/**
 * @module driver/index
 * @description Entry point for @nds-stack/bunql/driver subpath.
 */

export type { DriverAdapter, QueryResult, RunResult } from "./adapter.ts";
export { MongoDriver } from "./mongodb.ts";
export type { MongoDriverOptions } from "./mongodb.ts";
export { MongoError, ConnectionPool } from "./mongodb/connection.ts";
export { encodeBSON } from "./mongodb/bson-encoder.ts";
export { decodeBSON } from "./mongodb/bson-decoder.ts";
