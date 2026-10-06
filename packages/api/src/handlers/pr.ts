import type { IssueRef } from '@kanbots/core';
import { z } from 'zod';
import type { PullRequestPayload } from '../bridge.js';
import { issueRefSchema } from '../issue-ref.js';
import { approveCard, type ApproveResult } from '../card-flow.js';
import { mergePullRequest, openPullRequest, watchPullRequests } from '../pr-flow.js';
import { parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const numberSchema = z.object({ number: issueRefSchema }).strict();

/** Approve a reviewed card: push its branch, open its PR, move it to PR. */
export async function open(
  deps: HandlerDeps,
  args: { number: IssueRef },
): Promise<PullRequestPayload> {
  return openPullRequest(deps, parseArgs(numberSchema, args).number);
}

/** Approve a reviewed card: PR or local merge, by its workspace's stages. */
export async function approve(
  deps: HandlerDeps,
  args: { number: IssueRef },
): Promise<ApproveResult> {
  return approveCard(deps, parseArgs(numberSchema, args).number);
}

/** Merge a card's PR once CI passed; the card goes to Done. */
export async function merge(
  deps: HandlerDeps,
  args: { number: IssueRef },
): Promise<PullRequestPayload> {
  return mergePullRequest(deps, parseArgs(numberSchema, args).number);
}

/** One pass of the PR watcher (the desktop host calls it on a timer). */
export async function refreshAll(deps: HandlerDeps): Promise<{ changed: boolean }> {
  return { changed: await watchPullRequests(deps) };
}
