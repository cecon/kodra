import { useEffect, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { WorkspaceProfilePayload, WorkspaceStages } from '@kanbots/api';
import { IconsaxIcon } from '@kanbots/ui';
import { Add, Edit2, Folder2, Trash } from 'iconsax-react';
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
  devServer: string;
  setup: string;
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
        devServer: w.scripts?.devServer ?? '',
        setup: w.scripts?.setup ?? '',
      }
    : {
        name: '',
        path: '',
        color: COLORS[index % COLORS.length]!,
        baseBranch: '',
        stages: DEFAULT_STAGES,
        devServer: '',
        setup: '',
      };
}

/** The stages in flow order, as chips for the list. */
function stageChips(s: WorkspaceStages): string[] {
  return [
    'Agent',
    s.checks ? `Checks${s.checkKinds.length ? ` (${s.checkKinds.join(', ')})` : ''}` : null,
    s.review ? 'Your review' : null,
    s.pr ? 'PR + CI' : 'Local merge',
    s.pr && s.autoMerge ? 'Auto merge' : null,
  ].filter((x): x is string => x !== null);
}

/** A labelled field, Able Pro style: the label above the input. */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <Stack spacing={1}>
      <InputLabel htmlFor={htmlFor}>{label}</InputLabel>
      {children}
    </Stack>
  );
}

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">{title}</Typography>
        {caption ? (
          <Typography variant="caption" color="text.secondary">
            {caption}
          </Typography>
        ) : null}
      </Box>
      {children}
    </Stack>
  );
}

/** One stage: a switch with a title and what it does. */
function StageRow({
  step,
  title,
  description,
  checked,
  disabled = false,
  onChange,
  children,
}: {
  step: number;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <Box
      sx={{
        p: 1.5,
        border: 1,
        borderColor: checked ? 'primary.main' : 'divider',
        borderRadius: 1.5,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <Chip size="small" label={step} sx={{ mt: 0.25, minWidth: 28 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1">{title}</Typography>
          <Typography variant="caption" color="text.secondary">
            {description}
          </Typography>
          {checked && children ? <Box sx={{ mt: 1 }}>{children}</Box> : null}
        </Box>
        <Switch
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          inputProps={{ 'aria-label': title }}
        />
      </Stack>
    </Box>
  );
}

/**
 * Configure → Workspaces: the repos cards can act on. Each has a colour
 * (its cards' stripe and chip on the board), scripts, and the stages its
 * cards go through after the agent works.
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
        scripts: { devServer: draft.devServer, setup: draft.setup },
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

  const editing = draft !== null;
  return (
    <ModalFrame
      title={
        editing ? (draft.id ? `Edit ${draft.name || 'workspace'}` : 'New workspace') : 'Workspaces'
      }
      onClose={onClose}
      width={760}
      muiBody
      footerHint={
        editing ? undefined : 'A workspace is a repo cards can act on; its colour marks its cards.'
      }
      actions={
        editing ? (
          <>
            <Button color="secondary" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={() => void save()}
              disabled={busy || !draft.name.trim() || !draft.path.trim()}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {busy ? 'Saving…' : 'Save workspace'}
            </Button>
          </>
        ) : (
          <Button
            variant="contained"
            startIcon={<IconsaxIcon icon={Add} size={18} />}
            onClick={() => setDraft(draftOf(null, list?.length ?? 0))}
            sx={{ whiteSpace: 'nowrap' }}
          >
            Add workspace
          </Button>
        )
      }
    >
      <Stack spacing={3}>
        {error ? <Alert severity="error">{error}</Alert> : null}

        {editing ? (
          <>
            <Section title="Repository" caption="The git repo cards of this workspace work in.">
              <Grid container spacing={2}>
                <Grid item xs={12} sm={8}>
                  <Field label="Name" htmlFor="ws-name">
                    <TextField
                      id="ws-name"
                      fullWidth
                      placeholder="e.g. Livraria"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </Field>
                </Grid>
                <Grid item xs={12} sm={4}>
                  <Field label="Base branch" htmlFor="ws-branch">
                    <TextField
                      id="ws-branch"
                      fullWidth
                      placeholder="repo default"
                      value={draft.baseBranch}
                      onChange={(e) => setDraft({ ...draft, baseBranch: e.target.value })}
                    />
                  </Field>
                </Grid>
                <Grid item xs={12}>
                  <Field label="Folder" htmlFor="ws-path">
                    <TextField
                      id="ws-path"
                      fullWidth
                      placeholder="D:\projetos\my-repo"
                      value={draft.path}
                      onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                      InputProps={{
                        endAdornment: (
                          <InputAdornment position="end">
                            <Button
                              size="small"
                              color="secondary"
                              startIcon={<IconsaxIcon icon={Folder2} size={16} />}
                              onClick={() => void pickFolder()}
                            >
                              Choose
                            </Button>
                          </InputAdornment>
                        ),
                      }}
                    />
                  </Field>
                </Grid>
                <Grid item xs={12}>
                  <Field label="Card colour" htmlFor="ws-color">
                    <Stack direction="row" spacing={1.25} id="ws-color">
                      {COLORS.map((c) => (
                        <ButtonBase
                          key={c}
                          aria-label={`Colour ${c}`}
                          aria-pressed={draft.color === c}
                          onClick={() => setDraft({ ...draft, color: c })}
                          sx={{
                            width: 30,
                            height: 30,
                            borderRadius: '50%',
                            bgcolor: c,
                            outline: draft.color === c ? '2px solid' : 'none',
                            outlineColor: 'text.primary',
                            outlineOffset: 3,
                          }}
                        />
                      ))}
                    </Stack>
                  </Field>
                </Grid>
              </Grid>
            </Section>

            <Divider />

            <Section title="Scripts" caption="Optional commands, run in the card's worktree.">
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <Field label="Dev server (branch preview)" htmlFor="ws-dev">
                    <TextField
                      id="ws-dev"
                      fullWidth
                      placeholder="pnpm dev"
                      value={draft.devServer}
                      onChange={(e) => setDraft({ ...draft, devServer: e.target.value })}
                      helperText="PORT is set for it."
                    />
                  </Field>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <Field label="Setup (fresh worktree)" htmlFor="ws-setup">
                    <TextField
                      id="ws-setup"
                      fullWidth
                      placeholder="npm ci"
                      value={draft.setup}
                      onChange={(e) => setDraft({ ...draft, setup: e.target.value })}
                      helperText="Replaces the automatic dependency install."
                    />
                  </Field>
                </Grid>
              </Grid>
            </Section>

            <Divider />

            <Section title="Stages" caption="The agent always works first; then, in this order:">
              <Stack spacing={1.25}>
                <StageRow
                  step={1}
                  title="Local checks"
                  description="Before review: commit check, dependencies, then the checks you pick."
                  checked={draft.stages.checks}
                  onChange={(on) => setStages({ checks: on })}
                >
                  <Stack direction="row" spacing={1}>
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
                </StageRow>
                <StageRow
                  step={2}
                  title="Your review"
                  description="You approve the changes before they move on. Off: green checks approve by themselves."
                  checked={draft.stages.review}
                  onChange={(on) => setStages({ review: on })}
                />
                <StageRow
                  step={3}
                  title="Pull request + CI"
                  description="Push and open a GitHub PR, waiting on its CI. Off: merge locally into the base branch."
                  checked={draft.stages.pr}
                  onChange={(on) => setStages({ pr: on, autoMerge: on && draft.stages.autoMerge })}
                />
                <StageRow
                  step={4}
                  title="Auto merge"
                  description="Merge the PR by itself once CI is green. Off: you click Merge."
                  checked={draft.stages.pr && draft.stages.autoMerge}
                  disabled={!draft.stages.pr}
                  onChange={(on) => setStages({ autoMerge: on })}
                />
              </Stack>
            </Section>
          </>
        ) : list === null ? (
          <Typography variant="body2" color="text.secondary">
            Loading…
          </Typography>
        ) : list.length === 0 ? (
          <Stack spacing={1.5} sx={{ alignItems: 'center', py: 5, textAlign: 'center' }}>
            <IconsaxIcon icon={Folder2} size={36} variant="Bulk" />
            <Typography variant="h6">No workspaces yet</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 380 }}>
              Add the repos your cards should work on. Each gets a colour on the board and its own
              stages.
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            {list.map((w) => (
              <Stack
                key={w.id}
                direction="row"
                spacing={2}
                sx={{
                  alignItems: 'center',
                  p: 2,
                  border: 1,
                  borderColor: 'divider',
                  borderLeft: `5px solid ${w.color}`,
                  borderRadius: 1.5,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.25 }}>
                    <Typography variant="subtitle1">{w.name}</Typography>
                    {w.baseBranch ? (
                      <Chip size="small" variant="outlined" label={w.baseBranch} />
                    ) : null}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" noWrap component="div">
                    {w.path}
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={0.5}
                    sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.5 }}
                  >
                    {stageChips(w.stages).map((s, i) => (
                      <Chip
                        key={s}
                        size="small"
                        variant="light"
                        color={i === 0 ? 'secondary' : 'primary'}
                        label={s}
                      />
                    ))}
                  </Stack>
                </Box>
                <Button
                  size="small"
                  color="secondary"
                  startIcon={<IconsaxIcon icon={Edit2} size={16} />}
                  onClick={() => setDraft(draftOf(w, 0))}
                >
                  Edit
                </Button>
                <Button
                  size="small"
                  color="error"
                  startIcon={<IconsaxIcon icon={Trash} size={16} />}
                  onClick={() => void remove(w)}
                >
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
