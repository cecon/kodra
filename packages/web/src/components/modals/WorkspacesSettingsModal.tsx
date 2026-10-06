import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { WorkspaceProfilePayload, WorkspaceStages } from '@kanbots/api';
import { api } from '../../api.js';
import { getBridge } from '../../desktop-bridge.js';
import { dispatchIssuesRefetch } from '../../hooks/useIssues.js';
import { ModalFrame } from './ModalFrame.js';

const COLORS = [
  '#4680ff',
  '#2ca87f',
  '#e58a00',
  '#dc2626',
  '#7265e6',
  '#13c2c2',
  '#d6336c',
  '#5b6b79',
];
const CHECK_KINDS: Array<{ kind: WorkspaceStages['checkKinds'][number]; label: string }> = [
  { kind: 'lint', label: 'Lint' },
  { kind: 'typecheck', label: 'Typecheck' },
  { kind: 'tests', label: 'Tests' },
];
const DEFAULT_STAGES: WorkspaceStages = {
  checks: true,
  checkKinds: ['lint', 'typecheck', 'tests'],
  review: true,
  pr: true,
  autoMerge: false,
};

interface Draft {
  id?: string;
  name: string;
  path: string;
  color: string;
  baseBranch: string;
  stages: WorkspaceStages;
}

function draftOf(w: WorkspaceProfilePayload | null, index: number): Draft {
  return w
    ? {
        id: w.id,
        name: w.name,
        path: w.path,
        color: w.color,
        baseBranch: w.baseBranch ?? '',
        stages: w.stages,
      }
    : {
        name: '',
        path: '',
        color: COLORS[index % COLORS.length]!,
        baseBranch: '',
        stages: DEFAULT_STAGES,
      };
}

/** One line per stage, in flow order, for the list. */
function stageSummary(s: WorkspaceStages): string {
  return [
    'agent',
    s.checks ? `checks (${s.checkKinds.join(', ') || 'commit only'})` : null,
    s.review ? 'your review' : null,
    s.pr ? 'PR + CI' : 'local merge',
    s.pr && s.autoMerge ? 'auto merge' : null,
  ]
    .filter(Boolean)
    .join(' → ');
}

/**
 * Configure → Workspaces: the repos cards can act on. Each has a colour
 * (its cards' stripe and chip on the board) and the stages its cards go
 * through after the agent works.
 */
export function WorkspacesSettingsModal({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<WorkspaceProfilePayload[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    setList(await api.listWorkspaceProfiles());
  }
  useEffect(() => {
    void reload().catch((err: unknown) => setError(String(err)));
  }, []);

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveWorkspaceProfile({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        path: draft.path,
        color: draft.color,
        baseBranch: draft.baseBranch.trim() || null,
        stages: draft.stages,
      });
      setDraft(null);
      await reload();
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(w: WorkspaceProfilePayload): Promise<void> {
    if (!window.confirm(`Remove the workspace "${w.name}"? Its cards keep their history.`)) return;
    setError(null);
    try {
      await api.removeWorkspaceProfile(w.id);
      await reload();
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pickFolder(): Promise<void> {
    const path = await getBridge()?.pickFolder();
    if (!path || !draft) return;
    const name = draft.name || path.split(/[\\/]/).filter(Boolean).pop() || '';
    setDraft({ ...draft, path, name });
  }

  const setStages = (patch: Partial<WorkspaceStages>) =>
    draft && setDraft({ ...draft, stages: { ...draft.stages, ...patch } });

  return (
    <ModalFrame
      title="Workspaces"
      onClose={onClose}
      width={720}
      footerHint="A workspace is a repo cards can act on. Its colour marks its cards on the board."
      actions={
        draft ? (
          <>
            <Button color="secondary" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={() => void save()}
              disabled={busy || !draft.name.trim() || !draft.path.trim()}
            >
              {busy ? 'Saving…' : 'Save workspace'}
            </Button>
          </>
        ) : (
          <Button variant="contained" onClick={() => setDraft(draftOf(null, list?.length ?? 0))}>
            Add workspace
          </Button>
        )
      }
    >
      <Stack spacing={2}>
        {error ? <Alert severity="error">{error}</Alert> : null}

        {draft ? (
          <Stack spacing={2}>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <TextField
                label="Name"
                size="small"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Base branch"
                size="small"
                placeholder="repo default"
                value={draft.baseBranch}
                onChange={(e) => setDraft({ ...draft, baseBranch: e.target.value })}
                sx={{ width: 180 }}
              />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <TextField
                label="Repository folder"
                size="small"
                value={draft.path}
                onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                sx={{ flex: 1 }}
              />
              <Button variant="outlined" color="secondary" onClick={() => void pickFolder()}>
                Choose…
              </Button>
            </Stack>

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Card colour
              </Typography>
              <Stack direction="row" spacing={1}>
                {COLORS.map((c) => (
                  <ButtonBase
                    key={c}
                    aria-label={`Colour ${c}`}
                    aria-pressed={draft.color === c}
                    onClick={() => setDraft({ ...draft, color: c })}
                    sx={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      bgcolor: c,
                      outline: draft.color === c ? '2px solid' : 'none',
                      outlineColor: 'text.primary',
                      outlineOffset: 2,
                    }}
                  />
                ))}
              </Stack>
            </Box>

            <Box>
              <Typography variant="subtitle2">Stages</Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                The agent always works first. Then, in this order:
              </Typography>
              <Stack spacing={0.5}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={draft.stages.checks}
                      onChange={(e) => setStages({ checks: e.target.checked })}
                    />
                  }
                  label="Local checks before review (dependencies, then the checks below)"
                />
                {draft.stages.checks ? (
                  <Stack direction="row" spacing={1} sx={{ pl: 6 }}>
                    {CHECK_KINDS.map(({ kind, label }) => (
                      <FormControlLabel
                        key={kind}
                        control={
                          <Checkbox
                            size="small"
                            checked={draft.stages.checkKinds.includes(kind)}
                            onChange={(e) =>
                              setStages({
                                checkKinds: e.target.checked
                                  ? [...draft.stages.checkKinds, kind]
                                  : draft.stages.checkKinds.filter((k) => k !== kind),
                              })
                            }
                          />
                        }
                        label={label}
                      />
                    ))}
                  </Stack>
                ) : null}
                <FormControlLabel
                  control={
                    <Switch
                      checked={draft.stages.review}
                      onChange={(e) => setStages({ review: e.target.checked })}
                    />
                  }
                  label="Human review: you approve before it moves on"
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={draft.stages.pr}
                      onChange={(e) =>
                        setStages({
                          pr: e.target.checked,
                          autoMerge: e.target.checked && draft.stages.autoMerge,
                        })
                      }
                    />
                  }
                  label="Pull request + CI on GitHub (off: merge locally into the base branch)"
                />
                <FormControlLabel
                  disabled={!draft.stages.pr}
                  control={
                    <Switch
                      checked={draft.stages.pr && draft.stages.autoMerge}
                      onChange={(e) => setStages({ autoMerge: e.target.checked })}
                    />
                  }
                  label="Merge automatically once CI is green"
                />
              </Stack>
            </Box>
          </Stack>
        ) : list === null ? (
          <Typography variant="body2" color="text.secondary">
            Loading…
          </Typography>
        ) : list.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No workspaces yet. Add the repos your cards should work on.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {list.map((w) => (
              <Stack
                key={w.id}
                direction="row"
                spacing={1.5}
                sx={{
                  alignItems: 'center',
                  p: 1.5,
                  border: 1,
                  borderColor: 'divider',
                  borderLeft: `4px solid ${w.color}`,
                  borderRadius: 1,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography variant="subtitle1">{w.name}</Typography>
                    {w.baseBranch ? (
                      <Chip size="small" variant="outlined" label={w.baseBranch} />
                    ) : null}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" noWrap component="div">
                    {w.path}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div">
                    {stageSummary(w.stages)}
                  </Typography>
                </Box>
                <Button size="small" color="secondary" onClick={() => setDraft(draftOf(w, 0))}>
                  Edit
                </Button>
                <Button size="small" color="error" onClick={() => void remove(w)}>
                  Remove
                </Button>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </ModalFrame>
  );
}
