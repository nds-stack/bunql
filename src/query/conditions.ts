/**
 * @module query/conditions
 * @description SQL condition helpers — builds AST condition nodes for the query builder.
 */

import type { ColumnExpr, Condition, Literal, OrderByNode } from "../ast/ast.ts";

export function col(name: string, table?: string): ColumnExpr {
  return { type: "column", name, table };
}

export function alias(expr: ColumnExpr, alias: string): ColumnExpr {
  return { type: "alias", name: expr.name, table: expr.table, alias };
}

export function wildcard(): ColumnExpr {
  return { type: "wildcard" };
}

export function lit(value: Literal): ColumnExpr {
  return { type: "literal", value };
}

export function func(name: string, ...args: ColumnExpr[]): ColumnExpr {
  return { type: "function", func: name, args };
}

export function eq(column: ColumnExpr, value: Literal): Condition {
  return { type: "eq", left: column, right: value };
}

export function neq(column: ColumnExpr, value: Literal): Condition {
  return { type: "neq", left: column, right: value };
}

export function gt(column: ColumnExpr, value: Literal): Condition {
  return { type: "gt", left: column, right: value };
}

export function lt(column: ColumnExpr, value: Literal): Condition {
  return { type: "lt", left: column, right: value };
}

export function gte(column: ColumnExpr, value: Literal): Condition {
  return { type: "gte", left: column, right: value };
}

export function lte(column: ColumnExpr, value: Literal): Condition {
  return { type: "lte", left: column, right: value };
}

export function like(column: ColumnExpr, pattern: string): Condition {
  return { type: "like", left: column, pattern };
}

export function notLike(column: ColumnExpr, pattern: string): Condition {
  return { type: "notLike", left: column, pattern };
}

export function inList(column: ColumnExpr, values: Literal[]): Condition {
  return { type: "in", left: column, values };
}

export function notIn(column: ColumnExpr, values: Literal[]): Condition {
  return { type: "notIn", left: column, values };
}

export function between(column: ColumnExpr, min: Literal, max: Literal): Condition {
  return { type: "between", left: column, min, max };
}

export function isNull(column: ColumnExpr): Condition {
  return { type: "isNull", left: column };
}

export function isNotNull(column: ColumnExpr): Condition {
  return { type: "isNotNull", left: column };
}

export function and(...conditions: Condition[]): Condition {
  return { type: "and", conditions };
}

export function or(...conditions: Condition[]): Condition {
  return { type: "or", conditions };
}

export function not(condition: Condition): Condition {
  return { type: "not", condition };
}

export function asc(column: ColumnExpr): OrderByNode {
  return { column, direction: "asc" };
}

export function desc(column: ColumnExpr): OrderByNode {
  return { column, direction: "desc" };
}

export type { ColumnExpr, Condition, Literal, OrderByNode };
