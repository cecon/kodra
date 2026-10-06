import { z } from 'zod';
import type { WorkspaceProfilePayload } from '../bridge.js';
import { WorkspaceRegistryError, type WorkspaceRegistry } from '../workspace-registry.js';
import { badRequest, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const stagesSchema = z
  .object({
    spec: z.boolean(),
    checks: z.boolean(),
    checkKinds: z.array(z.enum(['lint', 'typecheck', 'tests'])),
    review: z.boolean(),
    pr: z.boolean(),
    autoMerge: z.boolean(),
  })
  .partial()
  .strict();

const saveSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).max(80),
    path: z.string().min(1),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    baseBranch: z.string().min(1).nullable().optional(),
    stages: stagesSchema.optional(),
    scripts: z
      .object({
        devServer: z.string().max(2_000).optional(),
        setup: z.string().max(2_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const removeSchema = z.object({ id: z.string().min(1) }).strict();

function registryOf(deps: HandlerDeps): WorkspaceRegistry {
  if (!deps.registry) throw badRequest('the workspace registry is not available in this build');
  return deps.registry;
}

export function list(deps: HandlerDeps): WorkspaceProfilePayload[] {
  return registryOf(deps).list();
}

export function save(deps: HandlerDeps, args: unknown): WorkspaceProfilePayload {
  const parsed = parseArgs(saveSchema, args);
  try {
    return registryOf(deps).save({
      name: parsed.name,
      path: parsed.path,
      ...(parsed.id !== undefined ? { id: parsed.id } : {}),
      ...(parsed.color !== undefined ? { color: parsed.color } : {}),
      ...(parsed.baseBranch !== undefined ? { baseBranch: parsed.baseBranch } : {}),
      ...(parsed.stages !== undefined ? { stages: stripUndefined(parsed.stages) } : {}),
      ...(parsed.scripts !== undefined ? { scripts: stripUndefined(parsed.scripts) } : {}),
    });
  } catch (err) {
    if (err instanceof WorkspaceRegistryError) throw badRequest(err.message);
    throw err;
  }
}

export function remove(deps: HandlerDeps, args: unknown): { removed: boolean } {
  const parsed = parseArgs(removeSchema, args);
  return { removed: registryOf(deps).remove(parsed.id) };
}

function stripUndefined<T extends object>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
