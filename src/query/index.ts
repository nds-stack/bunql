/**
 * @module query/index
 * @description Re-exports for @nds-stack/bunql/query subpath.
 */

export { sql, SqlQuery, RelationsQuery } from "./sql-builder.ts";
export type { QueryExecutor } from "./sql-builder.ts";
export { MqlQuery } from "./mql-builder.ts";
export type { Executor as MqlExecutor } from "./mql-builder.ts";
export { fetchOne, fetchMany, defineTable, relations } from "./relations/relations.ts";
export type { RelationDef, RelationMap, RelationsResult, TableDef } from "./relations/relations.ts";
export {
  col, alias, wildcard, lit, func,
  eq, neq, gt, lt, gte, lte,
  like, notLike, inList, notIn, between,
  isNull, isNotNull,
  and, or, not,
  asc, desc,
} from "./conditions.ts";
export type { ColumnExpr, Condition, Literal, OrderByNode } from "./conditions.ts";
