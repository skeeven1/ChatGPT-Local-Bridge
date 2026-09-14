import { resolveUsableBounds } from './bounds-resolver.mjs';
import { normalizeWindowState } from './window-state.mjs';
import { normalizeMonitor } from './monitor-layout.mjs';

export function createWindowContext(raw = {}) {
  const hwnd = Number(raw.hwnd ?? raw.MainWindowHandle);
  const pid = Number(raw.pid ?? raw.Id);
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error('invalid_hwnd');
  const { windowBounds, clientBounds } = resolveUsableBounds(raw);
  const state = normalizeWindowState(raw.state ?? raw);
  const processName = String(raw.processName ?? raw.ProcessName ?? '').trim() || null;
  const title = String(raw.title ?? raw.MainWindowTitle ?? '').trim() || null;
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence ?? 0.98)));
  return Object.freeze({
    hwnd,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    process: processName,
    processName,
    title,
    bounds: windowBounds,
    clientBounds,
    state,
    focused: state.active,
    monitor: normalizeMonitor(raw.monitorInfo ?? raw),
    dpi: Number.isFinite(Number(raw.dpi)) ? Number(raw.dpi) : 96,
    confidence
  });
}

export async function inspectHwnd(hwnd, adapter, hints = {}) {
  if (typeof adapter !== 'function') throw new Error('window_inspector_adapter_required');
  const raw = await adapter(hwnd);
  return createWindowContext({ ...raw, ...hints, hwnd });
}
