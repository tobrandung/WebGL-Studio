import * as THREE from 'three';
import {
  buildSplines,
  getSplinePoints,
  formatKeyframeRef,
  type Keyframe,
} from './camera-path';

/**
 * Camera-path visualisation for the editor viewport: one draggable marker per
 * keyframe position and look-at point, plus the interpolated spline.
 *
 * Unlike a rebuild-on-change approach this reconciles per keyframe id (same
 * shape as `syncLights`) and updates buffers in place. That matters because the
 * transform gizmo attaches to a marker mesh. Recreating the meshes on every
 * change would tear the gizmo's target away mid-drag.
 */

export type KeyframeMarkerRecord = {
  position: THREE.Mesh;
  lookAt: THREE.Mesh;
  connector: THREE.Line;
};

export type KeyframeMarkerState = {
  markers: Map<string, KeyframeMarkerRecord>;
  splineLine: THREE.Line | null;
};

export type KeyframeMarkerOptions = {
  showMarkers: boolean;
  showSpline: boolean;
  isLoop: boolean;
  /** Composite ref (see `formatKeyframeRef`) of the highlighted marker. */
  selectedRef: string | null;
};

const SEGMENTS = 200;

const POSITION_COLOR = 0xff4444;
const LOOKAT_COLOR = 0x44ff44;
const SELECTED_COLOR = 0xffd23f;
const CONNECTOR_COLOR = 0xffff44;
const SPLINE_COLOR = 0x00aaff;

// Shared across every marker and never disposed. Geometry is cheap, and
// reusing it keeps adding/removing keyframes free of GPU churn. Highlighting
// scales the mesh rather than swapping geometry.
const POSITION_GEOMETRY = new THREE.SphereGeometry(0.08, 16, 12);
const LOOKAT_GEOMETRY = new THREE.SphereGeometry(0.045, 12, 8);

export function createKeyframeMarkerState(): KeyframeMarkerState {
  return { markers: new Map(), splineLine: null };
}

function createRecord(keyframe: Keyframe): KeyframeMarkerRecord {
  const position = new THREE.Mesh(
    POSITION_GEOMETRY,
    new THREE.MeshBasicMaterial({ color: POSITION_COLOR }),
  );
  position.name = formatKeyframeRef(keyframe.id, 'position');

  const lookAt = new THREE.Mesh(
    LOOKAT_GEOMETRY,
    new THREE.MeshBasicMaterial({ color: LOOKAT_COLOR }),
  );
  lookAt.name = formatKeyframeRef(keyframe.id, 'lookAt');

  const connectorGeometry = new THREE.BufferGeometry();
  connectorGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const connector = new THREE.Line(
    connectorGeometry,
    new THREE.LineBasicMaterial({ color: CONNECTOR_COLOR, opacity: 0.4, transparent: true }),
  );

  return { position, lookAt, connector };
}

function paint(mesh: THREE.Mesh, selected: boolean, baseColor: number) {
  (mesh.material as THREE.MeshBasicMaterial).color.setHex(selected ? SELECTED_COLOR : baseColor);
  mesh.scale.setScalar(selected ? 1.6 : 1);
}

function updateRecord(
  record: KeyframeMarkerRecord,
  keyframe: Keyframe,
  showMarkers: boolean,
  selectedRef: string | null,
) {
  record.position.position.set(...keyframe.position);
  record.lookAt.position.set(...keyframe.lookAt);

  paint(record.position, selectedRef === formatKeyframeRef(keyframe.id, 'position'), POSITION_COLOR);
  paint(record.lookAt, selectedRef === formatKeyframeRef(keyframe.id, 'lookAt'), LOOKAT_COLOR);

  const attribute = record.connector.geometry.getAttribute('position') as THREE.BufferAttribute;
  attribute.setXYZ(0, ...keyframe.position);
  attribute.setXYZ(1, ...keyframe.lookAt);
  attribute.needsUpdate = true;
  record.connector.geometry.computeBoundingSphere();

  record.position.visible = showMarkers;
  record.lookAt.visible = showMarkers;
  record.connector.visible = showMarkers;
}

function disposeRecord(scene: THREE.Scene, record: KeyframeMarkerRecord) {
  scene.remove(record.position, record.lookAt, record.connector);
  (record.position.material as THREE.Material).dispose();
  (record.lookAt.material as THREE.Material).dispose();
  record.connector.geometry.dispose();
  (record.connector.material as THREE.Material).dispose();
}

function syncSpline(
  scene: THREE.Scene,
  state: KeyframeMarkerState,
  keyframes: Keyframe[],
  isLoop: boolean,
  showSpline: boolean,
) {
  if (!state.splineLine) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3),
    );
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: SPLINE_COLOR, opacity: 0.7, transparent: true }),
    );
    line.frustumCulled = false;
    scene.add(line);
    state.splineLine = line;
  }

  const line = state.splineLine;
  const { positionSpline } = buildSplines(keyframes, isLoop);

  if (!showSpline || !positionSpline) {
    line.visible = false;
    return;
  }

  const points = getSplinePoints(positionSpline, SEGMENTS);
  const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < points.length; i += 1) {
    attribute.setXYZ(i, points[i].x, points[i].y, points[i].z);
  }
  attribute.needsUpdate = true;
  line.geometry.setDrawRange(0, points.length);
  line.geometry.computeBoundingSphere();
  line.visible = true;
}

/** Reconciles the markers and spline with the given keyframes. */
export function syncKeyframeMarkers(
  scene: THREE.Scene,
  state: KeyframeMarkerState,
  keyframes: Keyframe[],
  options: KeyframeMarkerOptions,
): void {
  const seen = new Set<string>();

  for (const keyframe of keyframes) {
    seen.add(keyframe.id);
    let record = state.markers.get(keyframe.id);
    if (!record) {
      record = createRecord(keyframe);
      scene.add(record.position, record.lookAt, record.connector);
      state.markers.set(keyframe.id, record);
    }
    updateRecord(record, keyframe, options.showMarkers, options.selectedRef);
  }

  for (const [id, record] of state.markers) {
    if (seen.has(id)) continue;
    disposeRecord(scene, record);
    state.markers.delete(id);
  }

  syncSpline(scene, state, keyframes, options.isLoop, options.showSpline);
}

/** Every marker mesh currently eligible for picking. */
export function pickableKeyframeMarkers(state: KeyframeMarkerState): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const record of state.markers.values()) {
    if (record.position.visible) meshes.push(record.position);
    if (record.lookAt.visible) meshes.push(record.lookAt);
  }
  return meshes;
}

/** The mesh a composite ref points at, if it still exists. */
export function findKeyframeMarker(state: KeyframeMarkerState, ref: string): THREE.Mesh | null {
  for (const record of state.markers.values()) {
    if (record.position.name === ref) return record.position;
    if (record.lookAt.name === ref) return record.lookAt;
  }
  return null;
}

export function disposeKeyframeMarkers(scene: THREE.Scene, state: KeyframeMarkerState): void {
  for (const record of state.markers.values()) disposeRecord(scene, record);
  state.markers.clear();

  if (state.splineLine) {
    scene.remove(state.splineLine);
    state.splineLine.geometry.dispose();
    (state.splineLine.material as THREE.Material).dispose();
    state.splineLine = null;
  }
}
