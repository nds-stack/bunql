import type { BunQL } from "../bunql.ts";
import type { ServerOptions } from "../types/result.ts";
import type { SQLQueryBindings } from "bun:sqlite";

interface RequestPayload {
  sql?: string;
  params?: SQLQueryBindings[];
  operations?: Array<{ sql: string; params?: SQLQueryBindings[] }>;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function createHandler(bunql: BunQL, options: ServerOptions): (req: Request) => Promise<Response> {
  const apiKeys = options.auth ? [options.auth.apiKey] : [];

  function checkAuth(req: Request): boolean {
    if (apiKeys.length === 0) return true;
    const key = req.headers.get("x-api-key");
    return key !== null && apiKeys.includes(key);
  }

  async function handleQuery(body: RequestPayload): Promise<Response> {
    if (!body.sql) return errorResponse("Missing 'sql' field");
    try {
      const result = bunql.query(body.sql, body.params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 500);
    }
  }

  async function handleRun(body: RequestPayload): Promise<Response> {
    if (!body.sql) return errorResponse("Missing 'sql' field");
    try {
      const result = await bunql.run(body.sql, body.params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 500);
    }
  }

  async function handleExec(body: RequestPayload): Promise<Response> {
    if (!body.sql) return errorResponse("Missing 'sql' field");
    try {
      await bunql.exec(body.sql);
      return jsonResponse({ ok: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 500);
    }
  }

  async function handleBatch(body: RequestPayload): Promise<Response> {
    if (!body.operations) return errorResponse("Missing 'operations' field");
    try {
      const results = await bunql.batch(body.operations);
      return jsonResponse(results);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 500);
    }
  }

  async function handleTransaction(body: RequestPayload): Promise<Response> {
    if (!body.operations || !Array.isArray(body.operations)) {
      return errorResponse("Missing 'operations' array");
    }
    try {
      const result = await bunql.transaction(async (tx) => {
        const results: unknown[] = [];
        for (const op of body.operations!) {
          if (op.sql?.toLowerCase().startsWith("select")) {
            results.push(tx.query(op.sql, op.params));
          } else {
            results.push(await tx.run(op.sql, op.params));
          }
        }
        return results;
      });
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 500);
    }
  }

  return async (req: Request): Promise<Response> => {
    if (!checkAuth(req)) {
      return errorResponse("Unauthorized", 401);
    }

    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        status: "ok",
        queueSize: bunql.queueSize,
        isProcessing: bunql.isProcessing,
      });
    }

    if (req.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    let body: RequestPayload;
    try {
      body = await req.json() as RequestPayload;
    } catch {
      return errorResponse("Invalid JSON body");
    }

    switch (url.pathname) {
      case "/query":
        return handleQuery(body);
      case "/run":
        return handleRun(body);
      case "/exec":
        return handleExec(body);
      case "/batch":
        return handleBatch(body);
      case "/transaction":
        return handleTransaction(body);
      default:
        return errorResponse("Not found", 404);
    }
  };
}
