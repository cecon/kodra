import { z } from 'zod';
import type { AssistFieldInput, DraftedIssue } from '../bridge.js';
import { collectSuggestionEntries } from '../suggestion-context.js';
import { badRequest, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const draftSchema = z
  .object({
    description: z.string().min(1).max(20_000),
  })
  .strict();

export interface DraftArgs {
  description: string;
}

export async function draft(deps: HandlerDeps, args: DraftArgs): Promise<DraftedIssue> {
  const parsed = parseArgs(draftSchema, args);
  return deps.draftIssue({ description: parsed.description });
}

const assistSchema = z
  .object({
    mode: z.enum(['improve-description', 'suggest-title']),
    title: z.string().max(500),
    description: z.string().max(20_000),
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
  return deps.assistField(parsed);
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
}

export async function suggest(deps: HandlerDeps, args: SuggestArgs): Promise<DraftedIssue> {
  const parsed = parseArgs(suggestSchema, args);
  const issues = await deps.source.listIssues({ state: 'all' });
  const backlog = collectSuggestionEntries(issues);
  const trimmedNotes = parsed.userNotes?.trim();
  return deps.suggestIssue({
    backlog,
    personaPrompt: parsed.personaPrompt,
    ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
    ...(trimmedNotes ? { userNotes: trimmedNotes } : {}),
    ...(deps.onSuggestEvent !== undefined ? { onEvent: deps.onSuggestEvent } : {}),
  });
}
