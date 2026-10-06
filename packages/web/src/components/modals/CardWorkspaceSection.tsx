import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { WorkspaceProfilePayload } from '@kanbots/api';
import { api } from '../../api.js';
import { dispatchIssuesRefetch } from '../../hooks/useIssues.js';
import type { AgentRun, Issue } from '../../types.js';

/**
 * The card's own corner of the file system: which workspace (repo) it acts
 * on — changeable while no agent is working — and the worktrees its runs
 * created, each openable in the file manager. This used to sit on the
 * board's left rail for the whole opened folder.
 */
export function CardWorkspaceSection({
  issue,
  locked,
  onChanged,
}: {
  issue: Issue;
  /** An agent is working on the card: its workspace can't change now. */
  locked: boolean;
  onChanged: () => void;
}) {
  const [profiles, setProfiles] = useState<WorkspaceProfilePayload[] | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listWorkspaceProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    void api
      .listIssueRuns(issue.number)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [issue.number]);

  const current = profiles?.find((w) => w.id === issue.workspaceId) ?? null;
  const worktrees = runs.filter((r) => r.worktreePath);

  async function change(workspaceId: string): Promise<void> {
    setError(null);
    try {
      await api.updateIssue(issue.number, { workspaceId: workspaceId || null });
      dispatchIssuesRefetch();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function reveal(runId: number): Promise<void> {
    setError(null);
    try {
      await api.revealAgentRunWorktree(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Stack spacing={1.25}>
      <TextField
        select
        size="small"
        label="Workspace"
        value={issue.workspaceId ?? ''}
        disabled={locked || profiles === null}
        onChange={(e) => void change(e.target.value)}
        helperText={
          locked
            ? 'An agent is working on it: stop it to change the workspace.'
            : current
              ? current.path
              : 'No workspace: the agent works in the folder this board was opened on.'
        }
      >
        <MenuItem value="">
          <em>None</em>
        </MenuItem>
        {(profiles ?? []).map((w) => (
          <MenuItem key={w.id} value={w.id}>
            <Box
              component="span"
              sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: w.color, mr: 1 }}
            />
            {w.name}
          </MenuItem>
        ))}
      </TextField>

      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Worktrees
        </Typography>
        {worktrees.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            None yet — each agent run works in its own worktree.
          </Typography>
        ) : (
          <Stack spacing={0.75}>
            {worktrees.map((r) => (
              <Stack key={r.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    variant="caption"
                    component="div"
                    noWrap
                    sx={{ fontFamily: 'var(--ff-mono, monospace)' }}
                    title={r.worktreePath ?? ''}
                  >
                    run #{r.id} · {r.branchName ?? '—'}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    component="div"
                    noWrap
                    title={r.worktreePath ?? ''}
                  >
                    {r.worktreePath}
                  </Typography>
                </Box>
                <Button size="small" color="secondary" onClick={() => void reveal(r.id)}>
                  Open
                </Button>
              </Stack>
            ))}
          </Stack>
        )}
      </Box>
      {error ? (
        <Typography variant="caption" color="error" role="alert">
          {error}
        </Typography>
      ) : null}
    </Stack>
  );
}
