import { containsBounds, normalizeBounds } from '../window-intelligence/bounds-resolver.mjs';
import { createUIElementEvidence } from './ui-element-evidence.mjs';

const CANVAS_TERMS = /canvas|drawing|document|zone de dessin|toile/i;

export function rankCanvasElements(elements = [], windowContext = {}) {
  const client = normalizeBounds(windowContext.clientBounds ?? windowContext.bounds);
  return elements.map((item) => {
    const bounds = normalizeBounds(item.bounds);
    if (!bounds || !client || !containsBounds(client, bounds, 8) || bounds.width < 64 || bounds.height < 64) return null;
    const text = [item.name, item.automationId, item.className, item.controlType].filter(Boolean).join(' ');
    let confidence = 0.45;
    if (CANVAS_TERMS.test(text)) confidence += 0.32;
    if (/document|pane|custom|image/i.test(String(item.controlType ?? ''))) confidence += 0.12;
    if (bounds.width * bounds.height >= client.width * client.height * 0.18) confidence += 0.08;
    if (item.offscreen === true || item.enabled === false) confidence -= 0.25;
    return createUIElementEvidence({
      source: 'windows-ui', element: 'canvas', confidence,
      bounds, details: { name: item.name ?? '', automationId: item.automationId ?? '', controlType: item.controlType ?? '' }
    });
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
}
