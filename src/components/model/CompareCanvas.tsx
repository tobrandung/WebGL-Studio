import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { createCompareView, type CompareView } from '@/three/preview-compare';

type CompareCanvasProps = {
  /** The unmodified GLB. */
  original: ArrayBuffer | null;
  /** The compressed result, or null while none has been produced yet. */
  optimized: ArrayBuffer | null;
  /** Shown instead of the right-hand side when the model is too big to hold twice. */
  degraded?: boolean;
  busy?: boolean;
};

/**
 * Before/after comparison. Both halves share one camera, so dragging turns
 * both models identically and any difference on screen is the compression.
 */
export function CompareCanvas({ original, optimized, degraded, busy }: CompareCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CompareView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // A refused WebGL context — the browser's per-page limit, a blocked GPU —
    // must not take the whole dialog down with it. The numbers are the point;
    // the comparison is the extra.
    let view: CompareView;
    try {
      view = createCompareView(container);
    } catch (cause) {
      setError(`Vorschau nicht verfügbar: ${(cause as Error).message}`);
      return;
    }
    viewRef.current = view;

    const observer = new ResizeObserver(() => view.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      viewRef.current = null;
      view.dispose();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    void view
      .setModel('a', original)
      .catch((cause: Error) => {
        if (!cancelled) setError(`Vorschau links: ${cause.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [original]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    void view
      .setModel('b', degraded ? null : optimized)
      .catch((cause: Error) => {
        if (!cancelled) setError(`Vorschau rechts: ${cause.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [optimized, degraded]);

  return (
    <div className="relative h-48 overflow-hidden rounded-lg border bg-secondary/30">
      <div ref={containerRef} className="h-full w-full" />

      <span className="pointer-events-none absolute top-1.5 left-2 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        Aktuell
      </span>
      <span className="pointer-events-none absolute top-1.5 right-2 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        Optimiert
      </span>
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border/80" />

      {(busy || (!optimized && !degraded)) && (
        <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1.5 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          wird berechnet
        </span>
      )}

      {degraded && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex w-1/2 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          Vorschau deaktiviert — das Modell ist zu groß, um es zweimal gleichzeitig auf der
          Grafikkarte zu halten.
        </span>
      )}

      {error && (
        <span className="absolute inset-x-2 bottom-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
