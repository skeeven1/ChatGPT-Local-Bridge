import { BRIDGE_VERSION } from '../../bridge-version.mjs';
export function createBridgeManifest(input = {}) {
  return {
    bridgeVersion: input.bridgeVersion ?? BRIDGE_VERSION,
    apiVersion: input.apiVersion ?? "stable-v1",
    modules: input.modules ?? [],
    capabilities: input.capabilities ?? [],
    generatedAt: new Date().toISOString()
  };
}
