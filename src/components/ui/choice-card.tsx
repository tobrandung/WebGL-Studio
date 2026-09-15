import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * A switch that owns a card instead of sitting at the end of a row: title,
 * explanation and control in one bordered box, and the whole box is the
 * target. The rows it replaces were a label, a line of muted text and a switch
 * pushed apart by `justify-between`, which left the control looking unrelated
 * to the text on a wide dialog.
 *
 * The card carries the click rather than a wrapping `<label>`: the Radix
 * switch is a `<button>`, and a label never forwards its click to one. The
 * switch stops its own click so a hit on the control itself does not toggle
 * twice.
 */
function ChoiceCard({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  className,
  children,
}: {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
  /** Extra content under the description, e.g. the colour swatch. */
  children?: React.ReactNode;
}) {
  return (
    <div
      onClick={() => onCheckedChange(!checked)}
      data-slot="choice-card"
      data-state={checked ? 'checked' : 'unchecked'}
      className={cn(
        'flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-accent/50 data-[state=checked]:border-ring',
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        {children}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

export { ChoiceCard };
