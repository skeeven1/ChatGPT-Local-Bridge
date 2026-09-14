export function createReadinessState() {
  return {
    state: "booting",
    ready: false,
    checks: {
      server: false,
      tunnel: false,
      pcStatus: false,
      gui: false
    },
    updatedAt: new Date().toISOString()
  };
}

export function isReady(status) {
  return Boolean(
    status &&
    status.checks &&
    Object.values(status.checks).every(Boolean)
  );
}
