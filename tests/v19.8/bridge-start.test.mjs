import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BRIDGE_VERSION } from '../../bridge/bridge-version.mjs';

test('1-2. Bridge starts only with compatible Agent Runtime and keeps GPT Actions schema', { timeout: 30000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clb-v19-8-http-'));
  const cap = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
  const child = spawn(process.execPath, ['bridge/actions-http-server.mjs'], {
    cwd: path.resolve('.'), windowsHide: true,
    env: { ...process.env, CHATGPT_LOCAL_BRIDGE_DATA_DIR: dataDir, CHATGPT_LOCAL_BRIDGE_ACTION_PORT: '0', CHATGPT_LOCAL_BRIDGE_ACTION_CAP: cap },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const readyLine = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`server timeout: ${stderr}`)), 12000);
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        for (const line of buffer.split(/\r?\n/)) {
          try {
            const value = JSON.parse(line);
            if (value.type === 'gpt-actions-http') { clearTimeout(timer); resolve(value); }
          } catch {}
        }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    });
    assert.equal(readyLine.version, BRIDGE_VERSION);
    assert.equal(readyLine.runtimeVersion, BRIDGE_VERSION);
    const base = `http://127.0.0.1:${readyLine.port}`;
    const ready = await fetch(`${base}/readyz`).then((response) => response.json());
    const schema = await fetch(`${base}/setup/${cap}/openapi.json`).then((response) => response.json());
    const status = await fetch(`${base}/gpt/${cap}/pc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status', requestId: 'test-start' }) }).then((response) => response.json());
    assert.deepEqual(ready.runtime, { loaded: true, compatible: true, version: BRIDGE_VERSION });
    assert.equal(schema.openapi, '3.1.0');
    assert.equal(schema.info.version, BRIDGE_VERSION);
    assert.equal(Object.keys(schema.paths).length, 14);
    const runSchema = schema.paths['/workspace/run'].post.requestBody.content['application/json'].schema;
    assert.deepEqual(runSchema.properties.action.enum, ['task', 'npmScript']);
    assert.equal(Object.hasOwn(runSchema.properties, 'command'), false);
    assert.equal(Object.hasOwn(runSchema.properties, 'shell'), false);
    assert.equal(status.status, 'ok');
    assert.equal(status.bridgeDiagnostics.version, BRIDGE_VERSION);
    assert.equal(status.actionModel.validation.goalReached, true);
    const rejectedResponse = await fetch(`${base}/gpt/${cap}/pc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'arbitraryShell' }) });
    const rejected = await rejectedResponse.json();
    assert.equal(rejectedResponse.status, 200);
    assert.equal(rejected.status, 'error');
    assert.match(rejected.message, /unknown|unsupported/i);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve)).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
