import assert from 'node:assert/strict';
import { loadAgentRuntime } from '../bridge/agent-runtime/runtime-loader.mjs';
import { BRIDGE_VERSION } from '../bridge/bridge-version.mjs';

const runtime = await loadAgentRuntime();
assert.equal(runtime.context.coreLoaded, true);
assert.equal(runtime.context.version, BRIDGE_VERSION);
assert.equal(runtime.compatible, true);
assert.match(runtime.runtimeUrl, /^file:\/\//);

console.log(`Agent Runtime loaded ${runtime.context.version}`);
console.log('Version compatible');
console.log('Bridge ready');
