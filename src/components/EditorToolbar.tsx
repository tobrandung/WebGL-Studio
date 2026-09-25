import {
  ArrowLeft,
  Plus,
  Video,
  Undo2,
  Redo2,
  Share,
  Box,
  Lightbulb,
  Sun,
  Flashlight,
  Globe,
  Image,
  Square,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import type { SaveStatus } from '@/lib/db';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { LightType } from '@/lib/db';
import type { HistoryState } from '@/hooks/useHistory';

type EditorToolbarProps = {
  onAddModel: () => void;
  onAddLight: (type: LightType) => void;
  onAddPlane: () => void;
  /** What the viewport shows besides the scene itself. */
  /** `all` is the master switch; the others apply only while it is on. */
  overlays: { all: boolean; grid: boolean; lightHelpers: boolean; spline: boolean; markers: boolean };
  onToggleAll: (visible: boolean) => void;
  onToggleGrid: (visible: boolean) => void;
  onToggleLightHelpers: (visible: boolean) => void;
  onToggleSpline: (visible: boolean) => void;
  onToggleMarkers: (visible: boolean) => void;
  onAddEnvironment: () => void;
  onOpenKeyframeEditor: () => void;
  /** Whether the keyframe bar is showing, so the button reads as a toggle. */
  keyframeEditorOpen: boolean;
  onExport: () => void;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  history: HistoryState;
  projectName: string;
  saveStatus: SaveStatus;
  /** Opens the conflict resolution dialog. */
  onResolveConflict: () => void;
  hasKeyframes: boolean;
};

export function EditorToolbar({
  onAddModel,
  onAddLight,
  onAddPlane,
  overlays,
  onToggleAll,
  onToggleGrid,
  onToggleLightHelpers,
  onToggleSpline,
  onToggleMarkers,
  onAddEnvironment,
  onOpenKeyframeEditor,
  keyframeEditorOpen,
  onExport,
  onBack,
  onUndo,
  onRedo,
  history,
  projectName,
  saveStatus,
  onResolveConflict,
  hasKeyframes,
}: EditorToolbarProps) {
  return (
    <div className="absolute left-0 right-0 top-0 z-10 flex items-center gap-1 border-b glass-surface px-3 py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Zurück zum Dashboard">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Zurück</TooltipContent>
      </Tooltip>

      <span className="mr-1 text-sm font-medium">{projectName}</span>
      {saveStatus === 'saved' && (
        <span className="text-xs text-muted-foreground">Gespeichert</span>
      )}
      {saveStatus === 'saving' && (
        <span className="text-xs text-muted-foreground">Speichert…</span>
      )}
      {saveStatus === 'dirty' && (
        <span className="inline-block h-2 w-2 rounded-full bg-orange-400" title="Ungespeicherte Änderungen" />
      )}
      {/* Local save succeeded, the R2 copy did not. The work is safe in this
          browser but nowhere else, which is worth saying plainly. */}
      {saveStatus === 'offline' && (
        <span
          className="text-xs text-orange-400"
          title="Lokal gespeichert, aber nicht ins CDN synchronisiert. Bei abgelaufener Sitzung hilft ein Reload."
        >
          Nur lokal
        </span>
      )}
      {saveStatus === 'conflict' && (
        <button
          type="button"
          onClick={onResolveConflict}
          className="text-xs text-red-400 underline underline-offset-2 hover:text-red-300"
          title="Jemand anderes hat dieses Projekt zwischenzeitlich gespeichert. Klicken, um zu entscheiden, welche Fassung gilt."
        >
          Konflikt
        </button>
      )}

      <Separator orientation="vertical" className="mx-1.5 h-6" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={onUndo} disabled={!history.canUndo} aria-label="Rückgängig">
            <Undo2 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{history.canUndo ? `Rückgängig: ${history.undoLabel}` : 'Rückgängig (Cmd+Z)'}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={onRedo} disabled={!history.canRedo} aria-label="Wiederholen">
            <Redo2 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{history.canRedo ? `Wiederholen: ${history.redoLabel}` : 'Wiederholen (Cmd+Shift+Z)'}</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="mx-1.5 h-6" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Objekt hinzufügen">
            <Plus className="mr-1 h-4 w-4" />
            Hinzufügen
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onAddModel}>
            <Box className="mr-2 h-4 w-4" />
            Modell
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Lightbulb className="mr-2 h-4 w-4" />
              Licht
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => onAddLight('point')}>
                <Lightbulb className="mr-2 h-4 w-4" />
                Punktlicht
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAddLight('directional')}>
                <Sun className="mr-2 h-4 w-4" />
                Richtungslicht
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAddLight('spot')}>
                <Flashlight className="mr-2 h-4 w-4" />
                Spotlicht
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAddLight('ambient')}>
                <Globe className="mr-2 h-4 w-4" />
                Umgebungslicht
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={onAddPlane}>
            <Square className="mr-2 h-4 w-4" />
            Plane
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">Umgebung</DropdownMenuLabel>
          <DropdownMenuItem onClick={onAddEnvironment}>
            <Image className="mr-2 h-4 w-4" />
            HDRI / Umgebung
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Toggling keeps the menu open, so several overlays can be set in one go. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Anzeige im Viewport">
            <Eye className="mr-1 h-4 w-4" />
            Anzeigen
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {/* An action rather than a checkbox: the label says what a click does. */}
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onToggleAll(!overlays.all);
            }}
          >
            {overlays.all ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
            {overlays.all ? 'Alle verstecken' : 'Alle zeigen'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={overlays.grid}
            disabled={!overlays.all}
            onCheckedChange={onToggleGrid}
            onSelect={(e) => e.preventDefault()}
          >
            Grid
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={overlays.lightHelpers}
            disabled={!overlays.all}
            onCheckedChange={onToggleLightHelpers}
            onSelect={(e) => e.preventDefault()}
          >
            Licht-Helfer
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">Kamerafahrt</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={overlays.spline}
            disabled={!overlays.all}
            onCheckedChange={onToggleSpline}
            onSelect={(e) => e.preventDefault()}
          >
            Spline
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={overlays.markers}
            disabled={!overlays.all}
            onCheckedChange={onToggleMarkers}
            onSelect={(e) => e.preventDefault()}
          >
            Marker
          </DropdownMenuCheckboxItem>
          {!keyframeEditorOpen && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              Spline und Marker erscheinen, solange die Kamerafahrt offen ist.
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(keyframeEditorOpen && 'active-surface')}
            aria-pressed={keyframeEditorOpen}
            onClick={onOpenKeyframeEditor}
          >
            <Video className="mr-1 h-4 w-4" />
            Kamerafahrt
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {keyframeEditorOpen ? 'Keyframe Editor schließen' : 'Keyframe Editor öffnen'}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={!hasKeyframes}
            aria-label="Exportieren"
          >
            <Share className="mr-1 h-4 w-4" />
            Exportieren
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {hasKeyframes ? 'Als Widget exportieren' : 'Erstelle zuerst eine Kamerafahrt'}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
