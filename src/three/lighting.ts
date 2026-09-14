import * as THREE from 'three';
import { formatFromFileName } from '@/lib/hdri/format';
import type { EnvironmentFormat } from '@/lib/hdri/types';
import type { LightEntry, LightType } from '@/lib/db';

/**
 * Central lighting + environment helpers shared by the editor viewport, the
 * preview page and the exported widget. Keeping this framework-agnostic (no
 * IndexedDB/React imports) lets the widget bundle it without pulling in `idb`.
 */

export type LightRecord = {
  light: THREE.Light;
  helper?: THREE.Object3D;
};

export type EnvironmentOptions = {
  showBackground: boolean;
  useForReflection: boolean;
  intensity: number;
  blurriness?: number;
};

export type EnvironmentState = {
  /** Prefiltered PMREM texture assigned to `scene.environment`. */
  envMap: THREE.Texture | null;
  /** Raw equirect texture assigned to `scene.background`. */
  backgroundTexture: THREE.Texture | null;
};

export const EMPTY_ENVIRONMENT: EnvironmentState = { envMap: null, backgroundTexture: null };

/**
 * Default studio lighting seeded for projects without an explicit light setup.
 * Mirrors the former hardcoded rig (ambient + key/fill/rim); the previous
 * hemisphere light is intentionally dropped for a single source of truth.
 */
export function createDefaultLights(): LightEntry[] {
  return [
    {
      id: crypto.randomUUID(),
      name: 'Umgebungslicht',
      type: 'ambient',
      color: '#ffffff',
      intensity: 0.4,
      position: [0, 0, 0],
      visible: true,
      order: 0,
    },
    {
      id: crypto.randomUUID(),
      name: 'Key Light',
      type: 'directional',
      color: '#ffffff',
      intensity: 1.2,
      position: [5, 8, 5],
      target: [0, 0, 0],
      visible: true,
      order: 1,
    },
    {
      id: crypto.randomUUID(),
      name: 'Fill Light',
      type: 'directional',
      color: '#b4c6e0',
      intensity: 0.6,
      position: [-3, 4, -2],
      target: [0, 0, 0],
      visible: true,
      order: 2,
    },
    {
      id: crypto.randomUUID(),
      name: 'Rim Light',
      type: 'directional',
      color: '#ffd4a0',
      intensity: 0.5,
      position: [0, 3, -6],
      target: [0, 0, 0],
      visible: true,
      order: 3,
    },
  ];
}

/** Sensible defaults for a freshly added light of the given type. */
export function createLightEntry(type: LightType, order: number): LightEntry {
  const base = {
    id: crypto.randomUUID(),
    type,
    color: '#ffffff',
    visible: true,
    order,
  };
  switch (type) {
    case 'ambient':
      return { ...base, name: 'Umgebungslicht', intensity: 0.4, position: [0, 0, 0] };
    case 'directional':
      return { ...base, name: 'Richtungslicht', intensity: 1, position: [4, 6, 4], target: [0, 0, 0] };
    case 'point':
      return { ...base, name: 'Punktlicht', intensity: 8, position: [0, 3, 0], distance: 0, decay: 2 };
    case 'spot':
      return {
        ...base,
        name: 'Spotlicht',
        intensity: 12,
        position: [0, 5, 0],
        target: [0, 0, 0],
        distance: 0,
        decay: 2,
        angle: Math.PI / 6,
        penumbra: 0.3,
      };
  }
}

function typeOf(light: THREE.Light): LightType {
  if (light instanceof THREE.AmbientLight) return 'ambient';
  if (light instanceof THREE.DirectionalLight) return 'directional';
  if (light instanceof THREE.SpotLight) return 'spot';
  return 'point';
}

function createHelper(light: THREE.Light): THREE.Object3D | undefined {
  if (light instanceof THREE.DirectionalLight) return new THREE.DirectionalLightHelper(light, 1);
  if (light instanceof THREE.PointLight) return new THREE.PointLightHelper(light, 0.5);
  if (light instanceof THREE.SpotLight) return new THREE.SpotLightHelper(light);
  return undefined;
}

function createLightObject(entry: LightEntry): THREE.Light {
  switch (entry.type) {
    case 'ambient':
      return new THREE.AmbientLight();
    case 'directional':
      return new THREE.DirectionalLight();
    case 'point':
      return new THREE.PointLight();
    case 'spot':
      return new THREE.SpotLight();
  }
}

function applyLightProps(record: LightRecord, entry: LightEntry, scene: THREE.Scene) {
  const { light } = record;
  light.name = entry.id;
  light.color.set(entry.color);
  light.intensity = entry.intensity;
  light.visible = entry.visible !== false;

  if (!(light instanceof THREE.AmbientLight)) {
    light.position.set(entry.position[0], entry.position[1], entry.position[2]);
  }

  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
    if (!light.target.parent) scene.add(light.target);
    const t = entry.target ?? [0, 0, 0];
    light.target.position.set(t[0], t[1], t[2]);
    light.target.updateMatrixWorld();
  }

  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
    light.distance = entry.distance ?? 0;
    light.decay = entry.decay ?? 2;
  }

  if (light instanceof THREE.SpotLight) {
    light.angle = entry.angle ?? Math.PI / 6;
    light.penumbra = entry.penumbra ?? 0;
  }

  if (record.helper) {
    record.helper.visible = light.visible;
    const helper = record.helper as THREE.Object3D & { update?: () => void };
    helper.update?.();
  }
}

function disposeRecord(scene: THREE.Scene, record: LightRecord) {
  scene.remove(record.light);
  if (record.light instanceof THREE.DirectionalLight || record.light instanceof THREE.SpotLight) {
    scene.remove(record.light.target);
  }
  if (record.helper) {
    scene.remove(record.helper);
    (record.helper as THREE.Object3D & { dispose?: () => void }).dispose?.();
  }
  (record.light as THREE.Light & { dispose?: () => void }).dispose?.();
}

/**
 * Reconciles the given light entries with the live THREE lights stored in
 * `store`: creates new lights, updates changed ones, and removes stale ones.
 * When `helpers` is true, editor-only visualization helpers are attached.
 */
export function syncLights(
  scene: THREE.Scene,
  entries: LightEntry[],
  store: Map<string, LightRecord>,
  options: { helpers?: boolean } = {},
): void {
  const seen = new Set<string>();

  for (const entry of entries) {
    seen.add(entry.id);
    let record = store.get(entry.id);

    if (record && typeOf(record.light) !== entry.type) {
      disposeRecord(scene, record);
      store.delete(entry.id);
      record = undefined;
    }

    if (!record) {
      const light = createLightObject(entry);
      scene.add(light);
      const helper = options.helpers ? createHelper(light) : undefined;
      if (helper) scene.add(helper);
      record = { light, helper };
      store.set(entry.id, record);
    }

    applyLightProps(record, entry, scene);
  }

  for (const [id, record] of store) {
    if (!seen.has(id)) {
      disposeRecord(scene, record);
      store.delete(id);
    }
  }
}

/**
 * Loads an equirectangular image as a texture ready for use as
 * `scene.environment`/`scene.background`. Blobs are loaded via object URL,
 * which is revoked once the loader has consumed it. The heavy decoders are
 * imported lazily so they only ship when actually needed.
 *
 * `format` decides the decoder and should be passed whenever it is known: an
 * Ultra HDR file is a `.jpg`, and handing that to `TextureLoader` *succeeds*. It decodes only the SDR base layer and silently drops the gain map, leaving a
 * flat, dim environment with no error anywhere. Omitting it falls back to name
 * sniffing, which is what environments stored before the converter existed rely
 * on (their extensions are unambiguous, so it is correct for them).
 */
export async function loadEquirectTexture(
  source: Blob | string,
  fileName: string,
  format?: EnvironmentFormat,
): Promise<THREE.Texture> {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const kind = format ?? formatFromFileName(fileName);

  try {
    let texture: THREE.Texture;
    if (kind === 'hdr') {
      // HDRLoader, not RGBELoader: the latter is a deprecation shim in r180+
      // that logs a warning on every construction.
      const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
      texture = await new HDRLoader().loadAsync(url);
    } else if (kind === 'exr') {
      const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
      texture = await new EXRLoader().loadAsync(url);
    } else if (kind === 'ultrahdr') {
      const { UltraHDRLoader } = await import('three/addons/loaders/UltraHDRLoader.js');
      // No colorSpace assignment here: the loader reconstructs linear HDR data
      // from the gain map, so tagging it sRGB would double-decode the transfer.
      texture = await new UltraHDRLoader().loadAsync(url);
    } else {
      texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

/**
 * Applies (or clears) an equirect environment texture. Uses a PMREM-prefiltered
 * map for reflections and optionally the raw texture as background. Disposes the
 * previously applied textures to avoid GPU memory leaks.
 */
export function applyEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture | null,
  options: EnvironmentOptions,
  previous: EnvironmentState = EMPTY_ENVIRONMENT,
): EnvironmentState {
  if (previous.envMap) {
    if (scene.environment === previous.envMap) scene.environment = null;
    previous.envMap.dispose();
  }
  if (previous.backgroundTexture) {
    if (scene.background === previous.backgroundTexture) scene.background = null;
    previous.backgroundTexture.dispose();
  }

  if (!texture) return { envMap: null, backgroundTexture: null };

  let envMap: THREE.Texture | null = null;
  if (options.useForReflection) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    envMap = pmrem.fromEquirectangular(texture).texture;
    pmrem.dispose();
    scene.environment = envMap;
    scene.environmentIntensity = options.intensity;
  }

  let backgroundTexture: THREE.Texture | null = null;
  if (options.showBackground) {
    backgroundTexture = texture;
    scene.background = texture;
    scene.backgroundIntensity = options.intensity;
    scene.backgroundBlurriness = options.blurriness ?? 0;
  } else {
    // Not shown as background: the raw source is no longer referenced.
    texture.dispose();
  }

  return { envMap, backgroundTexture };
}
