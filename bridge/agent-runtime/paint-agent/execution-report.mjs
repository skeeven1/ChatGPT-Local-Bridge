// V19.9.29 Paint execution report
// Separates command, backend decision, execution, observation and validation.
export function createPaintExecutionReport(input={}) {
  return {
    commandReceived: Boolean(input.commandReceived),
    backendSelected: input.backendSelected ?? null,
    actionExecuted: Boolean(input.actionExecuted ?? input.backendExecuted),
    resultObserved: Boolean(input.resultObserved ?? input.evidenceChanged),
    evidence: input.evidence ?? null,
    validation: input.validation ?? null,
    goalReached: Boolean(input.goalReached),
    failure: input.failure ?? null,
    diagnostics: input.diagnostics ?? null
  };
}
