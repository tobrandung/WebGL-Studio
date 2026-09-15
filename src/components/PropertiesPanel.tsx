import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet } from '@/components/ui/sheet';
import {
  Camera,
  Copy,
  Crosshair,
  ImageUp,
  Link2,
  Link2Off,
  Maximize,
  Move,
  RotateCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { InfoHint } from '@/components/ui/info-hint';
import { cn, formatBytes } from '@/lib/utils';
import { environmentFormat, type LightEntry, type EnvironmentConfig } from '@/lib/db';
import { BUDGET_OK } from '@/lib/hdri/budget';
import { ENVIRONMENT_FORMAT_LABEL } from '@/lib/hdri/format';
import type { Keyframe, KeyframePart } from '@/three/camera-path';
import type { TransformMode } from '@/three/viewport';

export type KeyframeSelection = {
  keyframe: Keyframe;
  /** 1-based position in the path, for labelling. */
  index: number;
  part: KeyframePart;
};

export type ModelTransformKey = 'position' | 'rotation' | 'scale';

export type ModelSelection = {
  id: string;
  name: string;
  position: [number, number, number];
  /** Euler angles in radians, as THREE stores them. */
  rotation: [number, number, number];
  scale: [number, number, number];
};

type PropertiesPanelProps = {
  model: ModelSelection | null;
  /** Which transform channel the viewport gizmo currently drags. */
  transformMode: TransformMode;
  onTransformModeChange: (mode: TransformMode) => void;
  /** Whether editing one scale axis carries the factor to the other two. */
  scaleLocked: boolean;
  onScaleLockChange: (locked: boolean) => void;
  light: LightEntry | null;
  environment: EnvironmentConfig | null;
  /** Non-null when the world/background entry is selected. */
  background: string | null;
  /**
   * The scene's environment regardless of what is selected. The world panel
   * needs it to offer the HDRI as a background source. And to hide that
   * option entirely when no environment has been added.
   */
  sceneEnvironment: EnvironmentConfig | null;
  onUseEnvironmentBackground: (use: boolean) => void;
  keyframe: KeyframeSelection | null;
  onUpdateModelTransform: (key: ModelTransformKey, value: [number, number, number]) => void;
  onUpdateLight: (id: string, patch: Partial<LightEntry>) => void;
  onUpdateEnvironment: (patch: Partial<EnvironmentConfig>) => void;
  onReplaceEnvironment: () => void;
  onUpdateBackground: (color: string) => void;
  onUpdateKeyframe: (id: string, patch: Partial<Omit<Keyframe, 'id'>>) => void;
  onSelectKeyframePart: (id: string, part: KeyframePart) => void;
  onCaptureKeyframeFromCamera: (id: string) => void;
  onJumpToKeyframe: (id: string) => void;
  onDuplicateKeyframe: (id: string) => void;
  onDeleteKeyframe: (id: string) => void;
  /** Whether anything is selected. Drives the slide in and out. */
  open: boolean;
};

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

function Row({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function ValueLabel({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{label}</Label>
      <span className="text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

export function PropertiesPanel({
  model,
  transformMode,
  onTransformModeChange,
  scaleLocked,
  onScaleLockChange,
  light,
  environment,
  background,
  sceneEnvironment,
  onUseEnvironmentBackground,
  keyframe,
  onUpdateModelTransform,
  onUpdateLight,
  onUpdateEnvironment,
  onReplaceEnvironment,
  onUpdateBackground,
  onUpdateKeyframe,
  onSelectKeyframePart,
  onCaptureKeyframeFromCamera,
  onJumpToKeyframe,
  onDuplicateKeyframe,
  onDeleteKeyframe,
  open,
}: PropertiesPanelProps) {
  return (
    <Sheet
      side="right"
      open={open}
      className="absolute right-0 top-[49px] z-10 flex h-[calc(100%-49px)] w-[260px] flex-col border-l glass-surface"
    >
      <div className="px-3 py-2">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Eigenschaften
        </span>
      </div>
      <Separator />
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {model && (
          <ModelProperties
            model={model}
            transformMode={transformMode}
            onTransformModeChange={onTransformModeChange}
            scaleLocked={scaleLocked}
            onScaleLockChange={onScaleLockChange}
            onUpdate={onUpdateModelTransform}
          />
        )}
        {background !== null && (
          <WorldProperties
            background={background}
            environment={sceneEnvironment}
            onUpdate={onUpdateBackground}
            onUseEnvironmentBackground={onUseEnvironmentBackground}
          />
        )}
        {light && <LightProperties light={light} onUpdate={onUpdateLight} />}
        {keyframe && (
          <KeyframeProperties
            selection={keyframe}
            onUpdate={onUpdateKeyframe}
            onSelectPart={onSelectKeyframePart}
            onCaptureFromCamera={onCaptureKeyframeFromCamera}
            onJumpTo={onJumpToKeyframe}
            onDuplicate={onDuplicateKeyframe}
            onDelete={onDeleteKeyframe}
          />
        )}
        {environment && (
          <EnvironmentProperties
            environment={environment}
            onUpdate={onUpdateEnvironment}
            onReplace={onReplaceEnvironment}
          />
        )}
      </div>
    </Sheet>
  );
}

/** Normalisiert Hex-Eingaben (#rgb / #rrggbb, optional ohne #). */
function normalizeHex(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (!value.startsWith('#')) value = `#${value}`;

  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const r = value[1];
    const g = value[2];
    const b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  return null;
}

function isPureGray(hex: string): boolean {
  const normalized = normalizeHex(hex);
  if (!normalized) return false;
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return r === g && g === b;
}

function hexToGrayChannel(hex: string): number {
  const normalized = normalizeHex(hex);
  if (!normalized) return 26;
  return Number.parseInt(normalized.slice(1, 3), 16);
}

function grayToHex(value: number): string {
  const channel = Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
  return `#${channel}${channel}${channel}`;
}

type BackgroundMode = 'hdri' | 'gray' | 'custom';

/**
 * The three mutually exclusive background sources. Only one can own
 * `scene.background`, so picking a colour turns the HDRI dome off and picking
 * the HDRI leaves the colour untouched. Switch back and the grey/hex values
 * are still there. The HDRI card only exists while an environment is loaded.
 */
function WorldProperties({
  background,
  environment,
  onUpdate,
  onUseEnvironmentBackground,
}: {
  background: string;
  environment: EnvironmentConfig | null;
  onUpdate: (color: string) => void;
  onUseEnvironmentBackground: (use: boolean) => void;
}) {
  const hdriActive = environment?.showBackground ?? false;
  const [colorMode, setColorMode] = useState<Exclude<BackgroundMode, 'hdri'>>(() =>
    isPureGray(background) ? 'gray' : 'custom',
  );
  // While the dome is shown it *is* the background, so it wins over whichever
  // colour card was last picked; that choice is remembered underneath.
  const mode: BackgroundMode = hdriActive ? 'hdri' : colorMode;
  const setMode = (next: Exclude<BackgroundMode, 'hdri'>) => {
    setColorMode(next);
    if (hdriActive) onUseEnvironmentBackground(false);
  };
  // Slider-Wert entkoppelt von der aktuellen Farbe im Custom-Modus.
  const [graySliderValue, setGraySliderValue] = useState(() =>
    isPureGray(background) ? hexToGrayChannel(background) : 26,
  );
  const [hexDraft, setHexDraft] = useState(background);
  const colorInputValue = normalizeHex(background) ?? '#1a1a1a';

  useEffect(() => {
    setHexDraft(background);
    // Follow externally applied greys (undo/redo) so the thumb keeps matching
    // the colour it produced. The mode is left alone. Which card is
    // highlighted stays the user's choice.
    if (isPureGray(background)) setGraySliderValue(hexToGrayChannel(background));
  }, [background]);

  const applyGray = (value: number) => {
    const next = grayToHex(value);
    setMode('gray');
    setGraySliderValue(value);
    setHexDraft(next);
    onUpdate(next);
  };

  const applyCustom = (raw: string) => {
    const normalized = normalizeHex(raw);
    if (!normalized) {
      setHexDraft(background);
      return;
    }
    setMode('custom');
    setHexDraft(normalized);
    onUpdate(normalized);
  };

  return (
    <>
      <p className="text-xs text-muted-foreground">Welt</p>

      {environment && (
        <div
          role="button"
          tabIndex={0}
          aria-pressed={mode === 'hdri'}
          onClick={() => onUseEnvironmentBackground(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onUseEnvironmentBackground(true);
            }
          }}
          className={cn(
            'cursor-pointer rounded-lg border p-3 transition-colors',
            mode === 'hdri'
              ? 'active-surface'
              : 'border-border/60 opacity-60 hover:opacity-80',
          )}
        >
          <Label className="mb-2 block text-xs">HDRI-Hintergrund</Label>
          <p className="truncate text-[11px] text-muted-foreground" title={environment.fileName}>
            {environment.fileName}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Intensität und Unschärfe unter „Umgebung“.
          </p>
        </div>
      )}

      <div
        role="button"
        tabIndex={0}
        aria-pressed={mode === 'gray'}
        onClick={() => applyGray(graySliderValue)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            applyGray(graySliderValue);
          }
        }}
        className={cn(
          'cursor-pointer rounded-lg border p-3 transition-colors',
          mode === 'gray'
            ? 'active-surface'
            : 'border-border/60 opacity-60 hover:opacity-80',
        )}
      >
        <Label className="mb-2 block text-xs">Graustufen</Label>
        <Slider
          min={0}
          max={255}
          step={1}
          value={[graySliderValue]}
          onValueChange={([v]) => applyGray(v)}
          onPointerDown={() => applyGray(graySliderValue)}
          aria-label="Graustufen von Schwarz bis Weiß"
        />
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
          <span>Schwarz</span>
          <span>{graySliderValue}</span>
          <span>Weiß</span>
        </div>
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-pressed={mode === 'custom'}
        onClick={() => {
          setMode('custom');
          setHexDraft(background);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setMode('custom');
            setHexDraft(background);
          }
        }}
        className={cn(
          'cursor-pointer rounded-lg border p-3 transition-colors',
          mode === 'custom'
            ? 'active-surface'
            : 'border-border/60 opacity-60 hover:opacity-80',
        )}
      >
        <Label htmlFor="bg-color" className="mb-2 block text-xs">
          Eigene Hintergrundfarbe
        </Label>
        <div className="flex min-w-0 items-center gap-2">
          <input
            id="bg-color"
            type="color"
            value={colorInputValue}
            onChange={(e) => applyCustom(e.target.value)}
            onFocus={() => setMode('custom')}
            className="h-9 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent"
            aria-label="Eigene Hintergrundfarbe wählen"
          />
          <Input
            value={hexDraft}
            onChange={(e) => {
              setMode('custom');
              setHexDraft(e.target.value);
            }}
            onFocus={() => setMode('custom')}
            onBlur={() => applyCustom(hexDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            spellCheck={false}
            className="font-mono text-xs uppercase"
            aria-label="Hex-Farbwert"
            placeholder="#1a1a1a"
          />
        </div>
      </div>
    </>
  );
}

function LightProperties({
  light,
  onUpdate,
}: {
  light: LightEntry;
  onUpdate: (id: string, patch: Partial<LightEntry>) => void;
}) {
  const typeLabel: Record<LightEntry['type'], string> = {
    ambient: 'Umgebungslicht',
    directional: 'Richtungslicht',
    point: 'Punktlicht',
    spot: 'Spotlicht',
  };

  return (
    <>
      <p className="text-xs text-muted-foreground">{typeLabel[light.type]}</p>

      {/* Ambient light has no place in the scene; its `position` is ignored. */}
      {light.type !== 'ambient' && (
        <TransformChannel
          icon={Move}
          label="Position"
          value={light.position}
          onChange={(position) => onUpdate(light.id, { position })}
        />
      )}

      <Row>
        <Label htmlFor="light-color" className="text-xs">
          Farbe
        </Label>
        <div className="flex items-center gap-2">
          <input
            id="light-color"
            type="color"
            value={light.color}
            onChange={(e) => onUpdate(light.id, { color: e.target.value })}
            className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent"
            aria-label="Lichtfarbe"
          />
          <span className="text-xs text-muted-foreground">{light.color}</span>
        </div>
      </Row>

      <Row>
        <ValueLabel label="Intensität" value={light.intensity.toFixed(2)} />
        <Slider
          min={0}
          max={light.type === 'ambient' || light.type === 'directional' ? 3 : 30}
          step={0.05}
          value={[light.intensity]}
          onValueChange={([v]) => onUpdate(light.id, { intensity: v })}
        />
      </Row>

      {(light.type === 'point' || light.type === 'spot') && (
        <>
          <Row>
            <ValueLabel label="Reichweite" value={light.distance ? light.distance.toFixed(1) : '∞'} />
            <Slider
              min={0}
              max={50}
              step={0.5}
              value={[light.distance ?? 0]}
              onValueChange={([v]) => onUpdate(light.id, { distance: v })}
            />
          </Row>
          <Row>
            <ValueLabel label="Abnahme (Decay)" value={(light.decay ?? 2).toFixed(1)} />
            <Slider
              min={0}
              max={4}
              step={0.1}
              value={[light.decay ?? 2]}
              onValueChange={([v]) => onUpdate(light.id, { decay: v })}
            />
          </Row>
        </>
      )}

      {light.type === 'spot' && (
        <>
          <Row>
            <ValueLabel label="Kegelwinkel" value={`${Math.round((light.angle ?? Math.PI / 6) * RAD_TO_DEG)}°`} />
            <Slider
              min={5}
              max={90}
              step={1}
              value={[(light.angle ?? Math.PI / 6) * RAD_TO_DEG]}
              onValueChange={([v]) => onUpdate(light.id, { angle: v * DEG_TO_RAD })}
            />
          </Row>
          <Row>
            <ValueLabel label="Weichzeichnung" value={(light.penumbra ?? 0).toFixed(2)} />
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[light.penumbra ?? 0]}
              onValueChange={([v]) => onUpdate(light.id, { penumbra: v })}
            />
          </Row>
        </>
      )}
    </>
  );
}

function EnvironmentProperties({
  environment,
  onUpdate,
  onReplace,
}: {
  environment: EnvironmentConfig;
  onUpdate: (patch: Partial<EnvironmentConfig>) => void;
  onReplace: () => void;
}) {
  return (
    <>
      <Row>
        <Label className="text-xs">Bild</Label>
        <div className="rounded-md bg-secondary px-2 py-1.5">
          <p className="truncate text-xs" title={environment.sourceFileName ?? environment.fileName}>
            {environment.fileName}
          </p>
          <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            {environment.fileSize !== undefined && formatBytes(environment.fileSize)}
            {environment.width ? ` · ${environment.width} × ${environment.height}` : ''}
            {` · ${ENVIRONMENT_FORMAT_LABEL[environmentFormat(environment)]}`}
            {environment.fileSize !== undefined && environment.fileSize > BUDGET_OK && (
              <InfoHint variant="warning" label="Große Umgebung">
                Diese Umgebung ist für ein Web-Widget groß. Sie wird beim Export mitgeliefert und
                von jedem Besucher geladen. Über „Bild ersetzen“ lässt sie sich auf 1024 × 512
                umrechnen; für Spiegelungen bleibt die Qualität praktisch identisch.
              </InfoHint>
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" className="w-full" onClick={onReplace}>
          <ImageUp className="mr-2 h-3.5 w-3.5" />
          Bild ersetzen
        </Button>
      </Row>

      <div className="flex items-center justify-between">
        <Label htmlFor="env-reflect" className="text-xs">
          Für Spiegelung nutzen
        </Label>
        <Switch
          id="env-reflect"
          checked={environment.useForReflection}
          onCheckedChange={(v) => onUpdate({ useForReflection: v })}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="env-bg" className="text-xs">
          Als Hintergrund zeigen
        </Label>
        <Switch
          id="env-bg"
          checked={environment.showBackground}
          onCheckedChange={(v) => onUpdate({ showBackground: v })}
        />
      </div>

      <Row>
        <ValueLabel label="Intensität" value={environment.intensity.toFixed(2)} />
        <Slider
          min={0}
          max={3}
          step={0.05}
          value={[environment.intensity]}
          onValueChange={([v]) => onUpdate({ intensity: v })}
        />
      </Row>

      {environment.showBackground && (
        <Row>
          <ValueLabel label="Hintergrund-Unschärfe" value={(environment.blurriness ?? 0).toFixed(2)} />
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={[environment.blurriness ?? 0]}
            onValueChange={([v]) => onUpdate({ blurriness: v })}
          />
        </Row>
      )}
    </>
  );
}

const AXES = ['X', 'Y', 'Z'] as const;

/** Trims float noise so a gizmo drag doesn't fill the fields with 14 digits. */
function formatAxis(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * Three numeric axis fields committing on blur/Enter, so a half-typed value
 * never reaches the scene.
 *
 * Only the axis being typed in holds a draft; the other two render straight
 * from `value`. Keeping drafts for all three meant an edit that also moved its
 * siblings, proportional scaling, or an undo, left those fields showing the
 * old number while the scene had already changed.
 */
function AxisInputs({
  label,
  value,
  onChange,
}: {
  /** Names the fields for screen readers; the visible heading is separate. */
  label: string;
  value: [number, number, number];
  onChange: (next: [number, number, number]) => void;
}) {
  const [draft, setDraft] = useState<{ axis: number; text: string } | null>(null);

  const commit = (index: number, raw: string) => {
    setDraft(null);
    const parsed = Number.parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed === value[index]) return;
    const next: [number, number, number] = [...value];
    next[index] = parsed;
    onChange(next);
  };

  return (
    <div className="grid grid-cols-3 gap-1">
      {AXES.map((axis, index) => (
        <div key={axis} className="relative">
          <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground">
            {axis}
          </span>
          <Input
            value={draft?.axis === index ? draft.text : formatAxis(value[index])}
            onChange={(e) => setDraft({ axis: index, text: e.target.value })}
            onBlur={(e) => commit(index, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            inputMode="decimal"
            spellCheck={false}
            className="pl-5 font-mono text-xs"
            aria-label={`${label} ${axis}`}
          />
        </div>
      ))}
    </div>
  );
}

/** Axis fields under a plain label, for values no gizmo mode belongs to. */
function Vec3Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  onChange: (next: [number, number, number]) => void;
}) {
  return (
    <Row>
      <Label className="text-xs">{label}</Label>
      <AxisInputs label={label} value={value} onChange={onChange} />
    </Row>
  );
}

/**
 * One transform channel, its heading included.
 *
 * The heading doubles as the gizmo's mode switch, which is what let the tool
 * icons leave the toolbar: every channel is on screen at once, and the
 * highlighted row is the one the viewport gizmo drags. A light has only its
 * position, so there is nothing to switch and the heading stays a label.
 */
function TransformChannel({
  icon: Icon,
  label,
  value,
  onChange,
  active,
  onActivate,
  action,
}: {
  icon: LucideIcon;
  label: string;
  value: [number, number, number];
  onChange: (next: [number, number, number]) => void;
  active?: boolean;
  onActivate?: () => void;
  /** Optional control on the heading row, e.g. the proportional lock. */
  action?: React.ReactNode;
}) {
  const heading = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </>
  );

  return (
    <Row>
      <div className="flex items-center justify-between gap-2">
        {onActivate ? (
          <button
            type="button"
            onClick={onActivate}
            aria-pressed={active}
            className={cn(
              'flex items-center gap-2 rounded border border-transparent px-2 py-1 text-xs transition-colors',
              active ? 'active-surface' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {heading}
          </button>
        ) : (
          <span className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            {heading}
          </span>
        )}
        {action}
      </div>
      <AxisInputs label={label} value={value} onChange={onChange} />
    </Row>
  );
}

function ModelProperties({
  model,
  transformMode,
  onTransformModeChange,
  scaleLocked,
  onScaleLockChange,
  onUpdate,
}: {
  model: ModelSelection;
  transformMode: TransformMode;
  onTransformModeChange: (mode: TransformMode) => void;
  scaleLocked: boolean;
  onScaleLockChange: (locked: boolean) => void;
  onUpdate: (key: ModelTransformKey, value: [number, number, number]) => void;
}) {
  const commitScale = (next: [number, number, number]) => {
    if (!scaleLocked) {
      onUpdate('scale', next);
      return;
    }
    const axis = next.findIndex((v, i) => v !== model.scale[i]);
    if (axis < 0) return;
    const from = model.scale[axis];
    const to = next[axis];
    // Scale the other axes by the same factor so a non-uniform model keeps its
    // proportions. A zero axis has no ratio to carry over, so the typed value
    // is simply copied across.
    onUpdate(
      'scale',
      from === 0
        ? [to, to, to]
        : (model.scale.map((v) => v * (to / from)) as [number, number, number]),
    );
  };

  return (
    <>
      <p className="truncate text-xs text-muted-foreground" title={model.name}>
        {model.name}
      </p>

      <TransformChannel
        icon={Move}
        label="Position"
        value={model.position}
        onChange={(next) => onUpdate('position', next)}
        active={transformMode === 'translate'}
        onActivate={() => onTransformModeChange('translate')}
      />

      {/* Degrees, because radians in an input field are unreadable. */}
      <TransformChannel
        icon={RotateCw}
        label="Rotation (°)"
        value={model.rotation.map((r) => r * RAD_TO_DEG) as [number, number, number]}
        onChange={(next) =>
          onUpdate('rotation', next.map((d) => d * DEG_TO_RAD) as [number, number, number])
        }
        active={transformMode === 'rotate'}
        onActivate={() => onTransformModeChange('rotate')}
      />

      <TransformChannel
        icon={Maximize}
        label="Skalierung"
        value={model.scale}
        onChange={commitScale}
        active={transformMode === 'scale'}
        onActivate={() => onTransformModeChange('scale')}
        action={
          <button
            type="button"
            onClick={() => onScaleLockChange(!scaleLocked)}
            aria-pressed={scaleLocked}
            aria-label={
              scaleLocked ? 'Proportionale Skalierung ausschalten' : 'Proportional skalieren'
            }
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors',
              scaleLocked
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {scaleLocked ? <Link2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3" />}
            Proportional
          </button>
        }
      />

      {scaleLocked && (
        <p className="text-[11px] text-muted-foreground">
          Proportional: ein Wert genügt, die anderen Achsen folgen im gleichen Verhältnis.
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">
        Die hervorgehobene Zeile ist das Werkzeug im Viewport. Mit G, R und S umschalten.
      </p>
    </>
  );
}

function KeyframeProperties({
  selection,
  onUpdate,
  onSelectPart,
  onCaptureFromCamera,
  onJumpTo,
  onDuplicate,
  onDelete,
}: {
  selection: KeyframeSelection;
  onUpdate: (id: string, patch: Partial<Omit<Keyframe, 'id'>>) => void;
  onSelectPart: (id: string, part: KeyframePart) => void;
  onCaptureFromCamera: (id: string) => void;
  onJumpTo: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { keyframe, index, part } = selection;

  return (
    <>
      <p className="text-xs text-muted-foreground">Keyframe {index}</p>

      <div className="grid grid-cols-2 gap-1">
        <Button
          variant="outline"
          size="sm"
          className={cn(part === 'position' && 'active-surface')}
          onClick={() => onSelectPart(keyframe.id, 'position')}
        >
          Kamera
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={cn(part === 'lookAt' && 'active-surface')}
          onClick={() => onSelectPart(keyframe.id, 'lookAt')}
        >
          Blickpunkt
        </Button>
      </div>

      <Vec3Field
        label="Kameraposition"
        value={keyframe.position}
        onChange={(position) => onUpdate(keyframe.id, { position })}
      />
      <Vec3Field
        label="Blickpunkt"
        value={keyframe.lookAt}
        onChange={(lookAt) => onUpdate(keyframe.id, { lookAt })}
      />

      <Separator />

      <div className="space-y-1.5">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={() => onCaptureFromCamera(keyframe.id)}
        >
          <Camera className="mr-2 h-3.5 w-3.5" />
          Aktuelle Ansicht übernehmen
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={() => onJumpTo(keyframe.id)}
        >
          <Crosshair className="mr-2 h-3.5 w-3.5" />
          Kamera hierher setzen
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={() => onDuplicate(keyframe.id)}
        >
          <Copy className="mr-2 h-3.5 w-3.5" />
          Duplizieren
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start text-red-400 hover:text-red-300"
          onClick={() => onDelete(keyframe.id)}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Löschen
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Marker im Viewport per Verschieben-Gizmo ziehen. Der rote Punkt ist die Kamera, der grüne
        der Blickpunkt.
      </p>
    </>
  );
}
