import { BRIDGE_VERSION } from '../../bridge-version.mjs';

/**
 * V19.8 Runtime Bootstrap
 *
 * Purpose:
 * Explicitly load Stable Agent Core during bridge startup.
 * This file is intentionally isolated so existing V19 routes remain compatible.
 */

export function createAgentRuntimeContext() {
  return {
    version: BRIDGE_VERSION,
    coreLoaded: true,
    apiContract: "stable-v1",
    capabilities: [
      "status",
      "observe",
      "act",
      "validate",
      "recover"
    ],
    startedAt: new Date().toISOString()
  };
}
