import * as THREE from 'three';

export type Keyframe = {
  /**
   * Stable identity so a keyframe survives edits, reordering and deletion of
   * its neighbours. Projects saved before keyframe editing existed lack it and
   * get one assigned on load.
   */
  id: string;
  position: [number, number, number];
  lookAt: [number, number, number];
};

/** Which of a keyframe's two draggable points a selection refers to. */
export type KeyframePart = 'position' | 'lookAt';

const REF_SEPARATOR = '#';

/**
 * Composite selection id for a single draggable keyframe marker. Keyframe
 * selection travels through the same single-id channel as models and lights
 * (so only ever one transform gizmo is attached), hence the packed form.
 */
export function formatKeyframeRef(id: string, part: KeyframePart): string {
  return `${id}${REF_SEPARATOR}${part}`;
}

export function parseKeyframeRef(ref: string | null | undefined): { id: string; part: KeyframePart } | null {
  if (!ref) return null;
  const at = ref.lastIndexOf(REF_SEPARATOR);
  if (at <= 0) return null;
  const part = ref.slice(at + 1);
  if (part !== 'position' && part !== 'lookAt') return null;
  return { id: ref.slice(0, at), part };
}

/** The two points a path segment interpolates. All `buildSplines` needs. */
export type KeyframePose = Pick<Keyframe, 'position' | 'lookAt'>;

export type CameraPathState = {
  keyframes: Keyframe[];
  positionSpline: THREE.CatmullRomCurve3 | null;
  lookAtSpline: THREE.CatmullRomCurve3 | null;
  isLoop: boolean;
};

export function buildSplines(keyframes: readonly KeyframePose[], isLoop: boolean): {
  positionSpline: THREE.CatmullRomCurve3 | null;
  lookAtSpline: THREE.CatmullRomCurve3 | null;
} {
  if (keyframes.length < 2) return { positionSpline: null, lookAtSpline: null };

  const posPoints = keyframes.map((kf) => new THREE.Vector3(...kf.position));
  const lookAtPoints = keyframes.map((kf) => new THREE.Vector3(...kf.lookAt));

  const positionSpline = new THREE.CatmullRomCurve3(posPoints, isLoop, 'catmullrom', 0.5);
  const lookAtSpline = new THREE.CatmullRomCurve3(lookAtPoints, isLoop, 'catmullrom', 0.5);

  return { positionSpline, lookAtSpline };
}

export function getSplinePoints(spline: THREE.CatmullRomCurve3, segments = 200): THREE.Vector3[] {
  return spline.getPoints(segments);
}

export function getCameraAtProgress(
  positionSpline: THREE.CatmullRomCurve3,
  lookAtSpline: THREE.CatmullRomCurve3,
  t: number,
): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const clampedT = Math.max(0, Math.min(1, t));
  // getPointAt (not getPoint) walks the curve by arc length rather than by
  // the raw Catmull-Rom parameter, so unevenly spaced keyframes still feel
  // like a constant-speed camera move instead of speeding up/slowing down
  // between closer/farther-apart points.
  return {
    position: positionSpline.getPointAt(clampedT),
    lookAt: lookAtSpline.getPointAt(clampedT),
  };
}
