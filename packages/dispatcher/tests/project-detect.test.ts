import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject, installCommand, planChecks } from '../src/project-detect.js';

const dirs: string[] = [];

async function project(files: Record<string, string>, nodeModules = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kodra-detect-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  if (nodeModules) await mkdir(join(dir, 'node_modules'));
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('detectProject', () => {
  it('reads the package manager from the lockfile and the scripts from package.json', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }),
      'package-lock.json': '{}',
    });
    const info = await detectProject(dir);
    expect(info).toMatchObject({
      hasPackageJson: true,
      packageManager: 'npm',
      hasNodeModules: false,
    });
    expect([...info.scripts].sort()).toEqual(['lint', 'test']);
  });

  it('prefers pnpm when its lockfile is present', async () => {
    const dir = await project(
      { 'package.json': '{}', 'pnpm-lock.yaml': '', 'package-lock.json': '{}' },
      true,
    );
    expect(await detectProject(dir)).toMatchObject({
      packageManager: 'pnpm',
      hasNodeModules: true,
    });
  });

  it('reports no project without a package.json', async () => {
    const dir = await project({ 'README.md': '# hi' });
    expect(await detectProject(dir)).toMatchObject({ hasPackageJson: false, packageManager: null });
  });
});

describe('planChecks', () => {
  const info = {
    hasPackageJson: true,
    packageManager: 'npm' as const,
    scripts: new Set(['lint', 'test']),
    hasNodeModules: true,
  };

  it('runs only the kinds the project has a script for, through its package manager', () => {
    expect(planChecks(info, ['lint', 'typecheck', 'tests'])).toEqual([
      { kind: 'lint', command: 'npm', args: ['run', 'lint'] },
      { kind: 'tests', command: 'npm', args: ['run', 'test'] },
    ]);
  });

  it('lets a configured override win, even without a script', () => {
    expect(
      planChecks(info, ['typecheck'], { typecheck: { command: 'tsc', args: ['--noEmit'] } }),
    ).toEqual([{ kind: 'typecheck', command: 'tsc', args: ['--noEmit'] }]);
  });
});

describe('installCommand', () => {
  it('installs from the lockfile without updating it', () => {
    expect(installCommand('npm')).toMatchObject({ command: 'npm', args: ['ci'] });
    expect(installCommand('pnpm')).toMatchObject({ args: ['install', '--frozen-lockfile'] });
  });
});
