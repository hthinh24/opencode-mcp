import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { OpenCodeClient } from '../dist/opencode/client.js';

let server;
let baseUrl;
let requests;
let routeMode;

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (routeMode === 'v2-html-fallback') {
      if (req.url === '/global/health') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><title>OpenCode</title></html>');
        return;
      }
      if (req.url === '/api/info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '2.0.26' }));
        return;
      }
      if (req.url === '/api/agent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 'v2-agent' }]));
        return;
      }
    }

    if (routeMode === 'legacy') {
      if (req.url === '/api/info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '2.0.26' }));
        return;
      }
      if (req.url === '/api/agent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 'orchestrator' }]));
        return;
      }
      if (req.url === '/api/session/s1/prompt') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ delivery: 'steer' }));
        return;
      }
      if (req.url === '/api/session/s1/interrupt?resume=false') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ interrupted: true }));
        return;
      }
    } else {
      if (req.url === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version: 'test' }));
        return;
      }
      if (req.url === '/agent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 'default' }]));
        return;
      }
      if (req.url === '/session' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'created-session' }));
        return;
      }
      if (req.url === '/session/s1/prompt_async') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/session/s1/abort') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(true));
        return;
      }
      if (req.url === '/session/s1/children') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 'child-1' }]));
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('uses the current OpenCode API routes and Basic Auth', async () => {
  routeMode = 'current';
  requests = [];
  const client = new OpenCodeClient({
    baseUrl,
    username: 'opencode',
    password: 'secret',
    apiPrefix: 'auto',
  });

  const agents = await client.listAgents();
  assert.deepEqual(agents, [{ id: 'default' }]);
  const agentRequest = requests.find((request) => request.url === '/agent');
  assert.equal(agentRequest.headers.authorization, `Basic ${Buffer.from('opencode:secret').toString('base64')}`);
});

test('prefers the V2 JSON API when the legacy health path serves frontend HTML', async () => {
  routeMode = 'v2-html-fallback';
  requests = [];
  const client = new OpenCodeClient({ baseUrl, apiPrefix: 'auto' });
  assert.deepEqual(await client.listAgents(), [{ id: 'v2-agent' }]);
  assert.ok(requests.some((request) => request.url === '/api/info'));
  assert.ok(requests.some((request) => request.url === '/api/agent'));
});

test('creates sessions using only supported session fields', async () => {
  routeMode = 'current';
  requests = [];
  const client = new OpenCodeClient({ baseUrl, apiPrefix: 'none' });
  const session = await client.createSession({ title: 'MCP test', parentId: 'parent-1' });
  assert.deepEqual(session, { id: 'created-session' });
  assert.deepEqual(requests.find((request) => request.url === '/session').body, {
    title: 'MCP test',
    parentID: 'parent-1',
  });
});

test('sends prompts asynchronously on the current API', async () => {
  routeMode = 'current';
  requests = [];
  const client = new OpenCodeClient({ baseUrl, apiPrefix: 'none' });
  const result = await client.sendMessage({ sessionId: 's1', text: 'Review this change', agent: 'reviewer' });
  assert.deepEqual(result, { accepted: true, delivery: 'async' });
  const request = requests.find((entry) => entry.url === '/session/s1/prompt_async');
  assert.deepEqual(request.body, {
    parts: [{ type: 'text', text: 'Review this change' }],
    agent: 'reviewer',
  });
});

test('detects and uses the legacy /api route layout and prompt endpoint', async () => {
  routeMode = 'legacy';
  requests = [];
  const client = new OpenCodeClient({ baseUrl, apiPrefix: 'auto' });
  const agents = await client.listAgents();
  assert.deepEqual(agents, [{ id: 'orchestrator' }]);
  const result = await client.sendMessage({ sessionId: 's1', text: 'Continue' });
  assert.deepEqual(result, {
    accepted: true,
    delivery: 'legacy',
    response: { delivery: 'steer' },
  });
  const promptRequest = requests.find((entry) => entry.url === '/api/session/s1/prompt');
  assert.deepEqual(promptRequest.body, { text: 'Continue' });
});

test('uses the legacy interrupt endpoint when abort is unavailable', async () => {
  routeMode = 'legacy';
  requests = [];
  const client = new OpenCodeClient({ baseUrl, apiPrefix: '/api' });
  const result = await client.abortSession('s1');
  assert.deepEqual(result, { interrupted: true });
  assert.ok(requests.some((entry) => entry.url === '/api/session/s1/interrupt?resume=false'));
});

test('lists child sessions on the current API', async () => {
  routeMode = 'current';
  requests = [];
  const client = new OpenCodeClient({ baseUrl, apiPrefix: 'none' });
  assert.deepEqual(await client.listChildSessions('s1'), [{ id: 'child-1' }]);
});
