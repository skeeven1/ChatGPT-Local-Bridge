const WEIGHTS = Object.freeze({ window: 0.34, 'windows-ui': 0.34, 'windows-system': 0.12, vision: 0.20 });

export function scoreEvidence(evidence = []) {
  const bestBySource = new Map();
  for (const item of evidence) {
    if (!item || !item.source) continue;
    const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0)));
    if (confidence > Number(bestBySource.get(item.source)?.confidence ?? -1)) bestBySource.set(item.source, { ...item, confidence });
  }
  let weighted = 0;
  let available = 0;
  for (const [source, item] of bestBySource) {
    const weight = WEIGHTS[source] ?? 0.1;
    weighted += item.confidence * weight;
    available += weight;
  }
  const diversityBonus = Math.min(0.12, Math.max(0, bestBySource.size - 1) * 0.04);
  return {
    confidence: Math.max(0, Math.min(1, available ? weighted / Math.max(0.72, available) + diversityBonus : 0)),
    sources: [...bestBySource.keys()],
    evidence: [...bestBySource.values()]
  };
}
