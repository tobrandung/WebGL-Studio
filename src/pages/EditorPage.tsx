import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as THREE from 'three';
import {
  getDB,
  generateId,
  sweepOrphanBlobs,
  environmentFormat,
  type Project,
  type ModelEntry,
  type SceneGroup,
  type LightEntry,
  type LightType,
  type EnvironmentConfig,
  type SaveStatus,
  type PlaybackMode,
} from '@/lib/db';
import { formatBytes } from '@/lib/utils';
import { loadBlob } from '@/lib/storage/blob-cache';
import { isHostingConfigured } from '@/lib/storage/config';
import { ApiError } from '@/lib/storage/api';
import { pushProject, fetchRemoteProject, toDocument } from '@/lib/sync/projects';
import { useModels } from '@/hooks/useModels';
import { useHistory, stateCommand, type Command } from '@/hooks/useHistory';
import {
  createViewport,
  loadModelFromBuffer,
  selectObject,
  setTransformMode,
  removeModel,
  applyViewportLights,
  applyKeyframeMarkers,
  setViewportEnvironment,
  updateBackground,
  captureThumbnail,
  type ViewportContext,
  type TransformMode,
} from '@/three/viewport';
import { pickableKeyframeMarkers, findKeyframeMarker } from '@/three/keyframe-markers';
import { createDefaultLights, createLightEntry, loadEquirectTexture } from '@/three/lighting';
import { EditorToolbar } from '@/components/EditorToolbar';
import { ModelUploadDialog } from '@/components/ModelUploadDialog';
import { OptimizeDialog } from '@/components/model/OptimizeDialog';
import {
  EnvironmentUploadDialog,
  type EnvironmentUploadResult,
} from '@/components/EnvironmentUploadDialog';
import {
  PropertiesPanel,
  type KeyframeSelection,
  type ModelSelection,
  type ModelTransformKey,
} from '@/components/PropertiesPanel';
import { KeyframeEditor, type CameraPathImport } from '@/components/KeyframeEditor';
import { ExportDialog } from '@/components/ExportDialog';
import { SceneOutliner, type OutlinerSelectionKind } from '@/components/SceneOutliner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { GLASS_SURFACE } from '@/components/ui/glass-dialog';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  formatKeyframeRef,
  parseKeyframeRef,
  type Keyframe,
  type KeyframePart,
} from '@/three/camera-path';

type Transform = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

/** Snapshot taken when a gizmo drag starts, committed to history when it ends. */
type DragSnapshot =
  | { kind: 'model'; id: string; transform: Transform }
  | { kind: 'light'; lights: LightEntry[] }
  | { kind: 'keyframe'; keyframes: Keyframe[] };

type CameraPathSnapshot = { keyframes: Keyframe[]; isLoop: boolean; speed: number };

type OutlinerSnapshot = {
  groups: SceneGroup[];
  placement: { id: string; order: number; groupId: string | null }[];
};

const TRANSFORM_LABEL: Record<TransformMode, string> = {
  translate: 'Verschieben',
  rotate: 'Rotieren',
  scale: 'Skalieren',
};

/** Which tool a panel-edited transform channel belongs to, for undo labels. */
const TRANSFORM_MODE_FOR_CHANNEL: Record<ModelTransformKey, TransformMode> = {
  position: 'translate',
  rotation: 'rotate',
  scale: 'scale',
};

/** Clicks landing this soon after a gizmo drag are the drag's own mouse-up. */
const CLICK_AFTER_DRAG_MS = 200;

/** Pointer travel (px) up to which a press/release still counts as a click. */
const CLICK_SLOP_PX = 4;

function readTransform(object: THREE.Object3D): Transform {
  return {
    position: [object.position.x, object.position.y, object.position.z],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: [object.scale.x, object.scale.y, object.scale.z],
  };
}

function writeTransform(object: THREE.Object3D | undefined, transform: Transform) {
  if (!object) return;
  object.position.set(...transform.position);
  object.rotation.set(...transform.rotation);
  object.scale.set(...transform.scale);
}

function sameTransform(a: Transform, b: Transform): boolean {
  return (['position', 'rotation', 'scale'] as const).every((key) =>
    a[key].every((value, index) => value === b[key][index]),
  );
}

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<ViewportContext | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [transformModeState, setTransformModeState] = useState<TransformMode>('translate');
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  /** Model whose file the upload dialog is about to swap out. */
  const [replaceModelId, setReplaceModelId] = useState<string | null>(null);
  const [optimizeModelId, setOptimizeModelId] = useState<string | null>(null);
  const [optimizeSource, setOptimizeSource] = useState<ArrayBuffer | null>(null);
  /** Set while a freshly picked file is being optimized before it is stored. */
  const [optimizeFileName, setOptimizeFileName] = useState<string | null>(null);
  const [showEnvDialog, setShowEnvDialog] = useState(false);
  const [showKeyframeEditor, setShowKeyframeEditor] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<OutlinerSelectionKind | null>(null);
  // Live transform of the selected model, mirrored out of its THREE object so
  // the numeric fields track gizmo drags. Model transforms live in the scene
  // graph (not in React state), hence the mirror rather than a lookup.
  const [modelTransform, setModelTransform] = useState<Transform | null>(null);
  // Kept here rather than in the panel so the choice survives reselecting a
  // model (the panel unmounts whenever the selection clears).
  const [scaleLocked, setScaleLocked] = useState(true);
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [isLoop, setIsLoop] = useState(true);
  const [cameraSpeed, setCameraSpeed] = useState(1);
  // Im Export-Dialog gewählt, hier nur mitgeführt, damit das nächste
  // Speichern die Wahl nicht wieder aus cameraPath kippt.
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('scroll');
  const [showSpline, setShowSpline] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  /**
   * ETag of the last version this editor pushed, held in a ref rather than on
   * `project` for the same reason the thumbnail is: the viewport-init effect
   * keys on the project reference, so writing sync bookkeeping into state would
   * rebuild the scene on every autosave.
   */
  const remoteEtagRef = useRef<string | undefined>(undefined);
  const [outlinerCollapsed, setOutlinerCollapsed] = useState(false);
  const [visibilityMap, setVisibilityMap] = useState<Record<string, boolean>>({});
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [conflictAuthor, setConflictAuthor] = useState<string | null>(null);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [groups, setGroups] = useState<SceneGroup[]>([]);
  const [lights, setLights] = useState<LightEntry[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentConfig | null>(null);
  const [background, setBackground] = useState('#1a1a1a');
  // The live viewport instance kept in state (not just the ref) so that effects
  // which populate it (models, lights, environment) re-run and target the exact
  // instance — critical under React StrictMode's mount/cleanup/mount cycle where
  // two viewports are briefly created on the same canvas.
  const [viewport, setViewport] = useState<ViewportContext | null>(null);

  const clipboardRef = useRef<{ model: ModelEntry; blobId: string } | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always points at the latest performSave so the debounced auto-save doesn't
  // fire a stale closure (captured while `project` was still null → early return).
  const performSaveRef = useRef<(() => void) | null>(null);
  const selectionRef = useRef<{ id: string | null; kind: OutlinerSelectionKind | null }>({ id: null, kind: null });

  const history = useHistory();
  const {
    models,
    addModel,
    updateModel,
    deleteModel,
    restoreModel,
    getModelBlob,
    reorderModels,
  } = useModels(id ?? '');

  // Mirrors of the editable state, so history commands and the viewport event
  // listeners (which are set up once per viewport) always read current values
  // without re-subscribing or capturing stale closures.
  const keyframesRef = useRef(keyframes);
  const lightsRef = useRef(lights);
  const groupsRef = useRef(groups);
  const modelsRef = useRef(models);
  const environmentRef = useRef(environment);
  const backgroundRef = useRef(background);
  const transparentRef = useRef(false);
  useEffect(() => { keyframesRef.current = keyframes; }, [keyframes]);
  useEffect(() => { lightsRef.current = lights; }, [lights]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { modelsRef.current = models; }, [models]);
  useEffect(() => { environmentRef.current = environment; }, [environment]);
  useEffect(() => { backgroundRef.current = background; }, [background]);
  useEffect(() => { transparentRef.current = project?.settings.transparent ?? false; }, [project]);

  const dragSnapshotRef = useRef<DragSnapshot | null>(null);
  const lastDragEndRef = useRef(0);
  /** Where the current press started, to tell a pick from a camera orbit. */
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const commitDragRef = useRef<((snapshot: DragSnapshot, mode: TransformMode) => void) | null>(null);

  // Load project
  useEffect(() => {
    if (!id) { navigate('/'); return; }
    history.clear();
    (async () => {
      const db = await getDB();
      const p = await db.get('projects', id);
      if (!p) { navigate('/'); return; }
      setProject(p);
      remoteEtagRef.current = p.remote?.etag;
      // Older projects stored keyframes without an id. Assign one so every
      // keyframe is individually addressable; persisted lazily on first edit.
      setKeyframes(p.cameraPath.keyframes.map((kf) => ({ ...kf, id: kf.id ?? generateId() })));
      setIsLoop(p.cameraPath.isLoop);
      setCameraSpeed(p.cameraPath.speed);
      setPlaybackMode(p.cameraPath.playbackMode ?? 'scroll');
      setGroups(p.groups ?? []);
      // Seed default lights into state only (persisted lazily on first edit)
      // so untouched legacy projects are not marked dirty.
      setLights(p.lights && p.lights.length ? p.lights : createDefaultLights());
      setEnvironment(p.environment ?? null);
      setBackground(p.settings.background);
      // Deletions keep their blob around so undo can restore them; collect the
      // ones no longer reachable from any project.
      await sweepOrphanBlobs().catch(() => {});
    })();
  }, [id, navigate, history.clear]);

  /**
   * Reads the model's transform back out of the scene graph. Falls back to the
   * persisted record while a freshly added model's async load is still running —
   * `loadModelFromBuffer` seeds the group from exactly those values, so the
   * fields never show anything the scene disagrees with.
   */
  const syncModelTransform = useCallback((modelId: string) => {
    const group = viewportRef.current?.models.get(modelId);
    if (group) {
      setModelTransform(readTransform(group));
      return;
    }
    const entry = modelsRef.current.find((m) => m.id === modelId);
    setModelTransform(
      entry ? { position: entry.position, rotation: entry.rotation, scale: entry.scale } : null,
    );
  }, []);

  /**
   * Writes a transform into the live group (re-resolved by id, because undoing
   * past a delete/restore hands back a different group object) and refreshes the
   * mirrored values when that model is the selected one.
   */
  const applyModelTransform = useCallback((modelId: string, transform: Transform) => {
    writeTransform(viewportRef.current?.models.get(modelId), transform);
    if (selectionRef.current.kind === 'model' && selectionRef.current.id === modelId) {
      setModelTransform(transform);
    }
  }, []);

  // Init viewport
  useEffect(() => {
    if (!canvasRef.current || !project) return;
    const ctx = createViewport(canvasRef.current, project.settings.background, project.settings.transparent);
    viewportRef.current = ctx;
    setViewport(ctx);

    ctx.transformControls.addEventListener('objectChange', () => {
      // Read a dragged light's or keyframe marker's position back out of the
      // THREE object into state so panels and persistence stay in sync.
      const sel = selectionRef.current;
      if (sel.kind === 'model' && sel.id) {
        // Models keep their transform in the scene graph; mirror it so the
        // numeric fields move along with the gizmo.
        syncModelTransform(sel.id);
      } else if (sel.kind === 'light' && sel.id) {
        const record = ctx.lights.get(sel.id);
        if (record) {
          const p = record.light.position;
          setLights((prev) =>
            prev.map((l) => (l.id === sel.id ? { ...l, position: [p.x, p.y, p.z] } : l)),
          );
        }
      } else if (sel.kind === 'keyframe' && sel.id) {
        const parsed = parseKeyframeRef(sel.id);
        const marker = parsed ? findKeyframeMarker(ctx.keyframeMarkers, sel.id) : null;
        if (parsed && marker) {
          const p = marker.position;
          setKeyframes((prev) =>
            prev.map((kf) =>
              kf.id === parsed.id ? { ...kf, [parsed.part]: [p.x, p.y, p.z] as [number, number, number] } : kf,
            ),
          );
        }
      }
      markDirty();
    });

    // Bracket each gizmo drag with a before/after snapshot so a transform is a
    // single undo step — without this the drag only marked the project dirty
    // and undo fell through to whatever command came before it.
    ctx.transformControls.addEventListener('dragging-changed', (event) => {
      const sel = selectionRef.current;
      if (event.value) {
        if (sel.kind === 'model' && sel.id) {
          const group = ctx.models.get(sel.id);
          dragSnapshotRef.current = group
            ? { kind: 'model', id: sel.id, transform: readTransform(group) }
            : null;
        } else if (sel.kind === 'light') {
          dragSnapshotRef.current = { kind: 'light', lights: lightsRef.current };
        } else if (sel.kind === 'keyframe') {
          dragSnapshotRef.current = { kind: 'keyframe', keyframes: keyframesRef.current };
        } else {
          dragSnapshotRef.current = null;
        }
        return;
      }

      lastDragEndRef.current = performance.now();
      const snapshot = dragSnapshotRef.current;
      dragSnapshotRef.current = null;
      if (snapshot) commitDragRef.current?.(snapshot, ctx.transformControls.mode as TransformMode);
    });

    return () => {
      ctx.dispose();
      if (viewportRef.current === ctx) viewportRef.current = null;
      setViewport((current) => (current === ctx ? null : current));
    };
  }, [project]);

  // Sync lights into the viewport whenever the light config or instance changes.
  useEffect(() => {
    if (!viewport) return;
    applyViewportLights(viewport, lights);
  }, [lights, viewport]);

  // Camera-path markers and spline. Owned here (not by the keyframe panel) so
  // the meshes are reconciled in place and the gizmo keeps its target; the path
  // is only pickable while the camera-path editor is open.
  useEffect(() => {
    if (!viewport) return;
    applyKeyframeMarkers(viewport, keyframes, {
      showMarkers: showKeyframeEditor && showMarkers,
      showSpline: showKeyframeEditor && showSpline,
      isLoop,
      selectedRef: selectedKind === 'keyframe' ? selectedId : null,
    });
  }, [viewport, keyframes, isLoop, showKeyframeEditor, showMarkers, showSpline, selectedId, selectedKind]);

  // Re-attach the gizmo once a freshly created marker mesh exists (selecting a
  // just-added keyframe runs before the sync effect has built its marker).
  useEffect(() => {
    if (!viewport || selectedKind !== 'keyframe' || !selectedId) return;
    const marker = findKeyframeMarker(viewport.keyframeMarkers, selectedId);
    // Skip while it is already attached — re-attaching on every drag frame
    // would be pure churn.
    if (!marker || viewport.transformControls.object === marker) return;
    selectObject(viewport, selectedId, 'keyframe');
  }, [viewport, selectedId, selectedKind, keyframes]);

  // Seed the numeric transform fields for the selected model. Keyed on `models`
  // as well so a model that was just added (its record appears before its mesh
  // finishes loading) picks up the group once it exists.
  useEffect(() => {
    if (selectedKind !== 'model' || !selectedId) {
      setModelTransform(null);
      return;
    }
    syncModelTransform(selectedId);
  }, [selectedKind, selectedId, models, viewport, syncModelTransform]);

  // Apply the solid background colour. A visible environment dome owns
  // `scene.background`, so skip while one is shown (the environment effect below
  // restores the solid colour when the dome is turned off).
  useEffect(() => {
    if (!viewport || environment?.showBackground) return;
    updateBackground(viewport, background, transparentRef.current);
  }, [background, viewport, environment?.showBackground]);

  // Load + apply the environment texture. Deliberately keyed on the image
  // identity and the two structural toggles rather than on `environment` as a
  // whole: `handleUpdateEnvironment` produces a new object per patch, so
  // depending on it re-read the blob from IndexedDB and re-ran PMREM on every
  // slider tick — 100-400 ms each with a 4K HDRI. Intensity and blurriness are
  // pure scene scalars and are handled by the effect below instead.
  useEffect(() => {
    const ctx = viewport;
    if (!ctx) return;
    let cancelled = false;

    const transparent = transparentRef.current;

    (async () => {
      const config = environmentRef.current;
      if (!config) {
        setViewportEnvironment(ctx, null, { showBackground: false, useForReflection: false, intensity: 1 });
        updateBackground(ctx, backgroundRef.current, transparent);
        return;
      }
      const data = await loadBlob(config.blobId, config.assetKey);
      if (!data || cancelled) return;
      const texture = await loadEquirectTexture(
        new Blob([data]),
        config.fileName,
        environmentFormat(config),
      );
      if (cancelled) {
        texture.dispose();
        return;
      }
      setViewportEnvironment(ctx, texture, {
        showBackground: config.showBackground,
        useForReflection: config.useForReflection,
        intensity: config.intensity,
        blurriness: config.blurriness,
      });
      // The dome owns scene.background only while shown; otherwise restore the
      // solid colour the environment application may have cleared.
      if (!config.showBackground) {
        updateBackground(ctx, backgroundRef.current, transparent);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    viewport,
    environment?.blobId,
    environment?.format,
    environment?.showBackground,
    environment?.useForReflection,
  ]);

  // Intensity and blurriness are plain scene scalars, so a drag on either
  // slider must not trigger the decode + PMREM above.
  useEffect(() => {
    if (!viewport || !environment) return;
    const { scene } = viewport;
    if (environment.useForReflection) scene.environmentIntensity = environment.intensity;
    if (environment.showBackground) {
      scene.backgroundIntensity = environment.intensity;
      scene.backgroundBlurriness = environment.blurriness ?? 0;
    }
  }, [viewport, environment]);

  // Load models into the viewport. Keyed on the `viewport` instance so models
  // fetched from IndexedDB before the viewport exists (or after it is recreated)
  // are loaded into the *live* instance — otherwise reopening a project, or the
  // StrictMode remount, leaves the async load targeting a discarded viewport and
  // the scene appears empty. The cleanup cancels an in-flight load on swap.
  useEffect(() => {
    if (!viewport || !models.length) return;
    let cancelled = false;
    (async () => {
      for (const model of models) {
        if (cancelled) return;
        if (viewport.models.has(model.id)) continue;
        const buffer = await getModelBlob(model.id);
        if (cancelled) return;
        if (!buffer) continue;
        await loadModelFromBuffer(
          viewport,
          model.id,
          buffer,
          model.fileName,
          model.position,
          model.rotation,
          model.scale,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewport, models, getModelBlob]);

  // Auto-save
  const markDirty = useCallback(() => {
    setIsDirty(true);
    setSaveStatus('dirty');
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      performSaveRef.current?.();
    }, 3000);
  }, []);

  // ---------------------------------------------------------------------------
  // History plumbing
  // ---------------------------------------------------------------------------

  /** Runs a command and records it. */
  const runCommand = useCallback(
    (command: Command) => {
      history.execute(command);
      markDirty();
    },
    [history, markDirty],
  );

  /** Records a command whose effect already happened. */
  const pushCommand = useCallback(
    (command: Command) => {
      history.push(command);
      markDirty();
    },
    [history, markDirty],
  );

  const handleUndo = useCallback(() => {
    history.undo();
    markDirty();
  }, [history, markDirty]);

  const handleRedo = useCallback(() => {
    history.redo();
    markDirty();
  }, [history, markDirty]);

  const applyCameraPath = useCallback((snapshot: CameraPathSnapshot) => {
    setKeyframes(snapshot.keyframes);
    setIsLoop(snapshot.isLoop);
    setCameraSpeed(snapshot.speed);
  }, []);

  const captureCameraPath = useCallback(
    (): CameraPathSnapshot => ({
      keyframes: keyframesRef.current,
      isLoop: isLoop,
      speed: cameraSpeed,
    }),
    [isLoop, cameraSpeed],
  );

  /** Undoable replacement of the keyframe list. */
  const commitKeyframes = useCallback(
    (type: string, label: string, next: Keyframe[], mergeKey?: string) => {
      runCommand(
        stateCommand({
          type,
          label,
          before: keyframesRef.current,
          after: next,
          apply: setKeyframes,
          mergeKey,
        }),
      );
    },
    [runCommand],
  );

  /** Undoable replacement of the light list. */
  const commitLights = useCallback(
    (type: string, label: string, next: LightEntry[], mergeKey?: string) => {
      runCommand(
        stateCommand({
          type,
          label,
          before: lightsRef.current,
          after: next,
          apply: setLights,
          mergeKey,
        }),
      );
    },
    [runCommand],
  );

  const applyOutliner = useCallback(
    (snapshot: OutlinerSnapshot) => {
      setGroups(snapshot.groups);
      void reorderModels(snapshot.placement);
    },
    [reorderModels],
  );

  const captureOutliner = useCallback(
    (): OutlinerSnapshot => ({
      groups: groupsRef.current,
      placement: modelsRef.current.map((m, index) => ({
        id: m.id,
        order: m.order ?? index,
        groupId: m.groupId ?? null,
      })),
    }),
    [],
  );

  /** The model record plus its live viewport transform (which may be newer). */
  const captureModelEntry = useCallback((modelId: string): ModelEntry | null => {
    const base = modelsRef.current.find((m) => m.id === modelId);
    if (!base) return null;
    const group = viewportRef.current?.models.get(modelId);
    if (!group) return base;
    const transform = readTransform(group);
    return { ...base, ...transform };
  }, []);

  const applySelection = useCallback((nextId: string | null, kind: OutlinerSelectionKind | null) => {
    const ctx = viewportRef.current;
    selectionRef.current = { id: nextId, kind };
    setSelectedId(nextId);
    setSelectedKind(kind);
    // Lights and path markers are translate-only, and `selectObject` forces the
    // gizmo accordingly — mirror that in the toolbar so the button (and the
    // properties panel, which follows the mode) cannot claim rotate/scale.
    if (kind === 'light' || kind === 'keyframe') setTransformModeState('translate');
    if (!ctx) return;
    if (kind === 'model' || kind === 'light' || kind === 'keyframe') {
      selectObject(ctx, nextId, kind);
    } else {
      // environment, world or cleared selection: no gizmo
      selectObject(ctx, null, null);
    }
  }, []);

  /** Adds a model to history so undo removes it and redo brings it back. */
  const makeModelAddCommand = useCallback(
    (entry: ModelEntry, label: string): Command => {
      let snapshot = entry;
      return {
        type: 'model:add',
        label,
        execute: () => {
          void restoreModel(snapshot);
        },
        undo: () => {
          // Re-capture first: name, group and transform may have changed since
          // the model was added, and a redo should bring back the latest state.
          snapshot = captureModelEntry(snapshot.id) ?? snapshot;
          const ctx = viewportRef.current;
          if (ctx) removeModel(ctx, snapshot.id);
          void deleteModel(snapshot.id);
          if (selectionRef.current.id === snapshot.id) applySelection(null, null);
        },
      };
    },
    [restoreModel, deleteModel, captureModelEntry, applySelection],
  );

  const deleteModelWithHistory = useCallback(
    (modelId: string) => {
      const snapshot = captureModelEntry(modelId);
      if (!snapshot) return;
      runCommand({
        type: 'model:delete',
        label: `"${snapshot.name}" löschen`,
        execute: () => {
          const ctx = viewportRef.current;
          if (ctx) removeModel(ctx, snapshot.id);
          void deleteModel(snapshot.id);
          if (selectionRef.current.id === snapshot.id) applySelection(null, null);
        },
        undo: () => {
          void restoreModel(snapshot);
        },
      });
    },
    [captureModelEntry, runCommand, deleteModel, restoreModel, applySelection],
  );

  const commitDrag = useCallback(
    (snapshot: DragSnapshot, mode: TransformMode) => {
      if (snapshot.kind === 'model') {
        const group = viewportRef.current?.models.get(snapshot.id);
        if (!group) return;
        const after = readTransform(group);
        if (sameTransform(snapshot.transform, after)) return;
        const before = snapshot.transform;
        const modelId = snapshot.id;
        const name = modelsRef.current.find((m) => m.id === modelId)?.name;
        pushCommand({
          type: `transform:model:${mode}`,
          label: name ? `${TRANSFORM_LABEL[mode]}: "${name}"` : TRANSFORM_LABEL[mode],
          execute: () => applyModelTransform(modelId, after),
          undo: () => applyModelTransform(modelId, before),
        });
        return;
      }

      if (snapshot.kind === 'light') {
        // The objectChange handler only replaces the array when a value moved,
        // so identity is a reliable "nothing changed" test.
        if (lightsRef.current === snapshot.lights) return;
        pushCommand(
          stateCommand({
            type: 'transform:light',
            label: 'Licht verschieben',
            before: snapshot.lights,
            after: lightsRef.current,
            apply: setLights,
          }),
        );
        return;
      }

      if (keyframesRef.current === snapshot.keyframes) return;
      pushCommand(
        stateCommand({
          type: 'transform:keyframe',
          label: 'Keyframe verschieben',
          before: snapshot.keyframes,
          after: keyframesRef.current,
          apply: setKeyframes,
        }),
      );
    },
    [pushCommand, applyModelTransform],
  );

  /** Commits one edited transform channel from the properties panel. */
  const handleUpdateModelTransform = useCallback(
    (key: ModelTransformKey, value: [number, number, number]) => {
      const { id: modelId, kind } = selectionRef.current;
      if (!modelId || kind !== 'model') return;
      const group = viewportRef.current?.models.get(modelId);
      if (!group) return;

      const before = readTransform(group);
      const after: Transform = { ...before, [key]: value };
      if (sameTransform(before, after)) return;

      const mode = TRANSFORM_MODE_FOR_CHANNEL[key];
      const name = modelsRef.current.find((m) => m.id === modelId)?.name;
      runCommand({
        type: `transform:model:${mode}`,
        label: name ? `${TRANSFORM_LABEL[mode]}: "${name}"` : TRANSFORM_LABEL[mode],
        execute: () => applyModelTransform(modelId, after),
        undo: () => applyModelTransform(modelId, before),
      });
    },
    [runCommand, applyModelTransform],
  );

  useEffect(() => {
    commitDragRef.current = commitDrag;
  }, [commitDrag]);

  const performSave = useCallback(async () => {
    if (!id || !project) return;
    setSaveStatus('saving');
    const db = await getDB();
    const ctx = viewportRef.current;

    // Save model transforms
    if (ctx) {
      for (const [modelId, group] of ctx.models.entries()) {
        await updateModel(modelId, {
          position: [group.position.x, group.position.y, group.position.z],
          rotation: [group.rotation.x, group.rotation.y, group.rotation.z],
          scale: [group.scale.x, group.scale.y, group.scale.z],
        });
      }
    }

    // Read back live light positions from the viewport before persisting.
    let lightsToSave = lights;
    if (ctx) {
      lightsToSave = lights.map((l) => {
        const record = ctx.lights.get(l.id);
        if (!record || record.light instanceof THREE.AmbientLight) return l;
        const p = record.light.position;
        return { ...l, position: [p.x, p.y, p.z] as [number, number, number] };
      });
    }

    // Capture a fresh viewport thumbnail (falls back to the existing one).
    // Not written back into `project` state to avoid re-triggering the
    // viewport-init effect (which keys on the `project` reference) on every save.
    // An empty capture means the viewport could not be read; keep the old one.
    const thumbnail = (ctx && captureThumbnail(ctx)) || project.thumbnail;

    // Save camera path + outliner groups + lights + environment
    const saved = {
      ...project,
      thumbnail,
      settings: { ...project.settings, background },
      cameraPath: { keyframes, isLoop, speed: cameraSpeed, playbackMode },
      groups,
      lights: lightsToSave,
      environment,
      updatedAt: Date.now(),
    };
    await db.put('projects', saved);
    setIsDirty(false);

    if (!isHostingConfigured()) {
      setSaveStatus('saved');
      return;
    }

    // Mirror into R2. The local write above has already happened, so a failure
    // here costs durability and hand-off, not the user's work — which is why it
    // downgrades the indicator instead of throwing.
    try {
      const modelRecords = await db.getAllFromIndex('models', 'by-project', id);
      const result = await pushProject(toDocument(saved, modelRecords), remoteEtagRef.current);
      remoteEtagRef.current = result.etag;
      // Written straight to the store, deliberately not through setProject.
      await db.put('projects', {
        ...saved,
        remote: { etag: result.etag, syncedAt: result.updatedAt, author: result.author },
      });
      setSaveStatus('saved');
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'conflict') {
        setSaveStatus('conflict');
        setConflictAuthor(err.message);
      } else {
        setSaveStatus('offline');
      }
    }
  }, [id, project, keyframes, isLoop, cameraSpeed, groups, lights, environment, background, updateModel]);

  /**
   * Resolves a save conflict, explicitly and in one direction or the other.
   *
   * There is no automatic merge to be had here — two people moved the same
   * camera — so the only honest options are to take theirs or keep yours, and
   * the user has to say which. Without this the editor would sit on "Konflikt"
   * forever: reloading re-reads IndexedDB, which is exactly the version that was
   * refused.
   */
  const resolveConflict = useCallback(
    async (keep: 'remote' | 'local') => {
      if (!id) return;
      setResolvingConflict(true);
      try {
        const { document, etag } = await fetchRemoteProject(id);
        remoteEtagRef.current = etag;

        if (keep === 'remote') {
          const db = await getDB();
          const existingModels = await db.getAllFromIndex('models', 'by-project', id);
          const incoming = new Set(document.models.map((m) => m.id));
          const tx = db.transaction(['projects', 'models'], 'readwrite');
          await tx.objectStore('projects').put({
            ...document.project,
            remote: { etag, syncedAt: Date.now(), author: '' },
          });
          // Models the other version dropped have to go, or the scene would show
          // a union of both edits — which is neither version.
          for (const model of existingModels) {
            if (!incoming.has(model.id)) await tx.objectStore('models').delete(model.id);
          }
          for (const model of document.models) await tx.objectStore('models').put(model);
          await tx.done;
          // Simplest correct way back to a consistent editor: reload the route.
          window.location.reload();
          return;
        }

        // Keep local: re-push against the version that is actually out there.
        setConflictAuthor(null);
        setSaveStatus('dirty');
        performSaveRef.current?.();
      } catch {
        setSaveStatus('offline');
        setConflictAuthor(null);
      } finally {
        setResolvingConflict(false);
      }
    },
    [id],
  );

  useEffect(() => {
    performSaveRef.current = performSave;
  }, [performSave]);

  // Handle back navigation
  const handleBack = useCallback(() => {
    if (isDirty) {
      setShowLeaveDialog(true);
    } else {
      navigate('/');
    }
  }, [isDirty, navigate]);

  const handleSaveAndLeave = useCallback(async () => {
    await performSave();
    setShowLeaveDialog(false);
    navigate('/');
  }, [performSave, navigate]);

  const handleDiscardAndLeave = useCallback(() => {
    setShowLeaveDialog(false);
    navigate('/');
  }, [navigate]);

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  const handleUpload = useCallback(
    async (file: File) => {
      const newModel = await addModel(file);
      // The record already exists, so only record it — executing again would
      // duplicate the write.
      pushCommand(makeModelAddCommand(newModel, `"${newModel.name}" hinzufügen`));
    },
    [addModel, makeModelAddCommand, pushCommand],
  );

  /**
   * Points a model at a different stored buffer: writes it into the model's own
   * blob slot (the loader addresses blobs by model id), rebuilds the mesh in
   * place and keeps the live transform. Used in both directions of a swap, so
   * an undo restores the previous file exactly the same way.
   *
   * The record is updated last: the model-loading effect keys on `models` and
   * skips ids already in the scene, so re-adding the mesh first keeps it from
   * loading a second copy.
   */
  const applyModelSource = useCallback(
    async (modelId: string, source: { blobId: string; fileName: string; fileSize: number }) => {
      const ctx = viewportRef.current;
      const db = await getDB();
      const stored = await db.get('blobs', source.blobId);
      if (!stored) return;
      await db.put('blobs', { id: modelId, data: stored.data });

      if (ctx) {
        const group = ctx.models.get(modelId);
        const transform = group ? readTransform(group) : null;
        removeModel(ctx, modelId);
        await loadModelFromBuffer(
          ctx,
          modelId,
          stored.data,
          source.fileName,
          transform?.position,
          transform?.rotation,
          transform?.scale,
        );
        if (selectionRef.current.kind === 'model' && selectionRef.current.id === modelId) {
          selectObject(ctx, modelId, 'model');
          syncModelTransform(modelId);
        }
      }

      await updateModel(modelId, { fileName: source.fileName, fileSize: source.fileSize });
    },
    [updateModel, syncModelTransform],
  );

  /**
   * Swaps the file behind a model — the same asset with textures, or a
   * compressed build — while its name, transform and outliner slot stay put.
   * Both buffers are parked under throwaway blob ids so undo/redo can move
   * either one back into place without carrying them in the history stack.
   */
  const handleReplaceModel = useCallback(
    async (file: File) => {
      const modelId = replaceModelId;
      setReplaceModelId(null);
      if (!modelId) return;

      const entry = modelsRef.current.find((m) => m.id === modelId);
      const db = await getDB();
      const current = await db.get('blobs', modelId);
      if (!entry || !current) return;

      const previousId = generateId();
      const nextId = generateId();
      await db.put('blobs', { id: previousId, data: current.data });
      await db.put('blobs', { id: nextId, data: await file.arrayBuffer() });

      const previous = {
        blobId: previousId,
        fileName: entry.fileName,
        fileSize: entry.fileSize,
      };
      const next = { blobId: nextId, fileName: file.name, fileSize: file.size };

      runCommand({
        type: 'model:replace',
        label: `"${entry.name}" austauschen`,
        execute: () => void applyModelSource(modelId, next),
        undo: () => void applyModelSource(modelId, previous),
      });
    },
    [replaceModelId, applyModelSource, runCommand],
  );

  /**
   * Opens the optimize dialog for a model, handing it a copy of the stored
   * GLB. A copy, because the worker takes ownership of whatever it is given —
   * transferring the cached blob would detach the buffer IndexedDB handed us.
   */
  const handleOpenOptimize = useCallback(async (modelId: string) => {
    const db = await getDB();
    const stored = await db.get('blobs', modelId);
    if (!stored) return;
    setOptimizeSource(stored.data.slice(0));
    setOptimizeModelId(modelId);
  }, []);

  /**
   * Optimizing a file on the way in, before it is ever stored. The upload
   * dialog cannot host this itself — its submit is fire-and-forget — so it
   * hands the file over and the optimize dialog finishes the import.
   */
  const handleOptimizeUpload = useCallback(async (file: File) => {
    setOptimizeFileName(file.name);
    setOptimizeSource(await file.arrayBuffer());
  }, []);

  /**
   * Writes the optimized GLB back. For a model already in the project this
   * goes through the same path as a file swap, so the transform survives and
   * undo restores the original byte for byte. For a fresh import it becomes
   * the file the model is created from.
   */
  const handleOptimizeConfirm = useCallback(
    async (buffer: ArrayBuffer) => {
      const modelId = optimizeModelId;
      const importName = optimizeFileName;
      setOptimizeModelId(null);
      setOptimizeSource(null);
      setOptimizeFileName(null);

      if (importName) {
        await handleUpload(new File([buffer], importName, { type: 'model/gltf-binary' }));
        return;
      }
      if (!modelId) return;

      const entry = modelsRef.current.find((m) => m.id === modelId);
      const db = await getDB();
      const current = await db.get('blobs', modelId);
      if (!entry || !current) return;

      // Replacing parks the original for undo, so it briefly holds the source
      // twice plus the result twice. Quota failures in IndexedDB surface as an
      // opaque abort mid-transaction, which would leave the model pointing at
      // nothing — better to say so before starting.
      const needed = current.data.byteLength * 2 + buffer.byteLength * 2;
      const quota = await navigator.storage?.estimate?.().catch(() => null);
      if (quota?.quota && quota.usage !== undefined && quota.quota - quota.usage < needed) {
        window.alert(
          `Zu wenig Speicher im Browser: benötigt werden etwa ${formatBytes(needed)}, ` +
            `frei sind ${formatBytes(quota.quota - quota.usage)}. ` +
            'Lösche ein Projekt oder gib Browser-Speicher frei.',
        );
        return;
      }

      const previousId = generateId();
      const nextId = generateId();
      await db.put('blobs', { id: previousId, data: current.data });
      await db.put('blobs', { id: nextId, data: buffer });

      const previous = { blobId: previousId, fileName: entry.fileName, fileSize: entry.fileSize };
      const next = { blobId: nextId, fileName: entry.fileName, fileSize: buffer.byteLength };

      runCommand({
        type: 'model:optimize',
        label: `"${entry.name}" optimieren`,
        execute: () => void applyModelSource(modelId, next),
        undo: () => void applyModelSource(modelId, previous),
      });
    },
    [optimizeModelId, optimizeFileName, handleUpload, applyModelSource, runCommand],
  );

  /**
   * Copies a model, offset so the duplicate is visible. The transform goes into
   * the record rather than the live group: the viewport loads models
   * asynchronously, so the group does not exist yet at this point.
   */
  const copyModel = useCallback(
    async (source: ModelEntry, label: string) => {
      const buffer = await getModelBlob(source.id);
      if (!buffer) return;
      const live = captureModelEntry(source.id) ?? source;
      const file = new File([buffer], source.fileName);
      const newModel = await addModel(file, `${source.name} (Kopie)`, {
        position: [live.position[0] + 0.5, live.position[1], live.position[2] + 0.5],
        rotation: live.rotation,
        scale: live.scale,
      });
      pushCommand(makeModelAddCommand(newModel, label));
    },
    [getModelBlob, captureModelEntry, addModel, makeModelAddCommand, pushCommand],
  );

  const pasteModel = useCallback(async () => {
    const clipboard = clipboardRef.current;
    if (!clipboard) return;
    await copyModel(clipboard.model, `"${clipboard.model.name}" einfügen`);
  }, [copyModel]);

  const duplicateSelected = useCallback(async () => {
    if (!selectedId || selectionRef.current.kind !== 'model') return;
    const model = models.find((m) => m.id === selectedId);
    if (!model) return;
    await copyModel(model, `"${model.name}" duplizieren`);
  }, [selectedId, models, copyModel]);

  const handleToggleVisibility = useCallback((modelId: string) => {
    const ctx = viewportRef.current;
    if (!ctx) return;
    const group = ctx.models.get(modelId);
    if (!group) return;
    const newVisible = !group.visible;
    group.visible = newVisible;
    setVisibilityMap((prev) => ({ ...prev, [modelId]: newVisible }));
  }, []);

  const handleOutlinerSelect = useCallback(
    (nextId: string | null, kind: OutlinerSelectionKind = 'model') => {
      applySelection(nextId, nextId ? kind : null);
    },
    [applySelection],
  );

  const handleOutlinerRename = useCallback(
    (modelId: string, name: string) => {
      const previous = modelsRef.current.find((m) => m.id === modelId)?.name;
      if (previous === undefined || previous === name) return;
      runCommand(
        stateCommand({
          type: 'model:rename',
          label: `"${name}" umbenennen`,
          before: previous,
          after: name,
          apply: (value) => void updateModel(modelId, { name: value }),
        }),
      );
    },
    [runCommand, updateModel],
  );

  const handleOutlinerDuplicate = useCallback(
    async (modelId: string) => {
      const model = models.find((m) => m.id === modelId);
      if (!model) return;
      await copyModel(model, `"${model.name}" duplizieren`);
    },
    [models, copyModel],
  );

  // ---------------------------------------------------------------------------
  // Outliner groups
  // ---------------------------------------------------------------------------

  const handleCreateGroup = useCallback(() => {
    const group: SceneGroup = {
      id: generateId(),
      name: 'Neue Gruppe',
      collapsed: false,
      order: groupsRef.current.length,
    };
    runCommand(
      stateCommand({
        type: 'group:create',
        label: 'Gruppe anlegen',
        before: groupsRef.current,
        after: [...groupsRef.current, group],
        apply: setGroups,
      }),
    );
  }, [runCommand]);

  const handleRenameGroup = useCallback(
    (groupId: string, name: string) => {
      const before = groupsRef.current;
      if (before.find((g) => g.id === groupId)?.name === name) return;
      runCommand(
        stateCommand({
          type: 'group:rename',
          label: `Gruppe "${name}" umbenennen`,
          before,
          after: before.map((g) => (g.id === groupId ? { ...g, name } : g)),
          apply: setGroups,
        }),
      );
    },
    [runCommand],
  );

  // Collapsing is a view preference, not an edit — kept out of the undo stack.
  const handleToggleGroupCollapsed = useCallback(
    (groupId: string) => {
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)));
      markDirty();
    },
    [markDirty],
  );

  const handleDeleteGroup = useCallback(
    (groupId: string) => {
      const before = captureOutliner();
      const remaining = before.groups.filter((g) => g.id !== groupId).sort((a, b) => a.order - b.order);
      const placement: OutlinerSnapshot['placement'] = [];
      for (const g of remaining) {
        for (const m of modelsRef.current.filter((m) => m.groupId === g.id)) {
          placement.push({ id: m.id, order: placement.length, groupId: g.id });
        }
      }
      for (const m of modelsRef.current.filter((m) => !m.groupId || m.groupId === groupId)) {
        placement.push({ id: m.id, order: placement.length, groupId: null });
      }
      runCommand(
        stateCommand({
          type: 'group:delete',
          label: 'Gruppe löschen',
          before,
          after: { groups: remaining.map((g, i) => ({ ...g, order: i })), placement },
          apply: applyOutliner,
        }),
      );
    },
    [captureOutliner, runCommand, applyOutliner],
  );

  const handleReorder = useCallback(
    (items: { id: string; groupId: string | null }[]) => {
      const before = captureOutliner();
      runCommand(
        stateCommand({
          type: 'model:reorder',
          label: 'Reihenfolge ändern',
          before,
          after: {
            groups: before.groups,
            placement: items.map((it, i) => ({ id: it.id, order: i, groupId: it.groupId })),
          },
          apply: applyOutliner,
        }),
      );
    },
    [captureOutliner, runCommand, applyOutliner],
  );

  // ---------------------------------------------------------------------------
  // Lights
  // ---------------------------------------------------------------------------

  const handleAddLight = useCallback(
    (type: LightType) => {
      const entry = createLightEntry(type, lightsRef.current.length);
      commitLights('light:add', `"${entry.name}" hinzufügen`, [...lightsRef.current, entry]);
      applySelection(entry.id, 'light');
    },
    [commitLights, applySelection],
  );

  const handleUpdateLight = useCallback(
    (lightId: string, patch: Partial<LightEntry>) => {
      commitLights(
        'light:update',
        'Lichteigenschaft ändern',
        lightsRef.current.map((l) => (l.id === lightId ? { ...l, ...patch } : l)),
        // Collapse a slider drag on one property into a single undo step.
        `light:${lightId}:${Object.keys(patch).sort().join(',')}`,
      );
    },
    [commitLights],
  );

  const handleDeleteLight = useCallback(
    (lightId: string) => {
      const name = lightsRef.current.find((l) => l.id === lightId)?.name ?? 'Licht';
      commitLights(
        'light:delete',
        `"${name}" löschen`,
        lightsRef.current.filter((l) => l.id !== lightId),
      );
      if (selectionRef.current.id === lightId) applySelection(null, null);
    },
    [commitLights, applySelection],
  );

  const handleToggleLightVisibility = useCallback(
    (lightId: string) => {
      commitLights(
        'light:visibility',
        'Licht ein-/ausblenden',
        lightsRef.current.map((l) => (l.id === lightId ? { ...l, visible: l.visible === false } : l)),
      );
    },
    [commitLights],
  );

  const handleRenameLight = useCallback(
    (lightId: string, name: string) => {
      if (lightsRef.current.find((l) => l.id === lightId)?.name === name) return;
      commitLights(
        'light:rename',
        `"${name}" umbenennen`,
        lightsRef.current.map((l) => (l.id === lightId ? { ...l, name } : l)),
      );
    },
    [commitLights],
  );

  // ---------------------------------------------------------------------------
  // Environment / world
  // ---------------------------------------------------------------------------

  const handleEnvironmentUpload = useCallback(
    async (result: EnvironmentUploadResult) => {
      if (!id) return;
      const db = await getDB();
      const blobId = generateId();
      const buffer = await result.file.arrayBuffer();
      await db.put('blobs', { id: blobId, data: buffer });
      // The previous blob stays put so undo can restore the old environment;
      // `sweepOrphanBlobs` collects it once it is unreachable.
      const before = environmentRef.current;
      runCommand(
        stateCommand({
          type: 'environment:set',
          label: result.presetId
            ? 'Standard-HDRI setzen'
            : before
              ? 'Umgebung ersetzen'
              : 'Umgebung setzen',
          before,
          after: {
            blobId,
            fileName: result.file.name,
            // Replacing the image must not throw away the dome, intensity and
            // blur the user set up — "Bild ersetzen" from the properties panel
            // runs through here too.
            showBackground: before?.showBackground ?? false,
            useForReflection: before?.useForReflection ?? true,
            intensity: before?.intensity ?? 1,
            blurriness: before?.blurriness ?? 0,
            format: result.format,
            fileSize: result.file.size,
            width: result.width || undefined,
            height: result.height || undefined,
            sourceFileName: result.sourceFileName,
            presetId: result.presetId,
          },
          apply: setEnvironment,
        }),
      );
      applySelection('__environment__', 'environment');
    },
    [id, runCommand, applySelection],
  );

  const handleUpdateEnvironment = useCallback(
    (patch: Partial<EnvironmentConfig>) => {
      const before = environmentRef.current;
      if (!before) return;
      runCommand(
        stateCommand({
          type: 'environment:update',
          label: 'Umgebung ändern',
          before,
          after: { ...before, ...patch },
          apply: setEnvironment,
          mergeKey: `environment:${Object.keys(patch).sort().join(',')}`,
        }),
      );
    },
    [runCommand],
  );

  /**
   * Switching the background source between the HDRI dome and a solid colour.
   * Same state as the environment panel's "Als Hintergrund zeigen" switch, but
   * it gets its own undo label because that is what the user just did.
   */
  const handleUseEnvironmentBackground = useCallback(
    (use: boolean) => {
      const before = environmentRef.current;
      if (!before || before.showBackground === use) return;
      runCommand(
        stateCommand({
          type: 'environment:update',
          label: use ? 'HDRI als Hintergrund' : 'HDRI-Hintergrund aus',
          before,
          after: { ...before, showBackground: use },
          apply: setEnvironment,
        }),
      );
    },
    [runCommand],
  );

  const handleRemoveEnvironment = useCallback(() => {
    const before = environmentRef.current;
    if (!before) return;
    runCommand(
      stateCommand({
        type: 'environment:remove',
        label: 'Umgebung entfernen',
        before,
        after: null,
        apply: setEnvironment,
      }),
    );
    if (selectionRef.current.kind === 'environment') applySelection(null, null);
  }, [runCommand, applySelection]);

  const handleUpdateBackground = useCallback(
    (color: string) => {
      if (backgroundRef.current === color) return;
      runCommand(
        stateCommand({
          type: 'world:background',
          label: 'Hintergrundfarbe ändern',
          before: backgroundRef.current,
          after: color,
          apply: setBackground,
          mergeKey: 'world:background',
        }),
      );
    },
    [runCommand],
  );

  // ---------------------------------------------------------------------------
  // Camera path
  // ---------------------------------------------------------------------------

  const selectedKeyframe = useMemo<KeyframeSelection | null>(() => {
    if (selectedKind !== 'keyframe') return null;
    const parsed = parseKeyframeRef(selectedId);
    if (!parsed) return null;
    const index = keyframes.findIndex((kf) => kf.id === parsed.id);
    if (index < 0) return null;
    return { keyframe: keyframes[index], index: index + 1, part: parsed.part };
  }, [selectedKind, selectedId, keyframes]);

  const selectedModel = useMemo<ModelSelection | null>(() => {
    if (selectedKind !== 'model' || !selectedId || !modelTransform) return null;
    const entry = models.find((m) => m.id === selectedId);
    if (!entry) return null;
    return { id: entry.id, name: entry.name, ...modelTransform };
  }, [selectedKind, selectedId, models, modelTransform]);

  const selectKeyframe = useCallback(
    (keyframeId: string | null, part: KeyframePart = 'position') => {
      if (!keyframeId) {
        applySelection(null, null);
        return;
      }
      applySelection(formatKeyframeRef(keyframeId, part), 'keyframe');
    },
    [applySelection],
  );

  /** Camera position and orbit target as a keyframe. */
  const readCameraPose = useCallback((): Pick<Keyframe, 'position' | 'lookAt'> | null => {
    const ctx = viewportRef.current;
    if (!ctx) return null;
    const pos = ctx.camera.position;
    const target = ctx.orbitControls.target;
    return {
      position: [pos.x, pos.y, pos.z],
      lookAt: [target.x, target.y, target.z],
    };
  }, []);

  const handleAddKeyframe = useCallback(() => {
    const pose = readCameraPose();
    if (!pose) return;
    const keyframe: Keyframe = { id: generateId(), ...pose };
    const current = keyframesRef.current;
    // Insert behind the selected keyframe, matching how DCC timelines behave.
    const selectedIndex = selectedKeyframe
      ? current.findIndex((kf) => kf.id === selectedKeyframe.keyframe.id)
      : -1;
    const at = selectedIndex >= 0 ? selectedIndex + 1 : current.length;
    const next = [...current.slice(0, at), keyframe, ...current.slice(at)];
    commitKeyframes('keyframe:add', `Keyframe ${at + 1} hinzufügen`, next);
    selectKeyframe(keyframe.id);
  }, [readCameraPose, selectedKeyframe, commitKeyframes, selectKeyframe]);

  const handleDuplicateKeyframe = useCallback(
    (keyframeId: string) => {
      const current = keyframesRef.current;
      const at = current.findIndex((kf) => kf.id === keyframeId);
      if (at < 0) return;
      const copy: Keyframe = { ...current[at], id: generateId() };
      const next = [...current.slice(0, at + 1), copy, ...current.slice(at + 1)];
      commitKeyframes('keyframe:duplicate', `Keyframe ${at + 1} duplizieren`, next);
      selectKeyframe(copy.id);
    },
    [commitKeyframes, selectKeyframe],
  );

  const handleUpdateKeyframe = useCallback(
    (keyframeId: string, patch: Partial<Omit<Keyframe, 'id'>>) => {
      const current = keyframesRef.current;
      const at = current.findIndex((kf) => kf.id === keyframeId);
      if (at < 0) return;
      commitKeyframes(
        'keyframe:update',
        `Keyframe ${at + 1} ändern`,
        current.map((kf) => (kf.id === keyframeId ? { ...kf, ...patch } : kf)),
        `keyframe:${keyframeId}:${Object.keys(patch).sort().join(',')}`,
      );
    },
    [commitKeyframes],
  );

  const handleCaptureKeyframeFromCamera = useCallback(
    (keyframeId: string) => {
      const pose = readCameraPose();
      if (!pose) return;
      const at = keyframesRef.current.findIndex((kf) => kf.id === keyframeId);
      if (at < 0) return;
      commitKeyframes(
        'keyframe:capture',
        `Keyframe ${at + 1} auf Ansicht setzen`,
        keyframesRef.current.map((kf) => (kf.id === keyframeId ? { ...kf, ...pose } : kf)),
      );
    },
    [readCameraPose, commitKeyframes],
  );

  const handleJumpToKeyframe = useCallback((keyframeId: string) => {
    const ctx = viewportRef.current;
    const keyframe = keyframesRef.current.find((kf) => kf.id === keyframeId);
    if (!ctx || !keyframe) return;
    ctx.camera.position.set(...keyframe.position);
    ctx.orbitControls.target.set(...keyframe.lookAt);
    ctx.orbitControls.update();
  }, []);

  const handleDeleteKeyframe = useCallback(
    (keyframeId: string) => {
      const at = keyframesRef.current.findIndex((kf) => kf.id === keyframeId);
      if (at < 0) return;
      commitKeyframes(
        'keyframe:delete',
        `Keyframe ${at + 1} löschen`,
        keyframesRef.current.filter((kf) => kf.id !== keyframeId),
      );
      if (parseKeyframeRef(selectionRef.current.id)?.id === keyframeId) applySelection(null, null);
    },
    [commitKeyframes, applySelection],
  );

  const handleReorderKeyframes = useCallback(
    (orderedIds: string[]) => {
      const byId = new Map(keyframesRef.current.map((kf) => [kf.id, kf]));
      const next = orderedIds.map((keyframeId) => byId.get(keyframeId)).filter((kf): kf is Keyframe => !!kf);
      if (next.length !== keyframesRef.current.length) return;
      commitKeyframes('keyframe:reorder', 'Keyframe-Reihenfolge ändern', next);
    },
    [commitKeyframes],
  );

  const handleLoopChange = useCallback(
    (nextLoop: boolean) => {
      runCommand(
        stateCommand({
          type: 'camerapath:loop',
          label: nextLoop ? 'Loop aktivieren' : 'Loop deaktivieren',
          before: isLoop,
          after: nextLoop,
          apply: setIsLoop,
        }),
      );
    },
    [runCommand, isLoop],
  );

  const handleSpeedChange = useCallback(
    (nextSpeed: number) => {
      if (nextSpeed === cameraSpeed) return;
      runCommand(
        stateCommand({
          type: 'camerapath:speed',
          label: 'Geschwindigkeit ändern',
          before: cameraSpeed,
          after: nextSpeed,
          apply: setCameraSpeed,
          mergeKey: 'camerapath:speed',
        }),
      );
    },
    [runCommand, cameraSpeed],
  );

  const handleImportPath = useCallback(
    (data: CameraPathImport) => {
      const before = captureCameraPath();
      runCommand(
        stateCommand({
          type: 'camerapath:import',
          label: 'Kamerafahrt importieren',
          before,
          after: {
            keyframes: Array.isArray(data.keyframes)
              ? data.keyframes.map((kf) => ({ id: generateId(), position: kf.position, lookAt: kf.lookAt }))
              : before.keyframes,
            isLoop: typeof data.isLoop === 'boolean' ? data.isLoop : before.isLoop,
            speed: typeof data.speed === 'number' ? data.speed : before.speed,
          },
          apply: applyCameraPath,
        }),
      );
      applySelection(null, null);
    },
    [captureCameraPath, runCommand, applyCameraPath, applySelection],
  );

  const handleToggleKeyframeEditor = useCallback(() => {
    // Path markers are only pickable while the editor is open, so drop a
    // keyframe selection on the way out rather than leaving an orphaned gizmo.
    if (showKeyframeEditor && selectionRef.current.kind === 'keyframe') applySelection(null, null);
    setShowKeyframeEditor(!showKeyframeEditor);
  }, [showKeyframeEditor, applySelection]);

  // ---------------------------------------------------------------------------
  // Viewport interaction
  // ---------------------------------------------------------------------------

  const handleTransformModeChange = useCallback((mode: TransformMode) => {
    const ctx = viewportRef.current;
    // Lights and keyframe markers reject rotate/scale — don't light up a
    // toolbar button that had no effect.
    if (ctx && !setTransformMode(ctx, mode)) return;
    setTransformModeState(mode);
  }, []);

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleModelClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const ctx = viewportRef.current;
    if (!ctx || !canvasRef.current) return;
    // Ignore the mouse-up that ends a gizmo drag; it would clear the selection.
    if (ctx.transformControls.dragging) return;
    if (performance.now() - lastDragEndRef.current < CLICK_AFTER_DRAG_MS) return;

    // An orbit ends in a click on the canvas too, and treating that as a pick
    // would drop the selection (and close the properties panel) every time the
    // user just turned the view. Anything that travelled further than the slop
    // was a camera drag, not a pick.
    const down = pointerDownRef.current;
    pointerDownRef.current = null;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, ctx.camera);

    // Path markers take precedence: they are small and sit in front of models.
    const markers = pickableKeyframeMarkers(ctx.keyframeMarkers);
    if (markers.length) {
      const markerHits = raycaster.intersectObjects(markers, false);
      if (markerHits.length > 0) {
        // Deckungsgleiche Marker sind hier der Normalfall, kein Sonderfall:
        // `readCameraPose` legt als Blickpunkt das Orbit-Ziel ab, also teilen
        // sich alle Keyframes einer Umrundung denselben Blickpunkt und ihre
        // grünen Marker liegen exakt übereinander. Einfach den nächstgelegenen
        // Treffer zu nehmen hieß bei identischem Abstand immer denselben — die
        // Sortierung ist stabil, also gewann stets der zuerst angelegte
        // Keyframe, und an die Blickpunkte aller anderen kam man im Viewport
        // nicht mehr heran.
        //
        // Deshalb entscheidet bei einem solchen Stapel der Keyframe, an dem
        // gerade gearbeitet wird. Reihum durchklicken geht nicht: sobald die
        // Gizmo am Klickpunkt hängt, verwirft der Drag-Schutz weiter oben jeden
        // weiteren Klick an derselben Stelle.
        const nearest = markerHits[0].distance;
        const tied = markerHits.filter((hit) => hit.distance - nearest < 1e-4);
        const activeId = parseKeyframeRef(selectionRef.current.id)?.id ?? null;
        const preferred = tied.find((hit) => parseKeyframeRef(hit.object.name)?.id === activeId);
        applySelection((preferred ?? markerHits[0]).object.name, 'keyframe');
        return;
      }
    }

    const objects = Array.from(ctx.models.values());
    const intersects = raycaster.intersectObjects(objects, true);

    if (intersects.length > 0) {
      let obj: THREE.Object3D = intersects[0].object;
      while (obj.parent && !ctx.models.has(obj.name)) {
        obj = obj.parent;
      }
      if (ctx.models.has(obj.name)) {
        applySelection(obj.name, 'model');
        return;
      }
    }
    applySelection(null, null);
  }, [applySelection]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const ctx = viewportRef.current;
      if (!ctx) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const isMeta = e.metaKey || e.ctrlKey;

      // Undo/Redo
      if (isMeta && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }
      if (isMeta && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Copy
      if (isMeta && e.key === 'c') {
        if (selectedId && selectionRef.current.kind === 'model') {
          const model = models.find((m) => m.id === selectedId);
          if (model) {
            clipboardRef.current = { model, blobId: model.id };
          }
        }
        return;
      }

      // Paste
      if (isMeta && e.key === 'v') {
        e.preventDefault();
        void pasteModel();
        return;
      }

      // Duplicate
      if (isMeta && e.key === 'd') {
        e.preventDefault();
        void duplicateSelected();
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'g':
          handleTransformModeChange('translate');
          break;
        case 'r':
          handleTransformModeChange('rotate');
          break;
        case 's':
          if (!isMeta) handleTransformModeChange('scale');
          break;
        case 'delete':
        case 'backspace': {
          const sel = selectionRef.current;
          if (sel.kind === 'light' && sel.id) {
            handleDeleteLight(sel.id);
          } else if (sel.kind === 'keyframe' && sel.id) {
            const parsed = parseKeyframeRef(sel.id);
            if (parsed) handleDeleteKeyframe(parsed.id);
          } else if (sel.kind === 'model' && sel.id) {
            deleteModelWithHistory(sel.id);
          }
          break;
        }
        // Nur in der Kamerafahrt: sonst würde ein E beim Modellieren
        // unbemerkt Keyframes in eine Fahrt legen, die gar nicht sichtbar ist.
        case 'e':
          if (!isMeta && showKeyframeEditor) {
            e.preventDefault();
            handleAddKeyframe();
          }
          break;
        case 'escape':
          applySelection(null, null);
          break;
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedId,
    models,
    handleUndo,
    handleRedo,
    pasteModel,
    duplicateSelected,
    handleTransformModeChange,
    handleDeleteLight,
    handleDeleteKeyframe,
    deleteModelWithHistory,
    applySelection,
    showKeyframeEditor,
    handleAddKeyframe,
  ]);

  if (!project) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Laden…</div>
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <EditorToolbar
        transformMode={transformModeState}
        onTransformModeChange={handleTransformModeChange}
        onAddModel={() => setShowUploadDialog(true)}
        onAddLight={handleAddLight}
        onAddEnvironment={() => setShowEnvDialog(true)}
        onOpenKeyframeEditor={handleToggleKeyframeEditor}
        onExport={async () => {
          await performSave();
          setShowExportDialog(true);
        }}
        onBack={handleBack}
        onUndo={handleUndo}
        onRedo={handleRedo}
        history={history}
        projectName={project.name}
        saveStatus={saveStatus}
        onResolveConflict={() => setConflictAuthor((prev) => prev ?? 'Dieses Projekt wurde zwischenzeitlich woanders gespeichert.')}
        hasKeyframes={keyframes.length > 0}
      />
      <SceneOutliner
        models={models}
        groups={groups}
        lights={lights}
        environment={environment}
        background={background}
        selectedId={selectedId}
        selectedKind={selectedKind}
        visibilityMap={visibilityMap}
        onSelect={handleOutlinerSelect}
        onToggleVisibility={handleToggleVisibility}
        onRename={handleOutlinerRename}
        onDuplicate={handleOutlinerDuplicate}
        onReplace={setReplaceModelId}
        onOptimize={(id) => void handleOpenOptimize(id)}
        onDelete={deleteModelWithHistory}
        onToggleLightVisibility={handleToggleLightVisibility}
        onRenameLight={handleRenameLight}
        onDeleteLight={handleDeleteLight}
        onRemoveEnvironment={handleRemoveEnvironment}
        onCreateGroup={handleCreateGroup}
        onRenameGroup={handleRenameGroup}
        onDeleteGroup={handleDeleteGroup}
        onToggleGroupCollapsed={handleToggleGroupCollapsed}
        onReorder={handleReorder}
        collapsed={outlinerCollapsed}
        onToggleCollapse={() => setOutlinerCollapsed(!outlinerCollapsed)}
      />
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        onPointerDown={handleCanvasPointerDown}
        onClick={handleModelClick}
      />
      {(selectedKind === 'world' ||
        (selectedKind === 'light' && selectedId) ||
        (selectedKind === 'environment' && environment) ||
        selectedModel ||
        selectedKeyframe) && (
        <PropertiesPanel
          model={selectedModel}
          transformMode={transformModeState}
          scaleLocked={scaleLocked}
          onScaleLockChange={setScaleLocked}
          light={selectedKind === 'light' ? lights.find((l) => l.id === selectedId) ?? null : null}
          environment={selectedKind === 'environment' ? environment : null}
          background={selectedKind === 'world' ? background : null}
          sceneEnvironment={environment}
          onUseEnvironmentBackground={handleUseEnvironmentBackground}
          keyframe={selectedKeyframe}
          onUpdateModelTransform={handleUpdateModelTransform}
          onUpdateLight={handleUpdateLight}
          onUpdateEnvironment={handleUpdateEnvironment}
          onReplaceEnvironment={() => setShowEnvDialog(true)}
          onUpdateBackground={handleUpdateBackground}
          onUpdateKeyframe={handleUpdateKeyframe}
          onSelectKeyframePart={selectKeyframe}
          onCaptureKeyframeFromCamera={handleCaptureKeyframeFromCamera}
          onJumpToKeyframe={handleJumpToKeyframe}
          onDuplicateKeyframe={handleDuplicateKeyframe}
          onDeleteKeyframe={handleDeleteKeyframe}
        />
      )}
      {showKeyframeEditor && (
        <KeyframeEditor
          viewportCtx={viewport}
          keyframes={keyframes}
          isLoop={isLoop}
          speed={cameraSpeed}
          selectedKeyframeId={selectedKeyframe?.keyframe.id ?? null}
          showSpline={showSpline}
          showMarkers={showMarkers}
          onToggleSpline={setShowSpline}
          onToggleMarkers={setShowMarkers}
          onSelectKeyframe={(keyframeId) => selectKeyframe(keyframeId)}
          onAddKeyframe={handleAddKeyframe}
          onJumpToKeyframe={handleJumpToKeyframe}
          onDeleteKeyframe={handleDeleteKeyframe}
          onReorderKeyframes={handleReorderKeyframes}
          onLoopChange={handleLoopChange}
          onSpeedChange={handleSpeedChange}
          onImportPath={handleImportPath}
        />
      )}
      <ModelUploadDialog
        open={showUploadDialog}
        onOpenChange={setShowUploadDialog}
        onUpload={handleUpload}
        onOptimize={(file) => void handleOptimizeUpload(file)}
      />
      <ModelUploadDialog
        open={replaceModelId !== null}
        onOpenChange={(open) => {
          if (!open) setReplaceModelId(null);
        }}
        onUpload={handleReplaceModel}
        replacing={models.find((m) => m.id === replaceModelId)?.name ?? null}
      />
      <OptimizeDialog
        open={optimizeSource !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOptimizeModelId(null);
            setOptimizeSource(null);
            setOptimizeFileName(null);
          }
        }}
        modelName={
          optimizeFileName ?? models.find((m) => m.id === optimizeModelId)?.name ?? ''
        }
        importing={optimizeFileName !== null}
        source={optimizeSource}
        onConfirm={(buffer) => void handleOptimizeConfirm(buffer)}
      />
      <EnvironmentUploadDialog
        open={showEnvDialog}
        onOpenChange={setShowEnvDialog}
        onUpload={handleEnvironmentUpload}
        current={environment}
      />
      <ExportDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        project={{
          ...project,
          // Live-Weltfarbe mitgeben – sonst landet die zuletzt gespeicherte Farbe im Embed.
          settings: { ...project.settings, background },
          cameraPath: { keyframes, isLoop, speed: cameraSpeed, playbackMode },
          lights,
          environment,
        }}
        onPlaybackModeChange={setPlaybackMode}
      />

      <AlertDialog open={conflictAuthor !== null} onOpenChange={(next) => !next && setConflictAuthor(null)}>
        <AlertDialogContent className={GLASS_SURFACE}>
          {/* Das X ist "später entscheiden": Schließen lässt den Konflikt offen
              und die lokalen Änderungen unangetastet. Als Icon oben rechts
              statt als dritter Button, damit die Zeile nur die beiden echten
              Entscheidungen trägt. */}
          <AlertDialogCancel
            variant="ghost"
            size="icon-sm"
            disabled={resolvingConflict}
            aria-label="Später entscheiden"
            title="Später entscheiden"
            className="absolute top-4 right-4 opacity-70 hover:opacity-100"
          >
            <XIcon className="size-4" />
          </AlertDialogCancel>
          <AlertDialogHeader>
            <AlertDialogTitle>Speicher-Konflikt</AlertDialogTitle>
            <AlertDialogDescription>
              {conflictAuthor} Deine Änderungen sind weiterhin lokal vorhanden – du musst nur
              entscheiden, welche Fassung gilt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={resolvingConflict}
              onClick={() => resolveConflict('remote')}
            >
              Fremde Version laden
            </Button>
            <AlertDialogAction disabled={resolvingConflict} onClick={() => resolveConflict('local')}>
              Meine Version durchsetzen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        {/* Same surface as every Dialog — AlertDialog is a separate Radix
            primitive, so it takes the class rather than the shell. */}
        <AlertDialogContent className={GLASS_SURFACE}>
          <AlertDialogHeader>
            <AlertDialogTitle>Ungespeicherte Änderungen</AlertDialogTitle>
            <AlertDialogDescription>
              Du hast ungespeicherte Änderungen. Möchtest du speichern bevor du gehst?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDiscardAndLeave}>
              Verwerfen
            </Button>
            <AlertDialogAction onClick={handleSaveAndLeave}>
              Speichern & Verlassen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default EditorPage;
