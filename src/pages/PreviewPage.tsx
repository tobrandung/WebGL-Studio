import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { ArrowLeft, Play, Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getDB, environmentFormat, type Project, type PlaybackMode } from '@/lib/db';
import { loadBlob } from '@/lib/storage/blob-cache';
import { buildSplines, getCameraAtProgress, type Keyframe } from '@/three/camera-path';
import {
  syncLights,
  applyEnvironment,
  loadEquirectTexture,
  createDefaultLights,
  EMPTY_ENVIRONMENT,
  type LightRecord,
  type EnvironmentState,
} from '@/three/lighting';
import { syncPlanes, type PlaneRecord } from '@/three/planes';
import { fitShadowCameras, freezeShadows, setMeshShadows, visibleBounds } from '@/three/shadows';
import { createModelLoader, createRenderer, disposeRenderer, prepareModel } from '@/three/renderer';

type PreviewMode = 'scroll' | 'autoplay';

export function PreviewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  /** Holds the canvas, which each renderer creates for itself (see createViewport). */
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WebGPURenderer | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const progressRef = useRef(0);
  const [project, setProject] = useState<Project | null>(null);

  // Ohne ?mode= entscheidet das Projekt: was im Export-Dialog gewählt wurde,
  // soll die Vorschau auch zeigen. 'loop' ist Autoplay, das nicht anhält.
  const storedMode = project?.cameraPath.playbackMode;
  const paramMode = searchParams.get('mode') as PlaybackMode | null;
  const playbackMode: PlaybackMode = paramMode ?? storedMode ?? 'scroll';
  const mode: PreviewMode = playbackMode === 'scroll' ? 'scroll' : 'autoplay';
  const loops = playbackMode === 'loop' || Boolean(project?.cameraPath.isLoop);

  const [playing, setPlaying] = useState(false);

  // Erst wenn das Projekt da ist, steht die Abspielart fest.
  useEffect(() => {
    if (project) setPlaying(mode === 'autoplay');
  }, [project, mode]);
  const splinesRef = useRef<{ positionSpline: THREE.CatmullRomCurve3 | null; lookAtSpline: THREE.CatmullRomCurve3 | null }>({
    positionSpline: null,
    lookAtSpline: null,
  });

  useEffect(() => {
    if (!id) { navigate('/'); return; }
    (async () => {
      const db = await getDB();
      const p = await db.get('projects', id);
      if (!p) { navigate('/'); return; }
      setProject(p);

      const { positionSpline, lookAtSpline } = buildSplines(p.cameraPath.keyframes, p.cameraPath.isLoop);
      splinesRef.current = { positionSpline, lookAtSpline };
    })();
  }, [id, navigate]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !project) return;
    let cancelled = false;
    setRendererError(null);

    const canvas = document.createElement('canvas');
    canvas.className = 'block h-full w-full';
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    if (project.settings.transparent) {
      scene.background = null;
    } else {
      scene.background = new THREE.Color(project.settings.background);
    }
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    camera.position.set(3, 2, 5);
    cameraRef.current = camera;

    // Ohne das stünde die Kamera bis zur ersten Scroll- oder Autoplay-Bewegung
    // auf ihrer Default-Position statt am Anfang der Fahrt. Die Szene sprang
    // beim ersten Scrollen sichtbar an die richtige Stelle.
    {
      const { positionSpline, lookAtSpline } = splinesRef.current;
      if (positionSpline && lookAtSpline) {
        const start = getCameraAtProgress(positionSpline, lookAtSpline, progressRef.current);
        camera.position.copy(start.position);
        camera.lookAt(start.lookAt);
      }
    }

    const lightStore = new Map<string, LightRecord>();
    syncLights(scene, project.lights && project.lights.length ? project.lights : createDefaultLights(), lightStore);
    const planeStore = new Map<string, PlaneRecord>();
    syncPlanes(scene, project.planes ?? [], planeStore);
    const placed: THREE.Group[] = [];

    let renderer: WebGPURenderer | null = null;
    let envState: EnvironmentState = EMPTY_ENVIRONMENT;
    const resizeObserver = new ResizeObserver(() => {
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
      // updateStyle=false: the canvas is CSS-sized, and inline width/height
      // from three would pin it, leaving this observer blind to later changes.
      renderer?.setSize(canvas.clientWidth, canvas.clientHeight, false);
    });

    async function loadEnvironment() {
      const env = project!.environment;
      if (!env) return;
      const data = await loadBlob(env.blobId, env.assetKey);
      if (!data || cancelled) return;
      const texture = await loadEquirectTexture(new Blob([data]), env.fileName, environmentFormat(env));
      if (cancelled) {
        texture.dispose();
        return;
      }
      envState = applyEnvironment(scene, texture, {
        showBackground: env.showBackground,
        useForReflection: env.useForReflection,
        intensity: env.intensity,
        blurriness: env.blurriness,
      });
    }

    async function loadModels(active: WebGPURenderer) {
      const db = await getDB();
      const models = await db.getAllFromIndex('models', 'by-project', id!);
      const { loader, dispose } = await createModelLoader(active);
      await Promise.all(
        models.map(async (model) => {
          const data = await loadBlob(model.id, model.assetKey);
          if (!data || cancelled) return;
          try {
            const gltf = await loader.parseAsync(data, '');
            setMeshShadows(gltf.scene);
            prepareModel(active, gltf.scene);
            const wrapper = new THREE.Group();
            wrapper.add(gltf.scene);
            const box = new THREE.Box3().setFromObject(wrapper);
            const center = box.getCenter(new THREE.Vector3());
            gltf.scene.position.sub(center);
            wrapper.position.set(...model.position);
            wrapper.rotation.set(...model.rotation);
            wrapper.scale.set(...model.scale);
            scene.add(wrapper);
            placed.push(wrapper);
          } catch (err) {
            // One unreadable model must not blank the whole preview.
            console.error('[Preview] Modell konnte nicht geladen werden:', model.name, err);
          }
        }),
      );
      dispose();
    }

    (async () => {
      let created: WebGPURenderer;
      try {
        created = await createRenderer({
          canvas,
          alpha: project.settings.transparent,
          pixelRatio: Math.min(window.devicePixelRatio, 2),
        });
      } catch (err) {
        canvas.remove();
        if (!cancelled) {
          console.error('[Preview] Renderer konnte nicht starten:', err);
          setRendererError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (cancelled) {
        void disposeRenderer(created).finally(() => canvas.remove());
        return;
      }
      renderer = created;
      rendererRef.current = created;
      created.setSize(canvas.clientWidth, canvas.clientHeight, false);
      resizeObserver.observe(canvas);

      await Promise.all([
        loadEnvironment().catch((err) => console.error('[Preview] Umgebung konnte nicht geladen werden:', err)),
        loadModels(created),
      ]);
      if (cancelled) return;

      // The preview scene is static: fit the shadow cameras once and render
      // each shadow map once, instead of on every frame.
      const lights = Array.from(lightStore.values(), (record) => record.light);
      fitShadowCameras(lights, visibleBounds(placed), visibleBounds(Array.from(planeStore.values(), (record) => record.mesh)));
      freezeShadows(lights);

      // Build every pipeline before the first frame, so the camera path does
      // not stutter while shaders compile. Before the loop starts on purpose:
      // compiling while the loop renders can fail pipeline creation (three.js
      // #34632).
      await created.compileAsync(scene, camera).catch(() => {});
      if (cancelled) return;
      void created.setAnimationLoop(() => created.render(scene, camera));
    })();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      envState.texture?.dispose();
      if (renderer) {
        const active = renderer;
        void active.setAnimationLoop(null);
        void disposeRenderer(active).finally(() => canvas.remove());
      }
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [project, id]);

  useEffect(() => {
    if (mode !== 'scroll') return;

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const { positionSpline, lookAtSpline } = splinesRef.current;
      if (!positionSpline || !lookAtSpline || !cameraRef.current) return;

      progressRef.current += e.deltaY * 0.0005;
      if (loops) {
        progressRef.current = ((progressRef.current % 1) + 1) % 1;
      } else {
        progressRef.current = Math.max(0, Math.min(1, progressRef.current));
      }

      const { position, lookAt } = getCameraAtProgress(positionSpline, lookAtSpline, progressRef.current);
      cameraRef.current.position.copy(position);
      cameraRef.current.lookAt(lookAt);
    }

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [mode, project, loops]);

  useEffect(() => {
    if (mode !== 'autoplay' || !playing) return;

    let lastTime = performance.now();
    let animId = 0;

    function tick() {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const { positionSpline, lookAtSpline } = splinesRef.current;
      if (!positionSpline || !lookAtSpline || !cameraRef.current || !project) {
        animId = requestAnimationFrame(tick);
        return;
      }

      const duration = project.cameraPath.keyframes.length * 2;
      progressRef.current += (dt * project.cameraPath.speed) / Math.max(duration, 1);

      if (progressRef.current >= 1) {
        if (loops) {
          progressRef.current = progressRef.current % 1;
        } else {
          progressRef.current = 1;
          setPlaying(false);
          return;
        }
      }

      const { position, lookAt } = getCameraAtProgress(positionSpline, lookAtSpline, progressRef.current);
      cameraRef.current.position.copy(position);
      cameraRef.current.lookAt(lookAt);

      animId = requestAnimationFrame(tick);
    }
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [mode, playing, project, loops]);

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div className="absolute left-4 top-4 z-10 flex items-center gap-2">
        {/* The preview is reached from the project card, not from the editor,
            so back means back to the project list. */}
        <Button variant="secondary" size="sm" onClick={() => navigate('/')} aria-label="Zurück zum Dashboard">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Zurück
        </Button>
        {mode === 'autoplay' && (
          <Button variant="secondary" size="icon" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
        )}
        <span className="rounded bg-secondary px-2 py-1 text-xs text-muted-foreground">
          {mode === 'scroll' ? 'Scroll-Modus' : 'Autoplay'}
        </span>
      </div>
      <div ref={hostRef} className="h-full w-full" />
      {rendererError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
          <p className="max-w-sm text-center text-sm text-muted-foreground">{rendererError}</p>
        </div>
      )}
    </div>
  );
}

export default PreviewPage;
