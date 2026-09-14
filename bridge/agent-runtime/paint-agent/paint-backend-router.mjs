// V19.9.7 Paint Backend Router
// Selection only: execution remains owned by existing paint pipeline.
export function choosePaintBackend(context = {}) {
  const candidates = [
    {id:'clipboard-image', available:Boolean(context.clipboardAvailable), priority:100},
    {id:'ui-automation', available:Boolean(context.uiAutomationAvailable), priority:80},
    {id:'win32', available:Boolean(context.win32Available), priority:60},
    {id:'raster-fallback', available:true, priority:40}
  ];
  return candidates
    .filter(x=>x.available)
    .sort((a,b)=>b.priority-a.priority)[0] ?? {id:'none', available:false};
}

export function shouldFallback(result) {
  return !(result?.validation?.goalReached === true);
}
