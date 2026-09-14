export async function retry(context) {
  if (typeof context.retry !== 'function') throw new Error('retry_unavailable');
  const value = await context.retry();
  if (value === false) throw new Error('retry_failed');
  return { strategy: 'retry', value };
}

export async function recalibrate(context) {
  if (typeof context.recalibrate !== 'function') throw new Error('recalibration_unavailable');
  const value = await context.recalibrate();
  if (value === false) throw new Error('recalibration_failed');
  return { strategy: 'recalibrate', value };
}

export async function refocus(context) {
  if (typeof context.refocus !== 'function') throw new Error('refocus_unavailable');
  const value = await context.refocus();
  if (value === false) throw new Error('refocus_failed');
  return { strategy: 'refocus', value };
}

export async function rediscoverWindow(context) {
  if (typeof context.rediscoverWindow !== 'function') throw new Error('window_rediscovery_unavailable');
  const value = await context.rediscoverWindow();
  if (value === false) throw new Error('window_rediscovery_failed');
  return { strategy: 'rediscoverWindow', value };
}

export async function abortSafely(context) {
  if (typeof context.abort === 'function') await context.abort();
  return { strategy: 'abortSafely', aborted: true };
}
