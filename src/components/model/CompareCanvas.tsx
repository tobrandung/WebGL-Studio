import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { createCompareView, type CompareView } from '@/three/preview-compare';

type CompareCanvasProps = {
  /** The unmodified GLB. */
  original: ArrayBuffer | null;
  /** The compressed result, or null while none has been produced yet. */
  optimized: ArrayBuffer | null;
  /** Shown instead of the right-hand side when the model is too big to hold twice. */
  degraded?: boolean;
  busy?: boolean;
  /** Height override. The caller knows how much room the layout gives it. */
  className?: string;
};

/**
 * Before/after comparison. Both halves share one camera, so dragging turns
 * both models identically and any difference on screen is the compression.
 */
export function CompareCanvas({
  original,
  optimized,
  degraded,
  busy,
  className,
}: CompareCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CompareView | null>(null);
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  /**
   * Kept apart from `error`: a browser refusing fullscreen says nothing about
   * the comparison, which keeps working. It belongs next to the button that
   * was pressed, and the button has to stay pressable.
   */
  const [fullscreenError, setFullscreenError] = useState('');

  /**
   * The real Fullscreen API rather than a fixed-position overlay: the dialog
   * above this has both a transform and a backdrop-filter, and either one makes
   * it the containing block for `position: fixed` children. An "overlay" would
   * only ever fill the dialog. A fullscreen element is promoted to the browser's
   * top layer instead, so it escapes all of that.
   */
  const toggleFullscreen = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;

    if (document.fullscreenElement === frame) {
      void document.exitFullscreen();
      return;
    }
    if (!frame.requestFullscreen) {
      setFullscreenError('Vollbild wird hier nicht unterstützt');
      return;
    }
    setFullscreenError('');
    frame.requestFullscreen().catch((cause: Error) => {
      setFullscreenError(`Vollbild nicht möglich: ${cause.message}`);
    });
  }, []);

  // The canvas is resized by the ResizeObserver below. The element that goes
  // fullscreen is this frame, and the container inside it follows its box.
  // This only keeps the icon and the classes in sync, including when the user
  // leaves fullscreen by way of the browser rather than the button.
  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === frameRef.current;
      setFullscreen(active);
      if (active) setFullscreenError('');
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleFullscreen();
        return;
      }

      // While fullscreen, Escape belongs to this view. The dialog listens for
      // it on the document as well and would otherwise close behind us, so it is
      // caught in the capture phase so that listener never sees the key.
      if (event.key === 'Escape' && document.fullscreenElement === frameRef.current) {
        event.stopPropagation();
        void document.exitFullscreen();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [toggleFullscreen]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // A refused WebGL context. The browser's per-page limit, a blocked GPU:
    // none of them must take the whole dialog down with it. The numbers are the point;
    // the comparison is the extra.
    let view: CompareView;
    try {
      view = createCompareView(container);
    } catch (cause) {
      setError(`Vorschau nicht verfügbar: ${(cause as Error).message}`);
      return;
    }
    viewRef.current = view;
    // The renderer comes up asynchronously, and a browser without WebGPU and
    // WebGL 2 only says so then.
    view.ready.catch((cause: Error) => setError(`Vorschau nicht verfügbar: ${cause.message}`));

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
    <div
      ref={frameRef}
      // The fullscreen sizing is a `:fullscreen` rule in index.css keyed on this
      // attribute, not a class toggled from `fullscreen` state: the state can
      // drift (a fullscreenchange that never arrives leaves a screen-sized box
      // sitting inside the dialog), while the pseudo-class cannot.
      data-compare-frame=""
      className={cn('relative h-48 overflow-hidden rounded-lg border bg-secondary/30', className)}
    >
      <div ref={containerRef} className="h-full w-full" />

      <span className="pointer-events-none absolute top-1.5 left-2 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        Aktuell
      </span>
      <span className="pointer-events-none absolute top-1.5 right-2 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        Optimiert
      </span>
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border/80" />

      {/* Button and hint in one group, bottom left. The shortcut is written out
          next to the control rather than left to the tooltip alone: a tooltip
          is portalled to document.body, which is outside the top layer and so
          invisible in fullscreen. Exactly where the way back matters. */}
      {!error && (
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="h-7 w-7 bg-background/70"
                onClick={toggleFullscreen}
                aria-label={fullscreen ? 'Vollbild beenden' : 'Vergleich im Vollbild'}
                aria-pressed={fullscreen}
              >
                {fullscreen ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {fullscreen ? 'Vollbild beenden (F oder Esc)' : 'Vergleich im Vollbild (F)'}
            </TooltipContent>
          </Tooltip>
          <span
            className={cn(
              'pointer-events-none rounded bg-background/70 px-1.5 py-0.5 text-[10px]',
              fullscreenError ? 'text-orange-400' : 'text-muted-foreground',
            )}
          >
            {fullscreenError || (
              <>
                <kbd className="font-mono">F</kbd> {fullscreen ? '· Esc beendet' : 'für Vollbild'}
              </>
            )}
          </span>
        </div>
      )}

      {(busy || (!optimized && !degraded)) && (
        <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1.5 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          wird berechnet
        </span>
      )}

      {degraded && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex w-1/2 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          Vorschau deaktiviert. Das Modell ist zu groß, um es zweimal gleichzeitig auf der
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
