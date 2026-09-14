// V19.9.7 PaintSession context guard
export function createPaintSession(context={}) {
  return {
    hwnd: context.hwnd ?? null,
    process: context.process ?? null,
    title: context.title ?? null,
    bounds: context.bounds ?? null,
    dpi: context.dpi ?? null,
    focus: context.focus ?? false,
    canvas: context.canvas ?? null,
    confidence: Number(context.confidence ?? 0),
    updatedAt: Date.now()
  };
}

export function validatePaintSession(session) {
  const missing=[];
  if(!session?.hwnd) missing.push('hwnd');
  if(!session?.process) missing.push('process');
  if(!session?.canvas) missing.push('canvas');
  return {valid: missing.length===0, missing};
}
