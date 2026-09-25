import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import {
  syncLights,
  applyEnvironment,
  loadEquirectTexture,
  createDefaultLights,
  type LightRecord,
} from '@/three/lighting';
import { syncPlanes, type PlaneRecord } from '@/three/planes';
import { fitShadowCameras, freezeShadows, setMeshShadows, visibleBounds } from '@/three/shadows';
import { createModelLoader, createRenderer, prepareModel } from '@/three/renderer';
import type { LightEntry, PlaneEntry } from '@/lib/db';
import type { EnvironmentFormat } from '@/lib/hdri/types';

type Vec3 = [number, number, number];

/** Obergrenze für den internen Render-Framebuffer (in Pixeln). */
type MaxResolution = { width: number; height: number };

type ModelConfig = {
  url: string;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
};

type EnvironmentWidgetConfig = {
  url: string;
  /**
   * Decoder to use. Additive: embed snippets generated before Ultra HDR
   * existed omit it and fall back to sniffing the URL's extension, which is
   * correct for every format that was exportable back then.
   */
  format?: EnvironmentFormat;
  showBackground: boolean;
  useForReflection: boolean;
  intensity: number;
  blurriness?: number;
};

type WidgetConfig = {
  mode: 'scroll' | 'autoplay' | 'loop';
  transparent?: boolean;
  background?: string;
  keyframes: Array<{ position: Vec3; lookAt: Vec3 }>;
  isLoop: boolean;
  speed: number;
  /** Mehrere Modelle mit Transform. */
  models?: ModelConfig[];
  /** Rückwärtskompatibel: einzelnes Modell. */
  modelUrl?: string;
  /** Platzierte Lichtquellen (Fallback: Standard-Studio-Setup). */
  lights?: LightEntry[];
  /** Schattenfangende Bodenflächen. Fehlt bei älteren Embeds. */
  planes?: PlaneEntry[];
  /** Optionale equirektanguläre Umgebung für Spiegelung/Hintergrund. */
  environment?: EnvironmentWidgetConfig;
  /**
   * Deckelt die interne Render-Auflösung (Framebuffer), z. B. auf Full HD.
   * Die CSS-Größe bleibt unberührt. Das Modell skaliert weiter mit dem
   * Container, es wird nur nicht in nativer 4K/5K-Pixelzahl gerendert.
   * `null`/undefined = unbegrenzt (nur devicePixelRatio-Cap greift).
   */
  maxResolution?: MaxResolution | null;
  /**
   * Rendert per WebGL 2 statt WebGPU. Ohne die Option entscheidet der Browser:
   * WebGPU, wo es verfügbar ist, sonst automatisch WebGL 2.
   */
  forceWebGL?: boolean;
};

/**
 * Ermittelt den effektiven Pixel-Ratio, sodass der Framebuffer die konfigurierte
 * Maximalauflösung nicht überschreitet. Orientierungsunabhängig (die längere
 * Kante der Auflösung deckt die längere Container-Kante ab), damit z. B. Full HD
 * sowohl im Quer- als auch im Hochformat greift.
 */
function computePixelRatio(container: HTMLElement, maxResolution?: MaxResolution | null): number {
  const dpr = window.devicePixelRatio || 1;
  const baseCap = Math.min(dpr, 2);
  if (!maxResolution) return baseCap;

  const cssLong = Math.max(container.clientWidth, container.clientHeight);
  const cssShort = Math.min(container.clientWidth, container.clientHeight);
  if (cssLong <= 0 || cssShort <= 0) return baseCap;

  const resLong = Math.max(maxResolution.width, maxResolution.height);
  const resShort = Math.min(maxResolution.width, maxResolution.height);
  const resolutionCap = Math.min(resLong / cssLong, resShort / cssShort);

  // Nicht über den Geräte-Ratio hinaus hochskalieren, aber mind. 0.5 für Lesbarkeit.
  return Math.max(0.5, Math.min(baseCap, resolutionCap));
}

function buildSplines(keyframes: WidgetConfig['keyframes'], isLoop: boolean) {
  if (keyframes.length < 2) return { positionSpline: null, lookAtSpline: null };
  const posPoints = keyframes.map((kf) => new THREE.Vector3(...kf.position));
  const lookAtPoints = keyframes.map((kf) => new THREE.Vector3(...kf.lookAt));
  return {
    positionSpline: new THREE.CatmullRomCurve3(posPoints, isLoop, 'catmullrom', 0.5),
    lookAtSpline: new THREE.CatmullRomCurve3(lookAtPoints, isLoop, 'catmullrom', 0.5),
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function init(selector: string, config: WidgetConfig) {
  const container = document.querySelector<HTMLElement>(selector);
  if (!container) {
    console.error('[Web3DWidget] Container nicht gefunden:', selector);
    return;
  }

  if (config.keyframes.length < 2) {
    console.warn(
      '[Web3DWidget] Weniger als 2 Keyframes. Es findet keine Kamerafahrt statt. ' +
        'Erstelle im Editor mindestens 2 Keyframes und exportiere erneut.',
    );
  }

  const scene = new THREE.Scene();
  scene.background = config.transparent ? null : new THREE.Color(config.background ?? '#1a1a1a');

  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(3, 2, 5);

  const lightStore = new Map<string, LightRecord>();
  syncLights(scene, config.lights && config.lights.length ? config.lights : createDefaultLights(), lightStore);
  const planeStore = new Map<string, PlaneRecord>();
  syncPlanes(scene, config.planes ?? [], planeStore);
  const placed: THREE.Group[] = [];

  async function loadEnvironment() {
    const env = config.environment;
    if (!env) return;
    try {
      const texture = await loadEquirectTexture(env.url, env.url, env.format);
      applyEnvironment(scene, texture, {
        showBackground: env.showBackground,
        useForReflection: env.useForReflection,
        intensity: env.intensity,
        blurriness: env.blurriness,
      });
    } catch (err) {
      console.error('[Web3DWidget] Umgebung konnte nicht geladen werden:', env.url, err);
    }
  }

  async function loadModels(renderer: WebGPURenderer) {
    const { loader, dispose } = await createModelLoader(renderer);
    const modelList: ModelConfig[] = config.models ?? (config.modelUrl ? [{ url: config.modelUrl }] : []);
    await Promise.all(
      modelList.map(async (m) => {
        try {
          const gltf = await loader.loadAsync(m.url);
          setMeshShadows(gltf.scene);
          prepareModel(renderer, gltf.scene);
          const wrapper = new THREE.Group();
          wrapper.add(gltf.scene);
          const box = new THREE.Box3().setFromObject(wrapper);
          const center = box.getCenter(new THREE.Vector3());
          gltf.scene.position.sub(center);
          if (m.position) wrapper.position.set(...m.position);
          if (m.rotation) wrapper.rotation.set(...m.rotation);
          if (m.scale) wrapper.scale.set(...m.scale);
          scene.add(wrapper);
          placed.push(wrapper);
        } catch (err) {
          console.error('[Web3DWidget] Modell konnte nicht geladen werden:', m.url, err);
        }
      }),
    );
    dispose();
  }

  const { positionSpline, lookAtSpline } = buildSplines(config.keyframes, config.isLoop);
  let progress = 0;

  // Sucht ab dem Container aufwärts das erste `position: sticky`-Element. So
  // funktioniert der Scroll unabhängig davon, wie die Divs in Webflow
  // verschachtelt sind. Der Nutzer muss nur irgendwo Sticky setzen.
  function findStickyAncestor(start: HTMLElement | null): HTMLElement | null {
    let el: HTMLElement | null = start;
    while (el && el !== document.body) {
      if (getComputedStyle(el).position === 'sticky') return el;
      el = el.parentElement;
    }
    return null;
  }

  // Fortschritt aus der Scroll-Position des Sticky-Tracks ableiten. Der Track ist
  // das Elternelement des Sticky-Elements (die hohe Section); die Reisestrecke
  // ergibt sich aus Track-Höhe minus Höhe des gepinnten Elements.
  function computeScrollProgress(): number {
    const sticky = findStickyAncestor(container);
    const track = (sticky ?? container)?.parentElement;
    if (!track) return 0;
    const pinnedHeight = sticky ? sticky.offsetHeight : window.innerHeight;
    const travel = track.offsetHeight - pinnedHeight;
    if (travel <= 0) return 0;
    const scrolled = -track.getBoundingClientRect().top;
    return clamp01(scrolled / travel);
  }

  function applyCamera(t: number) {
    if (!positionSpline || !lookAtSpline) return;
    // getPointAt: arc-length parametrization, so scroll/time progress maps to a
    // constant-speed camera move regardless of how unevenly keyframes are spaced.
    const pos = positionSpline.getPointAt(t);
    const look = lookAtSpline.getPointAt(t);
    camera.position.copy(pos);
    camera.lookAt(look);
  }

  let lastTime = performance.now();

  function animate(renderer: WebGPURenderer) {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    if (positionSpline && lookAtSpline) {
      if (config.mode === 'scroll') {
        const target = computeScrollProgress();
        progress += (target - progress) * 0.12;
        applyCamera(progress);
      } else {
        const duration = Math.max(config.keyframes.length * 2, 1);
        progress += (dt * config.speed) / duration;
        if (progress >= 1) {
          progress = config.mode === 'loop' || config.isLoop ? progress % 1 : 1;
        }
        applyCamera(progress);
      }
    }

    renderer.render(scene, camera);
  }

  // The public `init()` stays synchronous for existing embeds; the renderer
  // (WebGPU, or WebGL 2 where WebGPU is missing) comes up in the background.
  void (async () => {
    let renderer: WebGPURenderer;
    try {
      renderer = await createRenderer({
        alpha: !!config.transparent,
        pixelRatio: computePixelRatio(container, config.maxResolution),
        forceWebGL: config.forceWebGL,
      });
    } catch (err) {
      console.error('[Web3DWidget] 3D wird von diesem Browser nicht unterstützt:', err);
      return;
    }
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const ro = new ResizeObserver(() => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(computePixelRatio(container, config.maxResolution));
      renderer.setSize(container.clientWidth, container.clientHeight);
    });
    ro.observe(container);

    await Promise.all([loadEnvironment(), loadModels(renderer)]);

    // The embedded scene is static: fit the shadow cameras once and render
    // each shadow map once, instead of on every frame.
    const lights = Array.from(lightStore.values(), (record) => record.light);
    fitShadowCameras(lights, visibleBounds(placed), visibleBounds(Array.from(planeStore.values(), (record) => record.mesh)));
    freezeShadows(lights);

    // Build every pipeline before the first frame so the camera move does not
    // stutter while shaders compile. Before the loop on purpose: compiling
    // while the loop renders can fail pipeline creation (three.js #34632).
    applyCamera(progress);
    await renderer.compileAsync(scene, camera).catch(() => {});
    lastTime = performance.now();
    void renderer.setAnimationLoop(() => animate(renderer));
  })();
}

(globalThis as Record<string, unknown>).Web3DWidget = { init };

export { init };
