import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { ArrowLeft, Play, Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getDB, environmentFormat, type Project } from '@/lib/db';
import { loadBlob } from '@/lib/storage/blob-cache';
import { buildSplines, getCameraAtProgress, type Keyframe } from '@/three/camera-path';
import {
  syncLights,
  applyEnvironment,
  loadEquirectTexture,
  createDefaultLights,
  type LightRecord,
  type EnvironmentState,
} from '@/three/lighting';

type PreviewMode = 'scroll' | 'autoplay';

export function PreviewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const mode = (searchParams.get('mode') as PreviewMode) || 'scroll';

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const progressRef = useRef(0);
  const [playing, setPlaying] = useState(mode === 'autoplay');
  const [project, setProject] = useState<Project | null>(null);
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
    if (!canvasRef.current || !project) return;

    const scene = new THREE.Scene();
    if (project.settings.transparent) {
      scene.background = null;
    } else {
      scene.background = new THREE.Color(project.settings.background);
    }
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, canvasRef.current.clientWidth / canvasRef.current.clientHeight, 0.1, 1000);
    camera.position.set(3, 2, 5);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ canvas: canvasRef.current, antialias: true, alpha: project.settings.transparent });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // updateStyle=false: this canvas is CSS-sized, and inline width/height from
    // three would pin it, leaving the ResizeObserver below blind to container
    // changes (it observes the canvas itself).
    renderer.setSize(canvasRef.current.clientWidth, canvasRef.current.clientHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    rendererRef.current = renderer;

    const lightStore = new Map<string, LightRecord>();
    syncLights(scene, project.lights && project.lights.length ? project.lights : createDefaultLights(), lightStore);

    let envState: EnvironmentState | null = null;
    let envCancelled = false;
    if (project.environment) {
      const env = project.environment;
      (async () => {
        const data = await loadBlob(env.blobId, env.assetKey);
        if (!data || envCancelled) return;
        const texture = await loadEquirectTexture(new Blob([data]), env.fileName, environmentFormat(env));
        if (envCancelled) {
          texture.dispose();
          return;
        }
        envState = applyEnvironment(scene, renderer, texture, {
          showBackground: env.showBackground,
          useForReflection: env.useForReflection,
          intensity: env.intensity,
          blurriness: env.blurriness,
        });
      })();
    }

    (async () => {
      const db = await getDB();
      const models = await db.getAllFromIndex('models', 'by-project', id!);
      const gltfLoader = new GLTFLoader();
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
      gltfLoader.setDRACOLoader(dracoLoader);

      await Promise.all(
        models.map(async (model) => {
          const data = await loadBlob(model.id, model.assetKey);
          if (!data) return;
          try {
            const gltf = await gltfLoader.parseAsync(data, '');
            const wrapper = new THREE.Group();
            wrapper.add(gltf.scene);
            const box = new THREE.Box3().setFromObject(wrapper);
            const center = box.getCenter(new THREE.Vector3());
            gltf.scene.position.sub(center);
            wrapper.position.set(...model.position);
            wrapper.rotation.set(...model.rotation);
            wrapper.scale.set(...model.scale);
            scene.add(wrapper);
          } catch (err) {
            // One unreadable model must not blank the whole preview.
            console.error('[Preview] Modell konnte nicht geladen werden:', model.name, err);
          }
        }),
      );
      dracoLoader.dispose();
    })();

    let animId = 0;
    function animate() {
      animId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    const resizeObserver = new ResizeObserver(() => {
      if (!canvasRef.current) return;
      camera.aspect = canvasRef.current.clientWidth / canvasRef.current.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(canvasRef.current.clientWidth, canvasRef.current.clientHeight, false);
    });
    resizeObserver.observe(canvasRef.current);

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      envCancelled = true;
      if (envState?.envMap) envState.envMap.dispose();
      if (envState?.backgroundTexture) envState.backgroundTexture.dispose();
      renderer.dispose();
    };
  }, [project, id]);

  useEffect(() => {
    if (mode !== 'scroll') return;

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const { positionSpline, lookAtSpline } = splinesRef.current;
      if (!positionSpline || !lookAtSpline || !cameraRef.current) return;

      progressRef.current += e.deltaY * 0.0005;
      if (project?.cameraPath.isLoop) {
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
  }, [mode, project]);

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
        if (project.cameraPath.isLoop) {
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
  }, [mode, playing, project]);

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div className="absolute left-4 top-4 z-10 flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => navigate(`/project/${id}`)} aria-label="Zurück zum Editor">
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
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}

export default PreviewPage;
