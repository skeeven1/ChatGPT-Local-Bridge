import * as strategies from './strategies.mjs';

const PLAN = Object.freeze({
  focus_lost: ['refocus', 'recalibrate', 'retry'],
  window_moved: ['recalibrate', 'retry'],
  window_closed: ['rediscoverWindow', 'refocus', 'recalibrate', 'retry'],
  timeout: ['retry', 'rediscoverWindow'],
  invalid_coordinates: ['recalibrate', 'retry']
});

export class RecoveryManager {
  constructor(options = {}) {
    this.maxAttempts = Math.max(1, Math.min(5, Number(options.maxAttempts ?? 3)));
  }

  async recover(reason, context = {}) {
    const plan = PLAN[reason] ?? [];
    const attempts = [];
    for (const name of plan.slice(0, this.maxAttempts)) {
      try {
        const result = await strategies[name](context);
        attempts.push({ strategy: name, ok: true });
        return { recovered: true, strategy: name, attempts, result };
      } catch (error) {
        attempts.push({ strategy: name, ok: false, error: String(error?.message ?? error) });
      }
    }
    const result = await strategies.abortSafely(context);
    return { recovered: false, strategy: 'abortSafely', attempts, result };
  }
}
