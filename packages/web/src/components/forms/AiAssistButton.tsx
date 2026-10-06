import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';

export interface AiAssistButtonProps {
  /** Short action label shown on the button, e.g. "Improve writing". */
  label: string;
  /** Longer explanation in the tooltip. */
  description: string;
  busy: boolean;
  /** When set, the button is disabled and the tooltip says why. */
  disabledReason?: string | null;
  onClick: () => void;
}

/** The "AI" sparkles: a large four-point star and two small ones. */
function SparklesIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 2.5c.4 4.6 2.9 7.1 7.5 7.5-4.6.4-7.1 2.9-7.5 7.5-.4-4.6-2.9-7.1-7.5-7.5 4.6-.4 7.1-2.9 7.5-7.5Z" />
      <path d="M18.5 1c.2 2.1 1.4 3.3 3.5 3.5-2.1.2-3.3 1.4-3.5 3.5-.2-2.1-1.4-3.3-3.5-3.5 2.1-.2 3.3-1.4 3.5-3.5Z" />
      <path d="M18 15c.2 2.4 1.6 3.8 4 4-2.4.2-3.8 1.6-4 4-.2-2.4-1.6-3.8-4-4 2.4-.2 3.8-1.6 4-4Z" />
    </svg>
  );
}

/** Sparkle + label button that sits in a form field's label row. */
export function AiAssistButton({
  label,
  description,
  busy,
  disabledReason = null,
  onClick,
}: AiAssistButtonProps) {
  const disabled = busy || disabledReason !== null;
  return (
    <Tooltip title={busy ? 'Trabalhando…' : (disabledReason ?? description)}>
      {/* span: a disabled button fires no events, so the tooltip needs a host. */}
      <span>
        <Button
          size="small"
          color="primary"
          variant="text"
          aria-busy={busy}
          disabled={disabled}
          onClick={onClick}
          startIcon={busy ? <CircularProgress size={12} /> : <SparklesIcon size={14} />}
          sx={{
            minWidth: 0,
            py: 0.25,
            px: 0.75,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0,
            textTransform: 'none',
            lineHeight: 1.4,
            '& .MuiButton-startIcon': { mr: 0.5 },
          }}
        >
          {busy ? 'Trabalhando…' : label}
        </Button>
      </span>
    </Tooltip>
  );
}
