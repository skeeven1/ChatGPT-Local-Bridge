// V19.9.21 Paint action gate
// Blocks false success: execution and evidence are separate states.

export async function runPaintActionGate({
  command,
  context = {},
  execute,
  validate
}) {
  const before = context?.evidence?.before ?? null;
  const execution = await execute({ command, context });
  const validation = await validate({
    command,
    context,
    before,
    execution
  });

  return {
    commandReceived: true,
    backendSelected: execution?.backend ?? null,
    actionExecuted: execution?.executed === true,
    resultObserved: validation?.changed === true,
    evidence: validation ?? { changed:false },
    executionResult: execution ?? null,
    goalReached: validation?.goalReached === true,
    recoveryRequired: validation?.goalReached !== true && execution?.executed === true,
    failure: execution?.failure ?? (validation?.changed === false ? {reason:'validation-no-observable-change'} : null)
  };
}
