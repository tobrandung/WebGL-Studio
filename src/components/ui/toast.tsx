import { useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Short-lived notifications: something finished, something failed, and the
 * message has no reason to stay on screen afterwards.
 *
 * The rule the app follows is that anything temporary comes through here, and
 * anything that describes a lasting state stays an `Alert` where that state is
 * (the dashboard's status bar, a banner over the canvas). A message that is
 * over but still on the page turns the layout into a log of things that already
 * happened.
 *
 * The call shape is the one from the shadcn Toast docs, `toast.add({ title,
 * description })` plus a `<Toaster />` in the layout, so the docs apply here.
 * Underneath it is the Radix primitive this app already ships rather than Base
 * UI, which would be a second toolkit for one component.
 */

export type ToastType = 'success' | 'info' | 'warning' | 'error';

export type ToastOptions = {
  title?: string;
  description?: ReactNode;
  /** Colour and icon. Defaults to `info`. */
  type?: ToastType;
  /** Milliseconds on screen. `0` keeps it until it is dismissed. */
  timeout?: number;
  /** One button inside the toast, e.g. „Rückgängig". */
  actionProps?: ComponentProps<typeof Button> & {
    children: ReactNode;
    /** Screen-reader text for the gesture this button undoes. */
    altText?: string;
  };
};

type ToastRecord = ToastOptions & { id: string };

/** Long enough to read a sentence, short enough not to sit there. */
const DEFAULT_TIMEOUT = 8000;

/**
 * Older toasts drop off rather than stacking up: five of them cover the corner
 * of the screen, and nobody reads the fifth.
 */
const MAX_VISIBLE = 3;

let items: ToastRecord[] = [];
let listeners: Array<() => void> = [];

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

/**
 * The queue lives outside React so anything can post to it: a hook, an event
 * handler, a catch block in a module that never renders.
 */
export const toast = {
  add(options: ToastOptions): string {
    const id = crypto.randomUUID();
    items = [...items, { ...options, id }].slice(-MAX_VISIBLE);
    emit();
    return id;
  },
  close(id: string): void {
    items = items.filter((entry) => entry.id !== id);
    emit();
  },
};

const TYPE_ICON: Record<ToastType, LucideIcon> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: AlertTriangle,
};

const TYPE_STYLE: Record<ToastType, string> = {
  success: 'border-green-500/40 text-green-300',
  info: 'border-border text-foreground',
  warning: 'border-orange-500/40 text-orange-300',
  error: 'border-destructive/40 text-destructive',
};

function ToastItem({ record }: { record: ToastRecord }) {
  const type = record.type ?? 'info';
  const Icon = TYPE_ICON[type];
  const { altText, className: actionClassName, ...actionProps } = record.actionProps ?? {};

  return (
    <ToastPrimitive.Root
      open
      // Radix counts this down itself; `0` means „stays until dismissed", which
      // it expresses as a duration nothing reaches rather than as a flag.
      duration={record.timeout === 0 ? Number.MAX_SAFE_INTEGER : (record.timeout ?? DEFAULT_TIMEOUT)}
      onOpenChange={(open) => {
        if (!open) toast.close(record.id);
      }}
      className={cn(
        // Same surface as the panels and dialogs, so a toast reads as part of
        // the app rather than as a browser notification. Tinted like a card,
        // because a toast has to lift off whatever it is floating over, and the
        // page background would let it sink into the dark.
        'glass-surface [--glass-tint:var(--card)] pointer-events-auto grid w-[min(384px,calc(100vw-32px))] grid-cols-[calc(var(--spacing)*4)_1fr_auto] items-start gap-x-4 gap-y-2 rounded-lg border p-4 text-sm shadow-lg',
        'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2 data-[state=open]:fade-in-0',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-2',
        // A swipe to the right dismisses; the transform follows the finger.
        'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=move]:transition-none data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform',
        'motion-reduce:animate-none motion-reduce:transition-none',
        TYPE_STYLE[type],
      )}
    >
      <Icon className="size-4 translate-y-0.5" />
      <div className="col-start-2 min-w-0">
        {record.title && <ToastPrimitive.Title className="font-medium">{record.title}</ToastPrimitive.Title>}
        {record.description && (
          <ToastPrimitive.Description
            className={cn('text-muted-foreground', record.title && 'mt-1')}
          >
            {record.description}
          </ToastPrimitive.Description>
        )}
        {record.actionProps && (
          <ToastPrimitive.Action asChild altText={altText ?? 'Aktion'} className="mt-2 inline-block">
            <Button size="sm" variant="outline" className={actionClassName} {...actionProps} />
          </ToastPrimitive.Action>
        )}
      </div>
      <ToastPrimitive.Close
        aria-label="Schließen"
        className="col-start-3 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <X className="size-4" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

/**
 * Mounted once, in the app root. Everything else in the app posts to `toast`.
 *
 * The viewport clears `--status-bar-height`, which the dashboard's status bar
 * sets while it is on screen: without it the first toast would sit behind the
 * bar, which is exactly where the eye is not looking.
 */
export function Toaster() {
  const records = useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {records.map((record) => (
        <ToastItem key={record.id} record={record} />
      ))}
      <ToastPrimitive.Viewport className="pointer-events-none fixed right-4 bottom-[calc(var(--status-bar-height,0px)+var(--spacing)*4)] z-50 flex max-h-screen w-auto flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
