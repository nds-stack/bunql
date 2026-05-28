/**
 * @module translator/index
 */
export { astToSQL } from "./to-sql.ts";
export type { SQLResult } from "./to-sql.ts";
export { astToMongo } from "./to-mongodb.ts";
export type { MongoCommand } from "./to-mongodb.ts";
export { astToRedis } from "./to-redis.ts";
export type { RedisCommand } from "./to-redis.ts";
