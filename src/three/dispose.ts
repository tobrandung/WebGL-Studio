/**
 * GPU resource release for loaded models.
 *
 * Its own module rather than part of `viewport.ts` so the optimize dialog's
 * comparison renderer can use it without importing the editor viewport, which would drag two scenes and OrbitControls into the widget's IIFE bundle,
 * where dynamic imports are inlined and nothing gets tree-shaken across the
 * entry.
 */

import * as THREE from 'three';

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

export function disposeMaterial(material: THREE.Material) {
  const record = material as unknown as Record<string, unknown>;
  for (const key of MATERIAL_TEXTURE_KEYS) {
    const texture = record[key];
    if (texture instanceof THREE.Texture) texture.dispose();
  }
  material.dispose();
}

/** Traverses a loaded model and disposes every geometry/material/texture it owns. */
export function disposeObject3D(object: THREE.Object3D) {
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
