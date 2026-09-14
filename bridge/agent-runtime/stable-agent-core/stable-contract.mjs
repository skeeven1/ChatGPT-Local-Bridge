export const StableAgentActions = Object.freeze({
  STATUS: "status",
  OBSERVE: "observe",
  ACT: "act",
  VALIDATE: "validate",
  RECOVER: "recover"
});

export function validateRequest(request = {}) {
  return Boolean(
    request.action &&
    Object.values(StableAgentActions).includes(request.action)
  );
}
