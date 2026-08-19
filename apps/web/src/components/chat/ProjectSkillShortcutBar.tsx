import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";

export const projectSkillShortcutBarClassName =
  "flex h-auto min-h-9 w-full flex-wrap items-center gap-1 overflow-visible rounded-t-[19px] border-b border-border/65 bg-muted/20 px-3 py-1 sm:px-4";

export function normalizeProjectSkillShortcut(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveProjectSkillShortcutText(shortcut: string, provider: string): string {
  const marker = shortcut[0];
  if ((marker !== "/" && marker !== "$") || shortcut.length === 1) return shortcut;
  if (provider === "claudeAgent") return `/${shortcut.slice(1)}`;
  if (provider === "codex") return `$${shortcut.slice(1)}`;
  return shortcut;
}

export function resolveProjectSkillShortcutActivation(altKey: boolean): "insert" | "send" {
  return altKey ? "insert" : "send";
}

export function addProjectSkillShortcut(shortcuts: readonly string[], value: string): string[] {
  const shortcut = normalizeProjectSkillShortcut(value);
  if (!shortcut || shortcuts.includes(shortcut)) return [...shortcuts];
  return [...shortcuts, shortcut];
}

export function removeProjectSkillShortcut(
  shortcuts: readonly string[],
  shortcut: string,
): string[] {
  return shortcuts.filter((entry) => entry !== shortcut);
}

export function reorderProjectSkillShortcuts(
  shortcuts: readonly string[],
  active: string,
  over: string,
): string[] {
  const from = shortcuts.indexOf(active);
  const to = shortcuts.indexOf(over);
  if (from < 0 || to < 0 || from === to) return [...shortcuts];
  return arrayMove([...shortcuts], from, to);
}

function shortcutsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((shortcut, index) => shortcut === right[index]);
}

function SortableShortcut(props: {
  shortcut: string;
  onInvoke: (shortcut: string) => void;
  onInsert: (shortcut: string) => void;
  onRemove: (shortcut: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.shortcut,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={cn(
        "shrink-0 whitespace-nowrap rounded-md border border-border/70 bg-background px-2 py-1 text-xs font-medium hover:bg-accent",
        isDragging && "opacity-50",
      )}
      title="Click to send; Alt-click to add to composer"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (resolveProjectSkillShortcutActivation(event.altKey) === "insert") {
          props.onInsert(props.shortcut);
          return;
        }
        props.onInvoke(props.shortcut);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const localApi = readLocalApi();
        if (!localApi) return;
        void localApi.contextMenu
          .show([{ id: "remove", label: "Remove" }], { x: event.clientX, y: event.clientY })
          .then((choice) => {
            if (choice === "remove") props.onRemove(props.shortcut);
          });
      }}
      {...attributes}
      {...listeners}
    >
      {props.shortcut}
    </button>
  );
}

export function ProjectSkillShortcutBar(props: {
  shortcuts: readonly string[];
  onChange: (shortcuts: string[]) => void;
  onInvoke: (shortcut: string) => void;
  onInsert: (shortcut: string) => void;
}) {
  const [shortcuts, setShortcuts] = useState(() => [...props.shortcuts]);
  const shortcutsRef = useRef(shortcuts);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useEffect(() => {
    if (shortcutsEqual(shortcutsRef.current, props.shortcuts)) return;
    const next = [...props.shortcuts];
    shortcutsRef.current = next;
    setShortcuts(next);
  }, [props.shortcuts]);
  const updateShortcuts = (update: (current: string[]) => string[]) => {
    const current = shortcutsRef.current;
    const next = update(current);
    if (shortcutsEqual(current, next)) return;
    shortcutsRef.current = next;
    setShortcuts(next);
    props.onChange(next);
  };
  const commit = () => {
    updateShortcuts((current) => addProjectSkillShortcut(current, value));
    setValue("");
    setAdding(false);
  };
  const cancel = () => {
    setValue("");
    setAdding(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };
  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over;
    if (!over) return;
    updateShortcuts((current) =>
      reorderProjectSkillShortcuts(current, String(event.active.id), String(over.id)),
    );
  };
  return (
    <div className={projectSkillShortcutBarClassName} aria-label="Project quick slots">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shortcuts} strategy={rectSortingStrategy}>
          {shortcuts.map((shortcut) => (
            <SortableShortcut
              key={shortcut}
              shortcut={shortcut}
              onInvoke={props.onInvoke}
              onInsert={props.onInsert}
              onRemove={(value) =>
                updateShortcuts((current) => removeProjectSkillShortcut(current, value))
              }
            />
          ))}
        </SortableContext>
      </DndContext>
      {adding ? (
        <input
          autoFocus
          maxLength={255}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={cancel}
          className="h-7 min-w-28 shrink-0 rounded-md border border-border bg-background px-2 text-xs"
          aria-label="Quick slot text"
        />
      ) : (
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent"
          aria-label="Add quick slot"
          onClick={() => setAdding(true)}
        >
          <PlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
