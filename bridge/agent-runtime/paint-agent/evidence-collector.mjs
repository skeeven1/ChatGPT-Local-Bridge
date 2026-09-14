// V19.9.11 Paint Evidence Collector
// Collects execution evidence. It never assumes command execution equals success.

export function createBeforeState(context = {}) {
  return {
    timestamp: Date.now(),
    hwnd: context.paintSession?.hwnd ?? null,
    bounds: context.paintSession?.bounds ?? null,
    fingerprint: context.beforeFingerprint ?? null
  };
}

export function createAfterState(context = {}) {
  return {
    timestamp: Date.now(),
    hwnd: context.paintSession?.hwnd ?? null,
    bounds: context.paintSession?.bounds ?? null,
    fingerprint: context.afterFingerprint ?? null
  };
}

export function validateEvidence(before, after, execution = {}) {
  const changed = Boolean(
    before.fingerprint &&
    after.fingerprint &&
    before.fingerprint !== after.fingerprint
  );

  return {
    changed,
    goalReached: changed && execution.executed === true,
    reason: changed ? 'state-changed' : 'no-observable-change'
  };
}
