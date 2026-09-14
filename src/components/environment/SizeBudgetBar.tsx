import { formatBytes } from '@/lib/utils';
import {
  BUDGET_GOOD,
  BUDGET_OK,
  CDN_LIMIT,
  ZONE_LABEL,
  ZONE_WIDTH,
  budgetPosition,
  budgetZone,
  type BudgetZone,
} from '@/lib/hdri/budget';

const ZONE_STYLE: Record<BudgetZone, string> = {
  good: 'bg-green-500/70',
  ok: 'bg-orange-500/70',
  large: 'bg-red-500/60',
  'over-cdn': 'bg-red-500',
};

const ZONE_ORDER: BudgetZone[] = ['good', 'ok', 'large', 'over-cdn'];

const TICKS: Array<{ bytes: number; label: string; strong?: boolean }> = [
  { bytes: BUDGET_GOOD, label: '1 MB' },
  { bytes: BUDGET_OK, label: '3 MB' },
  { bytes: CDN_LIMIT, label: '20 MiB (CDN-Limit)', strong: true },
];

/**
 * Shows where a file sits in the web-weight budget, with the original and the
 * selected conversion marked on the same track so the improvement is visible
 * in place rather than only as a number.
 */
export function SizeBudgetBar({
  sourceBytes,
  resultBytes,
  resultLabel,
  subject = 'Die Datei',
}: {
  sourceBytes: number;
  resultBytes?: number;
  resultLabel?: string;
  /** What the caption talks about, e.g. "Das Modell". Nominative case. */
  subject?: string;
}) {
  const shown = resultBytes ?? sourceBytes;
  const zone = budgetZone(shown);
  const description =
    `Dateigröße ${formatBytes(shown)}. Bereich „${ZONE_LABEL[zone]}“. Empfehlung unter ${formatBytes(BUDGET_GOOD)}.`;

  return (
    <div className="space-y-1.5">
      <div className="relative h-2 w-full overflow-hidden rounded-full" role="img" aria-label={description}>
        <div className="flex h-full w-full">
          {ZONE_ORDER.map((key) => (
            <div
              key={key}
              className={ZONE_STYLE[key]}
              style={{
                width: `${ZONE_WIDTH[key] * 100}%`,
                ...(key === 'over-cdn'
                  ? {
                      backgroundImage:
                        'repeating-linear-gradient(45deg, transparent 0 3px, rgba(0,0,0,.45) 3px 6px)',
                    }
                  : null),
              }}
            />
          ))}
        </div>
      </div>

      <div className="relative h-4">
        {TICKS.map((tick) => (
          <div
            key={tick.label}
            className="absolute top-0 -translate-x-1/2 text-[10px] whitespace-nowrap"
            style={{ left: `${budgetPosition(tick.bytes) * 100}%` }}
          >
            <span className={tick.strong ? 'text-red-400' : 'text-muted-foreground'}>{tick.label}</span>
          </div>
        ))}

        <div
          className="absolute -top-4 h-3 w-0.5 -translate-x-1/2 bg-foreground/40"
          style={{ left: `${budgetPosition(sourceBytes) * 100}%` }}
          title={`Original: ${formatBytes(sourceBytes)}`}
        />
        {resultBytes !== undefined && (
          <div
            className="absolute -top-4 h-3 w-1 -translate-x-1/2 rounded-sm bg-foreground"
            style={{ left: `${budgetPosition(resultBytes) * 100}%` }}
            title={`${resultLabel ?? 'Ergebnis'}: ${formatBytes(resultBytes)}`}
          />
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {ZONE_ORDER.slice(0, 3)
          .map((key) => ZONE_LABEL[key])
          .join(' · ')}{' '}
        Empfehlung fürs Web: unter 1 MB. Bis 3 MB ist vertretbar, darüber verlängert {subject} die
        Ladezeit deutlich.
      </p>
    </div>
  );
}
