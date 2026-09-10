import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Image as ImageIcon, Loader2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  GlassDialogBody,
  GlassDialogContent,
  GlassDialogFooter,
  GlassDialogHeader,
} from '@/components/ui/glass-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Notice } from '@/components/ui/notice';
import { InfoHint } from '@/components/ui/info-hint';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SizeBudgetBar } from '@/components/environment/SizeBudgetBar';
import { PresetLibrary } from '@/components/environment/PresetLibrary';
import { useHdriConverter } from '@/hooks/useHdriConverter';
import {
  BUDGET_GOOD,
  BUDGET_OK,
  RESOLUTION_SEVERE,
  RESOLUTION_WARN,
  textureBytes,
} from '@/lib/hdri/budget';
import { ACCEPTED_ENVIRONMENT_EXTENSIONS, ENVIRONMENT_FORMAT_LABEL } from '@/lib/hdri/format';
import {
  FORMAT_HINT,
  FORMAT_LABEL,
  availableFormats,
  availableWidths,
  parseTargetKey,
  targetKey,
  type TargetKey,
} from '@/lib/hdri/targets';
import { HDRI_PRESETS } from '@/lib/hdri/presets.generated';
import type { EnvironmentFormat, HdriPreset } from '@/lib/hdri/types';
import type { EnvironmentConfig } from '@/lib/db';
import { formatBytes } from '@/lib/utils';
import { formatSaving } from '@/lib/format';

/** What the dialog hands back once the user commits. */
export type EnvironmentUploadResult = {
  file: File;
  format: EnvironmentFormat;
  width: number;
  height: number;
  /** Name of the file the user picked, when conversion renamed it. */
  sourceFileName?: string;
  presetId?: string;
};

type EnvironmentUploadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Awaited before the dialog closes, so a failed write (a full IndexedDB, say)
   * surfaces here instead of closing on a lie.
   */
  onUpload: (result: EnvironmentUploadResult) => Promise<void>;
  /** Present when replacing — drives the copy and the recommended resolution. */
  current?: EnvironmentConfig | null;
};

const ACCEPT = ACCEPTED_ENVIRONMENT_EXTENSIONS.join(',');

export function EnvironmentUploadDialog({
  open,
  onOpenChange,
  onUpload,
  current,
}: EnvironmentUploadDialogProps) {
  const [dragOver, setDragOver] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState('');
  const [tab, setTab] = useState<'upload' | 'library'>('upload');
  const inputRef = useRef<HTMLInputElement>(null);

  const showBackground = current?.showBackground ?? false;
  const converter = useHdriConverter(showBackground);
  const { file, probe, status, recommendation, selected, progress, variants } = converter;

  // With no environment yet, start on the zero-cost, already-optimised path.
  useEffect(() => {
    if (open) setTab(current ? 'upload' : HDRI_PRESETS.length ? 'library' : 'upload');
  }, [open, current]);

  const reset = useCallback(() => {
    converter.reset();
    setDragOver(false);
    setCommitError('');
    setCommitting(false);
  }, [converter]);

  const selectedVariant = selected ? variants.get(selected) : undefined;
  const resultBytes = selectedVariant?.blob.size;

  const widths = useMemo(() => (probe?.width ? availableWidths(probe.width) : []), [probe?.width]);
  const formats = useMemo(() => (probe ? availableFormats(probe.format) : []), [probe]);
  const activeFormat = selected ? parseTargetKey(selected).format : null;
  const activeWidth = selected ? parseTargetKey(selected).width : null;

  const commit = useCallback(
    async (result: EnvironmentUploadResult) => {
      setCommitError('');
      setCommitting(true);
      try {
        await onUpload(result);
        reset();
        onOpenChange(false);
      } catch (cause) {
        const message = (cause as Error)?.name === 'QuotaExceededError'
          ? 'Speicher voll – der Browser kann die Datei nicht ablegen. Rechne sie kleiner oder lösche ein anderes Projekt.'
          : `Übernehmen fehlgeschlagen: ${(cause as Error).message}`;
        setCommitError(message);
      } finally {
        setCommitting(false);
      }
    },
    [onUpload, onOpenChange, reset],
  );

  const commitOriginal = useCallback(() => {
    if (!file) return;
    void commit({
      file,
      format: probe?.format ?? 'sdr',
      width: probe?.width ?? 0,
      height: probe?.height ?? 0,
    });
  }, [commit, file, probe]);

  const commitConverted = useCallback(() => {
    if (!file || !selectedVariant) return;
    const converted = new File([selectedVariant.blob], selectedVariant.fileName, {
      type: selectedVariant.blob.type,
    });
    void commit({
      file: converted,
      format: selectedVariant.format === 'webp' ? 'sdr' : selectedVariant.format,
      width: selectedVariant.width,
      height: selectedVariant.height,
      sourceFileName: file.name,
    });
  }, [commit, file, selectedVariant]);

  const usePreset = useCallback(
    async (preset: HdriPreset) => {
      setCommitError('');
      setCommitting(true);
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}hdri/${preset.file}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const presetFile = new File([blob], preset.file, { type: 'image/vnd.radiance' });
        await onUpload({
          file: presetFile,
          format: preset.format,
          width: preset.width,
          height: preset.height,
          presetId: preset.id,
        });
        reset();
        onOpenChange(false);
      } catch (cause) {
        setCommitError(`Standard-HDRI konnte nicht geladen werden: ${(cause as Error).message}`);
      } finally {
        setCommitting(false);
      }
    },
    [onUpload, onOpenChange, reset],
  );

  const sizeWarning = probe && probe.bytes > BUDGET_OK;
  const sizeHint = probe && !sizeWarning && probe.bytes > BUDGET_GOOD;
  const resolutionWarning = probe && probe.width > RESOLUTION_WARN;

  // "Original übernehmen" stays reachable on every path — a probe or encode
  // failure must never prevent adding the file the user picked.
  const canCommitOriginal = Boolean(file) && status !== 'sniffing' && !committing;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <GlassDialogContent size="md">
        <GlassDialogHeader>
          <DialogTitle>{current ? 'Umgebungsbild ersetzen' : 'Umgebung / HDRI hinzufügen'}</DialogTitle>
          <DialogDescription>
            {current
              ? 'Die Einstellungen für Spiegelung, Hintergrund, Intensität und Unschärfe bleiben erhalten.'
              : 'Equirektanguläres Bild als Spiegelung (IBL) und optional als Hintergrund. Die Datei wird mit dem Widget ausgeliefert – ihre Größe landet direkt im Seitengewicht deiner Seite.'}
          </DialogDescription>
        </GlassDialogHeader>

        <GlassDialogBody className="space-y-4">
        <Tabs value={tab} onValueChange={(value) => setTab(value as 'upload' | 'library')}>
          <TabsList>
            <TabsTrigger value="upload">Eigene Datei</TabsTrigger>
            <TabsTrigger value="library">Standard-HDRIs</TabsTrigger>
          </TabsList>

          <TabsContent value="library" className="mt-4">
            <PresetLibrary onUse={(preset) => void usePreset(preset)} busy={committing} />
          </TabsContent>

          <TabsContent value="upload" className="mt-4 space-y-4">
            <Input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked) converter.selectFile(picked);
                // Allow re-picking the same file after a reset.
                event.target.value = '';
              }}
            />

            {!file ? (
              <div
                className={`flex h-40 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors ${
                  dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground'
                }`}
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  const dropped = event.dataTransfer.files[0];
                  if (dropped) converter.selectFile(dropped);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === 'Enter' && inputRef.current?.click()}
                aria-label="Umgebungsbild hochladen"
              >
                <Upload className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Bild hierher ziehen oder klicken</p>
                <p className="text-xs text-muted-foreground">Erlaubt: .hdr, .exr, .jpg, .png, .webp</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 rounded-lg bg-secondary p-3">
                  <ImageIcon className="h-8 w-8 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={file.name}>
                      {file.name}
                    </p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {formatBytes(file.size)}
                      {probe?.width ? ` · ${probe.width} × ${probe.height}` : ''}
                      {probe && (
                        <Badge variant="secondary" className="text-[10px]">
                          {probe.format === 'sdr' ? 'SDR' : 'HDR'}
                        </Badge>
                      )}
                      {status === 'sniffing' && <Loader2 className="h-3 w-3 animate-spin" />}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={reset} disabled={committing}>
                    Ändern
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs">Dateigröße</Label>
                    <InfoHint label="Best Practice für HDRIs">
                      Faustregel: <strong>1024 × 512</strong> genügt für Spiegelungen – three.js
                      filtert das HDRI dafür ohnehin auf eine 256-px-Cubemap herunter (PMREM),
                      feinere Details landen dort nie im Bild. <strong>2048 × 1024</strong> nur, wenn
                      die Umgebung als sichtbarer, scharfer Hintergrund läuft. Ein 1k-.hdr liegt
                      typischerweise bei 1–2 MB; wenn es kleiner werden muss, ohne HDR-Bereich zu
                      verlieren: <strong>Ultra HDR JPEG</strong> – gleiche Dynamik bei etwa einem
                      Zwanzigstel der Dateigröße.
                    </InfoHint>
                  </div>
                  <SizeBudgetBar
                    sourceBytes={file.size}
                    resultBytes={resultBytes}
                    resultLabel={activeFormat ? FORMAT_LABEL[activeFormat] : undefined}
                    subject="die Umgebung"
                  />
                </div>

                {sizeWarning && (
                  <Notice variant="warning">
                    <strong>Diese Umgebung ist mit {formatBytes(probe.bytes)} zu groß fürs Web.</strong>{' '}
                    Das HDRI wird beim Export mitgeliefert und von jedem Besucher deiner Seite geladen
                    – es zählt voll ins Seitengewicht. Über 20 MiB liefert das CDN (jsDelivr) die
                    Datei gar nicht mehr aus (HTTP 403). Empfehlung: hier direkt umrechnen – für
                    Spiegelungen bleibt die Qualität praktisch identisch.
                  </Notice>
                )}

                {sizeHint && (
                  <p className="flex items-center gap-1.5 text-xs text-orange-400">
                    {formatBytes(probe.bytes)} ist vertretbar – unter 1 MB lädt deine Seite messbar
                    schneller.
                  </p>
                )}

                {resolutionWarning && (
                  <Notice variant="warning">
                    <strong>
                      {probe.width} × {probe.height} ist für ein Web-Widget zu hoch aufgelöst.
                    </strong>{' '}
                    Die Auflösung ist unabhängig von der Dateigröße ein Problem: entpackt belegt das
                    Bild rund {formatBytes(textureBytes(probe.width, probe.height))} Grafikspeicher,
                    und viele mobile GPUs verarbeiten maximal 4096 px – dort bleibt die Umgebung dann
                    schwarz. Für Spiegelungen rechnet three.js ohnehin auf eine 256-px-Cubemap
                    herunter; mehr als 1024 × 512 bringt dort keinen sichtbaren Gewinn.
                    {probe.width > RESOLUTION_SEVERE &&
                      ' Über 8192 px kann schon das Dekodieren im Browser den Tab zum Absturz bringen.'}
                  </Notice>
                )}

                {probe?.note && (
                  <p className="text-xs text-muted-foreground">
                    Hinweis: Die Datei ist eine {probe.note}-Variante – falls das Ergebnis seltsam
                    aussieht, exportiere sie als einfaches Scanline-EXR neu.
                  </p>
                )}

                {formats.length > 0 && widths.length > 0 && !probe?.tooLargeToConvert && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Format</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {formats.map((format) => {
                          const key = targetKey(format, activeWidth ?? widths[0]);
                          const isActive = activeFormat === format;
                          return (
                            <Button
                              key={format}
                              size="sm"
                              variant={isActive ? 'default' : 'outline'}
                              onClick={() => converter.selectTarget(key)}
                              disabled={committing}
                            >
                              {FORMAT_LABEL[format]}
                            </Button>
                          );
                        })}
                      </div>
                      {activeFormat && (
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {FORMAT_HINT[activeFormat]}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Auflösung</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {widths.map((width) => {
                          const key: TargetKey = targetKey(activeFormat ?? formats[0], width);
                          const variant = variants.get(key);
                          const isActive = activeWidth === width;
                          const isRecommended = recommendation?.key === key;
                          const loading = status === 'converting' && selected === key;
                          return (
                            <Button
                              key={width}
                              size="sm"
                              variant={isActive ? 'default' : 'outline'}
                              className="h-auto flex-col gap-0 py-1.5"
                              onClick={() => converter.selectTarget(key)}
                              disabled={committing}
                            >
                              <span className="flex items-center gap-1.5">
                                {width} × {Math.round(width / 2)}
                                {isRecommended && (
                                  <Badge variant="secondary" className="text-[9px]">
                                    Empfohlen
                                  </Badge>
                                )}
                              </span>
                              <span className="text-[10px] font-normal opacity-70">
                                {loading ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : variant ? (
                                  formatBytes(variant.blob.size)
                                ) : (
                                  '—'
                                )}
                              </span>
                            </Button>
                          );
                        })}
                      </div>
                      {recommendation && (
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {recommendation.reason}
                          {recommendation.alternative &&
                            (() => {
                              const alternative = recommendation.alternative;
                              const encoded = variants.get(alternative.key);
                              return (
                                <>
                                  {' '}
                                  {alternative.reason}
                                  {encoded ? ` (${formatBytes(encoded.blob.size)}).` : '.'}
                                  {alternative.caveat ? ` ${alternative.caveat}` : ''}
                                </>
                              );
                            })()}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {progress && (
                  <div className="space-y-1.5">
                    <Progress value={Math.round(progress.progress * 100)} />
                    <p className="text-xs text-muted-foreground" aria-live="polite">
                      {progress.label}
                    </p>
                  </div>
                )}

                {selectedVariant && !progress && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md bg-secondary p-2.5 text-xs">
                    <span className="text-muted-foreground">
                      Vorher {formatBytes(file.size)} · {probe?.width} × {probe?.height}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium">
                      Nachher {formatBytes(selectedVariant.blob.size)} · {selectedVariant.width} ×{' '}
                      {selectedVariant.height}
                    </span>
                    <span className="text-green-400">−{formatSaving(selectedVariant.blob.size, file.size)}</span>
                  </div>
                )}

                {converter.error && <Notice variant="warning">{converter.error}</Notice>}
              </>
            )}
          </TabsContent>
        </Tabs>

        {commitError && <Notice variant="error">{commitError}</Notice>}
        </GlassDialogBody>

        <GlassDialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={committing}>
            Abbrechen
          </Button>
          {tab === 'upload' && file && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" onClick={commitOriginal} disabled={!canCommitOriginal}>
                    Original übernehmen
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Übernimmt die Datei unverändert ({formatBytes(file.size)}
                  {probe && ` · ${ENVIRONMENT_FORMAT_LABEL[probe.format]}`}). Sie wird beim Export
                  vollständig mitgeliefert.
                </TooltipContent>
              </Tooltip>
              <Button onClick={commitConverted} disabled={!selectedVariant || committing}>
                {committing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Übernehme…
                  </>
                ) : selectedVariant ? (
                  `Übernehmen (${formatBytes(selectedVariant.blob.size)})`
                ) : (
                  'Umrechnen & übernehmen'
                )}
              </Button>
            </>
          )}
        </GlassDialogFooter>
      </GlassDialogContent>
    </Dialog>
  );
}
