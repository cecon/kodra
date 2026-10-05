import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { IssueRef } from '@kanbots/core';
import type { AgentRun } from '@kanbots/local-store';
import type { PullRequestPayload } from './bridge.js';
import { sweepAllRunsForThread } from './handlers/agent-runs.js';
import { badRequest } from './handlers/errors.js';
import { postMessage } from './handlers/issues.js';
import type { HandlerDeps } from './handlers/types.js';
import { assertNoUncommittedWork } from './worktree-guard.js';

/**
 * The PR stage of a card (status:pr), between your review and Done:
 *
 *   Review --approve--> push + open PR --CI--> passed: you merge → Done
 *                                         └--> failed: back to the agent
 *                                              with the failing job logs
 *
 * GitHub is reached through the `gh` CLI (with the user's own login), so it
 * works for any workspace whose remote is on GitHub, local issues included.
 */

const execFileAsync = promisify(execFile);
const LOG_LIMIT = 8_000;

/** Last known PR per card, refreshed by the watcher; keyed by repo + issue. */
const known = new Map<string, PullRequestPayload>();
/** Head commit already sent back for a CI failure, so it is sent once. */
const sentBack = new Map<string, string>();

function key(deps: HandlerDeps, number: IssueRef): string {
  return `${deps.config.repoPath ?? ''}#${String(number)}`;
}

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const detail = (e.stderr ?? '').trim() || e.message;
    throw new Error(`${cmd} ${args[0] ?? ''} failed: ${detail}`);
  }
}

function repoPathOf(deps: HandlerDeps): string {
  const repoPath = deps.config.repoPath;
  if (!repoPath) throw badRequest('this workspace has no local repository');
  return repoPath;
}

function latestRunOf(deps: HandlerDeps, number: IssueRef): AgentRun | null {
  const thread = deps.store.threads.findByIssue(deps.config.owner, deps.config.repo, number);
  return thread ? deps.store.agentRuns.findLatestForThread(thread.id) : null;
}

/**
 * The branch holding the card's work. Usually the latest run's, but a
 * follow-up run can start on a fresh branch (e.g. when the first worktree
 * was already removed) and then carry on the original one: so take the
 * branch the latest worktree actually has checked out, else the newest run
 * branch with commits ahead of its base.
 */
async function resolveBranch(deps: HandlerDeps, number: IssueRef): Promise<string | null> {
  const repoPath = deps.config.repoPath;
  const thread = deps.store.threads.findByIssue(deps.config.owner, deps.config.repo, number);
  if (!repoPath || !thread) return null;
  const runs = deps.store.agentRuns.listByThread(thread.id).sort((a, b) => b.id - a.id);
  const candidates: Array<{ branch: string; base: string }> = [];
  const latest = runs[0];
  if (latest?.worktreePath && existsSync(latest.worktreePath)) {
    try {
      const head = (
        await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], latest.worktreePath)
      ).trim();
      if (head && head !== 'HEAD')
        candidates.push({ branch: head, base: latest.baseBranch ?? 'main' });
    } catch {
      // fall back to the recorded branches
    }
  }
  for (const r of runs) {
    if (r.branchName) candidates.push({ branch: r.branchName, base: r.baseBranch ?? 'main' });
  }
  for (const c of candidates) {
    try {
      const ahead = Number(
        (
          await run('git', ['rev-list', '--count', `${c.base}..refs/heads/${c.branch}`], repoPath)
        ).trim(),
      );
      if (ahead > 0) return c.branch;
    } catch {
      // branch gone: next candidate
    }
  }
  return null;
}

async function branchOf(deps: HandlerDeps, number: IssueRef): Promise<string> {
  const branch = await resolveBranch(deps, number);
  if (!branch)
    throw badRequest(`#${number} has no agent branch with commits to open a pull request from`);
  return branch;
}

interface RollupItem {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

const FAILED = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
]);

export function ciOf(
  rollup: readonly RollupItem[],
  expectsCi = false,
): Pick<PullRequestPayload, 'ci' | 'failing'> {
  // Right after a push GitHub has registered no checks yet: in a repo with
  // workflows that means CI hasn't started, not that there is none.
  if (rollup.length === 0) return { ci: expectsCi ? 'pending' : 'none', failing: [] };
  const failing = rollup
    .filter((c) => FAILED.has(c.conclusion ?? '') || FAILED.has(c.state ?? ''))
    .map((c) => c.name ?? c.context ?? 'check');
  if (failing.length > 0) return { ci: 'failed', failing };
  const pending = rollup.some(
    (c) =>
      (c.status !== undefined && c.status !== 'COMPLETED') ||
      c.state === 'PENDING' ||
      c.state === 'EXPECTED',
  );
  return { ci: pending ? 'pending' : 'passed', failing: [] };
}

/** Whether the repo defines GitHub Actions workflows. */
function hasWorkflows(repoPath: string): boolean {
  try {
    return readdirSync(join(repoPath, '.github', 'workflows')).some((f) => /.ya?ml$/i.test(f));
  } catch {
    return false;
  }
}

/** The PR whose head is `branch` (open or not), or null. */
export async function prForBranch(
  repoPath: string,
  branch: string,
): Promise<PullRequestPayload | null> {
  const out = await run(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      'number,url,state,headRefOid,statusCheckRollup',
    ],
    repoPath,
  );
  const [pr] = JSON.parse(out) as Array<{
    number: number;
    url: string;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    headRefOid: string;
    statusCheckRollup: RollupItem[] | null;
  }>;
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    headSha: pr.headRefOid,
    ...ciOf(pr.statusCheckRollup ?? [], hasWorkflows(repoPath)),
  };
}

export function knownPullRequest(deps: HandlerDeps, number: IssueRef): PullRequestPayload | null {
  return known.get(key(deps, number)) ?? null;
}

async function setStatus(
  deps: HandlerDeps,
  number: IssueRef,
  status: string,
  agent: string,
  state?: 'open' | 'closed',
): Promise<void> {
  const issue = await deps.source.getIssue(number);
  const labels = issue.labels.filter((l) => !l.startsWith('status:') && !l.startsWith('agent:'));
  labels.push(status, agent);
  await deps.source.updateIssue(number, { labels, ...(state ? { state } : {}) });
}

/**
 * Your approval: pushes the card's branch and opens its PR (or reuses the
 * open one, e.g. after the agent fixed a CI failure), then moves the card
 * to the PR column.
 */
export async function openPullRequest(
  deps: HandlerDeps,
  number: IssueRef,
): Promise<PullRequestPayload> {
  const repoPath = repoPathOf(deps);
  const branch = await branchOf(deps, number);
  await assertNoUncommittedWork(deps, number);
  // Agent worktrees install a pre-push hook that refuses kodra/issue-*
  // branches, so an agent can't publish its own work. This push is the
  // human's approval, the bypass the hook itself names: --no-verify.
  await run('git', ['push', '--no-verify', '-u', 'origin', branch], repoPath);

  let pr = await prForBranch(repoPath, branch);
  if (!pr || pr.state !== 'OPEN') {
    const issue = await deps.source.getIssue(number);
    const base = latestRunOf(deps, number)?.baseBranch ?? null;
    await run(
      'gh',
      [
        'pr',
        'create',
        '--head',
        branch,
        ...(base ? ['--base', base] : []),
        '--title',
        issue.title,
        '--body',
        `${issue.body?.trim() || issue.title}\n\n---\nTask #${String(number)}, implemented by a Kodra agent and approved in review.`,
      ],
      repoPath,
    );
    pr = await prForBranch(repoPath, branch);
    if (!pr) throw new Error(`opened a pull request for ${branch} but could not find it`);
  }
  known.set(key(deps, number), pr);
  await setStatus(deps, number, 'status:pr', 'agent:idle');
  return pr;
}

/** You merge once CI passed; the card then goes to Done. */
export async function mergePullRequest(
  deps: HandlerDeps,
  number: IssueRef,
): Promise<PullRequestPayload> {
  const repoPath = repoPathOf(deps);
  const pr = await prForBranch(repoPath, await branchOf(deps, number));
  if (!pr || pr.state !== 'OPEN') throw badRequest(`#${number} has no open pull request`);
  if (pr.ci === 'failed' || pr.ci === 'pending') {
    throw badRequest(
      `#${number}: CI has ${pr.ci === 'failed' ? 'failed' : 'not finished'}; merge once it passes`,
    );
  }
  await run('gh', ['pr', 'merge', String(pr.number), '--merge'], repoPath);
  return finishMerged(deps, number, { ...pr, state: 'MERGED' });
}

async function finishMerged(
  deps: HandlerDeps,
  number: IssueRef,
  pr: PullRequestPayload,
): Promise<PullRequestPayload> {
  known.set(key(deps, number), pr);
  // Stays open with status:done, like a card dragged to Done, so it shows
  // in the Done column (the board loads open issues only).
  await setStatus(deps, number, 'status:done', 'agent:idle');
  // The work is on the base branch now: the worktrees can go.
  const thread = deps.store.threads.findByIssue(deps.config.owner, deps.config.repo, number);
  if (thread) await sweepAllRunsForThread(deps, thread.id);
  return pr;
}

async function failedLogs(repoPath: string, branch: string): Promise<string> {
  try {
    const runs = JSON.parse(
      await run(
        'gh',
        [
          'run',
          'list',
          '--branch',
          branch,
          '--limit',
          '10',
          '--json',
          'databaseId,conclusion,name',
        ],
        repoPath,
      ),
    ) as Array<{ databaseId: number; conclusion: string; name: string }>;
    const failed = runs.filter((r) => r.conclusion === 'failure').slice(0, 2);
    const logs: string[] = [];
    for (const r of failed) {
      const log = await run('gh', ['run', 'view', String(r.databaseId), '--log-failed'], repoPath);
      logs.push(`### ${r.name}\n\`\`\`\n${log.slice(-LOG_LIMIT / failed.length)}\n\`\`\``);
    }
    return logs.join('\n\n');
  } catch {
    return '';
  }
}

/**
 * Makes sure the latest run has a worktree on `branch` so the agent resumes
 * on the PR's work rather than starting over from base: the worktree is
 * gone when the card went through Done before (which removes worktrees).
 */
async function ensureWorktreeOn(
  deps: HandlerDeps,
  number: IssueRef,
  branch: string,
): Promise<void> {
  const latest = latestRunOf(deps, number);
  const repoPath = deps.config.repoPath;
  if (!latest || !repoPath) return;
  if (latest.worktreePath && existsSync(latest.worktreePath)) return;
  const path = join(repoPath, '.kodra', 'worktrees', `issue-${String(number)}-pr`);
  if (!existsSync(path)) await run('git', ['worktree', 'add', path, branch], repoPath);
  deps.store.agentRuns.update(latest.id, { worktreePath: path, branchName: branch });
}

/** CI failed: back to In progress, resuming the agent with the failures. */
export async function sendBackForCi(
  deps: HandlerDeps,
  number: IssueRef,
  pr: PullRequestPayload,
): Promise<void> {
  const repoPath = repoPathOf(deps);
  const branch = await branchOf(deps, number);
  const logs = await failedLogs(repoPath, branch);
  await ensureWorktreeOn(deps, number, branch);
  sentBack.set(key(deps, number), pr.headSha);
  await setStatus(deps, number, 'status:in-progress', 'agent:running');
  await postMessage(deps, {
    number,
    body: [
      `CI failed on pull request #${pr.number} (${pr.url}): ${pr.failing.join(', ')}.`,
      '',
      logs || '(The failing job logs could not be fetched; run the checks locally to reproduce.)',
      '',
      `Fix the cause on branch ${branch} in this worktree, run the same checks locally until they pass, and commit. Do not push: once you finish, the card goes back through the checks and human review, and Kodra pushes your commits to the PR.`,
    ].join('\n'),
  });
}

/**
 * One watcher pass over the cards in the PR column: refresh each PR, move
 * merged ones to Done and send CI failures back to the agent (once per
 * head commit). Returns whether anything changed.
 */
export async function watchPullRequests(deps: HandlerDeps): Promise<boolean> {
  const repoPath = deps.config.repoPath;
  if (!repoPath) return false;
  const issues = await deps.source.listIssues({ state: 'open' });
  let changed = false;
  for (const issue of issues) {
    if (!issue.labels.includes('status:pr')) continue;
    const branch = await resolveBranch(deps, issue.number);
    if (!branch) continue;
    let pr: PullRequestPayload | null;
    try {
      pr = await prForBranch(repoPath, branch);
    } catch {
      continue; // gh unavailable or offline: try again next pass
    }
    if (!pr) continue;
    const k = key(deps, issue.number);
    const before = known.get(k);
    known.set(k, pr);
    if (before?.ci !== pr.ci || before?.state !== pr.state) changed = true;
    if (pr.state === 'MERGED') {
      await finishMerged(deps, issue.number, pr);
      changed = true;
    } else if (pr.state === 'OPEN' && pr.ci === 'failed' && sentBack.get(k) !== pr.headSha) {
      try {
        await sendBackForCi(deps, issue.number, pr);
        changed = true;
      } catch {
        // retried on the next pass
      }
    }
  }
  return changed;
}
