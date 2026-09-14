import { normalizeBounds } from '../window-intelligence/bounds-resolver.mjs';

export function createUIElementEvidence(input = {}) {
  const source = String(input.source ?? 'windows-ui');
  const element = String(input.element ?? input.controlType ?? 'unknown');
  const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? 0)));
  const bounds = normalizeBounds(input.bounds);
  return Object.freeze({ source, element, confidence, bounds, details: input.details ?? {} });
}
