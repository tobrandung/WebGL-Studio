import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
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
import type { LightEntry } from '@/lib/db';

export type SelectionKind = 'model' | 'light' | 'keyframe';

export type ViewportContext = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  models: Map<string, THREE.Group>;
  lights: Map<string, LightRecord>;
  keyframeMarkers: KeyframeMarkerState;
  environmentState: EnvironmentState;
  selectedModelId: string | null;
  selectedId: string | null;
  selectedKind: SelectionKind | null;
  dispose: () => void;
};

export type TransformMode = 'translate' | 'rotate' | 'scale';

/**
 * Formats accepted on import. Deliberately limited to the two containers that
 * can carry their textures inside the file: .glb (always) and binary .fbx (when
 * exported with "Embed Textures"). Everything else — .gltf, .obj, .stl, .dae —
 * references textures by external path, which we cannot resolve from a single
 * uploaded file, so the model would arrive untextured.
 *
 * The loader in `loadModelFromBuffer` still understands the older formats so
 * that models imported before this restriction keep working.
 */
export const IMPORT_EXTENSIONS = ['.glb', '.fbx'] as const;
export const IMPORT_ACCEPT = IMPORT_EXTENSIONS.join(',');

const MATERIAL_TEXTURE_KEYS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'displacementMap',
  'alphaMap',
  'envMap',
  'lightMap',
  'bumpMap',
  'specularMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'transmissionMap',
  'thicknessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
] as const;

function disposeMaterial(material: THREE.Material) {
  const record = material as unknown as Record<string, unknown>;
  for (const key of MATERIAL_TEXTURE_KEYS) {
    const texture = record[key];
    if (texture instanceof THREE.Texture) texture.dispose();
  }
  material.dispose();
}

/** Traverses a loaded model and disposes every geometry/material/texture it owns. */
function disposeObject3D(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach(disposeMaterial);
    } else if (mesh.material) {
      disposeMaterial(mesh.material);
    }
  });
}

export function isSupportedModelFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return (IMPORT_EXTENSIONS as readonly string[]).includes(ext);
}

export function createViewport(
  canvas: HTMLCanvasElement,
  background: string,
  transparent: boolean,
): ViewportContext {
  const scene = new THREE.Scene();

  if (transparent) {
    scene.background = null;
  } else {
    scene.background = new THREE.Color(background);
  }

  const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
  camera.position.set(3, 2, 5);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: transparent });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // updateStyle=false: the canvas is sized by CSS (`h-full w-full`). Letting
  // three write inline width/height would pin it to its start size, and since
  // the ResizeObserver below watches the canvas itself, it would then never see
  // the container change again — the viewport could never follow the window.
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
  scene.add(gridHelper);

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
  const keyframeMarkers = createKeyframeMarkerState();
  let animationId = 0;
  let disposed = false;

  function animate() {
    if (disposed) return;
    animationId = requestAnimationFrame(animate);
    orbitControls.update();
    renderer.render(scene, camera);
  }
  animate();

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
    orbitControls,
    transformControls,
    models,
    lights,
    keyframeMarkers,
    environmentState: EMPTY_ENVIRONMENT,
    selectedModelId: null,
    selectedId: null,
    selectedKind: null,
    dispose() {
      disposed = true;
      disposeKeyframeMarkers(scene, keyframeMarkers);
      for (const model of models.values()) disposeObject3D(model);
      models.clear();
      syncLights(scene, [], lights, { helpers: true });
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      transformControls.dispose();
      orbitControls.dispose();
      renderer.dispose();
    },
  };
}

/** Reconciles the editor scene lights with the given entries (with helpers). */
export function applyViewportLights(ctx: ViewportContext, entries: LightEntry[]) {
  syncLights(ctx.scene, entries, ctx.lights, { helpers: true });
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
  ctx.environmentState = applyEnvironment(ctx.scene, ctx.renderer, texture, options, ctx.environmentState);
}

/**
 * Renders one fresh frame and returns a downscaled JPEG data URL for use as a
 * project card thumbnail. The read must happen synchronously right after
 * `render()` because the WebGL drawing buffer is not preserved between frames.
 */
export function captureThumbnail(ctx: ViewportContext, width = 320, height = 180): string {
  const source = ctx.renderer.domElement;
  // A collapsed container (a hidden panel, a zero-height layout) leaves the
  // canvas at 0x0, and `drawImage` throws InvalidStateError on a zero-size
  // source. That used to take the whole debounced autosave down with it and
  // silently lose every edit, so bail out and keep the previous thumbnail.
  if (!source.width || !source.height) return '';
  ctx.renderer.render(ctx.scene, ctx.camera);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c2d = canvas.getContext('2d');
  if (!c2d) return '';
  // Flatten onto a solid backdrop so transparent scenes don't become pure black.
  c2d.fillStyle = '#0f0f11';
  c2d.fillRect(0, 0, width, height);
  c2d.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.72);
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
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  let object: THREE.Object3D;

  switch (ext) {
    case '.glb':
    case '.gltf': {
      const loader = new GLTFLoader();
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
      loader.setDRACOLoader(dracoLoader);
      // Lazily imported: only needed for GLBs authored with KTX2/Basis-compressed
      // textures, so users who never touch that pay nothing for it.
      const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
      const ktx2Loader = new KTX2Loader();
      ktx2Loader.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/basis/');
      ktx2Loader.detectSupport(ctx.renderer);
      loader.setKTX2Loader(ktx2Loader);
      const gltf = await loader.parseAsync(buffer, '');
      object = gltf.scene;
      dracoLoader.dispose();
      ktx2Loader.dispose();
      break;
    }
    case '.fbx': {
      const loader = new FBXLoader();
      object = loader.parse(buffer, '');
      break;
    }
    case '.obj': {
      const loader = new OBJLoader();
      const text = new TextDecoder().decode(buffer);
      object = loader.parse(text);
      break;
    }
    case '.stl': {
      const loader = new STLLoader();
      const geometry = loader.parse(buffer);
      const material = new THREE.MeshStandardMaterial({ color: 0x808080 });
      object = new THREE.Mesh(geometry, material);
      break;
    }
    case '.dae': {
      const loader = new ColladaLoader();
      const text = new TextDecoder().decode(buffer);
      const collada = loader.parse(text, '');
      if (!collada) throw new Error('Failed to parse Collada file');
      object = collada.scene;
      break;
    }
    default:
      throw new Error(`Unsupported format: ${ext}`);
  }

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

/** Unified selection for models and lights; attaches the transform gizmo. */
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
  if (ctx.selectedKind !== null && ctx.selectedKind !== 'model' && mode !== 'translate') return false;
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
