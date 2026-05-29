/**
 * @module universal-ast
 * @description Universal AST node types — single IR for all query languages (SQL, MQL, Redis).
 */

export type ASTNode = SelectNode | InsertNode | UpdateNode | DeleteNode | AggregateNode | CreateTableNode | RawNode;

export interface SelectNode {
  type: "select";
  columns: ColumnExpr[];
  from: TableRef;
  joins?: JoinNode[];
  where?: Condition;
  groupBy?: ColumnExpr[];
  having?: Condition;
  orderBy?: OrderByNode[];
  limit?: number;
  offset?: number;
  distinct?: boolean;
}

export interface ParamRef {
  type: "param";
  index: number;
}

export type ValueExpr = Literal | ParamRef;

export interface InsertNode {
  type: "insert";
  table: string;
  columns?: string[];
  values: ValueExpr[][];
  returning?: string[];
}

export interface UpdateNode {
  type: "update";
  table: string;
  set: Record<string, ValueExpr | ColumnExpr>;
  where?: Condition;
  returning?: string[];
}

export interface DeleteNode {
  type: "delete";
  table: string;
  where?: Condition;
}

export interface AggregateNode {
  type: "aggregate";
  table: string;
  pipeline: AggregateStage[];
}

export interface RawNode {
  type: "raw";
  sql: string;
  params?: unknown[];
}

export interface ColumnDef {
  name: string;
  dataType: string;
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  defaultValue?: Literal;
}

export interface CreateTableNode {
  type: "createTable";
  table: string;
  columns: ColumnDef[];
  ifNotExists?: boolean;
}

export type AggregateStage =
  | { stage: "match"; condition: Condition }
  | { stage: "group"; id: Record<string, string | null>; accumulators: Record<string, Accumulator> }
  | { stage: "sort"; fields: OrderByNode[] }
  | { stage: "limit"; count: number }
  | { stage: "skip"; count: number }
  | { stage: "project"; fields: Record<string, number | string | boolean> }
  | { stage: "lookup"; from: string; localField: string; foreignField: string; as: string }
  | { stage: "lookup"; from: string; let?: Record<string, string>; pipeline: AggregateStage[]; as: string }
  | { stage: "unwind"; path: string; preserveNullAndEmptyArrays?: boolean; includeArrayIndex?: string };

export type Accumulator = { func: "sum" | "avg" | "min" | "max" | "count" | "push"; field: string };

export interface ColumnExpr {
  type: "column" | "alias" | "wildcard" | "literal" | "function" | "binary";
  name?: string;
  table?: string;
  alias?: string;
  value?: Literal;
  func?: string;
  args?: ColumnExpr[];
  left?: ColumnExpr;
  right?: ColumnExpr;
  op?: string;
}

export interface TableRef {
  name: string;
  alias?: string;
  subquery?: SelectNode;
  joinType?: string;
}

export interface JoinNode {
  type: "inner" | "left" | "right";
  table: TableRef;
  on: Condition;
}

export interface OrderByNode {
  column: ColumnExpr;
  direction: "asc" | "desc";
}

export type Literal = string | number | boolean | null | Date | Literal[] | { [key: string]: Literal };

export type Condition =
  | EqCondition | NeqCondition | GtCondition | LtCondition | GteCondition | LteCondition
  | AndCondition | OrCondition | NotCondition
  | LikeCondition | NotLikeCondition
  | ModCondition
  | SizeCondition | TypeCheckCondition
  | InCondition | NotInCondition
  | BetweenCondition
  | IsNullCondition | IsNotNullCondition;

export interface EqCondition   { type: "eq";   left: ColumnExpr; right: ValueExpr; }
export interface NeqCondition  { type: "neq";  left: ColumnExpr; right: ValueExpr; }
export interface GtCondition   { type: "gt";   left: ColumnExpr; right: ValueExpr; }
export interface LtCondition   { type: "lt";   left: ColumnExpr; right: ValueExpr; }
export interface GteCondition  { type: "gte";  left: ColumnExpr; right: ValueExpr; }
export interface LteCondition  { type: "lte";  left: ColumnExpr; right: ValueExpr; }
export interface AndCondition  { type: "and";  conditions: Condition[]; }
export interface OrCondition   { type: "or";   conditions: Condition[]; }
export interface NotCondition  { type: "not";  condition: Condition; }
export interface LikeCondition { type: "like"; left: ColumnExpr; pattern: ValueExpr; flags?: string; }
export interface NotLikeCondition { type: "notLike"; left: ColumnExpr; pattern: ValueExpr; flags?: string; }
export interface ModCondition { type: "mod"; left: ColumnExpr; divisor: ValueExpr; remainder: ValueExpr; }
export interface SizeCondition { type: "size"; left: ColumnExpr; count: ValueExpr; }
export interface TypeCheckCondition { type: "typeCheck"; left: ColumnExpr; bsonType: string; }
export interface InCondition   { type: "in";   left: ColumnExpr; values: ValueExpr[]; }
export interface NotInCondition { type: "notIn"; left: ColumnExpr; values: ValueExpr[]; }
export interface BetweenCondition { type: "between"; left: ColumnExpr; min: ValueExpr; max: ValueExpr; }
export interface IsNullCondition { type: "isNull"; left: ColumnExpr; }
export interface IsNotNullCondition { type: "isNotNull"; left: ColumnExpr; }

export function col(name: string, table?: string): ColumnExpr {
  return { type: "column", name, table };
}

export function colAlias(name: string, alias: string, table?: string): ColumnExpr {
  return { type: "alias", name, table, alias };
}

export function wildcard(): ColumnExpr {
  return { type: "wildcard" };
}

export function lit(value: Literal): ColumnExpr {
  return { type: "literal", value };
}

export function funcExpr(func: string, ...args: ColumnExpr[]): ColumnExpr {
  return { type: "function", func, args };
}

export function table(name: string, alias?: string): TableRef {
  return { name, alias };
}

export function eq(left: ColumnExpr, right: ValueExpr): EqCondition {
  return { type: "eq", left, right };
}

export function and(...conditions: Condition[]): AndCondition {
  return { type: "and", conditions };
}

export function or(...conditions: Condition[]): OrCondition {
  return { type: "or", conditions };
}

export function orderBy(column: ColumnExpr, direction: "asc" | "desc" = "asc"): OrderByNode {
  return { column, direction };
}
