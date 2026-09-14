import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('Windows UI helper compiles and answers its real IPC protocol', { timeout: 20000 }, async () => {
  if (process.platform !== 'win32') return;
  const helper = path.resolve('bridge/ui-helper.ps1');
  const child = spawn('powershell.exe', ['-Sta', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const reply = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`helper timeout: ${stderr}`)), 12000);
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          try { const value = JSON.parse(line); if (value.id === 'test-ping') { clearTimeout(timer); resolve(value); } } catch {}
        }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`helper exited ${code}: ${stderr}`)); });
      child.stdin.write(JSON.stringify({ id: 'test-ping', action: 'ping' }) + '\n');
    });
    assert.deepEqual(reply, { id: 'test-ping', ok: true, data: { pong: true } });
  } finally {
    child.stdin.end();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});
