import type { IssueRef } from '@kanbots/core';
import type { WorkspaceProfilePayload } from './bridge.js';
import { detectLocalBase, sweepAllRunsForThread } from './handlers/agent-runs.js';
import { merge as shipMerge } from './handlers/ship.js';
import type { HandlerDeps } from './handlers/types.js';
import { openPullRequest } from './pr-flow.js';
import { assertNoUncommittedWork } from './worktree-guard.js';

/**
 * Where a card goes next, by its workspace's stages:
 *
 *   agent → [checks] → [your review] → PR + CI → [auto] merge → Done
 *                                    └ (no PR) → local merge → Done
 *
 * A card without a registered workspace follows the full default path.
 */

export function profileForCard(
  deps: HandlerDeps,
  number: IssueRef,
): WorkspaceProfilePayload | null {
  const workspaceId = deps.store.localIssues.findByNumber(number)?.workspaceId ?? null;
  return workspaceId ? (deps.registry?.get(workspaceId) ?? null) : null;
}

export interface ApproveResult {
  outcome: 'pr-opened' | 'merged';
}

/**
 * Your approval of a reviewed card (or the automatic one when the
 * workspace skips review): open the PR, or merge locally into the base
 * branch when the workspace doesn't use PRs.
 */
export async function approveCard(deps: HandlerDeps, number: IssueRef): Promise<ApproveResult> {
  const profile = profileForCard(deps, number);
  if (!profile || profile.stages.pr) {
    await openPullRequest(deps, number);
    return { outcome: 'pr-opened' };
  }
  await assertNoUncommittedWork(deps, number);
  const targetBranch = profile.baseBranch ?? (await detectLocalBase(profile.path));
  await shipMerge(deps, { issueNumber: number, targetBranch });
  const issue = await deps.source.getIssue(number);
  const labels = issue.labels.filter((l) => !l.startsWith('status:') && !l.startsWith('agent:'));
  labels.push('status:done', 'agent:idle');
  await deps.source.updateIssue(number, { labels });
  const thread = deps.store.threads.findByIssue(deps.config.owner, deps.config.repo, number);
  if (thread) await sweepAllRunsForThread(deps, thread.id);
  return { outcome: 'merged' };
}

/** The gate passed: approve straight away when the workspace skips review. */
export async function afterGatePassed(deps: HandlerDeps, runId: number): Promise<void> {
  const run = deps.store.agentRuns.findById(runId);
  if (!run?.workspaceId) return;
  const profile = deps.registry?.get(run.workspaceId) ?? null;
  if (!profile || profile.stages.review) return;
  const thread = deps.store.threads.findById(run.threadId);
  if (!thread) return;
  await approveCard(deps, thread.issueNumber);
}
