import { describe, expect, it } from 'vitest';
import { ciOf } from '../src/pr-flow.js';

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
