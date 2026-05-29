/**
 * @module test-sql-parser
 * @description Tests for SQL parser — lexer + parser.
 */
import { describe, test, expect } from "bun:test";
import { parseSQL } from "../../src/parser/sql-parser.ts";
import { Lexer } from "../../src/parser/sql-lexer.ts";
import type { SelectNode, InsertNode, UpdateNode, DeleteNode, ASTNode } from "../../src/ast/ast.ts";

describe("Lexer", () => {
  test("tokenizes simple SELECT", () => {
    const lex = new Lexer("SELECT id, name FROM users");
    const tokens = lex.all().filter((t) => t.type !== "eof");
    expect(tokens[0]!.value).toBe("select");
    expect(tokens[1]!.value).toBe("id");
    expect(tokens[2]!.value).toBe(",");
    expect(tokens[5]!.value).toBe("users");
  });

  test("tokenizes INSERT", () => {
    const lex = new Lexer("INSERT INTO users (name) VALUES ('Alice')");
    const tokens = lex.all().filter((t) => t.type !== "eof");
    expect(tokens[0]!.value).toBe("insert");
    expect(tokens[2]!.value).toBe("users");
    expect(tokens[8]!.value).toBe("Alice");
  });

  test("tokenizes WHERE conditions", () => {
    const lex = new Lexer("WHERE age > 25 AND name = 'Bob'");
    const tokens = lex.all().filter((t) => t.type !== "eof");
    expect(tokens[0]!.value).toBe("where");
    expect(tokens[2]!.value).toBe(">");
    expect(tokens[4]!.value).toBe("and");
  });

  test("tokenizes operators", () => {
    const lex = new Lexer(">= <= <> !=");
    const tokens = lex.all().filter((t) => t.type !== "eof");
    expect(tokens[0]!.value).toBe(">=");
    expect(tokens[1]!.value).toBe("<=");
    expect(tokens[2]!.value).toBe("<>");
  });

  test("tokenizes numbers", () => {
    const lex = new Lexer("42 3.14");
    const tokens = lex.all().filter((t) => t.type !== "eof");
    expect(tokens[0]!.value).toBe("42");
    expect(tokens[1]!.value).toBe("3.14");
  });

  test("peek does not consume", () => {
    const lex = new Lexer("SELECT 1");
    const peeked = lex.peek();
    expect(peeked.value).toBe("select");
    const next = lex.next();
    expect(next.value).toBe("select");
  });

  test("skips single-line comments", () => {
    const lex = new Lexer("-- comment\nSELECT 1");
    const tokens = lex.all().filter((t) => t.type !== "eof");
    expect(tokens[0]!.value).toBe("select");
  });
});

describe("SQL Parser", () => {
  const asSelect = (ast: ASTNode): SelectNode => {
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    return ast;
  };
  const asInsert = (ast: ASTNode): InsertNode => {
    if (ast.type !== "insert") throw new Error(`Expected insert, got ${ast.type}`);
    return ast;
  };
  const asUpdate = (ast: ASTNode): UpdateNode => {
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    return ast;
  };
  const asDelete = (ast: ASTNode): DeleteNode => {
    if (ast.type !== "delete") throw new Error(`Expected delete, got ${ast.type}`);
    return ast;
  };

  test("parses simple SELECT", () => {
    const ast = asSelect(parseSQL("SELECT id, name FROM users"));
    expect(ast.columns.length).toBe(2);
    expect(ast.from.name).toBe("users");
  });

  test("parses SELECT *", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users"));
    expect(ast.columns[0]!.type).toBe("wildcard");
  });

  test("parses SELECT with WHERE", () => {
    const ast = asSelect(parseSQL("SELECT name FROM users WHERE age > 25"));
    expect(ast.where).toBeDefined();
    expect(ast.where!.type).toBe("gt");
  });

  test("parses SELECT with WHERE AND", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users WHERE age > 25 AND active = true"));
    expect(ast.where).toBeDefined();
    expect(ast.where!.type).toBe("and");
  });

  test("parses SELECT with ORDER BY and LIMIT", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users ORDER BY name DESC LIMIT 10"));
    expect(ast.orderBy).toBeDefined();
    expect(ast.orderBy![0]!.direction).toBe("desc");
    expect(ast.limit).toBe(10);
  });

  test("parses SELECT with GROUP BY", () => {
    const ast = asSelect(parseSQL("SELECT status, COUNT(*) FROM orders GROUP BY status"));
    expect(ast.groupBy).toBeDefined();
    expect(ast.groupBy!.length).toBe(1);
  });

  test("parses SELECT with JOIN", () => {
    const ast = asSelect(parseSQL("SELECT u.name, o.total FROM users u LEFT JOIN orders o ON u.id = o.user_id"));
    expect(ast.joins).toBeDefined();
    expect(ast.joins![0]!.type).toBe("left");
  });

  test("parses INSERT", () => {
    const ast = asInsert(parseSQL("INSERT INTO users (name, email) VALUES ('Alice', 'a@t.com')"));
    expect(ast.table).toBe("users");
    expect(ast.columns).toEqual(["name", "email"]);
  });

  test("parses UPDATE", () => {
    const ast = asUpdate(parseSQL("UPDATE users SET name = 'Bob' WHERE id = 1"));
    expect(ast.table).toBe("users");
    expect(ast.where).toBeDefined();
  });

  test("parses DELETE", () => {
    const ast = asDelete(parseSQL("DELETE FROM users WHERE id = 1"));
    expect(ast.table).toBe("users");
  });

  test("parses LIKE condition", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users WHERE name LIKE 'A%'"));
    expect(ast.where!.type).toBe("like");
  });

  test("parses IN condition", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users WHERE id IN (1, 2, 3)"));
    expect(ast.where!.type).toBe("in");
  });

  test("parses BETWEEN condition", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users WHERE age BETWEEN 18 AND 65"));
    expect(ast.where!.type).toBe("between");
  });

  test("parses IS NULL", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users WHERE email IS NULL"));
    expect(ast.where!.type).toBe("isNull");
  });

  test("parses SELECT DISTINCT", () => {
    const ast = asSelect(parseSQL("SELECT DISTINCT status FROM orders"));
    expect(ast.distinct).toBe(true);
  });

  test("parses SELECT with OFFSET", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users LIMIT 10 OFFSET 20"));
    expect(ast.limit).toBe(10);
    expect(ast.offset).toBe(20);
  });

  test("throws on invalid SQL", () => {
    expect(() => parseSQL("INVALID SQL HERE")).toThrow();
  });

  test("parses SELECT with table alias", () => {
    const ast = asSelect(parseSQL("SELECT u.id FROM users u"));
    expect(ast.from.alias).toBe("u");
  });

  test("parses HAVING clause", () => {
    const ast = parseSQL("SELECT status, COUNT(*) FROM orders GROUP BY status HAVING COUNT(*) > 1");
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    expect(ast.having).toBeDefined();
    expect(ast.having!.type).toBe("gt");
  });

  test("parses CTE WITH", () => {
    const ast = parseSQL("WITH cte AS (SELECT * FROM users) SELECT * FROM cte");
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    expect(ast.ctes).toBeDefined();
    expect(ast.ctes!.length).toBe(1);
    expect(ast.ctes![0]!.name).toBe("cte");
  });

  test("parses UNION", () => {
    const ast = parseSQL("SELECT * FROM a UNION SELECT * FROM b");
    expect(ast.type).toBe("setOp");
    if (ast.type === "setOp") {
      expect(ast.op).toBe("union");
    }
  });

  test("parses UNION ALL", () => {
    const ast = parseSQL("SELECT * FROM a UNION ALL SELECT * FROM b");
    expect(ast.type).toBe("setOp");
    if (ast.type === "setOp") {
      expect(ast.op).toBe("unionAll");
    }
  });

  test("parses INTERSECT", () => {
    const ast = parseSQL("SELECT * FROM a INTERSECT SELECT * FROM b");
    expect(ast.type).toBe("setOp");
    if (ast.type === "setOp") {
      expect(ast.op).toBe("intersect");
    }
  });

  test("parses EXCEPT", () => {
    const ast = parseSQL("SELECT * FROM a EXCEPT SELECT * FROM b");
    expect(ast.type).toBe("setOp");
    if (ast.type === "setOp") {
      expect(ast.op).toBe("except");
    }
  });

  test("parses subquery FROM", () => {
    const ast = parseSQL("SELECT * FROM (SELECT id, name FROM users) AS t");
    if (ast.type !== "select") throw new Error(`Expected select, got ${ast.type}`);
    expect(ast.from.subquery).toBeDefined();
    expect(ast.from.subquery!.type).toBe("select");
  });

  test("parses INSERT...SELECT", () => {
    const ast = parseSQL("INSERT INTO archive SELECT * FROM users WHERE active = 0");
    if (ast.type === "insert" && ast.select) {
      expect(ast.select.type).toBe("select");
    } else {
      throw new Error(`Expected insert with select, got ${ast.type}`);
    }
  });

  test("parses RETURNING id", () => {
    const ast = parseSQL("INSERT INTO users (name) VALUES ('Alice') RETURNING id");
    if (ast.type !== "insert") throw new Error(`Expected insert, got ${ast.type}`);
    expect(ast.returning).toBeDefined();
    expect(ast.returning!.length).toBe(1);
    expect(ast.returning![0]).toBe("id");
  });

  test("parses RETURNING multiple columns", () => {
    const ast = parseSQL("INSERT INTO users (name) VALUES ('Bob') RETURNING id, name");
    if (ast.type !== "insert") throw new Error(`Expected insert, got ${ast.type}`);
    expect(ast.returning).toBeDefined();
    expect(ast.returning!.length).toBe(2);
  });

  test("parses arithmetic expression in SELECT", () => {
    const ast = asSelect(parseSQL("SELECT price * qty AS total FROM orders"));
    expect(ast.columns.length).toBe(1);
  });

  test("parses SELECT with OFFSET only", () => {
    const ast = asSelect(parseSQL("SELECT * FROM users LIMIT 10 OFFSET 5"));
    expect(ast.limit).toBe(10);
    expect(ast.offset).toBe(5);
  });

  test("parses COUNT(DISTINCT col)", () => {
    const ast = asSelect(parseSQL("SELECT COUNT(DISTINCT status) FROM orders"));
    expect(ast.columns.length).toBe(1);
  });

  test("parses UPDATE with RETURNING", () => {
    const ast = parseSQL("UPDATE users SET name = 'Alice' WHERE id = 1 RETURNING id, name");
    if (ast.type !== "update") throw new Error(`Expected update, got ${ast.type}`);
    expect(ast.returning).toBeDefined();
    expect(ast.returning!.length).toBe(2);
  });

  test("parses DELETE with RETURNING", () => {
    const ast = parseSQL("DELETE FROM users WHERE id = 1 RETURNING id");
    if (ast.type !== "delete") throw new Error(`Expected delete, got ${ast.type}`);
    expect(ast.returning).toBeDefined();
    expect(ast.returning!.length).toBe(1);
    expect(ast.returning![0]).toBe("id");
  });

  test("parses DROP TABLE", () => {
    const ast = parseSQL("DROP TABLE IF EXISTS users");
    expect(ast.type).toBe("dropTable");
    if (ast.type === "dropTable") {
      expect(ast.table).toBe("users");
      expect(ast.ifExists).toBe(true);
    }
  });

  test("parses CREATE TABLE with constraints", () => {
    const ast = parseSQL("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    expect(ast.type).toBe("createTable");
    if (ast.type === "createTable") {
      expect(ast.table).toBe("users");
      expect(ast.columns.length).toBe(2);
      expect(ast.columns[0]!.primaryKey).toBe(true);
      expect(ast.columns[1]!.notNull).toBe(true);
    }
  });
});
