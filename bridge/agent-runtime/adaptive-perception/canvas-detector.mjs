export function createCanvasObservation(region, confidence = 0) {
  return {
    region,
    confidence,
    detectedAt: new Date().toISOString()
  };
}

export function validateCanvasObservation(canvas) {
  return Boolean(
    canvas &&
    canvas.region &&
    canvas.confidence > 0
  );
}
