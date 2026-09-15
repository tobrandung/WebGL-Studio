import { cn } from '@/lib/utils';

/**
 * A placeholder in the shape of the thing that is still loading. Used where a
 * list would otherwise be a centred „Laden…", which says nothing about what is
 * coming and jumps the whole layout once it arrives.
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-accent', className)}
      {...props}
    />
  );
}

export { Skeleton };
