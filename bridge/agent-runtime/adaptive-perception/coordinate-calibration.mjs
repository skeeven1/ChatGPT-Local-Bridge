export function calibrateRelativePoint(bounds, relative) {
  if (!bounds) {
    throw new Error("missing_window_bounds");
  }

  return {
    x: Math.round(bounds.x + bounds.width * relative.x),
    y: Math.round(bounds.y + bounds.height * relative.y),
    source: "dynamic-window-calibration"
  };
}
