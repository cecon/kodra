import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import { IconsaxIcon } from '@kanbots/ui';
import { MagicStar } from 'iconsax-react';

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
    <Tooltip title={busy ? 'Working…' : (disabledReason ?? description)}>
      {/* span: a disabled button fires no events, so the tooltip needs a host. */}
      <span>
        <Button
          size="small"
          color="primary"
          variant="text"
          aria-busy={busy}
          disabled={disabled}
          onClick={onClick}
          startIcon={
            busy ? (
              <CircularProgress size={12} />
            ) : (
              <IconsaxIcon icon={MagicStar} size={14} variant="Bulk" />
            )
          }
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
          {busy ? 'Working…' : label}
        </Button>
      </span>
    </Tooltip>
  );
}
