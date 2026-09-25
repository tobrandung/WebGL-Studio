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
import { ChoiceCard } from '@/components/ui/choice-card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  getDB,
  environmentFormat,
  type Project,
  type ModelEntry,
  type PlaybackMode,
} from '@/lib/db';
import type { EnvironmentFormat } from '@/lib/hdri/types';
import {
  ENVIRONMENT_CONTENT_TYPE,
  ENVIRONMENT_FORMAT_LABEL,
  extensionForFormat,
} from '@/lib/hdri/format';
import { uploadAsset, lookupAsset } from '@/lib/storage/client';
import { ApiError } from '@/lib/storage/api';
import { isHostingConfigured } from '@/lib/storage/config';
import { MAX_UPLOAD_BYTES } from '@/lib/storage/asset-key';
import { widgetScriptUrl, widgetRelease } from '@/lib/storage/widget-release';
import { cn, slugify, formatBytes } from '@/lib/utils';
import { InfoHint } from '@/components/ui/info-hint';
import { Alert, AlertDescription } from '@/components/ui/alert';

type ExportMode = PlaybackMode;
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
// die Voreinstellung. Reicht für die meisten Web-Einbettungen und verhindert,
// dass auf 4K/5K-Displays unnötig viele Pixel gerendert werden (Ruckeln).
const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: 'hd', label: 'HD (1280×720)', resolution: { width: 1280, height: 720 } },
  { id: 'fhd', label: 'Full HD (1920×1080)', resolution: { width: 1920, height: 1080 } },
  { id: 'qhd', label: '2K QHD (2560×1440)', resolution: { width: 2560, height: 1440 } },
  { id: 'uhd', label: '4K UHD (3840×2160)', resolution: { width: 3840, height: 2160 } },
  { id: 'unlimited', label: 'Unbegrenzt (nativ)', resolution: null },
];

const DEFAULT_RESOLUTION_ID = 'fhd';

/** One row of the upload log, so the UI can style outcomes rather than parse text. */
type UploadRow = {
  label: string;
  state: 'uploaded' | 'skipped' | 'failed';
  detail?: string;
};

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
  /**
   * Meldet die gewählte Abspielart zurück. Der Editor hält seine Kamerafahrt in
   * eigenem State und würde sie beim nächsten Speichern sonst wieder
   * überschreiben.
   */
  onPlaybackModeChange?: (mode: PlaybackMode) => void;
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

export function ExportDialog({
  open,
  onOpenChange,
  project,
  onPlaybackModeChange,
}: ExportDialogProps) {
  const [exportMode, setExportMode] = useState<ExportMode>('scroll');
  const projectId = project?.id ?? null;
  const storedMode = project?.cameraPath.playbackMode;

  // Die zuletzt gewählte Abspielart gehört zum Projekt, nicht zum Dialog: die
  // Vorschau soll dieselbe Fahrt zeigen wie das exportierte Widget.
  useEffect(() => {
    if (open) setExportMode(storedMode ?? 'scroll');
  }, [open, storedMode, projectId]);

  /**
   * Schreibt die Wahl sofort weg. Ohne Speichern-Klick, sonst zeigt die
   * Vorschau weiter die alte Abspielart. Read-modify-write direkt auf der DB,
   * damit parallel gehaltene Projektkopien nichts überschreiben.
   */
  const changeExportMode = useCallback(
    async (mode: ExportMode) => {
      setExportMode(mode);
      onPlaybackModeChange?.(mode);
      if (!projectId) return;
      const db = await getDB();
      const stored = await db.get('projects', projectId);
      if (!stored || stored.cameraPath.playbackMode === mode) return;
      await db.put('projects', {
        ...stored,
        cameraPath: { ...stored.cameraPath, playbackMode: mode },
        updatedAt: Date.now(),
      });
    },
    [projectId, onPlaybackModeChange],
  );
  const [transparent, setTransparent] = useState(true);
  const [resolutionId, setResolutionId] = useState(DEFAULT_RESOLUTION_ID);
  const [copied, setCopied] = useState(false);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [savingFolder, setSavingFolder] = useState(false);
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [includeEnv, setIncludeEnv] = useState(true);
  const [envBytes, setEnvBytes] = useState(0);
  const [envFolderStatus, setEnvFolderStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadLog, setUploadLog] = useState<UploadRow[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /**
   * Public CDN URL per asset, keyed by model id or environment blob id. Filled
   * on open for anything already published and on every successful upload; the
   * embed code is generated from it, so an unpublished project cannot produce a
   * snippet full of dead URLs.
   */
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  /** Current file and its byte progress, for the upload bar. */
  const [progress, setProgress] = useState<{ label: string; loaded: number; total: number } | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<ExportTab>('display');
  /** 1 = nach rechts, -1 = nach links. Steuert die Slide-Richtung des Contents. */
  const [tabSlideDir, setTabSlideDir] = useState(1);
  const [panelHeight, setPanelHeight] = useState<number | undefined>(undefined);
  const [panelScrollable, setPanelScrollable] = useState(false);
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  // Callback-Ref statt useRef: Radix mountet den Dialog-Inhalt erst in einem
  // späteren Commit, ein Layout-Effekt sähe hier also noch null.
  const [tabsList, setTabsList] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !project) return;
    // Jeder Export startet mit transparentem Hintergrund.
    setTransparent(true);
    (async () => {
      const db = await getDB();
      const all = await db.getAllFromIndex('models', 'by-project', project.id);
      setModels(all);
      // Deriving from the blob rather than only from `fileSize` keeps the number
      // right for environments stored before that field existed. Which is why
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

  // A fresh open starts from an empty log; the URLs are re-resolved below.
  useEffect(() => {
    if (open) return;
    setUploadLog([]);
    setUploadError(null);
    setAssetUrls({});
    setProgress(null);
  }, [open]);

  /**
   * Resolves which assets are already on the CDN.
   *
   * Content-addressed keys make this worth doing: an asset published in an
   * earlier session, or from a colleague's machine, is still there, so the
   * embed code can be copied straight away without pressing upload again. One
   * small request per asset, no bytes transferred.
   */
  useEffect(() => {
    if (!open || !project || !isHostingConfigured()) return;
    const keyed: Array<{ id: string; key: string }> = models
      .filter((m): m is ModelEntry & { assetKey: string } => Boolean(m.assetKey))
      .map((m) => ({ id: m.id, key: m.assetKey }));
    const env = project.environment;
    if (env?.assetKey) keyed.push({ id: env.blobId, key: env.assetKey });
    if (!keyed.length) return;

    let cancelled = false;
    (async () => {
      const found: Record<string, string> = {};
      for (const { id, key } of keyed) {
        try {
          const result = await lookupAsset(key);
          if (result.exists) found[id] = result.publicUrl;
        } catch {
          // Hosting unreachable or session expired: leave the asset pending.
          // Pressing upload surfaces the real error with a proper message.
          return;
        }
      }
      if (!cancelled && Object.keys(found).length) {
        setAssetUrls((prev) => ({ ...found, ...prev }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, project, models]);

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
    // panelHeight absichtlich nicht in deps. Sonst Endlosschleife.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- height sync on tab/content change only
  }, [open, activeTab, exportMode, resolutionId, transparent, includeEnv, models, project?.environment, uploading, uploadLog, uploadError, folderStatus, envFolderStatus, assetUrls, progress, copied, envBytes]);

  // Sliding Pill unter dem aktiven Tab.
  useLayoutEffect(() => {
    if (!open || !tabsList) return;
    const list = tabsList;

    const updateIndicator = () => {
      const active = list.querySelector<HTMLElement>('[data-state="active"]');
      // Breite 0 heißt, die Liste ist noch nicht ausgemessen. Diesen Wert zu
      // übernehmen hieße, den Indikator unsichtbar festzunageln.
      if (!active || active.offsetWidth === 0) return;
      setTabIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    };

    updateIndicator();
    // Ein einzelner Frame reichte beim ersten Öffnen nicht: der Dialog hatte
    // seine Breite noch nicht, die Messung ergab 0, und weil der Effekt nur an
    // `open` und `activeTab` hängt, blieb der Indikator unsichtbar, bis ein
    // Tab-Wechsel neu gemessen hat. Der Observer misst, sobald die Liste
    // tatsächlich Platz bekommt, und hält den Indikator auch beim Skalieren
    // des Fensters an der richtigen Stelle.
    const observer = new ResizeObserver(updateIndicator);
    observer.observe(list);
    return () => observer.disconnect();
  }, [open, activeTab, tabsList]);

  const handleTabChange = useCallback((next: string) => {
    const nextTab = next as ExportTab;
    const prevIdx = EXPORT_TABS.indexOf(activeTab);
    const nextIdx = EXPORT_TABS.indexOf(nextTab);
    setTabSlideDir(nextIdx >= prevIdx ? 1 : -1);
    setActiveTab(nextTab);
  }, [activeTab]);

  const projectSlug = project ? slugify(project.name) : '';
  const scriptUrl = widgetScriptUrl();
  // Sprechender, dateisystem- und URL-sicherer Name: Modellname (slugifiziert,
  // gekürzt) + Erstell-Zeitstempel für Eindeutigkeit. Nur noch Anzeige- und
  // Download-Name. Die CDN-URL wird über den Content-Hash gebildet.
  const modelFileName = (m: ModelEntry) =>
    `${slugify(m.name).slice(0, 40)}-${formatStamp(m.createdAt)}.${fileExtension(m.fileName)}`;
  const environment = project?.environment ?? null;
  const envFormat = environment ? environmentFormat(environment) : null;
  // Derive the extension from the format, not from the stored name: an Ultra HDR
  // file must keep its `.uhdr.jpg` marker so a widget that only sees the URL
  // still picks the right decoder.
  const envFileName = environment && envFormat ? `${environment.blobId}${extensionForFormat(envFormat)}` : '';
  const envUrl = environment ? assetUrls[environment.blobId] : undefined;

  // Which assets still have to be published before a snippet can be generated.
  const pendingModels = models.filter((m) => !assetUrls[m.id]);
  const envPending = Boolean(environment && includeEnv && !envUrl);
  const oversized = [
    ...models.filter((m) => m.fileSize > MAX_UPLOAD_BYTES).map((m) => m.name),
    ...(environment && includeEnv && envBytes > MAX_UPLOAD_BYTES ? [environment.fileName] : []),
  ];
  const hostingOn = isHostingConfigured();
  const canUpload = hostingOn && !oversized.length && (models.length > 0 || Boolean(environment && includeEnv));
  const embedReady =
    models.length > 0 && pendingModels.length === 0 && !envPending && Boolean(scriptUrl);

  const getEmbedCode = useCallback(() => {
    if (!project) return '';
    if (!embedReady) {
      return '// Erst im Tab „Hosting" hochladen. Danach steht hier der Embed-Code.';
    }

    const mappedModels = models.map((m) => ({
      url: assetUrls[m.id],
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

    // Rückwärtskompatibel: ältere Widget-Builds lesen nur modelUrl.
    if (mappedModels.length === 1) {
      config.modelUrl = mappedModels[0].url;
    }

    if (project.lights && project.lights.length) {
      config.lights = project.lights;
    }

    if (project.planes && project.planes.length) {
      config.planes = project.planes;
    }

    if (environment && includeEnv) {
      config.environment = {
        url: envUrl,
        // Additive: an older widget bundle ignores it and falls back to sniffing
        // the URL, which is correct for every format it can decode.
        format: envFormat,
        // A transparent export wins over the scene's own setting: the widget
        // applies the environment after clearing the background, so leaving
        // this true would paint the HDRI back over the transparency and the
        // toggle above would silently do nothing.
        showBackground: environment.showBackground && !transparent,
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
      console.error('[Web3DWidget] Script nicht geladen. CDN nicht erreichbar oder von einem Blocker unterdrückt.');
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
  }, [project, embedReady, exportMode, transparent, resolutionId, models, assetUrls, scriptUrl, environment, envFormat, includeEnv, envUrl]);

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
      setFolderStatus('Speichern fehlgeschlagen. Nutze stattdessen den Einzel-Download.');
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
      setEnvFolderStatus('Speichern fehlgeschlagen. Nutze stattdessen den Download.');
    }
  }, [project, environment, projectSlug, envFileName]);

  /**
   * Publishes every asset of this project and records its public URL.
   *
   * Each file is hashed, checked against the CDN, and only transferred when it
   * is genuinely new. So re-exporting after a tweak to the camera path uploads
   * nothing at all. The resulting `assetKey` is written back onto the record,
   * which is what lets the next open resolve URLs without hashing again and
   * what lets another machine load the project's models at all.
   */
  const uploadAssets = useCallback(async () => {
    if (!project) return;
    setUploading(true);
    setUploadError(null);
    setUploadLog([]);
    setProgress(null);

    const rows: UploadRow[] = [];
    const pushRow = (row: UploadRow) => {
      rows.push(row);
      setUploadLog([...rows]);
    };

    try {
      const db = await getDB();

      const targets: Array<{
        id: string;
        label: string;
        contentType: string;
        extension: string;
        /** Writes the key back onto its owning record. */
        persist: (key: string) => Promise<void>;
      }> = models.map((m) => ({
        id: m.id,
        label: modelFileName(m),
        contentType: 'model/gltf-binary',
        extension: fileExtension(m.fileName),
        persist: async (key) => {
          const current = await db.get('models', m.id);
          if (current) await db.put('models', { ...current, assetKey: key });
        },
      }));

      if (environment && includeEnv && envFormat) {
        targets.push({
          id: environment.blobId,
          label: envFileName,
          contentType: ENVIRONMENT_CONTENT_TYPE[envFormat],
          // extensionForFormat includes the dot; the key grammar does not.
          extension: extensionForFormat(envFormat).slice(1),
          persist: async (key) => {
            const current = await db.get('projects', project.id);
            if (current?.environment) {
              await db.put('projects', {
                ...current,
                environment: { ...current.environment, assetKey: key },
              });
            }
          },
        });
      }

      if (!targets.length) {
        pushRow({ label: 'Nichts hochzuladen', state: 'skipped', detail: 'Kein Modell, keine Umgebung.' });
        return;
      }

      const publishedKeys: Record<string, string> = {};
      for (const target of targets) {
        const blob = await db.get('blobs', target.id);
        if (!blob) {
          pushRow({ label: target.label, state: 'failed', detail: 'Datei lokal nicht gefunden.' });
          continue;
        }

        setProgress({ label: target.label, loaded: 0, total: blob.data.byteLength });
        const ref = await uploadAsset(
          {
            data: blob.data,
            contentType: target.contentType,
            extension: target.extension,
          },
          (loaded, total) => setProgress({ label: target.label, loaded, total }),
        );

        publishedKeys[target.id] = ref.key;
        setAssetUrls((prev) => ({ ...prev, [target.id]: ref.url }));
        await target.persist(ref.key);
        pushRow({
          label: target.label,
          state: ref.skipped ? 'skipped' : 'uploaded',
          detail: ref.skipped ? 'unverändert, bereits im CDN' : formatBytes(blob.data.byteLength),
        });
      }

      // Keep the in-memory model list in step with the keys just persisted, so
      // reopening the dialog without a remount still recognises them as
      // published rather than offering to upload again.
      setModels((prev) =>
        prev.map((m) => (publishedKeys[m.id] ? { ...m, assetKey: publishedKeys[m.id] } : m)),
      );
    } catch (err) {
      setUploadError(
        err instanceof ApiError ? err.message : `Upload fehlgeschlagen: ${(err as Error).message}`,
      );
    } finally {
      setProgress(null);
      setUploading(false);
    }
  }, [project, models, environment, includeEnv, envFormat, envFileName]);

  if (!project) return null;

  const hasEnoughKeyframes = project.cameraPath.keyframes.length >= 2;

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
          <Alert variant="warning" className="mx-6 mt-4 shrink-0">
            <AlertDescription>
              Dieses Projekt hat weniger als 2 Keyframes. Ohne Kamerafahrt bewegt sich die Kamera
              nicht. Erstelle zuerst im Keyframe-Editor mindestens 2 Keyframes.
            </AlertDescription>
          </Alert>
        )}

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="shrink-0 px-6 pt-4">
            <TabsList ref={setTabsList} className="relative">
              {/* Erst ab der ersten gültigen Messung im DOM, sonst würde der
                  Indikator beim Öffnen sichtbar von Breite 0 aufziehen. */}
              {tabIndicator.width > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute top-1 bottom-1 rounded-md bg-background shadow-sm transition-[left,width]',
                    DIALOG_TRANSITION,
                  )}
                  style={{ left: tabIndicator.left, width: tabIndicator.width }}
                />
              )}
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
            {/* Tab 1. Anzeige: rein visuelle/verhaltensbezogene Optionen. */}
            {activeTab === 'display' && (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label>Abspielmodus</Label>
                <div className="flex flex-wrap gap-2">
                  {EXPORT_MODES.map((m) => (
                    <Button
                      key={m.id}
                      variant="outline"
                      className={cn(exportMode === m.id && 'active-surface')}
                      size="sm"
                      onClick={() => void changeExportMode(m.id)}
                    >
                      {m.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{activeMode.hint}</p>
              </div>

              <ChoiceCard
                id="export-transparent"
                label="Transparenter Hintergrund"
                description={
                  transparent
                    ? 'Zeigt die Seite hinter dem 3D-Widget durch.'
                    : 'Nutzt die Hintergrundfarbe aus der Welt-Einstellung.'
                }
                checked={transparent}
                onCheckedChange={setTransparent}
              >
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
              </ChoiceCard>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>Max. Render-Auflösung</Label>
                  <InfoHint>
                    Deckelt die interne Render-Auflösung. Das Widget füllt weiterhin den ganzen
                    Container (skaliert in der Größe mit), rendert aber nicht in nativer
                    4K/5K-Pixelzahl. Das verhindert Ruckeln auf hochauflösenden Displays.
                  </InfoHint>
                </div>
                <div className="flex flex-wrap gap-2">
                  {RESOLUTION_PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      variant="outline"
                      className={cn(resolutionId === preset.id && 'active-surface')}
                      size="sm"
                      onClick={() => setResolutionId(preset.id)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>

              {environment && (
                <ChoiceCard
                  id="export-include-env"
                  label="HDRI / Umgebung einbeziehen"
                  description={
                    transparent
                      ? 'Licht und Spiegelung'
                      : environment.showBackground
                        ? 'Wird als Hintergrund und Spiegelung eingebettet.'
                        : 'Nur Licht und Spiegelung, kein Hintergrund.'
                  }
                  checked={includeEnv}
                  onCheckedChange={setIncludeEnv}
                />
              )}
            </div>
            )}

            {/* Tab 2. Hosting: Upload ins CDN und die Asset-Dateien. */}
            {activeTab === 'hosting' && (
            <div className="space-y-6">
              {!hostingOn ? (
                <Alert variant="warning">
                  <AlertDescription>
                    Hosting ist in diesem Build deaktiviert (<code>VITE_ASSET_HOSTING=off</code>).
                    Lade die Dateien unten herunter und binde sie von deinem eigenen Speicher ein.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>Veröffentlichen</Label>
                    <InfoHint label="Wie das Hosting funktioniert">
                      Jede Datei wird über ihren Inhalt benannt (SHA-256) und dauerhaft
                      unveränderlich ausgeliefert. Zwei Folgen: identische Dateien werden nie
                      zweimal übertragen, und eine einmal eingebettete URL kann später nicht
                      kaputtgehen. Maximal {MAX_UPLOAD_BYTES / 1024 / 1024}&nbsp;MB pro Datei.
                    </InfoHint>
                  </div>

                  {oversized.length > 0 && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {oversized.length === 1
                          ? `„${oversized[0]}" ist größer als ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`
                          : `${oversized.length} Dateien sind größer als ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`}{' '}
                        und können nicht veröffentlicht werden. Im Szenenbaum über das Menü des
                        Modells „Optimieren“ ausführen. WebP-Texturen und Draco-Geometrie bringen
                        ein solches Modell in der Regel deutlich darunter.
                      </AlertDescription>
                    </Alert>
                  )}

                  <Button
                    variant="default"
                    className="w-full"
                    disabled={!canUpload || uploading}
                    onClick={uploadAssets}
                  >
                    {uploading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-4 w-4" />
                    )}
                    {uploading
                      ? 'Lade hoch…'
                      : `Veröffentlichen (${models.length} ${models.length === 1 ? 'Modell' : 'Modelle'}${environment && includeEnv ? ' + HDRI' : ''})`}
                  </Button>

                  {progress && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="min-w-0 truncate">{progress.label}</span>
                        <span className="shrink-0 tabular-nums">
                          {formatBytes(progress.loaded)} / {formatBytes(progress.total)}
                        </span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-150"
                          style={{
                            width: `${progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {uploadLog.length > 0 && (
                    <div className="max-h-36 space-y-1 overflow-auto rounded-md bg-secondary p-2">
                      {uploadLog.map((row, index) => (
                        <div key={`${row.label}-${index}`} className="flex items-center gap-2 text-[11px]">
                          {row.state === 'failed' ? (
                            <AlertTriangle className="h-3 w-3 shrink-0 text-red-400" />
                          ) : (
                            <Check
                              className={cn(
                                'h-3 w-3 shrink-0',
                                row.state === 'uploaded' ? 'text-green-400' : 'text-muted-foreground',
                              )}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate">{row.label}</span>
                          {row.detail && (
                            <span className="shrink-0 text-muted-foreground">{row.detail}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {uploadError && (
                    <Alert variant="destructive">
                      <AlertDescription>{uploadError}</AlertDescription>
                    </Alert>
                  )}

                  {embedReady && !uploading && (
                    <p className="text-xs text-green-400">
                      Alle Assets veröffentlicht. Der Embed-Code im nächsten Tab ist fertig.
                    </p>
                  )}
                  {!scriptUrl && (
                    <Alert variant="warning">
                      <AlertDescription>
                        Das Widget-Bundle ist noch nicht veröffentlicht. Einmal{' '}
                        <code>npm run publish:widget</code> ausführen. Danach steht seine URL fest
                        und ältere Embeds bleiben auf ihrer Version.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label>Modelle</Label>
                    <InfoHint label="Ablage-Hinweis">
                      Veröffentlichen erledigt der Button oben. Der Download hier ist für den Fall,
                      dass eine Datei in ein fremdes Hosting soll, etwa Webflow Assets, oder du
                      sie archivieren willst.
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
                        <span
                          className={cn(
                            'shrink-0 text-[11px]',
                            assetUrls[m.id] ? 'text-green-400' : 'text-muted-foreground',
                          )}
                        >
                          {assetUrls[m.id] ? 'veröffentlicht' : formatBytes(m.fileSize)}
                        </span>
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

              </div>

              {environment && includeEnv && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Label>HDRI / Umgebung</Label>
                      <InfoHint label="Ablage-Hinweis">
                        Wird zusammen mit den Modellen veröffentlicht. Der Download ist nur für
                        fremdes Hosting oder zum Archivieren gedacht.
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
                      {envUrl && (
                        <span className="shrink-0 text-[11px] text-green-400">veröffentlicht</span>
                      )}
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={downloadEnv}>
                        <Download className="mr-1 h-3.5 w-3.5" />
                        {envFileName}
                      </Button>
                    </div>
                    {envFormat === 'ultrahdr' && (
                      <Alert variant="warning">
                        <AlertDescription>
                          <strong>Diese Umgebung ist ein Ultra HDR JPEG.</strong> Nur ein Widget-Build
                          ab Version {widgetRelease().version ?? '–'} liest sie mit vollem
                          HDR-Bereich. Bereits eingebettete, ältere Widgets zeigen weiterhin die
                          flachere SDR-Basis. Sie sind auf ihre Bundle-Version gepinnt.
                        </AlertDescription>
                      </Alert>
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

            {/* Tab 3. Embed-Code: das finale Deliverable mit primärer Kopieren-Aktion. */}
            {activeTab === 'embed' && (
            <div className="space-y-3">
              {!embedReady && (
                <Alert variant="warning">
                  <AlertDescription>
                    {models.length === 0
                      ? 'Dieses Projekt hat kein Modell. Es gibt nichts einzubetten.'
                      : !scriptUrl
                        ? 'Das Widget-Bundle ist noch nicht veröffentlicht. Einmal npm run publish:widget ausführen.'
                        : `Noch nicht veröffentlicht: ${[
                            ...pendingModels.map((m) => m.name),
                            ...(envPending ? ['HDRI / Umgebung'] : []),
                          ].join(', ')}. Im Tab „Hosting" veröffentlichen. Erst dann enthält das Snippet echte URLs.`}
                  </AlertDescription>
                </Alert>
              )}
              <Button className="w-full" disabled={!embedReady} onClick={handleCopy}>
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
