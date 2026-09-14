export function getRuntimeStatus(context) {
  return {
    version: context?.version ?? "unknown",
    stableCore: context?.coreLoaded === true,
    capabilities: context?.capabilities ?? []
  };
}
