export function validateActionResult(before, after, expected = {}) {
  const changed = JSON.stringify(before) !== JSON.stringify(after);

  return {
    validated: changed || expected.allowNoVisualChange === true,
    changed,
    before,
    after,
    expected
  };
}
