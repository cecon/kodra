import {
  detectProject,
  installCommand,
  planChecks,
  runCheck,
  type CheckCommand,
  type CheckResult,
} from '@kanbots/dispatcher';
import type { AgentCheck, AgentRun } from '@kanbots/local-store';
import type { ReviewGatePayload, ReviewGateState } from './bridge.js';
import { afterGatePassed } from './card-flow.js';
import { finishCheck, loadCheckOverrides } from './handlers/agent-checks.js';
import type { HandlerDeps } from './handlers/types.js';
import { describeChanges, uncommittedChanges } from './worktree-guard.js';

/**
 * Pre-review gate. When an agent run finishes and its card lands in Review,
 * the run's worktree gets its dependencies installed (when missing) and the
 * project's lint / typecheck / tests run against it. While that happens the
 * card is locked; it passes to human review only when everything is green,
 * and a failure can only go back to the agent, with the errors as its
 * instructions.
 *
 * Results are ordinary agent_checks rows (the install step as kind
 * `install`), so the existing checks UI shows them too.
 */

const GATE_KINDS = ['lint', 'typecheck', 'tests'] as const;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;

const running = new Map<number, AbortController>();

export type RunCheckFn = (opts: {
  cwd: string;
  command: CheckCommand;
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<CheckResult>;

export interface ReviewGateDeps extends HandlerDeps {
  runCheckImpl?: RunCheckFn;
}

function record(deps: HandlerDeps, row: AgentCheck, result: CheckResult): void {
  finishCheck(deps, row.id, result.status === 'stopped' ? 'idle' : result.status, result.summary);
}

/**
 * Starts (or restarts) the gate for a run. Returns the check rows it
 * created, all `running`; an empty list means the worktree has nothing to
 * check (no package.json scripts and no configured check commands).
 */
export async function startReviewGate(deps: ReviewGateDeps, runId: number): Promise<AgentCheck[]> {
  const run = deps.store.agentRuns.findById(runId);
  if (!run?.worktreePath) return [];
  stopReviewGate(runId);
  const cwd = run.worktreePath;

  // The work has to be committed: Done, Ship and deleting the worktree all
  // lose anything that is only on disk.
  const commitRow = deps.store.checks.start({ agentRunId: runId, kind: 'commit' });
  deps.supervisor.notifyChecksChanged(runId);
  const changes = await uncommittedChanges(cwd);
  const committed = finishCheck(
    deps,
    commitRow.id,
    changes !== null && changes.length === 0 ? 'pass' : 'fail',
    changes === null
      ? 'worktree not found'
      : changes.length === 0
        ? 'all work committed'
        : `uncommitted changes (commit them):
${describeChanges(changes)}`,
  );

  // The workspace's stages pick the checks; the commit check above always
  // runs, since uncommitted work is lost on Done.
  const profile = run.workspaceId ? (deps.registry?.get(run.workspaceId) ?? null) : null;
  const kinds = !profile
    ? GATE_KINDS
    : profile.stages.checks
      ? GATE_KINDS.filter((k) => profile.stages.checkKinds.includes(k))
      : [];
  const project = await detectProject(cwd);
  const checks = planChecks(
    project,
    kinds,
    await loadCheckOverrides(deps, run.repoPath ?? deps.config.repoPath ?? null),
  );
  if (checks.length === 0) {
    if (committed.status === 'pass') void advanceIfPassed(deps, runId);
    return [committed];
  }
  // The workspace's setup script prepares the worktree when it has one;
  // otherwise missing dependencies are installed from the lockfile.
  const setup = profile?.scripts?.setup;
  const needsInstall =
    project.packageManager !== null &&
    !project.hasNodeModules &&
    checks.some((c) => c.command === project.packageManager);
  const install: CheckCommand | null = setup
    ? shellCommand('install', setup)
    : needsInstall && project.packageManager
      ? installCommand(project.packageManager)
      : null;

  const controller = new AbortController();
  running.set(runId, controller);
  const steps = install ? [install, ...checks] : checks;
  const rows = steps.map((step) => deps.store.checks.start({ agentRunId: runId, kind: step.kind }));
  deps.supervisor.notifyChecksChanged(runId);

  const exec: RunCheckFn = deps.runCheckImpl ?? ((opts) => runCheck(opts));
  void (async () => {
    let checkRows = rows;
    if (install) {
      const [installRow, ...rest] = rows;
      checkRows = rest;
      const result = await exec({
        cwd,
        command: install,
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal: controller.signal,
      });
      record(deps, installRow!, result);
      if (result.status !== 'pass') {
        // Nothing can be checked without dependencies.
        for (const row of checkRows) {
          finishCheck(
            deps,
            row.id,
            result.status === 'stopped' ? 'idle' : 'fail',
            result.status === 'stopped' ? 'stopped' : 'skipped: dependency install failed',
          );
        }
        return;
      }
    }
    await Promise.all(
      checkRows.map(async (row, i) => {
        const result = await exec({
          cwd,
          command: checks[i]!,
          timeoutMs: CHECK_TIMEOUT_MS,
          signal: controller.signal,
        });
        record(deps, row, result);
      }),
    );
  })()
    .catch((err: unknown) => {
      // Leave no row stuck at `running`.
      const message = err instanceof Error ? err.message : String(err);
      for (const row of deps.store.checks.listLatestByRun(runId)) {
        if (row.status === 'running') finishCheck(deps, row.id, 'fail', message);
      }
    })
    .finally(() => {
      if (running.get(runId) === controller) running.delete(runId);
      void advanceIfPassed(deps, runId);
    });

  return [committed, ...rows];
}

/** A shell command line as a check: cmd on Windows (runCheck spawns it
 *  through a shell there), `sh -c` elsewhere. */
function shellCommand(kind: CheckCommand['kind'], line: string): CheckCommand {
  return process.platform === 'win32'
    ? { kind, command: line, args: [] }
    : { kind, command: 'sh', args: ['-c', line] };
}

/** A green gate moves on by itself when the workspace skips human review. */
async function advanceIfPassed(deps: HandlerDeps, runId: number): Promise<void> {
  if (gateStateOf(deps.store.checks.listLatestByRun(runId)) !== 'passed') return;
  try {
    await afterGatePassed(deps, runId);
  } catch (err) {
    console.warn(`[review-gate] could not advance run ${runId}:`, err);
  }
}

/** Aborts a running gate; its checks end as stopped (`idle`). */
export function stopReviewGate(runId: number): boolean {
  const controller = running.get(runId);
  if (!controller) return false;
  running.delete(runId);
  controller.abort();
  return true;
}

export function gateStateOf(checks: readonly AgentCheck[]): ReviewGateState | null {
  if (checks.length === 0) return null;
  if (checks.some((c) => c.status === 'running')) return 'checking';
  if (checks.some((c) => c.status === 'fail')) return 'failed';
  if (checks.some((c) => c.status === 'idle')) return 'stopped';
  return 'passed';
}

export function reviewGateFor(deps: HandlerDeps, run: AgentRun | null): ReviewGatePayload | null {
  if (!run) return null;
  const checks = deps.store.checks.listLatestByRun(run.id);
  const state = gateStateOf(checks);
  if (state === null) return null;
  return {
    runId: run.id,
    state,
    checks: checks.map((c) => ({ kind: c.kind, status: c.status, summary: c.summary })),
  };
}

/** The message that sends a failed gate back to the agent. */
export function failureReport(gate: ReviewGatePayload): string {
  const failed = gate.checks.filter((c) => c.status === 'fail');
  const lines = failed.map(
    (c) => `### ${c.kind}\n\`\`\`\n${(c.summary ?? 'failed').trim()}\n\`\`\``,
  );
  return [
    'The pre-review checks failed on your branch, so the task went back to you instead of to human review.',
    '',
    ...lines,
    '',
    'Fix the cause of each failure in this worktree, run the same checks yourself until they pass, and commit. Do not push: Kodra pushes after human review. The checks run again when you finish.',
  ].join('\n');
}
