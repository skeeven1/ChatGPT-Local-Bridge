import { scoreEvidence } from './evidence-score.mjs';

export function evaluateConfidence(evidence, { threshold = 0.72, requiredSources = ['window'] } = {}) {
  const scored = scoreEvidence(evidence);
  const missingSources = requiredSources.filter((source) => !scored.sources.includes(source));
  const nonWindowSources = scored.sources.filter((source) => source !== 'window');
  const accepted = scored.confidence >= threshold && missingSources.length === 0 && nonWindowSources.length > 0;
  return { ...scored, threshold, missingSources, accepted, refusalReason: accepted ? null : 'insufficient_perception_confidence' };
}

export function requireConfidence(evidence, options) {
  const result = evaluateConfidence(evidence, options);
  if (!result.accepted) {
    const error = new Error(result.refusalReason);
    error.code = 'INSUFFICIENT_CONFIDENCE';
    error.details = result;
    throw error;
  }
  return result;
}
