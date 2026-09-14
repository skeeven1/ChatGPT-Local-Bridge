import { rankCanvasElements } from './windows-ui-provider.mjs';
import { inferCanvasFromClient } from './system-provider.mjs';
import { visionCanvasEvidence } from './vision-provider.mjs';
import { evaluateConfidence, createFusionResult } from '../perception-fusion/index.mjs';

export function resolvePaintCanvas({ windowContext, uiElements = [], visualObservation = null, threshold = 0.72 } = {}) {
  if (!windowContext?.hwnd || !/^(mspaint|paint)$/i.test(String(windowContext.process ?? windowContext.processName ?? ''))) {
    throw new Error('verified_paint_window_required');
  }
  const evidence = [{
    source: 'window', element: 'paint-window', confidence: 0.99,
    bounds: windowContext.clientBounds,
    details: { hwnd: windowContext.hwnd, process: windowContext.process, title: windowContext.title }
  }];
  const uiEvidence = rankCanvasElements(uiElements, windowContext);
  if (uiEvidence[0]?.confidence >= 0.7) evidence.push(uiEvidence[0]);
  const systemEvidence = inferCanvasFromClient(windowContext);
  if (systemEvidence) evidence.push(systemEvidence);
  const visualEvidence = visionCanvasEvidence(visualObservation);
  if (visualEvidence) evidence.push(visualEvidence);
  const assessment = evaluateConfidence(evidence, { threshold, requiredSources: ['window'] });
  const selected = uiEvidence[0]?.confidence >= 0.7 ? uiEvidence[0] : visualEvidence ?? systemEvidence;
  const fusion = createFusionResult('canvas-found', assessment, selected?.bounds ?? null);
  return {
    ...fusion,
    canvasFound: Boolean(assessment.accepted && selected?.bounds),
    method: assessment.sources,
    selectedEvidence: selected ?? null,
    windowContext
  };
}
