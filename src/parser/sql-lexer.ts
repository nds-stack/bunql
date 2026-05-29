/**
 * @module sql-lexer
 * @description SQL tokenizer — converts SQL string to token stream for the parser.
 */

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export type TokenType =
  | "keyword" | "identifier" | "number" | "string" | "operator" | "param"
  | "comma" | "dot" | "semicolon" | "lparen" | "rparen" | "eof";

const KEYWORDS = new Set([
  "select", "from", "where", "insert", "into", "values", "update", "set", "delete",
  "create", "table", "drop", "join", "inner", "left", "right", "full", "cross", "natural", "on", "as",
  "group", "by", "having", "order", "asc", "desc", "limit", "offset", "distinct",
  "and", "or", "not", "in", "like", "between", "is", "null", "true", "false",
  "count", "sum", "avg", "min", "max",
  "begin", "commit", "rollback", "returning",
  "with", "union", "intersect", "except", "exists", "all",
  "primary", "key", "default", "unique", "if",
  "integer", "text", "varchar", "boolean", "real", "blob",
]);

const OPERATORS = new Set(["+", "-", "*", "/", "%", "=", "<>", "!=", "<", ">", "<=", ">=", "||"]);

export class Lexer {
  #input: string;
  #pos = 0;

  constructor(input: string) { this.#input = input; }

  next(): Token {
    this.#skipWS();
    if (this.#pos >= this.#input.length) return { type: "eof", value: "", pos: this.#pos };

    const ch = this.#ch();

    if (ch === "'" || ch === '"') return this.#readStr(ch);
    if (ch === ",") { this.#pos++; return { type: "comma", value: ",", pos: this.#pos - 1 }; }
    if (ch === ".") { this.#pos++; return { type: "dot", value: ".", pos: this.#pos - 1 }; }
    if (ch === ";") { this.#pos++; return { type: "semicolon", value: ";", pos: this.#pos - 1 }; }
    if (ch === "(") { this.#pos++; return { type: "lparen", value: "(", pos: this.#pos - 1 }; }
    if (ch === ")") { this.#pos++; return { type: "rparen", value: ")", pos: this.#pos - 1 }; }
    if (/[+\-*/%=<>!|]/.test(ch)) return this.#readOp();
    if (ch === "?") { this.#pos++; return { type: "param", value: "?", pos: this.#pos - 1 }; }
    if (/\d/.test(ch)) return this.#readNum();
    if (ch === "$" || ch === "@" || ch === ":") return this.#readParam();
    if (/[a-zA-Z_]/.test(ch)) return this.#readWord();

    this.#pos++;
    return { type: "operator", value: ch, pos: this.#pos - 1 };
  }

  peek(): Token {
    const saved = this.#pos;
    const token = this.next();
    this.#pos = saved;
    return token;
  }

  all(): Token[] {
    const tokens: Token[] = [];
    let t = this.next();
    while (t.type !== "eof") { tokens.push(t); t = this.next(); }
    return tokens;
  }

  #ch(): string { return this.#input[this.#pos] ?? ""; }
  #adv(): void { this.#pos++; }

  #readStr(quote: string): Token {
    const start = this.#pos; this.#adv();
    let value = "";
    while (this.#pos < this.#input.length && this.#ch() !== quote) {
      if (this.#ch() === quote && this.#input[this.#pos + 1] === quote) {
        value += quote; this.#pos += 2;
      } else {
        value += this.#ch(); this.#adv();
      }
    }
    this.#adv(); // skip closing quote
    return { type: "string", value, pos: start };
  }

  #readNum(): Token {
    const start = this.#pos;
    while (this.#pos < this.#input.length && /[\d.eE]/.test(this.#ch())) this.#adv();
    return { type: "number", value: this.#input.slice(start, this.#pos), pos: start };
  }

  #readWord(): Token {
    const start = this.#pos;
    while (this.#pos < this.#input.length && /[a-zA-Z0-9_]/.test(this.#ch())) this.#adv();
    const word = this.#input.slice(start, this.#pos);
    return KEYWORDS.has(word.toLowerCase())
      ? { type: "keyword", value: word.toLowerCase(), pos: start }
      : { type: "identifier", value: word, pos: start };
  }

  #readOp(): Token {
    const start = this.#pos;
    const one = this.#ch(); this.#adv();
    if (this.#pos < this.#input.length) {
      const two = one + this.#ch();
      if (OPERATORS.has(two)) { this.#adv(); return { type: "operator", value: two, pos: start }; }
    }
    if (one === "-" && this.#ch() === "-") { this.#skipLine(); return this.next(); }
    return { type: "operator", value: one, pos: start };
  }

  #readParam(): Token {
    const start = this.#pos; this.#adv();
    while (this.#pos < this.#input.length && /[a-zA-Z0-9_]/.test(this.#ch())) this.#adv();
    return { type: "param", value: this.#input.slice(start, this.#pos), pos: start };
  }

  #skipWS(): void {
    while (this.#pos < this.#input.length && /\s/.test(this.#ch())) this.#adv();
  }

  #skipLine(): void {
    while (this.#pos < this.#input.length && this.#ch() !== "\n") this.#adv();
  }
}
