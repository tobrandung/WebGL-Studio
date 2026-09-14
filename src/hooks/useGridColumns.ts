import { useEffect, useState, type RefObject } from 'react';

/**
 * How many columns a CSS grid currently renders, read back from the resolved
 * `grid-template-columns`.
 *
 * Cards stagger by their position within a row, so something has to know where
 * a row breaks. Reading it off the element keeps the breakpoints in one place,
 * the Tailwind classes on the grid, instead of mirroring them in a media
 * query here, where they would drift apart on the first layout change.
 */
export function useGridColumns(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const read = () => {
      const tracks = getComputedStyle(element).gridTemplateColumns;
      const count = tracks.split(' ').filter(Boolean).length;
      setColumns(count > 0 ? count : 1);
    };

    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return columns;
}
