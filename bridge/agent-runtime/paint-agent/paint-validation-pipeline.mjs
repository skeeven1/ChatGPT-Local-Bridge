// V19.9.20 Paint validation pipeline
// Keeps execution state separate from success.
export function createPaintValidationState(input={}) {
  return {
    commandReceived: Boolean(input.commandReceived),
    backendSelected: input.backendSelected ?? null,
    backendExecuted: Boolean(input.backendExecuted),
    before: input.before ?? null,
    after: input.after ?? null,
    changed: Boolean(input.changed),
    goalReached: Boolean(input.backendExecuted && input.changed),
    failure: input.failure ?? null
  };
}
