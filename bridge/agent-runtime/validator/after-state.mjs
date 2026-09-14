import { captureState } from './before-state.mjs';

export async function captureAfterState(observers = {}) {
  return captureState('after', observers);
}
