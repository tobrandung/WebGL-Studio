import { useNavigate } from 'react-router-dom';
import { MoreHorizontal, Copy, Pencil, Trash2, Download } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Project } from '@/lib/db';

type ProjectCardProps = {
  project: Project;
  /**
   * Whether this project also exists in R2. A project that lives only in
   * IndexedDB is one cache clear from gone, so the card says so rather than
   * leaving the distinction invisible.
   */
  synced?: boolean;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
};

export function ProjectCard({ project, synced, onRename, onDuplicate, onDelete, onExport }: ProjectCardProps) {
  const navigate = useNavigate();

  return (
    <Card
      className="group cursor-pointer overflow-hidden transition-colors hover:border-foreground/20"
      onClick={() => navigate(`/project/${project.id}`)}
    >
      <div className="relative aspect-video w-full bg-muted">
        {project.thumbnail ? (
          <img src={project.thumbnail} alt={project.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <svg className="h-10 w-10 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
          </div>
        )}
        <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="h-7 w-7"
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Projekt-Optionen"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Optionen</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => onRename(project.id)}>
                <Pencil className="mr-2 h-4 w-4" />
                Umbenennen
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate(project.id)}>
                <Copy className="mr-2 h-4 w-4" />
                Duplizieren
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport(project.id)}>
                <Download className="mr-2 h-4 w-4" />
                Exportieren
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-400 focus:text-red-400" onClick={() => onDelete(project.id)}>
                <Trash2 className="mr-2 h-4 w-4" />
                Löschen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <CardContent className="p-4">
        <p className="truncate text-sm font-medium">{project.name}</p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>
            {new Date(project.updatedAt).toLocaleDateString('de-DE', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
            })}
          </span>
          {synced === false && (
            <>
              <span aria-hidden>·</span>
              <span className="text-orange-400" title="Noch nicht ins Team-Backup synchronisiert">
                nur lokal
              </span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
