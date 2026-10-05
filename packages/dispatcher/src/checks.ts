import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

/** `install` is the review gate's dependency install, recorded like a check. */
export type CheckKind = 'install' | 'typecheck' | 'tests' | 'lint' | 'e2e';
export type CheckStatus = 'idle' | 'running' | 'pass' | 'fail';

export interface CheckCommand {
  kind: CheckKind;
  command: string;
  args: string[];
}

export interface CheckResult {
  kind: CheckKind;
  /** `stopped`: aborted through `signal` before it finished. */
  status: 'pass' | 'fail' | 'stopped';
  durationMs: number;
  summary: string;
}

export interface RunCheckOptions {
  cwd: string;
  command: CheckCommand;
  timeoutMs?: number;
  /** Aborting kills the command (its whole process tree) and resolves
   *  the check as `stopped`. */
  signal?: AbortSignal;
  spawn?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; shell?: boolean },
  ) => ChildProcess;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function defaultCheckCommand(kind: CheckKind): CheckCommand {
  switch (kind) {
    case 'install':
      return { kind, command: 'pnpm', args: ['install', '--frozen-lockfile'] };
    case 'typecheck':
      return { kind, command: 'pnpm', args: ['typecheck'] };
    case 'tests':
      return { kind, command: 'pnpm', args: ['test'] };
    case 'lint':
      return { kind, command: 'pnpm', args: ['lint'] };
    case 'e2e':
      return { kind, command: 'pnpm', args: ['e2e'] };
  }
}

export type CheckCommandOverride = { command: string; args: string[] };
export type CheckCommandOverrides = Partial<Record<CheckKind, CheckCommandOverride>>;

export function resolveCheckCommand(
  kind: CheckKind,
  overrides?: CheckCommandOverrides | null,
): CheckCommand {
  const override = overrides?.[kind];
  if (override && typeof override.command === 'string' && Array.isArray(override.args)) {
    return { kind, command: override.command, args: [...override.args] };
  }
  return defaultCheckCommand(kind);
}

export async function runCheck(opts: RunCheckOptions): Promise<CheckResult> {
  const spawn = opts.spawn ?? nodeSpawn;
  const start = Date.now();
  return await new Promise<CheckResult>((resolve) => {
    // Windows ships package managers as .cmd shims (pnpm.cmd, npm.cmd) that
    // only a shell resolves; spawning `pnpm` directly fails with ENOENT.
    const child = spawn(opts.command.command, opts.command.args, {
      cwd: opts.cwd,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let stopped = false;

    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const onAbort = (): void => {
      stopped = true;
      killTree(child);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        kind: opts.command.kind,
        status: 'fail',
        durationMs: Date.now() - start,
        summary: `spawn error: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - start;
      const status: CheckResult['status'] = stopped
        ? 'stopped'
        : !killed && code === 0
          ? 'pass'
          : 'fail';
      const summary = stopped ? 'stopped' : summarize(stdout, stderr, code, killed);
      resolve({ kind: opts.command.kind, status, durationMs, summary });
    });
  });
}

/** With a shell in between (Windows), killing the child only ends cmd.exe;
 *  taskkill /T takes the command it started down with it. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F']).on('error', () => {
      child.kill('SIGTERM');
    });
    return;
  }
  child.kill('SIGTERM');
}

function summarize(stdout: string, stderr: string, code: number | null, killed: boolean): string {
  if (killed) return 'timed out';
  const tailOut = stdout.split('\n').slice(-6).join('\n').trim();
  const tailErr = stderr.split('\n').slice(-3).join('\n').trim();
  const head = `exit ${code}`;
  return [head, tailOut, tailErr].filter(Boolean).join(' · ').slice(0, 600);
}
