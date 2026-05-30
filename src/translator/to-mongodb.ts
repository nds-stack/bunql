import type { ASTNode, ColumnExpr, Condition, InsertNode, OrderByNode, SelectNode, UpdateNode, DeleteNode, ParamRef, ValueExpr } from "../ast/ast.ts";

export interface MongoCommand {
  collection: string;
  method: "find" | "insertOne" | "insertMany" | "updateOne" | "updateMany" | "deleteOne" | "deleteMany" | "aggregate";
  args: unknown[];
}

export function astToMongo(node: ASTNode, params: unknown[] = []): MongoCommand {
  switch (node.type) {
    case "select": return translateSelect(node, params);
    case "insert": return translateInsert(node, params);
    case "update": return translateUpdate(node, params);
    case "delete": return translateDelete(node, params);
    case "aggregate": return translateAggregate(node, params);
    case "createTable":
      throw new Error(`MongoDB does not support CREATE TABLE. Collections are created automatically on first insert.`);
    case "dropTable":
      throw new Error(`MongoDB does not support DROP TABLE. Use db.collection.drop() directly.`);
    case "createIndex":
      throw new Error(`MongoDB does not support CREATE INDEX. Indexes are created automatically or via createIndex().`);
    case "dropIndex":
      throw new Error(`MongoDB does not support DROP INDEX. Use db.collection.dropIndex() directly.`);
    case "setOp":
      throw new Error(`MongoDB does not support ${(node as import("../ast/ast.ts").SetOpNode).op.toUpperCase()} set operations. Use application-level merging instead.`);
    case "raw":
      throw new Error(`Raw SQL not supported for MongoDB. Use SQL SELECT/INSERT/UPDATE/DELETE instead.`);
    default: throw new Error(`Unsupported AST node for MongoDB: ${(node as ASTNode).type}`);
  }
}

function isParamRef(v: unknown): v is ParamRef {
  return typeof v === "object" && v !== null && (v as ParamRef).type === "param";
}

function resolveValue(val: ValueExpr, params: unknown[]): unknown {
  if (isParamRef(val)) {
    if (val.index < 0 || val.index >= params.length) {
      throw new Error(`Missing parameter at index ${val.index}`);
    }
    return params[val.index];
  }
  return val;
}

function likeToRegex(pattern: string): string {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return `^${escaped}$`;
}

function translateSelect(n: SelectNode, params: unknown[]): MongoCommand {
  const collection = typeof n.from === "string" ? n.from : n.from.name;

  // Inline CTEs for MongoDB
  if (n.ctes && n.ctes.length > 0) {
    const cteMap = new Map(n.ctes.map(c => [c.name, c.query]));
    if (typeof n.from !== "string" && n.from.name && cteMap.has(n.from.name)) {
      return translateSelect(cteMap.get(n.from.name)!, params);
    }
  }

  // Handle subquery: translate to aggregate pipeline
  if (typeof n.from !== "string" && n.from.subquery) {
    const subquery = n.from.subquery;
    const pipeline: Record<string, unknown>[] = [];

    if (subquery.where) pipeline.push({ $match: condToMQL(subquery.where, params) });

    if (subquery.columns && !subquery.columns.some(c => c.type === "wildcard")) {
      const proj: Record<string, number> = {};
      for (const c of subquery.columns) {
        if (c.name && c.name !== "*") proj[c.name] = 1;
      }
      if (Object.keys(proj).length > 0) pipeline.push({ $project: proj });
    }

    if (subquery.orderBy) pipeline.push({ $sort: orderByToMQL(subquery.orderBy) });
    if (subquery.limit !== undefined) pipeline.push({ $limit: subquery.limit });
    if (subquery.offset !== undefined) pipeline.push({ $skip: subquery.offset });

    if (n.where) pipeline.push({ $match: condToMQL(n.where, params) });

    return { collection: typeof subquery.from === "string" ? subquery.from : subquery.from.name, method: "aggregate", args: [pipeline] };
  }

  const hasJoins = n.joins && n.joins.length > 0;
  const hasGroup = !!n.groupBy;
  const hasDistinct = !!n.distinct;
  const hasAggrFunc = n.columns.some(c => c.type === "function" && ["COUNT", "SUM", "AVG", "MIN", "MAX"].includes((c.func ?? "").toUpperCase()));
  const hasCase = n.columns.some(c => c.type === "case");
  const hasWindowFunc = n.columns.some(c => c.type === "function" && c.over);
  const hasSubquery = n.where && hasSubqueryCondition(n.where);
  const needsPipeline = hasJoins || hasGroup || hasDistinct || hasAggrFunc || hasCase || hasWindowFunc || hasSubquery || !!n.having;

  if (needsPipeline) {
    const pipeline: Record<string, unknown>[] = [];

    if (n.joins) {
      for (const j of n.joins) {
        if (j.on.type === "eq") {
          const rightVal = typeof j.on.right === "string" ? j.on.right.split(".").pop() ?? j.on.right : String(j.on.right);
          const lookup: Record<string, unknown> = {
            from: j.table.name,
            localField: colName(j.on.left),
            foreignField: rightVal,
            as: j.table.name,
          };
          if (j.type !== "left") lookup._joinType = j.type;
          pipeline.push({ $lookup: lookup });
        } else if (j.on.type === "expr") {
          const rightCol = typeof j.on.right === "object" ? colName(j.on.right) : String(j.on.right);
          const lookup: Record<string, unknown> = {
            from: j.table.name,
            localField: colName(j.on.left),
            foreignField: rightCol,
            as: j.table.name,
          };
          if (j.type !== "left") lookup._joinType = j.type;
          pipeline.push({ $lookup: lookup });
        }
      }
    }

    // Extract subquery conditions from WHERE and convert to $lookup stages
    let subqueryIndex = 0;
    const subqueryLookups: Record<string, unknown>[] = [];
    const processedWhere = n.where ? extractSubqueries(n.where, params, () => `_sub_${subqueryIndex++}`, subqueryLookups, collection) : undefined;
    for (const lookup of subqueryLookups) pipeline.push(lookup);

    if (processedWhere) pipeline.push({ $match: condToMQL(processedWhere, params) });

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

    if (n.having) pipeline.push({ $match: condToMQL(n.having, params) });
    if (n.orderBy) pipeline.push({ $sort: orderByToMQL(n.orderBy) });

    if ((hasGroup || hasAggrFunc || hasDistinct) && n.columns.some(c => c.type !== "wildcard")) {
      const proj: Record<string, number | Record<string, unknown>> = { _id: 0 };
      for (const c of n.columns) {
        if (c.type === "function") proj[c.alias ?? (c.func ?? "").toLowerCase()] = 1;
        else if (c.type === "case") proj[c.alias ?? "case"] = caseToMQL(c, params);
        else if (c.type !== "wildcard") proj[colName(c)] = 1;
      }
      pipeline.push({ $project: proj });
    }

    if (!hasGroup && !hasAggrFunc && !hasDistinct && n.columns.some(c => c.type === "case" || c.type === "function" && c.over)) {
      const proj: Record<string, number | Record<string, unknown>> = {};
      for (const c of n.columns) {
        if (c.type === "case") proj[c.alias ?? "case"] = caseToMQL(c, params);
        else if (c.type === "function" && c.over) {
          throw new Error("Window functions require MongoDB 5.0+ ($setWindowFields). Not yet implemented for MongoDB translator.");
        }
        else if (c.type !== "wildcard") proj[colName(c)] = 1;
      }
      if (Object.keys(proj).length > 0) pipeline.push({ $project: proj });
    }

    if (n.offset !== undefined) pipeline.push({ $skip: n.offset });
    if (n.limit !== undefined) pipeline.push({ $limit: n.limit });

    return { collection, method: "aggregate", args: [pipeline] };
  }

  // Simple find
  const filter = n.where ? condToMQL(n.where, params) : {};
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

function translateInsert(n: InsertNode, params: unknown[]): MongoCommand {
  const cols = n.columns;
  const resolve = (v: ValueExpr) => resolveValue(v, params);

  // Handle INSERT...SELECT: execute SELECT first, then insert results
  if (n.select) {
    const selectCmd = translateSelect(n.select, params);
    return { collection: n.table, method: "aggregate", args: [selectCmd.args[0]] };
  }

  if (n.values.length === 1 && cols) {
    const doc: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) doc[cols[i]!] = resolve(n.values[0]![i]!);
    return { collection: n.table, method: "insertOne", args: [doc] };
  }
  if (n.values.length === 1 && !cols) {
    const doc: Record<string, unknown> = {};
    n.values[0]!.forEach((v, i) => doc[String(i)] = resolve(v));
    return { collection: n.table, method: "insertOne", args: [doc] };
  }
  const docs = n.values.map((row) => {
    const doc: Record<string, unknown> = {};
    if (cols) for (let i = 0; i < cols.length; i++) doc[cols[i]!] = resolve(row[i]!);
    else row.forEach((v, i) => doc[String(i)] = resolve(v));
    return doc;
  });
  return { collection: n.table, method: "insertMany", args: [docs] };
}

function translateUpdate(n: UpdateNode, params: unknown[]): MongoCommand {
  const filter = n.where ? condToMQL(n.where, params) : {};
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.set)) {
    if (isParamRef(v)) {
      set[k] = resolveValue(v, params);
    } else {
      set[k] = v;
    }
  }

  const updateDoc: Record<string, unknown> = { $set: set };
  if (n.updateOps) {
    for (const op of n.updateOps) {
      const opKey = `$${op.op}`;
      if (!updateDoc[opKey]) updateDoc[opKey] = {};
      (updateDoc[opKey] as Record<string, unknown>)[op.field] = resolveValue(op.value, params);
    }
  }

  return { collection: n.table, method: "updateMany", args: [filter, updateDoc] };
}

function translateDelete(n: DeleteNode, params: unknown[]): MongoCommand {
  const filter = n.where ? condToMQL(n.where, params) : {};
  return { collection: n.table, method: "deleteMany", args: [filter] };
}

function translateAggregate(n: import("../ast/ast.ts").AggregateNode, params: unknown[]): MongoCommand {
  const pipeline: Record<string, unknown>[] = [];
  for (const stage of n.pipeline) {
    switch (stage.stage) {
      case "match": pipeline.push({ $match: condToMQL(stage.condition, params) }); break;
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
      case "project": pipeline.push({ $project: stage.fields as Record<string, unknown> }); break;
      case "addFields": pipeline.push({ $addFields: stage.fields as Record<string, unknown> }); break;
      case "sample": pipeline.push({ $sample: { size: stage.size } }); break;
      case "lookup": {
        if ("pipeline" in stage && stage.pipeline) {
          const lookupObj: Record<string, unknown> = {
            from: stage.from,
            as: stage.as,
            pipeline: stage.pipeline.map(s => {
              if (s.stage === "match") return { $match: condToMQL(s.condition, params) };
              if (s.stage === "project") return { $project: s.fields };
              if (s.stage === "limit") return { $limit: s.count };
              if (s.stage === "sort") return { $sort: orderByObjToMQL(s.fields) };
              return { $limit: 0 };
            }),
          };
          if (stage.let) lookupObj.let = stage.let;
          pipeline.push({ $lookup: lookupObj });
        } else if ("localField" in stage) {
          pipeline.push({ $lookup: { from: stage.from, localField: stage.localField, foreignField: stage.foreignField, as: stage.as } });
        }
        break;
      }
      case "unwind": {
        if (stage.preserveNullAndEmptyArrays !== undefined || stage.includeArrayIndex !== undefined) {
          const unwindObj: Record<string, unknown> = { path: `$${stage.path}` };
          if (stage.preserveNullAndEmptyArrays !== undefined) unwindObj.preserveNullAndEmptyArrays = stage.preserveNullAndEmptyArrays;
          if (stage.includeArrayIndex !== undefined) unwindObj.includeArrayIndex = `$${stage.includeArrayIndex}`;
          pipeline.push({ $unwind: unwindObj });
        } else {
          pipeline.push({ $unwind: `$${stage.path}` });
        }
        break;
      }
    }
  }
  return { collection: n.table, method: "aggregate", args: [pipeline] };
}

function condToMQL(cond: Condition, params: unknown[]): Record<string, unknown> {
  switch (cond.type) {
    case "eq": return { [colName(cond.left)]: resolveValue(cond.right, params) };
    case "neq": return { [colName(cond.left)]: { $ne: resolveValue(cond.right, params) } };
    case "gt": return { [colName(cond.left)]: { $gt: resolveValue(cond.right, params) } };
    case "lt": return { [colName(cond.left)]: { $lt: resolveValue(cond.right, params) } };
    case "gte": return { [colName(cond.left)]: { $gte: resolveValue(cond.right, params) } };
    case "lte": return { [colName(cond.left)]: { $lte: resolveValue(cond.right, params) } };
    case "like": {
      const pattern = likeToRegex(String(resolveValue(cond.pattern, params)));
      const base: Record<string, unknown> = { $regex: pattern };
      if (cond.flags) base.$options = cond.flags;
      return { [colName(cond.left)]: base };
    }
    case "notLike": {
      const pattern = likeToRegex(String(resolveValue(cond.pattern, params)));
      const inner: Record<string, unknown> = { $regex: pattern };
      if (cond.flags) inner.$options = cond.flags;
      return { [colName(cond.left)]: { $not: inner } };
    }
    case "mod":
      return {
        [colName(cond.left)]: { $mod: [resolveValue(cond.divisor, params), resolveValue(cond.remainder, params)] },
      };
    case "size": {
      const count = resolveValue(cond.count, params);
      return { [colName(cond.left)]: { $size: count } };
    }
    case "typeCheck": {
      return { [colName(cond.left)]: { $type: cond.bsonType } };
    }
    case "elemMatch":
      return { [colName(cond.left)]: { $elemMatch: condToMQL(cond.condition, params) } };
    case "all":
      return { [colName(cond.left)]: { $all: cond.values.map(v => resolveValue(v, params)) } };
    case "expr": {
      const opMap: Record<string, string> = { gt: "$gt", lt: "$lt", gte: "$gte", lte: "$lte", eq: "$eq", neq: "$ne" };
      const mqlOp = opMap[cond.op] ?? "$eq";
      const left = cond.left.type === "column" ? `$${cond.left.name}` : cond.left.value;
      const right = cond.right.type === "column" ? `$${cond.right.name}` : cond.right.value;
      return { $expr: { [mqlOp]: [left, right] } };
    }
    case "between": return { [colName(cond.left)]: { $gte: resolveValue(cond.min, params), $lte: resolveValue(cond.max, params) } };
    case "in": return { [colName(cond.left)]: { $in: cond.values.map(v => resolveValue(v, params)) } };
    case "notIn": return { [colName(cond.left)]: { $nin: cond.values.map(v => resolveValue(v, params)) } };
    case "isNull": return { [colName(cond.left)]: null };
    case "isNotNull": return { [colName(cond.left)]: { $ne: null } };
    case "and": return cond.conditions.length === 0 ? {} : { $and: cond.conditions.map(c => condToMQL(c, params)) };
    case "or": return cond.conditions.length === 0 ? {} : { $or: cond.conditions.map(c => condToMQL(c, params)) };
    case "not": {
      const inner = condToMQL(cond.condition, params);
      const entries = Object.entries(inner);
      if (entries.length === 1) {
        const [field, expr] = entries[0]!;
        if (typeof expr === "object" && expr !== null && !Array.isArray(expr) && !(expr instanceof Date)) {
          return { [field]: { $not: expr } };
        }
      }
      return { $nor: [inner] };
    }
    case "inSubquery":
    case "notInSubquery":
    case "exists":
    case "notExists":
      // These are handled by extractSubqueries before condToMQL is called
      // If they reach here, it means they weren't extracted (fallback)
      return {};
    case "scalarSubquery":
      throw new Error(`Scalar subquery not supported for MongoDB. Use SQL backend.`);
    default: return {};
  }
}

// Check if a condition tree contains subquery conditions
function hasSubqueryCondition(cond: Condition): boolean {
  if (cond.type === "inSubquery" || cond.type === "notInSubquery" || cond.type === "exists" || cond.type === "notExists") return true;
  if (cond.type === "and" || cond.type === "or") return cond.conditions.some(c => hasSubqueryCondition(c));
  if (cond.type === "not") return hasSubqueryCondition(cond.condition);
  return false;
}

// Traverse condition tree, extract subqueries into $lookup stages, replace with marker conditions
function extractSubqueries(
  cond: Condition,
  params: unknown[],
  nameGen: () => string,
  lookups: Record<string, unknown>[],
  outerCollection?: string
): Condition {
  switch (cond.type) {
    case "inSubquery":
    case "notInSubquery": {
      const stageName = nameGen();
      const sub = cond.subquery;
      const from = typeof sub.from === "string" ? sub.from : sub.from.name;
      const subPipeline: Record<string, unknown>[] = [];

      // Detect correlation: subquery WHERE references outer collection
      const correlation = findCorrelation(sub.where, outerCollection);
      if (correlation) {
        const outerVar = `_cor_${correlation.outerField}`;
        subPipeline.push({
          $match: {
            $expr: {
              $eq: [`$${correlation.innerField}`, `$$${outerVar}`],
            },
          },
        });
        lookups.push({
          $lookup: {
            from,
            let: { [outerVar]: `$${correlation.outerField}` },
            pipeline: subPipeline,
            as: stageName,
          },
        });
      } else {
        if (sub.where) subPipeline.push({ $match: condToMQL(sub.where, params) });
        const targetField = cond.type === "inSubquery" ? (cond.left as ColumnExpr).name : undefined;
        if (targetField) subPipeline.push({ $project: { [targetField]: 1, _id: 0 } });
        lookups.push({ $lookup: { from, pipeline: subPipeline, as: stageName } });
      }

      const isNegated = cond.type === "notInSubquery";
      return { type: isNegated ? "eq" : "neq", left: { type: "column" as const, name: stageName }, right: [] as unknown as ValueExpr } as Condition;
    }
    case "exists":
    case "notExists": {
      const stageName = nameGen();
      const sub = cond.subquery;
      const from = typeof sub.from === "string" ? sub.from : sub.from.name;
      const subPipeline: Record<string, unknown>[] = [];

      const correlation = findCorrelation(sub.where, outerCollection);
      const outerVar = correlation ? `_cor_${correlation.outerField}` : "";
      if (correlation) {
        subPipeline.push({
          $match: {
            $expr: {
              $eq: [`$${correlation.innerField}`, `$$${outerVar}`],
            },
          },
        });
      } else {
        if (sub.where) subPipeline.push({ $match: condToMQL(sub.where, params) });
      }
      subPipeline.push({ $limit: 1 });

      if (correlation) {
        lookups.push({
          $lookup: {
            from,
            let: { [outerVar]: `$${correlation.outerField}` },
            pipeline: subPipeline,
            as: stageName,
          },
        });
      } else {
        lookups.push({ $lookup: { from, pipeline: subPipeline, as: stageName } });
      }

      const isNegated = cond.type === "notExists";
      return { type: isNegated ? "eq" : "neq", left: { type: "column" as const, name: stageName }, right: [] as unknown as ValueExpr } as Condition;
    }
    case "and":
      return { ...cond, conditions: cond.conditions.map(c => extractSubqueries(c, params, nameGen, lookups, outerCollection)) };
    case "or":
      return { ...cond, conditions: cond.conditions.map(c => extractSubqueries(c, params, nameGen, lookups, outerCollection)) };
    case "not":
      return { ...cond, condition: extractSubqueries(cond.condition, params, nameGen, lookups, outerCollection) };
    default:
      return cond;
  }
}

function findCorrelation(where: Condition | undefined, outerCollection?: string): { innerField: string; outerField: string } | null {
  if (!where || !outerCollection) return null;
  // Scan for column references with table matching outerCollection
  const refs = findColumnRefs(where);
  const outerRef = refs.find(r => r.table === outerCollection);
  if (!outerRef) return null;
  // Find the inner field in the same expression (same eq condition)
  // Assume the INNER column is the OTHER side of the eq
  return { innerField: outerRef.name ?? "_id", outerField: outerRef.name ?? "_id" };
}

function findColumnRefs(cond: Condition): { table: string; name: string }[] {
  if (cond.type === "eq" || cond.type === "neq" || cond.type === "gt" || cond.type === "lt" || cond.type === "gte" || cond.type === "lte") {
    const result: { table: string; name: string }[] = [];
    if ((cond.left as ColumnExpr).table) result.push({ table: (cond.left as ColumnExpr).table!, name: (cond.left as ColumnExpr).name ?? "?" });
    const rightCond = cond as Record<string, unknown>;
    if (typeof rightCond.right === "object" && (rightCond.right as ColumnExpr)?.table) result.push({ table: (rightCond.right as ColumnExpr).table!, name: (rightCond.right as ColumnExpr).name ?? "?" });
    return result;
  }
  if (cond.type === "and" || cond.type === "or") return (cond as import("../ast/ast.ts").AndCondition).conditions.flatMap(c => findColumnRefs(c));
  if (cond.type === "not") return findColumnRefs((cond as import("../ast/ast.ts").NotCondition).condition);
  return [];
}

function caseToMQL(caseExpr: import("../ast/ast.ts").ColumnExpr, params: unknown[]): Record<string, unknown> {
  const branches = (caseExpr.branches ?? []).map(b => {
    const caseCondition = caseExpr.caseValue
      ? { $eq: [colName(b.when as import("../ast/ast.ts").ColumnExpr), resolveValue(b.then as import("../ast/ast.ts").ValueExpr, params)] }
      : condToMQL(b.when as Condition, params);
    return { case: caseCondition, then: resolveValue(b.then as import("../ast/ast.ts").ValueExpr, params) };
  });
  return {
    $switch: {
      branches,
      ...(caseExpr.else !== undefined ? { default: resolveValue(caseExpr.else as import("../ast/ast.ts").ValueExpr, params) } : {}),
    },
  };
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
