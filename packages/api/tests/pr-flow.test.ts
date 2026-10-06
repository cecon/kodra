import { describe, expect, it } from 'vitest';
import { priorityRank } from '../src/agent-queue.js';
import { buildTaskSystemPrompt, commitTypeOf } from '../src/handlers/issues.js';
import { branchOnRemote, ciOf, prTitle } from '../src/pr-flow.js';

describe('ciOf', () => {
  it('reports no CI when the PR has no checks', () => {
    expect(ciOf([])).toEqual({ ci: 'none', failing: [] });
  });

  it('waits for CI to start when the repo has workflows but no checks yet', () => {
    expect(ciOf([], true)).toEqual({ ci: 'pending', failing: [] });
  });

  it('is pending while any check run has not completed', () => {
    expect(
      ciOf([
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'test', status: 'IN_PROGRESS' },
      ]),
    ).toEqual({ ci: 'pending', failing: [] });
  });

  it('fails as soon as one check failed, naming it', () => {
    expect(
      ciOf([
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'test', status: 'IN_PROGRESS' },
      ]),
    ).toEqual({ ci: 'failed', failing: ['lint'] });
  });

  it('passes when every check run and status context succeeded', () => {
    expect(
      ciOf([
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { context: 'deploy/preview', state: 'SUCCESS' },
      ]),
    ).toEqual({ ci: 'passed', failing: [] });
  });

  it('treats a failing commit status like a failing check', () => {
    expect(ciOf([{ context: 'ci/legacy', state: 'ERROR' }])).toEqual({
      ci: 'failed',
      failing: ['ci/legacy'],
    });
  });
});

describe('prTitle', () => {
  it('prefixes the title with the card type as a conventional commit', () => {
    expect(prTitle('Start with Windows', ['type:feat'])).toBe('feat: Start with Windows');
    expect(prTitle('Fix login', ['type:fix'])).toBe('fix: Fix login');
    expect(prTitle('Pipeline cache', ['type:infra'])).toBe('ci: Pipeline cache');
  });

  it('leaves titles that already carry a prefix, or cards without a type', () => {
    expect(prTitle('feat(ui): Dark mode', ['type:feat'])).toBe('feat(ui): Dark mode');
    expect(prTitle('Something', ['priority:p1'])).toBe('Something');
  });
});

describe('card type and priority', () => {
  it('maps types to commit prefixes', () => {
    expect(commitTypeOf(['type:docs'])).toBe('docs');
    expect(commitTypeOf([])).toBeNull();
  });

  it('tells the agent how the type shapes the work', () => {
    const prompt = buildTaskSystemPrompt({ number: 3, title: 'Crash', labels: ['type:fix'] });
    expect(prompt).toContain('reproduce it with a test that fails');
    expect(prompt).toContain('"fix: <what changed>"');
    expect(buildTaskSystemPrompt({ number: 3, title: 'x' })).not.toContain('TASK_TYPE');
  });

  it('ranks P0 first and unprioritised last', () => {
    expect(priorityRank(['priority:p0'])).toBeLessThan(priorityRank(['priority:p3']));
    expect(priorityRank([])).toBeGreaterThan(priorityRank(['priority:p3']));
  });
});

describe('branchOnRemote', () => {
  it('turns the recorded base ref into a branch name for the PR', () => {
    expect(branchOnRemote('origin/main')).toBe('main');
    expect(branchOnRemote('refs/remotes/origin/develop')).toBe('develop');
    expect(branchOnRemote('main')).toBe('main');
    expect(branchOnRemote(null)).toBeNull();
  });
});
