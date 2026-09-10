import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import {
  Copy,
  Check,
  Download,
  AlertTriangle,
  FolderDown,
  Upload,
  Loader2,
  Settings2,
  Cloud,
  Code2,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  DIALOG_TRANSITION,
  GlassDialogContent,
  GlassDialogFooter,
  GlassDialogHeader,
} from '@/components/ui/glass-dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getDB, environmentFormat, type Project, type ModelEntry } from '@/lib/db';
import { ENVIRONMENT_FORMAT_LABEL, extensionForFormat } from '@/lib/hdri/format';
import { cn, slugify, formatBytes } from '@/lib/utils';
import { InfoHint } from '@/components/ui/info-hint';
import { Notice } from '@/components/ui/notice';

type ExportMode = 'scroll' | 'autoplay' | 'loop';
type ExportTab = 'display' | 'hosting' | 'embed';

const EXPORT_TABS: ExportTab[] = ['display', 'hosting', 'embed'];

/** Obergrenze für den animierten Content-Bereich (Rest bleibt Header/Tabs/Footer). */
function maxExportPanelHeight(): number {
  if (typeof window === 'undefined') return 480;
  return Math.min(window.innerHeight * 0.52, window.innerHeight * 0.85 - 180);
}

const EXPORT_MODES: Array<{ id: ExportMode; label: string; hint: string }> = [
  { id: 'scroll', label: 'Scroll', hint: 'Die Kamera folgt dem Scroll-Fortschritt der Seite.' },
  { id: 'autoplay', label: 'Autoplay', hint: 'Die Kamerafahrt startet automatisch und läuft einmal durch.' },
  { id: 'loop', label: 'Loop', hint: 'Die Kamerafahrt läuft automatisch in einer Endlosschleife.' },
];

type ResolutionPreset = {
  id: string;
  label: string;
  /** null = keine Begrenzung (rendert in nativer Container-Auflösung). */
  resolution: { width: number; height: number } | null;
};

// Gängige Auflösungen als Obergrenze für den Render-Framebuffer. Full HD ist
// die Voreinstellung – reicht für die meisten Web-Einbettungen und verhindert,
// dass auf 4K/5K-Displays unnötig viele Pixel gerendert werden (Ruckeln).
const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: 'hd', label: 'HD (1280×720)', resolution: { width: 1280, height: 720 } },
  { id: 'fhd', label: 'Full HD (1920×1080)', resolution: { width: 1920, height: 1080 } },
  { id: 'qhd', label: '2K QHD (2560×1440)', resolution: { width: 2560, height: 1440 } },
  { id: 'uhd', label: '4K UHD (3840×2160)', resolution: { width: 3840, height: 2160 } },
  { id: 'unlimited', label: 'Unbegrenzt (nativ)', resolution: null },
];

const DEFAULT_RESOLUTION_ID = 'fhd';

// GitHub-Token wird lokal im Browser gespeichert, damit er nicht bei jedem
// Export neu eingegeben werden muss. Hinweis: localStorage ist bei XSS lesbar –
// bewusster Komfort-Kompromiss auf Wunsch. Nur Fine-grained-Token mit minimalem
// Scope verwenden.
const TOKEN_STORAGE_KEY = 'web3d-export-gh-token';

/** Kompakter, dateisystemsicherer Zeitstempel wie 20260713-134500. */
function formatStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

type ExportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
};

// Minimal File System Access API typings (not in the DOM lib for our target).
type FsWritable = { write: (data: BufferSource | Blob) => Promise<void>; close: () => Promise<void> };
type FsFileHandle = { createWritable: () => Promise<FsWritable> };
type FsDirHandle = {
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<FsDirHandle>;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<FsFileHandle>;
};
type DirectoryPicker = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirHandle>;

const supportsFsAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function fileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : 'glb';
}

/** Encodes an ArrayBuffer to base64 in chunks to avoid call-stack limits. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function githubErrorMessage(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { message?: string };
    return json.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * Creates or updates a single file in a GitHub repo via the Contents API.
 * Fetches the existing blob sha first so updates don't fail with 409/422.
 * Returns the resulting commit SHA so callers can pin immutable CDN URLs.
 */
async function putFileToGitHub(params: {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  data: ArrayBuffer;
  token: string;
  message: string;
}): Promise<string | undefined> {
  const { owner, repo, branch, path, data, token, message } = params;
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  const headers: HeadersInit = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let sha: string | undefined;
  const getRes = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.ok) {
    const json = (await getRes.json()) as { sha?: string };
    sha = json.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`GET ${path}: ${getRes.status} – ${await githubErrorMessage(getRes)}`);
  }

  const putRes = await fetch(api, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message, content: arrayBufferToBase64(data), branch, sha }),
  });
  if (!putRes.ok) {
    throw new Error(`PUT ${path}: ${putRes.status} – ${await githubErrorMessage(putRes)}`);
  }
  const putJson = (await putRes.json()) as { commit?: { sha?: string } };
  return putJson.commit?.sha;
}

export function ExportDialog({ open, onOpenChange, project }: ExportDialogProps) {
  const [exportMode, setExportMode] = useState<ExportMode>('scroll');
  const [transparent, setTransparent] = useState(true);
  const [resolutionId, setResolutionId] = useState(DEFAULT_RESOLUTION_ID);
  const [copied, setCopied] = useState(false);
  const [owner, setOwner] = useState('tobrandung');
  const [repo, setRepo] = useState('webGL-test');
  const [branch, setBranch] = useState('main');
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [savingFolder, setSavingFolder] = useState(false);
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [includeEnv, setIncludeEnv] = useState(true);
  const [envBytes, setEnvBytes] = useState(0);
  const [envFolderStatus, setEnvFolderStatus] = useState<string | null>(null);
  const [token, setToken] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem(TOKEN_STORAGE_KEY) ?? '') : '',
  );
  const [uploading, setUploading] = useState(false);
  const [uploadLog, setUploadLog] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Commit SHA of the most recent GitHub upload. When set, embed URLs are pinned
  // to it (immutable → jsDelivr serves fresh content without cache purge).
  const [deployedSha, setDeployedSha] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ExportTab>('display');
  /** 1 = nach rechts, -1 = nach links – steuert die Slide-Richtung des Contents. */
  const [tabSlideDir, setTabSlideDir] = useState(1);
  const [panelHeight, setPanelHeight] = useState<number | undefined>(undefined);
  const [panelScrollable, setPanelScrollable] = useState(false);
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const tabsListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !project) return;
    // Jeder Export startet mit transparentem Hintergrund.
    setTransparent(true);
    (async () => {
      const db = await getDB();
      const all = await db.getAllFromIndex('models', 'by-project', project.id);
      setModels(all);
      // Deriving from the blob rather than only from `fileSize` keeps the number
      // right for environments stored before that field existed — which is why
      // no record migration is needed.
      const env = project.environment;
      if (!env) {
        setEnvBytes(0);
        return;
      }
      const record = await db.get('blobs', env.blobId);
      setEnvBytes(env.fileSize ?? record?.data.byteLength ?? 0);
    })();
  }, [open, project]);

  // Any change to the repo target or project invalidates a previously pinned
  // commit, so fall back to the branch until the user re-uploads.
  useEffect(() => {
    setDeployedSha(null);
  }, [owner, repo, branch, open, project]);

  // Token lokal spiegeln, damit er beim nächsten Export wieder vorausgefüllt ist.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  }, [token]);

  // Beim Schließen Höhe zurücksetzen, damit der nächste Open frisch misst.
  useEffect(() => {
    if (open) return;
    setPanelHeight(undefined);
    setPanelScrollable(false);
  }, [open]);

  // Modal-Höhe weich mitführen.
  // Wichtig: Höhe erst NACH dem Paint setzen (rAF), sonst sieht der Browser
  // alten und neuen Wert im selben Frame und die CSS-Transition startet nicht.
  useLayoutEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (!el) return;

    const measure = () => {
      const natural = el.scrollHeight;
      const max = maxExportPanelHeight();
      return {
        height: Math.min(natural, max),
        scrollable: natural > max,
      };
    };

    let raf1 = 0;
    let raf2 = 0;
    const { height: nextHeight, scrollable } = measure();

    if (panelHeight === undefined) {
      // Erster Open: sofort setzen, nichts zu animieren.
      setPanelHeight(nextHeight);
      setPanelScrollable(scrollable);
    } else {
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setPanelHeight(nextHeight);
          setPanelScrollable(scrollable);
        });
      });
    }

    // Spätere Inhaltsänderungen (Upload-Log etc.) ohne Tab-Wechsel.
    const ro = new ResizeObserver(() => {
      const m = measure();
      setPanelHeight(m.height);
      setPanelScrollable(m.scrollable);
    });
    // RO erst nach der Tab-Animation anbinden, sonst killt er die Transition.
    const roTimer = window.setTimeout(() => ro.observe(el), 350);
    const onResize = () => {
      const m = measure();
      setPanelHeight(m.height);
      setPanelScrollable(m.scrollable);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(roTimer);
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
    // panelHeight absichtlich nicht in deps – sonst Endlosschleife.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- height sync on tab/content change only
  }, [open, activeTab, exportMode, resolutionId, transparent, includeEnv, models, project?.environment, uploading, uploadLog, uploadError, folderStatus, envFolderStatus, deployedSha, owner, repo, branch, copied, envBytes]);

  // Sliding Pill unter dem aktiven Tab.
  useLayoutEffect(() => {
    if (!open) return;
    const list = tabsListRef.current;
    if (!list) return;

    const updateIndicator = () => {
      const active = list.querySelector<HTMLElement>('[data-state="active"]');
      if (!active) return;
      setTabIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    };

    // Ein Frame warten, damit data-state=active am DOM steht.
    const id = requestAnimationFrame(updateIndicator);
    return () => cancelAnimationFrame(id);
  }, [open, activeTab]);

  const handleTabChange = useCallback((next: string) => {
    const nextTab = next as ExportTab;
    const prevIdx = EXPORT_TABS.indexOf(activeTab);
    const nextIdx = EXPORT_TABS.indexOf(nextTab);
    setTabSlideDir(nextIdx >= prevIdx ? 1 : -1);
    setActiveTab(nextTab);
  }, [activeTab]);

  const projectSlug = project ? slugify(project.name) : '';
  // Pin to the uploaded commit when available; otherwise track the branch.
  const ref = deployedSha ?? branch;
  const baseUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}`;
  const rawBaseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}`;
  // A commit-pinned script URL is immutable, so the cache-busting query is only
  // needed for the mutable @branch fallback.
  const scriptUrl = `${baseUrl}/dist-widget/web3d-widget.iife.js${deployedSha ? '' : '?v=2'}`;
  // Sprechender, dateisystem- und URL-sicherer Name: Modellname (slugifiziert,
  // gekürzt) + Erstell-Zeitstempel für Eindeutigkeit. Ersetzt die lange UUID.
  const modelFileName = (m: ModelEntry) =>
    `${slugify(m.name).slice(0, 40)}-${formatStamp(m.createdAt)}.${fileExtension(m.fileName)}`;
  // jsDelivr refuses GitHub files larger than 20 MiB (HTTP 403). Fall back to
  // raw.githubusercontent.com (CORS-enabled, 100 MB limit) for oversized assets.
  const JSDELIVR_MAX_BYTES = 20 * 1024 * 1024;
  const assetUrl = (repoPath: string, sizeBytes: number) =>
    sizeBytes > JSDELIVR_MAX_BYTES ? `${rawBaseUrl}/${repoPath}` : `${baseUrl}/${repoPath}`;
  const modelPath = (m: ModelEntry) =>
    assetUrl(`dist-widget/models/${projectSlug}/${modelFileName(m)}`, m.fileSize);
  const environment = project?.environment ?? null;
  const envFormat = environment ? environmentFormat(environment) : null;
  // Derive the extension from the format, not from the stored name: an Ultra HDR
  // file must keep its `.uhdr.jpg` marker so a widget that only sees the URL
  // still picks the right decoder.
  const envFileName = environment && envFormat ? `${environment.blobId}${extensionForFormat(envFormat)}` : '';
  const envPath = assetUrl(`dist-widget/env/${projectSlug}/${envFileName}`, envBytes);
  const envOversized = Boolean(environment) && envBytes > JSDELIVR_MAX_BYTES;
  const oversizedModels = models.filter((m) => m.fileSize > JSDELIVR_MAX_BYTES);

  const getEmbedCode = useCallback(() => {
    if (!project) return '';

    const mappedModels = models.map((m) => ({
      url: modelPath(m),
      position: m.position,
      rotation: m.rotation,
      scale: m.scale,
    }));

    const config: Record<string, unknown> = {
      mode: exportMode,
      transparent,
      background: transparent ? 'transparent' : project.settings.background,
      // Editor-only keyframe ids are of no use to the widget.
      keyframes: project.cameraPath.keyframes.map(({ position, lookAt }) => ({ position, lookAt })),
      isLoop: exportMode === 'loop' || project.cameraPath.isLoop,
      speed: project.cameraPath.speed,
      models: mappedModels,
    };

    const maxResolution = RESOLUTION_PRESETS.find((p) => p.id === resolutionId)?.resolution;
    if (maxResolution) {
      config.maxResolution = maxResolution;
    }

    // Rückwärtskompatibel: ältere Widget-Builds auf jsDelivr lesen nur modelUrl.
    if (mappedModels.length === 1) {
      config.modelUrl = mappedModels[0].url;
    }

    if (project.lights && project.lights.length) {
      config.lights = project.lights;
    }

    if (environment && includeEnv) {
      config.environment = {
        url: envPath,
        // Additive: an older widget bundle ignores it and falls back to sniffing
        // the URL, which is correct for every format it can decode.
        format: envFormat,
        showBackground: environment.showBackground,
        useForReflection: environment.useForReflection,
        intensity: environment.intensity,
        blurriness: environment.blurriness,
      };
    }

    const configStr = JSON.stringify(config);

    const markup =
      exportMode === 'scroll'
        ? `<!-- Web3D Studio Widget (Scroll) -->
<div id="web3d-widget-track" style="position:relative;height:300vh;">
  <div id="web3d-widget" style="position:sticky;top:0;width:100%;height:100vh;overflow:hidden;"></div>
</div>`
        : `<!-- Web3D Studio Widget -->
<div id="web3d-widget" style="width:100%;height:100vh;"></div>`;

    return `${markup}
<script>
(function () {
  var config = ${configStr};
  function boot() {
    if (!window.Web3DWidget) {
      console.error('[Web3DWidget] Script nicht geladen. jsDelivr liefert nur aus öffentlichen GitHub-Repos – Repo public machen oder Dateien woanders hosten.');
      return;
    }
    Web3DWidget.init('#web3d-widget', config);
  }
  var existing = document.querySelector('script[data-web3d-widget]');
  if (existing) { existing.addEventListener('load', boot); return; }
  var s = document.createElement('script');
  s.src = '${scriptUrl}';
  s.async = false;
  s.setAttribute('data-web3d-widget', '1');
  s.onload = boot;
  s.onerror = function () {
    console.error('[Web3DWidget] Script-URL nicht erreichbar:', s.src);
  };
  document.head.appendChild(s);
})();
<\/script>`;
  }, [project, exportMode, transparent, resolutionId, models, scriptUrl, baseUrl, environment, envFormat, includeEnv, envPath]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(getEmbedCode());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [getEmbedCode]);

  const downloadModel = useCallback(async (m: ModelEntry) => {
    const db = await getDB();
    const blob = await db.get('blobs', m.id);
    if (!blob) return;
    const url = URL.createObjectURL(new Blob([blob.data]));
    const a = document.createElement('a');
    a.href = url;
    a.download = modelFileName(m);
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const saveModelsToFolder = useCallback(async () => {
    if (!project || !models.length) return;
    setFolderStatus(null);
    setSavingFolder(true);
    try {
      const picker = (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker;
      const root = await picker({ mode: 'readwrite' });
      const projectDir = await root.getDirectoryHandle(projectSlug, { create: true });
      const db = await getDB();
      let count = 0;
      for (const m of models) {
        const blob = await db.get('blobs', m.id);
        if (!blob) continue;
        const handle = await projectDir.getFileHandle(modelFileName(m), { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Blob([blob.data]));
        await writable.close();
        count += 1;
      }
      setFolderStatus(`${count} Modell(e) in „${projectSlug}/" gespeichert.`);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setFolderStatus('Speichern fehlgeschlagen – nutze stattdessen den Einzel-Download.');
    } finally {
      setSavingFolder(false);
    }
  }, [project, models, projectSlug]);

  const downloadEnv = useCallback(async () => {
    if (!environment) return;
    const db = await getDB();
    const blob = await db.get('blobs', environment.blobId);
    if (!blob) return;
    const url = URL.createObjectURL(new Blob([blob.data]));
    const a = document.createElement('a');
    a.href = url;
    a.download = envFileName;
    a.click();
    URL.revokeObjectURL(url);
  }, [environment, envFileName]);

  const saveEnvToFolder = useCallback(async () => {
    if (!project || !environment) return;
    setEnvFolderStatus(null);
    try {
      const picker = (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker;
      const root = await picker({ mode: 'readwrite' });
      const projectDir = await root.getDirectoryHandle(projectSlug, { create: true });
      const db = await getDB();
      const blob = await db.get('blobs', environment.blobId);
      if (!blob) return;
      const handle = await projectDir.getFileHandle(envFileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Blob([blob.data]));
      await writable.close();
      setEnvFolderStatus(`Umgebung in „${projectSlug}/" gespeichert.`);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setEnvFolderStatus('Speichern fehlgeschlagen – nutze stattdessen den Download.');
    }
  }, [project, environment, projectSlug, envFileName]);

  const uploadToGitHub = useCallback(async () => {
    if (!project || !token || !owner || !repo) return;
    setUploading(true);
    setUploadError(null);
    const log: string[] = [];
    setUploadLog([]);
    try {
      const db = await getDB();
      // Track the newest commit; the last upload's commit contains every prior
      // file plus the widget bundle, so pinning to it serves a consistent set.
      let lastSha: string | undefined;

      for (const m of models) {
        const blob = await db.get('blobs', m.id);
        if (!blob) continue;
        const path = `dist-widget/models/${projectSlug}/${modelFileName(m)}`;
        lastSha =
          (await putFileToGitHub({
            owner,
            repo,
            branch,
            path,
            data: blob.data,
            token,
            message: `Upload widget model ${modelFileName(m)}`,
          })) ?? lastSha;
        log.push(`OK  ${path}`);
        setUploadLog([...log]);
      }

      if (environment && includeEnv) {
        const blob = await db.get('blobs', environment.blobId);
        if (blob) {
          const path = `dist-widget/env/${projectSlug}/${envFileName}`;
          lastSha =
            (await putFileToGitHub({
              owner,
              repo,
              branch,
              path,
              data: blob.data,
              token,
              message: `Upload widget environment ${envFileName}`,
            })) ?? lastSha;
          log.push(`OK  ${path}`);
          setUploadLog([...log]);
        }
      }

      if (!log.length) {
        log.push('Nichts hochzuladen – kein Modell und keine Umgebung vorhanden.');
      } else if (lastSha) {
        setDeployedSha(lastSha);
        log.push(
          `Fertig. Embed-URLs auf Commit ${lastSha.slice(0, 7)} gepinnt – sofort live, kein Cache-Delay.`,
        );
        log.push('Wichtig: Embed-Code unten neu kopieren, damit der Pin greift.');
      } else {
        log.push('Fertig. jsDelivr cacht @main bis zu 12h – ggf. erneut einbetten.');
      }
      setUploadLog([...log]);
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }, [project, token, owner, repo, branch, models, environment, includeEnv, projectSlug, envFileName]);

  if (!project) return null;

  const hasEnoughKeyframes = project.cameraPath.keyframes.length >= 2;
  const canUpload = Boolean(token && owner && repo) && (models.length > 0 || (environment && includeEnv));

  const activeMode = EXPORT_MODES.find((m) => m.id === exportMode) ?? EXPORT_MODES[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <GlassDialogContent size="lg">
        <GlassDialogHeader>
          <DialogTitle>Widget exportieren</DialogTitle>
          <DialogDescription>
            Generiere ein Embed-Snippet für Webflow, Slater oder dein eigenes Projekt.
          </DialogDescription>
        </GlassDialogHeader>

        {!hasEnoughKeyframes && (
          <Notice variant="warning" className="mx-6 mt-4 shrink-0">
            Dieses Projekt hat weniger als 2 Keyframes. Ohne Kamerafahrt bewegt sich die Kamera
            nicht. Erstelle zuerst im Keyframe-Editor mindestens 2 Keyframes.
          </Notice>
        )}

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="shrink-0 px-6 pt-4">
            <TabsList ref={tabsListRef} className="relative">
              <span
                aria-hidden
                className={cn(
                  'pointer-events-none absolute top-1 bottom-1 rounded-md bg-background shadow-sm transition-[left,width]',
                  DIALOG_TRANSITION,
                )}
                style={{ left: tabIndicator.left, width: tabIndicator.width }}
              />
              <TabsTrigger
                value="display"
                className="relative z-10 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                <Settings2 />
                <span className="hidden sm:inline">Anzeige</span>
              </TabsTrigger>
              <TabsTrigger
                value="hosting"
                className="relative z-10 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                <Cloud />
                <span className="hidden sm:inline">Hosting</span>
              </TabsTrigger>
              <TabsTrigger
                value="embed"
                className="relative z-10 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                <Code2 />
                <span className="hidden sm:inline">Embed-Code</span>
              </TabsTrigger>
            </TabsList>
          </div>

          <div
            className={cn(
              'overflow-x-hidden transition-[height]',
              DIALOG_TRANSITION,
              panelScrollable ? 'overflow-y-auto' : 'overflow-hidden',
            )}
            style={{ height: panelHeight }}
          >
            <div ref={panelRef} className="px-6 py-5">
              <div
                key={activeTab}
                role="tabpanel"
                className={cn(
                  'animate-in fade-in-0 duration-300 fill-mode-both motion-reduce:animate-none',
                  tabSlideDir >= 0 ? 'slide-in-from-right-2' : 'slide-in-from-left-2',
                )}
              >
            {/* Tab 1 – Anzeige: rein visuelle/verhaltensbezogene Optionen. */}
            {activeTab === 'display' && (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label>Abspielmodus</Label>
                <div className="flex flex-wrap gap-2">
                  {EXPORT_MODES.map((m) => (
                    <Button
                      key={m.id}
                      variant={exportMode === m.id ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setExportMode(m.id)}
                    >
                      {m.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{activeMode.hint}</p>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-0.5">
                  <Label htmlFor="export-transparent">Transparenter Hintergrund</Label>
                  <p className="text-xs text-muted-foreground">
                    {transparent
                      ? 'Zeigt die Seite hinter dem 3D-Widget durch.'
                      : 'Nutzt die Hintergrundfarbe aus der Welt-Einstellung.'}
                  </p>
                  {!transparent && (
                    <div className="flex items-center gap-2 pt-1">
                      <span
                        className="h-4 w-4 shrink-0 rounded-sm border border-border"
                        style={{ backgroundColor: project.settings.background }}
                        aria-hidden
                      />
                      <code className="text-xs text-foreground">{project.settings.background}</code>
                    </div>
                  )}
                </div>
                <Switch id="export-transparent" checked={transparent} onCheckedChange={setTransparent} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>Max. Render-Auflösung</Label>
                  <InfoHint>
                    Deckelt die interne Render-Auflösung. Das Widget füllt weiterhin den ganzen
                    Container (skaliert in der Größe mit), rendert aber nicht in nativer
                    4K/5K-Pixelzahl – das verhindert Ruckeln auf hochauflösenden Displays.
                  </InfoHint>
                </div>
                <div className="flex flex-wrap gap-2">
                  {RESOLUTION_PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      variant={resolutionId === preset.id ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setResolutionId(preset.id)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>

              {environment && (
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="export-include-env">HDRI / Umgebung einbeziehen</Label>
                    <p className="text-xs text-muted-foreground">
                      {environment.showBackground
                        ? 'Wird als Hintergrund und Spiegelung eingebettet.'
                        : 'Transparenter Hintergrund, Spiegelung im Modell bleibt erhalten.'}
                    </p>
                  </div>
                  <Switch id="export-include-env" checked={includeEnv} onCheckedChange={setIncludeEnv} />
                </div>
              )}
            </div>
            )}

            {/* Tab 2 – Hosting: Repo-Ziel, Upload und Asset-Dateien. */}
            {activeTab === 'hosting' && (
            <div className="space-y-6">
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>GitHub-Repo (für jsDelivr-Hosting)</Label>
                  <InfoHint variant="warning" label="Hinweis zum Repo">
                    jsDelivr kann nur aus <strong>öffentlichen</strong> GitHub-Repos laden. Ist dein
                    Repo privat, bekommst du 404 und nichts wird angezeigt. Entweder Repo auf Public
                    stellen oder Widget + Modelle in Webflow Assets hochladen und die URLs im
                    Embed-Code anpassen.
                  </InfoHint>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Owner</span>
                    <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="owner" />
                  </div>
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Repo</span>
                    <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="repo" />
                  </div>
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Branch</span>
                    <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch" />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Script wird geladen von{' '}
                  <code className="break-all text-foreground">{scriptUrl}</code>
                </p>
                {deployedSha && (
                  <p className="text-xs text-green-400">
                    Auf Commit <code className="text-foreground">{deployedSha.slice(0, 7)}</code> gepinnt –
                    unveränderliche URLs, kein jsDelivr-Cache-Problem.
                  </p>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="gh-token">Direkt nach GitHub hochladen</Label>
                  <InfoHint label="Token-Hinweis">
                    Token mit Schreibrecht auf <code>Contents</code> (Fine-grained: „Contents: Read
                    and write" für{' '}
                    <code>
                      {owner}/{repo}
                    </code>
                    , oder Classic-Token mit <code>repo</code>-Scope).
                  </InfoHint>
                </div>
                <Input
                  id="gh-token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="GitHub Personal Access Token"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Wird lokal in diesem Browser gespeichert und beim nächsten Export vorausgefüllt.
                </p>

                <Button
                  variant="default"
                  className="w-full"
                  disabled={!canUpload || uploading}
                  onClick={uploadToGitHub}
                >
                  {uploading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  {uploading
                    ? 'Lade hoch…'
                    : `Nach ${owner}/${repo} hochladen (Modelle${environment && includeEnv ? ' + HDRI' : ''})`}
                </Button>

                {uploadLog.length > 0 && (
                  <pre className="max-h-32 overflow-auto rounded-md bg-secondary p-2 text-[11px] text-green-400">
                    {uploadLog.join('\n')}
                  </pre>
                )}
                {uploadError && (
                  <Notice variant="error">Upload fehlgeschlagen: {uploadError}</Notice>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label>Modelle</Label>
                    <InfoHint label="Ablage-Hinweis">
                      {supportsFsAccess
                        ? 'Alternativ einzeln herunterladen und '
                        : 'Lade jedes Modell herunter und lege es '}
                      im Repo unter <code>dist-widget/models/{projectSlug}/</code> ablegen. Danach
                      committen &amp; pushen – jsDelivr liefert die Dateien aus.
                    </InfoHint>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {models.length} {models.length === 1 ? 'Modell' : 'Modelle'}
                  </span>
                </div>

                {models.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Keine Modelle im Projekt.</p>
                ) : (
                  <div className="space-y-1">
                    {models.map((m) => (
                      <div key={m.id} className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-xs">{m.name}</span>
                        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => downloadModel(m)}>
                          <Download className="mr-1 h-3.5 w-3.5" />
                          {modelFileName(m)}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {models.length > 0 && supportsFsAccess && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={savingFolder}
                    onClick={saveModelsToFolder}
                  >
                    <FolderDown className="mr-2 h-4 w-4" />
                    {savingFolder ? 'Speichere…' : 'Modelle in Ordner speichern'}
                  </Button>
                )}
                {folderStatus && <p className="text-xs text-green-400">{folderStatus}</p>}

                {oversizedModels.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-orange-400">
                    <span>
                      {oversizedModels.length === 1
                        ? '1 Modell über 20 MiB'
                        : `${oversizedModels.length} Modelle über 20 MiB`}
                    </span>
                    <InfoHint variant="warning" label="Große Modelle">
                      Dateien über 20&nbsp;MiB werden von jsDelivr mit 403 abgelehnt. Der Embed-Code
                      lädt sie daher über <code>raw.githubusercontent.com</code> (funktioniert, ist
                      aber kein CDN). Für schnelleres Laden im Szenenbaum über das Menü des Modells
                      „Optimieren“ ausführen — Texturen als WebP und Draco-Geometrie bringen ein
                      solches Modell in der Regel deutlich unter 20&nbsp;MiB.
                    </InfoHint>
                  </div>
                )}
              </div>

              {environment && includeEnv && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Label>HDRI / Umgebung</Label>
                      <InfoHint label="Ablage-Hinweis">
                        Datei im Repo unter <code>dist-widget/env/{projectSlug}/</code> ablegen.
                      </InfoHint>
                    </div>
                    <div className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs">{environment.fileName}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {formatBytes(envBytes)}
                          {environment.width ? ` · ${environment.width} × ${environment.height}` : ''}
                          {envFormat ? ` · ${ENVIRONMENT_FORMAT_LABEL[envFormat]}` : ''}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={downloadEnv}>
                        <Download className="mr-1 h-3.5 w-3.5" />
                        {envFileName}
                      </Button>
                    </div>
                    {envOversized && (
                      <div className="flex items-center gap-1.5 text-xs text-orange-400">
                        <span>HDRI über 20 MiB</span>
                        <InfoHint variant="warning" label="Große Umgebung">
                          Dateien über 20&nbsp;MiB werden von jsDelivr mit 403 abgelehnt. Der
                          Embed-Code lädt die Umgebung daher über{' '}
                          <code>raw.githubusercontent.com</code> (funktioniert, ist aber kein CDN).
                          Besser: die Umgebung im Eigenschaften-Panel über „Bild ersetzen“ auf
                          1024&nbsp;× 512 umrechnen.
                        </InfoHint>
                      </div>
                    )}
                    {envFormat === 'ultrahdr' && (
                      <Notice variant="warning">
                        <strong>Diese Umgebung ist ein Ultra HDR JPEG.</strong> Nur ein neu gebauter
                        Widget-Build kann sie mit vollem HDR-Bereich lesen. Führe{' '}
                        <code>npm run build:widget</code> aus und lade{' '}
                        <code>dist-widget/web3d-widget.iife.js</code> mit hoch – bereits eingebettete
                        Widgets zeigen sonst nur die flachere SDR-Basis.
                      </Notice>
                    )}
                    {supportsFsAccess && (
                      <Button variant="outline" size="sm" className="w-full" onClick={saveEnvToFolder}>
                        <FolderDown className="mr-2 h-4 w-4" />
                        Umgebung in Ordner speichern
                      </Button>
                    )}
                    {envFolderStatus && <p className="text-xs text-green-400">{envFolderStatus}</p>}
                  </div>
                </>
              )}
            </div>
            )}

            {/* Tab 3 – Embed-Code: das finale Deliverable mit primärer Kopieren-Aktion. */}
            {activeTab === 'embed' && (
            <div className="space-y-3">
              <Button className="w-full" onClick={handleCopy}>
                {copied ? (
                  <>
                    <Check className="mr-2 h-4 w-4" />
                    Kopiert
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-4 w-4" />
                    Embed-Code kopieren
                  </>
                )}
              </Button>
              <pre className="max-h-72 w-full overflow-auto rounded-lg bg-secondary p-4 text-xs">
                <code>{getEmbedCode()}</code>
              </pre>
              <p className="text-xs text-muted-foreground">
                Snippet in Webflow (Embed-Element), Slater oder direkt in dein HTML einfügen.
              </p>
            </div>
            )}
              </div>
            </div>
          </div>
        </Tabs>

        <GlassDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Schließen
          </Button>
        </GlassDialogFooter>
      </GlassDialogContent>
    </Dialog>
  );
}
