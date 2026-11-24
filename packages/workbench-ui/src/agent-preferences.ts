import catalog from "../../../contracts/agent-session-defaults.json";
export const agentSessionDefaults = Object.freeze(catalog.preferences);
export type AgentPreferences = typeof catalog.preferences;
export function agentPreferences(value?: { agent_session?: Partial<AgentPreferences> }): AgentPreferences {
  return { ...agentSessionDefaults, ...value?.agent_session };
}
