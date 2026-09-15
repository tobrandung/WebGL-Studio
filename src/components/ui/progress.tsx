import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { Progress as ProgressPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * Determinate and indeterminate progress bar.
 *
 * Composed the way the shadcn Progress docs describe — `ProgressLabel` and
 * `ProgressValue` above a `ProgressTrack` — so a bar can carry its own caption
 * instead of every caller rebuilding one out of a flex row and a span. Radix
 * has no label or value parts, so the value travels through a context here;
 * everything else is the primitive.
 *
 * `value={null}` means work of unknown length (the gain-map encode), which
 * Radix reports as `data-state="indeterminate"`.
 */

type ProgressState = {
  value: number | null;
  max: number;
  /** 0-100, already clamped. Indeterminate bars report 0. */
  percent: number;
  variant: 'default' | 'destructive';
  indeterminate: boolean;
};

const ProgressContext = createContext<ProgressState | null>(null);

function useProgress(part: string): ProgressState {
  const state = useContext(ProgressContext);
  if (!state) throw new Error(`${part} muss innerhalb von <Progress> stehen.`);
  return state;
}

function Progress({
  className,
  value,
  max = 100,
  variant = 'default',
  children,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root> & { variant?: 'default' | 'destructive' }) {
  const indeterminate = value === null || value === undefined;
  const percent = indeterminate ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const state: ProgressState = { value: value ?? null, max, percent, variant, indeterminate };

  return (
    <ProgressContext.Provider value={state}>
      <ProgressPrimitive.Root
        data-slot="progress"
        // Label left, value right, track across both. A bar with neither still
        // occupies one row, so the bare form keeps its old height.
        className={cn('grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2', className)}
        value={value}
        max={max}
        {...props}
      >
        {/* Bare `<Progress value={x} />` stays the plain bar it always was. */}
        {children ?? <ProgressTrack />}
      </ProgressPrimitive.Root>
    </ProgressContext.Provider>
  );
}

function ProgressLabel({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="progress-label"
      className={cn('col-start-1 truncate text-sm font-medium', className)}
      {...props}
    />
  );
}

type ProgressValueProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** Custom text. Defaults to the rounded percentage. */
  children?: ReactNode | ((state: ProgressState) => ReactNode);
};

function ProgressValue({ className, children, ...props }: ProgressValueProps) {
  const state = useProgress('ProgressValue');
  const content =
    typeof children === 'function'
      ? children(state)
      : (children ?? (state.indeterminate ? null : `${Math.round(state.percent)}%`));
  return (
    <div
      data-slot="progress-value"
      className={cn('col-start-2 shrink-0 text-sm tabular-nums text-muted-foreground', className)}
      {...props}
    >
      {content}
    </div>
  );
}

function ProgressTrack({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="progress-track"
      className={cn(
        'col-span-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary',
        className,
      )}
      {...props}
    >
      {children ?? <ProgressIndicator />}
    </div>
  );
}

function ProgressIndicator({ className, ...props }: ComponentProps<typeof ProgressPrimitive.Indicator>) {
  const { percent, variant, indeterminate } = useProgress('ProgressIndicator');
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(
        'h-full w-full flex-1 transition-transform duration-200 ease-out',
        variant === 'destructive' ? 'bg-destructive' : 'bg-primary',
        indeterminate && 'animate-pulse motion-reduce:animate-none',
        className,
      )}
      style={{ transform: `translateX(-${100 - (indeterminate ? 40 : percent)}%)` }}
      {...props}
    />
  );
}

export { Progress, ProgressLabel, ProgressValue, ProgressTrack, ProgressIndicator };
