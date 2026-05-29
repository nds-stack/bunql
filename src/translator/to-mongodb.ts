import type { ASTNode, ColumnExpr, Condition, InsertNode, OrderByNode, SelectNode, UpdateNode, DeleteNode, Literal } from "../ast/ast.ts";

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

function translateSelect(n: SelectNode): MongoCommand {
  const collection = typeof n.from === "string" ? n.from : n.from.name;
  if (typeof n.from !== "string" && n.from.subquery) {
    throw new Error("Subqueries in FROM are not supported for MongoDB.");
  }

  const hasJoins = n.joins && n.joins.length > 0;
  const hasGroup = !!n.groupBy;
  const hasDistinct = !!n.distinct;
  const hasAggrFunc = n.columns.some(c => c.type === "function" && ["COUNT", "SUM", "AVG", "MIN", "MAX"].includes((c.func ?? "").toUpperCase()));
  const needsPipeline = hasJoins || hasGroup || hasDistinct || hasAggrFunc || !!n.having;

  if (needsPipeline) {
    const pipeline: Record<string, unknown>[] = [];

    if (n.joins) {
      for (const j of n.joins) {
        if (j.on.type === "eq") {
          const rightVal = typeof j.on.right === "string" ? j.on.right.split(".").pop() ?? j.on.right : String(j.on.right);
          pipeline.push({ $lookup: { from: j.table.name, localField: colName(j.on.left), foreignField: rightVal, as: j.table.name } });
        }
      }
    }

    if (n.where) pipeline.push({ $match: condToMQL(n.where) });

    if (hasGroup || hasDistinct || hasAggrFunc) {
      const groupStage: Record<string, unknown> = {};
      if (hasGroup && n.groupBy) {
        const idObj: Record<string, unknown> = {};
        for (const g of n.groupBy) idObj[colName(g)] = `$${colName(g)}`;
        groupStage._id = idObj;
      } else if (hasDistinct) {
        const distinctCols = n.columns.filter(c => c.type !== "function" && c.type !== "wildcard");
        if (distinctCols.length === 1) groupStage._id = `$${colName(distinctCols[0]!)}`;
        else if (distinctCols.length > 1) {
          const idObj: Record<string, unknown> = {};
          for (const c of distinctCols) idObj[colName(c)] = `$${colName(c)}`;
          groupStage._id = idObj;
        } else groupStage._id = null;
      }
      if (hasAggrFunc) {
        for (const c of n.columns) {
          if (c.type === "function") {
            const fn = (c.func ?? "").toLowerCase();
            const arg = c.args && c.args.length > 0 ? colName(c.args[0]!) : null;
            if (["sum", "avg", "min", "max", "count"].includes(fn)) {
              groupStage[c.alias ?? fn] = { [`$${fn}`]: fn === "count" ? 1 : `$${arg}` };
            }
          }
        }
      }
      pipeline.push({ $group: groupStage });
    }

    if (n.having) pipeline.push({ $match: condToMQL(n.having) });
    if (n.orderBy) pipeline.push({ $sort: orderByToMQL(n.orderBy) });

    // $project to shape output
    if ((hasGroup || hasAggrFunc || hasDistinct) && n.columns.some(c => c.type !== "wildcard")) {
      const proj: Record<string, number> = { _id: 0 };
      for (const c of n.columns) {
        if (c.type === "function") proj[c.alias ?? (c.func ?? "").toLowerCase()] = 1;
        else if (c.type !== "wildcard") proj[colName(c)] = 1;
      }
      pipeline.push({ $project: proj });
    }

    if (n.offset !== undefined) pipeline.push({ $skip: n.offset });
    if (n.limit !== undefined) pipeline.push({ $limit: n.limit });

    return { collection, method: "aggregate", args: [pipeline] };
  }

  // Simple find
  const filter = n.where ? condToMQL(n.where) : {};
  const projection: Record<string, number> = {};
  let hasCols = false;
  for (const col of n.columns) {
    if (col.type === "wildcard") continue;
    const name = col.alias ?? col.name;
    if (name && name !== "*") { projection[name] = 1; hasCols = true; }
  }
  if (projection._id === undefined && hasCols) projection._id = 0;

  const options: Record<string, unknown> = {};
  if (hasCols) options.projection = projection;
  if (n.orderBy) options.sort = orderByToMQL(n.orderBy);
  if (n.limit !== undefined) options.limit = n.limit;
  if (n.offset !== undefined) options.skip = n.offset;

  return { collection, method: "find", args: [filter, Object.keys(options).length > 0 ? options : undefined].filter(Boolean) };
}

function translateInsert(n: InsertNode): MongoCommand {
  const cols = n.columns;
  if (n.values.length === 1 && cols) {
    const doc: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) doc[cols[i]!] = n.values[0]![i];
    return { collection: n.table, method: "insertOne", args: [doc] };
  }
  if (n.values.length === 1 && !cols) {
    // INSERT INTO t VALUES (...) — map by position
    const doc: Record<string, unknown> = {};
    n.values[0]!.forEach((v, i) => doc[String(i)] = v);
    return { collection: n.table, method: "insertOne", args: [doc] };
  }
  const docs = n.values.map((row) => {
    const doc: Record<string, unknown> = {};
    if (cols) for (let i = 0; i < cols.length; i++) doc[cols[i]!] = row[i];
    else row.forEach((v, i) => doc[String(i)] = v);
    return doc;
  });
  return { collection: n.table, method: "insertMany", args: [docs] };
}

function translateUpdate(n: UpdateNode): MongoCommand {
  const filter = n.where ? condToMQL(n.where) : {};
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.set)) set[k] = v;
  return { collection: n.table, method: "updateMany", args: [filter, { $set: set }] };
}

function translateDelete(n: DeleteNode): MongoCommand {
  const filter = n.where ? condToMQL(n.where) : {};
  return { collection: n.table, method: "deleteMany", args: [filter] };
}

function translateAggregate(n: import("../ast/ast.ts").AggregateNode): MongoCommand {
  const pipeline: Record<string, unknown>[] = [];
  for (const stage of n.pipeline) {
    switch (stage.stage) {
      case "match": pipeline.push({ $match: condToMQL(stage.condition) }); break;
      case "group": {
        const gs: Record<string, unknown> = { _id: stage.id ?? null };
        for (const [k, acc] of Object.entries(stage.accumulators)) {
          gs[k] = { [`$${acc.func}`]: acc.field.startsWith("$") ? acc.field : `$${acc.field}` };
        }
        pipeline.push({ $group: gs });
        break;
      }
      case "sort": pipeline.push({ $sort: orderByObjToMQL(stage.fields) }); break;
      case "limit": pipeline.push({ $limit: stage.count }); break;
      case "skip": pipeline.push({ $skip: stage.count }); break;
      case "project": pipeline.push({ $project: stage.fields }); break;
      case "lookup": pipeline.push({ $lookup: { from: stage.from, localField: stage.localField, foreignField: stage.foreignField, as: stage.as } }); break;
      case "unwind": pipeline.push({ $unwind: `$${stage.path}` }); break;
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
    case "and": return cond.conditions.length === 0 ? {} : { $and: cond.conditions.map(c => condToMQL(c)) };
    case "or": return cond.conditions.length === 0 ? {} : { $or: cond.conditions.map(c => condToMQL(c)) };
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
  for (const item of items) sort[colName(item.column)] = item.direction === "desc" ? -1 : 1;
  return sort;
}

function orderByObjToMQL(items: OrderByNode[]): Record<string, number> {
  return orderByToMQL(items);
}
