import { isActionableWindow } from './window-state.mjs';

export async function ensureWindowFocused(context, { focus, inspect, attempts = 2 } = {}) {
  if (!context?.hwnd || typeof focus !== 'function' || typeof inspect !== 'function') throw new Error('focus_adapter_required');
  let current = context;
  if (isActionableWindow(current.state) && current.focused) return { context: current, recovered: false, attempts: 0 };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await focus(current.hwnd);
    current = await inspect(current.hwnd);
    if (isActionableWindow(current.state) && current.focused) return { context: current, recovered: true, attempts: attempt };
  }
  throw new Error('window_focus_recovery_failed');
}
