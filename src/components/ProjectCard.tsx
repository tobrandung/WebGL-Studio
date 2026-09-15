import type { CSSProperties } from 'react';
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { Copy, Pencil, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Project } from '@/lib/db';

type ProjectCardProps = {
  project: Project;
  /**
   * Whether this project also exists in R2. A project that lives only in
   * IndexedDB is one cache clear from gone, so the card says so rather than
   * leaving the distinction invisible.
   */
  synced?: boolean;
  /**
   * Who last saved this project, when that was not the person looking at it.
   * Left undefined for your own work, because a name on every card would say
   * nothing; on a colleague's it is the whole point of a shared dashboard.
   */
  author?: string;
  /**
   * Seconds to hold back this card's entrance, so a row fans out left to right.
   * The dashboard derives it from the card's column, not its index in the list.
   */
  delay?: number;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
};

/**
 * Content lands after the card itself, then cascades through its own children.
 * Both variants take the card's stagger delay as `custom`, which motion passes
 * down the subtree for us.
 */
const contentVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { staggerChildren: 0.08, delayChildren: delay + 0.2 },
  }),
};

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' as const } },
};

export function ProjectCard({
  project,
  synced,
  author,
  delay = 0,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
}: ProjectCardProps) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  // `amount: 0.3` means the whole row crosses the threshold together, which is
  // what makes a row read as one movement rather than four separate ones.
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reduceMotion = useReducedMotion();

  const stagger = reduceMotion ? 0 : delay;
  const formattedDate = new Date(project.updatedAt).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  /** Menu and action-bar clicks must not also open the project underneath. */
  const stopPropagation = (event: React.MouseEvent) => event.stopPropagation();

  return (
    <motion.div
      ref={ref}
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, ease: 'easeOut', delay: stagger }}
      className="h-full"
    >
      {/* A ring rather than a border: it is drawn outside the box, so it does
          not sit between the card edge and the 16px padding the way a border
          would. Content stays a clean 16 from the edge it is measured against. */}
      <Card
        // `--glass-tint` hebt die Card vom Seitenhintergrund ab, statt sie wie
        // Toolbar und Dialoge mit ihm verschmelzen zu lassen.
        style={{ '--glass-tint': 'var(--card)' } as CSSProperties}
        className="glass-surface group flex h-full cursor-pointer flex-col gap-0 overflow-hidden rounded-2xl border-0 p-0 ring-1 ring-border transition-[box-shadow] hover:ring-foreground/20"
        onClick={() => navigate(`/project/${project.id}`)}
      >
        <div className="relative aspect-video w-full overflow-hidden bg-muted">
          {project.thumbnail ? (
            <img
              src={project.thumbnail}
              alt={project.name}
              className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <svg
                className="h-10 w-10 opacity-30"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              </svg>
            </div>
          )}

          <motion.span
            initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
            animate={isInView ? { opacity: 1, scale: 1 } : {}}
            transition={{ type: 'spring', stiffness: 260, damping: 16, delay: stagger + 0.25 }}
            className="absolute left-4 top-4 rounded-lg bg-card/90 px-2 py-1 text-xs font-medium tabular-nums text-foreground ring-1 ring-inset ring-border backdrop-blur-sm"
          >
            {formattedDate}
          </motion.span>

          {author && (
            <motion.span
              initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
              animate={isInView ? { opacity: 1, scale: 1 } : {}}
              transition={{ type: 'spring', stiffness: 260, damping: 16, delay: stagger + 0.3 }}
              className="absolute bottom-4 left-4 max-w-[calc(100%-32px)] truncate rounded-lg bg-card/90 px-2 py-1 text-xs text-muted-foreground ring-1 ring-inset ring-border backdrop-blur-sm"
              title={`Zuletzt gespeichert von ${author}`}
            >
              {author}
            </motion.span>
          )}

          {synced === false && (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
              animate={isInView ? { opacity: 1, scale: 1 } : {}}
              transition={{ type: 'spring', stiffness: 260, damping: 16, delay: stagger + 0.3 }}
              className="absolute right-4 top-4"
            >
              <Badge
                variant="outline"
                className="border-orange-400/40 bg-card/90 text-orange-400 backdrop-blur-sm"
                title="Noch nicht ins Team-Backup synchronisiert"
              >
                nur lokal
              </Badge>
            </motion.div>
          )}
        </div>

        {/* Padding matches the date chip's `top-4 left-4` inset, so title,
            divider and action bar all line up with it against the card edge. */}
        <CardContent className="flex flex-1 flex-col p-4">
          <motion.div
            custom={stagger}
            variants={contentVariants}
            initial={reduceMotion ? false : 'hidden'}
            animate={isInView ? 'visible' : 'hidden'}
            className="flex flex-1 flex-col gap-4"
          >
            <motion.p
              variants={itemVariants}
              className="truncate text-base font-semibold text-foreground"
            >
              {project.name}
            </motion.p>

            {/* Pushed to the bottom edge so cards in a row line their action
                bars up even when only some of them carry a badge. */}
            <motion.div variants={itemVariants} className="mt-auto">
              <Separator />
            </motion.div>

            {/* Three equal thirds (`flex-1` over a zero basis, so the label
                lengths do not decide the widths). Labels only: at four columns
                the card is ~290px wide and icons pushed "Mehr" past the edge. */}
            <motion.div
              variants={itemVariants}
              className="flex items-center gap-2"
              onClick={stopPropagation}
            >
              <Button
                variant="ghost"
                size="sm"
                className="flex-1 px-0 text-xs"
                onClick={() => navigate(`/project/${project.id}/preview`)}
              >
                Vorschau
              </Button>
              <Separator orientation="vertical" className="h-4" />
              <Button
                variant="ghost"
                size="sm"
                className="flex-1 px-0 text-xs"
                onClick={() => onExport(project.id)}
              >
                Exportieren
              </Button>
              <Separator orientation="vertical" className="h-4" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 px-0 text-xs"
                    aria-label="Weitere Optionen"
                  >
                    Mehr
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onRename(project.id)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Umbenennen
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onDuplicate(project.id)}>
                    <Copy className="mr-2 h-4 w-4" />
                    Duplizieren
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-400 focus:text-red-400"
                    onClick={() => onDelete(project.id)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Löschen
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </motion.div>
          </motion.div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
