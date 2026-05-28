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
export { MongoError, ConnectionPool as MongoConnectionPool } from "./mongodb/connection.ts";
export { RedisError, RedisConnectionPool } from "./redis/connection.ts";
export { PGError, PGConnectionPool } from "./pg/connection.ts";
export { encodeBSON } from "./mongodb/bson-encoder.ts";
export { decodeBSON } from "./mongodb/bson-decoder.ts";
export { encodeCommand, decodeSimple, type RESPValue } from "./redis/resp.ts";
