import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { OpenCodeProcessManager } from '../dist/opencode/process-manager.js';

function createFakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }
    return true;
  };
  return child;
}

function createDependencies({ healthStatus = 200 } = {}) {
  const calls = [];
  const spawnCalls = [];
  const children = [];

  return {
    calls,
    spawnCalls,
    children,
    dependencies: {
      spawnProcess: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        const child = createFakeChild();
        children.push(child);
        return child;
      },
      allocatePort: async () => 45_678,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/global/health')) {
          return new Response('{}', { status: healthStatus });
        }
        if (url.endsWith('/api/info')) {
          return new Response('{}', { status: 200 });
        }
        if (url.endsWith('/agent')) {
          return new Response('[]', { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    },
  };
}

test('starts OpenCode with a fresh password, an available port, and the configured project directory', async () => {
  const setup = createDependencies();
  const manager = new OpenCodeProcessManager({
    OPENCODE_WORKING_DIRECTORY: process.cwd(),
    OPENCODE_EXECUTABLE: 'opencode-test',
  }, setup.dependencies);

  const client = await manager.start();
  const call = setup.spawnCalls[0];

  assert.equal(call.command, 'opencode-test');
  assert.deepEqual(call.args, ['serve', '--hostname', '127.0.0.1', '--port', '45678']);
  assert.equal(call.options.cwd, process.cwd());
  assert.equal(call.options.env.OPENCODE_PASSWORD, call.options.env.OPENCODE_SERVER_PASSWORD);
  assert.equal(Buffer.from(call.options.env.OPENCODE_PASSWORD, 'base64url').length, 32);
  assert.ok(setup.calls.some(({ url }) => url === 'http://127.0.0.1:45678/global/health'));
  assert.deepEqual(await client.listAgents(), []);

  await manager.stop();
  assert.equal(setup.children[0].exitCode, 0);
});

test('uses the legacy OpenCode health endpoint when the current endpoint is unavailable', async () => {
  const setup = createDependencies({ healthStatus: 404 });
  const manager = new OpenCodeProcessManager({
    OPENCODE_WORKING_DIRECTORY: process.cwd(),
    OPENCODE_API_PREFIX: 'auto',
  }, setup.dependencies);

  await manager.start();
  assert.ok(setup.calls.some(({ url }) => url === 'http://127.0.0.1:45678/api/info'));
  await manager.stop();
});

test('generates a different password for each managed server process', async () => {
  const first = createDependencies();
  const second = createDependencies();
  const firstManager = new OpenCodeProcessManager({ OPENCODE_WORKING_DIRECTORY: process.cwd() }, first.dependencies);
  const secondManager = new OpenCodeProcessManager({ OPENCODE_WORKING_DIRECTORY: process.cwd() }, second.dependencies);

  await firstManager.start();
  await secondManager.start();

  const firstPassword = first.spawnCalls[0].options.env.OPENCODE_PASSWORD;
  const secondPassword = second.spawnCalls[0].options.env.OPENCODE_PASSWORD;
  assert.notEqual(firstPassword, secondPassword);

  await firstManager.stop();
  await secondManager.stop();
});

test('rejects a working directory that does not exist', async () => {
  const setup = createDependencies();
  const manager = new OpenCodeProcessManager({
    OPENCODE_WORKING_DIRECTORY: '/path/that/does/not/exist/opencode-mcp-test',
  }, setup.dependencies);

  await assert.rejects(manager.start(), /working directory does not exist/i);
  assert.equal(setup.spawnCalls.length, 0);
});
