import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { IconsaxIcon } from '@kanbots/ui';
import { MagicStar } from 'iconsax-react';

export interface AiAssistButtonProps {
  /** What the AI does to the field, e.g. "Improve writing with AI". */
  label: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** Small sparkle button that sits in a form field's label row. */
export function AiAssistButton({ label, busy, disabled = false, onClick }: AiAssistButtonProps) {
  return (
    <Tooltip title={busy ? 'Working…' : label}>
      <span>
        <IconButton
          size="small"
          color="primary"
          aria-label={label}
          aria-busy={busy}
          disabled={disabled || busy}
          onClick={onClick}
          sx={{ width: 24, height: 24, p: 0 }}
        >
          {busy ? (
            <CircularProgress size={14} />
          ) : (
            <IconsaxIcon icon={MagicStar} size={16} variant="Bulk" />
          )}
        </IconButton>
      </span>
    </Tooltip>
  );
}
