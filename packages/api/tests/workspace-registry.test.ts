import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STAGES, WorkspaceRegistry } from '../src/workspace-registry.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'kodra-registry-'));
  dirs.push(root);
  const repo = async (name: string) => {
    const path = join(root, name);
    await mkdir(join(path, '.git'), { recursive: true });
    return path;
  };
  return { registry: new WorkspaceRegistry(join(root, 'data', 'workspaces.json')), repo, root };
}

describe('WorkspaceRegistry', () => {
  it('registers a repo with default stages and a colour, and persists it', async () => {
    const { registry, repo, root } = await setup();
    const saved = registry.save({ name: 'Livraria', path: await repo('livraria') });
    expect(saved.stages).toEqual(DEFAULT_STAGES);
    expect(saved.color).toMatch(/^#[0-9a-f]{6}$/i);
    const reread = new WorkspaceRegistry(join(root, 'data', 'workspaces.json'));
    expect(reread.list()).toEqual([saved]);
    expect(reread.findByPath(saved.path)?.id).toBe(saved.id);
  });

  it('updates stages and colour in place, keeping the rest', async () => {
    const { registry, repo } = await setup();
    const first = registry.save({ name: 'Kodra', path: await repo('kodra') });
    const updated = registry.save({
      id: first.id,
      name: 'Kodra',
      path: first.path,
      color: '#123456',
      stages: { review: false, autoMerge: true },
    });
    expect(updated).toMatchObject({ id: first.id, color: '#123456', createdAt: first.createdAt });
    expect(updated.stages).toEqual({ ...DEFAULT_STAGES, review: false, autoMerge: true });
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects folders that are not git repos and the same repo twice', async () => {
    const { registry, repo, root } = await setup();
    expect(() => registry.save({ name: 'x', path: root })).toThrow(/not a git repository/);
    const path = await repo('wa');
    registry.save({ name: 'WhatsApp', path });
    expect(() => registry.save({ name: 'again', path })).toThrow(/already the workspace/);
  });

  it('keeps trimmed scripts and drops empty ones', async () => {
    const { registry, repo } = await setup();
    const w = registry.save({
      name: 'Livraria',
      path: await repo('livraria'),
      scripts: { devServer: '  npm run dev:web ', setup: '   ' },
    });
    expect(w.scripts).toEqual({ devServer: 'npm run dev:web' });
    const cleared = registry.save({ id: w.id, name: w.name, path: w.path, scripts: {} });
    expect(cleared.scripts).toBeUndefined();
  });

  it('removes a workspace', async () => {
    const { registry, repo } = await setup();
    const w = registry.save({ name: 'tmp', path: await repo('tmp') });
    expect(registry.remove(w.id)).toBe(true);
    expect(registry.remove(w.id)).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});
