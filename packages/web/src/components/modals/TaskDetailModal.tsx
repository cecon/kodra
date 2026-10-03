import { KodraPulse } from '../KodraPulse.js';
import type { IssueRef } from '@kanbots/core';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { api } from '../../api.js';
import { SessionDropdown, useActiveSessionId } from '../chat/SessionDropdown.js';
import { ModelPicker, PROVIDER_LABELS, type ModelPickerValue } from '../forms/ModelPicker.js';
import { useFetch } from '../../hooks/useFetch.js';
import { useFocusedRepo } from '../../hooks/useFocusedRepo.js';
import { useIssues, dispatchIssuesRefetch, ISSUES_CHANGED_CHANNEL } from '../../hooks/useIssues.js';
import { useIssueRunStream } from '../../hooks/useIssueRunStream.js';
import {
  ageString,
  areaLabels,
  colorForLogin,
  linkedIssueNumbers,
  priorityFromLabels,
  tagFromLabels,
  withStatus,
} from '../../labels.js';
import { AgentSpinner } from '../run/AgentSpinner.js';
import { PreviewPanel, type PreviewInspectSelection } from '../run/PreviewPanel.js';
import { RunSummary } from '../run/RunSummary.js';
import { ToolUseCard } from '../run/ToolUseCard.js';
import { CreatePrModal } from './CreatePrModal.js';
import { ModalFrame } from './ModalFrame.js';
import { priorityColor, tagColor } from '../board/boardStyle.js';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import { IconButton, IconsaxIcon } from '@kanbots/ui';
import { Add, CloseCircle } from 'iconsax-react';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { renderMarkdown } from '../../lib/markdown.js';
import type {
  AgentEvent,
  AgentRun,
  AgentRunStatus,
  AutopilotChildEntry,
  AutopilotPlanningSlot,
  AutopilotSession,
  Card,
  ChatSessionPayload,
  DecisionPayload,
  DiffFile,
  DiffPayload,
  IssueDetail as IssueDetailPayload,
  IssueRelationPayload,
  Message,
  PrCommentPayload,
  PrCommentsListResult,
  ProviderId,
  ReviewCommentPayload,
  SentrySuggestion,
  SlashCommandPayload,
  StatusKey,
} from '../../types.js';

const TAB_LABELS: Record<DetailTab, string> = {
  autopilot: 'Autopilot',
  overview: 'Overview',
  thread: 'Thread',
  diff: 'Diff',
  preview: 'Preview',
  runs: 'Runs',
};
type DetailTab = 'autopilot' | 'overview' | 'thread' | 'diff' | 'preview' | 'runs';

const monoChipSx = { fontFamily: 'var(--ff-mono, monospace)' };

function runStatusColor(
  status: AgentRunStatus,
): 'success' | 'warning' | 'error' | 'info' | 'secondary' {
  switch (status) {
    case 'running':
      return 'success';
    case 'awaiting_input':
      return 'warning';
    case 'failed':
      return 'error';
    case 'complete':
      return 'info';
    default:
      return 'secondary';
  }
}

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  starting: 'STARTING',
  running: 'RUNNING',
  awaiting_input: 'AWAITING INPUT',
  complete: 'COMPLETE',
  failed: 'FAILED',
  stopped: 'STOPPED',
};

function fmtElapsed(startIso: string, endIso?: string | null): string {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return '—';
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Build the terminal command for resuming a provider-backed agent session. */
export function buildResumeCommand(
  provider: string | null,
  sessionId: string,
  worktreePath: string | null,
): string {
  switch (provider) {
    case 'claude-code':
      return `claude --resume ${sessionId}`;
    case 'codex-cli':
      return `codex resume ${sessionId}`;
    case 'agy-cli':
      return `agy --conversation ${sessionId}`;
    case 'opencode-cli':
      return worktreePath
        ? `opencode --dir ${worktreePath} --session ${sessionId}`
        : `opencode --session ${sessionId}`;
    default:
      return sessionId;
  }
}

function hasTerminalResumeCommand(provider: string | null): boolean {
  return (
    provider === 'claude-code' ||
    provider === 'codex-cli' ||
    provider === 'agy-cli' ||
    provider === 'opencode-cli'
  );
}

export interface TaskDetailModalProps {
  issueNumber: IssueRef;
  onClose: () => void;
  /** Optional. When supplied, the modal calls this to navigate to a
   *  related issue (parent or sub-issue) instead of opening a second
   *  modal layer. The host (App.tsx) sets the open-detail state with
   *  the target number — the same handler the board uses. */
  onOpenDetail?: (issueNumber: IssueRef) => void;
}

export function TaskDetailModal({ issueNumber, onClose, onOpenDetail }: TaskDetailModalProps) {
  const { data, loading, error, refetch } = useFetch<IssueDetailPayload>(
    `issue:${issueNumber}`,
    () => api.issue(issueNumber),
  );
  const isAutopilot = (data?.issue?.labels ?? []).includes('type:autopilot');
  const isArchived = (data?.issue?.labels ?? []).includes('archived');
  const [tab, setTab] = useState<DetailTab>(isAutopilot ? 'autopilot' : 'overview');
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const [runsRefreshKey, setRunsRefreshKey] = useState(0);
  const [viewedRunId, setViewedRunId] = useState<number | null>(null);
  const [viewedRunDetails, setViewedRunDetails] = useState<AgentRun | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<number | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  useEffect(() => {
    if (isAutopilot && tab !== 'autopilot' && tab !== 'thread') {
      // Default an autopilot card to its dedicated tab on load.
      setTab('autopilot');
    }
    // Only run on mount and when isAutopilot flips true; honour user's later picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAutopilot]);

  useEffect(() => {
    setViewedRunId(null);
    setViewedRunDetails(null);
    setStopError(null);
  }, [issueNumber]);

  // Refetch this issue's detail whenever the main process signals a change.
  // Debounced so a burst of run-status flips collapses to one fetch.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge) return;
    const unsubscribe = bridge.subscribe(ISSUES_CHANGED_CHANNEL, () => {
      if (debounceRef.current !== null) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void refetch();
      }, 80);
    });
    return () => {
      unsubscribe();
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [refetch]);

  const issue = data?.issue ?? null;
  const activeRun = data?.thread?.activeRun ?? null;
  const latestRun = data?.thread?.latestRun ?? null;
  const viewedRunSummary =
    viewedRunId === null
      ? null
      : (data?.thread?.runs?.find((run) => run.id === viewedRunId) ?? null);
  const viewedRun =
    viewedRunSummary !== null && viewedRunDetails?.id === viewedRunSummary.id
      ? viewedRunDetails
      : null;
  const displayRun = viewedRun ?? activeRun ?? latestRun;
  const messages = data?.thread?.messages ?? [];
  const isRunning =
    activeRun?.status === 'running' ||
    activeRun?.status === 'awaiting_input' ||
    activeRun?.status === 'starting';

  async function stopRun(runId: number): Promise<void> {
    if (stoppingRunId !== null) return;
    setStoppingRunId(runId);
    setStopError(null);
    try {
      await api.stopAgent(runId);
      await refetch();
      dispatchIssuesRefetch();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingRunId(null);
    }
  }

  const visibleTabs: DetailTab[] = isAutopilot
    ? ['autopilot', 'overview']
    : ['overview', 'thread', 'diff', 'preview', 'runs'];

  const headerActions = (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mr: 1 }}>
      {isAutopilot && !isArchived ? (
        <AutopilotStopButton issueNumber={issueNumber} onAfter={() => void refetch()} />
      ) : null}
      {!isAutopilot && activeRun && isRunning ? (
        <Button
          size="small"
          color="error"
          variant="outlined"
          disabled={stoppingRunId !== null}
          onClick={() => void stopRun(activeRun.id)}
        >
          {stoppingRunId === activeRun.id ? 'Stopping…' : 'Stop'}
        </Button>
      ) : null}
      {!isAutopilot ? (
        <Tooltip title={displayRun === null ? 'No run to fork' : 'Start a new run from this one'}>
          <span>
            <Button
              size="small"
              color="secondary"
              disabled={forking || displayRun === null}
              onClick={() => {
                if (displayRun === null || forking) return;
                setForking(true);
                setForkError(null);
                void api
                  .forkAgentRun(displayRun.id)
                  .then(() => {
                    setRunsRefreshKey((key) => key + 1);
                    return refetch();
                  })
                  .catch((err: unknown) => {
                    setForkError(err instanceof Error ? err.message : String(err));
                  })
                  .finally(() => setForking(false));
              }}
            >
              {forking ? 'Forking…' : 'Fork run'}
            </Button>
          </span>
        </Tooltip>
      ) : null}
      {!isAutopilot && displayRun ? (
        <Button size="small" variant="contained" onClick={() => setTab('preview')}>
          Open preview ↗
        </Button>
      ) : null}
      {isArchived ? (
        <Tooltip title="Restore this task to the board">
          <Button
            size="small"
            color="secondary"
            onClick={() => {
              void api.unarchiveIssue(issueNumber).then(() => {
                dispatchIssuesRefetch();
                onClose();
              });
            }}
          >
            Unarchive
          </Button>
        </Tooltip>
      ) : (
        <Button
          size="small"
          color="secondary"
          onClick={() => {
            const msg = isAutopilot
              ? 'Archive this autopilot task? Its session will be stopped. Child tasks remain.'
              : isRunning
                ? 'Archive this ticket? Its running agent will be stopped.'
                : 'Archive this ticket?';
            if (!window.confirm(msg)) return;
            void api.archiveIssue(issueNumber).then(() => {
              dispatchIssuesRefetch();
              onClose();
            });
          }}
        >
          Archive
        </Button>
      )}
    </Stack>
  );

  const tag = issue ? tagFromLabels(issue.labels, issue.isPullRequest) : null;
  const priority = issue ? priorityFromLabels(issue.labels) : null;

  return (
    <ModalFrame
      title={
        <>
          <Box
            component="span"
            sx={{ color: 'text.secondary', fontFamily: 'var(--ff-mono, monospace)', mr: 1 }}
          >
            #{issueNumber}
          </Box>
          {issue?.title ?? (loading ? 'Loading…' : 'Issue')}
        </>
      }
      ariaLabel={`Task #${issueNumber}`}
      onClose={onClose}
      width={1180}
      fillBody
      headerExtra={headerActions}
      footer={
        <Box
          className="kb-app kb-modal-foot"
          sx={{ width: '100%', border: 0, p: 0, bgcolor: 'transparent' }}
        >
          <span className="hint">Reply to agent</span>
          <ReplyFooter
            issueNumber={issueNumber}
            threadId={data?.thread?.id ?? null}
            activeRun={activeRun}
            onSent={() => void refetch()}
          />
        </Box>
      }
    >
      <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        {forkError || stopError ? (
          <Alert severity="error" sx={{ m: 2, mb: 0 }} role="alert">
            {forkError ?? stopError}
          </Alert>
        ) : null}
        {issue ? (
          <>
            <Box sx={{ px: 3, pt: 2.5, pb: 1.5 }}>
              <ParentBreadcrumb
                childNumber={issue.number}
                {...(onOpenDetail ? { onOpenDetail } : {})}
              />
              <Stack direction="row" spacing={1.25} sx={{ alignItems: 'baseline', mb: 1.5 }}>
                <Typography
                  variant="h4"
                  color="text.secondary"
                  sx={{ fontFamily: 'var(--ff-mono, monospace)' }}
                >
                  #{issue.number}
                </Typography>
                <Typography variant="h3" component="h1" sx={{ wordBreak: 'break-word' }}>
                  {issue.title}
                </Typography>
              </Stack>
              <Stack
                direction="row"
                spacing={0.75}
                sx={{ flexWrap: 'wrap', rowGap: 0.75, alignItems: 'center' }}
              >
                {activeRun ? (
                  <Chip
                    size="small"
                    variant="light"
                    color={runStatusColor(activeRun.status)}
                    label={`${STATUS_LABEL[activeRun.status]} · run #${activeRun.id}`}
                  />
                ) : null}
                {tag ? (
                  <Chip size="small" variant="outlined" color={tagColor(tag)} label={tag} />
                ) : null}
                {areaLabels(issue.labels).map((l) => (
                  <Chip key={l} size="small" variant="outlined" label={l} sx={monoChipSx} />
                ))}
                {priority ? (
                  <Chip
                    size="small"
                    variant="light"
                    color={priorityColor(priority)}
                    label={`priority:${priority}`}
                    sx={monoChipSx}
                  />
                ) : null}
                {displayRun?.branchName ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`branch ${displayRun.branchName}`}
                    sx={monoChipSx}
                  />
                ) : null}
                <Chip
                  size="small"
                  variant="outlined"
                  label={`opened ${ageString(issue.createdAt)} ago`}
                  sx={monoChipSx}
                />
              </Stack>
            </Box>

            <Tabs
              value={tab}
              onChange={(_e, next: DetailTab) => setTab(next)}
              sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}
            >
              {visibleTabs.map((t) => (
                <Tab key={t} value={t} label={TAB_LABELS[t]} />
              ))}
            </Tabs>

            <div className="kb-tdm-content">
              {tab === 'autopilot' ? <AutopilotTab issueNumber={issue.number} /> : null}
              {tab === 'overview' ? (
                <OverviewTab
                  issue={issue}
                  displayRun={displayRun}
                  cloudRunId={issue.cloudLatestRunId ?? issue.activeRun?.cloudRunId ?? null}
                  {...(onOpenDetail ? { onOpenDetail } : {})}
                />
              ) : null}
              {tab === 'thread' && !isAutopilot ? (
                <ThreadTab
                  activeRun={activeRun}
                  displayRun={displayRun}
                  cloudRunId={issue.cloudLatestRunId ?? issue.activeRun?.cloudRunId ?? null}
                  runs={data?.thread?.runs}
                  messages={messages}
                  issueNumber={issueNumber}
                  issueLabels={issue.labels}
                  issueStatus={issue.status}
                  onActionDone={() => void refetch()}
                />
              ) : null}
              {tab === 'diff' && !isAutopilot ? <DiffTabModal activeRun={displayRun} /> : null}
              {tab === 'preview' && !isAutopilot ? (
                <PreviewTabModal activeRun={displayRun} />
              ) : null}
              {tab === 'runs' && !isAutopilot ? (
                <RunsTab
                  issueNumber={issue.number}
                  refreshKey={runsRefreshKey}
                  onViewRun={(run) => {
                    setViewedRunId(run.id);
                    setViewedRunDetails(run);
                    setTab('thread');
                  }}
                />
              ) : null}
            </div>
          </>
        ) : error ? (
          <Alert severity="error" sx={{ m: 3 }}>
            {error.message}
          </Alert>
        ) : (
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', p: 3 }}>
            <CircularProgress size={18} />
            <Typography color="text.secondary">Loading…</Typography>
          </Stack>
        )}
      </Box>

      <Box
        component="aside"
        sx={{
          width: 320,
          flexShrink: 0,
          overflowY: 'auto',
          borderLeft: 1,
          borderColor: 'divider',
          bgcolor: 'background.default',
        }}
      >
        {issue ? <Aside issue={issue} activeRun={activeRun} latestRun={latestRun} /> : null}
      </Box>
    </ModalFrame>
  );
}

function ReplyFooter({
  issueNumber,
  threadId,
  activeRun,
  onSent,
}: {
  issueNumber: IssueRef;
  /** Issue's persisted thread id. NULL before the first reply is sent
   *  (no thread row exists yet) — in that case we hide the session
   *  dropdown and the first send lands without a chat-session tag,
   *  matching the pre-multi-session behaviour. */
  threadId: number | null;
  activeRun: AgentRun | null;
  onSent: () => void;
}) {
  const [body, setBody] = useState('');
  const [modelSelection, setModelSelection] = useState<ModelPickerValue | null>(null);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingComments, setPendingComments] = useState<ReviewCommentPayload[]>([]);
  const [allCommands, setAllCommands] = useState<SlashCommandPayload[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [sessions, setSessions] = useState<ChatSessionPayload[]>([]);
  // Persist the active session per-issue so re-opening the modal lands
  // the composer back on the same session the user last picked. Scoped
  // on `issueNumber` (cheap and human-readable) rather than threadId
  // because the latter is only populated after the first reply.
  const [activeSessionId, setActiveSessionId] = useActiveSessionId(
    `kanbots.issue.${issueNumber}.active-session`,
    null,
  );

  // Load the thread's sessions whenever the thread id appears or the
  // active run id flips (a new run might mean a new session was
  // bootstrapped by the post-message path). Also auto-bootstrap a
  // single default session the first time we land on a thread that has
  // never had one — saves the user from having to click "+ New" before
  // their first reply.
  const threadIdRef = useRef<number | null>(threadId);
  threadIdRef.current = threadId;
  useEffect(() => {
    if (threadId === null) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listThreadChatSessions(threadId);
        if (cancelled) return;
        if (list.length === 0) {
          // Bootstrap a default session pinned to the active run's
          // provider when one is in flight (so resuming an existing run
          // through the dropdown picks the right CLI), otherwise fall
          // back to claude-code as the safe default.
          const fallbackProvider: ProviderId =
            activeRun?.provider === 'claude-code' ||
            activeRun?.provider === 'codex-cli' ||
            activeRun?.provider === 'gemini-cli' ||
            activeRun?.provider === 'agy-cli' ||
            activeRun?.provider === 'amp-cli' ||
            activeRun?.provider === 'cursor-cli' ||
            activeRun?.provider === 'copilot-cli' ||
            activeRun?.provider === 'opencode-cli' ||
            activeRun?.provider === 'droid-cli' ||
            activeRun?.provider === 'ccr-cli' ||
            activeRun?.provider === 'qwen-cli' ||
            activeRun?.provider === 'acp'
              ? activeRun.provider
              : 'claude-code';
          try {
            const created = await api.createThreadChatSession({
              threadId,
              agentProvider: fallbackProvider,
            });
            if (cancelled) return;
            setSessions([created]);
            setActiveSessionId(created.id);
          } catch {
            // Best-effort: the dropdown will simply render empty and
            // the next send goes through without a session tag.
          }
        } else {
          setSessions(list);
          if (activeSessionId === null && list[0]) {
            setActiveSessionId(list[0].id);
          }
        }
      } catch {
        if (!cancelled) setSessions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally exclude activeSessionId / setActiveSessionId so we
    // don't re-fetch on every selection — the dropdown drives its own
    // state and the list only needs to refresh when the thread or
    // active run changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, activeRun?.id]);
  const { focusedRepoId } = useFocusedRepo();

  // Pick the provider to query for slash commands. activeRun.provider can be
  // arbitrary strings from older runs, so narrow defensively.
  const provider: ProviderId = useMemo(() => {
    const p = activeRun?.provider;
    if (
      p === 'claude-code' ||
      p === 'codex-cli' ||
      p === 'gemini-cli' ||
      p === 'agy-cli' ||
      p === 'amp-cli' ||
      p === 'cursor-cli' ||
      p === 'copilot-cli' ||
      p === 'opencode-cli' ||
      p === 'droid-cli' ||
      p === 'ccr-cli' ||
      p === 'qwen-cli' ||
      p === 'acp'
    ) {
      return p;
    }
    return 'claude-code';
  }, [activeRun?.provider]);

  // Discover slash commands for the active provider. Cache-warmed by the
  // backend; cheap to re-fetch on provider switch.
  useEffect(() => {
    let cancelled = false;
    api
      .getSlashCommands(provider)
      .then((cmds) => {
        if (!cancelled) setAllCommands(cmds);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Track pending inline review comments on the active run. Comments are
  // added from the diff viewer (a different surface), so poll periodically
  // while the modal is open.
  const activeRunId = activeRun?.id ?? null;
  useEffect(() => {
    if (activeRunId === null) {
      setPendingComments([]);
      return;
    }
    let cancelled = false;
    function refresh(): void {
      api
        .getReviewComments(activeRunId as number)
        .then((cs) => {
          if (!cancelled) setPendingComments(cs);
        })
        .catch(() => undefined);
    }
    refresh();
    const id = window.setInterval(refresh, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeRunId]);

  // Listen for prefill requests from the preview inspect flow. The Preview
  // tab dispatches `kanbots:composer:insert` with a formatted markdown block
  // describing the clicked element; we append it to the current draft (with
  // a newline separator if non-empty) and focus the input so the user can
  // immediately add a question.
  useEffect(() => {
    function onInsert(e: Event): void {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      const text = detail?.text;
      if (!text) return;
      setBody((prev) => (prev.length === 0 ? text : `${prev}\n${text}`));
      // Defer focus so the controlled-input value lands first.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
    window.addEventListener('kanbots:composer:insert', onInsert);
    return () => window.removeEventListener('kanbots:composer:insert', onInsert);
  }, []);

  // Open the slash-command menu when the input starts with `/` and the
  // first whitespace hasn't appeared yet (i.e. the user is still typing
  // the command name).
  const slashQuery = useMemo<string | null>(() => {
    const m = /^\/(\S*)$/.exec(body);
    return m ? (m[1] ?? '') : null;
  }, [body]);
  const slashOpen = slashQuery !== null;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const filteredCommands = useMemo<SlashCommandPayload[]>(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    if (q.length === 0) return allCommands;
    return allCommands.filter((c) => c.name.toLowerCase().includes(q));
  }, [slashQuery, allCommands]);

  function applySlash(cmd: SlashCommandPayload): void {
    setBody(`/${cmd.name} `);
    inputRef.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (slashOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const cmd = filteredCommands[slashIndex];
        if (cmd) applySlash(cmd);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashIndex];
        if (cmd) applySlash(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setBody('');
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  async function send(): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      let messageBody = trimmed;
      // Consume any pending inline review comments and prepend them as a
      // structured block so the agent sees them as context.
      if (activeRunId !== null && pendingComments.length > 0) {
        const consumed = await api.consumeReviewComments(activeRunId);
        if (consumed.length > 0) {
          const block = consumed
            .map((c) => `- \`${c.filePath}:${c.lineNumber}\` (${c.side}) — ${c.body}`)
            .join('\n');
          messageBody = `Inline review comments:\n${block}\n\n${trimmed}`;
        }
        setPendingComments([]);
      }
      const postOpts: Parameters<typeof api.postMessage>[2] = {};
      if (modelSelection) {
        postOpts.model = modelSelection.model;
        postOpts.provider = modelSelection.provider;
      }
      if (focusedRepoId !== null) postOpts.repoId = focusedRepoId;
      if (activeSessionId !== null) postOpts.chatSessionId = activeSessionId;
      await api.postMessage(issueNumber, messageBody, postOpts);
      setBody('');
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {threadId !== null ? (
        <div className="kb-chat-foot-session">
          <SessionDropdown
            sessions={sessions}
            activeSessionId={activeSessionId}
            onActiveSessionChange={setActiveSessionId}
            onSessionsChange={setSessions}
            onCreateSession={(input) => {
              const args: Parameters<typeof api.createThreadChatSession>[0] = {
                threadId,
                agentProvider: input.provider,
              };
              if (input.model !== null) args.agentModel = input.model;
              if (input.title !== null && input.title.length > 0) {
                args.title = input.title;
              }
              return api.createThreadChatSession(args);
            }}
            onRenameSession={(id, title) => api.renameThreadChatSession(id, title)}
            onDeleteSession={async (id) => {
              await api.deleteThreadChatSession(id);
            }}
          />
        </div>
      ) : null}
      {showAdvanced ? (
        <div className="kb-chat-foot-advanced">
          <label className="kb-chat-foot-field">
            <span className="kb-chat-foot-field-label">Model override</span>
            <ModelPicker
              value={modelSelection}
              onChange={setModelSelection}
              agentRunsOnly
              className="kb-chat-model-picker"
            />
          </label>
        </div>
      ) : null}
      <div className="kb-reply-input-wrap">
        {slashOpen && filteredCommands.length > 0 ? (
          <div className="kb-slash-menu" role="listbox" aria-label="Slash commands">
            {filteredCommands.slice(0, 8).map((cmd, i) => (
              <button
                key={`${cmd.source}:${cmd.name}`}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                className={`kb-slash-item${i === slashIndex ? ' is-active' : ''}`}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => {
                  // Prevent input blur before click fires.
                  e.preventDefault();
                }}
                onClick={() => applySlash(cmd)}
              >
                <span className="kb-slash-name">/{cmd.name}</span>
                <span className="kb-slash-desc">{cmd.description}</span>
                <span className={`kb-slash-src kb-slash-src-${cmd.source}`}>{cmd.source}</span>
              </button>
            ))}
          </div>
        ) : null}
        <input
          ref={inputRef}
          type="text"
          placeholder="/spec to refine · /review to spawn reviewer · /split to fan out…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKey}
          disabled={sending}
        />
      </div>
      {pendingComments.length > 0 ? (
        <span
          className="kb-reply-badge"
          title={`${pendingComments.length} inline review comment${pendingComments.length === 1 ? '' : 's'} will be sent with your next message`}
        >
          {pendingComments.length} comment{pendingComments.length === 1 ? '' : 's'}
        </span>
      ) : null}
      <button
        type="button"
        className="kb-chat-foot-opts-toggle"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
      >
        <span className={`kb-chat-foot-opts-chev${showAdvanced ? ' open' : ''}`} aria-hidden>
          ›
        </span>
        {showAdvanced ? 'Hide options' : 'Options'}
      </button>
      <button
        type="button"
        className="kb-btn primary"
        onClick={() => void send()}
        disabled={!body.trim() || sending}
      >
        {sending ? 'Sending…' : 'Send'} <span className="kb-kbd">⌘↵</span>
      </button>
      {error ? (
        <span style={{ color: 'var(--failed)', fontSize: 11, marginLeft: 8 }}>{error}</span>
      ) : null}
    </>
  );
}

function AsideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ px: 2.5, py: 2, borderBottom: 1, borderColor: 'divider' }}>
      <Typography
        variant="caption"
        color="text.secondary"
        component="div"
        sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, mb: 1.25 }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function AsideRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{ justifyContent: 'space-between', py: 0.5, minWidth: 0 }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        noWrap
        sx={{ minWidth: 0, textAlign: 'right', ...(mono && monoChipSx) }}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </Typography>
    </Stack>
  );
}

function Aside({
  issue,
  activeRun,
  latestRun,
}: {
  issue: IssueDetailPayload['issue'];
  activeRun: AgentRun | null;
  latestRun: AgentRun | null;
}) {
  const links = linkedIssueNumbers(issue.labels);
  const sidebarRun = activeRun ?? latestRun;
  const sidebarHeader = activeRun ? 'Live run' : latestRun ? 'Last run' : 'Run';
  return (
    <>
      <AsideSection title={sidebarHeader}>
        {sidebarRun ? (
          <RunSummary run={sidebarRun} layout="aside" />
        ) : (
          <Typography variant="body2" color="text.secondary">
            No agent runs yet.
          </Typography>
        )}
      </AsideSection>

      <AsideSection title="Properties">
        <AsideRow label="Status" value={issue.status ?? 'inbox'} />
        <AsideRow label="Assignee" value={issue.assignees[0] ?? '—'} />
        <AsideRow label="Priority" value={priorityFromLabels(issue.labels) ?? '—'} />
        <AsideRow label="Folder" value="current" mono />
        <AsideRow label="Worktree" value={sidebarRun?.worktreePath ?? '—'} mono />
        <AsideRow label="Branch" value={sidebarRun?.branchName ?? '—'} mono />
        <AsideRow label="Base" value={sidebarRun?.baseBranch ?? '—'} mono />
      </AsideSection>

      {links.length > 0 ? (
        <AsideSection title="Linked">
          <LinkedIssues numbers={links} currentNumber={issue.number} />
        </AsideSection>
      ) : null}

      <AsideSection title="Author">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Avatar
            sx={{ width: 24, height: 24, fontSize: 11, bgcolor: colorForLogin(issue.user.login) }}
          >
            {issue.user.login.slice(0, 1).toUpperCase()}
          </Avatar>
          <Typography variant="body2">{issue.user.login}</Typography>
        </Stack>
      </AsideSection>
    </>
  );
}

function LinkedIssues({
  numbers,
  currentNumber,
}: {
  numbers: IssueRef[];
  currentNumber: IssueRef;
}) {
  const { issues } = useIssues();
  return (
    <Stack spacing={0.75}>
      {numbers
        .filter((n) => String(n) !== String(currentNumber))
        .map((n) => {
          const linked = issues.find((i) => String(i.number) === String(n));
          return (
            <Box
              key={String(n)}
              component="a"
              href={`#/issue/${n}`}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1,
                py: 0.75,
                borderRadius: 1,
                border: 1,
                borderColor: 'divider',
                color: 'inherit',
                textDecoration: 'none',
                '&:hover': { borderColor: 'primary.main' },
              }}
            >
              <Typography variant="caption" color="text.secondary" sx={monoChipSx}>
                #{n}
              </Typography>
              <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                {linked?.title ?? '(not loaded)'}
              </Typography>
              {linked?.state === 'closed' ? (
                <Chip size="small" variant="light" color="info" label="closed" />
              ) : null}
            </Box>
          );
        })}
    </Stack>
  );
}

/**
 * Renders a compact "Parent: #<n> · <title>" link above the issue title
 * when the current issue has at least one recorded parent. Clicking the
 * link navigates to the parent via `onOpenDetail`. If no parent is
 * recorded (the issue is a root) the component renders nothing.
 */
function ParentBreadcrumb({
  childNumber,
  onOpenDetail,
}: {
  childNumber: IssueRef;
  onOpenDetail?: (issueNumber: IssueRef) => void;
}) {
  const [parents, setParents] = useState<IssueRelationPayload[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .listIssueParents(childNumber)
      .then((rows) => {
        if (!cancelled) setParents(rows);
      })
      .catch(() => {
        if (!cancelled) setParents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [childNumber]);

  if (loading || parents.length === 0) return null;

  return (
    <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
      {parents.map((p) => (
        <Button
          key={p.id}
          size="small"
          color="secondary"
          onClick={() => onOpenDetail?.(p.child.number)}
          disabled={!onOpenDetail}
          title={`Open parent #${p.child.number}`}
          sx={{ px: 1, minWidth: 0, textTransform: 'none' }}
        >
          <Box component="span" sx={{ color: 'text.secondary', mr: 0.75 }}>
            Parent
          </Box>
          <Box component="span" sx={{ ...monoChipSx, mr: 0.75 }}>
            #{p.child.number}
          </Box>
          {p.child.title}
        </Button>
      ))}
    </Stack>
  );
}

function statusBadge(status: StatusKey | null): {
  label: string;
  color: 'secondary' | 'primary' | 'success' | 'info';
} {
  // Short forms suitable for a tight list row.
  switch (status) {
    case 'backlog':
      return { label: 'backlog', color: 'secondary' };
    case 'todo':
      return { label: 'todo', color: 'primary' };
    case 'inProgress':
      return { label: 'in progress', color: 'success' };
    case 'review':
      return { label: 'review', color: 'info' };
    case 'done':
      return { label: 'done', color: 'success' };
    default:
      return { label: 'inbox', color: 'secondary' };
  }
}

/** The bordered surface used for markdown, descriptions and list rows. */
const panelSx = {
  p: 2,
  borderRadius: 1,
  border: 1,
  borderColor: 'divider',
  bgcolor: 'background.default',
};

/**
 * Renders the list of child sub-issues for `parentNumber` plus an
 * affordance to link an existing issue as a new sub-issue. Creating a
 * brand-new sub-issue via the create modal is intentionally out of
 * scope here — the user can create the issue first, then link it. That
 * keeps this surface narrow and avoids cross-modal state passing.
 */
function SubIssuesSection({
  parentNumber,
  onOpenDetail,
}: {
  parentNumber: IssueRef;
  onOpenDetail?: (issueNumber: IssueRef) => void;
}) {
  const [children, setChildren] = useState<IssueRelationPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { issues: allIssues } = useIssues();

  const refresh = useCallback(async () => {
    try {
      const rows = await api.listIssueChildren(parentNumber);
      setChildren(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [parentNumber]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  async function handleRemove(id: number): Promise<void> {
    setError(null);
    try {
      await api.removeIssueRelation(id);
      await refresh();
      // Re-fetch the board so the "↳N" badge stays in sync after an
      // unlink (the count lives on the decorated issue and only
      // refreshes when the issues list refetches).
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAdd(childNumber: IssueRef): Promise<void> {
    setError(null);
    try {
      await api.addIssueRelation({ parentNumber, childNumber });
      setAdding(false);
      await refresh();
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <TabSection title="Sub-issues">
      <Stack spacing={1}>
        {error ? (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        ) : null}
        {loading ? (
          <Typography variant="body2" color="text.secondary">
            Loading…
          </Typography>
        ) : children.length === 0 && !adding ? (
          <Typography variant="body2" color="text.secondary">
            No sub-issues yet.
          </Typography>
        ) : (
          children.map((rel) => {
            const badge = statusBadge(rel.child.status);
            return (
              <Stack key={rel.id} direction="row" spacing={1} sx={{ ...rowSx, py: 0.5, pr: 0.5 }}>
                <Chip size="small" variant="light" color={badge.color} label={badge.label} />
                <Button
                  color="inherit"
                  onClick={() => onOpenDetail?.(rel.child.number)}
                  disabled={!onOpenDetail}
                  title={`Open #${rel.child.number}`}
                  sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', textTransform: 'none' }}
                >
                  <Box component="span" sx={{ ...monoChipSx, color: 'text.secondary', mr: 1 }}>
                    #{rel.child.number}
                  </Box>
                  <Box
                    component="span"
                    sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {rel.child.title}
                  </Box>
                </Button>
                {rel.child.state === 'closed' ? (
                  <Chip size="small" variant="light" color="info" label="closed" />
                ) : null}
                <Tooltip title="Unlink (the issue is not deleted)">
                  <IconButton
                    size="small"
                    color="secondary"
                    onClick={() => void handleRemove(rel.id)}
                    aria-label={`Unlink #${rel.child.number}`}
                  >
                    <IconsaxIcon icon={CloseCircle} size={16} />
                  </IconButton>
                </Tooltip>
              </Stack>
            );
          })
        )}
        {adding ? (
          <SubIssueAddPicker
            parentNumber={parentNumber}
            existing={new Set(children.map((c) => c.child.number))}
            allIssues={allIssues}
            onPick={(n) => void handleAdd(n)}
            onCancel={() => {
              setAdding(false);
              setError(null);
            }}
          />
        ) : (
          <Box>
            <Button
              size="small"
              color="secondary"
              variant="outlined"
              startIcon={<IconsaxIcon icon={Add} size={16} />}
              onClick={() => setAdding(true)}
            >
              Add sub-issue
            </Button>
          </Box>
        )}
      </Stack>
    </TabSection>
  );
}

/**
 * Inline picker that lets the user filter the workspace issue list by
 * number/title and pick one to link as a sub-issue. Lives inside the
 * SubIssuesSection so it can share the section's refresh callback and
 * error state without the host modal having to mediate.
 */
function SubIssueAddPicker({
  parentNumber,
  existing,
  allIssues,
  onPick,
  onCancel,
}: {
  parentNumber: IssueRef;
  existing: Set<IssueRef>;
  allIssues: ReadonlyArray<{
    number: IssueRef;
    title: string;
    state: 'open' | 'closed';
  }>;
  onPick: (issueNumber: IssueRef) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  // Filter to: non-self, non-already-linked, fuzzy-match against
  // number/title. The list comes from `useIssues()` so it reflects the
  // open board — the user can always cancel and link a closed issue by
  // re-opening it first (linking closed issues is intentionally not a
  // happy path on the board).
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = allIssues.filter((i) => {
      if (String(i.number) === String(parentNumber)) return false;
      if ([...existing].some((n) => String(n) === String(i.number))) return false;
      if (!q) return true;
      const numStr = `#${i.number}`;
      return (
        numStr.includes(q) || i.title.toLowerCase().includes(q) || String(i.number).includes(q)
      );
    });
    return filtered.slice(0, 8);
  }, [allIssues, query, parentNumber, existing]);

  return (
    <Box sx={panelSx}>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Search by # or title…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <Button color="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </Stack>
      {matches.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No matches.
        </Typography>
      ) : (
        <Stack>
          {matches.map((i) => (
            <Button
              key={String(i.number)}
              color="inherit"
              onClick={() => onPick(i.number)}
              sx={{ justifyContent: 'flex-start', textTransform: 'none' }}
            >
              <Box component="span" sx={{ ...monoChipSx, color: 'text.secondary', mr: 1 }}>
                #{i.number}
              </Box>
              {i.title}
            </Button>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function OverviewTab({
  issue,
  displayRun,
  cloudRunId,
  onOpenDetail,
}: {
  issue: IssueDetailPayload['issue'];
  displayRun: AgentRun | null;
  cloudRunId: string | null;
  onOpenDetail?: (issueNumber: IssueRef) => void;
}) {
  const stream = useIssueRunStream(
    displayRun,
    cloudRunId,
    typeof issue.number === 'number' ? issue.number : undefined,
  );
  const { data: savedSpec } = useFetch(`spec:${issue.number}`, () => api.getSpec(issue.number));
  const recentToolCalls = stream.events
    .filter((e) => e.type === 'tool_use')
    .slice(-4)
    .reverse();
  const resultByToolUseId = buildResultIndex(stream.events);
  const acMatches = (issue.body ?? '').match(/(?:^|\n)\s*AC:\s*\n((?:[-*]\s.+\n?)+)/);
  const acItems =
    acMatches?.[1]?.match(/(?:^|\n)[-*]\s(.+)/g)?.map((l) => l.replace(/^[\s-*]+/, '')) ?? [];

  return (
    <>
      {issue.sentryMeta ? <SentryAnalysisSection issue={issue} /> : null}
      <AgentSessionSection run={displayRun} />

      <TabSection title="Description">
        <Typography
          variant="body2"
          component="div"
          sx={{ ...panelSx, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}
        >
          {issue.body || '(no description)'}
        </Typography>
      </TabSection>

      <SubIssuesSection parentNumber={issue.number} {...(onOpenDetail ? { onOpenDetail } : {})} />

      {savedSpec?.content !== null && savedSpec?.content !== undefined ? (
        <TabSection title="Spec">
          <Box
            className="kb-desc-md"
            sx={panelSx}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(savedSpec.content) }}
          />
        </TabSection>
      ) : null}

      {acItems.length > 0 ? (
        <TabSection title="Spec — extracted from AC: block">
          <Stack component="ul" spacing={0.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
            {acItems.map((item, i) => (
              <Stack
                component="li"
                key={i}
                direction="row"
                spacing={1}
                sx={{ alignItems: 'flex-start' }}
              >
                <Box
                  aria-hidden
                  sx={{
                    width: 14,
                    height: 14,
                    mt: 0.4,
                    borderRadius: 0.5,
                    border: 1,
                    borderColor: 'divider',
                    flexShrink: 0,
                  }}
                />
                <Typography variant="body2">{item}</Typography>
              </Stack>
            ))}
          </Stack>
        </TabSection>
      ) : null}

      {recentToolCalls.length > 0 ? (
        <TabSection title="What the agent did just now">
          {recentToolCalls.map((ev) => (
            <ToolUseCard
              key={ev.id}
              toolUse={ev}
              result={resultByToolUseId.get(toolUseIdOf(ev)) ?? null}
              isLive={false}
            />
          ))}
        </TabSection>
      ) : null}
    </>
  );
}

function AgentSessionSection({ run }: { run: AgentRun | null }) {
  const [copyOk, setCopyOk] = useState(false);

  if (!run?.sessionId) return null;

  const resumeCommand = buildResumeCommand(run.provider, run.sessionId, run.worktreePath);
  const hasResumeCommand = hasTerminalResumeCommand(run.provider);
  const providerLabel = run.provider
    ? (PROVIDER_LABELS[run.provider as keyof typeof PROVIDER_LABELS] ?? run.provider)
    : 'Unknown provider';

  async function copySession(): Promise<void> {
    try {
      await navigator.clipboard.writeText(resumeCommand);
      setCopyOk(true);
      window.setTimeout(() => setCopyOk(false), 1200);
    } catch {
      // Ignore — clipboard may be unavailable in restricted contexts.
    }
  }

  return (
    <TabSection title="Agent session">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Chip size="small" variant="outlined" label={providerLabel} />
        <Tooltip title={run.sessionId}>
          <Chip
            size="small"
            variant="outlined"
            label={run.sessionId}
            sx={{ ...monoChipSx, maxWidth: 360 }}
          />
        </Tooltip>
        <Button
          size="small"
          color={copyOk ? 'success' : 'secondary'}
          onClick={() => void copySession()}
          aria-label={hasResumeCommand ? 'Copy resume command' : 'Copy session ID'}
        >
          {copyOk ? 'Copied' : hasResumeCommand ? 'Copy command' : 'Copy ID'}
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75 }}>
        {hasResumeCommand ? 'Resume this session in your terminal' : 'Provider-specific session ID'}
      </Typography>
    </TabSection>
  );
}

const SENTRY_STATUS_LABEL: Record<string, string> = {
  analyzed: 'analyzed',
  applied: 'applied',
  upstream_resolved: 'upstream resolved',
};

function SentryAnalysisSection({ issue }: { issue: IssueDetailPayload['issue'] }) {
  const meta = issue.sentryMeta;
  const [suggestion, setSuggestion] = useState<SentrySuggestion | null>(meta?.suggestion ?? null);
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!meta) return null;

  async function handleAnalyze(): Promise<void> {
    if (analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      const result = await api.analyzeSentryIssue(issue.number);
      setSuggestion(result);
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleApply(): Promise<void> {
    if (applying) return;
    setApplying(true);
    setError(null);
    try {
      await api.applySentrySuggestion(issue.number);
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <TabSection
      title="Sentry"
      action={
        <Chip
          size="small"
          variant="light"
          color={meta.status === 'imported' ? 'error' : 'secondary'}
          label={SENTRY_STATUS_LABEL[meta.status] ?? 'unreviewed'}
        />
      }
    >
      <Stack spacing={1.25}>
        {meta.errorType ? (
          <Box component="code" sx={{ ...panelSx, ...monoChipSx, p: 1.25, fontSize: 12 }}>
            {meta.errorType}: {meta.errorValue ?? ''}
          </Box>
        ) : null}
        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">
            Occurrences: {meta.count}
          </Typography>
          {meta.culprit ? (
            <Typography variant="body2" color="text.secondary">
              Where: {meta.culprit}
            </Typography>
          ) : null}
          {meta.permalink ? (
            <Typography
              variant="body2"
              component="a"
              href={meta.permalink}
              target="_blank"
              rel="noreferrer noopener"
              sx={{ color: 'primary.main' }}
            >
              View in Sentry ↗
            </Typography>
          ) : null}
        </Stack>

        {error ? <Alert severity="error">{error}</Alert> : null}

        {suggestion ? (
          <Box sx={panelSx}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
              <Tooltip
                title={`Confidence: ${suggestion.confidence} · Category: ${suggestion.category}`}
              >
                <Chip
                  size="small"
                  variant="light"
                  color={suggestion.verdict === 'task' ? 'warning' : 'secondary'}
                  label={
                    suggestion.verdict === 'task'
                      ? 'Recommend converting to task'
                      : 'Likely skippable'
                  }
                />
              </Tooltip>
              <Typography variant="caption" color="text.secondary">
                {suggestion.confidence} confidence · {suggestion.category}
              </Typography>
            </Stack>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {suggestion.reasoning}
            </Typography>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              <strong>Suggested title:</strong> {suggestion.suggestedTitle}
            </Typography>
            <details>
              <summary>Suggested body</summary>
              <Box
                component="pre"
                sx={{ ...monoChipSx, whiteSpace: 'pre-wrap', fontSize: 12, mt: 1, mb: 0 }}
              >
                {suggestion.suggestedBody}
              </Box>
            </details>
            <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
              <Button
                size="small"
                variant="contained"
                onClick={() => void handleApply()}
                disabled={applying || meta.status === 'applied'}
              >
                {meta.status === 'applied' ? 'Applied' : applying ? 'Applying…' : 'Convert to task'}
              </Button>
              <Button
                size="small"
                color="secondary"
                onClick={() => void handleAnalyze()}
                disabled={analyzing}
              >
                {analyzing ? 'Re-analyzing…' : 'Re-analyze'}
              </Button>
            </Stack>
          </Box>
        ) : (
          <Box>
            <Button
              size="small"
              variant="contained"
              onClick={() => void handleAnalyze()}
              disabled={analyzing}
            >
              {analyzing ? 'Analyzing…' : 'Analyze'}
            </Button>
          </Box>
        )}
      </Stack>
    </TabSection>
  );
}

type TimelineItem =
  | { kind: 'event'; sortKey: string; id: string; event: AgentEvent }
  | { kind: 'message'; sortKey: string; id: string; message: Message; cards: Card[] };

function ThreadTab({
  activeRun,
  displayRun,
  cloudRunId,
  runs,
  messages,
  issueNumber,
  issueLabels,
  issueStatus,
  onActionDone,
}: {
  activeRun: AgentRun | null;
  displayRun: AgentRun | null;
  cloudRunId: string | null;
  /** Provider of every run in the thread — used to attribute each agent
   * message to the provider that actually authored it. Undefined for
   * legacy/cloud payloads without local run rows. */
  runs: readonly { id: number; provider: string | null }[] | undefined;
  messages: Message[];
  issueNumber: IssueRef;
  issueLabels: readonly string[];
  issueStatus: StatusKey | null;
  onActionDone: () => void;
}) {
  const stream = useIssueRunStream(
    displayRun,
    cloudRunId,
    typeof issueNumber === 'number' ? issueNumber : undefined,
  );
  const isLive = cloudRunId !== null || (activeRun !== null && activeRun.id === displayRun?.id);

  const cardsByMessageId = new Map<number, Card[]>();
  for (const c of stream.cards) {
    const arr = cardsByMessageId.get(c.messageId) ?? [];
    arr.push(c);
    cardsByMessageId.set(c.messageId, arr);
  }

  // Pair every tool_use with its tool_result (matched on toolUseId) so the
  // ToolUseCard can render both halves inside one card.
  const resultByToolUseId = buildResultIndex(stream.events);

  const items: TimelineItem[] = [];
  for (const m of messages) {
    items.push({
      kind: 'message',
      sortKey: m.createdAt,
      id: `m${m.id}`,
      message: m,
      cards: cardsByMessageId.get(m.id) ?? [],
    });
  }
  // Label for agent-authored messages: the run's actual provider (e.g.
  // "OpenCode"), falling back to the raw id, then "agent" for legacy
  // runs that predate the provider column.
  const agentLabel =
    displayRun?.provider != null
      ? (PROVIDER_LABELS[displayRun.provider as keyof typeof PROVIDER_LABELS] ??
        displayRun.provider)
      : 'agent';
  // Threads can mix providers across runs (the user picks a different
  // agent per run), so prefer the provider of the run that authored each
  // message over the thread-wide displayRun label.
  const providerByRunId = new Map<number, string | null>();
  for (const r of runs ?? []) providerByRunId.set(r.id, r.provider);
  function labelForMessage(m: Message): string {
    if (m.agentRunId === null || !providerByRunId.has(m.agentRunId)) return agentLabel;
    const provider = providerByRunId.get(m.agentRunId) ?? null;
    return provider != null
      ? (PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider)
      : 'agent';
  }
  for (const e of stream.events) {
    // tool_result events are folded into their tool_use parent.
    if (e.type === 'tool_result') continue;
    items.push({ kind: 'event', sortKey: e.createdAt, id: `e${e.id}`, event: e });
  }
  items.sort((a, b) => {
    if (a.sortKey === b.sortKey) return a.id.localeCompare(b.id);
    return a.sortKey < b.sortKey ? -1 : 1;
  });

  // Show the agent spinner whenever the run is still doing work — same
  // status set the header pill considers "active".
  const isRunning =
    displayRun !== null &&
    (displayRun.status === 'running' ||
      displayRun.status === 'starting' ||
      displayRun.status === 'awaiting_input');

  const sectionRef = useRef<HTMLDivElement | null>(null);
  useStickToBottom(sectionRef, [items.length, stream.events.length, isRunning]);

  if (items.length === 0 && !isRunning) {
    return (
      <>
        <div className="kb-tdm-section" ref={sectionRef}>
          <h3>Agent thread</h3>
          <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
            No agent activity yet. Reply below to start the conversation.
          </div>
        </div>
        <PrCommentsSection issueNumber={issueNumber} />
      </>
    );
  }

  return (
    <>
      <div className="kb-tdm-section" ref={sectionRef}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Agent thread</h3>
          {displayRun ? (
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              run #{displayRun.id} · {STATUS_LABEL[displayRun.status]}
              {isLive
                ? ''
                : ` · ended ${ageString(displayRun.endedAt ?? displayRun.startedAt)} ago`}
            </span>
          ) : null}
          {displayRun != null &&
          (displayRun.status === 'running' || displayRun.status === 'starting') ? (
            <KodraPulse tone="mint" style={{ alignSelf: 'center' }} />
          ) : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((it) =>
            it.kind === 'message' ? (
              <MessageRow
                key={it.id}
                message={it.message}
                cards={it.cards}
                agentLabel={labelForMessage(it.message)}
              />
            ) : it.event.type === 'tool_use' ? (
              <ToolUseCard
                key={it.id}
                toolUse={it.event}
                result={resultByToolUseId.get(toolUseIdOf(it.event)) ?? null}
                isLive={isLive}
              />
            ) : (
              <EventRow key={it.id} event={it.event} agentLabel={agentLabel} />
            ),
          )}
          {isRunning && displayRun ? (
            <AgentSpinner
              seed={displayRun.id}
              startedAt={displayRun.startedAt}
              tokensOut={displayRun.tokenUsageOutput ?? null}
            />
          ) : null}
          {displayRun && displayRun.status === 'complete' ? (
            <CompletionActions
              runId={displayRun.id}
              issueNumber={issueNumber}
              issueLabels={issueLabels}
              issueStatus={issueStatus}
              onChanged={onActionDone}
            />
          ) : null}
        </div>
      </div>
      <PrCommentsSection issueNumber={issueNumber} />
    </>
  );
}

/**
 * Section appended to the Thread tab that surfaces the comments on the
 * GitHub PR linked to this issue (when one exists). Polls every 30s
 * while the modal is mounted; degrades to a single fetch on mount when
 * the workspace is in local mode or the PR can't be located.
 */
function PrCommentsSection({ issueNumber }: { issueNumber: IssueRef }) {
  const [data, setData] = useState<PrCommentsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [posting, setPosting] = useState(false);

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const next = await api.listPrComments(issueNumber);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [issueNumber]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.listPrComments(issueNumber);
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    // Poll every 30s while the modal is open. Tolerable for a personal
    // PAT (~120 calls/hr); the conditional fetch (cache-aware Octokit
    // hook already in GitHubClient) makes most polls return 304.
    const interval = window.setInterval(() => {
      void refetch();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [issueNumber, refetch]);

  const onSubmitReply = useCallback(async (): Promise<void> => {
    const trimmed = replyBody.trim();
    if (trimmed.length === 0 || posting) return;
    setPosting(true);
    setError(null);
    try {
      await api.replyToPrComment(issueNumber, trimmed);
      setReplyBody('');
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }, [replyBody, posting, issueNumber, refetch]);

  // Hide the section entirely when the workspace can't surface PR
  // comments (local mode, no linked PR, or initial load hasn't returned
  // yet AND there's nothing to render).
  if (data === null && error === null) return null;
  if (data !== null && data.linkedPullNumber === null) return null;

  const comments = data?.comments ?? [];
  const inlineGroups = groupInlineComments(comments);
  const conversationComments = comments.filter((c) => !c.inline);

  return (
    <div className="kb-pr-comments">
      <div className="kb-pr-comments-head">
        <GitHubGlyph />
        <span>PR review</span>
        {data?.linkedPullNumber !== undefined && data.linkedPullNumber !== null ? (
          <a
            href={data.linkedPullHtmlUrl ?? '#'}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: 'var(--ink-3)', marginLeft: 4 }}
          >
            #{data.linkedPullNumber}
          </a>
        ) : null}
      </div>
      {error ? (
        <div style={{ color: 'var(--failed)', fontSize: 12, marginBottom: 8 }}>{error}</div>
      ) : null}
      {comments.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
          No comments on the PR yet.
        </div>
      ) : null}
      {conversationComments.map((c) => (
        <PrCommentRow key={`c${c.id}`} comment={c} />
      ))}
      {inlineGroups.map((group) => (
        <div key={`g:${group.filePath}`}>
          <div className="kb-pr-comment-file">{group.filePath}</div>
          {group.comments.map((c) => (
            <PrCommentRow key={`i${c.id}`} comment={c} />
          ))}
        </div>
      ))}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          placeholder="Reply on the PR…"
          rows={2}
          style={{
            background: 'var(--bg-1)',
            border: '1px solid var(--hairline)',
            borderRadius: 8,
            padding: '6px 9px',
            fontSize: 12.5,
            color: 'var(--ink-1)',
            outline: 'none',
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="kb-btn ghost"
            disabled={posting || replyBody.trim().length === 0}
            onClick={() => void onSubmitReply()}
          >
            {posting ? 'Posting…' : 'Reply on PR'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface InlineCommentGroup {
  filePath: string;
  comments: PrCommentPayload[];
}

function groupInlineComments(comments: ReadonlyArray<PrCommentPayload>): InlineCommentGroup[] {
  const byFile = new Map<string, PrCommentPayload[]>();
  for (const c of comments) {
    if (!c.inline) continue;
    const path = c.filePath ?? '(unknown)';
    const list = byFile.get(path) ?? [];
    list.push(c);
    byFile.set(path, list);
  }
  return Array.from(byFile.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, list]) => ({ filePath, comments: list }));
}

function PrCommentRow({ comment }: { comment: PrCommentPayload }) {
  const login = comment.author.login;
  const initials = login.slice(0, 2).toUpperCase();
  const tone = colorForLogin(login);
  return (
    <div className="kb-pr-comment">
      {comment.author.avatarUrl ? (
        <img className="kb-pr-comment-avatar" src={comment.author.avatarUrl} alt={login} />
      ) : (
        <span
          className="kb-pr-comment-avatar"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: tone,
            color: 'var(--bg-1)',
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {initials}
        </span>
      )}
      <div>
        <div className="kb-pr-comment-meta">
          <a
            href={comment.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: 'var(--ink-1)', fontWeight: 500 }}
          >
            {login}
          </a>
          {' · '}
          {ageString(comment.createdAt)} ago
          {comment.inline && comment.lineNumber !== undefined
            ? ` · line ${comment.lineNumber}`
            : ''}
        </div>
        <div className="kb-pr-comment-body">{comment.body}</div>
      </div>
    </div>
  );
}

function GitHubGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// Pin the scroll container to the bottom while the user is already at (or
// near) the bottom. If they scroll up, leave them alone until they scroll
// back down within `threshold` px of the bottom.
function useStickToBottom(
  anchorRef: RefObject<HTMLElement | null>,
  deps: ReadonlyArray<unknown>,
  threshold = 80,
): void {
  const pinnedRef = useRef(true);
  const scrollerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const scroller = el.closest('.kb-modal-main') as HTMLElement | null;
    scrollerRef.current = scroller;
    if (!scroller) return;
    const onScroll = (): void => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      pinnedRef.current = distance <= threshold;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [anchorRef, threshold]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Wait for layout to settle (images, code blocks expanding, etc.).
    const id = requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function buildResultIndex(events: AgentEvent[]): Map<string, AgentEvent> {
  const idx = new Map<string, AgentEvent>();
  for (const e of events) {
    if (e.type !== 'tool_result') continue;
    const id = (e.payload as { toolUseId?: unknown }).toolUseId;
    if (typeof id === 'string') idx.set(id, e);
  }
  return idx;
}

function toolUseIdOf(ev: AgentEvent): string {
  const id = (ev.payload as { toolUseId?: unknown }).toolUseId;
  return typeof id === 'string' ? id : `seq:${ev.seq}`;
}

function CompletionActions({
  runId,
  issueNumber,
  issueLabels,
  issueStatus,
  onChanged,
}: {
  runId: number;
  issueNumber: IssueRef;
  issueLabels: readonly string[];
  issueStatus: StatusKey | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [prModalOpen, setPrModalOpen] = useState(false);
  const alreadyDone = issueStatus === 'done';
  const { focusedRepoId } = useFocusedRepo();

  async function call<T>(
    name: string,
    fn: () => Promise<T>,
    success: (r: T) => string,
  ): Promise<void> {
    setBusy(name);
    setError(null);
    setInfo(null);
    try {
      const r = await fn();
      setInfo(success(r));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        border: '1px solid var(--accent-line)',
        borderRadius: 8,
        padding: 12,
        background: 'color-mix(in oklch, var(--bg-1) 80%, var(--accent-soft))',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 8 }}>
        <b style={{ color: 'var(--accent)' }}>Run complete.</b> What's next?
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          className="kb-btn ghost"
          disabled={busy !== null}
          onClick={() =>
            void call(
              'review',
              () =>
                api.spawnReviewer(
                  issueNumber,
                  focusedRepoId !== null ? { repoId: focusedRepoId } : {},
                ),
              (r) => `Review agent started — run #${r.id}`,
            )
          }
        >
          {busy === 'review' ? 'Spawning…' : 'Review code'}
        </button>
        <button
          type="button"
          className="kb-btn ghost"
          disabled={busy !== null || alreadyDone}
          onClick={() =>
            void call(
              'mark-complete',
              () =>
                api.updateIssue(issueNumber, {
                  labels: withStatus(issueLabels, 'done'),
                }),
              () => 'Marked complete · worktrees cleaned up (unmerged branches kept)',
            )
          }
        >
          {busy === 'mark-complete'
            ? 'Marking…'
            : alreadyDone
              ? 'Marked complete'
              : 'Mark as complete'}
        </button>
        <button
          type="button"
          className="kb-btn ghost"
          disabled={busy !== null}
          onClick={() => {
            setError(null);
            setInfo(null);
            setPrModalOpen(true);
          }}
          title="Drafts a title + body from this run's diff, then opens the PR with your edits."
        >
          Open draft PR
        </button>
      </div>
      {info ? (
        <div style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 8 }}>{info}</div>
      ) : null}
      {error ? (
        <div style={{ fontSize: 11, color: 'var(--failed)', marginTop: 8 }}>error: {error}</div>
      ) : null}
      {prModalOpen ? (
        <CreatePrModal
          runId={runId}
          onClose={() => setPrModalOpen(false)}
          onCreated={(prUrl) => {
            setPrModalOpen(false);
            setInfo(`PR opened: ${prUrl}`);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function MessageRow({
  message,
  cards,
  agentLabel,
}: {
  message: Message;
  cards: Card[];
  /** Provider-derived label for agent messages (e.g. "OpenCode"). */
  agentLabel: string;
}) {
  if (message.role === 'system') {
    return (
      <div
        style={{
          fontSize: 11,
          color: 'var(--ink-3)',
          textAlign: 'center',
          padding: '4px 0',
        }}
      >
        — {message.body} · {ageString(message.createdAt)} ago —
        {cards.map((c) =>
          c.type === 'decision' ? (
            <DecisionInline key={c.id} card={c as Card<DecisionPayload>} />
          ) : null,
        )}
      </div>
    );
  }
  const isUser = message.role === 'user';
  const label = isUser ? 'you' : agentLabel;
  const labelColor = isUser ? 'var(--ink-1)' : 'var(--accent)';
  const bg = isUser ? 'var(--bg-2)' : 'color-mix(in oklch, var(--bg-1) 80%, var(--accent-soft))';
  const border = isUser ? 'var(--hairline)' : 'var(--accent-line)';
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 5 }}>
        <b style={{ color: labelColor }}>{label}</b> · {ageString(message.createdAt)} ago
      </div>
      <div
        style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-1)', whiteSpace: 'pre-wrap' }}
      >
        {message.body}
      </div>
      {cards.map((c) =>
        c.type === 'decision' ? (
          <DecisionInline key={c.id} card={c as Card<DecisionPayload>} />
        ) : null,
      )}
    </div>
  );
}

function DecisionInline({ card }: { card: Card<DecisionPayload> }) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPending = card.status === 'pending';
  const isResolved = card.status === 'resolved';
  const isDismissed = card.status === 'dismissed';

  async function pick(value: string): Promise<void> {
    if (!isPending || submitting !== null) return;
    setSubmitting(value);
    setError(null);
    try {
      await api.resolveCard(card.id, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
    }
  }

  async function dismiss(): Promise<void> {
    if (!isPending || submitting !== null) return;
    setSubmitting('__dismiss');
    setError(null);
    try {
      await api.dismissCard(card.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
    }
  }

  return (
    <div
      className="kb-decision"
      role="region"
      aria-label="Agent question"
      style={{ marginTop: 10 }}
    >
      <div className="kb-decision-opts">
        {isPending ? (
          <KodraPulse
            tone="violet"
            size={7}
            label="Awaiting your decision"
            style={{ alignSelf: 'center' }}
          />
        ) : null}
        {card.payload.options.map((opt, i) => (
          <button
            key={opt.value}
            type="button"
            className={`kb-decision-opt${submitting === opt.value ? ' chosen' : ''}`}
            disabled={!isPending || submitting !== null}
            onClick={() => void pick(opt.value)}
          >
            <span className="num">{i + 1}</span>
            {opt.label}
          </button>
        ))}
        {isPending ? (
          <button
            key="__dismiss"
            type="button"
            className="kb-decision-opt dismiss"
            disabled={submitting !== null}
            onClick={() => void dismiss()}
            title="Dismiss this decision and stop the run"
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {isResolved ? <div className="kb-decision-resolved-note">resolved</div> : null}
      {isDismissed ? <div className="kb-decision-resolved-note">dismissed</div> : null}
      {error ? <div className="kb-decision-resolved-note">error: {error}</div> : null}
    </div>
  );
}

function EventRow({ event, agentLabel }: { event: AgentEvent; agentLabel: string }) {
  if (event.type === 'text') {
    const text = (event.payload as { text?: string }).text ?? '';
    return (
      <div
        style={{
          background: 'color-mix(in oklch, var(--bg-1) 80%, var(--accent-soft))',
          border: '1px solid var(--accent-line)',
          borderRadius: 8,
          padding: '10px 12px',
        }}
      >
        <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 5 }}>
          <b style={{ color: 'var(--accent)' }}>{agentLabel}</b> · {ageString(event.createdAt)} ago
        </div>
        <div
          style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-1)', whiteSpace: 'pre-wrap' }}
        >
          {text}
        </div>
      </div>
    );
  }
  if (event.type === 'error') {
    const p = event.payload as { message?: string };
    return (
      <div className="kb-tcall" style={{ borderColor: 'var(--failed)' }}>
        <div className="kb-tcall-head">
          <span className="name" style={{ color: 'var(--failed)' }}>
            error
          </span>
          <span className="arg">{p.message ?? 'unknown'}</span>
          <span className="dur">{ageString(event.createdAt)} ago</span>
        </div>
      </div>
    );
  }
  if (event.type === 'containment_warning') {
    const p = event.payload as {
      tool?: string;
      reason?: string;
      paths?: string[];
      heuristic?: boolean;
      mode?: string;
    };
    const arg =
      `${p.tool ?? 'tool'} → ${(p.paths ?? []).join(', ') || '(unknown path)'}` +
      (p.heuristic ? ' (heuristic)' : '');
    return (
      <div
        className="kb-tcall"
        style={{
          borderColor: 'var(--warning, #c47a00)',
          background: 'color-mix(in oklch, var(--bg-1) 80%, #c47a0033)',
        }}
      >
        <div className="kb-tcall-head">
          <span className="name" style={{ color: 'var(--warning, #c47a00)' }}>
            ⚠ containment {p.mode === 'pause' ? 'pause' : 'warn'}
          </span>
          <span className="arg" title={p.reason}>
            {arg}
          </span>
          <span className="dur">{ageString(event.createdAt)} ago</span>
        </div>
      </div>
    );
  }
  return null;
}

function DiffTabModal({ activeRun }: { activeRun: AgentRun | null }) {
  const [data, setData] = useState<DiffPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeRun) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getAgentRunDiff(activeRun.id)
      .then((p) => {
        if (!cancelled) setData(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun?.id]);

  if (!activeRun) {
    return (
      <div className="kb-tdm-section">
        <h3>Diff</h3>
        <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
          No active run for this issue.
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="kb-tdm-section">
        <h3>Diff</h3>
        <div className="kb-desc-md">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="kb-tdm-section">
        <h3>Diff</h3>
        <div className="kb-desc-md" style={{ color: 'var(--failed)' }}>
          {error}
        </div>
      </div>
    );
  }
  if (!data || data.empty) {
    return (
      <div className="kb-tdm-section">
        <h3>Diff</h3>
        <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
          No changes vs. base.
        </div>
      </div>
    );
  }
  return (
    <div className="kb-tdm-section">
      <h3>
        Diff vs {data.base} · {data.files.length} file{data.files.length === 1 ? '' : 's'}
      </h3>
      <div className="kb-diff-block">
        <div className="kb-diff-head">
          <span className="branch">{data.branch ?? 'HEAD'}</span>
          <span className="arrow">←</span>
          <span className="branch" style={{ color: 'var(--ink-3)' }}>
            {data.base}
          </span>
          <span className="stat">{data.files.length}</span>
        </div>
        {data.files.map((f) => (
          <DiffFileBlockModal key={f.path} file={f} />
        ))}
      </div>
    </div>
  );
}

function DiffFileBlockModal({ file }: { file: DiffFile }) {
  return (
    <div className="kb-diff-file">
      <div className="kb-diff-fhead">
        <span className={`stat-tag ${file.status}`}>{file.status}</span>
        <span className="path">{file.path}</span>
      </div>
      <div className="kb-diff-hunk">
        {file.patch.split('\n').map((line, idx) => {
          let cls = '';
          if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
            cls = '';
          } else if (line.startsWith('@@')) cls = 'hunk';
          else if (line.startsWith('+')) cls = 'add';
          else if (line.startsWith('-')) cls = 'del';
          return (
            <span key={idx} className={`kb-diff-line ${cls}`}>
              {line || ' '}
              {'\n'}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function PreviewTabModal({ activeRun }: { activeRun: AgentRun | null }) {
  // Translate an inspect selection into a markdown context block and hand it
  // to the chat composer via a window-scoped event. The composer
  // (`ReplyFooter`) listens for `kanbots:composer:insert` regardless of the
  // currently-visible tab — it lives in the modal footer, so the insert
  // always lands even if the user is staring at the Preview tab.
  function handleInspectSelect(sel: PreviewInspectSelection): void {
    const header = formatInspectHeader(sel);
    const preview = sel.textPreview.trim();
    const block = preview ? `${header}\n\`${preview}\`\n\n` : `${header}\n\n`;
    window.dispatchEvent(new CustomEvent('kanbots:composer:insert', { detail: { text: block } }));
  }
  return (
    <div className="kb-tdm-section">
      <h3>Branch preview · live dev server on this worktree</h3>
      <PreviewPanel
        branch={activeRun?.branchName ?? null}
        worktreePath={activeRun?.worktreePath ?? null}
        {...(activeRun ? { activeRunId: activeRun.id } : {})}
        size="tall"
        onInspectSelect={handleInspectSelect}
      />
    </div>
  );
}

function formatInspectHeader(sel: PreviewInspectSelection): string {
  const loc =
    sel.filePath && typeof sel.lineNumber === 'number'
      ? `\`src/${sel.filePath}:${sel.lineNumber}\``
      : sel.filePath
        ? `\`src/${sel.filePath}\``
        : null;
  if (sel.reactComponent && loc) {
    return `Inspecting <${sel.reactComponent}> in ${loc}:`;
  }
  if (loc) {
    const idSuffix = sel.id ? `#${sel.id}` : '';
    return `Inspecting <${sel.tagName}${idSuffix}> in ${loc}:`;
  }
  if (sel.selector) {
    return `Inspecting <${sel.tagName}> at \`${sel.selector}\`:`;
  }
  return `Inspecting <${sel.tagName}>:`;
}

/** A titled block inside a detail tab. */
function TabSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box sx={{ pb: 2.5, '& + &': { pt: 2.5, borderTop: 1, borderColor: 'divider' } }}>
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          component="h3"
          sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, flex: 1 }}
        >
          {title}
        </Typography>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

const RUN_STATUS_TEXT: Record<AgentRunStatus, string> = {
  running: 'Running',
  complete: 'Completed',
  failed: 'Failed',
  awaiting_input: 'Awaiting input',
  stopped: 'Stopped',
  starting: 'Starting',
};

function RunsTab({
  issueNumber,
  refreshKey,
  onViewRun,
}: {
  issueNumber: IssueRef;
  refreshKey: number;
  onViewRun: (run: AgentRun) => void;
}) {
  const { data, loading, error, refetch } = useFetch<AgentRun[]>(
    `runs:${issueNumber}:${refreshKey}`,
    () => api.listIssueRuns(issueNumber),
  );
  const [stoppingRunId, setStoppingRunId] = useState<number | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  async function stopRun(runId: number): Promise<void> {
    if (stoppingRunId !== null) return;
    setStoppingRunId(runId);
    setStopError(null);
    try {
      await api.stopAgent(runId);
      await refetch();
      dispatchIssuesRefetch();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingRunId(null);
    }
  }

  const runs = data ?? [];
  return (
    <TabSection title="Run history">
      {loading ? (
        <Typography variant="body2" color="text.secondary">
          Loading…
        </Typography>
      ) : error ? (
        <Alert severity="error">{error.message}</Alert>
      ) : runs.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No agent runs yet.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {stopError ? (
            <Alert severity="error" role="alert">
              {stopError}
            </Alert>
          ) : null}
          {runs.map((r) => {
            const status = r.status;
            const isActive =
              status === 'running' || status === 'awaiting_input' || status === 'starting';
            const color = runStatusColor(status);
            return (
              <Stack
                key={r.id}
                direction="row"
                spacing={1.5}
                sx={{
                  alignItems: 'flex-start',
                  p: 1.5,
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                }}
              >
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    mt: 0.75,
                    borderRadius: '50%',
                    bgcolor: `${color}.main`,
                    flexShrink: 0,
                  }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                    <Typography variant="subtitle2" sx={{ color: `${color}.main` }}>
                      {RUN_STATUS_TEXT[status]}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={monoChipSx}>
                      run #{r.id}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      · {ageString(r.startedAt)} ago
                    </Typography>
                  </Stack>
                  <Typography variant="body2" sx={{ mt: 0.25, wordBreak: 'break-word' }}>
                    {r.exitReason ?? '(no exit reason)'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={monoChipSx}>
                    {r.model ?? '—'} · {fmtTokens(r.tokenUsageInput)}/
                    {fmtTokens(r.tokenUsageOutput)} tok ·{' '}
                    {fmtElapsed(r.startedAt, r.endedAt ?? undefined)}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  color={isActive ? 'error' : 'secondary'}
                  variant={isActive ? 'outlined' : 'text'}
                  disabled={isActive && stoppingRunId !== null}
                  onClick={() => {
                    if (isActive) {
                      void stopRun(r.id);
                    } else {
                      onViewRun(r);
                    }
                  }}
                >
                  {isActive && stoppingRunId === r.id ? 'Stopping…' : isActive ? 'Stop' : 'View'}
                </Button>
              </Stack>
            );
          })}
        </Stack>
      )}
    </TabSection>
  );
}

function AutopilotStopButton({
  issueNumber,
  onAfter,
}: {
  issueNumber: IssueRef;
  onAfter: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop(stopChildren: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const session = await api.getAutopilotByIssue(issueNumber);
      if (!session) {
        throw new Error('Autopilot session not found for this card.');
      }
      await api.stopAutopilot(session.id, { stopChildren });
      setConfirmOpen(false);
      dispatchIssuesRefetch();
      onAfter();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="small"
        color="error"
        variant="outlined"
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
      >
        Stop autopilot
      </Button>
      <Dialog
        open={confirmOpen}
        onClose={() => !busy && setConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Stop autopilot</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            The autopilot loop will stop creating new tasks. Choose what happens to any child task
            that&apos;s currently running.
          </Typography>
          {error ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button color="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button color="secondary" onClick={() => void stop(false)} disabled={busy}>
            Let children finish
          </Button>
          <Button variant="contained" color="error" onClick={() => void stop(true)} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop and cancel children'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function AutopilotTab({ issueNumber }: { issueNumber: IssueRef }) {
  const { data, loading, error, refetch } = useFetch<AutopilotSession | null>(
    `autopilot:${issueNumber}`,
    () => api.getAutopilotByIssue(issueNumber),
  );

  // Refetch on broadcast — orchestrator fires `issues:changed` after every
  // session/cycle update.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge) return;
    return bridge.subscribe(ISSUES_CHANGED_CHANNEL, () => {
      void refetch();
    });
  }, [refetch]);

  if (loading && !data) {
    return (
      <TabSection title="Autopilot">
        <Typography variant="body2" color="text.secondary">
          Loading…
        </Typography>
      </TabSection>
    );
  }
  if (error) {
    return (
      <TabSection title="Autopilot">
        <Alert severity="error">{error.message}</Alert>
      </TabSection>
    );
  }
  if (!data) {
    return (
      <TabSection title="Autopilot">
        <Typography variant="body2" color="text.secondary">
          No autopilot session found for this card. It may have been started by an older app
          version.
        </Typography>
      </TabSection>
    );
  }

  const session = data;
  const personas = session.config.kind === 'feature-dev' ? session.config.personas : [];
  const checks = session.config.kind === 'qa' ? session.config.checks : [];
  const liveUi = session.config.kind === 'qa' ? session.config.liveUi : false;
  const featureDevConfig = session.config.kind === 'feature-dev' ? session.config : null;
  const parallelism = featureDevConfig?.parallelism ?? 1;
  const runningPersonaNames = new Set(
    session.children
      .filter((c) => c.status === 'running' && c.persona)
      .map((c) => c.persona as string),
  );
  const cycleHint =
    session.config.kind === 'feature-dev' && personas.length > 0
      ? parallelism > 1
        ? `${runningPersonaNames.size}/${parallelism} slots running`
        : `Next: ${personas[session.cycleIndex % personas.length]?.name ?? '—'}`
      : '';

  const facts: Array<{ label: string; value: ReactNode; mono?: boolean }> = [
    {
      label: 'Status',
      value: (
        <>
          {session.status}
          {session.stopReason ? (
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {' '}
              · {session.stopReason}
            </Box>
          ) : null}
        </>
      ),
    },
    { label: 'Started', value: `${ageString(session.startedAt)} ago` },
  ];
  if (session.endedAt) facts.push({ label: 'Ended', value: `${ageString(session.endedAt)} ago` });
  facts.push({
    label: 'Cycle',
    value: `${session.cycleIndex}${cycleHint ? ` · ${cycleHint}` : ''}`,
  });
  if (featureDevConfig) {
    facts.push(
      { label: 'Model', value: featureDevConfig.model ?? 'default', mono: true },
      { label: 'Effort', value: featureDevConfig.effort ?? 'medium', mono: true },
      { label: 'Parallel', value: String(parallelism), mono: true },
    );
  }

  return (
    <>
      <TabSection title={`Autopilot · ${session.kind}`}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 2,
            rowGap: 0.5,
          }}
        >
          {facts.map(({ label, value, mono }) => (
            <Fragment key={label}>
              <Typography variant="body2" color="text.secondary">
                {label}
              </Typography>
              <Typography variant="body2" sx={mono ? monoChipSx : {}}>
                {value}
              </Typography>
            </Fragment>
          ))}
        </Box>
      </TabSection>

      {personas.length > 0 ? (
        <TabSection title="Personas">
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
            {personas.map((p, i) => {
              const highlighted =
                session.status === 'running' &&
                (parallelism > 1
                  ? runningPersonaNames.has(p.name)
                  : i === session.cycleIndex % personas.length);
              return (
                <Chip
                  key={p.id}
                  size="small"
                  label={p.name}
                  color={highlighted ? 'primary' : 'secondary'}
                  variant={highlighted ? 'light' : 'outlined'}
                />
              );
            })}
          </Stack>
        </TabSection>
      ) : null}

      {checks.length > 0 || liveUi ? (
        <TabSection title="QA scope">
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
            {checks.map((c) => (
              <Chip
                key={c.kind}
                size="small"
                variant="outlined"
                label={`${c.kind}: ${c.command}`}
                sx={monoChipSx}
              />
            ))}
            {liveUi ? <Chip size="small" variant="outlined" label="live UI" /> : null}
          </Stack>
        </TabSection>
      ) : null}

      <TabSection title={`Children · ${session.children.length}`}>
        <Stack spacing={0.75}>
          {(session.planningSlots ?? []).map((slot) => (
            <PlanningSlotRow key={slot.slotIndex} slot={slot} />
          ))}
          {session.children.length === 0 &&
          (!session.planningSlots || session.planningSlots.length === 0) ? (
            <Typography variant="body2" color="text.secondary">
              No tasks created yet. The first one will appear shortly.
            </Typography>
          ) : null}
          {[...session.children].reverse().map((child, idx) => (
            <ChildRow key={`${child.issueNumber}-${idx}`} child={child} />
          ))}
        </Stack>
      </TabSection>
    </>
  );
}

const rowSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 1.25,
  px: 1.25,
  py: 1,
  borderRadius: 1,
  border: 1,
  borderColor: 'divider',
  color: 'inherit',
  textDecoration: 'none',
};

function ChildRow({ child }: { child: AutopilotChildEntry }) {
  const isReal = String(child.issueNumber) !== '0';
  const tag = child.kind === 'bug' ? 'BUG' : 'FEAT';
  const statusColor =
    child.status === 'complete'
      ? 'info.main'
      : child.status === 'failed' || child.status === 'stopped' || child.status === 'skipped'
        ? 'error.main'
        : 'success.main';
  return (
    <Box
      component="a"
      href={isReal ? `#/issue/${child.issueNumber}` : undefined}
      onClick={(e) => {
        if (!isReal) e.preventDefault();
      }}
      sx={{
        ...rowSx,
        cursor: isReal ? 'pointer' : 'default',
        ...(isReal && { '&:hover': { borderColor: 'primary.main' } }),
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ ...monoChipSx, minWidth: 40 }}>
        {isReal ? `#${child.issueNumber}` : '—'}
      </Typography>
      <Chip size="small" variant="outlined" color={tagColor(tag)} label={tag} />
      <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
        {child.title}
      </Typography>
      {child.persona ? (
        <Typography variant="caption" color="text.secondary">
          {child.persona}
        </Typography>
      ) : null}
      <Typography variant="caption" sx={{ color: statusColor, minWidth: 64, textAlign: 'right' }}>
        {child.status}
      </Typography>
    </Box>
  );
}

function PlanningSlotRow({ slot }: { slot: AutopilotPlanningSlot }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const events = slot.recentEvents.slice(-3);
  return (
    <Box sx={{ ...rowSx, flexDirection: 'column', alignItems: 'stretch', gap: 0.5 }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
        <Box
          sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main', flexShrink: 0 }}
        />
        <Typography variant="body2" sx={{ flex: 1 }}>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            Planning ·{' '}
          </Box>
          {slot.persona}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {fmtElapsed(slot.startedAt)}
        </Typography>
      </Stack>
      {events.length === 0 ? (
        <Typography variant="caption" color="text.secondary" sx={{ ...monoChipSx, pl: 2.25 }}>
          starting…
        </Typography>
      ) : (
        events.map((e, i) => (
          <Typography
            key={`${e.at}-${i}`}
            variant="caption"
            noWrap
            sx={{
              ...monoChipSx,
              pl: 2.25,
              color: i === events.length - 1 ? 'text.primary' : 'text.secondary',
            }}
          >
            {e.text}
          </Typography>
        ))
      )}
    </Box>
  );
}
