import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { WebGPURenderer } from 'three/webgpu';
import {
  syncLights,
  applyEnvironment,
  EMPTY_ENVIRONMENT,
  type LightRecord,
  type EnvironmentState,
  type EnvironmentOptions,
} from './lighting';
import {
  createKeyframeMarkerState,
  syncKeyframeMarkers,
  disposeKeyframeMarkers,
  findKeyframeMarker,
  type KeyframeMarkerState,
  type KeyframeMarkerOptions,
} from './keyframe-markers';
import type { Keyframe } from './camera-path';
import { disposeObject3D } from './dispose';
import { syncPlanes, type PlaneRecord } from './planes';
import { fitShadowCameras, setMeshShadows, visibleBounds } from './shadows';
import { createModelLoader, createRenderer, disposeRenderer, prepareModel } from './renderer';
import type { LightEntry, PlaneEntry } from '@/lib/db';

export type SelectionKind = 'model' | 'light' | 'plane' | 'keyframe';

export type ViewportContext = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: WebGPURenderer;
  /** Created by the viewport inside the host element, and removed with it. */
  canvas: HTMLCanvasElement;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  models: Map<string, THREE.Group>;
  lights: Map<string, LightRecord>;
  planes: Map<string, PlaneRecord>;
  keyframeMarkers: KeyframeMarkerState;
  environmentState: EnvironmentState;
  selectedModelId: string | null;
  selectedId: string | null;
  selectedKind: SelectionKind | null;
  /** Stops or restarts the render loop, e.g. while a dialog covers the view. */
  setPaused: (paused: boolean) => void;
  dispose: () => void;
};

export type TransformMode = 'translate' | 'rotate' | 'scale';

/**
 * Editor furniture lives on its own camera layers, so hiding it from the view
 * never touches `visible`. That flag already means "hidden by the user" for a
 * light, and its helper follows it.
 */
const LAYER_GRID = 1;
const LAYER_LIGHT_HELPERS = 2;
const LAYER_PLANE_OUTLINES = 3;

export type ViewportOverlays = { grid: boolean; lightHelpers: boolean; planeOutlines: boolean };

/**
 * The one format we accept. GLB is a single binary container that carries its
 * textures inside the file, and it is the only format the planned compression
 * step can even express: Draco geometry and KTX2/Basis textures are both glTF
 * extensions. Keeping the editor, the preview, the exported widget and that
 * pipeline on one format means one code path and one thing to test.
 */
export const IMPORT_EXTENSIONS = ['.glb'] as const;
export const IMPORT_ACCEPT = IMPORT_EXTENSIONS.join(',');

export function isSupportedModelFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return (IMPORT_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Builds the editor viewport inside `host`, on a canvas of its own.
 *
 * The canvas is created here rather than handed in because a renderer cannot
 * share one with its successor: on the WebGL fallback `dispose()` loses the
 * canvas's context for good, so a remount (StrictMode, a project reload) on
 * the same element would render into a dead context.
 */
export async function createViewport(
  host: HTMLElement,
  background: string,
  transparent: boolean,
): Promise<ViewportContext> {
  const canvas = document.createElement('canvas');
  canvas.className = 'block h-full w-full';
  host.appendChild(canvas);

  let renderer: WebGPURenderer;
  try {
    renderer = await createRenderer({ canvas, alpha: transparent, pixelRatio: Math.min(window.devicePixelRatio, 2) });
  } catch (err) {
    canvas.remove();
    throw err;
  }

  const scene = new THREE.Scene();

  if (transparent) {
    scene.background = null;
  } else {
    scene.background = new THREE.Color(background);
  }

  const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
  camera.position.set(3, 2, 5);

  // updateStyle=false: the canvas is sized by CSS (`h-full w-full`). Letting
  // three write inline width/height would pin it to its start size, and since
  // the ResizeObserver below watches the canvas itself, it would then never see
  // the container change again. The viewport could never follow the window.
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
  gridHelper.layers.set(LAYER_GRID);
  scene.add(gridHelper);
  camera.layers.enable(LAYER_GRID);
  camera.layers.enable(LAYER_LIGHT_HELPERS);
  camera.layers.enable(LAYER_PLANE_OUTLINES);

  const orbitControls = new OrbitControls(camera, canvas);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.08;

  const transformControls = new TransformControls(camera, canvas);
  transformControls.addEventListener('dragging-changed', (event) => {
    orbitControls.enabled = !event.value;
  });
  scene.add(transformControls.getHelper());

  const models = new Map<string, THREE.Group>();
  const lights = new Map<string, LightRecord>();
  const planes = new Map<string, PlaneRecord>();
  const keyframeMarkers = createKeyframeMarkerState();
  let disposed = false;

  function animate() {
    orbitControls.update();
    // Refit every frame: models and planes move, load, hide and disappear
    // from many places in the editor, and the bounds are cached per geometry,
    // so this costs a handful of box transforms instead of a hook at each site.
    fitShadowCameras(
      Array.from(lights.values(), (record) => record.light),
      visibleBounds(models.values()),
      visibleBounds(Array.from(planes.values(), (record) => record.mesh)),
    );
    renderer.render(scene, camera);
  }
  void renderer.setAnimationLoop(animate);

  function handleResize() {
    if (disposed) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }
  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(canvas);

  return {
    scene,
    camera,
    renderer,
    canvas,
    orbitControls,
    transformControls,
    models,
    lights,
    planes,
    keyframeMarkers,
    environmentState: EMPTY_ENVIRONMENT,
    selectedModelId: null,
    selectedId: null,
    selectedKind: null,
    setPaused(paused) {
      if (disposed) return;
      void renderer.setAnimationLoop(paused ? null : animate);
    },
    dispose() {
      disposed = true;
      disposeKeyframeMarkers(scene, keyframeMarkers);
      for (const model of models.values()) disposeObject3D(model);
      models.clear();
      syncLights(scene, [], lights, { helpers: true });
      syncPlanes(scene, [], planes, { helpers: true });
      void renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      transformControls.dispose();
      orbitControls.dispose();
      void disposeRenderer(renderer).finally(() => canvas.remove());
    },
  };
}

/** Reconciles the editor scene lights with the given entries (with helpers). */
export function applyViewportLights(ctx: ViewportContext, entries: LightEntry[]) {
  syncLights(ctx.scene, entries, ctx.lights, { helpers: true });
  // Layers are not inherited, and the directional and spot helpers draw
  // through children, so every part of a helper has to move.
  for (const record of ctx.lights.values()) {
    record.helper?.traverse((part) => part.layers.set(LAYER_LIGHT_HELPERS));
  }
}

/** Shows or hides the grid, light helpers and plane outlines in the editor view. */
export function setViewportOverlays(ctx: ViewportContext, overlays: ViewportOverlays) {
  if (overlays.grid) ctx.camera.layers.enable(LAYER_GRID);
  else ctx.camera.layers.disable(LAYER_GRID);
  if (overlays.lightHelpers) ctx.camera.layers.enable(LAYER_LIGHT_HELPERS);
  else ctx.camera.layers.disable(LAYER_LIGHT_HELPERS);
  if (overlays.planeOutlines) ctx.camera.layers.enable(LAYER_PLANE_OUTLINES);
  else ctx.camera.layers.disable(LAYER_PLANE_OUTLINES);
}

/** Reconciles the editor ground planes with the given entries (with outlines). */
export function applyViewportPlanes(ctx: ViewportContext, entries: PlaneEntry[]) {
  syncPlanes(ctx.scene, entries, ctx.planes, { helpers: true });
  for (const record of ctx.planes.values()) record.helper?.layers.set(LAYER_PLANE_OUTLINES);
}

/** Height of the lowest visible model point, where a new plane belongs. */
export function modelsFloor(ctx: ViewportContext): number {
  const box = visibleBounds(ctx.models.values());
  return box.isEmpty() ? 0 : box.min.y;
}

/** Reconciles the camera-path markers and spline with the given keyframes. */
export function applyKeyframeMarkers(
  ctx: ViewportContext,
  keyframes: Keyframe[],
  options: KeyframeMarkerOptions,
) {
  syncKeyframeMarkers(ctx.scene, ctx.keyframeMarkers, keyframes, options);
}

/** Applies (or clears) the equirect environment for the editor viewport. */
export function setViewportEnvironment(
  ctx: ViewportContext,
  texture: THREE.Texture | null,
  options: EnvironmentOptions,
) {
  ctx.environmentState = applyEnvironment(ctx.scene, texture, options, ctx.environmentState);
}

/**
 * Encodes the thumbnail canvas, preferring WebP.
 *
 * At the same visual quality WebP is roughly half the bytes of JPEG, which is
 * what pays for the larger capture below. `toDataURL` does not throw for a type
 * it cannot encode. It silently returns a PNG, and a PNG of a rendered scene
 * is several times either. So the result is checked rather than assumed.
 */
function encodeThumbnail(canvas: HTMLCanvasElement): string {
  const webp = canvas.toDataURL('image/webp', 0.82);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.8);
}

/**
 * Renders one fresh frame and returns a downscaled data URL for use as a
 * project card thumbnail. The read must happen synchronously right after
 * `render()` because the WebGL drawing buffer is not preserved between frames.
 *
 * 640×360 rather than the card's ~320 CSS pixels wide: the dashboard is looked
 * at on whatever display the user has, and a 1× source on a 2× screen was the
 * mush this used to be. The thumbnail lives in IndexedDB as a base64 data URL
 * inside the project record, so its bytes are paid for per project forever, and
 * WebP is what keeps that affordable at twice the resolution.
 */
export function captureThumbnail(ctx: ViewportContext, width = 640, height = 360): string {
  const source = ctx.renderer.domElement;
  // A collapsed container (a hidden panel, a zero-height layout) leaves the
  // canvas at 0x0, and `drawImage` throws InvalidStateError on a zero-size
  // source. That used to take the whole debounced autosave down with it and
  // silently lose every edit, so bail out and keep the previous thumbnail.
  if (!source.width || !source.height) return '';

  // The card should show the scene, not the workshop around it. Grid, gizmo,
  // light helpers, path markers and the spline are editor furniture and have
  // no business on the dashboard, so everything that is neither a model nor a
  // light is hidden for this one frame. Stated that way round, a helper added
  // later stays out by default instead of by being remembered here.
  const keep = new Set<THREE.Object3D>(ctx.models.values());
  for (const record of ctx.lights.values()) {
    keep.add(record.light);
    // Directional and spot lights aim at a target object that lives in the
    // scene. It draws nothing, but it is not furniture either.
    const target = (record.light as THREE.SpotLight).target as THREE.Object3D | undefined;
    if (target) keep.add(target);
  }
  for (const record of ctx.planes.values()) keep.add(record.mesh);
  const furniture = ctx.scene.children.filter((child) => child.visible && !keep.has(child));
  // A plane's outline is a child of the plane, so it survives the filter above.
  for (const record of ctx.planes.values()) {
    if (record.helper?.visible) furniture.push(record.helper);
  }
  for (const child of furniture) child.visible = false;

  try {
    return renderThumbnail(ctx, source, width, height);
  } finally {
    for (const child of furniture) child.visible = true;
  }
}

/** The capture itself, once the scene has been stripped to model and light. */
function renderThumbnail(
  ctx: ViewportContext,
  source: HTMLCanvasElement,
  width: number,
  height: number,
): string {
  ctx.renderer.render(ctx.scene, ctx.camera);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c2d = canvas.getContext('2d');
  if (!c2d) return '';
  // The viewport canvas is usually far larger than the thumbnail, so this is a
  // heavy downscale. The cheap filter leaves visible aliasing on thin edges.
  c2d.imageSmoothingQuality = 'high';
  // Flatten onto a solid backdrop so transparent scenes don't become pure black.
  c2d.fillStyle = '#0f0f11';
  c2d.fillRect(0, 0, width, height);
  // Centre-crop rather than squash. The viewport is whatever shape the panel
  // layout leaves it, rarely 16:9, and scaling that straight into the
  // thumbnail box stretched every model on the dashboard.
  const scale = Math.max(width / source.width, height / source.height);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  c2d.drawImage(
    source,
    (source.width - cropWidth) / 2,
    (source.height - cropHeight) / 2,
    cropWidth,
    cropHeight,
    0,
    0,
    width,
    height,
  );
  return encodeThumbnail(canvas);
}

export async function loadModelFromBuffer(
  ctx: ViewportContext,
  id: string,
  buffer: ArrayBuffer,
  fileName: string,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): Promise<THREE.Group> {
  if (!isSupportedModelFile(fileName)) {
    throw new Error(`Unsupported format: ${fileName}`);
  }

  const { loader, dispose } = await createModelLoader(ctx.renderer);
  let object: THREE.Object3D;
  try {
    const gltf = await loader.parseAsync(buffer, '');
    object = gltf.scene;
  } finally {
    dispose();
  }

  setMeshShadows(object);
  prepareModel(ctx.renderer, object);
  const wrapper = new THREE.Group();
  wrapper.add(object);
  wrapper.name = id;

  const box = new THREE.Box3().setFromObject(wrapper);
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);

  wrapper.position.set(...position);
  wrapper.rotation.set(...rotation);
  wrapper.scale.set(...scale);

  ctx.scene.add(wrapper);
  ctx.models.set(id, wrapper);

  return wrapper;
}

/** Unified selection for models, lights and planes; attaches the transform gizmo. */
export function selectObject(ctx: ViewportContext, id: string | null, kind: SelectionKind | null) {
  ctx.selectedId = id;
  ctx.selectedKind = id ? kind : null;
  ctx.selectedModelId = kind === 'model' ? id : null;

  if (!id || !kind) {
    ctx.transformControls.detach();
    return;
  }

  if (kind === 'model') {
    const model = ctx.models.get(id);
    if (model) ctx.transformControls.attach(model);
    return;
  }

  if (kind === 'plane') {
    const plane = ctx.planes.get(id);
    if (plane) ctx.transformControls.attach(plane.mesh);
    else ctx.transformControls.detach();
    return;
  }

  if (kind === 'keyframe') {
    const marker = findKeyframeMarker(ctx.keyframeMarkers, id);
    if (marker) {
      // A path point is a plain point in space: translation only.
      ctx.transformControls.setMode('translate');
      ctx.transformControls.attach(marker);
    } else {
      ctx.transformControls.detach();
    }
    return;
  }

  const record = ctx.lights.get(id);
  if (record && !(record.light instanceof THREE.AmbientLight)) {
    // Lights only support translation; direction derives from position -> target.
    ctx.transformControls.setMode('translate');
    ctx.transformControls.attach(record.light);
  } else {
    ctx.transformControls.detach();
  }
}

export function selectModel(ctx: ViewportContext, id: string | null) {
  selectObject(ctx, id, id ? 'model' : null);
}

/** Returns false when the mode is rejected for the current selection. */
export function setTransformMode(ctx: ViewportContext, mode: TransformMode): boolean {
  // Lights and keyframe markers are translate-only; ignore rotate/scale there.
  const fullTransform = ctx.selectedKind === 'model' || ctx.selectedKind === 'plane';
  if (ctx.selectedKind !== null && !fullTransform && mode !== 'translate') return false;
  ctx.transformControls.setMode(mode);
  return true;
}

export function removeModel(ctx: ViewportContext, id: string) {
  const model = ctx.models.get(id);
  if (model) {
    ctx.transformControls.detach();
    ctx.scene.remove(model);
    disposeObject3D(model);
    ctx.models.delete(id);
  }
}

export function updateBackground(ctx: ViewportContext, color: string, transparent: boolean) {
  if (transparent) {
    ctx.scene.background = null;
    ctx.renderer.setClearColor(0x000000, 0);
  } else {
    ctx.scene.background = new THREE.Color(color);
  }
}
