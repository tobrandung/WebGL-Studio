import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, CloudDownload, Loader2, Search, ArrowUpDown, ChevronDown, X } from 'lucide-react';
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
import { ExportDialog } from '@/components/ExportDialog';
import { useProjects } from '@/hooks/useProjects';
import { useRemoteProjects } from '@/hooks/useRemoteProjects';
import { useGridColumns } from '@/hooks/useGridColumns';
import { Card, CardContent } from '@/components/ui/card';
import type { Project } from '@/lib/db';


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

/** Seconds each column lags behind the one to its left. */
const COLUMN_STAGGER = 0.06;

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

/** Nur der Projektname ist durchsuchbar – mehr steht auf der Card nicht. */
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
  const { projects, loading, createProject, updateProject, deleteProject, duplicateProject } = useProjects();
  const { remoteOnly, importing, importProject } = useRemoteProjects(projects, loading);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportProject, setExportProject] = useState<Project | null>(null);
  const [renameId, setRenameId] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('updated');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const query = search.trim().toLowerCase();
  const directions = directionLabels(sortField);
  const activeSortLabel = SORT_FIELDS.find((f) => f.id === sortField)?.label ?? '';
  const visibleProjects = useMemo(
    () => sortEntries(projects.filter((p) => matchesQuery(p.name, query)), sortField, sortDirection),
    [projects, query, sortField, sortDirection],
  );
  const visibleRemote = useMemo(
    () => sortEntries(remoteOnly.filter((r) => matchesQuery(r.name, query)), sortField, sortDirection),
    [remoteOnly, query, sortField, sortDirection],
  );

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

  const openRename = (id: string) => {
    const project = projects.find((p) => p.id === id);
    setRenameId(id);
    setInputValue(project?.name ?? '');
    setShowRenameDialog(true);
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Laden…</div>
      </div>
    );
  }

  const isEmpty = projects.length === 0 && remoteOnly.length === 0;

  return (
    <div className="min-h-screen px-6 py-8 lg:px-8">
      {/* Hintergrund für Welcome-Screen und Projektliste gleichermaßen.
          `fixed`, damit er beim Scrollen durch viele Projekte stehen bleibt
          statt unten auszulaufen. `100% 100%` statt `cover` oder `contain`: der
          Verlauf wird auf das Fenster gezogen, damit er immer vollständig zu
          sehen ist — verzerrt, aber bei einem weichen Farbverlauf sieht man das
          nicht, und weder Anschnitt noch Ränder bleiben übrig. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[url('/app-background.avif')] bg-[length:100%_100%] bg-center bg-no-repeat opacity-50"
      />
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
                Zeilenabstand 6px unter deren Grundlinie — optisch sahen Suche
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
                {/* Erst ab der ersten Eingabe – ein X über einem leeren Feld
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
            {visibleProjects.map((project, index) => (
              <ProjectCard
                key={project.id}
                project={project}
                synced={Boolean(project.remote)}
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

          {query && visibleProjects.length === 0 && visibleRemote.length === 0 && (
            <p className="py-16 text-center text-muted-foreground">
              Kein Projekt passt zu „{search.trim()}".
            </p>
          )}

          {visibleRemote.length > 0 && (
            <>
              <div className="mt-10 mb-4">
                <h2 className="text-sm font-medium">Im Team-Speicher</h2>
                <p className="text-xs text-muted-foreground">
                  Projekte von Kolleg:innen oder von einem anderen Rechner. Öffnen lädt nur die
                  Szene – Modelle kommen beim Ansehen aus dem CDN.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleRemote.map((remote) => (
                  <Card
                    key={remote.id}
                    className="cursor-pointer transition-colors hover:border-foreground/20"
                    onClick={async () => {
                      const id = await importProject(remote.id);
                      if (id) navigate(`/project/${id}`);
                    }}
                  >
                    <CardContent className="flex items-center gap-3 p-4">
                      {importing === remote.id ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <CloudDownload className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{remote.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {remote.author} ·{' '}
                          {new Date(remote.updatedAt).toLocaleDateString('de-DE', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                          })}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
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

      {/* Deleting removes the shared R2 copy too, so it is worth a confirmation
          — a colleague's only version of a project can be behind this. */}
      <Dialog open={deleteTarget !== null} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <GlassDialogContent size="sm">
          <GlassDialogHeader>
            <DialogTitle>Projekt löschen</DialogTitle>
            <DialogDescription>
              „{deleteTarget?.name}" wird hier und im Team-Speicher gelöscht.
            </DialogDescription>
          </GlassDialogHeader>
          <GlassDialogBody>
            <p className="text-sm text-muted-foreground">
              {deleteTarget?.remote
                ? 'Auch Kolleg:innen können das Projekt danach nicht mehr öffnen. Bereits veröffentlichte Modelle bleiben im CDN – eingebettete Widgets auf Kundenseiten laufen weiter.'
                : 'Dieses Projekt war nie synchronisiert und existiert nur in diesem Browser – danach ist es weg.'}
            </p>
          </GlassDialogBody>
          <GlassDialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const target = deleteTarget;
                setDeleteTarget(null);
                if (target) await deleteProject(target.id);
              }}
            >
              Löschen
            </Button>
          </GlassDialogFooter>
        </GlassDialogContent>
      </Dialog>

      <ExportDialog open={showExportDialog} onOpenChange={setShowExportDialog} project={exportProject} />
    </div>
  );
}

export default DashboardPage;
