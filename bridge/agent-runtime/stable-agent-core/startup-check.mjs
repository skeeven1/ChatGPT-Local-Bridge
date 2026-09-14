export async function runStartupChecks(checks = {}) {
  const results = {};

  for (const [name, fn] of Object.entries(checks)) {
    try {
      results[name] = Boolean(await fn());
    } catch {
      results[name] = false;
    }
  }

  return {
    ready: Object.values(results).every(Boolean),
    checks: results
  };
}
