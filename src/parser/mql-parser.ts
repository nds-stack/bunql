/**
 * @module mql-parser
 * @description MongoDB Query Language parser — MQL object → Universal AST.
 */
import type { ASTNode, AggregateStage, ColumnExpr, Condition, Literal } from "../ast/ast.ts";

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
      case "$project": return { stage: "project", fields: value as Record<string, number | string | boolean> };
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
  const set = (update.$set ?? update) as Record<string, Literal>;
  const where = mqlToCondition(filter);
  return { type: "update", table: collection, set, where };
}

function parseDelete(collection: string, filter: Record<string, unknown>): ASTNode {
  return { type: "delete", table: collection, where: mqlToCondition(filter) };
}

function parseGroupStage(value: Record<string, unknown>): AggregateStage {
  const id = (value._id ?? null) as Record<string, string | null> | null;
  const acc: Record<string, { func: "sum" | "avg" | "min" | "max" | "count" | "push"; field: string }> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "_id") continue;
    const expr = v as Record<string, unknown>;
    const funcKeys = Object.keys(expr);
    const func = String(funcKeys[0] ?? "count").replace(/^\$/, "");
    const rawField = typeof expr[funcKeys[0]!] === "string" ? String(expr[funcKeys[0]!]) : "$ROOT";
    const field = rawField.replace(/^\$/, "");
    const validFuncs = ["sum", "avg", "min", "max", "count", "push"];
    acc[k] = { func: (validFuncs.includes(func) ? func : "count") as "sum" | "avg" | "min" | "max" | "count" | "push", field };
  }
  return { stage: "group", id: id ?? {}, accumulators: acc };
}

function parseLookupStage(value: Record<string, string>): AggregateStage {
  return {
    stage: "lookup",
    from: value.from ?? "",
    localField: value.localField ?? "",
    foreignField: value.foreignField ?? "",
    as: value.as ?? "",
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

  if (conditions.length === 1) return conditions[0]!;
  return { type: "and", conditions };
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
      case "$all": {
        const allVals = val as Literal[];
        if (allVals.length === 1) return { type: "eq" as const, left: col, right: allVals[0]! };
        return { type: "and" as const, conditions: allVals.map(v => ({ type: "eq" as const, left: col, right: v })) };
      }
      case "$size": {
        return { type: "eq" as const, left: col, right: null }; // placeholder
      }
      case "$type": return { type: "isNotNull" as const, left: col }; // approximate: type check exists
      default: return { type: "eq" as const, left: col, right: val as Literal };
    }
  });

  const result = conditions.length === 1 ? conditions[0]! : { type: "and" as const, conditions: conditions.filter((c): c is Condition => c !== null) };
  return result;
}
