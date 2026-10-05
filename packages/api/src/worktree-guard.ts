import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { IssueRef } from '@kanbots/core';
import { badRequest } from './handlers/errors.js';
import type { HandlerDeps } from './handlers/types.js';

const execFileAsync = promisify(execFile);

/**
 * Files with uncommitted changes in a worktree, as `git status --porcelain`
 * lines (untracked files included). Null when the path is gone or isn't a
 * git checkout.
 */
export async function uncommittedChanges(worktreePath: string): Promise<string[] | null> {
  if (!existsSync(worktreePath)) return null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: worktreePath },
    );
    return stdout.split('\n').filter((line) => line.trim() !== '');
  } catch {
    return null;
  }
}

export function describeChanges(lines: readonly string[], max = 15): string {
  const shown = lines.slice(0, max).join('\n');
  return lines.length > max ? `${shown}\n… and ${lines.length - max} more` : shown;
}

/**
 * Refuses to close a card while one of its worktrees holds uncommitted
 * work: Done removes those worktrees, and their changes would go with them.
 */
export async function assertNoUncommittedWork(deps: HandlerDeps, number: IssueRef): Promise<void> {
  const thread = deps.store.threads.findByIssue(deps.config.owner, deps.config.repo, number);
  if (!thread) return;
  for (const run of deps.store.agentRuns.listByThread(thread.id)) {
    if (!run.worktreePath) continue;
    const changes = await uncommittedChanges(run.worktreePath);
    if (changes && changes.length > 0) {
      throw badRequest(
        `#${number} has ${changes.length} uncommitted change${changes.length === 1 ? '' : 's'} in ${run.worktreePath}. ` +
          'Closing the card would delete them: send it back to the agent to commit them, or delete the card to discard them.\n' +
          describeChanges(changes),
      );
    }
  }
}
