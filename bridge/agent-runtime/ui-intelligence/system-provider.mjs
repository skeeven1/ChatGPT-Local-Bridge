import { normalizeBounds } from '../window-intelligence/bounds-resolver.mjs';
import { createUIElementEvidence } from './ui-element-evidence.mjs';

export function inferCanvasFromClient(windowContext = {}) {
  const client = normalizeBounds(windowContext.clientBounds ?? windowContext.bounds);
  if (!client || client.width < 240 || client.height < 180 || windowContext.state?.minimized) return null;
  const topInset = Math.min(Math.round(client.height * 0.28), Math.round(190 * (windowContext.dpi ?? 96) / 96));
  const sideInset = Math.min(Math.round(client.width * 0.06), Math.round(72 * (windowContext.dpi ?? 96) / 96));
  return createUIElementEvidence({
    source: 'windows-system', element: 'canvas-probable', confidence: 0.58,
    bounds: { x: client.x + sideInset, y: client.y + topInset, width: client.width - sideInset * 2, height: client.height - topInset - sideInset },
    details: { basis: 'paint-client-area', dpi: windowContext.dpi ?? 96 }
  });
}
