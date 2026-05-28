/**
 * @module to-sql
 * @description Universal AST → SQLite SQL string + params translator.
 */
import type { ASTNode, ColumnExpr, Condition, JoinNode, OrderByNode, TableRef } from "../ast/ast.ts";

export interface SQLResult {
  sql: string;
  params: unknown[];
}

export function astToSQL(node: ASTNode): SQLResult {
  switch (node.type) {
    case "select": return translateSelect(node);
    case "insert": return translateInsert(node);
    case "update": return translateUpdate(node);
    case "delete": return translateDelete(node);
    case "aggregate": return translateAggregateAsSQL(node);
    case "raw": return { sql: node.sql, params: node.params ?? [] };
    default: throw new Error(`Unknown AST node type: ${(node as ASTNode).type}`);
  }
}

function translateSelect(n: import("../ast/ast.ts").SelectNode): SQLResult {
  const params: unknown[] = [];
  let sql = "SELECT ";
  if (n.distinct) sql += "DISTINCT ";
  sql += n.columns.map((c) => colSQL(c)).join(", ");
  sql += " FROM " + tableSQL(n.from);

  if (n.joins) {
    for (const j of n.joins) {
      sql += joinSQL(j);
    }
  }

  if (n.where) {
    const w = condSQL(n.where, params);
    sql += " WHERE " + w;
  }
  if (n.groupBy) {
    sql += " GROUP BY " + n.groupBy.map((c) => colSQL(c)).join(", ");
  }
  if (n.having) {
    sql += " HAVING " + condSQL(n.having, params);
  }
  if (n.orderBy) {
    sql += " ORDER BY " + n.orderBy.map(o => `${colSQL(o.column)} ${o.direction.toUpperCase()}`).join(", ");
  }
  if (n.limit !== undefined) sql += ` LIMIT ${n.limit}`;
  if (n.offset !== undefined) sql += ` OFFSET ${n.offset}`;

  return { sql, params };
}

function translateInsert(n: import("../ast/ast.ts").InsertNode): SQLResult {
  const params: unknown[] = [];
  const cols = n.columns ?? [];
  const colStr = cols.length > 0 ? ` (${cols.join(", ")})` : "";

  const valueRows = n.values.map((row) => {
    params.push(...row);
    return `(${row.map(() => "?").join(", ")})`;
  }).join(", ");

  let sql = `INSERT INTO ${n.table}${colStr} VALUES ${valueRows}`;
  if (n.returning) sql += ` RETURNING ${n.returning.join(", ")}`;

  return { sql, params };
}

function translateUpdate(n: import("../ast/ast.ts").UpdateNode): SQLResult {
  const params: unknown[] = [];
  const setClauses = Object.entries(n.set).map(([k, v]) => {
    if (typeof v === "object" && v !== null && "type" in v) {
      params.push(colSQL(v as ColumnExpr));
      return `${k} = ?`;
    }
    params.push(v);
    return `${k} = ?`;
  });

  let sql = `UPDATE ${n.table} SET ${setClauses.join(", ")}`;
  if (n.where) sql += " WHERE " + condSQL(n.where, params);
  if (n.returning) sql += ` RETURNING ${n.returning.join(", ")}`;

  return { sql, params };
}

function translateDelete(n: import("../ast/ast.ts").DeleteNode): SQLResult {
  const params: unknown[] = [];
  let sql = `DELETE FROM ${n.table}`;
  if (n.where) sql += " WHERE " + condSQL(n.where, params);
  return { sql, params };
}

function translateAggregateAsSQL(n: import("../ast/ast.ts").AggregateNode): SQLResult {
  const params: unknown[] = [];
  let sql = `SELECT * FROM ${n.table}`;
  let hasWhere = false;

  for (const stage of n.pipeline) {
    if (stage.stage === "match") {
      const w = condSQL(stage.condition, params);
      sql += hasWhere ? ` AND ${w}` : ` WHERE ${w}`;
      hasWhere = true;
    }
  }

  for (const stage of n.pipeline) {
    if (stage.stage === "group") {
      const idParts = Object.entries(stage.id).map(([k, v]) => v ? `${v} AS ${k}` : `'${k}' AS ${k}`);
      const accParts = Object.entries(stage.accumulators).map(([k, a]) => `${a.func.toUpperCase()}(${a.field}) AS ${k}`);
      sql = `SELECT ${[...idParts, ...accParts].join(", ")} FROM ${n.table}`;
      if (hasWhere) {
        const wParts: string[] = [];
        for (const s of n.pipeline) {
          if (s.stage === "match") wParts.push(condSQL(s.condition, params));
        }
        sql += " WHERE " + wParts.join(" AND ");
      }
      if (stage.id && Object.keys(stage.id).length > 0) {
        sql += " GROUP BY " + Object.entries(stage.id).map(([, v]) => v ?? "").filter(Boolean).join(", ");
      }
    }
  }

  for (const stage of n.pipeline) {
    if (stage.stage === "sort") {
      sql += " ORDER BY " + stage.fields.map(f => `${colSQL(f.column)} ${f.direction.toUpperCase()}`).join(", ");
    }
    if (stage.stage === "limit") sql += ` LIMIT ${stage.count}`;
  }

  return { sql, params };
}

function colSQL(col: ColumnExpr): string {
  switch (col.type) {
    case "wildcard": return "*";
    case "column": return col.table ? `${col.table}.${col.name}` : col.name ?? "?";
    case "alias": {
      const inner = col.table ? `${col.table}.${col.name}` : col.name ?? "?";
      return col.alias ? `${inner} AS ${col.alias}` : inner;
    }
    case "literal": return "?";
    case "function": return `${col.func?.toUpperCase()}(${(col.args ?? []).map(colSQL).join(", ")})`;
    default: return col.name ?? "?";
  }
}

function tableSQL(table: TableRef): string {
  return table.alias ? `${table.name} AS ${table.alias}` : table.name;
}

function joinSQL(join: JoinNode): string {
  const params: unknown[] = [];
  const on = condSQL(join.on, params);
  return ` ${join.type.toUpperCase()} JOIN ${tableSQL(join.table)} ON ${on}`;
}

function condSQL(cond: Condition, params: unknown[]): string {
  switch (cond.type) {
    case "eq": params.push(cond.right); return `${colSQL(cond.left)} = ?`;
    case "neq": params.push(cond.right); return `${colSQL(cond.left)} <> ?`;
    case "gt": params.push(cond.right); return `${colSQL(cond.left)} > ?`;
    case "lt": params.push(cond.right); return `${colSQL(cond.left)} < ?`;
    case "gte": params.push(cond.right); return `${colSQL(cond.left)} >= ?`;
    case "lte": params.push(cond.right); return `${colSQL(cond.left)} <= ?`;
    case "like": params.push(cond.pattern); return `${colSQL(cond.left)} LIKE ?`;
    case "notLike": params.push(cond.pattern); return `${colSQL(cond.left)} NOT LIKE ?`;
    case "between": params.push(cond.min, cond.max); return `${colSQL(cond.left)} BETWEEN ? AND ?`;
    case "in": params.push(...cond.values); return `${colSQL(cond.left)} IN (${cond.values.map(() => "?").join(", ")})`;
    case "notIn": params.push(...cond.values); return `${colSQL(cond.left)} NOT IN (${cond.values.map(() => "?").join(", ")})`;
    case "isNull": return `${colSQL(cond.left)} IS NULL`;
    case "isNotNull": return `${colSQL(cond.left)} IS NOT NULL`;
    case "and": return cond.conditions.length > 0
      ? cond.conditions.map((c) => `(${condSQL(c, params)})`).join(" AND ")
      : "1=1";
    case "or": return cond.conditions.length > 0
      ? cond.conditions.map((c) => `(${condSQL(c, params)})`).join(" OR ")
      : "1=0";
    case "not": return `NOT (${condSQL(cond.condition, params)})`;
    default: return "1=1";
  }
}
