import { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogReveal,
  DialogTitle,
  GlassDialogBody,
  GlassDialogContent,
  GlassDialogFooter,
  GlassDialogHeader,
} from '@/components/ui/glass-dialog';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { InfoHint } from '@/components/ui/info-hint';
import { SizeBudgetBar } from '@/components/environment/SizeBudgetBar';
import { CompareCanvas } from '@/components/model/CompareCanvas';
import { useModelOptimizer } from '@/hooks/useModelOptimizer';
import { formatSaving } from '@/lib/format';
import { formatBytes } from '@/lib/utils';
import type { MaxTextureSize, TextureFormat } from '@/lib/optimize/types';

const MAX_SIZES: MaxTextureSize[] = [512, 1024, 2048, 4096];

/** Above these, holding the model twice on the GPU is not worth the risk. */
const PREVIEW_GPU_LIMIT = 384 * 1024 * 1024;
const PREVIEW_FILE_LIMIT = 60 * 1024 * 1024;

type OptimizeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name shown in the header; the model's, or the pending file's. */
  modelName: string;
  /** True when this is a file on its way in rather than a model already in the scene. */
  importing?: boolean;
  /** Source GLB. Transferred to the worker, so pass a copy you don't reuse. */
  source: ArrayBuffer | null;
  onConfirm: (buffer: ArrayBuffer) => void;
};

/** One before/after line of the byte breakdown. */
function BreakdownRow({
  label,
  before,
  after,
  estimated,
  hint,
}: {
  label: string;
  before: number;
  after?: number;
  /** Marks the "after" value as calculated rather than encoded. */
  estimated?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="flex items-center gap-1 text-muted-foreground">
        {label}
        {hint}
      </span>
      <span className="font-mono tabular-nums">
        <span className="text-muted-foreground">{formatBytes(before)}</span>
        {after !== undefined && (
          <>
            <span className="mx-1 text-muted-foreground">→</span>
            <span className={estimated ? 'text-muted-foreground' : undefined}>
              {estimated ? '≈ ' : ''}
              {formatBytes(after)}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

export function OptimizeDialog({
  open,
  onOpenChange,
  modelName,
  importing = false,
  source,
  onConfirm,
}: OptimizeDialogProps) {
  // The worker takes ownership of what it is given, so it gets a copy and
  // `source` stays intact for the left-hand side of the comparison. Only
  // handed over while the dialog is open, so closing it terminates the worker
  // and releases the parsed Document.
  const [active, setActive] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    setActive(open && source ? source.slice(0) : null);
  }, [open, source]);

  /**
   * Two live copies of a heavy model can exceed what a laptop GPU has: the
   * textures alone are 4 bytes per pixel plus mipmaps once decoded, whatever
   * the file costs on disk. Past that the comparison is dropped rather than
   * risking a lost context. And the panel says so.
   */
  const [degraded, setDegraded] = useState(false);
  const optimizer = useModelOptimizer(active, { preview: !degraded });
  const { analysis, size, settings, setSettings, status, error, progress, preview, notes } =
    optimizer;

  useEffect(() => {
    if (!analysis) return;
    setDegraded(analysis.gpuBytes > PREVIEW_GPU_LIMIT || analysis.fileSize > PREVIEW_FILE_LIMIT);
  }, [analysis]);

  const busy = status === 'opening' || status === 'measuring' || status === 'finishing';
  const estimated = size ? !size.measured : false;
  const sourceBytes = analysis?.fileSize ?? 0;
  const resultBytes = size?.total;

  const handleConfirm = async () => {
    const buffer = await optimizer.finish();
    if (buffer) {
      onConfirm(buffer);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <GlassDialogContent size="xl">
        <GlassDialogHeader>
          <DialogTitle>{importing ? 'Beim Import optimieren' : 'Modell optimieren'}</DialogTitle>
          <DialogDescription>
            Komprimiert Texturen und Geometrie von „{modelName}“
            {importing ? ' und fügt das Ergebnis der Szene hinzu' : ''}. Aufräumen (ungenutzte
            Daten entfernen, Duplikate zusammenlegen) läuft immer mit.
          </DialogDescription>
        </GlassDialogHeader>

        <GlassDialogBody className="space-y-4">
          {/* Settings left, result right. Two columns only from `lg`, where the
              dialog is actually wide enough for both; below that the same
              blocks stack, which is what a narrow window gets. */}
          <div className="grid gap-5 lg:grid-cols-[21rem_minmax(0,1fr)]">
            <div className="min-w-0 space-y-4">
              <section className="space-y-3 rounded-lg border p-3">
                <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Texturen
                </p>

                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs">Format</Label>
                  <ToggleGroup
                    type="single"
                    size="sm"
                    value={settings.textureFormat}
                    onValueChange={(value) =>
                      value && setSettings({ textureFormat: value as TextureFormat })
                    }
                  >
                    <ToggleGroupItem value="webp" className="px-3 text-xs">
                      WebP
                    </ToggleGroupItem>
                    <ToggleGroupItem value="keep" className="px-3 text-xs">
                      unverändert
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <Label className="flex items-center gap-1 text-xs">
                    Max. Größe
                    <InfoHint label="Maximale Texturgröße">
                      Die einzige Einstellung, die auch den GPU-Speicher senkt, und zwar
                      quadratisch. Das Format ändert nur die Dateigröße, im Speicher der
                      Grafikkarte liegt jede Textur unkomprimiert.
                    </InfoHint>
                  </Label>
                  <ToggleGroup
                    type="single"
                    size="sm"
                    value={String(settings.maxTextureSize)}
                    onValueChange={(value) =>
                      value && setSettings({ maxTextureSize: Number(value) as MaxTextureSize })
                    }
                  >
                    {MAX_SIZES.map((size) => (
                      <ToggleGroupItem key={size} value={String(size)} className="px-2 text-xs">
                        {size}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-1 text-xs">
                      Qualität
                      <InfoHint label="Textur-Qualität">
                        Normal-Maps werden von diesem Regler ausgenommen und immer mit hoher
                        Qualität gespeichert. Sie enthalten Richtungsvektoren, keine Farben, und
                        zeigen Kompressionsfehler als Streifen im Glanzlicht.
                      </InfoHint>
                    </Label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {Math.round(settings.textureQuality * 100)} %
                    </span>
                  </div>
                  <Slider
                    min={40}
                    max={100}
                    step={5}
                    value={[Math.round(settings.textureQuality * 100)]}
                    onValueChange={([value]) => setSettings({ textureQuality: value / 100 })}
                    disabled={settings.textureFormat === 'keep'}
                    aria-label="Textur-Qualität"
                  />
                </div>
              </section>

              <section className="space-y-2 rounded-lg border p-3">
                <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Geometrie
                </p>
                <div className="flex items-center justify-between">
                  <Label htmlFor="optimize-draco" className="flex items-center gap-1 text-xs">
                    Komprimieren (Draco)
                    <InfoHint label="Draco">
                      Verkleinert die Geometrie typisch um das Vier- bis Achtfache. Die Positionen
                      werden dabei quantisiert. In der Praxis nicht sichtbar. Der Editor, die
                      Vorschau und das Widget können Draco bereits laden.
                    </InfoHint>
                  </Label>
                  <Switch
                    id="optimize-draco"
                    checked={settings.draco}
                    onCheckedChange={(value) => setSettings({ draco: value })}
                  />
                </div>
              </section>

              {/* Sits with the setting it is about, not with the results. */}
              {settings.textureFormat === 'webp' && (
                <DialogReveal className="text-[11px] leading-relaxed text-muted-foreground">
                  WebP-Texturen brauchen die glTF-Erweiterung <code>EXT_texture_webp</code>.
                  Editor, Vorschau und Widget können das. Ältere Viewer und manche DCC-Importer
                  nicht. Wenn du die Datei auch außerhalb weitergibst, ist „unverändert“ die
                  portablere Wahl.
                </DialogReveal>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              {analysis && (
                <CompareCanvas
                  original={source}
                  optimized={preview}
                  degraded={degraded}
                  busy={status === 'measuring'}
                  className="h-56 lg:h-72"
                />
              )}

              {analysis && (
                <DialogReveal className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm">
                      <span className="text-muted-foreground">{formatBytes(sourceBytes)}</span>
                      <span className="mx-1.5 text-muted-foreground">→</span>
                      <span
                        className={estimated ? 'font-medium text-muted-foreground' : 'font-medium'}
                      >
                        {resultBytes !== undefined
                          ? `${estimated ? '≈ ' : ''}${formatBytes(resultBytes)}`
                          : '–'}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {/* Spinner while the encoder catches up, so a number that
                          has not settled yet never reads as final. */}
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                      {resultBytes !== undefined && `−${formatSaving(resultBytes, sourceBytes)}`}
                    </span>
                  </div>

                  <SizeBudgetBar
                    sourceBytes={sourceBytes}
                    resultBytes={resultBytes}
                    resultLabel="Optimiert"
                    subject="das Modell"
                  />

                  <div className="space-y-1 pt-1">
                    <BreakdownRow
                      label="Texturen"
                      before={analysis.textureBytes}
                      after={size?.textureBytes}
                      estimated={estimated}
                    />
                    <BreakdownRow
                      label="Geometrie"
                      before={analysis.geometryBytes}
                      after={size?.geometryBytes}
                      estimated={estimated}
                    />
                    <BreakdownRow
                      label="GPU-Speicher"
                      before={analysis.gpuBytes}
                      after={size?.gpuBytes}
                      estimated={estimated}
                      hint={
                        <InfoHint label="GPU-Speicher">
                          Was die Texturen entpackt auf der Grafikkarte belegen. Nur die maximale
                          Texturgröße senkt diesen Wert. WebP verkleinert ausschließlich die
                          Datei.
                        </InfoHint>
                      }
                    />
                  </div>
                </DialogReveal>
              )}

              {progress && (
                <div className="space-y-1.5">
                  <Progress value={Math.round(progress.progress * 100)} />
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {progress.label}
                  </p>
                </div>
              )}
            </div>
          </div>

          {notes.length > 0 && (
            <DialogReveal>
              <Alert variant="warning">
                <AlertDescription>
                  <ul className="space-y-0.5">
                    {notes.map((note, index) => (
                      <li key={`${index}-${note}`}>{note}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            </DialogReveal>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </GlassDialogBody>

        <GlassDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          {/* Enabled as soon as the document is open: confirming runs a final
              encode anyway, so there is no reason to wait for a measurement. */}
          <Button disabled={busy || !analysis} onClick={handleConfirm}>
            {status === 'finishing' ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-3.5 w-3.5" />
            )}
            {importing ? 'Optimieren & hinzufügen' : 'Optimieren'}
          </Button>
        </GlassDialogFooter>
      </GlassDialogContent>
    </Dialog>
  );
}
