import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckCommand, CheckResult } from '@kanbots/dispatcher';
import { afterEach, describe, expect, it } from 'vitest';
import {
  failureReport,
  gateStateOf,
  reviewGateFor,
  startReviewGate,
  type ReviewGateDeps,
} from '../src/review-gate.js';
import { issueFixture } from './helpers/fixtures.js';
import { makeHandlerTestKit } from './helpers/make-handlers.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function npmWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kodra-gate-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }),
  );
  await writeFile(join(dir, 'package-lock.json'), '{}');
  // A committed checkout, like the agent leaves when it is done.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return dir;
}

/** A gate wired to the test kit, running checks through `outcome`. */
async function setup(outcome: (command: CheckCommand) => CheckResult['status']) {
  const kit = makeHandlerTestKit();
  const worktree = await npmWorktree();
  kit.source.setIssue(issueFixture(7, 'gate', { labels: ['status:review', 'agent:idle'] }));
  const thread = kit.store.threads.create({ repoOwner: 'octo', repoName: 'hello', issueNumber: 7 });
  const run = kit.store.agentRuns.create({ threadId: thread.id });
  kit.store.agentRuns.update(run.id, { worktreePath: worktree });
  const commands: CheckCommand[] = [];
  const runCheckImpl: ReviewGateDeps['runCheckImpl'] = async ({ command }) => {
    commands.push(command);
    return { kind: command.kind, status: outcome(command), durationMs: 1, summary: 'out' };
  };
  const deps = {
    store: kit.store,
    supervisor: kit.supervisor,
    config: { ...kit.config, repoPath: null },
    runCheckImpl,
  } as unknown as ReviewGateDeps;
  return { kit, deps, runId: run.id, commands, worktree };
}

async function settled(deps: ReviewGateDeps, runId: number) {
  for (let i = 0; i < 50; i++) {
    const checks = deps.store.checks.listLatestByRun(runId);
    if (!checks.some((c) => c.status === 'running')) return checks;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('gate never settled');
}

describe('review gate', () => {
  it('installs missing dependencies first, then runs the scripts the project has', async () => {
    const { deps, runId, commands } = await setup(() => 'pass');
    const rows = await startReviewGate(deps, runId);
    expect(rows.map((r) => r.kind)).toEqual(['commit', 'install', 'lint', 'tests']);
    expect(rows[0]?.status).toBe('pass');
    expect(gateStateOf(rows)).toBe('checking');
    const checks = await settled(deps, runId);
    expect(gateStateOf(checks)).toBe('passed');
    expect(commands[0]).toMatchObject({ command: 'npm', args: ['ci'] });
    expect(commands.slice(1).map((c) => c.args)).toEqual([
      ['run', 'lint'],
      ['run', 'test'],
    ]);
  });

  it('fails every check when the install fails, and reports them to the agent', async () => {
    const { deps, runId, commands } = await setup((c) => (c.kind === 'install' ? 'fail' : 'pass'));
    await startReviewGate(deps, runId);
    const checks = await settled(deps, runId);
    expect(commands).toHaveLength(1);
    expect(gateStateOf(checks)).toBe('failed');
    const gate = reviewGateFor(deps, deps.store.agentRuns.findById(runId));
    expect(gate?.state).toBe('failed');
    expect(failureReport(gate!)).toContain('### lint');
  });

  it('fails when the agent left uncommitted work', async () => {
    const { deps, runId, worktree } = await setup(() => 'pass');
    await writeFile(join(worktree, 'README.md'), 'changed but not committed');
    await startReviewGate(deps, runId);
    const checks = await settled(deps, runId);
    const commit = checks.find((c) => c.kind === 'commit');
    expect(commit?.status).toBe('fail');
    expect(commit?.summary).toContain('README.md');
    expect(gateStateOf(checks)).toBe('failed');
  });

  it('attaches the gate to Review cards in the board list', async () => {
    const { kit, deps, runId } = await setup((c) => (c.kind === 'lint' ? 'fail' : 'pass'));
    await startReviewGate(deps, runId);
    await settled(deps, runId);
    const [card] = await kit.handlers['issues:list']({});
    expect(card?.reviewGate).toMatchObject({ runId, state: 'failed' });
  });

  it('refuses to send back a card whose checks did not fail', async () => {
    const { kit } = await setup(() => 'pass');
    await expect(kit.handlers['review-gate:send-back']({ number: 7 })).rejects.toThrow(
      /no failed checks/,
    );
  });
});
