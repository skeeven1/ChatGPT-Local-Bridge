// V19.9.11 Paint Backend Executor
// Execution abstraction. Backends report evidence; no backend may self-declare success.

export async function executePaintBackend(backend, context = {}, handlers = {}) {
  const started = Date.now();
  const preflight = {
    hasContext: Boolean(context),
    hasPaintSession: Boolean(context.paint),
    backendRequested: backend?.id ?? 'unknown'
  };
  try {
    if (backend.id === 'clipboard-image' && handlers.clipboardImage) {
      return normalizeResult(await handlers.clipboardImage({...context, preflight}, meta(backend, started)), backend, started);
    }
    if (backend.id === 'ui-automation' && handlers.uiAutomation) {
      return normalizeResult(await handlers.uiAutomation({...context, preflight}, meta(backend, started)), backend, started);
    }
    if (backend.id === 'win32' && handlers.win32) {
      return normalizeResult(await handlers.win32({...context, preflight}, meta(backend, started)), backend, started);
    }
    if (handlers.rasterFallback) {
      return normalizeResult(await handlers.rasterFallback({...context, preflight}, meta({id:'raster-fallback'}, started)), {id:'raster-fallback'}, started);
    }
    return failure(backend, started, `no-executor-for-${backend?.id ?? 'unknown'}`);
  } catch (error) {
    return failure(backend, started, error?.message || 'backend-error');
  }
}

function meta(backend, started) {
  return { backend: backend.id, startedAt: started };
}

function failure(backend, started, reason) {
  return {
    executed: false,
    backend: backend?.id ?? 'unknown',
    evidence: { changed:false, goalReached:false },
    failure:{ reason },
    durationMs: Date.now()-started
  };
}

function normalizeResult(result, backend, started) {
  return {
    ...result,
    executed: result?.executed === true,
    backend: result?.backend ?? backend.id,
    evidence: result?.evidence ?? { changed:false, goalReached:false },
    durationMs: result?.durationMs ?? (Date.now()-started)
  };
}
