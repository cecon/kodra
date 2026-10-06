import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  WorkspaceProfilePayload,
  WorkspaceScriptsPayload,
  WorkspaceStages,
} from './bridge.js';

/**
 * The app-level registry of workspaces: the repos cards can act on. Each
 * entry carries the colour its cards wear on the board and the stages its
 * cards go through (local checks, human review, PR + CI, auto merge).
 *
 * It lives in the app's data folder (workspace-registry.json) rather than in any repo, so the board
 * is not tied to the folder the app was opened on. Stored as one small JSON
 * file, written atomically.
 */

export const DEFAULT_STAGES: WorkspaceStages = {
  checks: true,
  checkKinds: ['lint', 'typecheck', 'tests'],
  review: true,
  pr: true,
  autoMerge: false,
};

/** Board-friendly colours offered for new workspaces, in order. */
export const WORKSPACE_COLORS = [
  '#4680ff',
  '#2ca87f',
  '#e58a00',
  '#dc2626',
  '#7265e6',
  '#13c2c2',
  '#d6336c',
  '#5b6b79',
] as const;

export interface SaveWorkspaceInput {
  id?: string;
  name: string;
  path: string;
  color?: string;
  baseBranch?: string | null;
  stages?: Partial<WorkspaceStages>;
  scripts?: WorkspaceScriptsPayload;
}

interface RegistryFile {
  version: 1;
  workspaces: WorkspaceProfilePayload[];
}

/** Trimmed, non-empty scripts only; undefined when none is set. */
function cleanScripts(
  scripts: WorkspaceScriptsPayload | undefined,
): { scripts: WorkspaceScriptsPayload } | undefined {
  if (!scripts) return undefined;
  const out: WorkspaceScriptsPayload = {};
  const dev = scripts.devServer?.trim();
  const setup = scripts.setup?.trim();
  if (dev) out.devServer = dev;
  if (setup) out.setup = setup;
  return Object.keys(out).length > 0 ? { scripts: out } : undefined;
}

export class WorkspaceRegistryError extends Error {
  override name = 'WorkspaceRegistryError';
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    resolve(p)
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

export class WorkspaceRegistry {
  constructor(private readonly file: string) {}

  private read(): RegistryFile {
    if (!existsSync(this.file)) return { version: 1, workspaces: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RegistryFile>;
      return { version: 1, workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [] };
    } catch {
      return { version: 1, workspaces: [] };
    }
  }

  private write(data: RegistryFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }

  list(): WorkspaceProfilePayload[] {
    return this.read().workspaces;
  }

  get(id: string): WorkspaceProfilePayload | null {
    return this.list().find((w) => w.id === id) ?? null;
  }

  findByPath(path: string): WorkspaceProfilePayload | null {
    return this.list().find((w) => samePath(w.path, path)) ?? null;
  }

  save(input: SaveWorkspaceInput): WorkspaceProfilePayload {
    const name = input.name.trim();
    if (!name) throw new WorkspaceRegistryError('A workspace needs a name');
    const path = resolve(input.path.trim());
    if (!existsSync(join(path, '.git'))) {
      throw new WorkspaceRegistryError(`${path} is not a git repository`);
    }
    const data = this.read();
    const clash = data.workspaces.find((w) => samePath(w.path, path) && w.id !== input.id);
    if (clash) throw new WorkspaceRegistryError(`${path} is already the workspace "${clash.name}"`);

    const existing = input.id ? data.workspaces.find((w) => w.id === input.id) : undefined;
    if (input.id && !existing) throw new WorkspaceRegistryError(`workspace ${input.id} not found`);
    const color =
      input.color ??
      existing?.color ??
      WORKSPACE_COLORS[data.workspaces.length % WORKSPACE_COLORS.length]!;
    const profile: WorkspaceProfilePayload = {
      id: existing?.id ?? randomUUID(),
      name,
      path,
      color,
      baseBranch:
        input.baseBranch !== undefined ? input.baseBranch : (existing?.baseBranch ?? null),
      stages: { ...DEFAULT_STAGES, ...existing?.stages, ...input.stages },
      ...(cleanScripts(input.scripts ?? existing?.scripts) ?? {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    data.workspaces = existing
      ? data.workspaces.map((w) => (w.id === profile.id ? profile : w))
      : [...data.workspaces, profile];
    this.write(data);
    return profile;
  }

  remove(id: string): boolean {
    const data = this.read();
    const next = data.workspaces.filter((w) => w.id !== id);
    if (next.length === data.workspaces.length) return false;
    this.write({ ...data, workspaces: next });
    return true;
  }
}
