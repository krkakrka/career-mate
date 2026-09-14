import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { listOperationalLogs } from '../../src/db/repositories/operational-logs.js';

const serverEntry = fileURLToPath(new URL('../../bin/cm-mcp.js', import.meta.url));

let dataDir: string;
let server: ChildProcessWithoutNullStreams;
let pending: Map<number, (value: Record<string, unknown>) => void>;
let nextId: number;
let stderr: string;
let stdoutLines: string[];

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-mcp-'));
  pending = new Map();
  nextId = 1;
  stderr = '';
  stdoutLines = [];

  server = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, CM_DATA_DIR: dataDir, CM_DISABLE_DAEMON_AUTOSTART: '1' },
  }) as ChildProcessWithoutNullStreams;

  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let buffer = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      stdoutLines.push(line);
      const message = JSON.parse(line) as { id?: number };
      if (message.id === undefined) continue;
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message as Record<string, unknown>);
      }
    }
  });

  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

afterEach(() => {
  server.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function send(message: unknown): void {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15_000);
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

/** Calls a tool and returns its parsed payload, asserting it did not report an error. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = (await request('tools/call', { name, arguments: args })) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  expect(response.result.isError, response.result.content[0]?.text).toBeFalsy();
  return JSON.parse(response.result.content[0]!.text);
}

describe('the handshake', () => {
  it('agrees on a protocol version and announces the tools capability', async () => {
    const response = (await request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })) as {
      result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } };
    };

    expect(response.result.protocolVersion).toBe('2025-06-18');
    expect(response.result.capabilities).toHaveProperty('tools');
    expect(response.result.serverInfo.name).toBe('career-mate');
  });

  it('answers ping, which is how a host checks the server is alive', async () => {
    expect(await request('ping')).toMatchObject({ result: {} });
  });
});

describe('tools/list', () => {
  it('describes every tool with a usable JSON Schema', async () => {
    const response = (await request('tools/list')) as {
      result: {
        tools: {
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
          annotations: { readOnlyHint: boolean };
        }[];
      };
    };
    const tools = response.result.tools;

    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      // additionalProperties:false is what makes an argument set checkable
      // rather than merely suggestive.
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
    }

    // A host that wants to confirm before mutating needs the split to exist.
    expect(tools.some((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(tools.some((tool) => !tool.annotations.readOnlyHint)).toBe(true);
  });
});

describe('tools/call', () => {
  it('round-trips a mutation and a read', async () => {
    const added = (await callTool('add_opportunity', { url: 'https://acme.example.com/jobs/1' })) as {
      created: boolean;
      opportunity: { id: number };
    };
    expect(added.created).toBe(true);

    const pipeline = (await callTool('get_pipeline')) as { totalActive: number; stages: { status: string }[] };
    expect(pipeline.totalActive).toBe(1);
    expect(pipeline.stages.map((stage) => stage.status)).toContain('interviewing');

    await callTool('set_stage', { opportunity_id: added.opportunity.id, stage: 'applied', note: 'sent it' });
    const detail = (await callTool('get_opportunity', { opportunity_id: added.opportunity.id })) as {
      opportunity: { status: string };
      stageHistory: unknown[];
    };
    expect(detail.opportunity.status).toBe('applied');
    expect(detail.stageHistory.length).toBeGreaterThan(0);
  });

  it('is idempotent on re-adding a tracked URL', async () => {
    await callTool('add_opportunity', { url: 'https://acme.example.com/jobs/1' });
    const again = (await callTool('add_opportunity', { url: 'https://acme.example.com/jobs/1' })) as { created: boolean };
    expect(again.created).toBe(false);
  });

  it('reports a bad argument as a tool error the model can recover from', async () => {
    const response = (await request('tools/call', {
      name: 'get_opportunity',
      arguments: { opportunity_id: 999 },
    })) as { result: { isError: boolean; content: { text: string }[] } };

    // A tool error, not a JSON-RPC error: the model should see this and act
    // on it, whereas a transport fault it never sees.
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toMatch(/No opportunity #999/);
    expect(response.result.content[0]!.text).toMatch(/list_opportunities/);
  });

  it('rejects a tool outside the registry', async () => {
    const response = (await request('tools/call', { name: 'delete_everything', arguments: {} })) as {
      error: { code: number; message: string };
    };

    // The registry is the actual constraint on what an agent can do.
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toMatch(/Unknown tool/);
  });
});

describe('robustness', () => {
  it('survives malformed JSON and keeps serving', async () => {
    server.stdin.write('this is not json\n');

    // The client is still there and its next message may be fine.
    expect(await request('ping')).toMatchObject({ result: {} });
  });

  it('never answers a notification', async () => {
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });
    // A reply to a notification would break the next id correlation.
    expect(await request('ping')).toMatchObject({ result: {} });
  });

  it('writes nothing but protocol to stdout', async () => {
    await callTool('get_pipeline');
    await request('tools/list');

    // Asserted on stdout itself: a stray console.log anywhere in the
    // process corrupts the stream and the host disconnects. (An earlier
    // version of this test checked *stderr* for JSON-RPC, which is the
    // inverse property and would not have caught it.)
    expect(stdoutLines.length).toBeGreaterThan(2);
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line), line.slice(0, 80)).not.toThrow();
      expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0');
    }
  });

  it('rejects a JSON-RPC batch instead of silently dropping it', async () => {
    // A batch parses as valid JSON but destructures to {id: undefined} —
    // read as a notification and dropped, leaving the client waiting
    // forever. Batching was removed from MCP in 2025-06-18.
    const seen = stdoutLines.length;
    server.stdin.write(`${JSON.stringify([{ jsonrpc: '2.0', id: 99, method: 'ping' }])}\n`);
    await request('ping');

    const batchReply = stdoutLines.slice(seen).map((line) => JSON.parse(line) as { error?: { message: string } });
    expect(batchReply.some((msg) => msg.error?.message.includes('batches are not supported'))).toBe(true);
  });

  it('uses a null id for a parse error, since 0 is a real request id', async () => {
    const seen = stdoutLines.length;
    server.stdin.write('{ broken json\n');
    await request('ping');

    // The official MCP SDK numbers requests from 0, so replying with id 0
    // here would resolve the client's in-flight initialize with a spurious
    // parse error.
    const parseError = stdoutLines
      .slice(seen)
      .map((line) => JSON.parse(line) as { id: unknown; error?: { code: number } })
      .find((msg) => msg.error?.code === -32700);
    expect(parseError?.id).toBeNull();
  });

  it('does not claim a protocol version it cannot honour', async () => {
    // 2025-03-26 *requires* receiving batches, which this server does not
    // implement — echoing it produced a clean handshake and then a hang.
    const response = (await request('initialize', { protocolVersion: '2025-03-26', capabilities: {} })) as {
      result: { protocolVersion: string };
    };
    expect(response.result.protocolVersion).toBe('2025-06-18');

    const nonsense = (await request('initialize', { protocolVersion: 'banana', capabilities: {} })) as {
      result: { protocolVersion: string };
    };
    expect(nonsense.result.protocolVersion).toBe('2025-06-18');
  });
});

describe('measurement', () => {
  it('logs every tool call with a duration, like a CLI action', async () => {
    await callTool('get_pipeline');
    await callTool('add_opportunity', { url: 'https://acme.example.com/jobs/1' });

    const db = openDb(path.join(dataDir, 'career-mate.db'));
    try {
      const logs = listOperationalLogs(db, { component: 'mcp' });
      expect(logs.map((log) => log.action)).toEqual(expect.arrayContaining(['get_pipeline', 'add_opportunity']));
      // Step 26 compares the two surfaces, which only works if the agent
      // path is measured on the same terms as the CLI.
      for (const log of logs.filter((entry) => entry.action !== 'serve')) {
        expect(log.duration_ms, log.action).not.toBeNull();
      }
    } finally {
      db.close();
    }
  });
});
