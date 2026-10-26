// The agent inference service, as the room server sees it: one call per room per decision.
// Rooms whose players hand control to the agent send their state every 0.5 s and get back an
// action for each agent-driven explorer (see services/agent-inference).

/** A decision that takes longer than this is abandoned; the next one is due 0.5 s later anyway. */
const DECISION_TIMEOUT_MS = 2000;

/** A client for the agent service at `url`: act(request) resolves to [[move, gait, gaze], ...]. */
export function agentClient(url) {
  const endpoint = new URL('/act', url);
  return {
    async act(request) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`agent service answered ${response.status}`);
      return (await response.json()).actions;
    },
  };
}
