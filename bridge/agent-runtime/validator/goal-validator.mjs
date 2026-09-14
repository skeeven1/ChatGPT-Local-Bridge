import { compareVisualStates } from './visual-diff.mjs';

export function validateGoal(before = {}, after = {}, expected = {}, actionResult = {}) {
  const checks = {};
  if (expected.window) checks.window = Object.entries(expected.window).every(([key, value]) => after.window?.[key] === value);
  if (expected.uiChange === true) checks.ui = JSON.stringify(before.ui ?? null) !== JSON.stringify(after.ui ?? null);
  if (expected.visualChange === true || expected.minMatchScore != null) {
    checks.visual = compareVisualStates(before.visual ?? {}, after.visual ?? {}, expected).changed;
  }
  if (typeof expected.predicate === 'function') checks.expectedResult = Boolean(expected.predicate(after, actionResult));
  const values = Object.values(checks);
  const goalReached = actionResult?.executed !== false && values.length > 0 && values.every(Boolean);
  return { validated: values.length > 0, goalReached, checks, reason: goalReached ? 'goal_reached' : 'goal_not_observed' };
}
