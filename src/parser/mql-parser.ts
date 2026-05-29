/**
 * @module mql-parser
 * @description MongoDB Query Language parser — MQL object → Universal AST.
 */
import type { ASTNode, AggregateStage, ColumnExpr, Condition, Literal, ComputedExpr } from "../ast/ast.ts";

export function parseMQL(collection: string, method: string, args: unknown[]): ASTNode {
  switch (method) {
    case "find": return parseFind(collection, args[0] as Record<string, unknown> | undefined, args[1] as Record<string, unknown> | undefined);
    case "findOne": {
      const node = parseFind(collection, args[0] as Record<string, unknown> | undefined, args[1] as Record<string, unknown> | undefined);
      if (node.type === "select") node.limit = 1;
      return node;
    }
    case "aggregate": return parseAggregate(collection, args[0] as Record<string, unknown>[]);
    case "insertOne": return parseInsert(collection, args[0] as Record<string, Literal>);
    case "insertMany": return parseInsertMany(collection, args[0] as Record<string, Literal>[]);
    case "updateOne": return parseUpdate(collection, args[0] as Record<string, unknown>, args[1] as Record<string, unknown>);
    case "updateMany": return parseUpdate(collection, args[0] as Record<string, unknown>, args[1] as Record<string, unknown>);
    case "deleteOne": return parseDelete(collection, args[0] as Record<string, unknown>);
    case "deleteMany": return parseDelete(collection, args[0] as Record<string, unknown>);
    case "findOneAndUpdate": {
      const node = parseFind(collection, args[0] as Record<string, unknown> | undefined);
      if (node.type === "select") node.limit = 1;
      return node;
    }
    case "findOneAndDelete": return parseFind(collection, args[0] as Record<string, unknown> | undefined);
    case "replaceOne": {
      const where = mqlToCondition(args[0] as Record<string, unknown>);
      const set = args[1] as Record<string, Literal>;
      return { type: "update", table: collection, set, where };
    }
    default: throw new Error(`Unknown MQL method: ${method}`);
  }
}

function parseFind(collection: string, filter?: Record<string, unknown>, options?: Record<string, unknown>): ASTNode {
  const where = filter && Object.keys(filter).length > 0 ? mqlToCondition(filter) : undefined;

  let columns: ColumnExpr[] = [{ type: "wildcard" }];
  if (options?.projection) {
    const proj = options.projection as Record<string, number>;
    const fields = Object.entries(proj).filter(([, v]) => v === 1);
    if (fields.length > 0) {
      columns = fields.map(([k]) => ({ type: "column" as const, name: k }));
      if (proj._id !== 1) columns = columns.filter((c) => c.name !== "_id");
    }
  }

  return {
    type: "select",
    columns,
    from: { name: collection },
    where,
    orderBy: options?.sort ? parseSortObj(options.sort as Record<string, number>) : undefined,
    limit: options?.limit as number | undefined,
    offset: options?.skip as number | undefined,
  };
}

function parseAggregate(collection: string, pipeline: Record<string, unknown>[]): ASTNode {
  const stages: AggregateStage[] = pipeline.map((stage) => {
    const entries = Object.entries(stage);
    if (entries.length === 0) return { stage: "limit", count: 0 };
    const [key, value] = entries[0]!;
    switch (key) {
      case "$match": return { stage: "match", condition: mqlToCondition(value as Record<string, unknown>) };
      case "$group": return parseGroupStage(value as Record<string, unknown>);
      case "$sort": return { stage: "sort", fields: parseSortObj(value as Record<string, number>) };
      case "$limit": return { stage: "limit", count: value as number };
      case "$skip": return { stage: "skip", count: value as number };
      case "$project": {
        const fields: Record<string, number | string | boolean | ComputedExpr> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (typeof v === "object" && v !== null && !Array.isArray(v)) {
            const firstKey = Object.keys(v)[0];
            if (firstKey?.startsWith("$")) {
              fields[k] = v as ComputedExpr;
              continue;
            }
          }
          fields[k] = v as number | string | boolean;
        }
        return { stage: "project", fields };
      }
      case "$lookup": return parseLookupStage(value as Record<string, string>);
      case "$unwind": {
        if (typeof value === "string") {
          return { stage: "unwind", path: value.replace(/^\$/, "") };
        }
        if (typeof value === "object" && value !== null) {
          const obj = value as Record<string, unknown>;
          return {
            stage: "unwind",
            path: String(obj.path ?? "").replace(/^\$/, ""),
            preserveNullAndEmptyArrays: obj.preserveNullAndEmptyArrays === true,
            includeArrayIndex: typeof obj.includeArrayIndex === "string" ? obj.includeArrayIndex.replace(/^\$/, "") : undefined,
          };
        }
        return { stage: "unwind", path: "" };
      }
      case "$sample": return { stage: "sample", size: (value as Record<string, number>).size ?? 1 };
      default: return { stage: "limit", count: 0 };
    }
  });

  return { type: "aggregate", table: collection, pipeline: stages };
}

function parseInsert(collection: string, doc: Record<string, Literal>): ASTNode {
  const columns = Object.keys(doc);
  return { type: "insert", table: collection, columns, values: [[...Object.values(doc)]] };
}

function parseInsertMany(collection: string, docs: Record<string, Literal>[]): ASTNode {
  const columns = docs.length > 0 ? Object.keys(docs[0]!) : [];
  return {
    type: "insert",
    table: collection,
    columns,
    values: docs.map((d) => columns.map((c) => d[c] ?? null)),
  };
}

function parseUpdate(collection: string, filter: Record<string, unknown>, update: Record<string, unknown>): ASTNode {
  const set: Record<string, Literal> = {};
  const updateOps: import("../ast/ast.ts").UpdateNode["updateOps"] = [];

  for (const [op, val] of Object.entries(update)) {
    if (op === "$set") {
      Object.assign(set, val as Record<string, Literal>);
    } else if (["$inc", "$unset", "$push", "$pull"].includes(op)) {
      const shortOp = op.slice(1) as "inc" | "unset" | "push" | "pull";
      for (const [field, value] of Object.entries(val as Record<string, unknown>)) {
        updateOps.push({ op: shortOp, field, value: value as import("../ast/ast.ts").ValueExpr });
      }
    } else {
      set[op] = val as Literal;
    }
  }

  const where = mqlToCondition(filter);
  return { type: "update", table: collection, set, updateOps: updateOps.length > 0 ? updateOps : undefined, where };
}

function parseDelete(collection: string, filter: Record<string, unknown>): ASTNode {
  return { type: "delete", table: collection, where: mqlToCondition(filter) };
}

function parseGroupStage(value: Record<string, unknown>): AggregateStage {
  const id = (value._id ?? null) as Record<string, string | null> | null;
  const acc: Record<string, { func: "sum" | "avg" | "min" | "max" | "count" | "push" | "addToSet" | "first" | "last"; field: string }> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "_id") continue;
    const expr = v as Record<string, unknown>;
    const funcKeys = Object.keys(expr);
    const func = String(funcKeys[0] ?? "count").replace(/^\$/, "");
    const rawField = typeof expr[funcKeys[0]!] === "string" ? String(expr[funcKeys[0]!]) : "$ROOT";
    const field = rawField.replace(/^\$/, "");
    const validFuncs = ["sum", "avg", "min", "max", "count", "push", "addToSet", "first", "last"];
    acc[k] = { func: (validFuncs.includes(func) ? func : "count") as "sum" | "avg" | "min" | "max" | "count" | "push" | "addToSet" | "first" | "last", field };
  }
  return { stage: "group", id: id ?? {}, accumulators: acc };
}

function parseLookupStage(value: Record<string, unknown>): AggregateStage {
  const from = String(value.from ?? "");
  const as = String(value.as ?? "");

  // Complex variant: has 'pipeline' field
  if (value.pipeline && Array.isArray(value.pipeline)) {
    const letVars = value.let as Record<string, string> | undefined;
    const pipeline = (value.pipeline as Record<string, unknown>[]).map((stage) => {
      const entries = Object.entries(stage);
      if (entries.length === 0) return { stage: "limit", count: 0 } as AggregateStage;
      const [key, val] = entries[0]!;
      switch (key) {
        case "$match": return { stage: "match", condition: mqlToCondition(val as Record<string, unknown>) } as AggregateStage;
        case "$project": return { stage: "project", fields: val as Record<string, number | string | boolean> } as AggregateStage;
        case "$limit": return { stage: "limit", count: val as number } as AggregateStage;
        case "$sort": return { stage: "sort", fields: parseSortObj(val as Record<string, number>) } as AggregateStage;
        default: return { stage: "limit", count: 0 } as AggregateStage;
      }
    });
    return { stage: "lookup", from, let: letVars, pipeline, as };
  }

  // Simple variant: localField/foreignField
  return {
    stage: "lookup",
    from,
    localField: String(value.localField ?? ""),
    foreignField: String(value.foreignField ?? ""),
    as,
  };
}

function parseSortObj(sort: Record<string, number>): Array<{ column: ColumnExpr; direction: "asc" | "desc" }> {
  return Object.entries(sort).map(([k, v]) => ({
    column: { type: "column" as const, name: k },
    direction: v === -1 ? "desc" as const : "asc" as const,
  }));
}

function mqlToCondition(obj: Record<string, unknown>): Condition {
  const entries = Object.entries(obj);
  if (entries.length === 0) return { type: "and", conditions: [] };

  const conditions: Condition[] = entries.map(([field, value]) => {
    const col: ColumnExpr = { type: "column", name: field };

    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      return mqlOperator(col, value as Record<string, unknown>);
    }

    if (Array.isArray(value)) {
      return { type: "in", left: col, values: value as Literal[] };
    }

    return { type: "eq", left: col, right: value as Literal };
  });

  if (conditions.length === 1 && conditions[0] !== null) return conditions[0]!;
  const filtered = conditions.filter((c): c is Condition => c !== null);
  return filtered.length > 0 ? { type: "and", conditions: filtered } : { type: "and", conditions: [] };
}

function mqlOperator(col: ColumnExpr, ops: Record<string, unknown>): Condition {
  const entries = Object.entries(ops);
  if (entries.length === 0) return { type: "eq", left: col, right: null };

  // Check for $regex with $options
  const hasRegex = ops.$regex !== undefined;
  if (hasRegex) {
    const pattern = String(ops.$regex);
    const flags = typeof ops.$options === "string" ? ops.$options : undefined;
    return { type: "like" as const, left: col, pattern, flags };
  }

  const conditions: (Condition | null)[] = entries.map(([op, val]) => {
    if (!op.startsWith("$")) return null;
    switch (op) {
      case "$eq": return { type: "eq" as const, left: col, right: val as Literal };
      case "$ne": return { type: "neq" as const, left: col, right: val as Literal };
      case "$gt": return { type: "gt" as const, left: col, right: val as Literal };
      case "$lt": return { type: "lt" as const, left: col, right: val as Literal };
      case "$gte": return { type: "gte" as const, left: col, right: val as Literal };
      case "$lte": return { type: "lte" as const, left: col, right: val as Literal };
      case "$in": return { type: "in" as const, left: col, values: (val as Literal[]) };
      case "$nin": return { type: "notIn" as const, left: col, values: (val as Literal[]) };
      case "$regex":
      case "$options":
        return null;
      case "$exists": return val
        ? { type: "isNotNull" as const, left: col }
        : { type: "isNull" as const, left: col };
      case "$and": return { type: "and" as const, conditions: (val as Record<string, unknown>[]).map((o) => mqlToCondition(o)) };
      case "$or": return { type: "or" as const, conditions: (val as Record<string, unknown>[]).map((o) => mqlToCondition(o)) };
      case "$nor": return { type: "and" as const, conditions: (val as Record<string, unknown>[]).map((o) => ({ type: "not" as const, condition: mqlToCondition(o) })) };
      case "$not": return { type: "not" as const, condition: mqlToCondition(val as Record<string, unknown>) };
      case "$mod": {
        const arr = val as unknown[];
        if (Array.isArray(arr) && arr.length === 2) {
          return { type: "mod" as const, left: col, divisor: arr[0] as Literal, remainder: arr[1] as Literal };
        }
        return { type: "eq" as const, left: col, right: null };
      }
      case "$elemMatch": {
        const filter = val as Record<string, unknown>;
        return { type: "elemMatch" as const, left: col, condition: mqlToCondition(filter) };
      }
      case "$all": {
        const allVals = val as Literal[];
        return { type: "all" as const, left: col, values: allVals };
      }
      case "$expr": {
        const expr = val as Record<string, unknown[]>;
        const opKey = Object.keys(expr)[0] ?? "$eq";
        const args = expr[opKey] as unknown[];
        const leftArg = args?.[0];
        const rightArg = args?.[1];
        const leftCol: ColumnExpr = typeof leftArg === "string" && leftArg.startsWith("$")
          ? { type: "column", name: (leftArg as string).slice(1) }
          : { type: "literal", value: leftArg as Literal };
        const rightCol: ColumnExpr = typeof rightArg === "string" && rightArg.startsWith("$")
          ? { type: "column", name: (rightArg as string).slice(1) }
          : { type: "literal", value: rightArg as Literal };
        const opMap: Record<string, string> = { $gt: "gt", $lt: "lt", $gte: "gte", $lte: "lte", $eq: "eq", $ne: "neq" };
        return { type: "expr" as const, left: leftCol, op: opMap[opKey] ?? "eq", right: rightCol };
      }
      case "$size": {
        const count = val as Literal;
        return { type: "size" as const, left: col, count };
      }
      case "$type": {
        return { type: "typeCheck" as const, left: col, bsonType: String(val) };
      }
      default: throw new Error(`Unsupported MQL operator: ${op}`);
    }
  });

  const filtered = conditions.filter((c): c is Condition => c !== null);
  const result = filtered.length === 1 ? filtered[0]! : filtered.length > 0 ? { type: "and" as const, conditions: filtered } : { type: "and" as const, conditions: [] };
  return result;
}
