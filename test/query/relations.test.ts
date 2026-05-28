import { describe, test, expect } from "bun:test";
import { SqlQuery, sql, RelationsQuery } from "../../src/query/sql-builder.ts";
import { fetchOne, fetchMany, defineTable, relations } from "../../src/query/relations/relations.ts";
import type { RelationMap } from "../../src/query/relations/relations.ts";

const mockExecutor = {
  executeSQL: (sql: string, params: unknown[]) => {
    if (sql.includes("users WHERE id = ?")) {
      if (params[0] === 1) {
        return { columns: ["id", "name"], rows: [{ id: 1, name: "Alice" }] };
      }
      return { columns: ["id", "name"], rows: [] }; // not found
    }
    if (sql.includes("posts WHERE user_id = ?") && params[0] === 1) {
      return {
        columns: ["id", "title"],
        rows: [
          { id: 1, title: "Post 1" },
          { id: 2, title: "Post 2" },
        ],
      };
    }
    if (sql.includes("profile WHERE user_id = ?") && params[0] === 1) {
      return { columns: ["bio"], rows: [{ bio: "Hello!" }] };
    }
    if (sql === "SELECT * FROM users" || sql.includes("WHERE id = ?") === false && sql.includes("users")) {
      return {
        columns: ["id", "name"],
        rows: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      };
    }
    return { columns: [], rows: [] };
  },
  executeRun: () => ({ changes: 0, lastInsertRowid: 0 }),
  isAsync: false,
};

describe("Relations API", () => {
  test("fetchOne with one-to-one relation", async () => {
    const result = await fetchOne(mockExecutor, "SELECT * FROM users WHERE id = ?", [1], {
      profile: { type: "one", sql: "SELECT * FROM profile WHERE user_id = ?", bind: "id" },
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.name).toBe("Alice");
    expect(result!.profile).toEqual({ bio: "Hello!" });
  });

  test("fetchOne with has-many relation", async () => {
    const result = await fetchOne(mockExecutor, "SELECT * FROM users WHERE id = ?", [1], {
      posts: { type: "many", sql: "SELECT * FROM posts WHERE user_id = ?", bind: "id" },
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.posts).toHaveLength(2);
    expect(result!.posts[0]).toEqual({ id: 1, title: "Post 1" });
  });

  test("fetchMany with relations", async () => {
    const results = await fetchMany(mockExecutor, "SELECT * FROM users", [], {
      posts: { type: "many", sql: "SELECT * FROM posts WHERE user_id = ?", bind: "id" },
    });
    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe("Alice");
    expect(results[1]!.name).toBe("Bob");
  });

  test("fetchOne returns null for no results", async () => {
    const result = await fetchOne(mockExecutor, "SELECT * FROM users WHERE id = ?", [999], {
      posts: { type: "many", sql: "SELECT * FROM posts WHERE user_id = ?", bind: "id" },
    });
    expect(result).toBeNull();
  });

  test("SqlQuery.with().get() with relations", async () => {
    const q = new SqlQuery("SELECT * FROM users WHERE id = ?", [1], mockExecutor);
    const rq = q.with({
      profile: { type: "one", sql: "SELECT * FROM profile WHERE user_id = ?", bind: "id" },
    });
    const result = await rq.get();
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.profile).toEqual({ bio: "Hello!" });
  });

  test("SqlQuery.with().all() with relations", async () => {
    const q = new SqlQuery("SELECT * FROM users", [], mockExecutor);
    const rq = q.with({
      posts: { type: "many", sql: "SELECT * FROM posts WHERE user_id = ?", bind: "id" },
    });
    const result = await rq.all();
    expect(result).toHaveLength(2);
  });

  test("defineTable and relations builder", () => {
    const users = defineTable("users", { id: { type: "integer" }, name: { type: "string" } });
    const posts = defineTable("posts", { id: { type: "integer" }, userId: { type: "integer" }, title: { type: "string" } });

    const rels = relations(users, ({ many }) => ({
      posts: many(posts, { from: "id", to: "userId" }),
    })) as { posts: { type: string; sql: string; bind: string } };

    expect(rels.posts.type).toBe("many");
    expect(rels.posts.sql).toContain("posts");
    expect(rels.posts.bind).toBe("id");
  });

  test("RelationsQuery inherits properly", () => {
    const q = new SqlQuery("SELECT * FROM users WHERE id = ?", [1], mockExecutor);
    const rq = q.with({
      posts: { type: "many", sql: "SELECT * FROM posts WHERE user_id = ?", bind: "id" },
    });
    expect(rq).toBeInstanceOf(RelationsQuery);
  });
});
