import type Database from 'better-sqlite3';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';
import {
  failure,
  JSON_RPC,
  result,
  FALLBACK_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.js';
import { TOOLS, TOOLS_BY_NAME } from './tools.js';

const SERVER_INFO = { name: 'career-mate', version: '0.1.0' };

/**
 * Turns one JSON-RPC message into its response, or `undefined` for a
 * notification (which must never be answered — a reply to a notification
 * is a protocol violation, and some clients disconnect over it).
 *
 * Separated from the stdio transport so the protocol can be tested without
 * spawning a process, and so the transport stays small enough to read.
 */
export function handleMessage(db: Database.Database, message: JsonRpcRequest): JsonRpcResponse | undefined {
  if (Array.isArray(message)) {
    // A batch parses as valid JSON and would otherwise destructure to
    // `{id: undefined}` — read as a notification and silently dropped,
    // leaving the client waiting forever. Batching was removed from MCP in
    // 2025-06-18 and this server never implemented it; say so.
    return failure(null, JSON_RPC.invalidRequest, 'JSON-RPC batches are not supported; send one message per line');
  }

  const { id, method } = message;
  const isNotification = id === undefined;

  if (isNotification) {
    // `notifications/initialized` and friends: acknowledged by doing
    // nothing, which is what the protocol asks for.
    return undefined;
  }

  switch (method) {
    case 'initialize':
      return result(id, {
        // Echo the client's version only when we can actually honour it;
        // otherwise answer with ours and let the client decide. Claiming a
        // revision blind once meant claiming batch support we do not have.
        protocolVersion:
          typeof message.params?.protocolVersion === 'string' &&
          SUPPORTED_PROTOCOL_VERSIONS.has(message.params.protocolVersion)
            ? message.params.protocolVersion
            : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      });

    case 'tools/call':
      return callTool(db, id, message.params ?? {});

    default:
      return failure(id, JSON_RPC.methodNotFound, `Unknown method: ${method}`);
  }
}

function callTool(db: Database.Database, id: string | number, params: Record<string, unknown>): JsonRpcResponse {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    // Nothing outside the registry can be dispatched: this is the actual
    // constraint on what an agent may do, not the schemas.
    return failure(id, JSON_RPC.invalidParams, `Unknown tool: ${name}`);
  }

  const startedAt = Date.now();
  try {
    const value = tool.handler(db, args);
    record(db, tool.name, 'succeeded', startedAt);
    return result(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  } catch (error) {
    record(db, tool.name, 'failed', startedAt, error);
    // Returned as a tool result, not a JSON-RPC error: a failed *tool* is
    // something the model should see and can recover from ("no such
    // opportunity — list them first"), whereas a JSON-RPC error is a
    // transport-level fault the model never sees.
    return result(id, {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    });
  }
}

/** Every tool call lands in the same log as a CLI action, so the two surfaces can be compared on equal terms. */
function record(db: Database.Database, action: string, outcome: 'succeeded' | 'failed', startedAt: number, error?: unknown): void {
  tryRecordOperationalLog(db, {
    severity: outcome === 'failed' ? 'error' : 'info',
    outcome,
    component: 'mcp',
    action,
    durationMs: Date.now() - startedAt,
    ...(error === undefined ? {} : { error }),
  });
}
