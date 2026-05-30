/**
 * @module sql-parser
 * @description Hand-written recursive descent SQL parser — tokens → Universal AST.
 */
import { Lexer, type Token } from "./sql-lexer.ts";
import type { ASTNode, ColumnExpr, Condition, CreateTableNode, JoinNode, OrderByNode, SelectNode, TableRef, ValueExpr } from "../ast/ast.ts";
import { ParseError } from "../errors/parse-error.ts";

export { ParseError };

export function parseSQL(sql: string): ASTNode {
  const lexer = new Lexer(sql);
  const parser = new Parser(lexer);
  return parser.parse();
}

class Parser {
  #lex: Lexer;
  #current: Token;
  #paramIndex = 0;

  constructor(lex: Lexer) {
    this.#lex = lex;
    this.#current = lex.next();
  }

  parse(): ASTNode {
    this.#paramIndex = 0;
    const kw = this.#current.value;

    // Check for WITH clause (CTE) before any statement
    let ctes: import("../ast/ast.ts").SelectNode["ctes"];
    if (kw === "with") {
      this.#advance();
      ctes = [];
      do {
        if (this.#current.value === ",") this.#advance();
        const name = this.#parseIdentifier();
        let columns: string[] | undefined;
        if (this.#match("(")) {
          columns = this.#parseColumnList();
          this.#expect(")");
        }
        this.#expect("as");
        this.#expect("(");
        const query = this.#parseSelect();
        this.#expect(")");
        ctes.push({ name, columns, query });
      } while (this.#current.value === ",");

      // After CTE, expect a SELECT
      const selectNode = this.#parseSelect();
      selectNode.ctes = ctes;
      return selectNode;
    }

    switch (kw) {
      case "select": {
        const left = this.#parseSelect();

        // Check for set operations: UNION, INTERSECT, EXCEPT
        if (this.#match("union") || this.#current.value === "union") {
          if (this.#match("all")) return this.#makeSetOp("unionAll", left);
          return this.#makeSetOp("union", left);
        }
        if (this.#match("intersect")) return this.#makeSetOp("intersect", left);
        if (this.#match("except")) return this.#makeSetOp("except", left);

        return left;
      }
      case "insert": return this.#parseInsert();
      case "update": return this.#parseUpdate();
      case "delete": return this.#parseDelete();
      case "create": {
        const peeked = this.#lex.peek().value;
        if (peeked === "index" || peeked === "unique") {
          return this.#parseCreateIndex();
        }
        return this.#parseCreateTable();
      }
      case "drop": {
        // Distinguish DROP TABLE / DROP INDEX
        if (this.#lex.peek().value === "index") {
          return this.#parseDropIndex();
        }
        return this.#parseDropTable();
      }
      case "begin":
      case "commit":
      case "rollback":
        this.#advance();
        return { type: "raw", sql: kw.toUpperCase(), params: [] };
      default:
        throw new ParseError(`Unexpected keyword: ${kw}`, this.#current.pos);
    }
  }

  #parseDropTable(): ASTNode {
    this.#expect("drop");
    this.#expect("table");
    const ifExists = this.#match("if") && this.#match("exists");
    const table = this.#parseIdentifier();
    return { type: "dropTable", table, ifExists };
  }

  #parseCreateIndex(): ASTNode {
    this.#expect("create");
    const unique = this.#match("unique");
    this.#expect("index");
    const ifNotExists = this.#match("if") && this.#match("not") && this.#match("exists");
    const name = this.#parseIdentifier();
    this.#expect("on");
    const table = this.#parseIdentifier();
    this.#expect("(");
    const columns: { column: string; order?: "asc" | "desc" }[] = [];
    do {
      if (this.#current.value === ",") this.#advance();
      const col = this.#parseIdentifier();
      const order = this.#match("asc") ? "asc" : this.#match("desc") ? "desc" : undefined;
      columns.push({ column: col, order });
    } while (this.#current.value === ",");
    this.#expect(")");
    return { type: "createIndex", table, name, columns, unique, ifNotExists } as ASTNode;
  }

  #parseDropIndex(): ASTNode {
    this.#expect("drop");
    this.#expect("index");
    const ifExists = this.#match("if") && this.#match("exists");
    const name = this.#parseIdentifier();
    return { type: "dropIndex", name, ifExists } as ASTNode;
  }

  #makeSetOp(op: import("../ast/ast.ts").SetOpNode["op"], left: import("../ast/ast.ts").SelectNode): import("../ast/ast.ts").SetOpNode {
    const right = this.#parseSelect();
    return { type: "setOp", op, left, right };
  }

  #parseSelect(): SelectNode {
    this.#expect("select");
    const distinct = this.#match("distinct");
    const columns = this.#parseColumns();
    const from = this.#parseFrom();
    const joins = this.#parseJoins();
    const where = this.#match("where") ? this.#parseWhere() : undefined;
    const groupBy = this.#match("group") ? this.#parseGroupBy() : undefined;
    const having = this.#match("having") ? this.#parseWhere() : undefined;
    const orderBy = this.#match("order") ? this.#parseOrderBy() : undefined;
    const limit = this.#match("limit") ? this.#parseLimit() : undefined;
    const offset = this.#match("offset") ? this.#parseOffset() : undefined;

    return {
      type: "select", columns, from, joins: joins.length > 0 ? joins : undefined,
      where, groupBy, having, orderBy, limit, offset, distinct,
    };
  }

  #parseInsert(): ASTNode {
    this.#expect("insert");
    this.#expect("into");
    const table = this.#parseIdentifier();
    const columns = this.#match("(") ? (() => { const cols = this.#parseColumnList(); this.#expect(")"); return cols; })() : undefined;

    // Check for INSERT...SELECT variant
    if (this.#current.value === "select") {
      const select = this.#parseSelect();
      return { type: "insert", table, columns, select, values: [], returning: undefined };
    }

    this.#expect("values");

    const values: ValueExpr[][] = [];
    do {
      if (this.#current.value === ",") this.#advance();
      this.#expect("(");
      const row: ValueExpr[] = [];
      do {
        if (this.#current.value === ",") this.#advance();
        row.push(this.#parseLiteral());
      } while (this.#current.value === ",");
      values.push(row);
      this.#expect(")");
    } while (this.#current.value === ",");

    let returning: string[] | undefined;
    if (this.#match("returning")) {
      returning = this.#parseColumnList();
    }

    // UPSERT: ON CONFLICT (PostgreSQL) / ON DUPLICATE KEY (MySQL)
    let onConflict: import("../ast/ast.ts").InsertNode["onConflict"];
    if (this.#match("on")) {
      if (this.#match("conflict")) {
        // PostgreSQL: ON CONFLICT [(col1, col2)] DO [UPDATE SET ... | NOTHING]
        let constraint: string[] | undefined;
        if (this.#match("(")) {
          constraint = this.#parseColumnList();
          this.#expect(")");
        }
        if (this.#match("do")) {
          if (this.#match("nothing")) {
            onConflict = { action: "nothing", constraint };
          } else if (this.#match("update")) {
            this.#expect("set");
            const set: Record<string, import("../ast/ast.ts").ValueExpr> = {};
            do {
              if (this.#current.type === "comma") this.#advance();
              const col = this.#parseIdentifier();
              this.#expect("=");
              this.#expect("excluded"); // EXCLUDED.col
              this.#expect(".");
              set[col] = this.#parseIdentifier() as unknown as import("../ast/ast.ts").ValueExpr;
            } while (this.#current.type === "comma");
            onConflict = { action: "update", constraint, set };
          }
        }
      } else if (this.#match("duplicate")) {
        // MySQL: ON DUPLICATE KEY UPDATE col1 = VALUES(col1), ...
        this.#expect("key");
        this.#expect("update");
        const set: Record<string, import("../ast/ast.ts").ValueExpr> = {};
        do {
          if (this.#current.type === "comma") this.#advance();
          const col = this.#parseIdentifier();
          this.#expect("=");
          // VALUES(col) — store col name, translator emits VALUES(col)
          this.#expect("values");
          this.#expect("(");
          set[col] = this.#parseIdentifier() as unknown as import("../ast/ast.ts").ValueExpr;
          this.#expect(")");
        } while (this.#current.type === "comma");
        onConflict = { action: "update", set };
      }
    }

    return { type: "insert", table, columns, values, select: undefined, returning, onConflict };
  }

  #parseUpdate(): ASTNode {
    this.#expect("update");
    const table = this.#parseIdentifier();
    this.#expect("set");
    const set: Record<string, ValueExpr> = {};
    do {
      if (this.#current.type === "comma") this.#advance();
      const col = this.#parseIdentifier();
      this.#expect("=");
      set[col] = this.#parseLiteral();
    } while (this.#current.type === "comma");

    const where = this.#match("where") ? this.#parseWhere() : undefined;
    let returning: string[] | undefined;
    if (this.#match("returning")) {
      returning = this.#parseColumnList();
    }
    return { type: "update", table, set, where, returning };
  }

  #parseDelete(): ASTNode {
    this.#expect("delete");
    this.#expect("from");
    const table = this.#parseIdentifier();
    const where = this.#match("where") ? this.#parseWhere() : undefined;
    let returning: string[] | undefined;
    if (this.#match("returning")) {
      returning = this.#parseColumnList();
    }
    return { type: "delete", table, where, returning };
  }

  #parseCreateTable(): CreateTableNode {
    this.#expect("create");
    this.#expect("table");

    const ifNotExists = this.#match("if") && this.#match("not") && this.#match("exists");

    const table = this.#parseIdentifier();
    this.#expect("(");

    const columns: import("../ast/ast.ts").ColumnDef[] = [];

    do {
      if (this.#current.type === "comma") this.#advance();

      const name = this.#parseIdentifier();
      const dataType = this.#parseIdentifier();

      let primaryKey = false;
      let notNull = false;
      let unique = false;
      let defaultValue: import("../ast/ast.ts").Literal | undefined;

      while (this.#current.type === "keyword") {
        if (this.#match("primary")) {
          this.#expect("key");
          primaryKey = true;
        } else if (this.#match("not")) {
          this.#expect("null");
          notNull = true;
        } else if (this.#match("unique")) {
          unique = true;
        } else if (this.#match("default")) {
          defaultValue = this.#parseLiteral() as import("../ast/ast.ts").Literal;
        } else {
          break;
        }
      }

      columns.push({ name, dataType, primaryKey, notNull, unique, defaultValue });
    } while (this.#current.type === "comma");

    this.#expect(")");

    return { type: "createTable", table, columns, ifNotExists };
  }

  #parseColumns(): ColumnExpr[] {
    if (this.#current.value === "*") { this.#advance(); return [{ type: "wildcard" }]; }
    if (this.#current.value === ")") return []; // Empty arg list for functions like ROW_NUMBER()
    const cols: ColumnExpr[] = [];
    do {
      if (this.#current.value === ",") this.#advance();
      cols.push(this.#parseColumnExpr());
    } while (this.#current.value === ",");
    return cols;
  }

  #parseColumnExpr(): ColumnExpr {
    // CASE expression: CASE [value] WHEN ... THEN ... [ELSE ...] END
    const curVal = this.#current.value;
    if (curVal === "case") {
      this.#advance();
      const nextVal = this.#current.value;
      let caseValue: ColumnExpr | undefined;
      // If next token is not WHEN, it's a simple CASE with value expression
      if ((nextVal as string) !== "when") {
        caseValue = this.#parseColumnExpr();
      }

      const branches: { when: ColumnExpr | Condition; then: ValueExpr }[] = [];
      while (this.#match("when")) {
        const whenExpr = caseValue
          ? this.#parseColumnExpr()  // Simple: WHEN literal/value
          : this.#parseOr();          // Searched: WHEN condition
        this.#expect("then");
        const thenExpr = this.#parseColumnExpr();  // Use parseColumnExpr for nested CASE support
        branches.push({ when: whenExpr, then: thenExpr.value ?? thenExpr as unknown as ValueExpr });
      }

      let elseExpr: ValueExpr | undefined;
      if (this.#match("else")) {
        const e = this.#parseColumnExpr();
        elseExpr = e.value ?? e as unknown as ValueExpr;
      }
      this.#expect("end");

      let alias: string | undefined;
      if (this.#match("as") || this.#current.type === "identifier") {
        alias = this.#parseIdentifier();
      }

      return { type: "case", caseValue, branches, else: elseExpr, alias } as ColumnExpr;
    }

    if (this.#current.type === "string") {
      const v = this.#current.value; this.#advance();
      return { type: "literal", value: v };
    }
    if (this.#current.type === "number") {
      const v = Number(this.#current.value); this.#advance();
      return { type: "literal", value: v };
    }

    let expr: ColumnExpr;

    if (this.#isFunction()) {
      const func = this.#parseIdentifier();
      this.#expect("(");
      const distinct = this.#match("distinct");
      const args = this.#parseColumns();
      this.#expect(")");
      expr = { type: "function", func, args, ...(distinct ? { distinct: true } : {}) };

      // OVER clause for window functions
      if (this.#match("over")) {
        this.#expect("(");
        let partitionBy: ColumnExpr[] | undefined;
        if (this.#match("partition")) {
          this.#expect("by");
          partitionBy = this.#parseColumns();
        }
        let orderBy: import("../ast/ast.ts").OrderByNode[] | undefined;
        if (this.#match("order")) {
          orderBy = this.#parseOrderBy();
        }
        this.#expect(")");
        (expr as import("../ast/ast.ts").ColumnExpr).over = { partitionBy, orderBy };
      }
    } else {
      const name = this.#parseIdentifier();
      expr = { type: "column", name };
      if (this.#current.type === "dot") {
        this.#advance();
        const colName = this.#parseIdentifier();
        expr = { type: "column", table: name, name: colName };
      }
    }

    // Arithmetic operators: + - * / %
    const ARITH_OPS = new Set(["+", "-", "*", "/", "%"]);
    while (this.#current.type === "operator" && ARITH_OPS.has(this.#current.value)) {
      const op = this.#current.value;
      this.#advance();
      const right = this.#parseColumnExpr();
      expr = { type: "binary", left: expr, op, right };
    }

    if (this.#match("as") || this.#current.type === "identifier") {
      const alias = this.#parseIdentifier();
      expr = { ...expr, alias };
    }

    return expr;
  }

  #parseFrom(): TableRef {
    this.#expect("from");

    // Subquery: FROM (SELECT ...) AS alias
    if (this.#current.type === "lparen") {
      this.#advance();
      const subquery = this.#parseSelect();
      // consume closing paren — use value check since type narrowing is strict
      if (this.#current.value === ")") this.#advance();
      let alias: string | undefined;
      if (this.#match("as")) {
        alias = this.#parseIdentifier();
      } else if (this.#current.type === "identifier" as string) {
        alias = this.#parseIdentifier();
      }
      return { name: alias ?? "sub", subquery, alias };
    }

    const name = this.#parseIdentifier();
    const alias = this.#match("as") || this.#current.type === "identifier" ? this.#parseIdentifier() : undefined;
    return { name, alias };
  }

  #parseJoins(): JoinNode[] {
    const joins: JoinNode[] = [];
    const joinKeywords = ["inner", "left", "right", "full", "cross", "natural", "join"];
    while (joinKeywords.includes(this.#current.value)) {
      let natural = false;
      if (this.#match("natural")) natural = true;

      let type: JoinNode["type"] = "inner";
      if (this.#match("left")) type = "left";
      else if (this.#match("right")) type = "right";
      else if (this.#match("full")) type = "inner"; // FULL → inner approximation
      else if (this.#match("cross")) type = "inner"; // CROSS → inner approximation

      if (natural) {
        this.#expect("join");
        const table = this.#parseIdentifier();
        const alias = this.#match("as") || this.#current.type === "identifier" ? this.#parseIdentifier() : undefined;
        // NATURAL JOIN: auto-match same-named columns
        joins.push({ type, table: { name: table, alias }, on: { type: "and", conditions: [] } });
        continue;
      }

      if (this.#current.value === "join") this.#advance();
      else this.#expect("join");

      const table = this.#parseIdentifier();
      const alias = this.#match("as") || this.#current.type === "identifier" ? this.#parseIdentifier() : undefined;

      if (this.#match("on")) {
        const on = this.#parseWhere();
        joins.push({ type, table: { name: table, alias }, on });
      } else {
        // CROSS JOIN — no ON clause
        joins.push({ type, table: { name: table, alias }, on: { type: "and", conditions: [] } });
      }
    }
    return joins;
  }

  #parseWhere(): Condition {
    return this.#parseOr();
  }

  #parseOr(): Condition {
    let left = this.#parseAnd();
    while (this.#match("or")) {
      const right = this.#parseAnd();
      left = { type: "or", conditions: [left, right] };
    }
    return left;
  }

  #parseAnd(): Condition {
    let left = this.#parseCondition();
    while (this.#match("and")) {
      const right = this.#parseCondition();
      left = { type: "and", conditions: [left, right] };
    }
    return left;
  }

  #parseCondition(): Condition {
    if (this.#match("not")) {
      return { type: "not", condition: this.#parseCondition() };
    }
    if (this.#match("lparen")) {
      const cond = this.#parseOr();
      this.#expect(")");
      return cond;
    }

    // EXISTS / NOT EXISTS: subquery (check before NOT token consumption)
    if (this.#current.value === "exists") {
      this.#advance();
      this.#expect("(");
      const subquery = this.#parseSelect();
      this.#expect(")");
      return { type: "exists", subquery } as Condition;
    }
    if (this.#current.value === "not" && this.#lex.peek().value === "exists") {
      this.#advance(); // consume "not"
      this.#advance(); // consume "exists"
      this.#expect("(");
      const subquery = this.#parseSelect();
      this.#expect(")");
      return { type: "notExists", subquery } as Condition;
    }

    const left = this.#parseColumnExpr();

    if (this.#match("is")) {
      if (this.#match("not")) { this.#expect("null"); return { type: "isNotNull", left }; }
      this.#expect("null");
      return { type: "isNull", left };
    }

    if (this.#match("like")) {
      const pattern = this.#parseLiteral();
      return { type: "like", left, pattern };
    }

    let negateIn = false; // for NOT IN tracking
    if (this.#match("not")) {
      if (this.#current.value === "in") {
        // NOT IN — consume "in" and fall through to IN handling
        this.#advance();
        negateIn = true;
      } else {
        // NOT LIKE
        this.#expect("like");
        const pattern = this.#parseLiteral();
        return { type: "notLike", left, pattern };
      }
    }

    const negate = negateIn;
    if (!negateIn && this.#match("in")) {
      // negate stays false (positive IN)
    }

    if (negate || this.#current.value === "(") {
      // We parsed "in" or "not in" — now check for subquery vs literal list
      this.#expect("(");

      // Peek: if the token after ( is SELECT → subquery, else → literal list
      if (this.#current.value === "select") {
        const subquery = this.#parseSelect();
        this.#expect(")");
        return negate
          ? { type: "notInSubquery", left, subquery } as Condition
          : { type: "inSubquery", left, subquery } as Condition;
      }

      const values: ValueExpr[] = [];
      do {
        if (this.#current.value === ",") this.#advance();
        values.push(this.#parseLiteral());
      } while (this.#current.value === ",");
      this.#expect(")");
      return negate ? { type: "notIn", left, values } : { type: "in", left, values };
    }

    // If we got here, it's a regular operator comparison
    if (this.#match("between")) {
      const min = this.#parseLiteral();
      this.#expect("and");
      const max = this.#parseLiteral();
      return { type: "between", left, min, max };
    }

    // CASE boundaries: WHEN condition without explicit operator → treat as eq true
    if (["then", "else", "end"].includes(this.#current.value)) {
      return { type: "eq", left, right: true as ValueExpr };
    }

    const op = this.#parseOperator();
    const opMap: Record<string, string> = {
      "=": "eq", "<>": "neq", "!=": "neq", ">": "gt", "<": "lt", ">=": "gte", "<=": "lte",
    };
    const condType = opMap[op] ?? "eq";

    // Scalar subquery: col = (SELECT ...)
    if (this.#current.value === "(" && this.#lex.peek().value === "select") {
      this.#advance();
      const subquery = this.#parseSelect();
      this.#expect(")");
      return { type: "scalarSubquery", left, op: condType as "eq" | "neq" | "gt" | "lt" | "gte" | "lte", subquery } as unknown as Condition;
    }

    // Try to parse the right side as a column expression;
    // if it's a literal, use it directly
    const right = this.#parseColumnExpr();
    if (right.type === "literal") {
      return { type: condType, left, right: right.value } as Condition;
    }
    // Column-to-column comparison → use expr condition
    return { type: "expr", left, op: condType, right } as unknown as Condition;
  }

  #parseGroupBy(): ColumnExpr[] {
    this.#expect("by");
    const cols: ColumnExpr[] = [];
    do {
      if (this.#current.type === "comma") this.#advance();
      cols.push(this.#parseColumnExpr());
    } while (this.#current.type === "comma");
    return cols;
  }

  #parseOrderBy(): OrderByNode[] {
    this.#expect("by");
    const items: OrderByNode[] = [];
    do {
      if (this.#current.type === "comma") this.#advance();
      const col = this.#parseColumnExpr();
      const dir = this.#match("desc") ? "desc" : (this.#match("asc"), "asc");
      items.push({ column: col, direction: dir });
    } while (this.#current.type === "comma");
    return items;
  }

  #parseLimit(): number {
    const n = Number(this.#current.value); this.#advance();
    return n;
  }

  #parseOffset(): number {
    return this.#parseLimit();
  }

  #parseLiteral(): ValueExpr {
    if (this.#current.type === "param") {
      const val = this.#current.value;
      this.#advance();
      if (val === "?") return { type: "param", index: this.#paramIndex++ };
      const idx = /^\d+$/.test(val.slice(1)) ? parseInt(val.slice(1), 10) - 1 : this.#paramIndex++;
      return { type: "param", index: idx };
    }
    if (this.#current.type === "string") { const v = this.#current.value; this.#advance(); return v; }
    if (this.#current.type === "number") { const v = Number(this.#current.value); this.#advance(); return v; }
    if (this.#match("true")) return true;
    if (this.#match("false")) return false;
    if (this.#match("null")) return null;
    return this.#parseIdentifier();
  }
  #parseLiteralList(): ValueExpr[] {
    const items: ValueExpr[] = [];
    do {
      if (this.#current.value === ",") this.#advance();
      items.push(this.#parseLiteral());
    } while (this.#current.value === ",");
    return items;
  }
  #parseColumnList(): string[] {
    const cols: string[] = [];
    do { if (this.#current.type === "comma") this.#advance(); cols.push(this.#parseIdentifier()); }
    while (this.#current.type === "comma");
    return cols;
  }

  #parseIdentifier(): string {
    const t = this.#current;
    if (t.type === "identifier" || t.type === "keyword" || t.type === "string") { this.#advance(); return t.value; }
    throw new ParseError(`Expected identifier, got ${t.type} "${t.value}"`, t.pos);
  }

  #parseOperator(): string {
    const t = this.#current;
    if (t.type === "operator") { this.#advance(); return t.value; }
    throw new ParseError(`Expected operator, got ${t.type} "${t.value}"`, t.pos);
  }

  #match(value: string): boolean {
    if (this.#current.value !== value) return false;
    this.#advance();
    return true;
  }

  #expect(value: string): void {
    if (this.#match(value)) return;
    const actual = `${this.#current.type} "${this.#current.value}"`;
    throw new ParseError(`Expected "${value}", got ${actual}`, this.#current.pos);
  }

  #advance(): void { this.#current = this.#lex.next(); }

  #isFunction(): boolean {
    if (this.#current.type !== "identifier" && this.#current.type !== "keyword") return false;
    const peeked = this.#lex.peek();
    return peeked.type === "lparen";
  }
}
