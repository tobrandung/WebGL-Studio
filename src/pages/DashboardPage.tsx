import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Loader2, Search, ArrowUpDown, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  GlassDialogBody,
  GlassDialogContent,
  GlassDialogFooter,
  GlassDialogHeader,
} from '@/components/ui/glass-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProjectCard } from '@/components/ProjectCard';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { ExportDialog } from '@/components/ExportDialog';
import { useProjects } from '@/hooks/useProjects';
import { useTeamSync } from '@/hooks/useTeamSync';
import { useAssetBackfill } from '@/hooks/useAssetBackfill';
import { useGridColumns } from '@/hooks/useGridColumns';
import { fetchIdentity, fetchUsage, type StorageUsage } from '@/lib/storage/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { toast } from '@/components/ui/toast';
import { Label } from '@/components/ui/label';
import { Progress, ProgressLabel, ProgressTrack, ProgressValue } from '@/components/ui/progress';
import { formatBytes } from '@/lib/utils';
import type { Project } from '@/lib/db';

/**
 * What has to be typed before a project can be deleted.
 *
 * A second click is muscle memory; a word is not. Deleting takes the project's
 * models and HDRIs out of the team storage with it, which breaks any widget
 * embedded on a customer site, so the dialog asks for something you cannot do
 * by accident.
 */
const DELETE_CONFIRMATION = 'LÖSCHEN';


/** Logo-über-Name-Lockup fürs Hauptmenü. `lg` für den leeren Zustand (zentriert, größer). */
function Brand({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const large = size === 'lg';
  return (
    <div className={`flex flex-col ${large ? 'items-center gap-3' : 'items-start gap-1.5'}`}>
      <img src="/brandung-logo.svg" alt="BRANDUNG" className={large ? 'h-8 w-auto' : 'h-5 w-auto'} />
      <h1 className={`font-bold tracking-tight ${large ? 'text-4xl' : 'text-2xl'}`}>WebGL Studio</h1>
    </div>
  );
}

/**
 * How full the shared bucket is.
 *
 * Sits on the dashboard rather than in the upload dialog because the budget is
 * the team's, not one upload's: by the time a model is refused, the person
 * being refused is rarely the one who filled it.
 *
 * A full bucket draws the bar all the way and in red even though the measured
 * ratio can still read below 100. The server counts uploads it has signed for
 * but not yet seen land, so "voll" is the honest state while the arithmetic is
 * still catching up, and a bar sitting at four fifths next to the word would
 * just look broken.
 */
function StorageMeter({ usage, full }: { usage: StorageUsage; full: boolean }) {
  const ratio = usage.quotaBytes > 0 ? usage.usedBytes / usage.quotaBytes : 0;
  const critical = full || ratio >= 0.9;
  return (
    <Progress
      value={full ? 100 : Math.min(100, Math.round(ratio * 100))}
      variant={critical ? 'destructive' : 'default'}
      className="w-60 shrink-0"
      aria-label="Team-Speicher"
      title={`${usage.objects} Dateien im Team-Speicher`}
    >
      <ProgressLabel className={`text-xs ${critical ? 'text-destructive' : 'text-muted-foreground'}`}>
        Team-Speicher
      </ProgressLabel>
      <ProgressValue className={`text-xs ${critical ? 'text-destructive' : ''}`}>
        {full ? 'voll' : `${formatBytes(usage.usedBytes)} von ${formatBytes(usage.quotaBytes)}`}
      </ProgressValue>
      <ProgressTrack />
    </Progress>
  );
}

/**
 * The team storage, parked at the bottom edge of the page.
 *
 * It used to sit between the header and the first row of cards, where a single
 * line of text pushed the whole grid down and then pulled it back up again the
 * moment a sync finished. Down here the message and the gauge are always in the
 * same place, and the grid never moves because of them.
 *
 * Only lasting state belongs in it: how full the storage is, that it cannot be
 * reached, that a sync is running. Anything that is simply over goes to a toast.
 */
function StatusBar({
  message,
  usage,
  full,
}: {
  message: ReactNode;
  usage: StorageUsage | null;
  full: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Toasts anchor to the bottom right as well, and the page has to end above
  // the bar, so both read its height from this variable. Measured rather than
  // assumed: on a narrow window the message wraps under the gauge and the bar
  // is suddenly twice as tall.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty('--status-bar-height', `${Math.round(element.offsetHeight)}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--status-bar-height');
    };
  }, []);

  return (
    <div ref={ref} className="glass-surface fixed inset-x-0 bottom-0 z-40 border-t">
      <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 lg:px-8">
        <div className="min-w-48 flex-1">{message}</div>
        {usage && <StorageMeter usage={usage} full={full} />}
      </div>
    </div>
  );
}

/* Hintergrund für Welcome-Screen, Projektliste und Ladezustand gleichermaßen.
   `fixed`, damit er beim Scrollen durch viele Projekte stehen bleibt statt
   unten auszulaufen. `100% 100%` statt `cover` oder `contain`: der Verlauf wird
   auf das Fenster gezogen, damit er immer vollständig zu sehen ist. Verzerrt,
   aber bei einem weichen Farbverlauf sieht man das nicht, und weder Anschnitt
   noch Ränder bleiben übrig. */
function PageBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 bg-[url('/app-background.avif')] bg-[length:100%_100%] bg-center bg-no-repeat opacity-50"
    />
  );
}

/** A project card with its content still missing: thumbnail, title, footer. */
function ProjectCardSkeleton() {
  return (
    <div className="glass-surface flex h-full flex-col overflow-hidden rounded-2xl ring-1 ring-border">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="flex flex-1 flex-col gap-4 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="mt-auto h-4 w-full" />
      </div>
    </div>
  );
}

/** Seconds each column lags behind the one to its left. */
const COLUMN_STAGGER = 0.06;

/** Projects per page. Four full rows on the widest grid. */
const PAGE_SIZE = 16;

/**
 * The page numbers to offer, with `null` for a gap. Up to seven pages are
 * listed in full; past that only the first, the last and the current page's
 * neighbours, so the row keeps its width however long the list gets.
 */
function pageItems(current: number, count: number): Array<number | null> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const pages = new Set([1, count, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= count).sort((a, b) => a - b);
  const items: Array<number | null> = [];
  for (const [i, page] of sorted.entries()) {
    if (i > 0 && page - sorted[i - 1] > 1) items.push(null);
    items.push(page);
  }
  return items;
}

type SortField = 'updated' | 'created' | 'name';
type SortDirection = 'desc' | 'asc';

const SORT_FIELDS: Array<{ id: SortField; label: string }> = [
  { id: 'updated', label: 'Zuletzt geändert' },
  { id: 'created', label: 'Erstellungsdatum' },
  { id: 'name', label: 'Alphabetisch' },
];

/**
 * Für Namen ergibt „neueste zuerst" keinen Sinn, deshalb hängen die Labels am
 * gewählten Feld. Die Richtung selbst bleibt dieselbe: `desc` ist absteigend.
 */
function directionLabels(field: SortField): Record<SortDirection, string> {
  return field === 'name'
    ? { desc: 'Z–A', asc: 'A–Z' }
    : { desc: 'Neueste zu ältesten', asc: 'Älteste zu neuesten' };
}

/** Nur der Projektname ist durchsuchbar. Mehr steht auf der Card nicht. */
function matchesQuery(name: string, query: string): boolean {
  return name.toLowerCase().includes(query);
}

function sortEntries<T extends { name: string; updatedAt: number; createdAt?: number }>(
  entries: T[],
  field: SortField,
  direction: SortDirection,
): T[] {
  const sorted = [...entries].sort((a, b) => {
    if (field === 'name') return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
    // Team-Projekte kennen kein Erstellungsdatum; dort bleibt es beim letzten Stand.
    if (field === 'created') return (a.createdAt ?? a.updatedAt) - (b.createdAt ?? b.updatedAt);
    return a.updatedAt - b.updatedAt;
  });
  return direction === 'desc' ? sorted.reverse() : sorted;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(gridRef);
  const { projects, loading, reload, createProject, updateProject, deleteProject, duplicateProject } =
    useProjects();
  // Team projects are mirrored in on load, so `projects` is the whole picture:
  // one grid, every card complete, nothing to import by hand.
  const { syncing, error: syncError } = useTeamSync(loading, reload);
  // Runs after the team pass so it sees the full set, including projects that
  // just arrived from a colleague.
  const { progress: backfill, quotaExceeded } = useAssetBackfill(projects, !loading && !syncing, reload);
  const [identity, setIdentity] = useState<string | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportProject, setExportProject] = useState<Project | null>(null);
  const [renameId, setRenameId] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('updated');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);

  const query = search.trim().toLowerCase();
  const directions = directionLabels(sortField);
  const activeSortLabel = SORT_FIELDS.find((f) => f.id === sortField)?.label ?? '';
  const visibleProjects = useMemo(
    () => sortEntries(projects.filter((p) => matchesQuery(p.name, query)), sortField, sortDirection),
    [projects, query, sortField, sortDirection],
  );

  const pageCount = Math.max(1, Math.ceil(visibleProjects.length / PAGE_SIZE));
  // Clamped rather than trusted: deleting the last project on the last page
  // would otherwise leave the grid empty with no way back.
  const currentPage = Math.min(page, pageCount);
  const pagedProjects = visibleProjects.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  // A new search or sort order starts at the top again.
  useEffect(() => {
    setPage(1);
  }, [query, sortField, sortDirection]);

  // Only used to decide whether a card needs to say who made it; a failure just
  // means every synced project shows its author, which is no worse than before.
  useEffect(() => {
    void fetchIdentity().then(setIdentity);
  }, []);

  // Re-read once the backfill has stopped moving bytes, so the figure reflects
  // what it just uploaded rather than what was there when the page opened.
  useEffect(() => {
    if (backfill) return;
    void fetchUsage().then(setUsage);
  }, [backfill]);

  const handleCreate = async () => {
    const name = inputValue.trim() || 'Unbenanntes Projekt';
    const project = await createProject(name);
    setShowNewDialog(false);
    setInputValue('');
    navigate(`/project/${project.id}`);
  };

  const handleRename = async () => {
    if (!renameId) return;
    await updateProject(renameId, { name: inputValue.trim() || 'Unbenanntes Projekt' });
    setShowRenameDialog(false);
    setInputValue('');
    setRenameId('');
  };

  // The dialog fades out over a moment in which `deleteTarget` is already null.
  // Reading the name and the local/remote wording from the last target instead
  // keeps the closing dialog from flashing an empty name and the wrong warning.
  const shownDeleteTarget = useRef<Project | null>(null);
  if (deleteTarget) shownDeleteTarget.current = deleteTarget;
  const deleteDialogProject = deleteTarget ?? shownDeleteTarget.current;

  const closeDelete = () => {
    setDeleteTarget(null);
    setDeleteConfirm('');
  };

  // Normalised because „Ö" reaches us as one code point or as O plus combining
  // diaeresis depending on the keyboard, and both are the word the user typed.
  const deleteArmed =
    deleteConfirm.trim().normalize('NFC').toUpperCase() === DELETE_CONFIRMATION && !deleting;

  const handleDelete = async () => {
    const target = deleteTarget;
    if (!target || !deleteArmed) return;
    setDeleting(true);
    try {
      const result = await deleteProject(target.id);
      const freed = result && result.freedBytes > 0 ? `, ${formatBytes(result.freedBytes)} frei` : '';
      const kept =
        result && result.keptAssets > 0
          ? ` ${result.keptAssets} ${result.keptAssets === 1 ? 'Datei bleibt' : 'Dateien bleiben'}, weil andere Projekte sie verwenden.`
          : '';
      // A toast, because this is news, not a state: the project is gone, and a
      // line that says so has nothing left to describe a moment later.
      toast.add({
        type: 'success',
        title: `„${target.name}" gelöscht`,
        description: result
          ? `${result.deletedAssets} ${result.deletedAssets === 1 ? 'Datei' : 'Dateien'} aus dem Team-Speicher entfernt${freed}.${kept}`
          : 'Das Projekt war nur in diesem Browser gespeichert.',
      });
      // The meter is the whole point of freeing space, so it must not wait for
      // the next reload to show it.
      void fetchUsage().then(setUsage);
      closeDelete();
    } finally {
      setDeleting(false);
    }
  };

  const openRename = (id: string) => {
    const project = projects.find((p) => p.id === id);
    setRenameId(id);
    setInputValue(project?.name ?? '');
    setShowRenameDialog(true);
  };

  // Waiting out the first team pass on an empty dashboard, rather than showing
  // the welcome screen to someone whose colleagues have twenty projects and
  // then swapping it for a grid half a second later.
  if (loading || (projects.length === 0 && syncing)) {
    return (
      <div className="min-h-screen px-6 py-8 lg:px-8">
        <PageBackdrop />
        <div className="mb-6 flex flex-wrap items-end gap-4">
          <Brand />
          <div className="flex flex-1 flex-wrap items-end gap-4 pb-1">
            <Skeleton className="h-9 min-w-48 flex-1" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-40" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <ProjectCardSkeleton key={index} />
          ))}
        </div>
      </div>
    );
  }

  const isEmpty = projects.length === 0;

  // One line at a time, most urgent first: a full storage stops uploads, an
  // unreachable one stops syncing, and the two running states are only worth
  // mentioning while nothing is wrong.
  const statusMessage: ReactNode = quotaExceeded ? (
    <Alert inline variant="destructive">
      <AlertDescription>
        Team-Speicher voll. Neue Modelle werden abgelehnt, bis Platz frei wird. Bestehende Projekte
        lassen sich weiter bearbeiten.
      </AlertDescription>
    </Alert>
  ) : syncError ? (
    <Alert inline variant="destructive">
      <AlertDescription>
        Team-Speicher nicht erreichbar: {syncError} Projekte aus diesem Browser sind weiterhin da.
      </AlertDescription>
    </Alert>
  ) : syncing ? (
    <Alert inline icon={null}>
      <AlertDescription className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Team-Projekte werden abgeglichen…
      </AlertDescription>
    </Alert>
  ) : backfill ? (
    <Alert inline icon={null}>
      <AlertDescription className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Modelle werden für das Team hochgeladen: „{backfill.name}" ({backfill.index} von{' '}
        {backfill.total})
      </AlertDescription>
    </Alert>
  ) : null;

  const showStatusBar = Boolean(statusMessage) || usage !== null;

  return (
    <div
      className="min-h-screen px-6 py-8 lg:px-8"
      // Ends above the bar rather than behind it, whatever height it has.
      style={showStatusBar ? { paddingBottom: 'calc(var(--status-bar-height, 0px) + 2rem)' } : undefined}
    >
      <PageBackdrop />
      {isEmpty ? (
        <div className="flex h-[calc(100vh-4rem)] flex-col items-center justify-center gap-6">
          <Brand size="lg" />
          <p className="max-w-md text-center text-muted-foreground">
            Erstelle interaktive 3D-Erlebnisse mit Kamerafahrten und exportiere sie als embeddable
            Widget für deine Webprojekte.
          </p>
          <Button size="lg" onClick={() => setShowNewDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Neues Projekt
          </Button>
        </div>
      ) : (
        <>
          {/* Unten ausgerichtet: Suche und Aktionen schließen mit der
              Unterkante des Lockups ab, nicht mit dessen Mitte. */}
          <div className="mb-6 flex flex-wrap items-end gap-4">
            <Brand />
            {/* `pb-1` hebt die Reihe um 4px an: `items-end` richtet an der
                Box-Unterkante der Überschrift aus, und die liegt durch den
                Zeilenabstand 6px unter deren Grundlinie. Optisch sahen Suche
                und Buttons dadurch abgesackt aus. */}
            <div className="flex flex-1 flex-wrap items-end gap-4 pb-1">
              {/* Nimmt den freien Platz zwischen Lockup und Aktionen ein und
                  rutscht auf schmalen Fenstern in eine eigene Zeile. */}
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Projekt suchen"
                  aria-label="Projekt suchen"
                  className="pl-10 pr-10"
                />
                {/* Erst ab der ersten Eingabe. Ein X über einem leeren Feld
                    hätte nichts zu löschen. Rechts spiegelbildlich zur Lupe:
                    beide Icon-Mitten liegen 24px vom jeweiligen Rand. */}
                {search && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Suche löschen"
                    title="Suche löschen"
                    onClick={() => setSearch('')}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" aria-label="Sortieren nach">
                    <ArrowUpDown className="h-4 w-4" />
                    {activeSortLabel}
                    <ChevronDown className="h-4 w-4 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Sortieren nach</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={sortField}
                    onValueChange={(value) => setSortField(value as SortField)}
                  >
                    {SORT_FIELDS.map((field) => (
                      <DropdownMenuRadioItem key={field.id} value={field.id}>
                        {field.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Ordnen</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={sortDirection}
                    onValueChange={(value) => setSortDirection(value as SortDirection)}
                  >
                    <DropdownMenuRadioItem value="desc">{directions.desc}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="asc">{directions.asc}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button onClick={() => setShowNewDialog(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Neues Projekt
              </Button>
            </div>
          </div>
          <div
            ref={gridRef}
            className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {pagedProjects.map((project, index) => (
              <ProjectCard
                key={project.id}
                project={project}
                synced={Boolean(project.remote)}
                author={
                  project.remote?.author && project.remote.author !== identity
                    ? project.remote.author
                    : undefined
                }
                delay={(index % columns) * COLUMN_STAGGER}
                onRename={openRename}
                onDuplicate={(id) => duplicateProject(id)}
                onDelete={(id) => {
                  const p = projects.find((pr) => pr.id === id);
                  if (p) setDeleteTarget(p);
                }}
                onExport={(projectId) => {
                  const p = projects.find((pr) => pr.id === projectId);
                  if (p) { setExportProject(p); setShowExportDialog(true); }
                }}
              />
            ))}
          </div>

          {pageCount > 1 && (
            <Pagination className="pt-8">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    disabled={currentPage === 1}
                    onClick={() => setPage(currentPage - 1)}
                  />
                </PaginationItem>
                {pageItems(currentPage, pageCount).map((item, index) => (
                  <PaginationItem key={item ?? `gap-${index}`}>
                    {item === null ? (
                      <PaginationEllipsis />
                    ) : (
                      <PaginationLink
                        isActive={item === currentPage}
                        onClick={() => setPage(item)}
                      >
                        {item}
                      </PaginationLink>
                    )}
                  </PaginationItem>
                ))}
                <PaginationItem>
                  <PaginationNext
                    disabled={currentPage === pageCount}
                    onClick={() => setPage(currentPage + 1)}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}

          {query && visibleProjects.length === 0 && (
            <p className="py-16 text-center text-muted-foreground">
              Kein Projekt passt zu „{search.trim()}".
            </p>
          )}

        </>
      )}

      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Neues Projekt</DialogTitle>
            <DialogDescription>Gib deinem Projekt einen Namen.</DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Projektname"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewDialog(false)}>
              Abbrechen
            </Button>
            <Button onClick={handleCreate}>Erstellen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Projekt umbenennen</DialogTitle>
            <DialogDescription>Gib einen neuen Namen ein.</DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Neuer Name"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRenameDialog(false)}>
              Abbrechen
            </Button>
            <Button onClick={handleRename}>Speichern</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deleting takes the project's models and HDRIs out of the team storage
          with it, which is what stops the bucket from only ever growing. It
          also breaks every embed pointing at them, so this asks for the word
          rather than for a second click. */}
      <Dialog open={deleteTarget !== null} onOpenChange={(next) => !next && closeDelete()}>
        <GlassDialogContent size="sm">
          <GlassDialogHeader>
            <DialogTitle>Projekt löschen</DialogTitle>
            <DialogDescription>
              „{deleteDialogProject?.name}" wird endgültig entfernt. Das lässt sich nicht rückgängig
              machen.
            </DialogDescription>
          </GlassDialogHeader>
          <GlassDialogBody className="space-y-4">
            {deleteDialogProject?.remote ? (
              <Alert variant="destructive">
                <AlertTitle>Eingebundene Widgets hören auf zu laden</AlertTitle>
                <AlertDescription>
                  Das Projekt verschwindet für alle im Team, und seine Modelle und HDRIs werden aus
                  dem Team-Speicher gelöscht. Ist das Projekt auf einer Kundenseite eingebunden,
                  bleibt die Szene dort leer. Dateien, die noch ein anderes Projekt verwendet,
                  bleiben erhalten.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <AlertTitle>Nur in diesem Browser vorhanden</AlertTitle>
                <AlertDescription>
                  Dieses Projekt wurde nie mit dem Team-Speicher abgeglichen, es gibt also keine
                  zweite Kopie. Danach ist es weg.
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="delete-confirm">
                Tippe {DELETE_CONFIRMATION}, um das zu bestätigen
              </Label>
              <Input
                id="delete-confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleDelete();
                }}
                placeholder={DELETE_CONFIRMATION}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </GlassDialogBody>
          <GlassDialogFooter>
            <Button variant="outline" onClick={closeDelete} disabled={deleting}>
              Abbrechen
            </Button>
            <Button variant="destructive" disabled={!deleteArmed} onClick={() => void handleDelete()}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Endgültig löschen
            </Button>
          </GlassDialogFooter>
        </GlassDialogContent>
      </Dialog>

      <ExportDialog open={showExportDialog} onOpenChange={setShowExportDialog} project={exportProject} />

      {showStatusBar && (
        <StatusBar message={statusMessage} usage={usage} full={quotaExceeded} />
      )}
    </div>
  );
}

export default DashboardPage;
