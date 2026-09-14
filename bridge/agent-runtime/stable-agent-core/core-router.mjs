import { validateRequest } from "./stable-contract.mjs";

export function routeAgentRequest(request, handlers = {}) {
  if (!validateRequest(request)) {
    return {
      ok: false,
      error: "invalid_stable_action"
    };
  }

  const handler = handlers[request.action];

  if (!handler) {
    return {
      ok: false,
      error: "capability_not_connected",
      action: request.action
    };
  }

  return handler(request);
}
