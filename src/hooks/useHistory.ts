import { useCallback, useRef, useState } from 'react';

export type Command = {
  type: string;
  label: string;
  /** Applies the "after" state. Must be idempotent and safe to re-run (redo). */
  execute: () => void;
  /** Applies the "before" state. */
  undo: () => void;
  /**
   * Consecutive commands sharing a merge key collapse into a single undo step
   * while they keep arriving. Without it a slider drag would push one command
   * per pointer move.
   */
  mergeKey?: string;
};

type StackEntry = Command & { at: number };

export type HistoryState = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
};

const MAX_HISTORY = 50;
/** How long a mergeable command stays open for further merges. */
const COALESCE_MS = 600;

/**
 * Builds a command from a before/after value pair and a single applier,
 * the shape almost every editor edit takes, so callers stay one-liners.
 */
export function stateCommand<T>(options: {
  type: string;
  label: string;
  before: T;
  after: T;
  apply: (value: T) => void;
  mergeKey?: string;
}): Command {
  const { type, label, before, after, apply, mergeKey } = options;
  return {
    type,
    label,
    mergeKey,
    execute: () => apply(after),
    undo: () => apply(before),
  };
}

export function useHistory() {
  const undoStack = useRef<StackEntry[]>([]);
  const redoStack = useRef<StackEntry[]>([]);
  const [state, setState] = useState<HistoryState>({
    canUndo: false,
    canRedo: false,
    undoLabel: '',
    redoLabel: '',
  });

  const updateState = useCallback(() => {
    setState({
      canUndo: undoStack.current.length > 0,
      canRedo: redoStack.current.length > 0,
      undoLabel: undoStack.current[undoStack.current.length - 1]?.label ?? '',
      redoLabel: redoStack.current[redoStack.current.length - 1]?.label ?? '',
    });
  }, []);

  /**
   * Records an already-applied command. Mergeable commands that arrive shortly
   * after one with the same key replace only that entry's "after" state, so the
   * original "before" stays the single undo target for the whole gesture.
   */
  const push = useCallback(
    (command: Command) => {
      const now = Date.now();
      const top = undoStack.current[undoStack.current.length - 1];

      if (command.mergeKey && top?.mergeKey === command.mergeKey && now - top.at < COALESCE_MS) {
        top.execute = command.execute;
        top.label = command.label;
        top.at = now;
      } else {
        undoStack.current.push({ ...command, at: now });
        if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
      }

      redoStack.current = [];
      updateState();
    },
    [updateState],
  );

  const execute = useCallback(
    (command: Command) => {
      command.execute();
      push(command);
    },
    [push],
  );

  const undo = useCallback(() => {
    const command = undoStack.current.pop();
    if (!command) return;
    command.undo();
    redoStack.current.push(command);
    updateState();
  }, [updateState]);

  const redo = useCallback(() => {
    const command = redoStack.current.pop();
    if (!command) return;
    command.execute();
    // Drop the merge key so a following gesture on the same control starts a
    // fresh undo step instead of swallowing the redo.
    undoStack.current.push({ ...command, mergeKey: undefined, at: Date.now() });
    updateState();
  }, [updateState]);

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    updateState();
  }, [updateState]);

  return { ...state, execute, push, undo, redo, clear };
}
