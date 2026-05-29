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

    switch (kw) {
      case "select": return this.#parseSelect();
      case "insert": return this.#parseInsert();
      case "update": return this.#parseUpdate();
      case "delete": return this.#parseDelete();
      case "create": return this.#parseCreateTable();
      default:
        throw new ParseError(`Unexpected keyword: ${kw}`, this.#current.pos);
    }
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

    return { type: "insert", table, columns, values, returning };
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
    return { type: "update", table, set, where };
  }

  #parseDelete(): ASTNode {
    this.#expect("delete");
    this.#expect("from");
    const table = this.#parseIdentifier();
    const where = this.#match("where") ? this.#parseWhere() : undefined;
    return { type: "delete", table, where };
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
    const cols: ColumnExpr[] = [];
    do {
      if (this.#current.value === ",") this.#advance();
      cols.push(this.#parseColumnExpr());
    } while (this.#current.value === ",");
    return cols;
  }

  #parseColumnExpr(): ColumnExpr {
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
      const args = this.#parseColumns();
      this.#expect(")");
      expr = { type: "function", func, args };
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
      this.#expect("rparen");
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
    while (this.#current.value === "inner" || this.#current.value === "left" || this.#current.value === "right" || this.#current.value === "join") {
      let type: JoinNode["type"] = "inner";
      if (this.#match("left")) type = "left";
      else if (this.#match("right")) type = "right";
      if (this.#current.value === "join") this.#advance();
      else this.#expect("join");

      const table = this.#parseIdentifier();
      const alias = this.#match("as") || this.#current.type === "identifier" ? this.#parseIdentifier() : undefined;
      this.#expect("on");
      const on = this.#parseWhere();
      joins.push({ type, table: { name: table, alias }, on });
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

    if (this.#match("not")) {
      this.#expect("like");
      const pattern = this.#parseLiteral();
      return { type: "notLike", left, pattern };
    }

    let negate = false;
    if (this.#match("in")) {
      // negate stays false
    } else if (this.#match("not")) {
      this.#expect("in");
      negate = true;
    } else {
      // fall through to operator parsing
    }

    if (negate || this.#current.value === "(") {
      // We parsed "in" or "not in" — now expect values in parens
      this.#expect("(");
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

    const op = this.#parseOperator();
    const right = this.#parseLiteral();
    const opMap: Record<string, Condition["type"]> = {
      "=": "eq", "<>": "neq", "!=": "neq", ">": "gt", "<": "lt", ">=": "gte", "<=": "lte",
    };
    const type = opMap[op] ?? "eq";
    return { type: type as Condition["type"], left, right } as Condition;
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
