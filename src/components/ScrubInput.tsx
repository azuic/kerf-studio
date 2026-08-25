import { useCallback, useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface ScrubInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** Millimetres (or degrees) per pixel of horizontal drag. */
  step?: number;
  min?: number;
  max?: number;
  /** Appended to the readout, e.g. "mm" or "°". */
  unit?: string;
  disabled?: boolean;
  className?: string;
}

const FINE = 0.1;
const COARSE = 10;

/**
 * A numeric field you can drag.
 *
 * Dragging the label scrubs the value; the input itself still types normally. Pointer
 * capture keeps the drag alive once the pointer leaves the label. Shift scrubs ten times
 * finer, Alt ten times coarser, and the arrow keys step by the same amounts so the
 * control is reachable without a pointer at all.
 *
 * Deliberately no Pointer Lock: it would allow unbounded dragging, but it hides the
 * cursor and raises a browser-level "press Esc to exit" banner on every scrub, which is
 * far too heavy for nudging a number.
 *
 * Typing is kept in a local string while focused so intermediate states like "" or "-"
 * or "1." survive; the number only propagates when it parses.
 */
export function ScrubInput({
  label,
  value,
  onChange,
  step = 0.5,
  min,
  max,
  unit,
  disabled,
  className,
}: ScrubInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const accumulated = useRef(0);
  const startValue = useRef(0);
  const latest = useRef(value);
  latest.current = value;

  const clamp = useCallback(
    (v: number) => {
      let out = v;
      if (min !== undefined) out = Math.max(min, out);
      if (max !== undefined) out = Math.min(max, out);
      // Snap away float dust from accumulated drag deltas.
      return Math.round(out * 1e4) / 1e4;
    },
    [min, max],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    // Throws if the pointer id is not active (synthetic events, odd input stacks).
    // Losing capture only costs us the drag-outside behaviour, so it must not be fatal.
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* continue without capture */
    }
    accumulated.current = 0;
    startValue.current = latest.current;
    setScrubbing(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!scrubbing) return;
    // movementX is what pointer lock reports; it also works without the lock.
    const dx = e.movementX || 0;
    const scale = e.shiftKey ? FINE : e.altKey ? COARSE : 1;
    accumulated.current += dx * step * scale;
    onChange(clamp(startValue.current + accumulated.current));
  };

  const endScrub = (e: React.PointerEvent<HTMLElement>) => {
    if (!scrubbing) return;
    setScrubbing(false);
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* already released */
    }
  };

  // A drag can end outside the window, where no pointerup reaches us.
  useEffect(() => {
    if (!scrubbing) return;
    const stop = () => setScrubbing(false);
    window.addEventListener('blur', stop);
    window.addEventListener('pointerup', stop);
    return () => {
      window.removeEventListener('blur', stop);
      window.removeEventListener('pointerup', stop);
    };
  }, [scrubbing]);

  const commitDraft = (text: string) => {
    const parsed = Number.parseFloat(text);
    if (Number.isFinite(parsed)) onChange(clamp(parsed));
  };

  const shown = draft ?? format(value);

  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      <span
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onKeyDown={(e) => {
          if (disabled) return;
          const scale = e.shiftKey ? FINE : e.altKey ? COARSE : 1;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            onChange(clamp(value + step * scale));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            onChange(clamp(value - step * scale));
          }
        }}
        className={cn(
          'text-muted-foreground w-fit max-w-full truncate text-[10px] font-medium tracking-wider uppercase',
          'select-none rounded-sm px-0.5 -mx-0.5',
          'focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-ew-resize hover:text-foreground',
          scrubbing && 'text-foreground',
        )}
        title={disabled ? undefined : 'Drag to scrub · shift = fine · alt = coarse'}
      >
        {label}
        {unit ? <span className="text-muted-foreground/70 normal-case"> {unit}</span> : null}
      </span>

      <Input
        type="text"
        inputMode="decimal"
        size="sm"
        disabled={disabled}
        value={shown}
        className={cn('font-mono tabular-nums', scrubbing && 'border-ring')}
        onChange={(e) => {
          setDraft(e.target.value);
          commitDraft(e.target.value);
        }}
        onFocus={() => setDraft(format(value))}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitDraft(e.currentTarget.value);
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function format(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}
