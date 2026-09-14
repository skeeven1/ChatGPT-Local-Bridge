// V19.9.19 Paint Windows backend adapters
// Adapters expose execution hooks but do not claim success without evidence.

export function createWindowsPaintAdapters(deps = {}) {
  return {
    async clipboardImage(context, meta) {
      if (typeof deps.clipboardPaste !== 'function') {
        return fail('clipboard-image', 'clipboard-runtime-missing');
      }
      const before = context?.evidence?.before ?? null;
      const action = await deps.clipboardPaste({ context, meta });
      const after = typeof deps.capturePaintState === 'function'
        ? await deps.capturePaintState(context)
        : null;
      return {
        executed: action?.executed === true,
        backend: 'clipboard-image',
        evidence: compare(before, after),
        action
      };
    },
    async rasterFallback(context, meta) {
      if (typeof deps.rasterJob !== 'function') {
        return fail('raster-fallback', 'raster-runtime-missing');
      }
      const before = context?.evidence?.before ?? null;
      const action = await deps.rasterJob({ context, meta });
      const after = typeof deps.capturePaintState === 'function'
        ? await deps.capturePaintState(context)
        : null;
      return {
        executed: action?.executed === true,
        backend: 'raster-fallback',
        evidence: compare(before, after),
        action
      };
    }
  };
}

function compare(before, after) {
  const changed = Boolean(before && after && JSON.stringify(before) !== JSON.stringify(after));
  return { changed, goalReached: changed };
}

function fail(backend, reason) {
  return {
    executed:false,
    backend,
    evidence:{changed:false, goalReached:false},
    failure:{reason}
  };
}
