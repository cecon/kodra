import { useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Typography from '@mui/material/Typography';
import { api } from '../../api.js';
import { dispatchIssuesRefetch } from '../../hooks/useIssues.js';
import { withStatus } from '../../labels.js';
import type { Issue } from '../../types.js';
import { liveRunOf, reviewGateOf } from '../Card.js';

type StepState = 'todo' | 'active' | 'done' | 'failed';

interface Journey {
  steps: Array<{ label: string; state: StepState; caption?: string }>;
  /** What happens now, in one sentence. */
  next: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  actions: Array<{ label: string; run: () => Promise<unknown> | void; primary?: boolean }>;
}

export interface CardJourneyProps {
  issue: Issue;
  onOpenTab: (tab: 'diff' | 'runs') => void;
  onChanged: () => void;
}

/**
 * "Where is this card?" — the path every task takes (agent → checks →
 * your review → done), where this one stands, and the one thing to do
 * next, with the button for it.
 */
export function CardJourney({ issue, onOpenTab, onChanged }: CardJourneyProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const journey = journeyOf(issue, onOpenTab);

  async function act(run: () => Promise<unknown> | void): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await run();
      dispatchIssuesRefetch();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ px: 3, pb: 2 }}>
      <Stepper alternativeLabel sx={{ mb: 1.5 }}>
        {journey.steps.map((s) => (
          <Step key={s.label} active={s.state === 'active'} completed={s.state === 'done'}>
            <StepLabel
              error={s.state === 'failed'}
              {...(s.caption
                ? {
                    optional: (
                      <Typography variant="caption" color="text.secondary">
                        {s.caption}
                      </Typography>
                    ),
                  }
                : {})}
            >
              {s.label}
            </StepLabel>
          </Step>
        ))}
      </Stepper>
      <Alert
        severity={journey.severity}
        action={
          journey.actions.length > 0 ? (
            <Stack direction="row" spacing={1}>
              {journey.actions.map((a) => (
                <Button
                  key={a.label}
                  size="small"
                  color="inherit"
                  variant={a.primary ? 'outlined' : 'text'}
                  disabled={busy}
                  onClick={() => void act(a.run)}
                >
                  {a.label}
                </Button>
              ))}
            </Stack>
          ) : undefined
        }
      >
        <Next>{journey.next}</Next>
        {error ? (
          <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
            {error}
          </Typography>
        ) : null}
      </Alert>
    </Box>
  );
}

function Next({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body2" component="div">
      <strong>Next: </strong>
      {children}
    </Typography>
  );
}

function journeyOf(issue: Issue, onOpenTab: CardJourneyProps['onOpenTab']): Journey {
  const live = liveRunOf(issue);
  const gate = reviewGateOf(issue);
  const status = issue.status;
  const failedKinds = gate?.checks.filter((c) => c.status === 'fail').map((c) => c.kind) ?? [];

  const agent: StepState =
    status === 'review' || status === 'done'
      ? 'done'
      : live || status === 'inProgress'
        ? 'active'
        : 'todo';
  const checks: StepState =
    status === 'done'
      ? 'done'
      : status !== 'review'
        ? 'todo'
        : gate === null || gate.state === 'passed'
          ? 'done'
          : gate.state === 'checking'
            ? 'active'
            : 'failed';
  const review: StepState =
    status === 'done' ? 'done' : status === 'review' && checks === 'done' ? 'active' : 'todo';
  const steps: Journey['steps'] = [
    { label: 'Agent works', state: agent, ...(live ? { caption: 'running now' } : {}) },
    {
      label: 'Checks',
      state: checks,
      ...(gate?.state === 'failed'
        ? { caption: `failed: ${failedKinds.join(', ')}` }
        : gate?.state === 'stopped'
          ? { caption: 'stopped' }
          : status === 'review' && gate === null
            ? { caption: 'none to run' }
            : {}),
    },
    { label: 'Your review', state: review },
    { label: 'Done', state: status === 'done' ? 'done' : 'todo' },
  ];

  if (live) {
    return {
      steps,
      severity: 'info',
      next: 'the agent is working on this task. Follow it in the Thread tab, or stop it.',
      actions: [{ label: 'Stop agent', run: () => api.stopAgent(live.id) }],
    };
  }
  if (status === 'done') {
    return {
      steps,
      severity: 'success',
      next: 'nothing — this task is done. Its committed work stays on its branch.',
      actions: [],
    };
  }
  if (status === 'review') {
    if (gate?.state === 'checking') {
      return {
        steps,
        severity: 'info',
        next: 'the checks are running on the agent’s branch. The card is locked until they finish.',
        actions: [{ label: 'Stop checks', run: () => api.stopReviewGate(gate.runId) }],
      };
    }
    if (gate?.state === 'failed') {
      return {
        steps,
        severity: 'error',
        next: `send it back to the agent: ${failedKinds.join(', ')} failed. It gets the errors and fixes them; the checks run again when it finishes.`,
        actions: [
          {
            label: 'Send back to agent',
            primary: true,
            run: () => api.sendBackToAgent(issue.number),
          },
          { label: 'See errors', run: () => onOpenTab('runs') },
        ],
      };
    }
    if (gate?.state === 'stopped') {
      return {
        steps,
        severity: 'warning',
        next: 'the checks were stopped before finishing. Run them again to get the card to review.',
        actions: [
          { label: 'Re-run checks', primary: true, run: () => api.runReviewGate(gate.runId) },
        ],
      };
    }
    return {
      steps,
      severity: 'success',
      next:
        gate === null
          ? 'review the changes in the Diff tab, then ship them or request changes from the card on the board.'
          : 'all checks passed. Review the changes in the Diff tab, then ship them or request changes from the card on the board.',
      actions: [{ label: 'Open Diff', primary: true, run: () => onOpenTab('diff') }],
    };
  }
  return {
    steps,
    severity: 'info',
    next:
      status === 'inProgress'
        ? 'no agent is running on this task. Start one to work on it.'
        : 'this task hasn’t started. Run an agent on it, or leave it in the queue.',
    actions: [
      {
        label: 'Run agent',
        primary: true,
        run: async () => {
          if (status !== 'inProgress') {
            await api.updateIssue(issue.number, { labels: withStatus(issue.labels, 'inProgress') });
          }
          await api.dispatchIssue(issue.number, { fromStatus: status });
        },
      },
    ],
  };
}
