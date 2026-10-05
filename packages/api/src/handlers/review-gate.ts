import type { AgentCheck, AgentRun } from '@kanbots/local-store';
import { z } from 'zod';
import type { ReviewGatePayload } from '../bridge.js';
import { issueRefSchema } from '../issue-ref.js';
import {
  failureReport,
  reviewGateFor,
  startReviewGate,
  stopReviewGate,
  type ReviewGateDeps,
} from '../review-gate.js';
import { badRequest, notFound, parseArgs } from './errors.js';
import { postMessage } from './issues.js';
import type { HandlerDeps } from './types.js';
import type { IssueRef } from '@kanbots/core';

const runIdSchema = z.object({ runId: z.number().int().positive() }).strict();
const numberSchema = z.object({ number: issueRefSchema }).strict();

export async function run(deps: ReviewGateDeps, args: { runId: number }): Promise<AgentCheck[]> {
  const parsed = parseArgs(runIdSchema, args);
  if (!deps.store.agentRuns.findById(parsed.runId)) {
    throw notFound(`agent run ${parsed.runId} not found`);
  }
  return startReviewGate(deps, parsed.runId);
}

export function stop(_deps: HandlerDeps, args: { runId: number }): { stopped: boolean } {
  const parsed = parseArgs(runIdSchema, args);
  return { stopped: stopReviewGate(parsed.runId) };
}

/** The card's latest run, the one its Review gate checks. */
export function latestRunForIssue(deps: HandlerDeps, number: IssueRef): AgentRun | null {
  const thread = deps.store.threads.findByIssue(deps.config.owner, deps.config.repo, number);
  return thread ? deps.store.agentRuns.findLatestForThread(thread.id) : null;
}

export function gateForIssue(deps: HandlerDeps, number: IssueRef): ReviewGatePayload | null {
  return reviewGateFor(deps, latestRunForIssue(deps, number));
}

/**
 * The only way out of a failed gate: back to In progress, resuming the
 * agent's session in the same worktree with the failures as its prompt.
 */
export async function sendBack(
  deps: HandlerDeps,
  args: { number: IssueRef },
): Promise<{ ok: true }> {
  const parsed = parseArgs(numberSchema, args);
  const gate = gateForIssue(deps, parsed.number);
  if (!gate || gate.state !== 'failed') {
    throw badRequest(`#${parsed.number} has no failed checks to send back`);
  }
  const issue = await deps.source.getIssue(parsed.number);
  const labels = issue.labels.filter((l) => !l.startsWith('status:') && !l.startsWith('agent:'));
  labels.push('status:in-progress', 'agent:running');
  await deps.source.updateIssue(parsed.number, { labels });
  await postMessage(deps, { number: parsed.number, body: failureReport(gate) });
  return { ok: true };
}
