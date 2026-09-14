/**
 * The slice of MCP this server speaks: JSON-RPC 2.0 over stdio, four
 * methods.
 *
 * Written by hand rather than pulled from `@modelcontextprotocol/sdk`,
 * which installs 91 packages / 26 MB — including express, hono, cors and
 * jose — for a local server that never opens a socket. This project has 36
 * packages in total and has been deliberate about that. The risk that
 * trade buys is protocol drift, and it is paid for by verifying against the
 * real client (`claude mcp add`) rather than only against our own test
 * double.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** Absent on a notification, which must not be answered. */
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  /** `null` when the id could not be determined — JSON-RPC requires it, and 0 is a real id the official SDK uses. */
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Standard JSON-RPC codes; MCP adds no others for this method set. */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/**
 * Revisions this server can honestly claim.
 *
 * Echoing whatever the client asked for looked friendlier but asserted
 * compatibility that was never checked — including `2025-03-26`, which
 * *requires* receiving JSON-RPC batches. This server does not implement
 * batches, so echoing that version produced a successful handshake and
 * then a session that hung on the first batched message. It would equally
 * have echoed `banana`.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2024-11-05']);

export function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

export function failure(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
