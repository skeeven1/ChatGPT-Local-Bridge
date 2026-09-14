#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { BRIDGE_VERSION } from './bridge-version.mjs';
import { createWindowContext } from './agent-runtime/window-intelligence/index.mjs';
import { resolvePaintCanvas } from './agent-runtime/ui-intelligence/index.mjs';
import { createActionRecord, GUI_DISPATCH_ACTIONS } from './agent-runtime/action-model.mjs';
import { choosePaintBackend, shouldFallback } from './agent-runtime/paint-agent/paint-backend-router.mjs';
import { executePaintBackend } from './agent-runtime/paint-agent/paint-backend-executor.mjs';
import { runPaintActionGate } from './agent-runtime/paint-agent/paint-action-gate.mjs';
import { createPaintBackendHandlers } from './agent-runtime/paint-agent/paint-backend-handlers.mjs';
import { createPaintValidationState } from './agent-runtime/paint-agent/paint-validation-pipeline.mjs';

const VERSION = BRIDGE_VERSION;
const PROTOCOL = 'chatgpt-local-bridge-v15';
const IS_WIN = process.platform === 'win32';
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const POLL_MS = 3000;
const HEARTBEAT_MS = 60000;
const COMMAND_MAX_LIFETIME_MS = 5 * 60 * 1000;
const COMMAND_CLOCK_SKEW_MS = 90 * 1000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage']);
const BLOCKED_EXECUTABLES = new Set([
  'cmd','cmd.exe','powershell','powershell.exe','pwsh','pwsh.exe','wscript','wscript.exe','cscript','cscript.exe','mshta','mshta.exe',
  'rundll32','rundll32.exe','regsvr32','regsvr32.exe','wmic','wmic.exe','reg','reg.exe','sc','sc.exe','schtasks','schtasks.exe',
  'certutil','certutil.exe','bitsadmin','bitsadmin.exe'
]);
const BLOCKED_TARGET_EXTENSIONS = new Set(['.bat','.cmd','.ps1','.psm1','.vbs','.vbe','.js','.jse','.wsf','.wsh','.reg','.msc']);
const SAFE_URL_SCHEMES = new Set(['steam:','uplay:','ubisoftconnect:','com.epicgames.launcher:']);
const MAX_SVG_CHARS = 420000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const truncate = (s, n = MAX_OUTPUT_BYTES) => {
  const b = Buffer.from(String(s ?? ''), 'utf8');
  if (b.length <= n) return b.toString('utf8');
  return b.subarray(b.length - n).toString('utf8') + '\n...[truncated]';
};
const sha256Text = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function localAppData() {
  if (process.env.CHATGPT_LOCAL_BRIDGE_DATA_DIR) return process.env.CHATGPT_LOCAL_BRIDGE_DATA_DIR;
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'ChatGPTLocalBridgeV19');
  return path.join(os.homedir(), '.chatgpt-local-bridge-v19');
}

function ghExecutable(config) {
  if (process.env.CHATGPT_LOCAL_BRIDGE_GH) return process.env.CHATGPT_LOCAL_BRIDGE_GH;
  if (config?.ghPath) return config.ghPath;
  if (IS_WIN) {
    const p = 'C:\\Program Files\\GitHub CLI\\gh.exe';
    if (fs.existsSync(p)) return p;
  }
  return 'gh';
}

function npmExecutable() {
  if (IS_WIN) {
    const p = 'C:\\Program Files\\nodejs\\npm.cmd';
    if (fs.existsSync(p)) return p;
    return 'npm.cmd';
  }
  return 'npm';
}

function gitExecutable() { return IS_WIN ? 'git.exe' : 'git'; }

async function runCaptured(file, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const input = opts.input ?? null;
  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const append = (cur, chunk) => {
      const next = Buffer.concat([cur, Buffer.from(chunk)]);
      return next.length > MAX_OUTPUT_BYTES ? next.subarray(next.length - MAX_OUTPUT_BYTES) : next;
    };
    child.stdout.on('data', (d) => { stdout = append(stdout, d); });
    child.stderr.on('data', (d) => { stderr = append(stderr, d); });
    const finish = (obj) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: obj.code ?? null,
        signal: obj.signal ?? null,
        timedOut: !!obj.timedOut,
        error: obj.error ? String(obj.error.message ?? obj.error) : '',
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8')
      });
    };
    child.on('error', (error) => finish({ code: null, error }));
    child.on('close', (code, signal) => finish({ code, signal }));
    if (input != null) child.stdin.end(input); else child.stdin.end();
    timer = setTimeout(async () => {
      try {
        if (IS_WIN && child.pid) {
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).unref();
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
      finish({ code: null, timedOut: true });
    }, timeoutMs);
  });
}

function runDetached(file, args = [], opts = {}) {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: false,
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  });
  child.unref();
  return child.pid ?? null;
}

function sameOrChild(root, candidate) {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  const rr = IS_WIN ? r.toLowerCase() : r;
  const cc = IS_WIN ? c.toLowerCase() : c;
  return cc === rr || cc.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
}

async function realOrNearestParent(p) {
  let cur = p;
  for (;;) {
    try { return { existing: cur, real: await fsp.realpath(cur) }; }
    catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      cur = parent;
    }
  }
}

async function resolveInside(root, relativePath, { allowRoot = false } = {}) {
  if (typeof relativePath !== 'string') throw new Error('relativePath must be a string');
  if (relativePath.includes('\0')) throw new Error('NUL path rejected');
  if (path.isAbsolute(relativePath)) throw new Error('Absolute paths are not allowed');
  const rootReal = await fsp.realpath(root);
  const candidate = path.resolve(rootReal, relativePath || '.');
  if (!sameOrChild(rootReal, candidate)) throw new Error('Path escapes workspace');
  if (!allowRoot && path.resolve(candidate) === path.resolve(rootReal)) throw new Error('Workspace root is not a file target');
  const nearest = await realOrNearestParent(candidate);
  if (!sameOrChild(rootReal, nearest.real)) throw new Error('Symlink escape rejected');
  try {
    const targetReal = await fsp.realpath(candidate);
    if (!sameOrChild(rootReal, targetReal)) throw new Error('Symlink escape rejected');
  } catch (e) {
    if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
  }
  return candidate;
}

function cleanRoots(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (/^[a-zA-Z0-9._-]{1,64}$/.test(k) && typeof v === 'string' && v.trim()) out[k] = path.resolve(v);
  }
  return out;
}

async function loadOrCreateConfig(dataDir) {
  await fsp.mkdir(dataDir, { recursive: true });
  const cfgPath = path.join(dataDir, 'config.json');
  let config = null;
  try { config = JSON.parse(await fsp.readFile(cfgPath, 'utf8')); } catch {}

  if (!config) {
    const oldCfgCandidates = [
      path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV18', 'config.json'),
      path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV17', 'config.json'),
      path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV16', 'config.json'),
      path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV15', 'config.json'),
      path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV14_3', 'config.json')
    ];
    let old = null;
    for (const oldCfg of oldCfgCandidates) {
      try { old = JSON.parse(await fsp.readFile(oldCfg, 'utf8')); if (old) break; } catch {}
    }
    const roots = cleanRoots(old?.allowedRoots ?? old?.workspaces ?? old?.roots);
    if (!Object.keys(roots).length) roots.doonce = path.join(os.homedir(), 'Desktop', 'doonce');
    config = {
      relayRepo: ((old?.relayRepo && String(old.relayRepo).startsWith('skeeven1/')) ? old.relayRepo : ((old?.commandRepo && String(old.commandRepo).startsWith('skeeven1/')) ? old.commandRepo : 'skeeven1/chatgpt-local-bridge-marketplace')),
      relayBranch: old?.relayBranch ?? old?.commandBranch ?? 'main',
      relayPath: '.chatgpt-local-bridge/command.json',
      telemetryRepo: old?.telemetryRepo ?? 'skeeven1/doonce-control-telemetry-public',
      telemetryBranch: old?.telemetryBranch ?? 'main',
      sessionPath: '.chatgpt-local-bridge/session-v15.json',
      statusPath: '.chatgpt-local-bridge/status-v15.enc',
      allowedRoots: roots,
      pollMs: POLL_MS,
      heartbeatMs: HEARTBEAT_MS
    };
    await fsp.writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
  let migrated = false;
  if (!String(config.relayRepo ?? '').startsWith('skeeven1/')) {
    config.relayRepo = 'skeeven1/chatgpt-local-bridge-marketplace';
    config.relayBranch = 'main';
    config.relayPath = '.chatgpt-local-bridge/command.json';
    migrated = true;
  }
  config.allowedRoots = cleanRoots(config.allowedRoots);
  if (!Object.keys(config.allowedRoots).length) { config.allowedRoots.doonce = path.join(os.homedir(), 'Desktop', 'doonce'); migrated = true; }
  if (migrated) await fsp.writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { config, cfgPath };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

async function acquireSingleInstance(dataDir) {
  const lockPath = path.join(dataDir, 'bridge.lock');
  const token = crypto.randomBytes(12).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await fsp.open(lockPath, 'wx', 0o600);
      await fd.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: nowIso() }) + '\n', 'utf8');
      await fd.close();
      const release = () => {
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (cur?.token === token) fs.unlinkSync(lockPath);
        } catch {}
      };
      process.once('exit', release);
      return { lockPath, release };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let cur = null;
      try { cur = JSON.parse(await fsp.readFile(lockPath, 'utf8')); } catch {}
      if (processExists(Number(cur?.pid))) throw new Error(`ChatGPT Local Bridge is already running (PID ${cur.pid})`);
      try { await fsp.unlink(lockPath); } catch {}
    }
  }
  throw new Error('Unable to acquire single-instance lock');
}

async function loadOrCreateMasterKey(dataDir) {
  const dst = path.join(dataDir, 'bridge.key');
  const candidates = [
    dst,
    path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV15', 'bridge.key'),
    path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV14_3', 'bridge.key'),
    path.join(process.env.LOCALAPPDATA ?? '', 'DoOnceCodexLikeV14', 'bridge.key')
  ];
  for (const p of candidates) {
    if (!p) continue;
    try {
      const text = (await fsp.readFile(p, 'utf8')).trim();
      const b = Buffer.from(text, 'base64');
      if (b.length === 32) {
        if (p !== dst) await fsp.writeFile(dst, text + '\n', { encoding: 'utf8', mode: 0o600 });
        return { key: b, keyPath: dst, importedFrom: p === dst ? null : p };
      }
    } catch {}
  }
  const b = crypto.randomBytes(32);
  await fsp.writeFile(dst, b.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 });
  return { key: b, keyPath: dst, importedFrom: null };
}

function deriveTelemetryKeys(masterKey) {
  const salt = Buffer.from('ChatGPT Local Bridge V15 HKDF salt', 'utf8');
  const encKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('telemetry-aes-256-gcm-v1'), 32));
  const macKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('telemetry-hmac-sha256-v1'), 32));
  return { encKey, macKey };
}

function encryptTelemetry(obj, masterKey) {
  const { encKey, macKey } = deriveTelemetryKeys(masterKey);
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(PROTOCOL, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, nonce);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const gcmTag = cipher.getAuthTag();
  const payload = Buffer.concat([nonce, gcmTag, ciphertext]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.from('v15.', 'utf8')).update(payload).digest();
  return `v15.${payload.toString('base64')}.${mac.toString('base64')}`;
}

function decryptTelemetryForSelfTest(text, masterKey) {
  const m = /^v15\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) throw new Error('Bad envelope');
  const payload = Buffer.from(m[1], 'base64');
  const mac = Buffer.from(m[2], 'base64');
  const { encKey, macKey } = deriveTelemetryKeys(masterKey);
  const expected = crypto.createHmac('sha256', macKey).update(Buffer.from('v15.', 'utf8')).update(payload).digest();
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) throw new Error('Bad HMAC');
  const nonce = payload.subarray(0, 12);
  const gcmTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, nonce);
  decipher.setAAD(Buffer.from(PROTOCOL, 'utf8'));
  decipher.setAuthTag(gcmTag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

function encodeRepoPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

async function ghApi(gh, args, { input = null, timeoutMs = 30000 } = {}) {
  const r = await runCaptured(gh, ['api', ...args], { input, timeoutMs });
  if (r.code !== 0) {
    const e = new Error(`gh api failed (${r.code ?? 'no-code'}): ${truncate(r.stderr || r.stdout, 4000)}`);
    e.result = r;
    throw e;
  }
  return r.stdout;
}

async function githubGetFile(gh, repo, filePath, branch) {
  const ep = `repos/${repo}/contents/${encodeRepoPath(filePath)}?ref=${encodeURIComponent(branch)}`;
  try {
    const out = await ghApi(gh, ['--method', 'GET', ep]);
    const j = JSON.parse(out);
    return { exists: true, sha: j.sha, text: Buffer.from(String(j.content ?? '').replace(/\s/g, ''), 'base64').toString('utf8') };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/404|Not Found/i.test(msg)) return { exists: false, sha: null, text: '' };
    throw e;
  }
}

async function githubPutFile(gh, repo, filePath, branch, text, message) {
  const ep = `repos/${repo}/contents/${encodeRepoPath(filePath)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await githubGetFile(gh, repo, filePath, branch);
    const body = { message, content: Buffer.from(text, 'utf8').toString('base64'), branch };
    if (current.sha) body.sha = current.sha;
    try {
      const out = await ghApi(gh, ['--method', 'PUT', ep, '--input', '-'], { input: JSON.stringify(body), timeoutMs: 45000 });
      return JSON.parse(out);
    } catch (e) {
      if (attempt < 3 && /409|422|does not match|sha/i.test(String(e?.message ?? e))) { await sleep(500 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw new Error('Unable to update GitHub file after retries');
}

function publicSession(state) {
  return {
    protocol: PROTOCOL,
    agentVersion: VERSION,
    online: state.online,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    heartbeatAt: state.heartbeatAt,
    workspaces: Object.keys(state.config.allowedRoots),
    capabilities: [
      'pc-status','list-workspaces','list-dir','search-text','read-file','write-file','copy-file','move-file','mkdir','delete-file',
      'list-processes','list-windows','list-apps','launch-app','stop-process','screen-info','screen-capture','screen-capture-region','sample-canvas-pixel','find-paint-canvas',
      'mouse-move','mouse-click','mouse-drag','mouse-scroll','type-text','key-press','image-target-create','image-target-info','image-target-delete',
      'clipboard-set-target','paint-render-target','paint-correct-target','mouse-render-target','compare-target-region','run-task','npm-script','git-status','git-diff','git-log','git-commit'
    ],
    commandTransport: 'github-authenticated-json',
    telemetryTransport: 'aes-256-gcm+hmac-sha256'
  };
}

function privateStatus(state) {
  return {
    ...publicSession(state),
    userName: os.userInfo().username,
    hostName: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pid: process.pid,
    lastCommand: state.lastCommand ?? null
  };
}

async function publish(state, { forceStatus = false, reason = 'heartbeat' } = {}) {
  state.heartbeatAt = nowIso();
  const pub = JSON.stringify(publicSession(state), null, 2) + '\n';
  await githubPutFile(state.gh, state.config.telemetryRepo, state.config.sessionPath, state.config.telemetryBranch, pub, `chatgpt local bridge session v15 (${reason})`);
  if (forceStatus) {
    const enc = encryptTelemetry(privateStatus(state), state.masterKey) + '\n';
    await githubPutFile(state.gh, state.config.telemetryRepo, state.config.statusPath, state.config.telemetryBranch, enc, `chatgpt local bridge telemetry v15 (${reason})`);
  }
  state.lastPublishedAt = Date.now();
}

function validateCommand(cmd, state) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new Error('Command must be an object');
  if (cmd.protocol !== PROTOCOL) throw new Error('Protocol mismatch');
  if (typeof cmd.id !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(cmd.id)) throw new Error('Invalid command id');
  if (cmd.sessionId !== state.sessionId) throw new Error('Session mismatch');
  if (typeof cmd.action !== 'string' || !cmd.action) throw new Error('Missing action');
  const issued = Date.parse(cmd.issuedAt);
  const expires = Date.parse(cmd.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) throw new Error('Bad command timestamps');
  const now = Date.now();
  if (issued > now + COMMAND_CLOCK_SKEW_MS) throw new Error('Command issued in the future');
  if (expires <= now) throw new Error('Command expired');
  if (expires - issued <= 0 || expires - issued > COMMAND_MAX_LIFETIME_MS) throw new Error('Command lifetime rejected');
  return true;
}

function workspaceRoot(state, cmd) {
  const name = String(cmd.workspace ?? cmd.root ?? '');
  if (!name || !state.config.allowedRoots[name]) throw new Error(`Unknown workspace: ${name || '(missing)'}`);
  return { name, root: state.config.allowedRoots[name] };
}

async function readSmallText(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('Not a file');
  if (st.size > MAX_TEXT_BYTES) throw new Error(`File too large (${st.size} bytes)`);
  return await fsp.readFile(file, 'utf8');
}

async function listDirAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const p = await resolveInside(root, String(cmd.relativePath ?? '.'), { allowRoot: true });
  const entries = await fsp.readdir(p, { withFileTypes: true });
  const data = [];
  for (const e of entries.slice(0, 1000)) {
    let size = null;
    try { if (e.isFile()) size = (await fsp.stat(path.join(p, e.name))).size; } catch {}
    data.push({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other', size });
  }
  return { status: 'ok', message: `${data.length} entries`, data };
}

async function walkFiles(root, maxFiles = 5000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

async function searchTextAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const query = String(cmd.query ?? '');
  if (!query || query.length > 500) throw new Error('Invalid search query');
  const base = await resolveInside(root, String(cmd.relativePath ?? '.'), { allowRoot: true });
  const files = await walkFiles(base, 5000);
  const q = cmd.caseSensitive ? query : query.toLowerCase();
  const results = [];
  for (const file of files) {
    if (results.length >= 200) break;
    let st; try { st = await fsp.stat(file); } catch { continue; }
    if (st.size > 2 * 1024 * 1024) continue;
    let text; try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < 200; i++) {
      const hay = cmd.caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (hay.includes(q)) results.push({ path: path.relative(root, file), line: i + 1, text: truncate(lines[i], 1200) });
    }
  }
  return { status: 'ok', message: `${results.length} matches`, data: results };
}

async function readFileAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const rel = String(cmd.relativePath ?? cmd.path ?? '');
  const p = await resolveInside(root, rel);
  const text = await readSmallText(p);
  return { status: 'ok', message: `Read ${rel}`, data: { relativePath: rel, text, sha256: sha256Text(text), bytes: Buffer.byteLength(text) } };
}

async function writeFileAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const rel = String(cmd.relativePath ?? cmd.path ?? '');
  const text = String(cmd.text ?? cmd.content ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('Text too large');
  const p = await resolveInside(root, rel);
  if (cmd.expectedSha256) {
    let cur = ''; try { cur = await fsp.readFile(p, 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    if (sha256Text(cur) !== String(cmd.expectedSha256)) throw new Error('expectedSha256 mismatch');
  }
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, text, 'utf8');
  return { status: 'ok', message: `Wrote ${rel}`, data: { relativePath: rel, sha256: sha256Text(text), bytes: Buffer.byteLength(text) } };
}

async function mkdirAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const rel = String(cmd.relativePath ?? cmd.path ?? '');
  const p = await resolveInside(root, rel);
  await fsp.mkdir(p, { recursive: true });
  return { status: 'ok', message: `Created directory ${rel}` };
}

async function copyMoveAction(state, cmd, move) {
  const { root } = workspaceRoot(state, cmd);
  const srcRel = String(cmd.source ?? cmd.from ?? '');
  const dstRel = String(cmd.destination ?? cmd.to ?? '');
  const src = await resolveInside(root, srcRel);
  const dst = await resolveInside(root, dstRel);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  if (move) await fsp.rename(src, dst); else await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
  return { status: 'ok', message: `${move ? 'Moved' : 'Copied'} ${srcRel} -> ${dstRel}` };
}


function helperScriptPath() {
  const script = path.resolve(process.argv[1] ?? 'bridge.mjs');
  return path.join(path.dirname(script), 'ui-helper.ps1');
}

function rejectUiPending(state, message) {
  const h = state.uiHelper;
  if (!h) return;
  for (const { reject, timer } of h.pending.values()) {
    clearTimeout(timer);
    reject(new Error(message));
  }
  h.pending.clear();
}

async function startUiHelper(state) {
  if (!IS_WIN) throw new Error('UI control is only available on Windows');
  if (state.uiHelper?.alive) return;
  const helper = helperScriptPath();
  if (!fs.existsSync(helper)) throw new Error(`UI helper missing: ${helper}`);
  const child = spawn('powershell.exe', ['-Sta','-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File', helper], {
    shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe']
  });
  const h = { child, pending: new Map(), nextId: 1, alive: true, stderr: '' };
  state.uiHelper = h;
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  h.readline = rl;
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const pending = h.pending.get(String(msg.id ?? ''));
    if (!pending) return;
    h.pending.delete(String(msg.id));
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.data ?? {});
    else pending.reject(new Error(String(msg.error ?? 'UI helper error')));
  });
  child.stderr.on('data', (d) => { h.stderr = truncate(h.stderr + Buffer.from(d).toString('utf8'), 16000); });
  child.on('error', (e) => {
    h.alive = false;
    rejectUiPending(state, `UI helper process error: ${e.message}`);
  });
  child.on('exit', (code, signal) => {
    h.alive = false;
    rejectUiPending(state, `UI helper exited (${code ?? signal ?? 'unknown'}): ${h.stderr}`);
  });
  await callUiHelperExisting(state, 'ping', {}, 15000);
}

async function callUiHelperExisting(state, action, payload = {}, timeoutMs = 15000) {
  const h = state.uiHelper;
  if (!h?.alive) throw new Error('UI helper is not running');
  const id = `ui-${process.pid}-${h.nextId++}`;
  const req = { id, action, ...payload };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      h.pending.delete(id);
      reject(new Error(`UI helper timeout: ${action}`));
    }, timeoutMs);
    h.pending.set(id, { resolve, reject, timer });
    try { h.child.stdin.write(JSON.stringify(req) + '\n', 'utf8'); }
    catch (e) { clearTimeout(timer); h.pending.delete(id); reject(e); }
  });
}

async function callUiHelper(state, action, payload = {}, timeoutMs = 15000) {
  if (!state.uiHelper?.alive) await startUiHelper(state);
  return await callUiHelperExisting(state, action, payload, timeoutMs);
}

function intField(value, name, min = -100000, max = 100000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}

async function screenInfoAction(state) {
  const data = await callUiHelper(state, 'screen-info');
  return { status: 'ok', message: 'Screen geometry collected', data };
}

async function screenCaptureAction(state, cmd) {
  const maxWidth = Math.min(1600, Math.max(640, Number(cmd.maxWidth ?? 1280)));
  const data = await callUiHelper(state, 'screen-capture', { maxWidth }, 30000);
  if (typeof data.base64 !== 'string' || data.base64.length > 760000) throw new Error('Screenshot payload rejected');
  return { status: 'ok', message: `Screen captured ${data.imageWidth}x${data.imageHeight}`, data };
}



function validateSafeSvg(svg) {
  const text = String(svg ?? '').trim();
  if (!text || text.length > MAX_SVG_CHARS) throw new Error('SVG payload missing or too large');
  if (!/^<svg[\s>]/i.test(text)) throw new Error('draw_in_paint requires a self-contained <svg> document');
  const blocked = [
    /<script\b/i, /<foreignObject\b/i, /<iframe\b/i, /<object\b/i, /<embed\b/i,
    /\bon[a-z]+\s*=/i, /javascript\s*:/i, /@import\b/i,
    /url\s*\(\s*["']?\s*(?:https?|file|data):/i,
    /(?:xlink:)?href\s*=\s*["']\s*(?!#)/i
  ];
  for (const re of blocked) if (re.test(text)) throw new Error('SVG contains blocked active or external content');
  return text;
}


function parseNumAttr(tag, name, fallback = null) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?)`, 'i').exec(tag);
  return m ? Number(m[1]) : fallback;
}

function parseSvgViewBox(svg) {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const vb = /\bviewBox\s*=\s*["']\s*([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s*["']/i.exec(root);
  if (vb) return { x:Number(vb[1]), y:Number(vb[2]), width:Number(vb[3]), height:Number(vb[4]) };
  const width = parseNumAttr(root, 'width', 1000), height = parseNumAttr(root, 'height', 1000);
  return { x:0, y:0, width:width||1000, height:height||1000 };
}

function attrValue(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m ? m[1] : '';
}

function pathTokens(d) {
  return String(d ?? '').match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
}

function svgPathToPolylines(d) {
  const t = pathTokens(d); let i=0, cmd=''; let x=0,y=0,sx=0,sy=0; const out=[]; let cur=[];
  const num=()=>{ if(i>=t.length || /^[a-zA-Z]$/.test(t[i])) throw new Error('Malformed SVG path'); return Number(t[i++]); };
  const push=(px,py)=>{ x=px; y=py; if(!cur.length || Math.hypot(cur[cur.length-1].x-x,cur[cur.length-1].y-y)>0.01) cur.push({x,y}); };
  const finish=()=>{ if(cur.length>=2) out.push(cur); cur=[]; };
  while(i<t.length){
    if(/^[a-zA-Z]$/.test(t[i])) cmd=t[i++];
    if(!cmd) throw new Error('SVG path missing command');
    const rel=cmd===cmd.toLowerCase(), C=cmd.toUpperCase();
    if(C==='M'){
      const nx=num(), ny=num(); finish(); push(rel?x+nx:nx, rel?y+ny:ny); sx=x;sy=y; cmd=rel?'l':'L';
    } else if(C==='L'){
      const nx=num(),ny=num(); push(rel?x+nx:nx,rel?y+ny:ny);
    } else if(C==='H'){
      const nx=num(); push(rel?x+nx:nx,y);
    } else if(C==='V'){
      const ny=num(); push(x,rel?y+ny:ny);
    } else if(C==='C'){
      const x0=x,y0=y; let x1=num(),y1=num(),x2=num(),y2=num(),x3=num(),y3=num();
      if(rel){x1+=x0;y1+=y0;x2+=x0;y2+=y0;x3+=x0;y3+=y0}
      const steps=14; for(let k=1;k<=steps;k++){const u=k/steps,a=1-u;push(a*a*a*x0+3*a*a*u*x1+3*a*u*u*x2+u*u*u*x3,a*a*a*y0+3*a*a*u*y1+3*a*u*u*y2+u*u*u*y3)}
    } else if(C==='Q'){
      const x0=x,y0=y; let x1=num(),y1=num(),x2=num(),y2=num(); if(rel){x1+=x0;y1+=y0;x2+=x0;y2+=y0}
      const steps=12; for(let k=1;k<=steps;k++){const u=k/steps,a=1-u;push(a*a*x0+2*a*u*x1+u*u*x2,a*a*y0+2*a*u*y1+u*u*y2)}
    } else if(C==='Z'){
      push(sx,sy); finish(); cmd='';
    } else {
      throw new Error(`Unsupported SVG path command ${cmd}; use M/L/H/V/C/Q/Z for stroke mode`);
    }
  }
  finish(); return out;
}

function ellipsePolyline(cx,cy,rx,ry,steps=72){ const pts=[]; for(let i=0;i<=steps;i++){const a=i/steps*Math.PI*2;pts.push({x:cx+Math.cos(a)*rx,y:cy+Math.sin(a)*ry})} return pts; }

function svgToStrokePolylines(svg) {
  validateSafeSvg(svg); const lines=[];
  for (const m of svg.matchAll(/<path\b[^>]*>/gi)) { const tag=m[0]; if (/\bstroke\s*=\s*["']none/i.test(tag)) continue; const d=attrValue(tag,'d'); if(d) lines.push(...svgPathToPolylines(d)); }
  for (const m of svg.matchAll(/<line\b[^>]*>/gi)) { const t=m[0]; lines.push([{x:parseNumAttr(t,'x1',0),y:parseNumAttr(t,'y1',0)},{x:parseNumAttr(t,'x2',0),y:parseNumAttr(t,'y2',0)}]); }
  for (const m of svg.matchAll(/<(polyline|polygon)\b[^>]*>/gi)) { const t=m[0], pts=(attrValue(t,'points').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)||[]).map(Number); const p=[]; for(let i=0;i+1<pts.length;i+=2)p.push({x:pts[i],y:pts[i+1]}); if(m[1].toLowerCase()==='polygon'&&p.length)p.push({...p[0]}); if(p.length>=2)lines.push(p); }
  for (const m of svg.matchAll(/<rect\b[^>]*>/gi)) { const t=m[0],x=parseNumAttr(t,'x',0),y=parseNumAttr(t,'y',0),w=parseNumAttr(t,'width',0),h=parseNumAttr(t,'height',0); if(w>0&&h>0)lines.push([{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h},{x,y}]); }
  for (const m of svg.matchAll(/<circle\b[^>]*>/gi)) { const t=m[0],cx=parseNumAttr(t,'cx',0),cy=parseNumAttr(t,'cy',0),r=parseNumAttr(t,'r',0); if(r>0)lines.push(ellipsePolyline(cx,cy,r,r)); }
  for (const m of svg.matchAll(/<ellipse\b[^>]*>/gi)) { const t=m[0],cx=parseNumAttr(t,'cx',0),cy=parseNumAttr(t,'cy',0),rx=parseNumAttr(t,'rx',0),ry=parseNumAttr(t,'ry',0); if(rx>0&&ry>0)lines.push(ellipsePolyline(cx,cy,rx,ry)); }
  const total=lines.reduce((n,p)=>n+p.length,0); if(!lines.length) throw new Error('Stroke mode found no drawable SVG paths/shapes'); if(lines.length>1500||total>80000) throw new Error('SVG has too many strokes for visible drawing');
  return { viewBox:parseSvgViewBox(svg), polylines:lines };
}

function mapStrokePoints(points, viewBox, region, margin=18) {
  const sx=(region.width-margin*2)/Math.max(1,viewBox.width), sy=(region.height-margin*2)/Math.max(1,viewBox.height), scale=Math.min(sx,sy);
  const ox=region.x+margin+(region.width-margin*2-viewBox.width*scale)/2-viewBox.x*scale;
  const oy=region.y+margin+(region.height-margin*2-viewBox.height*scale)/2-viewBox.y*scale;
  const out=[]; let last=null;
  for(const p of points){const q={x:Math.round(ox+p.x*scale),y:Math.round(oy+p.y*scale)};if(!last||Math.hypot(q.x-last.x,q.y-last.y)>=1.5){out.push(q);last=q}}
  return out;
}

async function renderSvgStrokesInPaint(state, svg, canvas, cmd={}) {
  const parsed=svgToStrokePolylines(svg); const margin=Math.max(4,Math.min(120,Number(cmd.margin??20))); let strokes=0,points=0;
  // Best effort: ensure Paint has focus before every visible drawing run.
  await ensurePaintForeground(state);
  for(const source of parsed.polylines){
    const mapped=mapStrokePoints(source,parsed.viewBox,canvas,margin); if(mapped.length<2)continue;
    for(let off=0;off<mapped.length-1;off+=1900){const chunk=mapped.slice(off,Math.min(mapped.length,off+1901)); if(chunk.length<2)continue; const duration=Math.max(100,Math.min(12000,Number(cmd.strokeDurationMs??Math.max(120,chunk.length*8)))); await callUiHelper(state,'mouse-drag',{points:chunk,button:'left',durationMs:duration},duration+10000); strokes++; points+=chunk.length;}
  }
  return {strokes,points,viewBox:parsed.viewBox};
}

let _DatabaseSync = null;
async function databaseSyncClass(){ if(_DatabaseSync)return _DatabaseSync; const mod=await import('node:sqlite'); _DatabaseSync=mod.DatabaseSync; return _DatabaseSync; }
function normalizeMatch(s){return String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();}
function decodeNotificationPayload(v){if(v==null)return'';const b=Buffer.isBuffer(v)?v:Buffer.from(v);if(!b.length)return'';let zeros=0;for(let i=1;i<Math.min(b.length,200);i+=2)if(b[i]===0)zeros++;let s=zeros>20?b.toString('utf16le'):b.toString('utf8');return s.replace(/\0/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");}
function notificationDbPath(){return path.join(process.env.LOCALAPPDATA??'', 'Microsoft','Windows','Notifications','wpndatabase.db');}
async function openNotificationDb(){
  const source=notificationDbPath(); if(!IS_WIN||!fs.existsSync(source))return null; const DatabaseSync=await databaseSyncClass();
  try{return{db:new DatabaseSync(source,{readOnly:true}),cleanup:null}}catch{}
  const tmp=path.join(os.tmpdir(),`clb-wpn-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);await fsp.mkdir(tmp,{recursive:true});
  const dst=path.join(tmp,'wpndatabase.db');await fsp.copyFile(source,dst);
  for(const suffix of ['-wal','-shm']){try{await fsp.copyFile(source+suffix,dst+suffix)}catch{}}
  try{return{db:new DatabaseSync(dst),cleanup:()=>fsp.rm(tmp,{recursive:true,force:true})}}
  catch(e){await fsp.rm(tmp,{recursive:true,force:true});throw new Error(`Unable to open Windows notification database: ${e.message}`)}
}
async function readNotificationRows(afterOrder=0){
  const opened=await openNotificationDb(); if(!opened)return[]; const {db,cleanup}=opened;
  try{
    const stmt=db.prepare('SELECT n."Order" AS ord, n.ArrivalTime AS arrival, n.Payload AS payload, h.PrimaryId AS primaryId FROM Notification n LEFT JOIN NotificationHandler h ON n.HandlerId=h.RecordId WHERE n."Order" > ? ORDER BY n."Order" ASC LIMIT 200');
    return stmt.all(Number(afterOrder)||0).map(r=>({order:Number(r.ord),arrival:Number(r.arrival||0),primaryId:String(r.primaryId??''),payload:decodeNotificationPayload(r.payload)}));
  } finally {try{db.close()}catch{};try{await cleanup?.()}catch{}}
}
async function maxNotificationOrder(){
  const opened=await openNotificationDb(); if(!opened)return 0; const {db,cleanup}=opened;
  try{const row=db.prepare('SELECT COALESCE(MAX("Order"),0) AS maxOrder FROM Notification').get();return Number(row?.maxOrder||0)}
  finally{try{db.close()}catch{};try{await cleanup?.()}catch{}}
}
async function loadWatches(state){if(state.notificationWatches)return state.notificationWatches;const file=path.join(state.dataDir,'notification-watches.json');let arr=[];try{arr=JSON.parse(await fsp.readFile(file,'utf8'));if(!Array.isArray(arr))arr=[]}catch{}state.notificationWatches=arr.filter(w=>w&&w.id&&w.enabled!==false);state.watchFile=file;return state.notificationWatches;}
async function saveWatches(state){await fsp.mkdir(state.dataDir,{recursive:true});await fsp.writeFile(state.watchFile??path.join(state.dataDir,'notification-watches.json'),JSON.stringify(state.notificationWatches??[],null,2)+'\n','utf8');}
function alarmScriptPath(){return path.join(path.dirname(fileURLToPath(import.meta.url)),'alarm.ps1');}
function triggerLocalAlarm(watch,row){if(!IS_WIN)return;const script=alarmScriptPath();const title=watch.title||'ChatGPT Local Bridge - Alerte';const body=`${watch.label||watch.textContains||'Notification detectee'}\n${String(row.payload).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,500)}`;try{const c=spawn('powershell.exe',['-Sta','-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Title',title,'-Body',body,'-TimeoutSeconds',String(watch.alarmSeconds||90)],{detached:true,windowsHide:false,stdio:'ignore'});c.unref()}catch{}}
async function pollNotificationWatches(state){const watches=await loadWatches(state);if(!watches.length)return;let min=Math.min(...watches.map(w=>Number(w.lastOrder||0)));const rows=await readNotificationRows(min);if(!rows.length)return;let changed=false;for(const w of watches){for(const r of rows){if(r.order<=Number(w.lastOrder||0))continue;w.lastOrder=Math.max(Number(w.lastOrder||0),r.order);changed=true;const p=normalizeMatch(r.payload),app=normalizeMatch(r.primaryId),text=normalizeMatch(w.textContains),source=normalizeMatch(w.appContains);const sourceOk=!source||app.includes(source)||p.includes(source);if(sourceOk&&text&&p.includes(text)){w.lastMatch={at:nowIso(),order:r.order,primaryId:r.primaryId,preview:String(r.payload).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,600)};triggerLocalAlarm(w,r);}}
  }if(changed)await saveWatches(state);}
function ensureNotificationWatchLoop(state){if(state.watchTimer)return;state.watchTimer=setInterval(()=>pollNotificationWatches(state).catch(()=>{}),Math.max(1000,Number(state.watchPollMs||2000)));state.watchTimer.unref?.();pollNotificationWatches(state).catch(()=>{});}
async function watchNotificationAction(state,cmd){const textContains=String(cmd.textContains??cmd.sender??'').trim();if(!textContains||textContains.length>160)throw new Error('textContains/sender is required');const appContains=String(cmd.appContains??'').trim();const watches=await loadWatches(state);const id=String(cmd.id??`watch-${crypto.randomBytes(6).toString('hex')}`);if(watches.some(w=>w.id===id))throw new Error('Watch id already exists');const baseline=await maxNotificationOrder();const w={id,enabled:true,label:String(cmd.label??textContains),appContains,textContains,alarmSeconds:Math.max(10,Math.min(600,Number(cmd.alarmSeconds??90))),createdAt:nowIso(),lastOrder:baseline};watches.push(w);await saveWatches(state);ensureNotificationWatchLoop(state);return{status:'ok',message:`Notification watch started: ${w.label}`,data:w};}
async function watchTeamsSenderAction(state,cmd){const sender=String(cmd.sender??'').trim();if(!sender)throw new Error('sender is required');return await watchNotificationAction(state,{...cmd,label:`Teams: ${sender}`,appContains:'teams',textContains:sender});}
async function listWatchesAction(state){const watches=await loadWatches(state);ensureNotificationWatchLoop(state);return{status:'ok',message:`${watches.length} local watch(es) active`,data:watches};}
async function stopWatchAction(state,cmd){const id=String(cmd.id??'').trim();const watches=await loadWatches(state);const i=watches.findIndex(w=>w.id===id);if(i<0)throw new Error('Watch not found');const [removed]=watches.splice(i,1);await saveWatches(state);return{status:'ok',message:`Watch stopped: ${removed.label||id}`,data:removed};}
async function testAlarmAction(){triggerLocalAlarm({label:'Test alarme',alarmSeconds:15},{payload:'ChatGPT Local Bridge fonctionne.'});return{status:'ok',message:'Local alarm triggered for 15 seconds'};}
async function initializePersistentServices(state){const watches=await loadWatches(state);if(watches.length)ensureNotificationWatchLoop(state);return{watches:watches.length};}

async function chromiumRenderers() {
  if (!IS_WIN) return [];
  const out = [];
  const seen = new Set();
  const add = (label, exe) => {
    const p = String(exe ?? '').trim().replace(/^"|"$/g, '');
    if (!p) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    try { if (!fs.statSync(p).isFile()) return; } catch { return; }
    seen.add(key);
    out.push({ label, exe: p });
  };

  if (process.env.CHROME_PATH) add('Google Chrome', process.env.CHROME_PATH);
  const roots = [process.env.PROGRAMFILES, process.env.PROGRAMFILES_X86, process.env.LOCALAPPDATA].filter(Boolean);
  for (const r of roots) {
    add('Microsoft Edge', path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add('Google Chrome', path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add('Brave', path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    add('Chromium', path.join(r, 'Chromium', 'Application', 'chrome.exe'));
  }

  for (const name of ['msedge.exe','chrome.exe','brave.exe','chromium.exe']) {
    try {
      const r = await runCaptured('where.exe', [name], { timeoutMs: 5000 });
      if (r.code === 0) {
        for (const line of String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
          const label = /msedge/i.test(name) ? 'Microsoft Edge' : /brave/i.test(name) ? 'Brave' : /chromium/i.test(name) ? 'Chromium' : 'Google Chrome';
          add(label, line);
        }
      }
    } catch {}
  }
  return out;
}

async function rasterizeSvgToPng(state, svg, width, height) {
  if (!IS_WIN) throw new Error('SVG rasterization for Paint is available on Windows only');
  const safeSvg = validateSafeSvg(svg);
  const w = intField(width ?? 1100, 'width', 64, 2048);
  const h = intField(height ?? 1100, 'height', 64, 2048);
  const dir = path.join(state.dataDir, 'renders');
  await fsp.mkdir(dir, { recursive: true });
  const nonce = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const htmlPath = path.join(dir, `render-${nonce}.html`);
  const pngPath = path.join(dir, `render-${nonce}.png`);
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}svg{width:100vw!important;height:100vh!important;display:block}</style>${safeSvg}`;
  await fsp.writeFile(htmlPath, html, 'utf8');

  const renderers = await chromiumRenderers();
  if (!renderers.length) {
    await fsp.rm(htmlPath, { force: true });
    throw new Error('No Chromium renderer found. Install or keep Microsoft Edge, Google Chrome, Brave, or Chromium available.');
  }

  const url = pathToFileURL(htmlPath).href;
  const failures = [];
  let chosen = null;
  for (let i = 0; i < renderers.length && !chosen; i++) {
    const renderer = renderers[i];
    for (const headless of ['--headless=new','--headless']) {
      const profileDir = path.join(dir, `browser-profile-${nonce}-${i}-${headless.includes('new') ? 'new' : 'legacy'}`);
      await fsp.rm(pngPath, { force: true });
      await fsp.mkdir(profileDir, { recursive: true });
      const common = [
        '--no-first-run','--no-default-browser-check','--disable-gpu','--hide-scrollbars',
        '--run-all-compositor-stages-before-draw','--force-device-scale-factor=1',
        `--user-data-dir=${profileDir}`,`--window-size=${w},${h}`,`--screenshot=${pngPath}`,url
      ];
      const r = await runCaptured(renderer.exe, [headless, ...common], { timeoutMs: 45000 });
      await fsp.rm(profileDir, { recursive: true, force: true });
      let good = false;
      try { good = r.code === 0 && fs.statSync(pngPath).size > 100; } catch {}
      if (good) { chosen = renderer; break; }
      failures.push(`${renderer.label}: ${truncate(r.stderr || r.stdout || r.error || `exit ${r.code}`, 600)}`);
    }
  }

  await fsp.rm(htmlPath, { force: true });
  if (!chosen || !fs.existsSync(pngPath)) {
    await fsp.rm(pngPath, { force: true });
    throw new Error(`SVG rasterization failed with all available browsers: ${truncate(failures.join(' | '), 3000)}`);
  }
  const buf = await fsp.readFile(pngPath);
  await fsp.rm(pngPath, { force: true });
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error('Rasterized image rejected');
  return { buf, width: w, height: h, renderer: chosen.label, rendererPath: chosen.exe };
}


const PAINT_CLASSIC_PALETTE = [
  {name:'black',hex:'#000000',r:0,g:0,b:0},
  {name:'dark-gray',hex:'#7f7f7f',r:127,g:127,b:127},
  {name:'light-gray',hex:'#c3c3c3',r:195,g:195,b:195},
  {name:'white',hex:'#ffffff',r:255,g:255,b:255},
  {name:'maroon',hex:'#880015',r:136,g:0,b:21},
  {name:'red',hex:'#ed1c24',r:237,g:28,b:36},
  {name:'orange',hex:'#ff7f27',r:255,g:127,b:39},
  {name:'yellow',hex:'#fff200',r:255,g:242,b:0},
  {name:'green',hex:'#22b14c',r:34,g:177,b:76},
  {name:'lime',hex:'#b5e61d',r:181,g:230,b:29},
  {name:'teal',hex:'#00a2e8',r:0,g:162,b:232},
  {name:'blue',hex:'#3f48cc',r:63,g:72,b:204},
  {name:'purple',hex:'#a349a4',r:163,g:73,b:164},
  {name:'pink',hex:'#ffaec9',r:255,g:174,b:201},
  {name:'brown',hex:'#b97a57',r:185,g:122,b:87},
  {name:'tan',hex:'#ffc90e',r:255,g:201,b:14}
];

function paintPaletteFor(profile='classic16') {
  const p=String(profile||'classic16').toLowerCase();
  if(p==='gray4'||p==='grayscale') return PAINT_CLASSIC_PALETTE.filter(x=>['black','dark-gray','light-gray','white'].includes(x.name));
  if(p==='portrait8') return PAINT_CLASSIC_PALETTE.filter(x=>['black','dark-gray','light-gray','white','brown','pink','maroon','tan'].includes(x.name));
  if(p==='classic12') return PAINT_CLASSIC_PALETTE.filter(x=>!['lime','teal','purple','tan'].includes(x.name));
  return PAINT_CLASSIC_PALETTE;
}

function decodePngRgba(buf) {
  const sig=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if(!Buffer.isBuffer(buf)||buf.length<32||!buf.subarray(0,8).equals(sig)) throw new Error('Raster renderer expected PNG');
  let off=8,w=0,h=0,bit=0,type=0,interlace=0; const idat=[];
  while(off+12<=buf.length){const len=buf.readUInt32BE(off);const name=buf.toString('ascii',off+4,off+8);const data=buf.subarray(off+8,off+8+len);off+=12+len;
    if(name==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);bit=data[8];type=data[9];interlace=data[12];}
    else if(name==='IDAT') idat.push(data); else if(name==='IEND') break;
  }
  if(!w||!h||bit!==8||![2,6].includes(type)||interlace!==0) throw new Error(`Unsupported PNG format ${w}x${h} bit=${bit} type=${type} interlace=${interlace}`);
  const bpp=type===6?4:3, stride=w*bpp, raw=zlib.inflateSync(Buffer.concat(idat));
  if(raw.length<(stride+1)*h) throw new Error('Truncated PNG data');
  const scan=Buffer.alloc(stride*h); let src=0;
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c};
  for(let y=0;y<h;y++){
    const f=raw[src++], row=y*stride, prev=(y-1)*stride;
    for(let x=0;x<stride;x++){
      const v=raw[src++], a=x>=bpp?scan[row+x-bpp]:0, b=y?scan[prev+x]:0, c=(y&&x>=bpp)?scan[prev+x-bpp]:0;
      let q=v; if(f===1)q=(v+a)&255; else if(f===2)q=(v+b)&255; else if(f===3)q=(v+Math.floor((a+b)/2))&255; else if(f===4)q=(v+paeth(a,b,c))&255; else if(f!==0) throw new Error(`Unsupported PNG filter ${f}`); scan[row+x]=q;
    }
  }
  const rgba=Buffer.alloc(w*h*4); let si=0,di=0;
  for(let i=0;i<w*h;i++){rgba[di++]=scan[si++];rgba[di++]=scan[si++];rgba[di++]=scan[si++];rgba[di++]=type===6?scan[si++]:255;}
  return {width:w,height:h,rgba};
}

function nearestPaletteIndex(r,g,b,palette) {
  let best=0,score=Infinity;
  for(let i=0;i<palette.length;i++){
    const p=palette[i]; const dr=r-p.r,dg=g-p.g,db=b-p.b;
    // Human vision weights green most heavily; keep integer-ish and cheap.
    const s=dr*dr*30+dg*dg*59+db*db*11;
    if(s<score){score=s;best=i;}
  }
  return best;
}

function resampleQuantizePng(buf,{maxWidth=240,maxHeight=240,paletteProfile='classic16',smoothPasses=1}={}) {
  const src=decodePngRgba(buf); const scale=Math.min(1,maxWidth/src.width,maxHeight/src.height);
  const dw=Math.max(1,Math.round(src.width*scale)), dh=Math.max(1,Math.round(src.height*scale));
  const palette=paintPaletteFor(paletteProfile); let idx=new Uint8Array(dw*dh);
  for(let y=0;y<dh;y++)for(let x=0;x<dw;x++){
    const sx=(x+0.5)*src.width/dw-0.5, sy=(y+0.5)*src.height/dh-0.5;
    const x0=Math.max(0,Math.min(src.width-1,Math.floor(sx))), y0=Math.max(0,Math.min(src.height-1,Math.floor(sy)));
    const x1=Math.min(src.width-1,x0+1), y1=Math.min(src.height-1,y0+1), fx=Math.max(0,Math.min(1,sx-x0)), fy=Math.max(0,Math.min(1,sy-y0));
    const sample=(xx,yy,c)=>src.rgba[(yy*src.width+xx)*4+c];
    const mix=(c)=>{const a=sample(x0,y0,c)*(1-fx)+sample(x1,y0,c)*fx,b=sample(x0,y1,c)*(1-fx)+sample(x1,y1,c)*fx;return a*(1-fy)+b*fy};
    const a=mix(3)/255, r=Math.round(mix(0)*a+255*(1-a)), g=Math.round(mix(1)*a+255*(1-a)), b=Math.round(mix(2)*a+255*(1-a));
    idx[y*dw+x]=nearestPaletteIndex(r,g,b,palette);
  }
  for(let pass=0;pass<Math.max(0,Math.min(2,smoothPasses));pass++){
    const next=idx.slice();
    for(let y=1;y<dh-1;y++)for(let x=1;x<dw-1;x++){
      const counts=new Uint8Array(palette.length); for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++)counts[idx[(y+yy)*dw+x+xx]]++;
      let bi=idx[y*dw+x],bc=counts[bi];for(let i=0;i<counts.length;i++)if(counts[i]>bc){bi=i;bc=counts[i]}
      if(bc>=6)next[y*dw+x]=bi;
    }
    idx=next;
  }
  return {width:dw,height:dh,palette,indexes:idx};
}

function rasterSegments(q,{minRun=1}={}) {
  const white=q.palette.findIndex(p=>p.name==='white'); const groups=[];
  for(let ci=0;ci<q.palette.length;ci++){
    if(ci===white)continue; const segments=[];
    for(let y=0;y<q.height;y++){
      let x=0; while(x<q.width){while(x<q.width&&q.indexes[y*q.width+x]!==ci)x++; if(x>=q.width)break; const x1=x; while(x<q.width&&q.indexes[y*q.width+x]===ci)x++; const x2=x-1;
        if(x2-x1+1>=minRun)segments.push({x1,x2,y});
      }
    }
    if(segments.length){const p=q.palette[ci];groups.push({name:p.name,hex:p.hex,r:p.r,g:p.g,b:p.b,segments});}
  }
  // Paint light areas first and dark outlines last.
  groups.sort((a,b)=>(b.r*30+b.g*59+b.b*11)-(a.r*30+a.g*59+a.b*11));
  return groups;
}

function rasterQualityProfile(name='balanced') {
  const n=String(name||'balanced').toLowerCase();
  if(n==='fast')return{resolution:128,palette:'portrait8',smooth:2,minRun:2,batch:180,delay:1};
  if(n==='quality')return{resolution:240,palette:'classic16',smooth:1,minRun:1,batch:100,delay:2};
  if(n==='ultra')return{resolution:320,palette:'classic16',smooth:0,minRun:1,batch:70,delay:3};
  return{resolution:180,palette:'classic12',smooth:1,minRun:1,batch:130,delay:2};
}

function rasterHelperPath(){return path.join(path.dirname(fileURLToPath(import.meta.url)),'paint-raster-helper.ps1');}
async function paintJobsDir(state){const d=path.join(state.dataDir,'paint-jobs');await fsp.mkdir(d,{recursive:true});return d;}
function safeJobId(v){const x=String(v??'');if(!/^[a-f0-9]{16,40}$/i.test(x))throw new Error('Invalid paint job id');return x.toLowerCase();}
async function latestPaintJobId(state){const d=await paintJobsDir(state);let best=null;for(const name of await fsp.readdir(d)){const m=name.match(/^([a-f0-9]{20})\.status\.json$/i);if(!m)continue;const f=path.join(d,name);const st=await fsp.stat(f);if(!best||st.mtimeMs>best.mtimeMs)best={id:m[1].toLowerCase(),mtimeMs:st.mtimeMs};}return best?.id??null;}
async function paintJobStatusAction(state,cmd={}){const id=cmd.jobId?safeJobId(cmd.jobId):await latestPaintJobId(state);if(!id)return{status:'ok',message:'No Paint raster job has been started',data:{state:'idle'}};const f=path.join(await paintJobsDir(state),`${id}.status.json`);let data;try{data=JSON.parse(await fsp.readFile(f,'utf8'))}catch{throw new Error('Paint job status unavailable')};return{status:'ok',message:`Paint job ${data.state||'unknown'} ${Math.round(Number(data.progress||0))}%`,data};}
async function paintJobControlAction(state,cmd={}){const id=cmd.jobId?safeJobId(cmd.jobId):await latestPaintJobId(state);if(!id)throw new Error('No Paint job available');const c=String(cmd.command??cmd.control??'').toLowerCase();if(!['pause','resume','stop'].includes(c))throw new Error('command must be pause, resume, or stop');const d=await paintJobsDir(state), control=path.join(d,`${id}.control.json`);await fsp.writeFile(control,JSON.stringify({command:c,at:nowIso()})+'\n','utf8');return{status:'ok',message:`Paint job ${c} requested`,data:{jobId:id,command:c}};}

async function startPaintRasterJob(state,cmd,paint,canvas) {
  if(!IS_WIN)throw new Error('Raster Paint jobs are available on Windows only');
  const profile=rasterQualityProfile(cmd.quality??'balanced');
  const paletteProfile=String(cmd.palette??profile.palette);
  const requested=Math.max(64,Math.min(420,Number(cmd.resolution??profile.resolution)));
  const maxW=Math.max(32,Math.min(requested,Math.floor(Number(canvas.width)-24))),maxH=Math.max(32,Math.min(requested,Math.floor(Number(canvas.height)-24)));
  const raster=await rasterizeSvgToPng(state,cmd.svg,Math.max(256,maxW*3),Math.max(256,maxH*3));
  const q=resampleQuantizePng(raster.buf,{maxWidth:maxW,maxHeight:maxH,paletteProfile,smoothPasses:cmd.smoothing===false?0:profile.smooth});
  const groups=rasterSegments(q,{minRun:Number(cmd.minRun??profile.minRun)}); const segmentCount=groups.reduce((n,g)=>n+g.segments.length,0);
  if(!segmentCount)throw new Error('Raster plan contains no non-white pixels'); if(segmentCount>60000)throw new Error(`Raster plan too complex (${segmentCount} segments); lower resolution or use a faster quality profile`);
  const originX=Math.round(Number(canvas.x)+(Number(canvas.width)-q.width)/2),originY=Math.round(Number(canvas.y)+(Number(canvas.height)-q.height)/2);
  const id=crypto.randomBytes(10).toString('hex'),d=await paintJobsDir(state),planPath=path.join(d,`${id}.plan.json`),statusPath=path.join(d,`${id}.status.json`),controlPath=path.join(d,`${id}.control.json`);
  const plan={version:VERSION,jobId:id,statusPath,controlPath,paintHwnd:paint.hwnd,paintTitle:paint.title,windowBounds:paint.bounds,canvas:{x:Number(canvas.x),y:Number(canvas.y),width:Number(canvas.width),height:Number(canvas.height)},originX,originY,rasterWidth:q.width,rasterHeight:q.height,paletteProfile,quality:String(cmd.quality??'balanced'),segmentCount,batchEvery:Number(cmd.batchEvery??profile.batch),batchDelayMs:Number(cmd.batchDelayMs??profile.delay),groups};
  await fsp.writeFile(planPath,JSON.stringify(plan),'utf8'); await fsp.writeFile(statusPath,JSON.stringify({jobId:id,state:'starting',progress:0,segmentCount,completedSegments:0,quality:plan.quality,palette:paletteProfile,startedAt:nowIso(),hint:'Move the physical mouse to pause instantly. F8 resumes/pauses. F9 stops.'},null,2)+'\n','utf8');
  const child=spawn('powershell.exe',['-Sta','-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',rasterHelperPath(),'-PlanPath',planPath],{detached:true,windowsHide:false,stdio:'ignore'}); child.unref();
  return{status:'ok',message:`Started cheat-style raster drawing (${q.width}x${q.height}, ${segmentCount} compressed runs). Move your mouse to pause; F8 resume/pause; F9 stop.`,data:{jobId:id,state:'starting',mode:'raster',quality:plan.quality,palette:paletteProfile,rasterWidth:q.width,rasterHeight:q.height,segmentCount,originX,originY,helperPid:child.pid,controls:{physicalMouse:'auto-pause',F8:'pause/resume',F9:'stop'}}};
}

async function focusWindowHandle(state, hwnd) {
  const h = Number(hwnd);
  if (!Number.isFinite(h) || h <= 0) throw new Error('Invalid window handle');
  const data = await callUiHelper(state, 'focus-window', { hwnd: h }, 12000);
  return data;
}

async function inspectWindowContext(state, processInfo) {
  const hwnd = Number(processInfo?.MainWindowHandle ?? processInfo?.hwnd);
  const native = await callUiHelper(state, 'window-context', { hwnd }, 12000);
  return createWindowContext({
    ...native,
    hwnd,
    pid: Number(processInfo?.Id ?? native.pid),
    processName: processInfo?.ProcessName,
    title: processInfo?.MainWindowTitle,
    monitorInfo: {
      id: native.monitor,
      bounds: native.monitorBounds,
      workArea: native.monitorWorkArea,
      primary: native.primary,
      dpi: native.dpi,
      scale: native.scale
    }
  });
}

function isPaintWindow(p) {
  const proc = String(p?.ProcessName ?? '').toLowerCase();
  const title = String(p?.MainWindowTitle ?? '').toLowerCase();
  return proc === 'mspaint' || title === 'paint' || title.endsWith(' - paint') || title.includes('microsoft paint');
}

async function ensurePaintForeground(state) {
  let win = (await processList()).find((p) => Number(p.MainWindowHandle) !== 0 && isPaintWindow(p));
  if (!win) {
    try { await launchAppAction(state, { name: 'Paint' }); }
    catch { runDetached('mspaint.exe', []); }
    for (let i = 0; i < 20; i++) {
      await sleep(350);
      win = (await processList()).find((p) => Number(p.MainWindowHandle) !== 0 && isPaintWindow(p));
      if (win) break;
    }
  }
  if (!win) throw new Error('Microsoft Paint did not expose a visible window');
  const focus = await focusWindowHandle(state, Number(win.MainWindowHandle));
  await sleep(350);
  const context = await inspectWindowContext(state, win);
  if (!focus?.focused || !context.focused || context.state.minimized) throw new Error('Paint focus could not be validated');
  return context;
}

async function rendererInfoAction() {
  const items = await chromiumRenderers();
  return {
    status: 'ok',
    message: items.length ? `${items.length} Chromium renderer(s) available` : 'No Chromium renderer found',
    data: { renderers: items.map(({ label, exe }) => ({ label, path: exe })) }
  };
}

async function drawInPaintAction(state, cmd) {
  const modeRaw = String(cmd.mode ?? 'raster-color').toLowerCase();
  const mode = modeRaw === 'mouse' ? 'vector' : modeRaw === 'strokes' ? 'vector' : modeRaw === 'raster' ? 'raster-color' : modeRaw;
  if (!['vector','exact','raster-color','raster-gray'].includes(mode)) throw new Error('mode must be raster-color, raster-gray, vector, or exact');
  const width = intField(cmd.width ?? 1100, 'width', 64, 2048);
  const height = intField(cmd.height ?? 1100, 'height', 64, 2048);
  const paint = await ensurePaintForeground(state);
  let canvas;
  try { canvas = (await findPaintCanvasAction(state)).data; } catch { canvas = null; }
  if (!canvas) throw new Error('Paint canvas detection is required');

  // V19.9.9: backend routing is now part of the execution decision.
  // This only selects an execution path; success still requires validation evidence.
  const backendDecision = choosePaintBackend({
    // V19.9.15: only select a backend when a real executor handler is connected.
    // Avoid selecting theoretical capabilities that immediately fail.
    clipboardAvailable: Boolean(cmd.clipboardAvailable) && typeof cmd._clipboardExecutor === 'function',
    uiAutomationAvailable: false,
    win32Available: false,
    rasterAvailable: true
  });
  const backendExecutionPlan = {
    backend: backendDecision.id,
    executorAvailable: true,
    selectedAt: Date.now(),
    reason: 'context-capability-selection'
  };

  if (mode === 'raster-color' || mode === 'raster-gray') {
    if (!cmd.svg) throw new Error('Raster drawing currently requires svg target data');
    let paintEvidenceBefore = null;
    try {
      paintEvidenceBefore = (await screenCaptureRegionAction(state, {
        x: Number(canvas.x),
        y: Number(canvas.y),
        width: Number(canvas.width),
        height: Number(canvas.height),
        maxWidth: 1280
      })).data;
    } catch {}
    const backendContext = { state, cmd, paint, canvas, mode, evidence: { before: paintEvidenceBefore } };
    const handlers = createPaintBackendHandlers({
      rasterFallback: async (context) => {
        const result = await startPaintRasterJob(state,{...cmd,palette:mode==='raster-gray'?'gray4':(cmd.palette??undefined),backendDecision,backendExecutionPlan},paint,canvas);
        let after = null;
        try {
          after = (await screenCaptureRegionAction(state, {
            x:Number(canvas.x),
            y:Number(canvas.y),
            width:Number(canvas.width),
            height:Number(canvas.height),
            maxWidth:1280
          })).data;
        } catch {}
        const before = backendContext?.evidence?.before ?? null;
        const changed = Boolean(before && after && JSON.stringify(before) !== JSON.stringify(after));
        return {
          executed:true,
          backend:'raster-fallback',
          evidence:{
            changed,
            goalReached:changed,
            beforeCaptured:Boolean(before),
            afterCaptured:Boolean(after)
          },
          validationState:createPaintValidationState({
            commandReceived:true,
            backendSelected:'raster-fallback',
            backendExecuted:true,
            changed,
            failure: changed ? null : {reason:'no-observable-change'}
          }),
          result
        };
      }
    });
    const gatedExecution = await runPaintActionGate({
      command: { action:'draw', mode, width, height },
      context: backendContext,
      execute: async () => executePaintBackend(backendDecision, backendContext, handlers),
      validate: async ({ execution }) => ({
        changed: Boolean(execution?.evidence?.changed),
        goalReached: Boolean(execution?.evidence?.goalReached),
        source: 'backend-evidence'
      })
    });
    const backendExecution = {
      ...gatedExecution,
      result: null,
      executed: gatedExecution.actionExecuted,
      evidence: gatedExecution.evidence
    };
    if (!backendExecution.executed) {
      const diagnostic = {
        stage: 'paint-backend-execution',
        backend: backendExecution.backendSelected ?? backendDecision.id,
        actionExecuted: backendExecution.actionExecuted,
        resultObserved: backendExecution.resultObserved,
        evidence: backendExecution.evidence ?? null,
        failure: backendExecution.failure ?? { reason: 'unknown' }
      };
      throw new Error(`Paint backend execution failed: ${JSON.stringify(diagnostic)}`);
    }
    const result = null;
    return {
      ...(result || {}),
      data: {
        ...(result?.data || {}),
        backendExecution,
        executionContract: {
          requested: true,
          backendSelected: backendDecision.id,
          executed: backendExecution.executed,
          validated: Boolean(backendExecution?.evidence?.goalReached),
          note: 'Backend Executor is now in the real raster execution path'
        }
      }
    };
  }

  if (mode === 'vector') {
    let before = null;
    try { before = (await screenCaptureRegionAction(state, { x: Number(canvas.x), y: Number(canvas.y), width: Number(canvas.width), height: Number(canvas.height), maxWidth: 1280 })).data; } catch {}
    const trace = await renderSvgStrokesInPaint(state, validateSafeSvg(cmd.svg), canvas, cmd);
    await sleep(500);
    let after = null; try { after = (await screenCaptureRegionAction(state, { x: Number(canvas.x), y: Number(canvas.y), width: Number(canvas.width), height: Number(canvas.height), maxWidth: 1280 })).data; } catch {}
    const changed = Boolean(before?.base64 && after?.base64 && sha256Text(before.base64) !== sha256Text(after.base64));
    const validation = { validated: Boolean(before && after), changed, goalReached: trace.strokes > 0 && changed, method: 'canvas-before-after-digest' };
    return {status:'ok',message:validation.goalReached?`Drew and validated ${trace.strokes} visible vector stroke(s) in Paint`:`Executed ${trace.strokes} vector stroke(s); visual goal was not independently validated`,data:{mode:'vector',backendDecision,backendExecutionPlan,paint,canvas,trace,validation,...(after?{base64:after.base64,mime:after.mime,imageWidth:after.imageWidth,imageHeight:after.imageHeight}:{})}};
  }

  const raster = await rasterizeSvgToPng(state, cmd.svg, width, height);
  const target = await imageTargetCreateAction(state, { base64: raster.buf.toString('base64') });
  const targetId = target.data.targetId;
  let renderWidth = width, renderHeight = height;
  const scale = Math.min(1, Number(canvas.width) / width, Number(canvas.height) / height);
  renderWidth = Math.max(32, Math.floor(width * scale)); renderHeight = Math.max(32, Math.floor(height * scale));
  await paintRenderTargetAction(state, { targetId, width: renderWidth, height: renderHeight });
  await sleep(800);
  let comparison=null; try{comparison=(await compareTargetRegionAction(state,{targetId,x:Number(canvas.x),y:Number(canvas.y),width:renderWidth,height:renderHeight})).data}catch{}
  let screenshot=null; try{screenshot=(await screenCaptureAction(state,{maxWidth:1280})).data}catch{}
  const score=comparison==null?null:Number(comparison.matchScore??0);
  const minScore=Math.max(0,Math.min(1,Number(cmd.minScore??0.75)));
  const validation={validated:score!=null,changed:score!=null,goalReached:score!=null&&score>=minScore,score,minScore,method:'target-region-match'};
  return {status:'ok',message:validation.goalReached?`Rendered exact drawing in Paint, visual match ${(score*100).toFixed(1)}%`:'Exact render executed; visual goal was not validated',data:{targetId,mode:'exact',backendDecision,backendExecutionPlan,renderer:raster.renderer,paint,canvas,renderWidth,renderHeight,comparison,validation,...(screenshot?{base64:screenshot.base64,mime:screenshot.mime,imageWidth:screenshot.imageWidth,imageHeight:screenshot.imageHeight}:{})}};
}

function decodeImagePayload(base64) {
  if (typeof base64 !== 'string' || base64.length < 16 || base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) throw new Error('Invalid image payload length');
  let buf;
  try { buf = Buffer.from(base64, 'base64'); } catch { throw new Error('Invalid image base64'); }
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error('Image payload too large');
  const png = buf.length >= 8 && buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const jpg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpg) throw new Error('Only PNG and JPEG images are accepted');
  return { buf, mime: png ? 'image/png' : 'image/jpeg', ext: png ? '.png' : '.jpg' };
}

function targetIdField(value) {
  const id = String(value ?? '');
  if (!/^[a-f0-9]{20,64}$/i.test(id)) throw new Error('Invalid targetId');
  return id.toLowerCase();
}

async function targetDir(state) {
  const d = path.join(state.dataDir, 'targets');
  await fsp.mkdir(d, { recursive: true });
  return d;
}

async function targetFileById(state, id) {
  const tid = targetIdField(id);
  const d = await targetDir(state);
  for (const ext of ['.png','.jpg']) {
    const f = path.join(d, tid + ext);
    try { const st = await fsp.stat(f); if (st.isFile()) return { file: f, tid, ext, size: st.size }; } catch {}
  }
  throw new Error('Unknown image target');
}

async function imageTargetCreateAction(state, cmd) {
  const { buf, mime, ext } = decodeImagePayload(cmd.base64 ?? cmd.imageBase64);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const tid = hash.slice(0, 24);
  const d = await targetDir(state);
  const file = path.join(d, tid + ext);
  await fsp.writeFile(file, buf, { mode: 0o600 });
  return { status: 'ok', message: `Image target stored: ${tid}`, data: { targetId: tid, mime, bytes: buf.length, sha256: hash } };
}

async function imageTargetInfoAction(state, cmd) {
  const t = await targetFileById(state, cmd.targetId);
  const buf = await fsp.readFile(t.file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return { status: 'ok', message: `Image target ${t.tid}`, data: { targetId: t.tid, bytes: t.size, sha256: hash, mime: t.ext === '.png' ? 'image/png' : 'image/jpeg' } };
}

async function imageTargetDeleteAction(state, cmd) {
  const t = await targetFileById(state, cmd.targetId);
  await fsp.unlink(t.file);
  return { status: 'ok', message: `Image target deleted: ${t.tid}`, data: { targetId: t.tid } };
}

async function imageTargetBase64(state, id) {
  const t = await targetFileById(state, id);
  if (t.size > MAX_IMAGE_BYTES) throw new Error('Stored image target too large');
  const buf = await fsp.readFile(t.file);
  return { ...t, base64: buf.toString('base64'), mime: t.ext === '.png' ? 'image/png' : 'image/jpeg' };
}

function regionFields(cmd) {
  return {
    x: intField(cmd.x, 'x'), y: intField(cmd.y, 'y'),
    width: intField(cmd.width, 'width', 1, 10000), height: intField(cmd.height, 'height', 1, 10000)
  };
}

async function screenCaptureRegionAction(state, cmd) {
  const region = regionFields(cmd);
  const maxWidth = Math.min(1600, Math.max(160, Number(cmd.maxWidth ?? Math.min(1280, region.width))));
  const data = await callUiHelper(state, 'screen-capture-region', { ...region, maxWidth }, 30000);
  if (typeof data.base64 !== 'string' || data.base64.length > 760000) throw new Error('Screenshot payload rejected');
  return { status: 'ok', message: `Screen region captured ${data.imageWidth}x${data.imageHeight}`, data };
}

async function findPaintCanvasAction(state) {
  const paintProcess = (await processList()).find((item) => Number(item.MainWindowHandle) !== 0 && isPaintWindow(item));
  if (!paintProcess) throw new Error('Microsoft Paint window not found');
  let windowContext = await inspectWindowContext(state, paintProcess);
  if (windowContext.state.minimized) {
    const focused = await focusWindowHandle(state, windowContext.hwnd);
    await sleep(250);
    windowContext = await inspectWindowContext(state, paintProcess);
    if (!focused?.focused || windowContext.state.minimized) throw new Error('Paint window restore failed');
  }

  let uiElements = [];
  try {
    const tree = await callUiHelper(state, 'inspect-ui-tree', { hwnd: windowContext.hwnd }, 20000);
    uiElements = tree.elements ?? [];
  } catch {}
  let visualObservation = null;
  try {
    const b = windowContext.clientBounds;
    visualObservation = await callUiHelper(state, 'find-bright-region', { x: b.x, y: b.y, width: b.width, height: b.height }, 30000);
    visualObservation.detector = 'paint-client-bright-region';
  } catch {}
  const fusion = resolvePaintCanvas({ windowContext, uiElements, visualObservation });
  if (!fusion.canvasFound || !fusion.bounds) {
    const error = new Error('Paint canvas refused: insufficient perception confidence');
    error.code = 'INSUFFICIENT_CONFIDENCE';
    error.details = fusion;
    throw error;
  }
  const data = {
    ...fusion.bounds,
    canvasFound: true,
    method: fusion.method,
    confidence: fusion.confidence,
    evidence: fusion.evidenceDetails,
    windowContext
  };
  return { status: 'ok', message: `Paint canvas validated ${data.width}x${data.height} (${Math.round(data.confidence * 100)}%)`, data };
}


async function sampleCanvasPixelAction(state, cmd) {
  const x = intField(cmd.x, 'x'); const y = intField(cmd.y, 'y');
  const data = await callUiHelper(state, 'sample-pixel', { x, y }, 12000);
  return { status: 'ok', message: `Pixel ${x},${y} = ${data.hex}`, data };
}

async function clipboardSetTargetAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const width = cmd.width == null ? 0 : intField(cmd.width, 'width', 1, 4096);
  const height = cmd.height == null ? 0 : intField(cmd.height, 'height', 1, 4096);
  const data = await callUiHelper(state, 'clipboard-set-image', { base64: t.base64, width, height }, 45000);
  return { status: 'ok', message: `Target ${t.tid} copied to image clipboard`, data: { targetId: t.tid, ...data } };
}

async function paintRenderTargetAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const width = cmd.width == null ? 0 : intField(cmd.width, 'width', 1, 4096);
  const height = cmd.height == null ? 0 : intField(cmd.height, 'height', 1, 4096);
  const data = await callUiHelper(state, 'paint-render-image', { base64: t.base64, width, height }, 60000);
  return { status: 'ok', message: `Target ${t.tid} pasted into foreground app`, data: { targetId: t.tid, ...data } };
}


async function paintCorrectTargetAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const region = regionFields(cmd);
  const minScore = Math.max(0, Math.min(1, Number(cmd.minScore ?? 0.985)));
  const before = await callUiHelper(state, 'compare-image-region', { base64: t.base64, ...region }, 60000);
  if (Number(before.matchScore ?? 0) >= minScore) {
    return { status: 'ok', message: `Canvas already matches target ${(Number(before.matchScore)*100).toFixed(1)}%`, data: { targetId: t.tid, corrected: false, before } };
  }
  const width = cmd.renderWidth == null ? region.width : intField(cmd.renderWidth, 'renderWidth', 1, 4096);
  const height = cmd.renderHeight == null ? region.height : intField(cmd.renderHeight, 'renderHeight', 1, 4096);
  const paste = await callUiHelper(state, 'paint-render-image', { base64: t.base64, width, height }, 60000);
  await sleep(700);
  let after = null;
  try { after = await callUiHelper(state, 'compare-image-region', { base64: t.base64, ...region }, 60000); } catch {}
  return { status: 'ok', message: `Canvas correction applied`, data: { targetId: t.tid, corrected: true, before, after, paste } };
}

async function mouseRenderTargetAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const region = regionFields(cmd);
  const threshold = intField(cmd.threshold ?? 128, 'threshold', 0, 255);
  const sampleStep = intField(cmd.sampleStep ?? 3, 'sampleStep', 1, 16);
  const maxRuns = intField(cmd.maxRuns ?? 5000, 'maxRuns', 1, 12000);
  const data = await callUiHelper(state, 'mouse-render-line-art', { base64: t.base64, ...region, threshold, sampleStep, maxRuns }, 180000);
  return { status: 'ok', message: `Mouse line-art render complete (${data.runs} runs)`, data: { targetId: t.tid, ...data } };
}

async function compareTargetRegionAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const region = regionFields(cmd);
  const data = await callUiHelper(state, 'compare-image-region', { base64: t.base64, ...region }, 60000);
  return { status: 'ok', message: `Target comparison score ${(Number(data.matchScore ?? 0) * 100).toFixed(1)}%`, data: { targetId: t.tid, ...data } };
}

async function mouseMoveAction(state, cmd) {
  const x = intField(cmd.x, 'x'); const y = intField(cmd.y, 'y');
  const durationMs = Math.min(5000, Math.max(0, Number(cmd.durationMs ?? 350)));
  const data = await callUiHelper(state, 'mouse-move', { x, y, durationMs }, 12000);
  return { status: 'ok', message: `Mouse moved to ${data.x},${data.y}`, data };
}

async function mouseClickAction(state, cmd) {
  const x = intField(cmd.x, 'x'); const y = intField(cmd.y, 'y');
  const button = String(cmd.button ?? 'left').toLowerCase();
  if (!['left','right','middle'].includes(button)) throw new Error('Unsupported mouse button');
  const clicks = Math.min(3, Math.max(1, intField(cmd.clicks ?? 1, 'clicks', 1, 3)));
  const data = await callUiHelper(state, 'mouse-click', { x, y, button, clicks }, 12000);
  return { status: 'ok', message: `${button} click at ${x},${y}`, data };
}

async function mouseDragAction(state, cmd) {
  if (!Array.isArray(cmd.points) || cmd.points.length < 2 || cmd.points.length > 2000) throw new Error('mouse-drag requires 2..2000 points');
  const points = cmd.points.map((p) => ({ x: intField(p?.x, 'point.x'), y: intField(p?.y, 'point.y') }));
  const button = String(cmd.button ?? 'left').toLowerCase();
  if (!['left','right','middle'].includes(button)) throw new Error('Unsupported mouse button');
  const durationMs = Math.min(30000, Math.max(50, Number(cmd.durationMs ?? Math.max(120, points.length * 12))));
  const data = await callUiHelper(state, 'mouse-drag', { points, button, durationMs }, durationMs + 10000);
  return { status: 'ok', message: `Mouse drag complete (${points.length} points)`, data };
}

async function mouseScrollAction(state, cmd) {
  const x = intField(cmd.x, 'x'); const y = intField(cmd.y, 'y');
  const delta = intField(cmd.delta, 'delta', -7200, 7200);
  const data = await callUiHelper(state, 'mouse-scroll', { x, y, delta }, 12000);
  return { status: 'ok', message: `Mouse scrolled ${delta} at ${x},${y}`, data };
}

async function typeTextAction(state, cmd) {
  const text = String(cmd.text ?? '');
  if (!text || text.length > 4000) throw new Error('Invalid text length');
  const data = await callUiHelper(state, 'type-text', { text }, 20000);
  return { status: 'ok', message: `Typed ${data.chars} characters`, data };
}

async function keyPressAction(state, cmd) {
  const key = String(cmd.key ?? '').trim();
  if (!key || key.length > 16) throw new Error('Invalid key');
  const data = await callUiHelper(state, 'key-press', { key, ctrl: !!cmd.ctrl, shift: !!cmd.shift, alt: !!cmd.alt }, 12000);
  return { status: 'ok', message: `Key pressed: ${[cmd.ctrl?'Ctrl':'',cmd.shift?'Shift':'',cmd.alt?'Alt':'',key].filter(Boolean).join('+')}`, data };
}

async function confirmWindows(title, text) {
  if (!IS_WIN) return false;
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$r=[System.Windows.Forms.MessageBox]::Show($env:CLB_CONFIRM_TEXT,$env:CLB_CONFIRM_TITLE,[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning);',
    'if($r -eq [System.Windows.Forms.DialogResult]::Yes){Write-Output YES}else{Write-Output NO}'
  ].join(' ');
  const env = { ...process.env, CLB_CONFIRM_TITLE: title, CLB_CONFIRM_TEXT: text };
  const r = await runCaptured('powershell.exe', ['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], { env, timeoutMs: 120000 });
  return r.code === 0 && /YES/.test(r.stdout);
}

async function deleteFileAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const rel = String(cmd.relativePath ?? cmd.path ?? '');
  const p = await resolveInside(root, rel);
  if (!await confirmWindows('ChatGPT Local Bridge', `Autoriser la suppression de :\n${p}`)) throw new Error('User declined deletion');
  const st = await fsp.lstat(p);
  if (st.isDirectory()) throw new Error('delete-file only accepts files');
  await fsp.unlink(p);
  return { status: 'ok', message: `Deleted ${rel}` };
}

async function gitAction(state, cmd, kind) {
  const { root } = workspaceRoot(state, cmd);
  let args;
  if (kind === 'status') args = ['-C', root, 'status', '--short', '--branch', '--untracked-files=normal'];
  else if (kind === 'diff') args = ['-C', root, 'diff', '--no-ext-diff', '--'];
  else if (kind === 'log') args = ['-C', root, 'log', '--oneline', '--decorate', '-n', String(Math.min(50, Math.max(1, Number(cmd.count ?? 20))))];
  else throw new Error('Unknown git action');
  const r = await runCaptured(gitExecutable(), args, { cwd: root, timeoutMs: 30000 });
  if (r.timedOut) return { status: 'error', message: `git-${kind} timed out`, outputTail: truncate(r.stderr || r.stdout) };
  if (r.code !== 0) return { status: 'error', message: `git-${kind} failed (${r.code ?? 'no-code'})`, outputTail: truncate(r.stderr || r.stdout) };
  return { status: 'ok', message: `git-${kind} complete`, outputTail: truncate(r.stdout) };
}

async function gitCommitAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const message = String(cmd.message ?? '').trim();
  if (!message || message.length > 500) throw new Error('Invalid commit message');
  if (!await confirmWindows('ChatGPT Local Bridge', `Autoriser un commit Git dans :\n${root}\n\nMessage :\n${message}`)) throw new Error('User declined git commit');
  if (cmd.stageAll !== false) {
    const add = await runCaptured(gitExecutable(), ['-C', root, 'add', '-A'], { timeoutMs: 30000 });
    if (add.code !== 0) return { status: 'error', message: 'git add failed', outputTail: truncate(add.stderr || add.stdout) };
  }
  const r = await runCaptured(gitExecutable(), ['-C', root, 'commit', '-m', message], { timeoutMs: 60000 });
  return r.code === 0
    ? { status: 'ok', message: 'Git commit created', outputTail: truncate(r.stdout) }
    : { status: 'error', message: `git commit failed (${r.code ?? 'no-code'})`, outputTail: truncate(r.stderr || r.stdout) };
}

async function npmScriptAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const packageDirRel = String(cmd.packageDir ?? '.');
  const packageDir = await resolveInside(root, packageDirRel, { allowRoot: true });
  const pkgPath = path.join(packageDir, 'package.json');
  const pkg = JSON.parse(await readSmallText(pkgPath));
  const script = String(cmd.script ?? '');
  if (!script || !pkg.scripts || typeof pkg.scripts[script] !== 'string') throw new Error(`npm script not found: ${script}`);
  const r = await runCaptured(npmExecutable(), ['run', script], { cwd: packageDir, timeoutMs: Math.min(20 * 60 * 1000, Math.max(10000, Number(cmd.timeoutMs ?? 10 * 60 * 1000))) });
  return r.code === 0
    ? { status: 'ok', message: `npm run ${script} succeeded`, outputTail: truncate((r.stdout + '\n' + r.stderr).trim()) }
    : { status: 'error', message: `npm run ${script} failed (${r.code ?? 'no-code'}${r.timedOut ? ', timeout' : ''})`, outputTail: truncate((r.stdout + '\n' + r.stderr).trim()) };
}

async function runTaskAction(state, cmd) {
  const task = String(cmd.task ?? cmd.name ?? '');
  if (!['typecheck','test','build','check'].includes(task)) throw new Error('Unsupported task');
  return await npmScriptAction(state, { ...cmd, script: task, packageDir: cmd.packageDir ?? '.' });
}

async function processList() {
  if (!IS_WIN) return [];
  const ps = "Get-Process | Select-Object Id,ProcessName,MainWindowHandle,MainWindowTitle | ConvertTo-Json -Compress";
  const r = await runCaptured('powershell.exe', ['-NoLogo','-NoProfile','-Command', ps], { timeoutMs: 20000 });
  if (r.code !== 0) throw new Error(truncate(r.stderr || r.stdout, 4000));
  if (!r.stdout.trim()) return [];
  const v = JSON.parse(r.stdout.trim());
  return Array.isArray(v) ? v : [v];
}

async function listProcessesAction() {
  const items = await processList();
  return { status: 'ok', message: `${items.length} processes`, data: items.slice(0, 1000) };
}

async function listWindowsAction(state) {
  const items = (await processList()).filter((p) => Number(p.MainWindowHandle) !== 0 || String(p.MainWindowTitle ?? '').trim());
  const contexts = await Promise.all(items.slice(0, 200).map(async (item) => {
    try { return await inspectWindowContext(state, item); }
    catch { return { hwnd: Number(item.MainWindowHandle), pid: Number(item.Id), process: item.ProcessName, title: item.MainWindowTitle, confidence: 0.45 }; }
  }));
  return { status: 'ok', message: `${contexts.length} windows`, data: contexts };
}

function allowedLaunchTarget(target) {
  if (!target || typeof target !== 'string') return false;
  const t = target.trim();
  if (!t || t.startsWith('\\\\')) return false;
  const ext = path.extname(t).toLowerCase();
  if (BLOCKED_TARGET_EXTENSIONS.has(ext)) return false;
  const base = path.basename(t).toLowerCase();
  if (BLOCKED_EXECUTABLES.has(base)) return false;
  if (!['.exe','.com'].includes(ext)) return false;
  if (IS_WIN && !path.win32.isAbsolute(t)) return false;
  try { if (IS_WIN && !fs.statSync(t).isFile()) return false; } catch { if (IS_WIN) return false; }
  return true;
}


async function discoverAppsWindows() {
  if (!IS_WIN) return [];
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$items=@()
Get-StartApps | ForEach-Object { if($_.Name -and $_.AppID){ $items += [pscustomobject]@{name=[string]$_.Name;kind='uwp';appId=[string]$_.AppID;shortcutPath='';target='';url=''} } }
$shell=New-Object -ComObject WScript.Shell
$roots=@("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs","$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs","$env:USERPROFILE\\Desktop")
foreach($root in $roots){
  if(Test-Path -LiteralPath $root){
    Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.lnk | ForEach-Object {
      $s=$shell.CreateShortcut($_.FullName)
      $items += [pscustomobject]@{name=[IO.Path]::GetFileNameWithoutExtension($_.Name);kind='shortcut';appId='';shortcutPath=[string]$_.FullName;target=[string]$s.TargetPath;url=''}
    }
    Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.url | ForEach-Object {
      $u=''; Get-Content -LiteralPath $_.FullName | ForEach-Object { if($_ -match '^URL=(.+)$'){ $u=$Matches[1] } }
      if($u){ $items += [pscustomobject]@{name=[IO.Path]::GetFileNameWithoutExtension($_.Name);kind='url';appId='';shortcutPath=[string]$_.FullName;target='';url=[string]$u} }
    }
  }
}
$keys=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*')
foreach($k in $keys){ Get-ItemProperty $k | ForEach-Object { if($_.'(default)'){ $items += [pscustomobject]@{name=[IO.Path]::GetFileNameWithoutExtension($_.PSChildName);kind='app-path';appId='';shortcutPath='';target=[string]$_.'(default)';url=''} } } }
$items | ConvertTo-Json -Compress -Depth 4
`;
  const r = await runCaptured('powershell.exe', ['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], { timeoutMs: 45000 });
  if (r.code !== 0) throw new Error(`App discovery failed: ${truncate(r.stderr || r.stdout, 4000)}`);
  let arr = [];
  if (r.stdout.trim()) {
    const v = JSON.parse(r.stdout.trim());
    arr = Array.isArray(v) ? v : [v];
  }
  const seen = new Set();
  const out = [];
  for (const a of arr) {
    const name = String(a.name ?? '').trim();
    if (!name) continue;
    if ((a.kind === 'shortcut' || a.kind === 'app-path') && !allowedLaunchTarget(String(a.target ?? ''))) continue;
    if (a.kind === 'url') {
      let scheme = ''; try { scheme = new URL(String(a.url)).protocol.toLowerCase(); } catch { continue; }
      if (!SAFE_URL_SCHEMES.has(scheme)) continue;
    }
    const key = `${name.toLowerCase()}|${a.kind}|${String(a.target ?? a.appId ?? a.url ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind: a.kind, appId: a.appId || '', shortcutPath: a.shortcutPath || '', target: a.target || '', url: a.url || '' });
  }
  out.sort((a,b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

function resolveAppByName(apps, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) throw new Error('Missing app name');
  const exact = apps.filter((a) => a.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Windows often exposes the same GUI app twice (for example through
    // Get-StartApps and a Start Menu shortcut). For an exact same-name
    // duplicate, prefer the most concrete, locally validated launch route.
    const priority = { shortcut: 0, 'app-path': 1, uwp: 2, url: 3 };
    return [...exact].sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99))[0];
  }
  const partial = apps.filter((a) => a.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (!partial.length) throw new Error(`App not found: ${query}`);
  const distinctNames = [...new Set(partial.map((a) => a.name.toLowerCase()))];
  if (distinctNames.length === 1) {
    const priority = { shortcut: 0, 'app-path': 1, uwp: 2, url: 3 };
    return [...partial].sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99))[0];
  }
  throw new Error(`Ambiguous app name: ${query} (${partial.slice(0,10).map((a)=>a.name).join(', ')})`);
}

async function getApps(state, force = false) {
  if (!force && state.appCache && Date.now() - state.appCacheAt < 5 * 60 * 1000) return state.appCache;
  state.appCache = await discoverAppsWindows();
  state.appCacheAt = Date.now();
  return state.appCache;
}

async function listAppsAction(state) {
  const apps = await getApps(state, true);
  return { status: 'ok', message: `${apps.length} apps discovered`, data: apps.map((a) => ({ name: a.name, kind: a.kind, target: a.target ? path.basename(a.target) : '', appId: a.appId })) };
}

async function launchAppAction(state, cmd) {
  const apps = await getApps(state, false);
  const app = resolveAppByName(apps, cmd.name ?? cmd.app ?? '');
  let pid = null;
  if (app.kind === 'uwp') pid = runDetached('explorer.exe', [`shell:AppsFolder\\${app.appId}`]);
  else if (app.kind === 'shortcut') {
    if (!allowedLaunchTarget(app.target)) throw new Error('Blocked launch target');
    pid = runDetached('explorer.exe', [app.shortcutPath]);
  } else if (app.kind === 'app-path') {
    if (!allowedLaunchTarget(app.target)) throw new Error('Blocked launch target');
    pid = runDetached(app.target, [], { cwd: path.dirname(app.target) });
  } else if (app.kind === 'url') {
    const scheme = new URL(app.url).protocol.toLowerCase();
    if (!SAFE_URL_SCHEMES.has(scheme)) throw new Error('Blocked URL scheme');
    pid = runDetached('explorer.exe', [app.url]);
  } else throw new Error('Unsupported app kind');
  return { status: 'ok', message: `Launch requested: ${app.name}`, data: { name: app.name, kind: app.kind, pid } };
}

async function stopProcessAction(state, cmd) {
  const pid = Number(cmd.pid);
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) throw new Error('Invalid PID');
  if (!await confirmWindows('ChatGPT Local Bridge', `Autoriser l'arrêt du processus PID ${pid} ?`)) throw new Error('User declined process stop');
  if (IS_WIN) {
    const args = ['/PID', String(pid), '/T']; if (cmd.force) args.push('/F');
    const r = await runCaptured('taskkill.exe', args, { timeoutMs: 30000 });
    return r.code === 0 ? { status: 'ok', message: `Stopped PID ${pid}`, outputTail: truncate(r.stdout) } : { status: 'error', message: `taskkill failed (${r.code})`, outputTail: truncate(r.stderr || r.stdout) };
  }
  process.kill(pid, cmd.force ? 'SIGKILL' : 'SIGTERM');
  return { status: 'ok', message: `Stopped PID ${pid}` };
}

async function pcStatusAction(state) {
  let windows = [];
  if (IS_WIN) { try { windows = (await processList()).filter((p) => Number(p.MainWindowHandle) !== 0 || String(p.MainWindowTitle ?? '').trim()); } catch {} }
  return {
    status: 'ok', message: 'PC status collected', data: {
      hostName: os.hostname(), userName: os.userInfo().username, platform: process.platform, release: os.release(), arch: process.arch,
      node: process.version, uptimeSeconds: Math.round(os.uptime()), freeMemory: os.freemem(), totalMemory: os.totalmem(),
      bridgePid: process.pid, visibleWindows: windows.slice(0,200)
    }
  };
}

async function executeCommand(state, cmd) {
  switch (cmd.action) {
    case 'pc-status': case 'status': return await pcStatusAction(state);
    case 'list-workspaces': return { status: 'ok', message: 'Workspaces listed', data: state.config.allowedRoots };
    case 'list-dir': return await listDirAction(state, cmd);
    case 'search-text': return await searchTextAction(state, cmd);
    case 'read-file': return await readFileAction(state, cmd);
    case 'write-file': return await writeFileAction(state, cmd);
    case 'mkdir': return await mkdirAction(state, cmd);
    case 'copy-file': return await copyMoveAction(state, cmd, false);
    case 'move-file': return await copyMoveAction(state, cmd, true);
    case 'delete-file': return await deleteFileAction(state, cmd);
    case 'list-processes': return await listProcessesAction(state, cmd);
    case 'list-windows': return await listWindowsAction(state, cmd);
    case 'list-apps': return await listAppsAction(state, cmd);
    case 'launch-app': return await launchAppAction(state, cmd);
    case 'stop-process': return await stopProcessAction(state, cmd);
    case 'screen-info': return await screenInfoAction(state, cmd);
    case 'screen-capture': return await screenCaptureAction(state, cmd);
    case 'screen-capture-region': return await screenCaptureRegionAction(state, cmd);
    case 'sample-canvas-pixel': return await sampleCanvasPixelAction(state, cmd);
    case 'find-paint-canvas': return await findPaintCanvasAction(state, cmd);
    case 'draw-in-paint': return await drawInPaintAction(state, cmd);
    case 'paint-job-status': return await paintJobStatusAction(state, cmd);
    case 'paint-job-control': return await paintJobControlAction(state, cmd);
    case 'renderer-info': return await rendererInfoAction(state, cmd);
    case 'watch-notification': return await watchNotificationAction(state, cmd);
    case 'watch-teams-sender': return await watchTeamsSenderAction(state, cmd);
    case 'list-watches': return await listWatchesAction(state, cmd);
    case 'stop-watch': return await stopWatchAction(state, cmd);
    case 'test-alarm': return await testAlarmAction(state, cmd);
    case 'image-target-create': return await imageTargetCreateAction(state, cmd);
    case 'image-target-info': return await imageTargetInfoAction(state, cmd);
    case 'image-target-delete': return await imageTargetDeleteAction(state, cmd);
    case 'clipboard-set-target': return await clipboardSetTargetAction(state, cmd);
    case 'paint-render-target': return await paintRenderTargetAction(state, cmd);
    case 'paint-correct-target': return await paintCorrectTargetAction(state, cmd);
    case 'mouse-render-target': return await mouseRenderTargetAction(state, cmd);
    case 'compare-target-region': return await compareTargetRegionAction(state, cmd);
    case 'mouse-move': return await mouseMoveAction(state, cmd);
    case 'mouse-click': return await mouseClickAction(state, cmd);
    case 'mouse-drag': return await mouseDragAction(state, cmd);
    case 'mouse-scroll': return await mouseScrollAction(state, cmd);
    case 'type-text': return await typeTextAction(state, cmd);
    case 'key-press': return await keyPressAction(state, cmd);
    case 'run-task': return await runTaskAction(state, cmd);
    case 'npm-script': return await npmScriptAction(state, cmd);
    case 'git-status': return await gitAction(state, cmd, 'status');
    case 'git-diff': return await gitAction(state, cmd, 'diff');
    case 'git-log': return await gitAction(state, cmd, 'log');
    case 'git-commit': return await gitCommitAction(state, cmd);
    default: throw new Error(`Unsupported action: ${cmd.action}`);
  }
}

async function appendAudit(state, entry) {
  try {
    const line = JSON.stringify({ at: nowIso(), ...entry }) + '\n';
    await fsp.appendFile(state.auditPath, line, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

async function handleCommand(state, cmd) {
  const startedAt = nowIso();
  let result;
  try { result = await executeCommand(state, cmd); }
  catch (e) { result = { status: 'error', message: String(e?.message ?? e), outputTail: truncate(e?.stack ?? '', 12000) }; }
  const completedAt = nowIso();
  if (!result.actionModel) {
    const executed = result.status === 'ok';
    const goalReached = executed && !GUI_DISPATCH_ACTIONS.has(cmd.action);
    result.actionModel = createActionRecord({
      id: cmd.id, goal: cmd.goal ?? cmd.action,
      preconditions: [{ name: 'authenticated-command-valid', satisfied: true }],
      action: { commandSent: true, executed, resultStatus: result.status },
      expectedResult: cmd.expectedResult ?? { status: 'ok' },
      validation: { validated: goalReached, commandSent: true, actionExecuted: executed, changeObserved: goalReached ? true : null, goalReached, reason: goalReached ? 'goal_reached' : executed ? 'goal_not_independently_observed' : 'action_failed' },
      metrics: { startedAt, completedAt, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) }
    });
  }
  state.lastCommand = {
    id: cmd.id, action: cmd.action, workspace: cmd.workspace ?? cmd.root ?? '', startedAt, completedAt, ...result
  };
  console.log(`[${nowIso()}] ${cmd.id} ${cmd.action} -> ${result.status}: ${result.message}`);
  await appendAudit(state, { id: cmd.id, action: cmd.action, workspace: cmd.workspace ?? cmd.root ?? '', status: result.status, message: result.message });
  try { await publish(state, { forceStatus: true, reason: `command ${cmd.id}` }); }
  catch (e) { console.error(`[${nowIso()}] telemetry publish failed after command:`, e.message); }
}

async function pollOnce(state) {
  const file = await githubGetFile(state.gh, state.config.relayRepo, state.config.relayPath, state.config.relayBranch);
  if (!file.exists || !file.text.trim()) return;
  let cmd;
  try { cmd = JSON.parse(file.text); } catch { return; }
  if (cmd?.protocol !== PROTOCOL) return;
  if (state.processedIds.has(cmd.id)) return;
  try { validateCommand(cmd, state); }
  catch (e) {
    if (cmd?.sessionId === state.sessionId && cmd?.id && !state.processedIds.has(cmd.id)) {
      state.processedIds.add(cmd.id);
      state.lastCommand = { id: cmd.id, action: cmd.action ?? '', status: 'rejected', message: String(e.message), completedAt: nowIso() };
      await appendAudit(state, { id: cmd.id, action: cmd.action ?? '', workspace: cmd.workspace ?? cmd.root ?? '', status: 'rejected', message: String(e.message) });
      try { await publish(state, { forceStatus: true, reason: `rejected ${cmd.id}` }); } catch {}
    }
    return;
  }
  state.processedIds.add(cmd.id);
  while (state.processedIds.size > 500) state.processedIds.delete(state.processedIds.values().next().value);
  await handleCommand(state, cmd);
}

async function preflight(state) {
  const v = await runCaptured(state.gh, ['--version'], { timeoutMs: 15000 });
  if (v.code !== 0) throw new Error(`GitHub CLI unavailable: ${truncate(v.stderr || v.error || v.stdout, 2000)}`);
  const auth = await runCaptured(state.gh, ['auth','status','--hostname','github.com'], { timeoutMs: 20000 });
  if (auth.code !== 0) throw new Error(`GitHub CLI not authenticated: ${truncate(auth.stderr || auth.stdout, 3000)}`);
  // Verify command relay is readable and telemetry repo is reachable before entering loop.
  await githubGetFile(state.gh, state.config.relayRepo, state.config.relayPath, state.config.relayBranch);
  await githubGetFile(state.gh, state.config.telemetryRepo, state.config.sessionPath, state.config.telemetryBranch);
  if (IS_WIN) await startUiHelper(state);
}

async function mainLoop(state) {
  await publish(state, { forceStatus: true, reason: 'startup' });
  console.log(`\n=== CHATGPT LOCAL BRIDGE V${VERSION} READY ===`);
  console.log(`Agent version: ${VERSION}`);
  console.log(`Protocol: ${PROTOCOL}`);
  console.log(`Session publique: ${state.config.telemetryRepo}/${state.config.sessionPath}`);
  console.log(`Commande: ${state.config.relayRepo}/${state.config.relayPath}`);
  console.log(`Workspaces: ${Object.keys(state.config.allowedRoots).join(', ')}`);
  console.log(`PID: ${process.pid}`);
  console.log(`Keep this window open.\n`);

  while (!state.stopping) {
    try { await pollOnce(state); }
    catch (e) { console.error(`[${nowIso()}] poll error: ${truncate(e?.message ?? e, 3000)}`); }
    if (Date.now() - state.lastPublishedAt >= Number(state.config.heartbeatMs ?? HEARTBEAT_MS)) {
      try { await publish(state, { forceStatus: false, reason: 'heartbeat' }); }
      catch (e) { console.error(`[${nowIso()}] heartbeat error: ${truncate(e?.message ?? e, 3000)}`); }
    }
    await sleep(Number(state.config.pollMs ?? POLL_MS));
  }
}

async function runSelfTest() {
  const errors = [];
  const ok = (cond, name) => { if (!cond) errors.push(name); };
  const key = crypto.randomBytes(32);
  const sample = { hello: 'world', n: 42, nested: { ok: true } };
  try {
    const enc = encryptTelemetry(sample, key);
    ok(JSON.stringify(decryptTelemetryForSelfTest(enc, key)) === JSON.stringify(sample), 'telemetry roundtrip');
  } catch { errors.push('telemetry roundtrip threw'); }

  try {
    const resolvedDuplicate = resolveAppByName([
      { name: 'Rayman Origins', kind: 'uwp', appId: 'rayman.uwp' },
      { name: 'Rayman Origins', kind: 'shortcut', target: 'C:\\Games\\Rayman\\Rayman.exe' }
    ], 'Rayman');
    ok(resolvedDuplicate.kind === 'shortcut', 'duplicate app resolution prefers validated shortcut');
    try {
      resolveAppByName([{ name: 'Rayman Origins', kind: 'shortcut' }, { name: 'Rayman Legends', kind: 'shortcut' }], 'Rayman');
      errors.push('distinct-name ambiguity accepted');
    } catch {}
  } catch { errors.push('duplicate app resolution threw'); }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'clb-v15-test-'));
  const root = path.join(tmp, 'root');
  await fsp.mkdir(root);
  await fsp.writeFile(path.join(root, 'a.txt'), 'hello bridge\n', 'utf8');
  try { ok((await resolveInside(root, 'a.txt')).endsWith('a.txt'), 'resolve inside'); } catch { errors.push('resolve inside threw'); }
  try { await resolveInside(root, '../escape.txt'); errors.push('path escape accepted'); } catch {}

  try {
    const state = { config: { allowedRoots: { test: root } } };
    const rr = await readFileAction(state, { workspace: 'test', relativePath: 'a.txt' });
    ok(rr.status === 'ok' && rr.data.text.includes('hello bridge'), 'read file');
    const wr = await writeFileAction(state, { workspace: 'test', relativePath: 'b.txt', text: 'ok' });
    ok(wr.status === 'ok' && (await fsp.readFile(path.join(root,'b.txt'),'utf8')) === 'ok', 'write file');
  } catch { errors.push('file actions threw'); }

  try {
    const r = await runCaptured(gitExecutable(), ['-C', root, 'status', '--short', '--branch'], { timeoutMs: 10000 });
    ok(typeof r.code === 'number' || r.error || r.code === null, 'git non-repo containment');
  } catch { errors.push('git containment threw'); }

  try {
    const apps = [{name:'Rayman Legends',kind:'shortcut'},{name:'Discord',kind:'shortcut'}];
    ok(resolveAppByName(apps,'rayman').name === 'Rayman Legends', 'app partial match');
    ok(resolveAppByName(apps,'Discord').name === 'Discord', 'app exact match');
  } catch { errors.push('app resolution threw'); }

  try {
    const fake = { sessionId: 'abc' };
    validateCommand({protocol:PROTOCOL,id:'x1',action:'status',sessionId:'abc',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}, fake);
  } catch { errors.push('valid command rejected'); }
  try {
    const fake = { sessionId: 'abc' };
    validateCommand({protocol:PROTOCOL,id:'x2',action:'status',sessionId:'abc',issuedAt:new Date(Date.now()-120000).toISOString(),expiresAt:new Date(Date.now()-60000).toISOString()}, fake);
    errors.push('expired command accepted');
  } catch {}

  try {
    ok(validateSafeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>').startsWith('<svg'), 'safe svg accepted');
    try { validateSafeSvg('<svg><script>alert(1)</script></svg>'); errors.push('active svg accepted'); } catch {}
  } catch { errors.push('svg validation threw'); }

  try {
    const onePxPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9WQAAAAASUVORK5CYII=';
    const img = decodeImagePayload(onePxPng);
    ok(img.mime === 'image/png' && img.buf.length > 16, 'image payload validation');
    try { decodeImagePayload(Buffer.from('not an image').toString('base64')); errors.push('invalid image payload accepted'); } catch {}
  } catch { errors.push('image payload validation threw'); }

  try {
    const chunk=(name,data)=>{const h=Buffer.alloc(8);h.writeUInt32BE(data.length,0);h.write(name,4,4,'ascii');return Buffer.concat([h,data,Buffer.alloc(4)]);};
    const ih=Buffer.alloc(13);ih.writeUInt32BE(4,0);ih.writeUInt32BE(2,4);ih[8]=8;ih[9]=6;
    const row0=Buffer.from([0,255,255,255,255,237,28,36,255,63,72,204,255,0,0,0,255]);
    const row1=Buffer.from([0,255,255,255,255,255,174,201,255,185,122,87,255,127,127,127,255]);
    const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(Buffer.concat([row0,row1]))),chunk('IEND',Buffer.alloc(0))]);
    const dec=decodePngRgba(png); ok(dec.width===4&&dec.height===2,'png decoder');
    const q=resampleQuantizePng(png,{maxWidth:4,maxHeight:2,paletteProfile:'classic16',smoothPasses:0});
    const gs=rasterSegments(q); ok(q.width===4&&q.height===2&&gs.some(g=>g.segments.length),'raster planner');
    const prof=rasterQualityProfile('ultra'); ok(prof.resolution===320&&prof.palette==='classic16','raster profiles');
  } catch (e) { errors.push('raster planner threw: '+String(e?.message||e)); }

  try {
    ok(intField(42, 'x') === 42, 'ui coordinate validation');
    try { intField(1.5, 'x'); errors.push('fractional UI coordinate accepted'); } catch {}
  } catch { errors.push('ui coordinate validation threw'); }

  try { ok(fs.existsSync(rasterHelperPath()), 'raster helper packaged'); } catch { errors.push('raster helper check threw'); }

  try {
    const lockDir = path.join(tmp, 'lock');
    await fsp.mkdir(lockDir);
    const lock = await acquireSingleInstance(lockDir);
    ok(fs.existsSync(lock.lockPath), 'single instance lock created');
    lock.release();
    ok(!fs.existsSync(lock.lockPath), 'single instance lock released');
  } catch { errors.push('single instance lock threw'); }

  await fsp.rm(tmp, { recursive: true, force: true });
  const report = { ok: errors.length === 0, version: VERSION, protocol: PROTOCOL, platform: process.platform, node: process.version, errors };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

async function main() {
  if (process.argv.includes('--self-test')) return await runSelfTest();
  const dataDir = localAppData();
  const { config, cfgPath } = await loadOrCreateConfig(dataDir);
  const instanceLock = await acquireSingleInstance(dataDir);
  const keyInfo = await loadOrCreateMasterKey(dataDir);
  const state = {
    config,
    cfgPath,
    dataDir,
    masterKey: keyInfo.key,
    gh: ghExecutable(config),
    sessionId: crypto.randomBytes(16).toString('hex'),
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    online: true,
    stopping: false,
    processedIds: new Set(),
    lastCommand: null,
    lastPublishedAt: 0,
    appCache: null,
    appCacheAt: 0,
    auditPath: path.join(dataDir, 'audit.jsonl'),
    instanceLock,
    uiHelper: null
  };

  console.log(`=== ChatGPT Local Bridge V${VERSION} ===`);
  console.log(`Node: ${process.version}`);
  console.log(`Config: ${cfgPath}`);
  console.log(`Local key: ${keyInfo.keyPath}${keyInfo.importedFrom ? ' (imported from previous bridge)' : ''}`);
  console.log(`GitHub CLI: ${state.gh}`);
  console.log(`Workspaces: ${Object.keys(config.allowedRoots).join(', ')}`);
  console.log('Preflight...');
  await preflight(state);
  console.log('Preflight: OK');

  const shutdown = async (sig) => {
    if (state.stopping) return;
    state.stopping = true; state.online = false;
    console.log(`\nStopping (${sig})...`);
    try { await publish(state, { forceStatus: true, reason: 'shutdown' }); } catch {}
    try { if (state.uiHelper?.child) state.uiHelper.child.kill(); } catch {}
  };
  process.on('SIGINT', () => { shutdown('SIGINT').finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').finally(() => process.exit(0)); });
  process.on('uncaughtException', (e) => { console.error('uncaughtException:', e?.stack ?? e); });
  process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', e); });

  await mainLoop(state);
}

export {
  VERSION, PROTOCOL, executeCommand, loadOrCreateConfig, localAppData, appendAudit, startUiHelper, initializePersistentServices, svgToStrokePolylines
};

function isDirectRun() {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\nFATAL:', e?.stack ?? e);
    process.exitCode = 1;
  });
}
