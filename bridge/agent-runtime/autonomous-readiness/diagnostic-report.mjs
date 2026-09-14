import { BRIDGE_VERSION } from '../../bridge-version.mjs';
export function createDiagnosticReport(input = {}) {
  return {
    version: `V${BRIDGE_VERSION}`,
    timestamp: new Date().toISOString(),
    health: input.health ?? "unknown",
    checks: input.checks ?? {},
    problems: input.problems ?? [],
    nextAction: input.nextAction ?? null
  };
}
