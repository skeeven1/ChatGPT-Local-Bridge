import { BRIDGE_VERSION } from "../../bridge-version.mjs";

export function getRuntimeManifest() {
  return {
    version: BRIDGE_VERSION,
    core: "stable-agent-core",
    capabilities: [
      "status",
      "observe",
      "act",
      "validate",
      "recover"
    ]
  };
}
