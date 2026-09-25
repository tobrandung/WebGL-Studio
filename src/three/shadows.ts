import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

/**
 * Shadow-map helpers shared by the editor viewport, the preview page and the
 * exported widget. Framework-agnostic for the same reason as `lighting.ts`.
 */

/**
 * PCF, not PCFSoftShadowMap: that one is gone since r186 and falls back to PCF
 * with a console warning. PCF is soft on both backends and honours
 * `shadow.radius`, so WebGPU and the WebGL fallback look the same.
 */
export function enableShadowMap(renderer: WebGPURenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
}

/**
 * Every mesh of a loaded model receives shadows (self-shadowing), and every
 * opaque one casts them. Blended materials do not cast: the shadow pass ignores
 * their opacity and would render them as solid. Glass would throw a black
 * shadow, and the baked ground-shadow quad many exported models carry would
 * turn into a hard black rectangle under the model.
 */
export function setMeshShadows(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.castShadow = !materials.some((material) => material.transparent);
    mesh.receiveShadow = true;
  });
}

const corner = new THREE.Vector3();

function boxCorners(box: THREE.Box3, visit: (point: THREE.Vector3) => void) {
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    visit(corner);
  }
}

/**
 * Fits each shadow camera to the scene so the shadow map resolution is spent
 * on the models instead of the default ±5 unit box, which either clips larger
 * scenes or wastes texels on small ones.
 *
 * Directional: the orthographic footprint (left/right/top/bottom) covers the
 * casters only, because a shadow can never fall outside a caster's projection
 * along the light. Near/far also span the receivers, otherwise the shadow is
 * cut off before it reaches a plane below. Near may go negative: an
 * orthographic camera handles that, so the light's position does not matter.
 *
 * Spot/point: their frustum shape is derived from the light itself; only `far`
 * is extended to reach the whole scene when the light has no range limit.
 */
export function fitShadowCameras(lights: Iterable<THREE.Light>, casters: THREE.Box3, receivers: THREE.Box3): void {
  if (casters.isEmpty()) return;
  const scene = casters.clone().union(receivers);
  const margin = scene.getSize(new THREE.Vector3()).length() * 0.02 + 0.01;

  for (const light of lights) {
    if (!light.castShadow) continue;

    if (light instanceof THREE.DirectionalLight) {
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
      light.shadow.updateMatrices(light);
      const camera = light.shadow.camera;
      const view = camera.matrixWorldInverse;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let minDepth = Infinity, maxDepth = -Infinity;
      boxCorners(casters, (p) => {
        p.applyMatrix4(view);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
        minDepth = Math.min(minDepth, -p.z);
        maxDepth = Math.max(maxDepth, -p.z);
      });
      if (!receivers.isEmpty()) {
        boxCorners(receivers, (p) => {
          p.applyMatrix4(view);
          maxDepth = Math.max(maxDepth, -p.z);
        });
      }

      camera.left = minX - margin;
      camera.right = maxX + margin;
      camera.bottom = minY - margin;
      camera.top = maxY + margin;
      camera.near = minDepth - margin;
      camera.far = maxDepth + margin;
      camera.updateProjectionMatrix();
    } else if (light instanceof THREE.SpotLight || light instanceof THREE.PointLight) {
      const origin = light.getWorldPosition(new THREE.Vector3());
      let far = 0;
      boxCorners(scene, (p) => {
        far = Math.max(far, p.distanceTo(origin));
      });
      light.shadow.camera.far = far + margin;
      light.shadow.camera.updateProjectionMatrix();
    }
  }
}

/** World bounds of the visible objects, for `fitShadowCameras`. */
export function visibleBounds(objects: Iterable<THREE.Object3D>): THREE.Box3 {
  const box = new THREE.Box3();
  for (const object of objects) {
    if (object.visible) box.expandByObject(object);
  }
  return box;
}

/**
 * Renders every shadow map once more and then never again. For scenes that do
 * not move after loading (preview, widget), where re-rendering each shadow
 * caster from every light on every frame is the largest avoidable cost.
 */
export function freezeShadows(lights: Iterable<THREE.Light>): void {
  for (const light of lights) {
    const { shadow } = light as THREE.Light & { shadow?: THREE.LightShadow };
    if (!light.castShadow || !shadow) continue;
    shadow.autoUpdate = false;
    shadow.needsUpdate = true;
  }
}
