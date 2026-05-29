import type { ASTNode, ColumnExpr, Condition, JoinNode, TableRef, ValueExpr, ParamRef } from "../ast/ast.ts";

export interface SQLResult { sql: string; params: unknown[]; }
export type SQLDialect = "sqlite" | "postgresql" | "mysql";

interface Ctx { params: unknown[]; dialect: SQLDialect; paramIdx: number; }

export function astToSQL(node: ASTNode, dialect: SQLDialect = "sqlite"): SQLResult {
  const ctx: Ctx = { params: [], dialect, paramIdx: 0 };
  switch (node.type) {
    case "select": return translateSelect(node, ctx);
    case "insert": return translateInsert(node, ctx);
    case "update": return translateUpdate(node, ctx);
    case "delete": return translateDelete(node, ctx);
    case "aggregate": return translateAggregate(node, ctx);
    case "createTable": return translateCreateTable(node, ctx);
    case "setOp": return translateSetOp(node, ctx);
    case "raw": return { sql: node.sql, params: node.params ?? [] };
    default: throw new Error(`Unknown AST node: ${(node as ASTNode).type}`);
  }
}

function ph(ctx: Ctx): string {
  ctx.paramIdx++;
  return ctx.dialect === "postgresql" ? `$${ctx.paramIdx}` : "?";
}

function q(name: string, ctx: Ctx): string {
  return ctx.dialect === "mysql" ? `\`${name}\`` : name;
}

function pushVal(val: ValueExpr, ctx: Ctx): void {
  if (typeof val === "object" && val !== null && (val as ParamRef).type === "param") return;
  ctx.params.push(val);
}

function translateSelect(n: import("../ast/ast.ts").SelectNode, ctx: Ctx): SQLResult {
  let sql = "SELECT ";

  // Handle CTEs
  if (n.ctes && n.ctes.length > 0) {
    const cteStrs = n.ctes.map(cte => {
      const sub = translateSelect(cte.query, ctx);
      return `${q(cte.name, ctx)} AS (${sub.sql})`;
    });
    sql = `WITH ${cteStrs.join(", ")} ` + sql;
  }

  if (n.distinct) sql += "DISTINCT ";
  sql += n.columns.map((c) => colSQL(c, ctx)).join(", ");
  sql += " FROM " + tableSQL(n.from, ctx);

  if (n.joins) for (const j of n.joins) sql += joinSQL(j, ctx);
  if (n.where) sql += " WHERE " + condSQL(n.where, ctx);
  if (n.groupBy) sql += " GROUP BY " + n.groupBy.map((c) => colSQL(c, ctx)).join(", ");
  if (n.having) sql += " HAVING " + condSQL(n.having, ctx);
  if (n.orderBy) sql += " ORDER BY " + n.orderBy.map(o => `${colSQL(o.column, ctx)} ${o.direction.toUpperCase()}`).join(", ");
  if (n.limit !== undefined) sql += ` LIMIT ${n.limit}`;
  if (n.offset !== undefined) sql += ` OFFSET ${n.offset}`;
  return { sql, params: ctx.params };
}

function translateInsert(n: import("../ast/ast.ts").InsertNode, ctx: Ctx): SQLResult {
  const cols = n.columns ?? [];
  const colStr = cols.length > 0 ? ` (${cols.map(c => q(c, ctx)).join(", ")})` : "";

  let sql: string;
  if (n.select) {
    const selectSql = translateSelect(n.select, ctx);
    ctx.params.push(...selectSql.params);
    sql = `INSERT INTO ${q(n.table, ctx)}${colStr} ${selectSql.sql}`;
  } else {
    const valueRows = n.values.map((row) => {
      for (const v of row) pushVal(v, ctx);
      return `(${row.map(() => ph(ctx)).join(", ")})`;
    }).join(", ");
    sql = `INSERT INTO ${q(n.table, ctx)}${colStr} VALUES ${valueRows}`;
  }

  if (n.returning) sql += ` RETURNING ${n.returning.join(", ")}`;
  return { sql, params: ctx.params };
}

function translateUpdate(n: import("../ast/ast.ts").UpdateNode, ctx: Ctx): SQLResult {
  const setClauses = Object.entries(n.set).map(([k, v]) => {
    if (typeof v === "object" && v !== null && "type" in v) {
      if ((v as ParamRef).type === "param") {
        const p = v as ParamRef;
        if (p.index >= 0) ctx.paramIdx = Math.max(ctx.paramIdx, p.index);
      } else {
        ctx.params.push(colSQL(v as ColumnExpr, ctx));
      }
      return `${q(k, ctx)} = ${ph(ctx)}`;
    }
    ctx.params.push(v);
    return `${q(k, ctx)} = ${ph(ctx)}`;
  });

  // Handle updateOps ($inc, $unset, $push, $pull)
  if (n.updateOps) {
    for (const op of n.updateOps) {
      switch (op.op) {
        case "inc":
          pushVal(op.value, ctx);
          setClauses.push(`${q(op.field, ctx)} = ${q(op.field, ctx)} + ${ph(ctx)}`);
          break;
        case "unset":
          setClauses.push(`${q(op.field, ctx)} = NULL`);
          break;
        default:
          setClauses.push(`${q(op.field, ctx)} = ${ph(ctx)}`);
          pushVal(op.value, ctx);
      }
    }
  }

  let sql = `UPDATE ${q(n.table, ctx)} SET ${setClauses.join(", ")}`;
  if (n.where) sql += " WHERE " + condSQL(n.where, ctx);
  if (n.returning) sql += ` RETURNING ${n.returning.join(", ")}`;
  return { sql, params: ctx.params };
}

function translateDelete(n: import("../ast/ast.ts").DeleteNode, ctx: Ctx): SQLResult {
  let sql = `DELETE FROM ${q(n.table, ctx)}`;
  if (n.where) sql += " WHERE " + condSQL(n.where, ctx);
  return { sql, params: ctx.params };
}

function translateCreateTable(n: import("../ast/ast.ts").CreateTableNode, ctx: Ctx): SQLResult {
  const ifNotExists = n.ifNotExists ? "IF NOT EXISTS " : "";
  const colDefs = n.columns.map(col => {
    let def = `${q(col.name, ctx)} ${col.dataType}`;
    if (col.primaryKey) def += " PRIMARY KEY";
    if (col.notNull) def += " NOT NULL";
    if (col.unique) def += " UNIQUE";
    if (col.defaultValue !== undefined) {
      ctx.params.push(col.defaultValue);
      def += ` DEFAULT ${ph(ctx)}`;
    }
    return def;
  });
  const sql = `CREATE TABLE ${ifNotExists}${q(n.table, ctx)} (${colDefs.join(", ")})`;
  return { sql, params: ctx.params };
}

function translateAggregate(n: import("../ast/ast.ts").AggregateNode, ctx: Ctx): SQLResult {
  const tableName = q(n.table, ctx);
  let selectColumns: string[] = [];
  const whereClauses: string[] = [];
  const joinClauses: string[] = [];
  let groupByColumns: string[] = [];
  let orderByClauses: string[] = [];
  let limitVal: number | undefined;
  let offsetVal: number | undefined;
  let hasGroup = false;

  for (const stage of n.pipeline) {
    switch (stage.stage) {
      case "match": whereClauses.push(condSQL(stage.condition, ctx)); break;
      case "group": {
        hasGroup = true;
        const idParts = Object.entries(stage.id).map(([k, v]) => v ? `${v} AS ${k}` : `'${k}' AS ${k}`);
        const accParts = Object.entries(stage.accumulators).map(([k, a]) => {
          if (a.func === "addToSet") {
            return ctx.dialect === "mysql"
              ? `GROUP_CONCAT(DISTINCT ${a.field}) AS ${k}`
              : `json_group_array(DISTINCT ${a.field}) AS ${k}`;
          }
          if (a.func === "first" || a.func === "last") {
            return `${a.field} AS ${k}`;
          }
          return `${a.func.toUpperCase()}(${a.field}) AS ${k}`;
        });
        selectColumns = [...idParts, ...accParts];
        if (stage.id && Object.keys(stage.id).length > 0) {
          groupByColumns = Object.entries(stage.id).map(([, v]) => v ?? "").filter(Boolean);
        }
        break;
      }
      case "sort": orderByClauses = stage.fields.map(f => `${colSQL(f.column, ctx)} ${f.direction.toUpperCase()}`); break;
      case "limit": limitVal = stage.count; break;
      case "skip": offsetVal = stage.count; break;
      case "project": {
        if (!hasGroup) {
          selectColumns = Object.entries(stage.fields).filter(([, v]) => v !== 0 && v !== false).map(([k, v]) => {
            if (typeof v === "object" && v !== null && "$concat" in v) {
              const args = ((v as Record<string, unknown>).$concat as (string | Record<string, unknown>)[] ?? []).map(arg =>
                typeof arg === "string" && arg.startsWith("$") ? colSQL({ type: "column", name: (arg as string).slice(1) }, ctx) : `'${arg}'`
              );
              return `CONCAT(${args.join(", ")}) AS ${q(k, ctx)}`;
            }
            if (typeof v === "object" && v !== null && "$add" in v) {
              const args = ((v as Record<string, unknown>).$add as (string | Record<string, unknown>)[] ?? []).map(arg =>
                typeof arg === "string" && arg.startsWith("$") ? colSQL({ type: "column", name: (arg as string).slice(1) }, ctx) : String(arg)
              );
              return `(${args.join(" + ")}) AS ${q(k, ctx)}`;
            }
            const name = typeof k === "string" ? k : String(k);
            return `${q(name, ctx)}`;
          });
        }
        break;
      }
      case "lookup": {
        if ("pipeline" in stage && stage.pipeline) {
          joinClauses.push(` LEFT JOIN ${q(stage.from, ctx)} AS ${q(stage.as, ctx)} ON 1=1`);
        } else if ("localField" in stage) {
          joinClauses.push(` LEFT JOIN ${q(stage.from, ctx)} ON ${tableName}.${stage.localField} = ${q(stage.from, ctx)}.${stage.foreignField}`);
        }
        break;
      }
    }
  }

  let sql = selectColumns.length > 0 ? `SELECT ${selectColumns.join(", ")} FROM ${tableName}` : `SELECT * FROM ${tableName}`;
  for (const j of joinClauses) sql += j;
  if (whereClauses.length > 0) sql += " WHERE " + whereClauses.join(" AND ");
  if (groupByColumns.length > 0) sql += " GROUP BY " + groupByColumns.join(", ");
  if (orderByClauses.length > 0) sql += " ORDER BY " + orderByClauses.join(", ");
  if (limitVal !== undefined) sql += ` LIMIT ${limitVal}`;
  if (offsetVal !== undefined) sql += ` OFFSET ${offsetVal}`;
  return { sql, params: ctx.params };
}

function colSQL(col: ColumnExpr, ctx: Ctx): string {
  switch (col.type) {
    case "wildcard": return "*";
    case "column": return col.table ? `${q(col.table, ctx)}.${q(col.name ?? "?", ctx)}` : q(col.name ?? "?", ctx);
    case "alias": {
      const inner = col.table ? `${q(col.table, ctx)}.${q(col.name ?? "?", ctx)}` : q(col.name ?? "?", ctx);
      return col.alias ? `${inner} AS ${col.alias}` : inner;
    }
    case "literal": return ph(ctx);
    case "function": return `${col.func?.toUpperCase()}(${(col.args ?? []).map(a => colSQL(a, ctx)).join(", ")})`;
    case "binary": return `(${colSQL(col.left!, ctx)} ${col.op} ${colSQL(col.right!, ctx)})`;
    default: return q(col.name ?? "?", ctx);
  }
}

function tableSQL(table: TableRef, ctx: Ctx): string {
  if (table.subquery) {
    const sub = translateSelect(table.subquery, ctx);
    const alias = table.alias ? ` AS ${table.alias}` : "";
    return `(${sub.sql})${alias}`;
  }
  const name = q(table.name, ctx);
  return table.alias ? `${name} AS ${table.alias}` : name;
}

function joinSQL(join: JoinNode, ctx: Ctx): string {
  return ` ${join.type.toUpperCase()} JOIN ${tableSQL(join.table, ctx)} ON ${condSQL(join.on, ctx)}`;
}

function condSQL(cond: Condition, ctx: Ctx): string {
  switch (cond.type) {
    case "eq": pushVal(cond.right, ctx); return `${colSQL(cond.left, ctx)} = ${ph(ctx)}`;
    case "neq": pushVal(cond.right, ctx); return `${colSQL(cond.left, ctx)} <> ${ph(ctx)}`;
    case "gt": pushVal(cond.right, ctx); return `${colSQL(cond.left, ctx)} > ${ph(ctx)}`;
    case "lt": pushVal(cond.right, ctx); return `${colSQL(cond.left, ctx)} < ${ph(ctx)}`;
    case "gte": pushVal(cond.right, ctx); return `${colSQL(cond.left, ctx)} >= ${ph(ctx)}`;
    case "lte": pushVal(cond.right, ctx); return `${colSQL(cond.left, ctx)} <= ${ph(ctx)}`;
    case "like": {
      pushVal(cond.pattern, ctx);
      if (cond.flags?.includes("i")) return `LOWER(${colSQL(cond.left, ctx)}) LIKE LOWER(${ph(ctx)})`;
      return `${colSQL(cond.left, ctx)} LIKE ${ph(ctx)}`;
    }
    case "notLike": {
      pushVal(cond.pattern, ctx);
      if (cond.flags?.includes("i")) return `LOWER(${colSQL(cond.left, ctx)}) NOT LIKE LOWER(${ph(ctx)})`;
      return `${colSQL(cond.left, ctx)} NOT LIKE ${ph(ctx)}`;
    }
    case "mod":
      pushVal(cond.divisor, ctx);
      pushVal(cond.remainder, ctx);
      return `${colSQL(cond.left, ctx)} % ${ph(ctx)} = ${ph(ctx)}`;
    case "all": {
      const col = colSQL(cond.left, ctx);
      const parts = cond.values.map(v => {
        pushVal(v, ctx);
        return `${col} LIKE ${ph(ctx)}`;
      });
      return `(${parts.join(" AND ")})`;
    }
    case "elemMatch": {
      const col = colSQL(cond.left, ctx);
      if (ctx.dialect === "postgresql") {
        const subCond = condSQL(cond.condition, ctx);
        return `EXISTS (SELECT 1 FROM jsonb_array_elements(${col}) AS elem WHERE ${subCond.replace(/elem\./g, "")})`;
      }
      if (ctx.dialect === "mysql") {
        return `JSON_CONTAINS(${col}, 'true') = 1`; // simplified
      }
      return `EXISTS (SELECT 1 FROM json_each(${col}) WHERE ${condSQL(cond.condition, ctx)})`;
    }
    case "expr": {
      const left = colSQL(cond.left, ctx);
      const right = colSQL(cond.right, ctx);
      return `${left} ${cond.op.toUpperCase()} ${right}`;
    }
    case "size": {
      pushVal(cond.count, ctx);
      const col = colSQL(cond.left, ctx);
      if (ctx.dialect === "mysql") return `JSON_LENGTH(${col}) = ${ph(ctx)}`;
      if (ctx.dialect === "postgresql") return `jsonb_array_length(${col}) = ${ph(ctx)}`;
      return `json_array_length(${col}) = ${ph(ctx)}`;
    }
    case "typeCheck": {
      const col = colSQL(cond.left, ctx);
      const typeMap: Record<string, string> = {
        string: "text", int: "integer", double: "real",
        bool: "integer", null: "null", array: "text", object: "text",
      };
      if (ctx.dialect === "sqlite") {
        return `TYPEOF(${col}) = '${typeMap[cond.bsonType.toLowerCase()] ?? "text"}'`;
      }
      if (ctx.dialect === "mysql") {
        return `JSON_TYPE(${col}) = '${cond.bsonType}'`;
      }
      return `1=1`;
    }
    case "between": pushVal(cond.min, ctx); pushVal(cond.max, ctx); return `${colSQL(cond.left, ctx)} BETWEEN ${ph(ctx)} AND ${ph(ctx)}`;
    case "in": for (const v of cond.values) pushVal(v, ctx); return `${colSQL(cond.left, ctx)} IN (${cond.values.map(() => ph(ctx)).join(", ")})`;
    case "notIn": for (const v of cond.values) pushVal(v, ctx); return `${colSQL(cond.left, ctx)} NOT IN (${cond.values.map(() => ph(ctx)).join(", ")})`;
    case "isNull": return `${colSQL(cond.left, ctx)} IS NULL`;
    case "isNotNull": return `${colSQL(cond.left, ctx)} IS NOT NULL`;
    case "and": return cond.conditions.length > 0 ? cond.conditions.map(c => `(${condSQL(c, ctx)})`).join(" AND ") : "1=1";
    case "or": return cond.conditions.length > 0 ? cond.conditions.map(c => `(${condSQL(c, ctx)})`).join(" OR ") : "1=0";
    case "not": return `NOT (${condSQL(cond.condition, ctx)})`;
    default: return "1=1";
  }
}

function translateSetOp(node: import("../ast/ast.ts").SetOpNode, ctx: Ctx): SQLResult {
  const left = translateSelect(node.left, ctx);
  const right = translateSelect(node.right, ctx);
  ctx.params.push(...right.params);

  const opMap: Record<string, string> = {
    union: "UNION", unionAll: "UNION ALL", intersect: "INTERSECT", except: "EXCEPT"
  };
  const sql = `${left.sql} ${opMap[node.op]} ${right.sql}`;
  return { sql, params: ctx.params };
}
