import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HDRI_PRESETS } from '@/lib/hdri/presets.generated';
import type { HdriPreset } from '@/lib/hdri/types';
import { formatBytes } from '@/lib/utils';

/**
 * The bundled HDRIs. No thumbnail files: the generator already has the pixels
 * when it converts, so it records the mean sky, horizon and ground colour and
 * they render as a vertical gradient. Which reads as an environment at a
 * glance, distinguishes a blue exterior from a warm studio from a sunset, and
 * costs no extra request or decode.
 */
export function PresetLibrary({
  onUse,
  busy,
}: {
  onUse: (preset: HdriPreset) => void;
  busy: boolean;
}) {
  if (!HDRI_PRESETS.length) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Noch keine Standard-HDRIs vorhanden. Führe <code>npm run presets:hdri</code> aus.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Mitgelieferte HDRIs. Jeweils 1024 × 512 als Radiance .hdr, rund 1 MB. Direkt web-taugliche
        Standardumgebungen, ohne Umrechnen.
      </p>
      <ScrollArea className="max-h-72">
        <div className="space-y-1.5 pr-3">
          {HDRI_PRESETS.map((preset) => (
            <div key={preset.id} className="flex items-center gap-3 rounded-md bg-secondary p-2">
              <div
                className="h-10 w-16 shrink-0 rounded-md border border-border"
                style={{
                  background: `linear-gradient(to bottom, ${preset.swatch[0]}, ${preset.swatch[1]}, ${preset.swatch[2]})`,
                }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{preset.label}</p>
                  {preset.tag && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {preset.tag}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {preset.width} × {preset.height} · {formatBytes(preset.byteSize)}
                </p>
              </div>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onUse(preset)}>
                Verwenden
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
