/**
 * @module to-mongodb
 * @description Universal AST → MongoDB driver command translator.
 */
import type { ASTNode, ColumnExpr, Condition, OrderByNode } from "../ast/ast.ts";

export interface MongoCommand {
  collection: string;
  method: "find" | "insertOne" | "insertMany" | "updateOne" | "updateMany" | "deleteOne" | "deleteMany" | "aggregate";
  args: unknown[];
}

export function astToMongo(node: ASTNode): MongoCommand {
  switch (node.type) {
    case "select": return translateSelect(node);
    case "insert": return translateInsert(node);
    case "update": return translateUpdate(node);
    case "delete": return translateDelete(node);
    case "aggregate": return translateAggregate(node);
    case "raw": return { collection: "", method: "find", args: [node.sql] };
    default: throw new Error(`Unsupported AST node for MongoDB: ${(node as ASTNode).type}`);
  }
}

function translateSelect(n: import("../ast/ast.ts").SelectNode): MongoCommand {
  const collection = typeof n.from === "string" ? n.from : n.from.name;

  if (typeof n.from !== "string" && n.from.subquery) {
    throw new Error("Subqueries in FROM are not supported for MongoDB translation.");
  }

  // If JOINs or GROUP BY present, use aggregate pipeline
  if (n.joins && n.joins.length > 0 || n.groupBy) {
    const pipeline: Record<string, unknown>[] = [];

    // Build $lookup stages from JOINs
    if (n.joins) {
      for (const j of n.joins) {
        if (j.on.type === "eq") {
          const leftName = colName(j.on.left);
          const rightVal = typeof j.on.right === "string" ? j.on.right.split(".").pop() ?? j.on.right : String(j.on.right);
          pipeline.push({
            $lookup: {
              from: j.table.name,
              localField: leftName,
              foreignField: rightVal,
              as: j.table.name,
            },
          });
        }
      }
    }

    // $match from WHERE
    if (n.where) {
      pipeline.push({ $match: condToMQL(n.where) });
    }

    // $group from GROUP BY
    if (n.groupBy) {
      const groupStage: Record<string, unknown> = { _id: {} };
      for (const g of n.groupBy) {
        const name = colName(g);
        (groupStage._id as Record<string, unknown>)[name] = `$${name}`;
      }
      pipeline.push({ $group: groupStage });
    }

    // $sort from ORDER BY
    if (n.orderBy) {
      pipeline.push({ $sort: orderByToMQL(n.orderBy) });
    }

    // $limit / $skip
    if (n.limit !== undefined) pipeline.push({ $limit: n.limit });
    if (n.offset !== undefined) pipeline.push({ $skip: n.offset });

    return { collection, method: "aggregate", args: [pipeline] };
  }

  // No JOIN/GROUP BY — use simple find
  const filter = n.where ? condToMQL(n.where) : {};
  const projection: Record<string, number> = {};
  let hasCols = false;

  for (const col of n.columns) {
    if (col.type === "wildcard") continue;
    const name = col.alias ?? col.name;
    if (name && name !== "*") {
      projection[name] = 1;
      hasCols = true;
    }
  }

  if (projection._id === undefined && hasCols) {
    projection._id = 0;
  }

  const options: Record<string, unknown> = {};
  if (hasCols) options.projection = projection;
  if (n.orderBy) options.sort = orderByToMQL(n.orderBy);
  if (n.limit !== undefined) options.limit = n.limit;
  if (n.offset !== undefined) options.skip = n.offset;

  return {
    collection,
    method: "find",
    args: [filter, Object.keys(options).length > 0 ? options : undefined].filter(Boolean),
  };
}

function translateInsert(n: import("../ast/ast.ts").InsertNode): MongoCommand {
  if (n.values.length === 1 && n.columns) {
    const doc: Record<string, unknown> = {};
    const cols = n.columns;
    const row = n.values[0]!;
    for (let i = 0; i < cols.length; i++) {
      doc[cols[i]!] = row[i];
    }
    return { collection: n.table, method: "insertOne", args: [doc] };
  }

  const docs = n.values.map((row) => {
    const doc: Record<string, unknown> = {};
    const cols = n.columns ?? [];
    if (cols.length > 0) {
      for (let i = 0; i < cols.length; i++) {
        doc[cols[i]!] = row[i];
      }
    }
    return doc;
  });
  return { collection: n.table, method: "insertMany", args: [docs] };
}

function translateUpdate(n: import("../ast/ast.ts").UpdateNode): MongoCommand {
  const filter = n.where ? condToMQL(n.where) : {};
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.set)) {
    set[k] = v;
  }
  return { collection: n.table, method: "updateOne", args: [filter, { $set: set }] };
}

function translateDelete(n: import("../ast/ast.ts").DeleteNode): MongoCommand {
  const filter = n.where ? condToMQL(n.where) : {};
  return { collection: n.table, method: "deleteOne", args: [filter] };
}

function translateAggregate(n: import("../ast/ast.ts").AggregateNode): MongoCommand {
  const pipeline: Record<string, unknown>[] = [];

  for (const stage of n.pipeline) {
    switch (stage.stage) {
      case "match":
        pipeline.push({ $match: condToMQL(stage.condition) });
        break;
      case "group": {
        const groupStage: Record<string, unknown> = { _id: stage.id ?? null };
        for (const [k, acc] of Object.entries(stage.accumulators)) {
          groupStage[k] = { [`$${acc.func}`]: acc.field.startsWith("$") ? acc.field : `$${acc.field}` };
        }
        pipeline.push({ $group: groupStage });
        break;
      }
      case "sort":
        pipeline.push({ $sort: orderByObjToMQL(stage.fields) });
        break;
      case "limit":
        pipeline.push({ $limit: stage.count });
        break;
      case "skip":
        pipeline.push({ $skip: stage.count });
        break;
      case "project":
        pipeline.push({ $project: stage.fields });
        break;
      case "lookup":
        pipeline.push({
          $lookup: {
            from: stage.from,
            localField: stage.localField,
            foreignField: stage.foreignField,
            as: stage.as,
          },
        });
        break;
      case "unwind":
        pipeline.push({ $unwind: `$${stage.path}` });
        break;
    }
  }

  return { collection: n.table, method: "aggregate", args: [pipeline] };
}

function condToMQL(cond: Condition): Record<string, unknown> {
  switch (cond.type) {
    case "eq": return { [colName(cond.left)]: cond.right };
    case "neq": return { [colName(cond.left)]: { $ne: cond.right } };
    case "gt": return { [colName(cond.left)]: { $gt: cond.right } };
    case "lt": return { [colName(cond.left)]: { $lt: cond.right } };
    case "gte": return { [colName(cond.left)]: { $gte: cond.right } };
    case "lte": return { [colName(cond.left)]: { $lte: cond.right } };
    case "like": return { [colName(cond.left)]: { $regex: cond.pattern } };
    case "notLike": return { [colName(cond.left)]: { $not: { $regex: cond.pattern } } };
    case "between": return { [colName(cond.left)]: { $gte: cond.min, $lte: cond.max } };
    case "in": return { [colName(cond.left)]: { $in: cond.values } };
    case "notIn": return { [colName(cond.left)]: { $nin: cond.values } };
    case "isNull": return { [colName(cond.left)]: null };
    case "isNotNull": return { [colName(cond.left)]: { $ne: null } };
    case "and": {
      if (cond.conditions.length === 0) return {};
      return { $and: cond.conditions.map((c) => condToMQL(c)) };
    }
    case "or": {
      if (cond.conditions.length === 0) return {};
      return { $or: cond.conditions.map((c) => condToMQL(c)) };
    }
    case "not": return { $nor: [condToMQL(cond.condition)] };
    default: return {};
  }
}

function colName(col: ColumnExpr): string {
  if (col.type === "binary") return `(${colSQLBin(col)})`;
  return col.alias ?? col.name ?? "_id";
}

function colSQLBin(col: ColumnExpr): string {
  if (col.type === "binary") return `(${colSQLBin(col.left!)} ${col.op} ${colSQLBin(col.right!)})`;
  if (col.type === "literal") return String(col.value ?? "null");
  return col.alias ?? col.name ?? "_id";
}

function orderByToMQL(items: OrderByNode[]): Record<string, number> {
  const sort: Record<string, number> = {};
  for (const item of items) {
    sort[colName(item.column)] = item.direction === "desc" ? -1 : 1;
  }
  return sort;
}

function orderByObjToMQL(items: OrderByNode[]): Record<string, number> {
  return orderByToMQL(items);
}
