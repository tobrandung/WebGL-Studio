/**
 * Side-by-side renderer for the optimize dialog: the original on the left,
 * the compressed result on the right, from the same camera.
 *
 * One canvas, one renderer, two scissored viewports — not two renderers. Two
 * would mean two WebGL contexts on top of the editor's, browsers cap the
 * total around eight to sixteen and evict the oldest, so opening and closing
 * this dialog enough times would kill the main viewport. Sharing one camera
 * for both draws also makes the two halves identical by construction rather
 * than by keeping two cameras in sync.
 *
 * Standalone on purpose: never import this from `viewport.ts`, or the widget
 * bundle inherits it.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { disposeObject3D } from './dispose';

export type CompareView = {
  /** Replaces one side's model. Pass null to clear it. */
  setModel: (side: 'a' | 'b', buffer: ArrayBuffer | null) => Promise<void>;
  /** 0..1 — where the split sits, as a fraction of the canvas width. */
  setSplit: (fraction: number) => void;
  resize: () => void;
  render: () => void;
  dispose: () => void;
};

/** Loads a GLB without touching any editor state. */
async function loadPreviewModel(buffer: ArrayBuffer): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  // The compressed side is Draco whenever the option is on, so the decoder is
  // needed on nearly every rebuild — warming it up front avoids a stall.
  draco.preload();
  loader.setDRACOLoader(draco);
  try {
    const gltf = await loader.parseAsync(buffer, '');
    return gltf.scene;
  } finally {
    draco.dispose();
  }
}

/**
 * Creates its own canvas inside `container` rather than taking one from React.
 *
 * `forceContextLoss()` on teardown makes that canvas element permanently
 * unusable — a later `getContext` on it returns a broken context whose
 * `getShaderPrecisionFormat` is null. Under React's StrictMode, which mounts
 * every effect twice in development, a React-owned canvas would therefore be
 * dead on the second mount. Owning the element means teardown throws it away
 * along with the context.
 */
export function createCompareView(container: HTMLElement): CompareView {
  const canvas = document.createElement('canvas');
  canvas.className = 'h-full w-full block';
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const sceneA = new THREE.Scene();
  const sceneB = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);

  const controls = new OrbitControls(camera, canvas);
  // Damping needs an update() every frame, i.e. a permanent render loop. This
  // view renders on demand so it never competes with the editor's viewport.
  controls.enableDamping = false;
  controls.enablePan = false;

  // A fixed neutral environment, not the project's lights: those are editable,
  // and a comparison has to isolate what compression changed. The same PMREM
  // texture serves both scenes — textures, unlike Object3Ds, can be shared.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  sceneA.environment = environment;
  sceneB.environment = environment;
  for (const scene of [sceneA, sceneB]) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.6));
  }

  const roots: Record<'a' | 'b', THREE.Object3D | null> = { a: null, b: null };
  let split = 0.5;
  let framed = false;

  function size(): { width: number; height: number } {
    return { width: container.clientWidth, height: container.clientHeight };
  }

  /**
   * Frames both models at once, using the *half* width for the aspect. With
   * the full canvas aspect the model overflows each half horizontally, which
   * is the easy thing to get wrong here.
   */
  function frame(): void {
    const box = new THREE.Box3();
    let empty = true;
    for (const root of Object.values(roots)) {
      if (!root) continue;
      box.union(new THREE.Box3().setFromObject(root));
      empty = false;
    }
    if (empty) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (!sphere.radius) return;

    const { width, height } = size();
    camera.aspect = Math.max(0.1, (width * split) / Math.max(1, height));
    camera.updateProjectionMatrix();

    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const distance = Math.max(sphere.radius / Math.sin(vFov / 2), sphere.radius / Math.sin(hFov / 2));

    if (!framed) {
      camera.position.copy(sphere.center).add(new THREE.Vector3(0.6, 0.35, 1).setLength(distance * 1.25));
      controls.target.copy(sphere.center);
      framed = true;
    }
    camera.near = Math.max(0.001, distance / 100);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function render(): void {
    const { width, height } = size();
    if (!width || !height) return;

    // `setSize(…, false)` because the canvas is sized by CSS; writing inline
    // styles here would override the layout and freeze the ResizeObserver.
    renderer.setSize(width, height, false);
    // setViewport/setScissor take CSS pixels — three applies the pixel ratio
    // itself. Pre-multiplying here doubles every rectangle on a retina screen,
    // which spills the left half across the whole canvas.
    const left = Math.round(width * split);

    camera.aspect = Math.max(0.1, left / height);
    camera.updateProjectionMatrix();

    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, left, height);
    renderer.setScissor(0, 0, left, height);
    renderer.render(sceneA, camera);

    renderer.setViewport(left, 0, width - left, height);
    renderer.setScissor(left, 0, width - left, height);
    renderer.render(sceneB, camera);
    renderer.setScissorTest(false);
  }

  controls.addEventListener('change', render);

  return {
    async setModel(side, buffer) {
      const existing = roots[side];
      if (existing) {
        (side === 'a' ? sceneA : sceneB).remove(existing);
        disposeObject3D(existing);
        roots[side] = null;
      }
      if (!buffer) {
        render();
        return;
      }

      const object = await loadPreviewModel(buffer);
      // Recentred the same way the editor centres a model, so the two sides
      // stay aligned even when compression nudges the bounding box.
      const center = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
      object.position.sub(center);
      (side === 'a' ? sceneA : sceneB).add(object);
      roots[side] = object;
      frame();
      render();
    },

    setSplit(fraction) {
      split = Math.max(0.05, Math.min(0.95, fraction));
      render();
    },

    resize() {
      frame();
      render();
    },

    render,

    dispose() {
      controls.removeEventListener('change', render);
      controls.dispose();
      for (const side of ['a', 'b'] as const) {
        const root = roots[side];
        if (root) {
          (side === 'a' ? sceneA : sceneB).remove(root);
          disposeObject3D(root);
        }
        roots[side] = null;
      }
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      // Without this the context lingers; enough open/close cycles then hit
      // the browser's context cap and take the editor viewport down with them.
      // It also makes this canvas element unusable, which is exactly why the
      // element is ours to throw away.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
