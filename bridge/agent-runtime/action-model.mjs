import crypto from 'node:crypto';

export const GUI_DISPATCH_ACTIONS = new Set([
  'mouse-click', 'mouse-drag', 'mouse-scroll', 'type-text', 'key-press',
  'draw-in-paint', 'paint-job-control', 'paint-render-target', 'paint-correct-target', 'mouse-render-target'
]);

export function createActionRecord(input = {}) {
  return {
    id: String(input.id ?? crypto.randomUUID()),
    goal: String(input.goal ?? input.actionName ?? 'action'),
    preconditions: input.preconditions ?? [],
    observationBefore: input.observationBefore ?? null,
    action: input.action ?? { commandSent: false, executed: false, resultStatus: 'unknown' },
    expectedResult: input.expectedResult ?? {},
    observationAfter: input.observationAfter ?? null,
    validation: input.validation ?? { validated: false, goalReached: false, reason: 'not_run' },
    recovery: input.recovery ?? { attempted: false, strategy: null },
    metrics: input.metrics ?? { startedAt: null, completedAt: null, durationMs: null }
  };
}

export function createActionModel(input = {}) {
  if (!input.goal || typeof input.action !== 'function') throw new Error('action_goal_and_executor_required');
  return {
    ...createActionRecord({ id: input.id, goal: input.goal, preconditions: input.preconditions, expectedResult: input.expectedResult }),
    action: { requested: input.actionName ?? 'action', sent: false, executed: false, result: null },
    recovery: { attempted: false, strategy: null, result: null },
    metrics: { startedAt: null, completedAt: null, durationMs: null, attempts: 0 },
    executors: { observe: input.observe, act: input.action, validate: input.validate, recover: input.recover }
  };
}

export async function executeActionModel(model) {
  const started = Date.now();
  model.metrics.startedAt = new Date(started).toISOString();
  model.metrics.attempts += 1;
  for (const check of model.preconditions) {
    if (!await check()) throw new Error('action_precondition_failed');
  }
  if (model.executors.observe) model.observationBefore = await model.executors.observe('before');
  model.action.sent = true;
  try {
    model.action.result = await model.executors.act();
    model.action.executed = model.action.result?.executed !== false;
    if (model.executors.observe) model.observationAfter = await model.executors.observe('after');
    model.validation = model.executors.validate ?
      await model.executors.validate(model.observationBefore, model.observationAfter, model.expectedResult, model.action.result) :
      { validated: false, goalReached: false, reason: 'validator_required' };
    if (!model.validation.goalReached && model.executors.recover) {
      model.recovery.attempted = true;
      model.recovery.result = await model.executors.recover(model);
      model.recovery.strategy = model.recovery.result?.strategy ?? null;
    }
    return model;
  } finally {
    const completed = Date.now();
    model.metrics.completedAt = new Date(completed).toISOString();
    model.metrics.durationMs = completed - started;
    delete model.executors;
  }
}
