function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = finite(bounds.x);
  const y = finite(bounds.y);
  const width = finite(bounds.width);
  const height = finite(bounds.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function containsBounds(outer, inner, tolerance = 2) {
  const a = normalizeBounds(outer);
  const b = normalizeBounds(inner);
  if (!a || !b) return false;
  return b.x >= a.x - tolerance && b.y >= a.y - tolerance &&
    b.x + b.width <= a.x + a.width + tolerance &&
    b.y + b.height <= a.y + a.height + tolerance;
}

export function resolveUsableBounds(raw = {}) {
  const windowBounds = normalizeBounds(raw.windowBounds ?? raw.bounds);
  const clientBounds = normalizeBounds(raw.clientBounds) ?? windowBounds;
  if (!windowBounds || !clientBounds) throw new Error('window_bounds_unavailable');
  return { windowBounds, clientBounds };
}
