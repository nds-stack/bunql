import type { BunQL } from "../bunql.ts";
import type { ServerOptions } from "../types/result.ts";
import { createHandler } from "./http-handler.ts";

export class BunQLServer {
  #bunql: BunQL;
  #options: ServerOptions;
  #server: ReturnType<typeof Bun.serve> | null = null;

  constructor(bunql: BunQL, options: ServerOptions = {}) {
    this.#bunql = bunql;
    this.#options = {
      port: options.port ?? 3456,
      host: options.host ?? "0.0.0.0",
      ...options,
    };
  }

  start(): void {
    if (this.#server) return;

    const handler = createHandler(this.#bunql, this.#options);

    this.#server = Bun.serve({
      port: this.#options.port!,
      hostname: this.#options.host!,
      fetch: async (req) => {
        if (this.#options.cors) {
          if (req.method === "OPTIONS") {
            return new Response(null, {
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, x-api-key",
              },
            });
          }
          const res = await handler(req);
          res.headers.set("Access-Control-Allow-Origin", "*");
          return res;
        }
        return handler(req);
      },
    });

    console.log(`[BunQLServer] Listening on http://${this.#options.host}:${this.#options.port}`);
  }

  stop(): void {
    this.#server?.stop();
    this.#server = null;
    console.log("[BunQLServer] Stopped");
  }

  get url(): string | null {
    if (!this.#server) return null;
    return `http://${this.#options.host}:${this.#options.port}`;
  }
}
