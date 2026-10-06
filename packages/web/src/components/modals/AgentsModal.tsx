import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { IssueRef } from '@kanbots/core';
import { IconsaxIcon } from '@kanbots/ui';
import { Folder2, StopCircle } from 'iconsax-react';
import { api } from '../../api.js';
import { dispatchIssuesRefetch } from '../../hooks/useIssues.js';
import type { AgentRun } from '../../types.js';
import {
  branchName,
  ContextBlock,
  fmtElapsed,
  fmtTokens,
  LIVE,
  Metric,
  mono,
  STATUS,
} from './CardAgentPanel.js';
import { ModalFrame } from './ModalFrame.js';

/**
 * Every agent that worked on a card — one per run — and, for the one
 * selected, its state, numbers, where it worked and the context it was
 * given (instructions and last prompt). Opened from the card's agents icon.
 */
export function AgentsModal({
  issueNumber,
  title,
  onClose,
}: {
  issueNumber: IssueRef;
  title: string;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    const list = [...(await api.listIssueRuns(issueNumber))].sort((a, b) => b.id - a.id);
    setRuns(list);
    setSelected((cur) => cur ?? list[0]?.id ?? null);
  }
  useEffect(() => {
    void load().catch((err: unknown) => setError(String(err)));
    // Live numbers (time, tokens) refresh while the modal is open.
    const timer = setInterval(() => void load().catch(() => undefined), 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueNumber]);

  const run = runs?.find((r) => r.id === selected) ?? null;

  async function act(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      dispatchIssuesRefetch();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <ModalFrame
      title={`Agentes · #${String(issueNumber)} ${title}`}
      onClose={onClose}
      width={980}
      muiBody
    >
      {runs === null ? (
        <Typography variant="body2" color="text.secondary">
          Carregando…
        </Typography>
      ) : runs.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nenhum agente trabalhou neste card ainda.
        </Typography>
      ) : (
        <Stack direction="row" spacing={2.5} sx={{ minHeight: 420 }}>
          <Stack spacing={0.75} sx={{ width: 250, flexShrink: 0 }}>
            {runs.map((r) => {
              const st = STATUS[r.status];
              return (
                <ListItemButton
                  key={r.id}
                  selected={r.id === selected}
                  onClick={() => setSelected(r.id)}
                  sx={{
                    borderRadius: 1.5,
                    border: 1,
                    borderColor: r.id === selected ? 'primary.main' : 'divider',
                    display: 'block',
                    py: 1,
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                    <Typography variant="subtitle2" sx={mono}>
                      run #{r.id}
                    </Typography>
                    <Chip size="small" variant="light" color={st.color} label={st.label} />
                  </Stack>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    component="div"
                    noWrap
                    sx={mono}
                  >
                    {r.provider ? `${r.provider} · ` : ''}
                    {r.model ?? '—'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div" noWrap>
                    {new Date(r.startedAt).toLocaleString()} · {fmtElapsed(r.startedAt, r.endedAt)}
                  </Typography>
                </ListItemButton>
              );
            })}
          </Stack>

          {run ? (
            <Stack spacing={2} sx={{ flex: 1, minWidth: 0 }}>
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
              >
                <Typography variant="h5" sx={mono}>
                  run #{run.id}
                </Typography>
                <Chip
                  size="small"
                  variant="light"
                  color={STATUS[run.status].color}
                  label={STATUS[run.status].label}
                />
                {run.model ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${run.provider ? `${run.provider} · ` : ''}${run.model}`}
                    sx={mono}
                  />
                ) : null}
                <Box sx={{ flex: 1 }} />
                {LIVE.has(run.status) ? (
                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    startIcon={<IconsaxIcon icon={StopCircle} size={16} />}
                    onClick={() => void act(() => api.stopAgent(run.id))}
                  >
                    Parar agente
                  </Button>
                ) : null}
                {run.worktreePath ? (
                  <Button
                    size="small"
                    color="secondary"
                    startIcon={<IconsaxIcon icon={Folder2} size={16} />}
                    onClick={() => void act(() => api.revealAgentRunWorktree(run.id))}
                  >
                    Abrir worktree
                  </Button>
                ) : null}
              </Stack>

              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1 }}>
                <Metric label="Tempo" value={fmtElapsed(run.startedAt, run.endedAt)} />
                <Metric
                  label="Custo (estimado)"
                  value={run.totalCostUsd !== null ? `$${run.totalCostUsd.toFixed(2)}` : '—'}
                />
                <Metric label="Tokens entrada" value={fmtTokens(run.tokenUsageInput)} />
                <Metric label="Tokens saída" value={fmtTokens(run.tokenUsageOutput)} />
              </Box>

              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  Branch
                </Typography>
                <Typography variant="body2" sx={mono}>
                  {run.branchName ?? '—'}
                  {run.baseBranch ? (
                    <Box component="span" sx={{ color: 'text.secondary' }}>
                      {' '}
                      → {branchName(run.baseBranch)}
                    </Box>
                  ) : null}
                </Typography>
                {run.worktreePath ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ...mono, wordBreak: 'break-all' }}
                  >
                    {run.worktreePath}
                  </Typography>
                ) : null}
              </Stack>

              {run.exitReason ? (
                <Box sx={{ p: 1.25, borderRadius: 1, bgcolor: 'action.hover' }}>
                  <Typography variant="caption" color="text.secondary" component="div">
                    Como terminou
                  </Typography>
                  <Typography
                    variant="body2"
                    color={run.status === 'failed' ? 'error' : 'text.primary'}
                    sx={{ ...mono, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
                  >
                    {run.exitReason}
                  </Typography>
                </Box>
              ) : null}

              <Stack spacing={1}>
                <Typography
                  variant="caption"
                  sx={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}
                  color="text.secondary"
                >
                  Contexto do agente
                </Typography>
                <ContextBlock title="Instruções que recebeu" text={run.systemPrompt} />
                <ContextBlock title="Último prompt" text={run.lastPrompt} />
              </Stack>

              {error ? (
                <Typography variant="caption" color="error" role="alert">
                  {error}
                </Typography>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      )}
    </ModalFrame>
  );
}
