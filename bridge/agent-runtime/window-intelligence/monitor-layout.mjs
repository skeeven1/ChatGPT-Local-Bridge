import { normalizeBounds } from './bounds-resolver.mjs';

export function normalizeMonitor(raw = {}) {
  const bounds = normalizeBounds(raw.bounds ?? raw.monitorBounds);
  const workArea = normalizeBounds(raw.workArea ?? raw.monitorWorkArea) ?? bounds;
  return Object.freeze({
    id: raw.id ?? raw.monitor ?? null,
    bounds,
    workArea,
    primary: raw.primary === true,
    dpi: Number.isFinite(Number(raw.dpi)) ? Number(raw.dpi) : 96,
    scale: Number.isFinite(Number(raw.scale)) ? Number(raw.scale) :
      (Number.isFinite(Number(raw.dpi)) ? Number(raw.dpi) / 96 : 1)
  });
}

export function monitorForWindow(monitors = [], bounds) {
  const b = normalizeBounds(bounds);
  if (!b) return null;
  let best = null;
  let bestArea = -1;
  for (const monitor of monitors.map(normalizeMonitor)) {
    const m = monitor.bounds;
    if (!m) continue;
    const width = Math.max(0, Math.min(b.x + b.width, m.x + m.width) - Math.max(b.x, m.x));
    const height = Math.max(0, Math.min(b.y + b.height, m.y + m.height) - Math.max(b.y, m.y));
    const area = width * height;
    if (area > bestArea) { best = monitor; bestArea = area; }
  }
  return best;
}
