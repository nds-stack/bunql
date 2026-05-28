/**
 * @module query/relations/relations
 * @description Relations API — one()/many() for joined data fetching, Drizzle-compatible.
 */

export interface RelationDef {
  type: "one" | "many";
  /** SQL template with ? placeholder for the bind column value */
  sql: string;
  /** Column name from parent row to use as bind value (e.g. "id") */
  bind: string;
}

export interface RelationMap {
  [key: string]: RelationDef;
}

export type RelationsResult<T, R extends RelationMap> = T & {
  [K in keyof R]: R[K]["type"] extends "one" ? Record<string, unknown> | null
    : Record<string, unknown>[];
};

export type QueryExecutor = {
  executeSQL: (sql: string, params: unknown[]) => { columns: string[]; rows: Record<string, unknown>[] };
};

/**
 * Fetch a single row with related data.
 * Executes the parent query, then for each relation, executes the child query.
 */
export async function fetchOne<T extends Record<string, unknown>, R extends RelationMap>(
  executor: QueryExecutor,
  parentSql: string,
  parentParams: unknown[],
  relations: R,
): Promise<RelationsResult<T, R> | null> {
  const parentResult = executor.executeSQL(parentSql, parentParams);
  if (parentResult.rows.length === 0) return null;
  const row = parentResult.rows[0] as T;
  return attachRelations(executor, row, relations) as Promise<RelationsResult<T, R>>;
}

/**
 * Fetch multiple rows, each with related data attached.
 */
export async function fetchMany<T extends Record<string, unknown>, R extends RelationMap>(
  executor: QueryExecutor,
  parentSql: string,
  parentParams: unknown[],
  relations: R,
): Promise<RelationsResult<T, R>[]> {
  const parentResult = executor.executeSQL(parentSql, parentParams);
  const rows = parentResult.rows as T[];
  return Promise.all(rows.map((row) => attachRelations(executor, row, relations))) as Promise<RelationsResult<T, R>[]>;
}

async function attachRelations<T extends Record<string, unknown>>(
  executor: QueryExecutor,
  row: T,
  relations: RelationMap,
): Promise<T & Record<string, unknown>> {
  const result = { ...row } as Record<string, unknown>;

  for (const [key, rel] of Object.entries(relations)) {
    const bindValue = row[rel.bind];
    if (bindValue === undefined || bindValue === null) {
      result[key] = rel.type === "one" ? null : [];
      continue;
    }

    const childResult = executor.executeSQL(rel.sql, [bindValue]);

    if (rel.type === "one") {
      result[key] = childResult.rows[0] ?? null;
    } else {
      result[key] = childResult.rows;
    }
  }

  return result as T & Record<string, unknown>;
}

// ─── Table + Relation definitions (Drizzle-compatible) ──

export interface TableDef {
  name: string;
  columns: Record<string, { type: string }>;
}

export function defineTable(name: string, columns: Record<string, { type: string }>): TableDef {
  return { name, columns };
}

export interface RelationBuilder {
  one: (child: TableDef, config: { from: string; to: string }) => RelationDef;
  many: (child: TableDef, config: { from: string; to: string }) => RelationDef;
}

export function relations(
  _table: TableDef,
  cb: (r: RelationBuilder) => Record<string, RelationDef>,
): Record<string, RelationDef> {
  const builder: RelationBuilder = {
    one: (child, config) => ({
      type: "one",
      sql: `SELECT * FROM ${child.name} WHERE ${config.to} = ?`,
      bind: config.from,
    }),
    many: (child, config) => ({
      type: "many",
      sql: `SELECT * FROM ${child.name} WHERE ${config.to} = ?`,
      bind: config.from,
    }),
  };
  return cb(builder);
}

export type { };
