import type { Migration } from './types.js';

/**
 * Cards belong to a registered workspace (the repo they act on), and runs
 * remember the workspace and repo path they worked in, so checks, ship and
 * PR flows follow the card rather than the folder the app was opened on.
 */
export const migration: Migration = {
  id: '0035_card_workspace',
  up: `
    ALTER TABLE local_issues ADD COLUMN workspace_id TEXT;
    ALTER TABLE agent_runs ADD COLUMN workspace_id TEXT;
    ALTER TABLE agent_runs ADD COLUMN repo_path TEXT;
  `,
};
