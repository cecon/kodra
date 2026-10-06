import { z } from 'zod';
import type { AssistFieldInput, DraftedIssue } from '../bridge.js';
import { collectSuggestionEntries } from '../suggestion-context.js';
import { badRequest, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

/** The repo a workspace points at, so the AI reads the card's code rather
 *  than the board's (which has none). Unknown ids fall back to the default. */
function workspaceCwd(deps: HandlerDeps, workspaceId: string | undefined): { cwd?: string } {
  const path = workspaceId ? deps.registry?.get(workspaceId)?.path : undefined;
  return path ? { cwd: path } : {};
}

const draftSchema = z
  .object({
    description: z.string().min(1).max(20_000),
    workspaceId: z.string().min(1).optional(),
  })
  .strict();

export interface DraftArgs {
  description: string;
  workspaceId?: string;
}

export async function draft(deps: HandlerDeps, args: DraftArgs): Promise<DraftedIssue> {
  const parsed = parseArgs(draftSchema, args);
  return deps.draftIssue({
    description: parsed.description,
    ...workspaceCwd(deps, parsed.workspaceId),
  });
}

const assistSchema = z
  .object({
    mode: z.enum(['improve-description', 'suggest-title']),
    title: z.string().max(500),
    description: z.string().max(20_000),
    workspaceId: z.string().min(1).optional(),
  })
  .strict();

/** Per-field AI help in the new-task form: polish the description or
 *  name the task. Needs at least some text to work from. */
export async function assist(deps: HandlerDeps, args: AssistFieldInput): Promise<DraftedIssue> {
  const parsed = parseArgs(assistSchema, args);
  if (!deps.assistField) throw badRequest('AI field help is not available in this build');
  if (parsed.title.trim() === '' && parsed.description.trim() === '') {
    throw badRequest('Write a title or a description first');
  }
  return deps.assistField({
    mode: parsed.mode,
    title: parsed.title,
    description: parsed.description,
    ...workspaceCwd(deps, parsed.workspaceId),
  });
}

const suggestSchema = z
  .object({
    personaPrompt: z.string().min(1).max(8_000),
    provider: z
      .enum([
        'claude-code',
        'codex-cli',
        'gemini-cli',
        'agy-cli',
        'amp-cli',
        'cursor-cli',
        'copilot-cli',
        'opencode-cli',
        'droid-cli',
        'ccr-cli',
        'qwen-cli',
        'acp',
      ])
      .optional(),
    userNotes: z.string().max(4_000).optional(),
    workspaceId: z.string().min(1).optional(),
  })
  .strict();

export interface SuggestArgs {
  personaPrompt: string;
  provider?:
    | 'claude-code'
    | 'codex-cli'
    | 'gemini-cli'
    | 'agy-cli'
    | 'amp-cli'
    | 'cursor-cli'
    | 'copilot-cli'
    | 'opencode-cli'
    | 'droid-cli'
    | 'ccr-cli'
    | 'qwen-cli'
    | 'acp';
  userNotes?: string;
  workspaceId?: string;
}

export async function suggest(deps: HandlerDeps, args: SuggestArgs): Promise<DraftedIssue> {
  const parsed = parseArgs(suggestSchema, args);
  const all = await deps.source.listIssues({ state: 'all' });
  // With a workspace, ideate for that repo: its code and its own cards.
  const issues = parsed.workspaceId ? all.filter((i) => i.workspaceId === parsed.workspaceId) : all;
  const backlog = collectSuggestionEntries(issues);
  const trimmedNotes = parsed.userNotes?.trim();
  return deps.suggestIssue({
    backlog,
    personaPrompt: parsed.personaPrompt,
    ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
    ...(trimmedNotes ? { userNotes: trimmedNotes } : {}),
    ...workspaceCwd(deps, parsed.workspaceId),
    ...(deps.onSuggestEvent !== undefined ? { onEvent: deps.onSuggestEvent } : {}),
  });
}
