import * as THREE from 'three';
import type { PlaneEntry } from '@/lib/db';

/**
 * Shadow-catching ground planes, shared by the editor viewport, the preview
 * page and the exported widget. Framework-agnostic like `lighting.ts`.
 */

export type PlaneRecord = {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial | THREE.ShadowMaterial>;
  /** Editor-only outline, so a shadow-only plane can still be found. */
  helper?: THREE.LineSegments;
};

/** A 10×10 floor at height `y`, typically the bottom of the models. */
export function createPlaneEntry(order: number, y = 0): PlaneEntry {
  return {
    id: crypto.randomUUID(),
    name: 'Plane',
    position: [0, y, 0],
    rotation: [0, 0, 0],
    scale: [10, 1, 10],
    color: '#808080',
    shadowOnly: false,
    shadowOpacity: 0.4,
    visible: true,
    order,
  };
}

/** Unit square lying flat on XZ, so a zero rotation is a floor and scale X/Z sizes it. */
function createGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function createMaterial(entry: PlaneEntry): THREE.MeshStandardMaterial | THREE.ShadowMaterial {
  return entry.shadowOnly
    ? new THREE.ShadowMaterial({ opacity: entry.shadowOpacity })
    : new THREE.MeshStandardMaterial({ color: entry.color, roughness: 1 });
}

function applyPlaneProps(record: PlaneRecord, entry: PlaneEntry) {
  const { mesh } = record;
  const wantsShadowMaterial = entry.shadowOnly;
  if (mesh.material instanceof THREE.ShadowMaterial !== wantsShadowMaterial) {
    mesh.material.dispose();
    mesh.material = createMaterial(entry);
  }
  if (mesh.material instanceof THREE.ShadowMaterial) {
    mesh.material.opacity = entry.shadowOpacity;
  } else {
    mesh.material.color.set(entry.color);
  }

  mesh.name = entry.id;
  mesh.visible = entry.visible !== false;
  mesh.position.set(...entry.position);
  mesh.rotation.set(...entry.rotation);
  mesh.scale.set(...entry.scale);
}

function disposeRecord(scene: THREE.Scene, record: PlaneRecord) {
  scene.remove(record.mesh);
  record.mesh.geometry.dispose();
  record.mesh.material.dispose();
  if (record.helper) {
    record.helper.geometry.dispose();
    (record.helper.material as THREE.Material).dispose();
  }
}

/**
 * Reconciles plane entries with the live meshes in `store`, the same way
 * `syncLights` does for lights. `helpers` adds the editor outline.
 */
export function syncPlanes(
  scene: THREE.Scene,
  entries: PlaneEntry[],
  store: Map<string, PlaneRecord>,
  options: { helpers?: boolean } = {},
): void {
  const seen = new Set<string>();

  for (const entry of entries) {
    seen.add(entry.id);
    let record = store.get(entry.id);

    if (!record) {
      const geometry = createGeometry();
      const mesh = new THREE.Mesh(geometry, createMaterial(entry));
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      record = { mesh };
      if (options.helpers) {
        const helper = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry),
          new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.6 }),
        );
        // Never the target of a click; the mesh underneath is.
        helper.raycast = () => {};
        mesh.add(helper);
        record.helper = helper;
      }
      scene.add(mesh);
      store.set(entry.id, record);
    }

    applyPlaneProps(record, entry);
  }

  for (const [id, record] of store) {
    if (!seen.has(id)) {
      disposeRecord(scene, record);
      store.delete(id);
    }
  }
}
