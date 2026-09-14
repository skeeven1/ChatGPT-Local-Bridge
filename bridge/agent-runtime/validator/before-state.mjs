export async function captureBeforeState(observers = {}) {
  return captureState('before', observers);
}

export async function captureState(phase, observers = {}) {
  const state = { phase, capturedAt: new Date().toISOString() };
  for (const [name, observe] of Object.entries(observers)) {
    try { state[name] = await observe(); }
    catch (error) { state[name] = { error: String(error?.message ?? error) }; }
  }
  return state;
}
