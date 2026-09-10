import { useCallback, useState } from 'react';
import {
  Eye,
  EyeOff,
  MoreHorizontal,
  Pencil,
  Copy,
  Replace,
  Trash2,
  ChevronRight,
  ChevronDown,
  Layers,
  FolderPlus,
  FolderMinus,
  GripVertical,
  Lightbulb,
  Sun,
  Flashlight,
  Globe,
  Image as ImageIcon,
  Palette,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ModelEntry, SceneGroup, LightEntry, EnvironmentConfig } from '@/lib/db';

type ReorderItem = { id: string; groupId: string | null };

/**
 * Kinds that can be selected in the editor. `keyframe` never originates from
 * the outliner — it travels the same channel so only one gizmo is ever active.
 */
export type OutlinerSelectionKind = 'model' | 'light' | 'environment' | 'world' | 'keyframe';

const ENVIRONMENT_SELECTION_ID = '__environment__';
export const WORLD_SELECTION_ID = '__world__';

const lightIcon = {
  ambient: Globe,
  directional: Sun,
  point: Lightbulb,
  spot: Flashlight,
} as const;

type SceneOutlinerProps = {
  models: ModelEntry[];
  groups: SceneGroup[];
  lights: LightEntry[];
  environment: EnvironmentConfig | null;
  background: string;
  selectedId: string | null;
  selectedKind: OutlinerSelectionKind | null;
  visibilityMap: Record<string, boolean>;
  onSelect: (id: string | null, kind?: OutlinerSelectionKind) => void;
  onToggleVisibility: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  /** Swaps a model's file, keeping its name and transform. */
  onReplace: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleLightVisibility: (id: string) => void;
  onRenameLight: (id: string, name: string) => void;
  onDeleteLight: (id: string) => void;
  onRemoveEnvironment: () => void;
  onCreateGroup: () => void;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onToggleGroupCollapsed: (id: string) => void;
  onReorder: (items: ReorderItem[]) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
};

export function SceneOutliner({
  models,
  groups,
  lights,
  environment,
  background,
  selectedId,
  selectedKind,
  visibilityMap,
  onSelect,
  onToggleVisibility,
  onRename,
  onDuplicate,
  onReplace,
  onDelete,
  onToggleLightVisibility,
  onRenameLight,
  onDeleteLight,
  onRemoveEnvironment,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onToggleGroupCollapsed,
  onReorder,
  collapsed,
  onToggleCollapse,
}: SceneOutlinerProps) {
  const [renamingModelId, setRenamingModelId] = useState<string | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renamingLightId, setRenamingLightId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const sortedGroups = [...groups].sort((a, b) => a.order - b.order);
  const ungrouped = models.filter((m) => !m.groupId);

  const startRename = useCallback((id: string, currentName: string, kind: 'model' | 'group') => {
    setRenameValue(currentName);
    if (kind === 'model') {
      setRenamingModelId(id);
      setRenamingGroupId(null);
    } else {
      setRenamingGroupId(id);
      setRenamingModelId(null);
    }
  }, []);

  const commitModelRename = useCallback(
    (id: string) => {
      if (renameValue.trim()) onRename(id, renameValue.trim());
      setRenamingModelId(null);
    },
    [renameValue, onRename],
  );

  const commitGroupRename = useCallback(
    (id: string) => {
      if (renameValue.trim()) onRenameGroup(id, renameValue.trim());
      setRenamingGroupId(null);
    },
    [renameValue, onRenameGroup],
  );

  const commitLightRename = useCallback(
    (id: string) => {
      if (renameValue.trim()) onRenameLight(id, renameValue.trim());
      setRenamingLightId(null);
    },
    [renameValue, onRenameLight],
  );

  // Rebuilds the full ordered list after moving the dragged model into
  // `targetGroupId`, optionally placed directly before `beforeId`.
  const applyMove = useCallback(
    (targetGroupId: string | null, beforeId: string | null) => {
      if (!draggingId) return;
      const buckets = new Map<string | null, string[]>();
      sortedGroups.forEach((g) => buckets.set(g.id, []));
      buckets.set(null, []);
      for (const m of models) {
        const key = m.groupId && buckets.has(m.groupId) ? m.groupId : null;
        buckets.get(key)!.push(m.id);
      }
      for (const arr of buckets.values()) {
        const i = arr.indexOf(draggingId);
        if (i >= 0) arr.splice(i, 1);
      }
      const target = buckets.get(targetGroupId) ?? buckets.get(null)!;
      if (beforeId) {
        const i = target.indexOf(beforeId);
        target.splice(i < 0 ? target.length : i, 0, draggingId);
      } else {
        target.push(draggingId);
      }
      const flat: ReorderItem[] = [];
      for (const g of sortedGroups) {
        for (const id of buckets.get(g.id)!) flat.push({ id, groupId: g.id });
      }
      for (const id of buckets.get(null)!) flat.push({ id, groupId: null });
      onReorder(flat);
    },
    [draggingId, models, sortedGroups, onReorder],
  );

  const handleDrop = useCallback(
    (targetGroupId: string | null, beforeId: string | null) => {
      applyMove(targetGroupId, beforeId);
      setDraggingId(null);
      setDropTarget(null);
    },
    [applyMove],
  );

  const renderModelRow = (model: ModelEntry) => {
    const isVisible = visibilityMap[model.id] !== false;
    const isSelected = selectedId === model.id && selectedKind === 'model';
    const isRenaming = renamingModelId === model.id;
    const isDropBefore = dropTarget === `model:${model.id}`;

    return (
      <div
        key={model.id}
        draggable={!isRenaming}
        onDragStart={() => setDraggingId(model.id)}
        onDragEnd={() => {
          setDraggingId(null);
          setDropTarget(null);
        }}
        onDragOver={(e) => {
          if (!draggingId || draggingId === model.id) return;
          e.preventDefault();
          setDropTarget(`model:${model.id}`);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleDrop(model.groupId ?? null, model.id);
        }}
        className={`group flex items-center gap-1 rounded-md px-2 py-1 ${
          isDropBefore ? 'border-t-2 border-ring' : ''
        } ${
          isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
        } ${draggingId === model.id ? 'opacity-40' : ''}`}
        onClick={() => onSelect(model.id, 'model')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(model.id, 'model')}
      >
        <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-100" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onToggleVisibility(model.id);
              }}
              type="button"
              aria-label={isVisible ? 'Ausblenden' : 'Einblenden'}
            >
              {isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 opacity-50" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{isVisible ? 'Ausblenden' : 'Einblenden'}</TooltipContent>
        </Tooltip>

        {isRenaming ? (
          <Input
            className="h-6 flex-1 px-1 text-xs"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => commitModelRename(model.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitModelRename(model.id);
              if (e.key === 'Escape') setRenamingModelId(null);
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className={`flex-1 truncate text-xs ${!isVisible ? 'opacity-50' : ''}`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename(model.id, model.name, 'model');
            }}
          >
            {model.name}
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="shrink-0 opacity-0 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
              type="button"
              aria-label="Modell-Optionen"
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={() => startRename(model.id, model.name, 'model')}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Umbenennen
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDuplicate(model.id)}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              Duplizieren
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onReplace(model.id)}>
              <Replace className="mr-2 h-3.5 w-3.5" />
              Austauschen
            </DropdownMenuItem>
            {model.groupId && (
              <DropdownMenuItem
                onClick={() => onReorder(moveOutOfGroup(models, sortedGroups, model.id))}
              >
                <FolderMinus className="mr-2 h-3.5 w-3.5" />
                Aus Gruppe entfernen
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-400 focus:text-red-400" onClick={() => onDelete(model.id)}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Löschen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const renderLightRow = (light: LightEntry) => {
    const isVisible = light.visible !== false;
    const isSelected = selectedId === light.id && selectedKind === 'light';
    const isRenaming = renamingLightId === light.id;
    const Icon = lightIcon[light.type];

    return (
      <div
        key={light.id}
        className={`group flex items-center gap-1 rounded-md px-2 py-1 ${
          isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
        }`}
        onClick={() => onSelect(light.id, 'light')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(light.id, 'light')}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onToggleLightVisibility(light.id);
              }}
              type="button"
              aria-label={isVisible ? 'Ausblenden' : 'Einblenden'}
            >
              {isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 opacity-50" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{isVisible ? 'Ausblenden' : 'Einblenden'}</TooltipContent>
        </Tooltip>

        {isRenaming ? (
          <Input
            className="h-6 flex-1 px-1 text-xs"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => commitLightRename(light.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLightRename(light.id);
              if (e.key === 'Escape') setRenamingLightId(null);
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className={`flex-1 truncate text-xs ${!isVisible ? 'opacity-50' : ''}`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenameValue(light.name);
              setRenamingLightId(light.id);
            }}
          >
            {light.name}
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="shrink-0 opacity-0 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
              type="button"
              aria-label="Licht-Optionen"
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              onClick={() => {
                setRenameValue(light.name);
                setRenamingLightId(light.id);
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Umbenennen
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-400 focus:text-red-400" onClick={() => onDeleteLight(light.id)}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Löschen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const renderWorldRow = () => {
    const isSelected = selectedKind === 'world';
    return (
      <div
        className={`group flex items-center gap-1 rounded-md px-2 py-1 ${
          isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
        }`}
        onClick={() => onSelect(WORLD_SELECTION_ID, 'world')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(WORLD_SELECTION_ID, 'world')}
      >
        <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-xs">Hintergrund</span>
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border"
          style={{ backgroundColor: background }}
          aria-hidden
        />
      </div>
    );
  };

  const renderEnvironmentRow = () => {
    if (!environment) return null;
    const isSelected = selectedKind === 'environment';
    return (
      <div
        className={`group flex items-center gap-1 rounded-md px-2 py-1 ${
          isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
        }`}
        onClick={() => onSelect(ENVIRONMENT_SELECTION_ID, 'environment')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(ENVIRONMENT_SELECTION_ID, 'environment')}
      >
        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-xs">{environment.fileName}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="shrink-0 opacity-0 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
              type="button"
              aria-label="Umgebungs-Optionen"
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem className="text-red-400 focus:text-red-400" onClick={() => onRemoveEnvironment()}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Entfernen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const sectionLabel = (text: string) => (
    <p className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
      {text}
    </p>
  );

  if (collapsed) {
    return (
      <div className="absolute left-0 top-[49px] z-10">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="m-2 size-8"
              onClick={onToggleCollapse}
              aria-label="Scene Outliner öffnen"
            >
              <Layers className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Scene Outliner</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="absolute left-0 top-[49px] z-10 flex h-[calc(100%-49px)] w-[260px] flex-col border-r bg-background/95 backdrop-blur-sm">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Scene</span>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6" onClick={onCreateGroup} aria-label="Neue Gruppe">
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Neue Gruppe</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6" onClick={onToggleCollapse} aria-label="Scene Outliner schließen">
                <ChevronRight className="h-3 w-3 rotate-180" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Einklappen</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="p-1">
          {sectionLabel('Welt')}
          {renderWorldRow()}

          {environment && (
            <>
              {sectionLabel('Umgebung')}
              {renderEnvironmentRow()}
            </>
          )}

          {lights.length > 0 && (
            <>
              {sectionLabel('Licht')}
              {[...lights].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(renderLightRow)}
            </>
          )}

          {sectionLabel('Modelle')}

          {models.length === 0 && groups.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">Noch keine Modelle vorhanden</p>
          ) : (
            <>
              {sortedGroups.map((group) => {
                const members = models.filter((m) => m.groupId === group.id);
                const isGroupDrop = dropTarget === `group:${group.id}`;
                return (
                  <Collapsible
                    key={group.id}
                    open={!group.collapsed}
                    onOpenChange={() => onToggleGroupCollapsed(group.id)}
                  >
                    <div
                      className={`group/g flex items-center gap-1 rounded-md px-1 py-1 hover:bg-accent/40 ${
                        isGroupDrop ? 'ring-1 ring-ring' : ''
                      }`}
                      onDragOver={(e) => {
                        if (!draggingId) return;
                        e.preventDefault();
                        setDropTarget(`group:${group.id}`);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDrop(group.id, null);
                      }}
                    >
                      <CollapsibleTrigger asChild>
                        <button className="shrink-0 text-muted-foreground hover:text-foreground" type="button" aria-label="Gruppe auf/zuklappen">
                          {group.collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </button>
                      </CollapsibleTrigger>

                      {renamingGroupId === group.id ? (
                        <Input
                          className="h-6 flex-1 px-1 text-xs"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => commitGroupRename(group.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitGroupRename(group.id);
                            if (e.key === 'Escape') setRenamingGroupId(null);
                            e.stopPropagation();
                          }}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="flex-1 truncate text-xs font-medium"
                          onDoubleClick={() => startRename(group.id, group.name, 'group')}
                        >
                          {group.name}
                        </span>
                      )}

                      <span className="shrink-0 text-[10px] text-muted-foreground">{members.length}</span>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="shrink-0 opacity-0 group-hover/g:opacity-100"
                            type="button"
                            aria-label="Gruppen-Optionen"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => startRename(group.id, group.name, 'group')}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Umbenennen
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-red-400 focus:text-red-400" onClick={() => onDeleteGroup(group.id)}>
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            Gruppe auflösen
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <CollapsibleContent>
                      <div className="ml-3 border-l border-border/60 pl-1">
                        {members.length === 0 ? (
                          <p className="px-2 py-1 text-[11px] text-muted-foreground/70">Leer – Modelle hierher ziehen</p>
                        ) : (
                          members.map(renderModelRow)
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}

              {sortedGroups.length > 0 && ungrouped.length > 0 && <Separator className="my-1" />}

              <div
                onDragOver={(e) => {
                  if (!draggingId) return;
                  e.preventDefault();
                  setDropTarget('ungrouped');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(null, null);
                }}
                className={`min-h-[8px] rounded-md ${dropTarget === 'ungrouped' ? 'ring-1 ring-ring' : ''}`}
              >
                {ungrouped.map(renderModelRow)}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// Produces the full ordered list with `modelId` detached from its group and
// appended to the ungrouped section.
function moveOutOfGroup(
  models: ModelEntry[],
  sortedGroups: SceneGroup[],
  modelId: string,
): ReorderItem[] {
  const flat: ReorderItem[] = [];
  for (const g of sortedGroups) {
    for (const m of models) {
      if (m.groupId === g.id && m.id !== modelId) flat.push({ id: m.id, groupId: g.id });
    }
  }
  for (const m of models) {
    if (!m.groupId && m.id !== modelId) flat.push({ id: m.id, groupId: null });
  }
  flat.push({ id: modelId, groupId: null });
  return flat;
}
