/**
 * The editor's dialog shell: one translucent, blurred surface with a fixed
 * header, a scrolling body and a footer that stays put.
 *
 * `ExportDialog` was the only popup that had this look, spelled out as a class
 * soup on its `DialogContent`; every other dialog got the bare shadcn default.
 * This is that shell extracted, so the chrome is defined once and a new dialog
 * inherits it instead of re-typing it.
 *
 * Composes shadcn's `Dialog` rather than replacing it — `Dialog`, `DialogTitle`
 * and friends are re-exported unchanged, so a dialog imports from one module.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';
import { DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';

/**
 * The surface without the layout, for popups that are not a `Dialog`:
 * `AlertDialog` is its own Radix primitive with its own content element.
 */
export const GLASS_SURFACE = 'border-border/50 bg-background/70 backdrop-blur-[24px]';

/**
 * The app's motion for anything that changes size or slides — a slow ease-out
 * that settles rather than snapping. Same curve as the export dialog's tabs.
 */
export const DIALOG_TRANSITION =
  'duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none';

/**
 * Named widths instead of per-dialog `sm:max-w-*`, so two dialogs of the same
 * kind cannot drift apart by a step.
 */
const WIDTHS = {
  /** A form with a handful of fields. */
  sm: 'sm:max-w-md',
  /** The default: text plus a few controls. */
  md: 'sm:max-w-xl',
  /** Tabs, tables, longer flows. */
  lg: 'sm:max-w-2xl',
  /** Two columns side by side — controls next to a preview. */
  xl: 'sm:max-w-4xl',
} as const;

export type GlassDialogSize = keyof typeof WIDTHS;

function GlassDialogContent({
  size = 'md',
  className,
  ...props
}: React.ComponentProps<typeof DialogContent> & { size?: GlassDialogSize }) {
  return (
    <DialogContent
      className={cn(
        // gap-0 and p-0 undo the primitive's own spacing: the header, body and
        // footer below carry it, because only the body may scroll.
        'flex max-h-[85vh] min-w-0 flex-col gap-0 overflow-hidden p-0',
        GLASS_SURFACE,
        WIDTHS[size],
        className,
      )}
      {...props}
    />
  );
}

function GlassDialogHeader({
  className,
  ...props
}: React.ComponentProps<typeof DialogHeader>) {
  // pr-12 keeps the title clear of the primitive's absolute close button.
  return <DialogHeader className={cn('shrink-0 px-6 pt-6 pr-12', className)} {...props} />;
}

/**
 * The one part that scrolls. `min-h-0` is what makes that work inside the
 * flex column — without it the body grows to its content and pushes the
 * footer off screen instead of overflowing.
 */
function GlassDialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5', className)}
      {...props}
    />
  );
}

function GlassDialogFooter({
  className,
  ...props
}: React.ComponentProps<typeof DialogFooter>) {
  return (
    <DialogFooter
      className={cn('shrink-0 border-t border-border/50 px-6 py-4', className)}
      {...props}
    />
  );
}

/**
 * Fades a section in where it would otherwise pop into place — a panel that
 * appears once a measurement lands, a step that replaces another. Purely
 * decorative, and skipped for `prefers-reduced-motion`.
 */
function DialogReveal({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-300 motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export {
  DialogReveal,
  GlassDialogBody,
  GlassDialogContent,
  GlassDialogFooter,
  GlassDialogHeader,
};
