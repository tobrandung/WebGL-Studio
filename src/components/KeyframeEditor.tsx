import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  Repeat,
  Repeat1,
  Plus,
  Trash2,
  Download,
  Upload,
  Camera,
  SlidersHorizontal,
  Eye,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { buildSplines, getCameraAtProgress, type Keyframe } from '@/three/camera-path';
import type { ViewportContext } from '@/three/viewport';

export type CameraPathImport = {
  keyframes?: Array<{ position: [number, number, number]; lookAt: [number, number, number] }>;
  isLoop?: boolean;
  speed?: number;
};

type KeyframeEditorProps = {
  viewportCtx: ViewportContext | null;
  keyframes: Keyframe[];
  isLoop: boolean;
  speed: number;
  /** Id of the keyframe whose marker currently owns the gizmo. */
  selectedKeyframeId: string | null;
  showSpline: boolean;
  showMarkers: boolean;
  onToggleSpline: (visible: boolean) => void;
  onToggleMarkers: (visible: boolean) => void;
  onSelectKeyframe: (id: string | null) => void;
  onAddKeyframe: () => void;
  onJumpToKeyframe: (id: string) => void;
  onDeleteKeyframe: (id: string) => void;
  onReorderKeyframes: (orderedIds: string[]) => void;
  onLoopChange: (isLoop: boolean) => void;
  onSpeedChange: (speed: number) => void;
  onImportPath: (data: CameraPathImport) => void;
};

export function KeyframeEditor({
  viewportCtx,
  keyframes,
  isLoop,
  speed,
  selectedKeyframeId,
  showSpline,
  showMarkers,
  onToggleSpline,
  onToggleMarkers,
  onSelectKeyframe,
  onAddKeyframe,
  onJumpToKeyframe,
  onDeleteKeyframe,
  onReorderKeyframes,
  onLoopChange,
  onSpeedChange,
  onImportPath,
}: KeyframeEditorProps) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState([0]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const animFrameRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  /** Which edges of the keyframe strip still have content hidden behind them. */
  const [overflow, setOverflow] = useState({ start: false, end: false });

  // Marker and spline rendering is owned by the viewport (see
  // `applyKeyframeMarkers`) so the gizmo keeps its target across edits; this
  // panel only drives playback, scrubbing and the timeline strip.
  const splines = buildSplines(keyframes, isLoop);

  useEffect(() => {
    if (!playing || !splines.positionSpline || !splines.lookAtSpline || !viewportCtx) return;

    let lastTime = performance.now();
    let currentProgress = progress[0] / 100;

    function tick() {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const duration = keyframes.length * 2;
      currentProgress += (dt * speed) / duration;

      if (currentProgress >= 1) {
        if (isLoop) {
          currentProgress = currentProgress % 1;
        } else {
          currentProgress = 1;
          setPlaying(false);
        }
      }

      if (splines.positionSpline && splines.lookAtSpline && viewportCtx) {
        const { position, lookAt } = getCameraAtProgress(splines.positionSpline, splines.lookAtSpline, currentProgress);
        viewportCtx.camera.position.copy(position);
        viewportCtx.camera.lookAt(lookAt);
      }

      setProgress([currentProgress * 100]);
      animFrameRef.current = requestAnimationFrame(tick);
    }

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [playing, speed, isLoop, keyframes, viewportCtx]);

  const syncOverflow = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    // 1px slack: fractional scroll offsets would otherwise keep a fade on forever.
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    syncOverflow();
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncOverflow, keyframes.length]);

  // A keyframe can also be selected by clicking its marker in the viewport, which
  // may sit far outside the visible part of a long strip.
  useEffect(() => {
    if (!selectedKeyframeId) return;
    stripRef.current
      ?.querySelector(`[data-kf-id="${selectedKeyframeId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedKeyframeId]);

  // Fades the chips themselves rather than overlaying the panel colour, so the
  // hint reads the same over any part of the 3D scene behind the bar.
  const fadeMask = `linear-gradient(to right, ${[
    overflow.start ? 'transparent 0px, #000 24px' : '#000 0px',
    overflow.end ? '#000 calc(100% - 36px), transparent 100%' : '#000 100%',
  ].join(', ')})`;

  const handleTimelineChange = useCallback(
    (value: number[]) => {
      setProgress(value);
      if (!splines.positionSpline || !splines.lookAtSpline || !viewportCtx) return;
      const t = value[0] / 100;
      const { position, lookAt } = getCameraAtProgress(splines.positionSpline, splines.lookAtSpline, t);
      viewportCtx.camera.position.copy(position);
      viewportCtx.camera.lookAt(lookAt);
    },
    [splines, viewportCtx],
  );

  /** Moves the dragged keyframe in front of the drop target. */
  const handleDrop = useCallback(
    (targetId: string) => {
      setDraggingId(null);
      setDropTargetId(null);
      if (!draggingId || draggingId === targetId) return;
      const remaining = keyframes.map((kf) => kf.id).filter((id) => id !== draggingId);
      const at = remaining.indexOf(targetId);
      if (at < 0) return;
      remaining.splice(at, 0, draggingId);
      onReorderKeyframes(remaining);
    },
    [draggingId, keyframes, onReorderKeyframes],
  );

  const exportJSON = useCallback(() => {
    const data = JSON.stringify(
      { keyframes: keyframes.map(({ position, lookAt }) => ({ position, lookAt })), isLoop, speed },
      null,
      2,
    );
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'camera-path.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [keyframes, isLoop, speed]);

  const importJSON = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          onImportPath(JSON.parse(reader.result as string) as CameraPathImport);
        } catch {
          /* invalid JSON */
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    },
    [onImportPath],
  );

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 border-t glass-surface">
      <div className="flex items-center gap-2 px-3 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Abspielen'}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{playing ? 'Pause' : 'Abspielen'}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onLoopChange(!isLoop)} aria-label={isLoop ? 'Loop deaktivieren' : 'Loop aktivieren'}>
              {isLoop ? <Repeat className="h-4 w-4" /> : <Repeat1 className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isLoop ? 'Loop deaktivieren' : 'Loop aktivieren'}</TooltipContent>
        </Tooltip>

        <div className="flex-1">
          <Slider min={0} max={100} step={0.1} value={progress} onValueChange={handleTimelineChange} />
        </div>

        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground">Speed</Label>
          <Slider
            className="w-20"
            min={0.1}
            max={5}
            step={0.1}
            value={[speed]}
            onValueChange={([v]) => onSpeedChange(v)}
          />
          <span className="w-8 text-right text-xs text-muted-foreground">{speed.toFixed(1)}x</span>
        </div>

        <Separator orientation="vertical" className="h-6" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onAddKeyframe} aria-label="Keyframe hinzufügen">
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {selectedKeyframeId ? 'Keyframe hinter dem gewählten einfügen' : 'Keyframe hinzufügen'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={exportJSON} aria-label="JSON exportieren">
              <Download className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Keyframes als JSON exportieren</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => fileInputRef.current?.click()} aria-label="JSON importieren">
              <Upload className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Keyframes aus JSON importieren</TooltipContent>
        </Tooltip>
        <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={importJSON} />
      </div>

      <Separator />

      <div className="flex items-center gap-3 px-3 py-1.5">
        <div className="flex shrink-0 items-center gap-2.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Eye className="h-3.5 w-3.5" />
                Anzeigen
              </span>
            </TooltipTrigger>
            <TooltipContent>Sichtbarkeit der Pfad-Hilfsobjekte im Viewport</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5">
                <Switch id="show-spline" checked={showSpline} onCheckedChange={onToggleSpline} />
                <Label htmlFor="show-spline" className="text-xs">Spline</Label>
              </div>
            </TooltipTrigger>
            <TooltipContent>Kurve der Kamerafahrt ein-/ausblenden</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5">
                <Switch id="show-markers" checked={showMarkers} onCheckedChange={onToggleMarkers} />
                <Label htmlFor="show-markers" className="text-xs">Marker</Label>
              </div>
            </TooltipTrigger>
            <TooltipContent>Keyframe-Punkte ein-/ausblenden (rot: Kamera, grün: Blickpunkt)</TooltipContent>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-5" />

        <span className="shrink-0 text-xs text-muted-foreground">Keyframes</span>

        <div className="min-w-0 flex-1">
          <div
            ref={stripRef}
            onScroll={syncOverflow}
            className="no-scrollbar flex gap-1.5 overflow-x-auto"
            style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
          >
            {keyframes.map((kf, i) => {
              const isSelected = selectedKeyframeId === kf.id;
              return (
                <div
                  key={kf.id}
                  data-kf-id={kf.id}
                  draggable
                  onDragStart={() => setDraggingId(kf.id)}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDropTargetId(null);
                  }}
                  onDragOver={(e) => {
                    if (!draggingId || draggingId === kf.id) return;
                    e.preventDefault();
                    setDropTargetId(kf.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(kf.id);
                  }}
                  onClick={() => onSelectKeyframe(isSelected ? null : kf.id)}
                  onDoubleClick={() => onJumpToKeyframe(kf.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSelectKeyframe(kf.id);
                  }}
                  title="Klick: auswählen · Doppelklick: Kamera hierher · Ziehen: umsortieren"
                  className={`group flex shrink-0 cursor-grab items-center gap-1 rounded-md px-2 py-1 ${
                    dropTargetId === kf.id ? 'border-l-2 border-ring' : ''
                  } ${
                    isSelected ? 'bg-accent text-accent-foreground ring-1 ring-ring' : 'bg-secondary'
                  } ${draggingId === kf.id ? 'opacity-40' : ''}`}
                >
                  <span className="min-w-3 text-center text-xs font-medium tabular-nums">{i + 1}</span>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="text-muted-foreground/70 transition-colors hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          onJumpToKeyframe(kf.id);
                        }}
                        type="button"
                        aria-label={`Kamera zu Keyframe ${i + 1}`}
                      >
                        <Camera className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Ansicht dieses Keyframes einnehmen</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="text-muted-foreground/70 transition-colors hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Selecting is what reveals the keyframe in the
                          // properties panel on the right.
                          onSelectKeyframe(kf.id);
                        }}
                        type="button"
                        aria-label={`Einstellungen von Keyframe ${i + 1}`}
                      >
                        <SlidersHorizontal className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Weitere Optionen im Eigenschaften-Panel</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="text-muted-foreground/70 transition-colors hover:text-red-400"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteKeyframe(kf.id);
                        }}
                        type="button"
                        aria-label={`Keyframe ${i + 1} löschen`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Keyframe löschen</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
