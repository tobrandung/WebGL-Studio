import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { enableShadowMap } from './shadows';

/**
 * The one place a renderer is made, shared by the editor viewport, the preview
 * page, the compare view and the exported widget. Framework-agnostic like
 * `lighting.ts`, so the widget can bundle it.
 *
 * WebGPU by default. `WebGPURenderer` falls back to its own WebGL 2 backend by
 * itself when `navigator.gpu` is missing or no adapter or device can be had,
 * so older browsers keep working without a second renderer in the bundle.
 */

export type RendererBackend = 'webgpu' | 'webgl2';

export type RendererOptions = {
  canvas?: HTMLCanvasElement;
  alpha: boolean;
  pixelRatio: number;
  /** Skips WebGPU, e.g. to test the fallback on a machine that has WebGPU. */
  forceWebGL?: boolean;
};

/** Thrown when the browser has neither WebGPU nor WebGL 2. */
export class RendererUnavailableError extends Error {
  /** What `init()` rejected with, for the console. */
  readonly reason: unknown;

  constructor(reason: unknown) {
    super('3D wird von diesem Browser nicht unterstützt.');
    this.name = 'RendererUnavailableError';
    this.reason = reason;
  }
}

/** `?renderer=webgl` in the page URL forces the fallback, for testing it. */
export function forceWebGLFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search || window.location.hash.split('?')[1] || '');
  return params.get('renderer') === 'webgl';
}

/**
 * Creates and initialises a renderer with the look every view shares: sRGB
 * output, ACES at 1.2 and PCF shadow maps. Awaiting `init()` here is what the
 * rest of the code relies on: `render()`, `hasFeature()` (KTX2) and PMREM all
 * throw or misbehave on a renderer that has not finished initialising.
 */
export async function createRenderer(options: RendererOptions): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({
    canvas: options.canvas,
    antialias: true,
    alpha: options.alpha,
    forceWebGL: options.forceWebGL ?? forceWebGLFromUrl(),
  });
  try {
    await renderer.init();
  } catch (err) {
    void renderer.dispose();
    throw new RendererUnavailableError(err);
  }
  // One line per renderer, so a report from a customer's machine says which
  // backend it actually ran on.
  console.info(`[3D] Renderer: ${rendererBackend(renderer) === 'webgpu' ? 'WebGPU' : 'WebGL 2 (Fallback)'}`);
  renderer.setPixelRatio(options.pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  enableShadowMap(renderer);
  return renderer;
}

/** Which backend actually runs. Only meaningful after `init()`, which swaps it. */
export function rendererBackend(renderer: WebGPURenderer): RendererBackend {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
}

/**
 * The one renderer on this page allowed to draw transmission (refractive glass,
 * `KHR_materials_transmission`), or null.
 *
 * three.js r186 samples transmission from a module-global viewport texture
 * node (`viewportBackSideTexture` in PhysicalLightingModel). With two
 * renderers drawing it, each binds the other's framebuffer copy: on WebGPU
 * every submit fails with "Destroyed texture", and the survivor keeps failing
 * after the other is disposed. Reproduced in isolation, and also with one of
 * the two on the WebGL 2 fallback. So only one renderer at a time gets it, and
 * any other one (the optimize compare view beside the editor, a second embed
 * on the same page) shows that glass without refraction.
 */
let transmissionOwner: WebGPURenderer | null = null;

function mayDrawTransmission(renderer: WebGPURenderer): boolean {
  if (transmissionOwner === null) transmissionOwner = renderer;
  return transmissionOwner === renderer;
}

/**
 * Prepares a loaded model's materials for this renderer: drops transmission
 * where another renderer already owns it (see `transmissionOwner`).
 */
export function prepareModel(renderer: WebGPURenderer, object: THREE.Object3D): void {
  if (mayDrawTransmission(renderer)) return;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const physical = material as THREE.MeshPhysicalMaterial;
      if (physical.isMeshPhysicalMaterial && physical.transmission > 0) physical.transmission = 0;
    }
  });
}

/** Disposes a renderer made by `createRenderer` and frees what it held on the page. */
export async function disposeRenderer(renderer: WebGPURenderer): Promise<void> {
  if (transmissionOwner === renderer) transmissionOwner = null;
  await renderer.dispose();
}

/**
 * Basis transcoder matching the installed three version. Hardcoding the
 * version here drifted from the package on every upgrade.
 */
const BASIS_TRANSCODER_PATH = `https://cdn.jsdelivr.net/npm/three@0.${THREE.REVISION}.0/examples/jsm/libs/basis/`;
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';

export type ModelLoader = { loader: GLTFLoader; dispose: () => void };

/**
 * GLTF with Draco geometry and KTX2 textures. `detectSupport` asks the
 * renderer which compressed formats the GPU takes, which is why the renderer
 * must be initialised first.
 *
 * KTX2Loader is imported lazily: only GLBs authored with Basis-compressed
 * textures need it, so the app chunk does not carry it for everyone else.
 */
export async function createModelLoader(renderer: WebGPURenderer): Promise<ModelLoader> {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_PATH);
  loader.setDRACOLoader(draco);
  const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath(BASIS_TRANSCODER_PATH);
  ktx2.detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  return {
    loader,
    dispose() {
      draco.dispose();
      ktx2.dispose();
    },
  };
}
