import type { Migration } from './types.js';

/**
 * What the agent was actually given: the composed system prompt (task
 * context, type guidance, spec stage, memory, house rules…) and the last
 * prompt sent to it, so the card can show the agent's context.
 */
export const migration: Migration = {
  id: '0036_run_agent_context',
  up: `
    ALTER TABLE agent_runs ADD COLUMN system_prompt TEXT;
    ALTER TABLE agent_runs ADD COLUMN last_prompt TEXT;
  `,
};
