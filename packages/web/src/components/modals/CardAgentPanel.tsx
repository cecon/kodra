import { useEffect, useState, type ReactNode } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { WorkspaceProfilePayload } from '@kanbots/api';
import { IconsaxIcon } from '@kanbots/ui';
import { ArrowDown2, Folder2 } from 'iconsax-react';
import { api } from '../../api.js';
import { dispatchIssuesRefetch } from '../../hooks/useIssues.js';
import type { AgentCheck, AgentRun, AgentRunStatus, Issue } from '../../types.js';

/**
 * The card's agent at a glance, in the task detail sidebar: its state and
 * numbers, where it works (workspace, branch, worktree) and its context —
 * the instructions it was given and the last prompt it received.
 *
 * Built from MUI parts only (no form inputs): the detail body still carries
 * the legacy `.kb-app` CSS, which restyles native inputs.
 */

const LIVE: ReadonlySet<AgentRunStatus> = new Set(['starting', 'running', 'awaiting_input']);

const STATUS: Record<
  AgentRunStatus,
  { label: string; color: 'success' | 'warning' | 'error' | 'info' | 'secondary' }
> = {
  starting: { label: 'Iniciando', color: 'info' },
  running: { label: 'Rodando', color: 'success' },
  awaiting_input: { label: 'Esperando você', color: 'warning' },
  complete: { label: 'Concluído', color: 'info' },
  failed: { label: 'Falhou', color: 'error' },
  stopped: { label: 'Parado', color: 'secondary' },
};

const CHECK_LABEL: Record<string, string> = {
  commit: 'commit',
  install: 'deps',
  typecheck: 'tsc',
  tests: 'tests',
  lint: 'lint',
  e2e: 'e2e',
};

function fmtElapsed(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return '—';
  const sec = Math.max(
    0,
    Math.floor(((endIso ? new Date(endIso).getTime() : Date.now()) - start) / 1000),
  );
  const m = Math.floor(sec / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}h ${m % 60}m`
    : `${m}m ${String(sec % 60).padStart(2, '0')}s`;
}

function fmtTokens(n: number | null): string {
  if (n === null) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const mono = { fontFamily: 'var(--ff-mono, monospace)' };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={1.25}>
      <Typography
        variant="caption"
        sx={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}
        color="text.secondary"
      >
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="subtitle2" noWrap sx={mono}>
        {value}
      </Typography>
    </Box>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ width: 64, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Stack>
  );
}

function ContextBlock({ title, text }: { title: string; text: string | null }) {
  return (
    <Accordion
      disableGutters
      elevation={0}
      sx={{
        bgcolor: 'transparent',
        border: 1,
        borderColor: 'divider',
        '&:before': { display: 'none' },
      }}
    >
      <AccordionSummary
        expandIcon={<IconsaxIcon icon={ArrowDown2} size={14} />}
        sx={{ minHeight: 36 }}
      >
        <Typography variant="subtitle2">{title}</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        {text ? (
          <Box
            component="pre"
            sx={{
              ...mono,
              m: 0,
              p: 1,
              maxHeight: 260,
              overflow: 'auto',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              bgcolor: 'background.default',
              borderRadius: 1,
            }}
          >
            {text}
          </Box>
        ) : (
          <Typography variant="caption" color="text.secondary">
            Não registrado (runs anteriores a esta versão).
          </Typography>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

export function CardAgentPanel({
  issue,
  run,
  onChanged,
}: {
  issue: Issue;
  /** The live run, else the latest one. */
  run: AgentRun | null;
  onChanged: () => void;
}) {
  const [profiles, setProfiles] = useState<WorkspaceProfilePayload[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [checks, setChecks] = useState<AgentCheck[]>([]);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void api
      .listWorkspaceProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    void api
      .listIssueRuns(issue.number)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [issue.number, run?.id, run?.status]);

  const runId = run?.id ?? null;
  useEffect(() => {
    if (runId === null) return setChecks([]);
    void api
      .getAgentRunChecks(runId)
      .then(setChecks)
      .catch(() => setChecks([]));
  }, [runId, tick]);

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge || runId === null) return;
    return bridge.subscribe('checks:changed', (payload: unknown) => {
      if (payload !== null && typeof payload === 'object' && 'runId' in payload) {
        if (payload.runId === runId) setTick((t) => t + 1);
      }
    });
  }, [runId]);

  const live = run !== null && LIVE.has(run.status);
  const workspace = profiles.find((w) => w.id === issue.workspaceId) ?? null;
  const status = run ? STATUS[run.status] : null;
  const otherWorktrees = runs.filter((r) => r.worktreePath && r.id !== run?.id);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      dispatchIssuesRefetch();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Stack spacing={2.5}>
      <Section title="Agente">
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
          {status ? (
            <Chip size="small" variant="light" color={status.color} label={status.label} />
          ) : (
            <Chip size="small" variant="outlined" label="Ainda não rodou" />
          )}
          {run?.model ? (
            <Chip
              size="small"
              variant="outlined"
              label={`${run.provider ? `${run.provider} · ` : ''}${run.model}`}
              sx={mono}
            />
          ) : null}
          {run ? <Chip size="small" variant="outlined" label={`run #${run.id}`} sx={mono} /> : null}
        </Stack>
        {run ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
            <Metric label="Tempo" value={fmtElapsed(run.startedAt, run.endedAt)} />
            <Metric
              label="Custo (estimado)"
              value={run.totalCostUsd !== null ? `$${run.totalCostUsd.toFixed(2)}` : '—'}
            />
            <Metric label="Tokens entrada" value={fmtTokens(run.tokenUsageInput)} />
            <Metric label="Tokens saída" value={fmtTokens(run.tokenUsageOutput)} />
          </Box>
        ) : null}
        {run?.exitReason && run.status === 'failed' ? (
          <Typography variant="caption" color="error" sx={{ ...mono, wordBreak: 'break-word' }}>
            {run.exitReason}
          </Typography>
        ) : null}
        {run ? (
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
          >
            {checks.length === 0 ? (
              <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                Checks ainda não rodaram
              </Typography>
            ) : (
              checks.map((c) => (
                <Tooltip key={c.kind} title={c.summary ?? c.status}>
                  <Chip
                    size="small"
                    variant="light"
                    color={
                      c.status === 'pass'
                        ? 'success'
                        : c.status === 'fail'
                          ? 'error'
                          : c.status === 'running'
                            ? 'warning'
                            : 'secondary'
                    }
                    label={CHECK_LABEL[c.kind] ?? c.kind}
                  />
                </Tooltip>
              ))
            )}
            <Button
              size="small"
              color="secondary"
              disabled={live}
              onClick={() => void act(() => api.runAgentRunChecks(run.id))}
            >
              Rodar checks
            </Button>
          </Stack>
        ) : null}
      </Section>

      <Section title="Onde trabalha">
        <Row label="Workspace">
          <Button
            size="small"
            color="secondary"
            disabled={live}
            onClick={(e) => setMenu(e.currentTarget)}
            endIcon={<IconsaxIcon icon={ArrowDown2} size={14} />}
            sx={{ maxWidth: '100%', justifyContent: 'flex-start', px: 1 }}
          >
            <Box
              component="span"
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: workspace?.color ?? 'text.disabled',
                mr: 1,
                flexShrink: 0,
              }}
            />
            <Typography variant="body2" noWrap>
              {workspace?.name ?? 'Nenhum'}
            </Typography>
          </Button>
          <Menu anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)}>
            {profiles.map((w) => (
              <MenuItem
                key={w.id}
                selected={w.id === issue.workspaceId}
                onClick={() => {
                  setMenu(null);
                  void act(() => api.updateIssue(issue.number, { workspaceId: w.id }));
                }}
              >
                <Box
                  component="span"
                  sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: w.color, mr: 1 }}
                />
                {w.name}
              </MenuItem>
            ))}
          </Menu>
        </Row>
        {run?.branchName ? (
          <Row label="Branch">
            <Typography variant="caption" noWrap component="div" sx={mono} title={run.branchName}>
              {run.branchName}
              {run.baseBranch ? (
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {' '}
                  → {run.baseBranch}
                </Box>
              ) : null}
            </Typography>
          </Row>
        ) : null}
        {run?.worktreePath ? (
          <Row label="Worktree">
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
              <Typography
                variant="caption"
                noWrap
                sx={{ ...mono, flex: 1, minWidth: 0, direction: 'rtl', textAlign: 'left' }}
                title={run.worktreePath}
              >
                {run.worktreePath}
              </Typography>
              <Button
                size="small"
                color="secondary"
                startIcon={<IconsaxIcon icon={Folder2} size={14} />}
                onClick={() => void act(() => api.revealAgentRunWorktree(run.id))}
              >
                Abrir
              </Button>
            </Stack>
          </Row>
        ) : null}
        {live ? (
          <Typography variant="caption" color="text.secondary">
            Com o agente rodando, o workspace não pode ser trocado.
          </Typography>
        ) : null}
        {otherWorktrees.length > 0 ? (
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              Worktrees de runs anteriores
            </Typography>
            {otherWorktrees.map((r) => (
              <Stack key={r.id} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography variant="caption" noWrap sx={{ ...mono, flex: 1, minWidth: 0 }}>
                  #{r.id} · {r.branchName ?? '—'}
                </Typography>
                <Button
                  size="small"
                  color="secondary"
                  onClick={() => void act(() => api.revealAgentRunWorktree(r.id))}
                >
                  Abrir
                </Button>
              </Stack>
            ))}
          </Stack>
        ) : null}
      </Section>

      {run ? (
        <Section title="Contexto do agente">
          <ContextBlock title="Instruções que recebeu" text={run.systemPrompt} />
          <ContextBlock title="Último prompt" text={run.lastPrompt} />
        </Section>
      ) : null}

      {error ? (
        <Typography variant="caption" color="error" role="alert">
          {error}
        </Typography>
      ) : null}
    </Stack>
  );
}
