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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  PROJECT_SKILL_SHORTCUT_COLORS,
  type ProjectSkillShortcutColor,
  type ProjectSkillShortcutColors,
} from "@t3tools/contracts";
import { CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  addProjectSkillShortcut,
  removeProjectSkillShortcut,
  reorderProjectSkillShortcuts,
  resolveProjectSkillShortcutActivation,
  setProjectSkillShortcutColor,
  applyProjectSkillShortcutLocalChange,
  createProjectSkillShortcutSyncState,
  reconcileProjectSkillShortcutProjection,
  rejectProjectSkillShortcutLocalChange,
  type ProjectSkillShortcutSnapshot,
} from "./ProjectSkillShortcutBar.logic";

const projectSkillShortcutBarClassName =
  "flex h-auto min-h-9 w-full flex-wrap items-center gap-1 overflow-visible rounded-t-3xl border-b border-border/65 bg-muted/20 px-3 py-1 sm:px-4";

const projectSkillShortcutButtonClassName =
  "min-w-0 max-w-full shrink-0 break-all whitespace-normal text-left rounded-md border border-border/70 bg-background px-2 py-1 text-xs font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-64";

function shortcutsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((shortcut, index) => shortcut === right[index]);
}

function shortcutColorsEqual(
  left: ProjectSkillShortcutColors,
  right: ProjectSkillShortcutColors,
): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([shortcut, color]) => right[shortcut] === color)
  );
}

function SortableShortcut(props: {
  shortcut: string;
  color: ProjectSkillShortcutColor | undefined;
  disabled: boolean;
  onInvoke: (shortcut: string) => void;
  onInsert: (shortcut: string) => void;
  onColorChange: (shortcut: string, color: ProjectSkillShortcutColor | null) => void;
  onRemove: (shortcut: string) => void;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.shortcut,
    disabled: props.disabled,
  });
  return (
    <Popover
      open={paletteOpen}
      onOpenChange={(open) => {
        if (!open) setPaletteOpen(false);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  ref={setNodeRef}
                  disabled={props.disabled}
                  type="button"
                  className={cn(projectSkillShortcutButtonClassName, isDragging && "opacity-50")}
                  style={{
                    transform: CSS.Transform.toString(transform),
                    transition,
                    ...(props.color
                      ? {
                          backgroundColor: `color-mix(in srgb, var(--color-${props.color}-500) 20%, var(--background))`,
                          borderColor: `color-mix(in srgb, var(--color-${props.color}-500) 50%, var(--border))`,
                        }
                      : {}),
                  }}
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    setPaletteOpen(false);
                    if (resolveProjectSkillShortcutActivation(event.altKey) === "insert") {
                      props.onInsert(props.shortcut);
                      return;
                    }
                    props.onInvoke(props.shortcut);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!props.disabled) setPaletteOpen(true);
                  }}
                  aria-label={props.shortcut}
                  {...attributes}
                  {...listeners}
                  onKeyDown={(event) => {
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      if (!props.disabled) setPaletteOpen(true);
                    } else {
                      listeners?.onKeyDown?.(event);
                    }
                  }}
                >
                  <span className="block break-all">{props.shortcut}</span>
                </button>
              }
            />
          }
        >
          {props.shortcut}
        </TooltipTrigger>
        <TooltipPopup side="top">
          Click to send · Alt-click to add to composer · Right-click to customize
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" side="top" className="w-auto">
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Button color
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {PROJECT_SKILL_SHORTCUT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              style={{ backgroundColor: `var(--color-${color}-500)` }}
              disabled={props.disabled}
              aria-label={`${color} button color`}
              aria-pressed={props.color === color}
              className={cn(
                "flex size-7 items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-popover hover:scale-105 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                props.color === color && "ring-2 ring-foreground/70",
              )}
              onClick={() => {
                props.onColorChange(props.shortcut, color);
                setPaletteOpen(false);
              }}
            >
              {props.color === color ? (
                <CheckIcon aria-hidden className="size-3.5 text-foreground" />
              ) : null}
            </button>
          ))}
        </div>
        <div className="mt-2 border-t border-border/70 pt-1.5">
          <Button
            variant="ghost"
            size="compact"
            disabled={props.disabled}
            onClick={() => {
              props.onColorChange(props.shortcut, null);
              setPaletteOpen(false);
            }}
          >
            <span className="flex size-4 items-center justify-center rounded-full border border-border bg-background">
              {props.color === undefined ? <CheckIcon aria-hidden className="size-2.5" /> : null}
            </span>
            Default
          </Button>
          <Button
            variant="ghost-destructive"
            size="compact"
            disabled={props.disabled}
            onClick={() => {
              props.onRemove(props.shortcut);
              setPaletteOpen(false);
            }}
          >
            <Trash2Icon aria-hidden className="size-3.5" />
            Remove
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ProjectSkillShortcutBar(props: {
  shortcuts: readonly string[];
  colors: ProjectSkillShortcutColors;
  onChange: (shortcuts: string[], colors: ProjectSkillShortcutColors) => Promise<void>;
  disabled?: boolean;
  onInvoke: (shortcut: string) => void;
  onInsert: (shortcut: string) => void;
}) {
  const [shortcuts, setShortcuts] = useState(() => [...props.shortcuts]);
  const [colors, setColors] = useState<ProjectSkillShortcutColors>(() => ({ ...props.colors }));
  const shortcutsRef = useRef(shortcuts);
  const colorsRef = useRef(colors);
  const syncRef = useRef(
    createProjectSkillShortcutSyncState({ shortcuts: props.shortcuts, colors: props.colors }),
  );
  const projectionRef = useRef({ shortcuts: props.shortcuts, colors: props.colors });
  const [error, setError] = useState<{
    message: string;
    snapshot: ProjectSkillShortcutSnapshot;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useEffect(() => {
    projectionRef.current = { shortcuts: props.shortcuts, colors: props.colors };
    const next = reconcileProjectSkillShortcutProjection(syncRef.current, {
      shortcuts: [...props.shortcuts],
      colors: { ...props.colors },
    });
    syncRef.current = next;
    if (
      shortcutsEqual(shortcutsRef.current, next.current.shortcuts) &&
      shortcutColorsEqual(colorsRef.current, next.current.colors)
    ) {
      return;
    }
    const nextShortcuts = next.current.shortcuts;
    const nextColors = next.current.colors;
    shortcutsRef.current = nextShortcuts;
    colorsRef.current = nextColors;
    setShortcuts(nextShortcuts);
    setColors(nextColors);
  }, [props.colors, props.shortcuts]);
  const updateState = (
    update: (current: { shortcuts: string[]; colors: ProjectSkillShortcutColors }) => {
      shortcuts: string[];
      colors: ProjectSkillShortcutColors;
    },
  ) => {
    const current = { shortcuts: shortcutsRef.current, colors: colorsRef.current };
    const next = update(current);
    if (
      shortcutsEqual(current.shortcuts, next.shortcuts) &&
      shortcutColorsEqual(current.colors, next.colors)
    ) {
      return;
    }
    shortcutsRef.current = next.shortcuts;
    colorsRef.current = next.colors;
    syncRef.current = applyProjectSkillShortcutLocalChange(syncRef.current, next);
    setShortcuts(next.shortcuts);
    setColors(next.colors);
    setError(null);
    void props.onChange(next.shortcuts, next.colors).catch((cause: unknown) => {
      setError({
        message: cause instanceof Error ? cause.message : "Could not save quick slots.",
        snapshot: next,
      });
      const reverted = rejectProjectSkillShortcutLocalChange(
        syncRef.current,
        next,
        projectionRef.current,
      );
      syncRef.current = reverted;
      shortcutsRef.current = reverted.current.shortcuts;
      colorsRef.current = reverted.current.colors;
      setShortcuts(reverted.current.shortcuts);
      setColors(reverted.current.colors);
    });
  };
  const commit = () => {
    updateState((current) => ({
      ...current,
      shortcuts: addProjectSkillShortcut(current.shortcuts, value),
    }));
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
    updateState((current) => ({
      ...current,
      shortcuts: reorderProjectSkillShortcuts(
        current.shortcuts,
        String(event.active.id),
        String(over.id),
      ),
    }));
  };
  return (
    <div
      className={projectSkillShortcutBarClassName}
      aria-label="Project quick slots"
      data-project-skill-shortcut-bar="true"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shortcuts} strategy={rectSortingStrategy}>
          {shortcuts.map((shortcut) => (
            <SortableShortcut
              key={shortcut}
              shortcut={shortcut}
              disabled={props.disabled === true}
              color={colors[shortcut]}
              onInvoke={props.onInvoke}
              onInsert={props.onInsert}
              onColorChange={(value, color) =>
                updateState((current) => ({
                  ...current,
                  colors: setProjectSkillShortcutColor(current.colors, value, color),
                }))
              }
              onRemove={(value) =>
                updateState((current) => ({
                  shortcuts: removeProjectSkillShortcut(current.shortcuts, value),
                  colors: setProjectSkillShortcutColor(current.colors, value, null),
                }))
              }
            />
          ))}
        </SortableContext>
      </DndContext>
      {error ? (
        <div role="alert" className="flex w-full items-center gap-2 text-xs text-destructive">
          <span>{error.message}</span>
          <Button
            variant="ghost"
            size="compact"
            disabled={props.disabled}
            onClick={() => updateState(() => error.snapshot)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {adding ? (
        <Input
          size="compact"
          autoFocus
          disabled={props.disabled}
          maxLength={255}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          aria-label="Quick slot text"
        />
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={props.disabled}
          aria-label="Add quick slot"
          onClick={() => setAdding(true)}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
