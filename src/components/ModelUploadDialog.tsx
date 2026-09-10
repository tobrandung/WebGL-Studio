import { useState, useRef, useCallback } from 'react';
import { Upload, FileBox, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { isSupportedModelFile, IMPORT_ACCEPT } from '@/three/viewport';

type ModelUploadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (file: File) => void;
  /**
   * Name of the model whose file is being swapped out. Set it to switch the
   * dialog from "add a model" to "replace this model's file"; the wording has
   * to say so, since replacing keeps the transform and drops the old geometry.
   */
  replacing?: string | null;
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export function ModelUploadDialog({
  open,
  onOpenChange,
  onUpload,
  replacing,
}: ModelUploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File) => {
    setError('');
    if (!isSupportedModelFile(f.name)) {
      setError('Nicht unterstütztes Format. Erlaubt ist nur .glb.');
      return;
    }
    if (f.size > MAX_FILE_SIZE) {
      setError('Datei zu groß. Maximale Größe: 100 MB.');
      return;
    }
    setFile(f);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const handleSubmit = () => {
    if (!file) return;
    onUpload(file);
    setFile(null);
    onOpenChange(false);
  };

  const reset = () => {
    setFile(null);
    setError('');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="min-w-0 overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{replacing ? 'Modell austauschen' : 'Modell hinzufügen'}</DialogTitle>
          <DialogDescription>
            {replacing
              ? `Ersetzt die Datei von „${replacing}“. Name, Position, Rotation und Skalierung bleiben erhalten.`
              : 'Lade ein 3D-Modell als .glb hoch. Max. 100 MB.'}
          </DialogDescription>
        </DialogHeader>

        {!file ? (
          <div
            className={`flex h-40 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors ${
              dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground'
            }`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
            aria-label="Datei hochladen"
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Datei hierher ziehen oder klicken</p>
            <p className="text-xs text-muted-foreground">Nur .glb</p>
            <Input
              ref={inputRef}
              type="file"
              accept={IMPORT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-3 overflow-hidden rounded-lg bg-secondary p-3">
            <FileBox className="h-8 w-8 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 overflow-hidden">
              <p className="truncate text-sm font-medium" title={file.name}>
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {(file.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            </div>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={reset}>
              Ändern
            </Button>
          </div>
        )}

        <div className="flex gap-2.5 rounded-lg bg-secondary/60 p-3 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">
              Bitte mit Material und Texturen exportieren.
            </p>
            <p className="mt-1">
              GLB legt die Texturen als Chunks in die Datei — sie kommen also mit, solange der
              Export Materialien einschließt. Aus FBX, OBJ oder Collada vorher ein GLB machen
              (Blender: Import, dann „glTF 2.0 (.glb)“ exportieren).
            </p>
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button disabled={!file} onClick={handleSubmit}>
            {replacing ? 'Austauschen' : 'Hinzufügen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
