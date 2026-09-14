import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowContext, ensureWindowFocused } from '../../bridge/agent-runtime/window-intelligence/index.mjs';
import { resolvePaintCanvas } from '../../bridge/agent-runtime/ui-intelligence/index.mjs';
import { evaluateConfidence } from '../../bridge/agent-runtime/perception-fusion/index.mjs';
import { createActionModel, executeActionModel } from '../../bridge/agent-runtime/action-model.mjs';
import { validateGoal } from '../../bridge/agent-runtime/validator/index.mjs';
import { RecoveryManager } from '../../bridge/agent-runtime/recovery/index.mjs';

function paintWindow(overrides = {}) {
  return createWindowContext({
    hwnd: 4242, pid: 100, processName: 'mspaint', title: 'drawing.png - Paint',
    windowBounds: { x: 100, y: 80, width: 1200, height: 800 },
    clientBounds: { x: 108, y: 112, width: 1184, height: 760 },
    visible: true, active: true, minimized: false, maximized: false, dpi: 120,
    monitorBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    monitorWorkArea: { x: 0, y: 0, width: 1920, height: 1040 },
    ...overrides
  });
}

const canvasElement = (x = 180, y = 280) => ({
  name: 'Canvas', automationId: 'CanvasHost', className: 'PaintCanvas', controlType: 'ControlType.Document',
  enabled: true, offscreen: false, bounds: { x, y, width: 1000, height: 540 }
});

test('3. Window detection builds a complete WindowContext', () => {
  const context = paintWindow();
  assert.equal(context.hwnd, 4242);
  assert.equal(context.process, 'mspaint');
  assert.deepEqual(context.state, { visible: true, minimized: false, maximized: false, active: true, mode: 'normal' });
  assert.equal(context.monitor.dpi, 120);
  assert.equal(context.monitor.scale, 1.25);
});

test('4. Paint detection fuses window, UI Automation, system, and vision', () => {
  const result = resolvePaintCanvas({
    windowContext: paintWindow(), uiElements: [canvasElement()],
    visualObservation: { x: 184, y: 284, width: 992, height: 532, confidence: 0.74 }
  });
  assert.equal(result.canvasFound, true);
  assert.ok(result.confidence >= 0.9);
  assert.deepEqual(result.bounds, canvasElement().bounds);
  assert.deepEqual(result.method, ['window', 'windows-ui', 'windows-system', 'vision']);
});

test('5. Paint moved uses current dynamic bounds', () => {
  const moved = paintWindow({
    windowBounds: { x: 460, y: 300, width: 1200, height: 800 },
    clientBounds: { x: 468, y: 332, width: 1184, height: 760 }
  });
  const result = resolvePaintCanvas({ windowContext: moved, uiElements: [canvasElement(540, 500)] });
  assert.equal(result.canvasFound, true);
  assert.equal(result.bounds.x, 540);
  assert.equal(result.windowContext.bounds.y, 300);
});

test('Paint maximized keeps monitor, DPI, and client coordinates', () => {
  const maximized = paintWindow({
    maximized: true,
    windowBounds: { x: -8, y: -8, width: 1936, height: 1056 },
    clientBounds: { x: 0, y: 32, width: 1920, height: 1008 }
  });
  const result = resolvePaintCanvas({ windowContext: maximized, uiElements: [canvasElement(80, 230)] });
  assert.equal(maximized.state.mode, 'maximized');
  assert.equal(result.canvasFound, true);
  assert.equal(result.bounds.x, 80);
});

test('Already-drawn or zoomed canvas remains detectable from Windows UI evidence', () => {
  const result = resolvePaintCanvas({ windowContext: paintWindow(), uiElements: [canvasElement()], visualObservation: null });
  assert.equal(result.canvasFound, true);
  assert.ok(result.method.includes('windows-ui'));
  assert.ok(!result.method.includes('vision'));
});

test('6. Paint minimized is restored and re-inspected', async () => {
  const minimized = paintWindow({ minimized: true, active: false });
  let focusCalls = 0;
  const recovered = await ensureWindowFocused(minimized, {
    focus: async () => { focusCalls += 1; },
    inspect: async () => paintWindow({ minimized: false, active: true })
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.context.focused, true);
  assert.equal(focusCalls, 1);
});

test('7. Focus loss selects refocus before retry', async () => {
  const calls = [];
  const result = await new RecoveryManager().recover('focus_lost', {
    refocus: async () => { calls.push('refocus'); return true; },
    retry: async () => { calls.push('retry'); return true; }
  });
  assert.equal(result.recovered, true);
  assert.equal(result.strategy, 'refocus');
  assert.deepEqual(calls, ['refocus']);
});

test('8. Recovery recalibrates invalid coordinates', async () => {
  const result = await new RecoveryManager().recover('invalid_coordinates', {
    recalibrate: async () => ({ x: 720, y: 510 }),
    retry: async () => true
  });
  assert.equal(result.strategy, 'recalibrate');
  assert.deepEqual(result.result.value, { x: 720, y: 510 });
});

test('Recovery rediscovers a closed window and falls through failed strategies', async () => {
  const calls = [];
  const result = await new RecoveryManager({ maxAttempts: 3 }).recover('window_closed', {
    rediscoverWindow: async () => { calls.push('rediscover'); return false; },
    refocus: async () => { calls.push('refocus'); throw new Error('stale hwnd'); },
    recalibrate: async () => { calls.push('recalibrate'); return { hwnd: 99 }; }
  });
  assert.equal(result.strategy, 'recalibrate');
  assert.deepEqual(calls, ['rediscover', 'refocus', 'recalibrate']);
});

test('Timeout exhausts retry and rediscovery then aborts safely', async () => {
  let aborted = false;
  const result = await new RecoveryManager().recover('timeout', {
    retry: async () => false,
    rediscoverWindow: async () => false,
    abort: async () => { aborted = true; }
  });
  assert.equal(result.recovered, false);
  assert.equal(result.strategy, 'abortSafely');
  assert.equal(aborted, true);
});

test('9. Validation requires an observed before/after change', async () => {
  let phase = 'before';
  const model = createActionModel({
    goal: 'modify Paint canvas', actionName: 'click',
    observe: async () => phase === 'before' ? { visual: { digest: 'a' } } : { visual: { digest: 'b' } },
    action: async () => { phase = 'after'; return { executed: true }; },
    expectedResult: { visualChange: true },
    validate: validateGoal
  });
  const result = await executeActionModel(model);
  assert.equal(result.action.sent, true);
  assert.equal(result.action.executed, true);
  assert.equal(result.validation.goalReached, true);
  assert.equal(result.validation.checks.visual, true);
});

test('insufficient evidence refuses the action', () => {
  const assessment = evaluateConfidence([{ source: 'window', confidence: 0.99 }]);
  assert.equal(assessment.accepted, false);
  assert.equal(assessment.refusalReason, 'insufficient_perception_confidence');
});
