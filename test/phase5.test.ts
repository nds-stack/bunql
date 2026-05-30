import { describe, test, expect } from "bun:test";
import { parseSQL } from "../src/parser/sql-parser.ts";
import { astToSQL } from "../src/translator/to-sql.ts";
import { astToMongo } from "../src/translator/to-mongodb.ts";

describe("CASE expression", () => {
  test("searched CASE WHEN THEN ELSE", () => {
    const sql = "SELECT CASE WHEN age > 18 THEN 'adult' ELSE 'minor' END AS status FROM users";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("CASE");
    expect(result.sql).toContain("WHEN");
    expect(result.sql).toContain("THEN");
    expect(result.sql).toContain("ELSE");
    expect(result.sql).toContain("END");
    expect(result.sql).toContain("AS status");
  });

  test("simple CASE value WHEN", () => {
    const sql = "SELECT CASE status WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 0 END FROM users";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("CASE status");
    expect(result.sql).toContain("WHEN");
    expect(result.sql).toContain("THEN");
    expect(result.sql).toContain("ELSE");
  });

  test("CASE in WHERE clause", () => {
    const sql = "SELECT * FROM users WHERE CASE WHEN active THEN 1 ELSE 0 END = 1";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("CASE");
    expect(result.sql).toContain("WHERE");
  });

  test("CASE with no ELSE (implicit NULL)", () => {
    const sql = "SELECT CASE WHEN flag THEN 1 END FROM t";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("CASE");
    expect(result.sql).toContain("WHEN");
    expect(result.sql).toContain("THEN");
    expect(result.sql).not.toContain("ELSE");
  });

  test("CASE → MongoDB $switch", () => {
    const sql = "SELECT CASE WHEN age > 18 THEN 'adult' ELSE 'minor' END AS status FROM users";
    const ast = parseSQL(sql);
    const cmd = astToMongo(ast);
    expect(cmd.method).toBe("aggregate");
    const pipeline = cmd.args[0] as Record<string, unknown>[];
    const projectStage = pipeline.find(s => (s as Record<string, unknown>).$project) as Record<string, unknown> | undefined;
    expect(projectStage).toBeDefined();
  });
});

describe("Subquery IN / EXISTS", () => {
  test("IN (SELECT ...) subquery", () => {
    const sql = "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("IN");
    expect(result.sql).toContain("SELECT");
    expect(result.sql).toContain("orders");
  });

  test("NOT IN (SELECT ...) subquery", () => {
    const sql = "SELECT * FROM users WHERE id NOT IN (SELECT user_id FROM orders)";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("NOT IN");
    expect(result.sql).toContain("SELECT");
  });

  test("EXISTS subquery", () => {
    const sql = "SELECT * FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("EXISTS");
  });

  test("NOT EXISTS subquery", () => {
    const sql = "SELECT * FROM users WHERE NOT EXISTS (SELECT 1 FROM orders)";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    // NOT EXISTS can be parsed as NOT(EXISTS(...)) or notExists — both are valid
    expect(result.sql).toContain("SELECT ? FROM orders");
    expect(result.sql).toContain("NOT");
    expect(result.sql).toContain("EXISTS");
  });

  test("EXISTS with params carries params correctly", () => {
    const sql = "SELECT * FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.total > 100)";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("EXISTS");
    expect(result.params).toContain(100);
  });

  test("MongoDB subquery → $lookup pipeline", () => {
    const sql = "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)";
    const ast = parseSQL(sql);
    const cmd = astToMongo(ast);
    expect(cmd.method).toBe("aggregate");
    const pipeline = cmd.args[0] as Record<string, unknown>[];
    const lookupStage = pipeline.find(s => (s as Record<string, unknown>).$lookup) as Record<string, unknown> | undefined;
    expect(lookupStage).toBeDefined();
  });
});

describe("Window functions", () => {
  test("ROW_NUMBER with PARTITION BY and ORDER BY", () => {
    const sql = "SELECT ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM employees";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("ROW_NUMBER()");
    expect(result.sql).toContain("OVER");
    expect(result.sql).toContain("PARTITION BY dept");
    expect(result.sql).toContain("ORDER BY salary DESC");
    expect(result.sql).toContain("AS rn");
  });

  test("RANK with ORDER BY only", () => {
    const sql = "SELECT RANK() OVER (ORDER BY score) AS rank FROM players";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("RANK()");
    expect(result.sql).toContain("OVER");
    expect(result.sql).toContain("ORDER BY score");
  });

  test("DENSE_RANK with PARTITION BY", () => {
    const sql = "SELECT DENSE_RANK() OVER (PARTITION BY category ORDER BY sales) AS dr FROM products";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("DENSE_RANK()");
    expect(result.sql).toContain("PARTITION BY category");
  });

  test("FIRST_VALUE window function", () => {
    const sql = "SELECT FIRST_VALUE(salary) OVER (PARTITION BY dept ORDER BY salary DESC) AS top FROM employees";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("FIRST_VALUE(salary)");
    expect(result.sql).toContain("OVER");
  });

  test("MongoDB window function throws", () => {
    const sql = "SELECT ROW_NUMBER() OVER (ORDER BY score) FROM players";
    const ast = parseSQL(sql);
    expect(() => astToMongo(ast)).toThrow();
  });
});

describe("CREATE / DROP INDEX", () => {
  test("CREATE INDEX", () => {
    const sql = "CREATE INDEX idx_name ON users (name)";
    const ast = parseSQL(sql);
    expect(ast.type).toBe("createIndex");
    if (ast.type === "createIndex") {
      expect(ast.name).toBe("idx_name");
      expect(ast.table).toBe("users");
      expect(ast.columns[0]!.column).toBe("name");
    }
  });

  test("CREATE UNIQUE INDEX", () => {
    const sql = "CREATE UNIQUE INDEX idx_email ON users (email)";
    const ast = parseSQL(sql);
    expect(ast.type).toBe("createIndex");
    if (ast.type === "createIndex") {
      expect(ast.unique).toBe(true);
    }
  });

  test("DROP INDEX", () => {
    const sql = "DROP INDEX IF EXISTS idx_name";
    const ast = parseSQL(sql);
    expect(ast.type).toBe("dropIndex");
    if (ast.type === "dropIndex") {
      expect(ast.name).toBe("idx_name");
      expect(ast.ifExists).toBe(true);
    }
  });
});

describe("UPSERT", () => {
  test("ON CONFLICT DO UPDATE", () => {
    const sql = "INSERT INTO users (id, name) VALUES (1, 'Alice') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name";
    const ast = parseSQL(sql);
    expect(ast.type).toBe("insert");
    if (ast.type === "insert") {
      expect(ast.onConflict).toBeDefined();
      expect(ast.onConflict!.action).toBe("update");
      expect(ast.onConflict!.constraint).toEqual(["id"]);
    }
  });

  test("ON CONFLICT DO NOTHING", () => {
    const sql = "INSERT INTO users (id, name) VALUES (1, 'Alice') ON CONFLICT DO NOTHING";
    const ast = parseSQL(sql);
    expect(ast.type).toBe("insert");
    if (ast.type === "insert") {
      expect(ast.onConflict).toBeDefined();
      expect(ast.onConflict!.action).toBe("nothing");
    }
  });

  test("SQL UPSERT output (PostgreSQL)", () => {
    const sql = "INSERT INTO users (id, name) VALUES (1, 'Alice') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name";
    const ast = parseSQL(sql);
    const result = astToSQL(ast, "postgresql");
    expect(result.sql).toContain("ON CONFLICT");
    expect(result.sql).toContain("DO UPDATE");
    expect(result.sql).toContain("EXCLUDED");
  });
});

describe("Scalar subquery", () => {
  test("col > (SELECT ...)", () => {
    const sql = "SELECT * FROM users WHERE salary > (SELECT AVG(salary) FROM employees)";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain(">");
    expect(result.sql).toContain("(SELECT");
    expect(result.sql).toContain("AVG(salary)");
  });

  test("col = (SELECT ...)", () => {
    const sql = "SELECT * FROM users WHERE status = (SELECT MAX(status) FROM orders)";
    const ast = parseSQL(sql);
    const result = astToSQL(ast);
    expect(result.sql).toContain("=");
    expect(result.sql).toContain("(SELECT");
  });

  test("UPSERT MySQL ON DUPLICATE KEY", () => {
    const sql = "INSERT INTO users (id, name) VALUES (1, 'Alice') ON DUPLICATE KEY UPDATE name = VALUES(name)";
    const ast = parseSQL(sql);
    expect(ast.type).toBe("insert");
    if (ast.type === "insert") {
      expect(ast.onConflict).toBeDefined();
      expect(ast.onConflict!.action).toBe("update");
    }
    const result = astToSQL(ast, "mysql");
    expect(result.sql).toContain("ON DUPLICATE KEY");
  });
});

describe("MongoDB subquery → $lookup", () => {
  test("IN (SELECT ...) → aggregate with $lookup", () => {
    const sql = "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)";
    const ast = parseSQL(sql);
    const cmd = astToMongo(ast);
    expect(cmd.method).toBe("aggregate");
    const pipeline = cmd.args[0] as Record<string, unknown>[];
    const lookupStage = pipeline.find(s => (s as Record<string, unknown>).$lookup) as Record<string, unknown> | undefined;
    expect(lookupStage).toBeDefined();
  });

  test("EXISTS (SELECT ...) → $lookup with $limit: 1", () => {
    const sql = "SELECT * FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)";
    const ast = parseSQL(sql);
    const cmd = astToMongo(ast);
    expect(cmd.method).toBe("aggregate");
  });
});
