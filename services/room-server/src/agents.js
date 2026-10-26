// The agent inference service, as the room server sees it. Rooms whose players hand control
// to their agent send their state every 0.5 s and get back an action for each agent-driven
// explorer; players teaching their agent send a demonstration every 0.5 s; and a player's
// agents are reset or forgotten (see services/agent-inference).

/** A decision that takes longer than this is abandoned; the next one is due 0.5 s later anyway. */
const DECISION_TIMEOUT_MS = 2000;

/**
 * A client for the agent service at `url`:
 *   act(request)          → [[move, gait, gaze], ...]
 *   demonstrate(request)  → { demos, updates, blend }
 *   reset(player, plan), forget(player)
 */
export function agentClient(url) {
  const post = async (path, body) => {
    const response = await fetch(new URL(path, url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`agent service answered ${response.status}`);
    return response.json();
  };
  return {
    act: async request => (await post('/act', request)).actions,
    demonstrate: request => post('/demonstrate', request),
    reset: (player, plan) => post('/reset', { player, plan }),
    forget: player => post('/forget', { player }),
  };
}
