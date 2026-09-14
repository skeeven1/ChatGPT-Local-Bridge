export function normalizeWindowState(raw = {}) {
  const minimized = raw.minimized === true;
  const maximized = raw.maximized === true;
  return Object.freeze({
    visible: raw.visible !== false,
    minimized,
    maximized,
    active: raw.active === true,
    mode: minimized ? 'minimized' : maximized ? 'maximized' : 'normal'
  });
}

export function isActionableWindow(state) {
  return Boolean(state?.visible && !state?.minimized);
}
