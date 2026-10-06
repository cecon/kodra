import { Logo } from '../Logo.js';
import { isValidCustomIssueId } from '@kanbots/core';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api, isCloudMode } from '../../api.js';
import { CardPreview } from '../Card.js';
import { notifyBacklogCreated } from '../BacklogToast.js';
import { MarkdownEditor, type MarkdownEditorHandle } from '../forms/MarkdownEditor.js';
import { useFetch } from '../../hooks/useFetch.js';
import { useFocusTrap } from '../../hooks/useFocusTrap.js';
import { priorityFromLabels, tagFromLabels } from '../../labels.js';
import type { CardTemplatePayload, Issue } from '../../types.js';
import { shortcut } from '../../shortcuts.js';
import { AiAssistButton } from '../forms/AiAssistButton.js';

type AiMode = 'improve-description' | 'suggest-title';

const LAST_WORKSPACE_KEY = 'kodra.newTask.workspace';

/** Line under a field after an AI assist: the error, or an undo link. */
function AiNote({
  mode,
  error,
  undo,
  onUndo,
}: {
  mode: AiMode;
  error: { mode: AiMode; message: string } | null;
  undo: { mode: AiMode; value: string } | null;
  onUndo: () => void;
}) {
  if (error?.mode === mode) {
    return (
      <div role="alert" style={{ fontSize: 11, color: 'var(--red, #f87171)', marginTop: 4 }}>
        {error.message}
      </div>
    );
  }
  if (undo?.mode !== mode) return null;
  return (
    <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
      Reescrito pela IA ·{' '}
      <button type="button" className="kb-link-btn" onClick={onUndo}>
        Desfazer
      </button>
    </div>
  );
}

type Tag = 'feat' | 'fix' | 'chore' | 'infra' | 'docs';
type Priority = 'p0' | 'p1' | 'p2' | 'p3';
type Template = 'bug' | 'feature' | 'refactor' | 'review' | 'spike';

const TEMPLATES: Array<{ id: Template; icon: string; name: string }> = [
  { id: 'bug', icon: '!', name: 'Correção de bug' },
  { id: 'feature', icon: '+', name: 'Funcionalidade' },
  { id: 'refactor', icon: '~', name: 'Refatoração' },
  { id: 'review', icon: '?', name: 'Revisão' },
  { id: 'spike', icon: '*', name: 'Investigação' },
];

export interface TaskCreateModalProps {
  onClose: () => void;
  onCreated?: (issue: Issue) => void;
  initialDescription?: string;
}

export function TaskCreateModal({
  onClose,
  onCreated,
  initialDescription = '',
}: TaskCreateModalProps) {
  const [title, setTitle] = useState('');
  const [customNumber, setCustomNumber] = useState('');
  const [body, setBody] = useState(initialDescription);
  const [tpl, setTpl] = useState<Template>('feature');
  const [tag, setTag] = useState<Tag>('feat');
  const [priority, setPriority] = useState<Priority>('p2');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<MarkdownEditorHandle | null>(null);
  const [pasting, setPasting] = useState(0);
  // The registered workspace (repo) the card acts on; remembers the last pick.
  const { data: profiles } = useFetch('workspace-profiles', () => api.listWorkspaceProfiles());
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(LAST_WORKSPACE_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!profiles || profiles.length === 0) return;
    if (!workspaceId || !profiles.some((w) => w.id === workspaceId)) {
      setWorkspaceId(profiles[0]!.id);
    }
  }, [profiles, workspaceId]);
  function pickWorkspace(id: string): void {
    setWorkspaceId(id);
    try {
      window.localStorage.setItem(LAST_WORKSPACE_KEY, id);
    } catch {
      // remembered for this session only
    }
  }
  // Per-field AI help. `aiUndo` keeps the value the AI replaced so the user
  // can take it back.
  const [aiBusy, setAiBusy] = useState<AiMode | null>(null);
  const [aiError, setAiError] = useState<{ mode: AiMode; message: string } | null>(null);
  const [aiUndo, setAiUndo] = useState<{ mode: AiMode; value: string } | null>(null);
  const [templates, setTemplates] = useState<CardTemplatePayload[]>([]);
  const [templateId, setTemplateId] = useState<number | ''>('');
  const modalRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listCardTemplates();
        if (!cancelled) setTemplates(list);
      } catch {
        // Best-effort — templates are optional in the create flow.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function applyTemplate(t: CardTemplatePayload): void {
    setTitle(t.titleTemplate);
    // Place the caret where the template authored a {{cursor}} marker;
    // strip the marker before applying. If the marker is missing the
    // caret ends up at the end of the body, which is what a textarea
    // does by default.
    const raw = t.bodyTemplate ?? '';
    const cursorIdx = raw.indexOf('{{cursor}}');
    const next = raw.replace(/\{\{cursor\}\}/g, '');
    setBody(next);
    // Mirror the template's labels onto the type/priority pickers when
    // possible — the type/priority segmented buttons are the canonical
    // labels surface, so we keep them in sync rather than letting the
    // template's labels race with the buttons' state at submit time.
    const nextTag = tagFromLabels(t.labels, false);
    if (
      nextTag === 'FEAT' ||
      nextTag === 'BUG' ||
      nextTag === 'CHORE' ||
      nextTag === 'INFRA' ||
      nextTag === 'DOCS' ||
      nextTag === 'FIX'
    ) {
      const map: Record<string, Tag> = {
        FEAT: 'feat',
        BUG: 'fix',
        FIX: 'fix',
        CHORE: 'chore',
        INFRA: 'infra',
        DOCS: 'docs',
      };
      const mapped = map[nextTag];
      if (mapped) setTag(mapped);
    }
    const nextPri = priorityFromLabels(t.labels);
    if (nextPri) setPriority(nextPri);
    // Defer caret placement until after React has committed the new body
    // value so selectionStart corresponds to the rendered DOM.
    queueMicrotask(() => {
      const ta = bodyRef.current?.getTextarea() ?? null;
      if (!ta) return;
      ta.focus();
      const pos = cursorIdx === -1 ? next.length : cursorIdx;
      ta.setSelectionRange(pos, pos);
    });
  }

  function onPickTemplate(e: ChangeEvent<HTMLSelectElement>): void {
    const raw = e.target.value;
    if (raw === '') {
      setTemplateId('');
      return;
    }
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id)) return;
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) applyTemplate(t);
  }

  async function runAiAssist(mode: AiMode): Promise<void> {
    setAiBusy(mode);
    setAiError(null);
    try {
      const result = await api.assistField({
        mode,
        title,
        description: body,
        ...(workspaceId ? { workspaceId } : {}),
      });
      if (mode === 'suggest-title') {
        setAiUndo({ mode, value: title });
        setTitle(result.title);
      } else {
        setAiUndo({ mode, value: body });
        setBody(result.body);
      }
    } catch (err) {
      setAiError({ mode, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setAiBusy(null);
    }
  }

  function undoAiAssist(): void {
    if (!aiUndo) return;
    if (aiUndo.mode === 'suggest-title') setTitle(aiUndo.value);
    else setBody(aiUndo.value);
    setAiUndo(null);
  }

  const insertAtCursor = useCallback((insert: string): void => {
    setBody((prev) => {
      const ta = bodyRef.current?.getTextarea() ?? null;
      if (!ta) return prev + insert;
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + insert + prev.slice(end);
      const cursor = start + insert.length;
      queueMicrotask(() => {
        const el = bodyRef.current?.getTextarea() ?? null;
        if (el) {
          el.focus();
          el.setSelectionRange(cursor, cursor);
        }
      });
      return next;
    });
  }, []);

  const replaceText = useCallback((from: string, to: string): void => {
    setBody((prev) => (prev.includes(from) ? prev.replace(from, to) : prev));
  }, []);

  async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: File[] = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) images.push(file);
      }
    }
    if (images.length === 0) return;
    e.preventDefault();
    for (const file of images) {
      const token = `![enviando imagem…](kanbots-pending:${Date.now()}-${Math.random().toString(36).slice(2, 8)})`;
      insertAtCursor(token);
      setPasting((n) => n + 1);
      try {
        const result = await api.uploadAttachment(file);
        const alt = file.name?.trim() || 'pasted image';
        replaceText(token, `![${alt}](${result.absolutePath})`);
      } catch (err) {
        replaceText(token, '');
        setError(
          `Não foi possível enviar a imagem colada: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setPasting((n) => Math.max(0, n - 1));
      }
    }
  }

  // Mirrors the dispatcher naming: kodra/issue-<id>-<runId> (see
  // defaultBranchName in @kanbots/dispatcher). Preview placeholders: N =
  // next auto number, R = run id assigned at dispatch time.
  const branchName = useMemo(() => `kodra/issue-${customNumber.trim() || 'N'}-R`, [customNumber]);
  const previewIssue: Issue = useMemo(
    () => ({
      number: 0,
      title: title || 'Tarefa sem título',
      body,
      state: 'open',
      // Same labels submit() creates: Inbox (no status), agent idle.
      labels: [`type:${tag}`, `priority:${priority}`, 'agent:idle'],
      assignees: [],
      user: { login: 'you', avatarUrl: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      htmlUrl: '',
      isPullRequest: false,
      status: null,
      agent: 'idle',
      activeRun: null,
      sentryMeta: null,
    }),
    [title, body, tag, priority],
  );

  // Closing throws the draft away, so it is never a stray click on the
  // backdrop, and once something is typed it asks first.
  const dirty =
    title.trim() !== '' || customNumber.trim() !== '' || body.trim() !== initialDescription.trim();
  const requestClose = useCallback((): void => {
    if (dirty && !window.confirm('Descartar esta tarefa? O que você escreveu será perdido.'))
      return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape' && !e.defaultPrevented) requestClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  async function submit(e?: FormEvent): Promise<void> {
    if (e) e.preventDefault();
    if (submitting) return;
    if (pasting > 0) {
      setError('Aguarde o envio da imagem colada terminar');
      return;
    }
    if (!title.trim()) {
      setError('O título é obrigatório');
      return;
    }
    const trimmedCustomNumber = customNumber.trim();
    if (trimmedCustomNumber && !isValidCustomIssueId(trimmedCustomNumber)) {
      setError(
        'ID inválido: use letras, números, ponto, hífen ou underline; sem espaços, "..", "--", ou terminando em "-" ou "."',
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Every card is born in the Inbox with no agent: moving it to In
      // progress is what starts one.
      const labels = [`type:${tag}`, `priority:${priority}`, 'agent:idle'];
      const created = await api.createIssue({
        title: title.trim(),
        body: body.trim(),
        labels,
        ...(trimmedCustomNumber ? { number: trimmedCustomNumber } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
      notifyBacklogCreated(labels);
      onCreated?.(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  async function submitAsDraft(): Promise<void> {
    if (submitting || !title.trim()) return;
    const trimmedCustomNumber = customNumber.trim();
    if (trimmedCustomNumber && !isValidCustomIssueId(trimmedCustomNumber)) {
      setError(
        'ID inválido: use letras, números, ponto, hífen ou underline; sem espaços, "..", "--", ou terminando em "-" ou "."',
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const labels = [`type:${tag}`, `priority:${priority}`, 'status:backlog', 'agent:idle'];
      const created = await api.createIssue({
        title: title.trim(),
        body: body.trim(),
        labels,
        ...(trimmedCustomNumber ? { number: trimmedCustomNumber } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
      notifyBacklogCreated(labels);
      onCreated?.(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  function onTitleKey(e: KeyboardEvent<HTMLInputElement>): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="kb-modal-scrim kb-app" role="dialog" aria-modal="true">
      <div ref={modalRef} className="kb-modal" tabIndex={-1}>
        <div className="kb-modal-head">
          <Logo size={11} withWordmark />
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <h2>Nova tarefa</h2>
          <span className="grow" />
          <span style={{ color: 'var(--ink-3)', fontSize: 11.5 }}>
            <span className="kb-kbd">{shortcut('mod+enter')}</span> para criar
          </span>
          <button type="button" className="x-btn" onClick={requestClose} aria-label="Fechar">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-modal-body">
          <main className="kb-modal-main">
            <form className="kb-tcm-content" onSubmit={(e) => void submit(e)}>
              {templates.length > 0 ? (
                <div className="kb-field">
                  <label className="kb-field-label">
                    Modelo de card
                    <span className="kb-field-hint">preenche título, descrição e labels</span>
                  </label>
                  <select
                    className="kb-input"
                    value={templateId === '' ? '' : String(templateId)}
                    onChange={onPickTemplate}
                  >
                    <option value="">(começar do zero)</option>
                    {templates.map((t) => (
                      <option key={t.id} value={String(t.id)}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {/* WORKSPACE: the repo the card acts on */}
              <div className="kb-field">
                <label className="kb-field-label">
                  Workspace
                  <span className="kb-field-hint">o repositório onde o agente trabalha</span>
                </label>
                {profiles && profiles.length > 0 ? (
                  <div className="kb-templates">
                    {profiles.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className={`kb-tpl${workspaceId === w.id ? ' on' : ''}`}
                        onClick={() => pickWorkspace(w.id)}
                        title={w.path}
                      >
                        <span
                          className="kb-ico"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: w.color,
                            display: 'inline-block',
                          }}
                        />
                        {w.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                    Nenhum workspace ainda: o agente precisa de um para saber em qual repositório
                    trabalhar. Cadastre seus repositórios em Configure → Workspaces.
                  </div>
                )}
              </div>

              {/* TITLE */}
              <div className="kb-field">
                <label className="kb-field-label" htmlFor="kb-task-title">
                  Título
                  <span className="kb-field-hint kb-field-hint-ai">
                    → vira o nome da branch e o título do PR
                    <AiAssistButton
                      label="Sugerir título"
                      description="Escreve um título a partir da descrição, com IA"
                      busy={aiBusy === 'suggest-title'}
                      disabledReason={
                        aiBusy !== null
                          ? 'A IA está ocupada'
                          : title.trim() === '' && body.trim() === ''
                            ? 'Escreva uma descrição antes'
                            : null
                      }
                      onClick={() => void runAiAssist('suggest-title')}
                    />
                  </span>
                </label>
                <input
                  id="kb-task-title"
                  className="kb-input title-input"
                  placeholder="ex.: Trocar login por senha por onboarding com passkey"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={onTitleKey}
                  autoFocus
                />
                <AiNote mode="suggest-title" error={aiError} undo={aiUndo} onUndo={undoAiAssist} />
                {title ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11,
                      color: 'var(--ink-3)',
                      minWidth: 0,
                    }}
                  >
                    <span style={{ color: 'var(--ink-4)', flexShrink: 0 }}>a branch será</span>
                    <span
                      style={{
                        fontFamily: 'var(--ff-mono)',
                        color: 'var(--accent)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                      title={branchName}
                    >
                      {branchName}
                    </span>
                  </div>
                ) : null}
              </div>

              {!isCloudMode() ? (
                <div className="kb-field">
                  <label className="kb-field-label">
                    ID da tarefa (opcional)
                    <span className="kb-field-hint">Vazio = número automático</span>
                  </label>
                  <input
                    className="kb-input"
                    type="text"
                    placeholder="ex.: FEAT-42"
                    value={customNumber}
                    onChange={(e) => setCustomNumber(e.target.value)}
                  />
                </div>
              ) : null}

              {/* TEMPLATE */}
              <div className="kb-field">
                <label className="kb-field-label">Modelo</label>
                <div className="kb-templates">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`kb-tpl${tpl === t.id ? ' on' : ''}`}
                      onClick={() => setTpl(t.id)}
                    >
                      <span className="kb-ico">{t.icon}</span>
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* DESCRIPTION */}
              <div className="kb-field">
                <label className="kb-field-label" htmlFor="kb-task-description">
                  Descrição
                  <span className="kb-field-hint kb-field-hint-ai">
                    Markdown · use AC: para critérios de aceite
                    <AiAssistButton
                      label="Melhorar escrita"
                      description="Reescreve a descrição com IA: mais clara, estruturada e com critérios de aceite"
                      busy={aiBusy === 'improve-description'}
                      disabledReason={
                        aiBusy !== null
                          ? 'A IA está ocupada'
                          : body.trim() === ''
                            ? 'Escreva uma descrição antes'
                            : null
                      }
                      onClick={() => void runAiAssist('improve-description')}
                    />
                  </span>
                </label>
                <MarkdownEditor
                  id="kb-task-description"
                  ref={bodyRef}
                  value={body}
                  onChange={setBody}
                  onPaste={(e) => void handlePaste(e)}
                  rows={10}
                  ariaLabel="Descrição da tarefa"
                  placeholder={`Qual é o resultado para o usuário?\n\nAC:\n- Um usuário novo consegue cadastrar uma passkey no primeiro login\n- Usuários existentes veem um aviso convidando para a passkey\n\nDica: cole uma imagem (${shortcut('mod+v')}) para anexá-la.`}
                />
                <AiNote
                  mode="improve-description"
                  error={aiError}
                  undo={aiUndo}
                  onUndo={undoAiAssist}
                />
                {pasting > 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                    Enviando {pasting} imagem{pasting === 1 ? '' : 'ns'}…
                  </div>
                ) : null}
              </div>

              {/* LABELS */}
              <div className="kb-field" style={{ marginBottom: 0 }}>
                <label className="kb-field-label">Labels</label>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <div>
                    <div
                      style={{
                        fontSize: 10.5,
                        color: 'var(--ink-3)',
                        marginBottom: 5,
                      }}
                    >
                      TIPO
                    </div>
                    <div className="kb-seg">
                      {(['feat', 'fix', 'chore', 'infra', 'docs'] as Tag[]).map((t) => (
                        <button
                          key={t}
                          type="button"
                          className={tag === t ? 'on' : ''}
                          onClick={() => setTag(t)}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 10.5,
                        color: 'var(--ink-3)',
                        marginBottom: 5,
                      }}
                    >
                      PRIORIDADE
                    </div>
                    <div className="kb-seg">
                      {(['p0', 'p1', 'p2', 'p3'] as Priority[]).map((p) => (
                        <button
                          key={p}
                          type="button"
                          className={priority === p ? 'on' : ''}
                          onClick={() => setPriority(p)}
                        >
                          {p.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </form>
          </main>

          <aside className="kb-modal-aside">
            <div className="kb-mas-block">
              <div className="kb-mas-h">Como vai aparecer</div>
              <div
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: 'var(--ink-3)',
                  marginBottom: 8,
                }}
              >
                INBOX
              </div>
              <div className="kb-preview-card-wrap">
                <CardPreview issue={previewIssue} />
              </div>
            </div>
          </aside>
        </div>

        <div className="kb-modal-foot">
          <span className="hint">
            Os cards nascem no Inbox. Mova para In progress para o agente começar.
          </span>
          {error ? (
            <span style={{ color: 'var(--failed)', fontSize: 11.5 }} role="alert">
              {error}
            </span>
          ) : null}
          <span className="grow" />
          <button type="button" className="kb-btn ghost" onClick={requestClose}>
            Cancelar
          </button>
          <SplitButton
            primaryLabel={submitting ? 'Criando…' : 'Criar tarefa'}
            primaryDisabled={submitting || pasting > 0 || !title.trim()}
            onPrimary={() => void submit()}
            options={[
              {
                label: 'Salvar como rascunho (Backlog)',
                onPick: () => void submitAsDraft(),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function SplitButton({
  primaryLabel,
  primaryDisabled,
  onPrimary,
  options,
}: {
  primaryLabel: string;
  primaryDisabled: boolean;
  onPrimary: () => void;
  options: Array<{ label: string; onPick: () => void }>;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.kb-btn-grp')) return;
      setOpen(false);
    }
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="kb-btn-grp" style={{ position: 'relative' }}>
      <button
        type="button"
        className="kb-btn primary"
        onClick={onPrimary}
        disabled={primaryDisabled}
      >
        {primaryLabel}
        <span className="kb-kbd" style={{ marginLeft: 6 }}>
          {shortcut('mod+enter')}
        </span>
      </button>
      <button
        type="button"
        className="kb-btn primary"
        onClick={() => setOpen((v) => !v)}
        aria-label="Mais opções"
        title="Mais opções"
      >
        ▾
      </button>
      {open ? (
        <div className="kb-btn-grp-menu" style={{ bottom: 'calc(100% + 6px)', right: 0 }}>
          {options.map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => {
                setOpen(false);
                opt.onPick();
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
