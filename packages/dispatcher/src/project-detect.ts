import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckCommand, CheckCommandOverrides, CheckKind } from './checks.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/** What the review gate needs to know about a worktree's JS project. */
export interface ProjectInfo {
  hasPackageJson: boolean;
  /** From the lockfile; npm when there is a package.json and no lockfile. */
  packageManager: PackageManager | null;
  scripts: ReadonlySet<string>;
  hasNodeModules: boolean;
}

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

export async function detectProject(cwd: string): Promise<ProjectInfo> {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    return {
      hasPackageJson: false,
      packageManager: null,
      scripts: new Set(),
      hasNodeModules: false,
    };
  }
  let scripts = new Set<string>();
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    scripts = new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    // unreadable package.json: no scripts to run
  }
  const lock = LOCKFILES.find(([file]) => existsSync(join(cwd, file)));
  return {
    hasPackageJson: true,
    packageManager: lock ? lock[1] : 'npm',
    scripts,
    hasNodeModules: existsSync(join(cwd, 'node_modules')),
  };
}

/** Installs exactly what the lockfile pins, so the gate checks what the
 *  branch declares rather than whatever resolves today. */
export function installCommand(pm: PackageManager): CheckCommand {
  switch (pm) {
    case 'pnpm':
      return { kind: 'install', command: 'pnpm', args: ['install', '--frozen-lockfile'] };
    case 'yarn':
      return { kind: 'install', command: 'yarn', args: ['install', '--frozen-lockfile'] };
    case 'bun':
      return { kind: 'install', command: 'bun', args: ['install', '--frozen-lockfile'] };
    case 'npm':
      return { kind: 'install', command: 'npm', args: ['ci'] };
  }
}

/** package.json script each check kind runs, in order of preference. */
const SCRIPTS_FOR_KIND: Record<Exclude<CheckKind, 'install' | 'commit'>, readonly string[]> = {
  typecheck: ['typecheck', 'type-check', 'tsc'],
  lint: ['lint'],
  tests: ['test'],
  e2e: ['e2e', 'test:e2e'],
};

/**
 * The checks a project can actually run: a configured override always
 * wins, otherwise the kind runs only when package.json has a script for
 * it, through the project's own package manager.
 */
export function planChecks(
  project: ProjectInfo,
  kinds: readonly Exclude<CheckKind, 'install' | 'commit'>[],
  overrides?: CheckCommandOverrides | null,
): CheckCommand[] {
  const out: CheckCommand[] = [];
  for (const kind of kinds) {
    const override = overrides?.[kind];
    if (override) {
      out.push({ kind, command: override.command, args: [...override.args] });
      continue;
    }
    if (!project.packageManager) continue;
    const script = SCRIPTS_FOR_KIND[kind].find((s) => project.scripts.has(s));
    if (script) out.push({ kind, command: project.packageManager, args: ['run', script] });
  }
  return out;
}
