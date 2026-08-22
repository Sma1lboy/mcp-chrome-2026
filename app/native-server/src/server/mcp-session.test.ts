import { describe, expect, test, afterAll, beforeAll } from '@jest/globals';
import http from 'node:http';
import Server from './index';

// Regression for the "HTTP connection dropped after ~600s" disconnects: a
// session whose only activity is an open GET SSE stream must not be reaped,
// and an unknown session must get 404 (so clients re-initialize) not 400.
describe('MCP session lifetime', () => {
  const fastify = Server.getInstance();
  const sessions = () => (Server as any).transportsMap as Map<string, any>;
  let port: number;

  beforeAll(async () => {
    await fastify.ready();
    await new Promise<void>((r) => fastify.server.listen(0, '127.0.0.1', r));
    port = (fastify.server.address() as any).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => fastify.server.close(() => r()));
  });

  const initialize = async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    return res.headers['mcp-session-id'] as string;
  };
  const backdate = (id: string) => {
    sessions().get(id).lastActivityAt = new Date(Date.now() - 60 * 60_000);
  };
  const reap = () => (Server as any).cleanupStaleSessions() as Promise<void>;

  test('unknown session id → 404', async () => {
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const res = await fastify.inject({
        method,
        url: '/mcp',
        headers: { 'mcp-session-id': 'nope', accept: 'application/json, text/event-stream' },
        payload: method === 'POST' ? { jsonrpc: '2.0', id: 2, method: 'ping' } : undefined,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  test('idle session without a stream is reaped', async () => {
    const id = await initialize();
    backdate(id);
    await reap();
    expect(sessions().has(id)).toBe(false);
  });

  test('session with an open SSE stream survives the reaper, then expires after it closes', async () => {
    const id = await initialize();
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      headers: { 'mcp-session-id': id, accept: 'text/event-stream' },
    });
    const res = await new Promise<http.IncomingMessage>((r) => req.on('response', r));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    let ended = false;
    res.on('end', () => (ended = true)).resume();
    await new Promise((r) => setTimeout(r, 100));
    expect(ended).toBe(false); // the stream stays open, it is not closed on arrival

    backdate(id);
    await reap();
    expect(sessions().has(id)).toBe(true);

    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    backdate(id);
    await reap();
    expect(sessions().has(id)).toBe(false);
  });
});
