import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The app's one banner. Every inline message that is not a dialog goes through
 * here: upload failures, unreachable hosting, a full team storage, a warning
 * about an unoptimized model.
 *
 * Structurally the shadcn Alert, slots and grid unchanged, so anything written
 * against those docs works. The palettes are this app's: stock `destructive` is
 * red text on a plain card, which next to the orange warnings here reads as a
 * quieter message rather than a louder one. Errors get the red tint the app
 * already used for them.
 */
const alertVariants = cva(
  'relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'border-border bg-secondary text-foreground',
        warning: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
        destructive:
          'border-destructive/40 bg-destructive/10 text-destructive *:data-[slot=alert-description]:text-destructive/90',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/**
 * The icon each variant carries unless the caller says otherwise. Supplied by
 * the component rather than by every call site, because a warning without the
 * triangle is the one that gets skimmed past.
 */
const VARIANT_ICON: Record<NonNullable<VariantProps<typeof alertVariants>['variant']>, LucideIcon> = {
  default: Info,
  warning: AlertTriangle,
  destructive: AlertTriangle,
};

function Alert({
  className,
  variant,
  icon,
  inline,
  children,
  ...props
}: ComponentProps<'div'> &
  VariantProps<typeof alertVariants> & {
    /** Overrides the variant's icon. `null` renders the alert without one. */
    icon?: LucideIcon | null;
    /**
     * Drops the box and keeps the colour and the icon, for a message that sits
     * inside a surface of its own: the dashboard's status bar draws the panel,
     * and an alert card inside it would be a second frame around the same line.
     */
    inline?: boolean;
  }) {
  const Icon = icon === null ? null : (icon ?? VARIANT_ICON[variant ?? 'default']);
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), inline && 'border-0 bg-transparent p-0', className)}
      {...props}
    >
      {/* A direct `svg` child is what switches the grid to its two-column form,
          so the icon has to be rendered here rather than inside a wrapper. */}
      {Icon && <Icon />}
      {children}
    </div>
  );
}

function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)}
      {...props}
    />
  );
}

/**
 * Block rather than shadcn's grid, and the one deliberate departure here.
 *
 * A grid turns every child into a row, which is right for stacked paragraphs
 * and wrong for the prose this app actually writes: `<strong>Zu groß.</strong>
 * Das HDRI wird…` would break across two lines mid-sentence. Stacked children
 * still get their gap, from the sibling margin instead of the grid's.
 */
function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'col-start-2 text-sm leading-relaxed [&>*+*]:mt-1 [&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

/** Trailing control, e.g. a retry button. Sits on the alert's own baseline. */
function AlertAction({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-action"
      className={cn('col-start-2 row-start-2 justify-self-start pt-1', className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction, alertVariants };
