export function compareVisualStates(before = {}, after = {}, options = {}) {
  if (Number.isFinite(before.hashDistance) && Number.isFinite(after.hashDistance)) {
    const delta = Math.abs(after.hashDistance - before.hashDistance);
    return { changed: delta >= Number(options.minHashDelta ?? 1), delta, method: 'hash-distance' };
  }
  if (Number.isFinite(after.matchScore)) {
    const minScore = Number(options.minMatchScore ?? 0.75);
    return { changed: after.matchScore >= minScore, score: after.matchScore, minScore, method: 'target-match' };
  }
  if (before.digest && after.digest) return { changed: before.digest !== after.digest, method: 'digest' };
  return { changed: false, method: 'unavailable', reason: 'visual_evidence_unavailable' };
}
