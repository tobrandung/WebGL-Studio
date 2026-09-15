import { useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * The editor's side panels, with the shadcn sheet's motion: slide in from the
 * edge they sit on, slide back out before they leave.
 *
 * Only the motion is borrowed. A sheet in the shadcn sense is a dialog with an
 * overlay, a focus trap and a dismiss on outside click. These panels sit next
 * to the viewport and stay usable while the scene is being dragged, so there is
 * no overlay, nothing dims and nothing blurs behind them.
 *
 * Positioning, size and surface stay with the caller in `className`. This adds
 * the direction and keeps the panel mounted until its exit animation is over.
 *
 * `fill-mode-both` is what stops the panel flashing back into view on the way
 * out: without it the element returns to its resting place the moment the
 * animation ends, and sits there fully visible for the frame it takes React to
 * unmount it.
 */
const SIDES = {
  left: 'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  right: 'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
} as const;

function Sheet({
  side,
  open,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { side: keyof typeof SIDES; open: boolean }) {
  const [present, setPresent] = useState(open);

  // The closing panel keeps the content it had while it was open. Without it a
  // properties panel emptied by a deselect would slide out blank, because the
  // props that filled it are already gone by then.
  const content = useRef(children);
  if (open) content.current = children;

  if (open && !present) setPresent(true);

  // `prefers-reduced-motion` suppresses the animation, and a suppressed
  // animation never reports an end. Nothing would unmount the panel.
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!open && present && reduced) setPresent(false);

  if (!open && !present) return null;

  return (
    <div
      data-state={open ? 'open' : 'closed'}
      onAnimationEnd={(event) => {
        if (!open && event.target === event.currentTarget) setPresent(false);
      }}
      className={cn(
        'fill-mode-both transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-[440ms] data-[state=closed]:duration-300 motion-reduce:animate-none',
        SIDES[side],
        className,
      )}
      {...props}
    >
      {content.current}
    </div>
  );
}

export { Sheet };
