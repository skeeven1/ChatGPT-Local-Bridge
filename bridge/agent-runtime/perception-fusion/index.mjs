export { scoreEvidence } from './evidence-score.mjs';
export { evaluateConfidence, requireConfidence } from './confidence-engine.mjs';

export function createFusionResult(result, assessment, bounds = null) {
  return Object.freeze({
    result,
    accepted: assessment.accepted,
    confidence: Number(assessment.confidence.toFixed(4)),
    bounds,
    evidence: assessment.sources,
    evidenceDetails: assessment.evidence,
    refusalReason: assessment.refusalReason
  });
}
