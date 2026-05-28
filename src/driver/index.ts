/**
 * @module driver/index
 * @description Entry point for @nds-stack/bunql/driver subpath.
 */

export type { DriverAdapter, QueryResult, RunResult } from "./adapter.ts";
export { MongoDriver } from "./mongodb.ts";
export type { MongoDriverOptions } from "./mongodb.ts";
export { RedisDriver } from "./redis.ts";
export type { RedisDriverOptions } from "./redis.ts";
export { PGDriver } from "./pg.ts";
export type { PGDriverOptions } from "./pg.ts";
export { MySQLDriver } from "./mysql.ts";
export type { MySQLDriverOptions } from "./mysql.ts";
export { TransactionManager } from "./transaction.ts";
export type { TransactionBackend, TxContext } from "./transaction.ts";
export { MongoError } from "./mongodb/error.ts";
export { ConnectionPool as MongoConnectionPool } from "./mongodb/pool.ts";
export { RedisError } from "./redis/error.ts";
export { RedisConnectionPool } from "./redis/pool.ts";
export { PGError } from "./pg/error.ts";
export { PGConnectionPool } from "./pg/pool.ts";
export { MySQLError } from "./mysql/error.ts";
export { MySQLConnectionPool } from "./mysql/pool.ts";
export { encodeBSON } from "./mongodb/bson-encoder.ts";
export { decodeBSON } from "./mongodb/bson-decoder.ts";
export { encodeCommand, decodeSimple, type RESPValue } from "./redis/resp.ts";
