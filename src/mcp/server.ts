import type { Readable, Writable } from 'node:stream';
import type Database from 'better-sqlite3';
import { failure, JSON_RPC, type JsonRpcRequest } from './protocol.js';
import { handleMessage } from './dispatch.js';

/**
 * MCP over stdio: newline-delimited JSON-RPC on stdin, responses on stdout.
 *
 * Nothing else may be written to stdout — a stray `console.log` anywhere in
 * the process corrupts the stream and the client disconnects. Diagnostics
 * go to stderr, which the host shows as server logs.
 */
export function serveStdio(db: Database.Database, input: Readable, output: Writable): void {
  let buffer = '';

  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk;

    // A message can arrive split across chunks, and several can arrive in
    // one — so the newline, not the chunk, is the frame boundary.
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) respond(db, line, output);
      newline = buffer.indexOf('\n');
    }
  });
}

function respond(db: Database.Database, line: string, output: Writable): void {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(line) as JsonRpcRequest;
  } catch {
    // `null`, not 0: JSON-RPC requires null when the id cannot be
    // determined, and 0 is a perfectly real id — the official MCP SDK
    // numbers its requests from 0, so replying with 0 here would resolve
    // the client's in-flight `initialize` with a spurious parse error.
    write(output, failure(null, JSON_RPC.parseError, 'Invalid JSON'));
    return;
  }

  try {
    const response = handleMessage(db, message);
    if (response) write(output, response);
  } catch (error) {
    // A handler that throws unexpectedly is a bug in us, not a reason to
    // drop the connection — report it against this id and keep serving.
    if (message.id !== undefined) {
      write(output, failure(message.id, JSON_RPC.internalError, error instanceof Error ? error.message : String(error)));
    }
    process.stderr.write(`[cm-mcp] handler error: ${error instanceof Error ? error.stack : String(error)}\n`);
  }
}

function write(output: Writable, payload: unknown): void {
  output.write(`${JSON.stringify(payload)}\n`);
}
