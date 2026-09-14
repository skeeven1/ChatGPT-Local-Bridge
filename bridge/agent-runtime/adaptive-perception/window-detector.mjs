export function normalizeWindowObservation(windowInfo = {}) {
  return {
    process: windowInfo.process ?? null,
    title: windowInfo.title ?? null,
    bounds: windowInfo.bounds ?? null,
    visible: Boolean(windowInfo.visible),
    confidence: windowInfo.confidence ?? 0
  };
}

export function hasUsableBounds(observation) {
  const b = observation?.bounds;
  return Boolean(
    b &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height)
  );
}
