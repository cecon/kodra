import type { Issue } from '@kanbots/core';
import { DEFAULT_AGENT_SETTINGS } from './workspace-registry.js';
import { dispatch } from './handlers/issues.js';
import type { HandlerDeps } from './handlers/types.js';

/**
 * Agents run up to a limit (Configure → Workspaces → Agents at once). A
 * card entering In progress beyond it waits there as "Queued", and queued
 * cards start by priority (P0 first, then oldest) as slots free up — when
 * a run completes and on the host's periodic pass.
 */

const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

export function maxAgents(deps: HandlerDeps): number {
  return deps.registry?.settings().maxAgents ?? DEFAULT_AGENT_SETTINGS.maxAgents;
}

export function liveRunCount(deps: HandlerDeps): number {
  return deps.store.agentRuns.listActiveForRepo(deps.config.owner, deps.config.repo).length;
}

export function priorityRank(labels: readonly string[]): number {
  const p = labels.find((l) => l.startsWith('priority:'))?.slice('priority:'.length) ?? '';
  return PRIORITY_RANK[p] ?? 4;
}

export function isQueued(issue: Pick<Issue, 'labels'>): boolean {
  return issue.labels.includes('status:in-progress') && issue.labels.includes('agent:queued');
}

/** Starts queued cards, highest priority first, while slots are free. */
export async function drainQueue(deps: HandlerDeps): Promise<number> {
  let free = maxAgents(deps) - liveRunCount(deps);
  if (free <= 0) return 0;
  const queued = (await deps.source.listIssues({ state: 'open' }))
    .filter(isQueued)
    .sort(
      (a, b) =>
        priorityRank(a.labels) - priorityRank(b.labels) || a.createdAt.localeCompare(b.createdAt),
    );
  let started = 0;
  for (const issue of queued) {
    if (free <= 0) break;
    try {
      const result = await dispatch(deps, { number: issue.number, fromStatus: 'inProgress' });
      if (result.run) {
        started += 1;
        free -= 1;
      }
    } catch {
      // Can't start this one (e.g. its workspace is gone): leave it queued.
    }
  }
  return started;
}
