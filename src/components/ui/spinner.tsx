import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * The app's one loading circle. Same icon the buttons already spin, wrapped so
 * a spinner is a component rather than an icon plus a class remembered by hand.
 */
function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2>) {
  return (
    <Loader2
      role="status"
      aria-label="Lädt"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  );
}

export { Spinner };
