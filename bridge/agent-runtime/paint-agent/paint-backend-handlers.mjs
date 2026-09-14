// V19.9.18 Paint backend handler registry
// Real OS adapters can be injected by the bridge runtime.
// Handlers never report success without evidence.


export function getAvailablePaintBackends(runtime = {}) {
  return {
    "clipboard-image": typeof runtime.clipboardImage === 'function',
    "ui-automation": typeof runtime.uiAutomation === 'function',
    "win32": typeof runtime.win32 === 'function',
    "raster-fallback": typeof runtime.rasterFallback === 'function'
  };
}

export function createPaintBackendHandlers(runtime = {}) {
  return {
    clipboardImage: async (context, meta) => runtime.clipboardImage
      ? runtime.clipboardImage(context, meta)
      : unavailable("clipboard-image"),
    uiAutomation: async (context, meta) => runtime.uiAutomation
      ? runtime.uiAutomation(context, meta)
      : unavailable("ui-automation"),
    win32: async (context, meta) => runtime.win32
      ? runtime.win32(context, meta)
      : unavailable("win32"),
    rasterFallback: async (context, meta) => runtime.rasterFallback
      ? runtime.rasterFallback(context, meta)
      : unavailable("raster-fallback")
  };
}

function unavailable(backend){
  return {
    executed:false,
    backend,
    evidence:{changed:false,goalReached:false},
    failure:{reason:"handler-not-connected"}
  };
}
