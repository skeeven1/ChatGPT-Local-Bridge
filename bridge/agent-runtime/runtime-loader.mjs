import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BRIDGE_VERSION } from '../bridge-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadAgentRuntime(options = {}) {
  const runtimePath = path.resolve(options.runtimePath ?? path.join(here, 'stable-agent-core', 'runtime-bootstrap.mjs'));
  const lockPath = path.resolve(options.lockPath ?? path.join(here, '..', 'core-version-lock.json'));
  const versionPath = path.resolve(options.versionPath ?? path.join(here, '..', 'runtime-version.json'));
  const [lock, versionFile] = await Promise.all([
    fs.readFile(lockPath, 'utf8').then(JSON.parse),
    fs.readFile(versionPath, 'utf8').then(JSON.parse)
  ]);
  const module = await import(pathToFileURL(runtimePath).href);
  if (typeof module.createAgentRuntimeContext !== 'function') throw new Error('runtime_factory_missing');
  const context = module.createAgentRuntimeContext();
  const versions = { bridge: BRIDGE_VERSION, expected: lock.expectedVersion, runtimeFile: versionFile.version, loaded: context.version };
  const compatible = Object.values(versions).every((value) => value === BRIDGE_VERSION);
  if (!compatible || context.coreLoaded !== true) {
    const error = new Error(`runtime_version_mismatch: ${JSON.stringify(versions)}`);
    error.versions = versions;
    throw error;
  }
  return { context, versions, compatible, runtimeUrl: pathToFileURL(runtimePath).href };
}
