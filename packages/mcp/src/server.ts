// packages/mcp/src/server.ts
// MCP over HTTP (JSON-RPC 2.0). No SDK dependency — the protocol surface we
// need is three methods, and adding a package would break `gate:no-deps`.
//
// Transport: a single POST endpoint. The host (cloud or self-host server)
// resolves WHO is calling and WHICH sites they may read, then hands us an
// allow-list. This module never does authentication itself — mixing auth into
// the tool layer is how a read-only surface quietly becomes a leak.

import { callTool, TOOLS, ToolError, type ToolContext } from "./tools.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function result(id: RpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Tool output is returned as text content — the MCP content shape. */
function toolContent(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export async function handleRpc(ctx: ToolContext, body: unknown): Promise<unknown> {
  const req = (body ?? {}) as RpcRequest;
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "vitrus", version: "0.1.0" },
        instructions:
          "Vitrus analytics, read-only. Every metric comes back with the SQL that produced it, its " +
          "parameters and the raw rows. When you report a number, cite the evidence id — and if a " +
          "tool says a metric is unavailable (for example retention without identify()), say that " +
          "instead of estimating.",
      });

    case "notifications/initialized":
      // Notification: no id, no response.
      return null;

    case "tools/list":
      return result(id, { tools: TOOLS });

    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return result(id, toolContent(await callTool(ctx, name, args)));
      } catch (e) {
        // Tool-level failures come back as tool results with isError, not as
        // protocol errors: the model should SEE the message and correct itself
        // rather than the whole call blowing up.
        const message = e instanceof ToolError ? e.message : "internal error";
        if (!(e instanceof ToolError)) console.error("[mcp] tool failed:", e);
        return result(id, { ...toolContent({ error: message }), isError: true });
      }
    }

    case "ping":
      return result(id, {});

    default:
      return error(id, -32601, `method not found: ${req.method ?? "(none)"}`);
  }
}

/** Convenience wrapper for a plain HTTP host. */
export async function handleMcpRequest(ctx: ToolContext, req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify(error(null, -32600, "POST required")), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify(error(null, -32700, "parse error")), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const out = await handleRpc(ctx, body);
  // Notifications produce no body.
  if (out === null) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
}

export { TOOLS, callTool, ToolError, type ToolContext };
