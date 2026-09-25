/**
 * Side-by-side renderer for the optimize dialog: the original on the left,
 * the compressed result on the right, from the same camera.
 *
 * One canvas, one renderer, two scissored viewports. Not two renderers. On
 * the WebGL fallback two would mean two contexts on top of the editor's,
 * browsers cap the total around eight to sixteen and evict the oldest, so
 * opening and closing this dialog enough times would kill the main viewport. Sharing one camera
 * for both draws also makes the two halves identical by construction rather
 * than by keeping two cameras in sync.
 *
 * Standalone on purpose: never import this from `viewport.ts`, or the widget
 * bundle inherits it.
 */

import * as THREE from 'three';
import { PMREMGenerator, type WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { disposeObject3D } from './dispose';
import { createModelLoader, createRenderer, disposeRenderer, prepareModel } from './renderer';

export type CompareView = {
  /** Settles once the renderer is up; rejects when the browser has no 3D. */
  ready: Promise<void>;
  /** Replaces one side's model. Pass null to clear it. */
  setModel: (side: 'a' | 'b', buffer: ArrayBuffer | null) => Promise<void>;
  /** 0..1. Where the split sits, as a fraction of the canvas width. */
  setSplit: (fraction: number) => void;
  resize: () => void;
  render: () => void;
  dispose: () => void;
};

/**
 * Loads a GLB without touching any editor state, with the same loader setup
 * as the editor. Including KTX2, because a source model may already carry
 * KTX2 textures and the left-hand side has to show it as it is.
 */
async function loadPreviewModel(renderer: WebGPURenderer, buffer: ArrayBuffer): Promise<THREE.Object3D> {
  const { loader, dispose } = await createModelLoader(renderer);
  try {
    const gltf = await loader.parseAsync(buffer, '');
    prepareModel(renderer, gltf.scene);
    return gltf.scene;
  } finally {
    dispose();
  }
}

/**
 * Creates its own canvas inside `container` rather than taking one from React.
 *
 * On the WebGL fallback, disposing the renderer loses the context and makes
 * that canvas element permanently unusable. A later `getContext` on it returns a broken context whose
 * `getShaderPrecisionFormat` is null. Under React's StrictMode, which mounts
 * every effect twice in development, a React-owned canvas would therefore be
 * dead on the second mount. Owning the element means teardown throws it away
 * along with the context.
 */
export function createCompareView(container: HTMLElement): CompareView {
  const canvas = document.createElement('canvas');
  canvas.className = 'h-full w-full block';
  container.appendChild(canvas);

  // Same renderer setup (and grading) as the editor viewport, so the
  // comparison does not look like a differently graded render of the model.
  // It comes up asynchronously; until then `render()` does nothing.
  let renderer: WebGPURenderer | null = null;
  let disposed = false;

  const sceneA = new THREE.Scene();
  const sceneB = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);

  const controls = new OrbitControls(camera, canvas);
  // Damping needs an update() every frame, i.e. a permanent render loop. This
  // view renders on demand so it never competes with the editor's viewport.
  controls.enableDamping = false;
  // Panning (Shift/Ctrl/Cmd + left drag, or right drag) moves the one shared
  // camera, so both halves follow it together.
  controls.enablePan = true;

  // A fixed neutral environment, not the project's lights: those are editable,
  // and a comparison has to isolate what compression changed. The same PMREM
  // texture serves both scenes. Textures, unlike Object3Ds, can be shared.
  let environment: THREE.Texture | null = null;
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
    if (!renderer || !width || !height) return;

    // `setSize(…, false)` because the canvas is sized by CSS; writing inline
    // styles here would override the layout and freeze the ResizeObserver.
    renderer.setSize(width, height, false);
    // setViewport/setScissor take CSS pixels. Three applies the pixel ratio
    // itself. Pre-multiplying here doubles every rectangle on a retina screen,
    // which spills the left half across the whole canvas.
    const left = Math.round(width * split);

    camera.aspect = Math.max(0.1, left / height);
    camera.updateProjectionMatrix();

    // One clear for the whole canvas, then both halves without clearing:
    // WebGPU clears the full target at the start of every render, scissor or
    // not, so with autoClear the right half would wipe out the left.
    renderer.setScissorTest(false);
    renderer.clear();
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

  const ready = createRenderer({ canvas, alpha: true, pixelRatio: Math.min(window.devicePixelRatio, 2) }).then(
    async (created) => {
      if (disposed) {
        await disposeRenderer(created);
        canvas.remove();
        return;
      }
      created.autoClear = false;
      // A fixed neutral environment, not the project's lights: those are
      // editable, and a comparison has to isolate what compression changed.
      // The same PMREM texture serves both scenes. Textures, unlike Object3Ds,
      // can be shared. RoomEnvironment is a Scene full of meshes and has no
      // dispose of its own; once baked they would pile up with every open.
      const pmrem = new PMREMGenerator(created);
      const room = new RoomEnvironment();
      environment = pmrem.fromScene(room, 0.04).texture;
      disposeObject3D(room);
      pmrem.dispose();
      sceneA.environment = environment;
      sceneB.environment = environment;
      renderer = created;
      render();
    },
    (err: unknown) => {
      canvas.remove();
      throw err;
    },
  );

  return {
    ready,
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

      await ready;
      if (!renderer) return;
      const object = await loadPreviewModel(renderer, buffer);
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
      disposed = true;
      environment?.dispose();
      // On the WebGL fallback this also loses the context. Without that it
      // would linger, and enough open/close cycles would hit the browser's
      // context cap and take the editor viewport down with them. It makes the
      // canvas unusable, which is exactly why the element is ours to throw away.
      if (renderer) {
        const active = renderer;
        renderer = null;
        void disposeRenderer(active).finally(() => canvas.remove());
      }
    },
  };
}
