import { createUIElementEvidence } from './ui-element-evidence.mjs';

export function visionCanvasEvidence(observation = {}) {
  if (!observation?.bounds && !Number.isFinite(Number(observation?.width))) return null;
  const bounds = observation.bounds ?? observation;
  const raw = Number(observation.confidence ?? 0);
  const confidence = Math.max(0.45, Math.min(0.88, 0.55 + raw * 0.45));
  return createUIElementEvidence({ source: 'vision', element: 'canvas', confidence, bounds, details: { detector: observation.detector ?? 'bright-region' } });
}
