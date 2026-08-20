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

export function setProjectSkillShortcutColor(
  colors: ProjectSkillShortcutColors,
  shortcut: string,
  color: ProjectSkillShortcutColor | null,
): ProjectSkillShortcutColors {
  const next = { ...colors };
  if (color === null) {
    delete next[shortcut];
  } else {
    next[shortcut] = color;
  }
  return next;
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

const shortcutColorClassNames = {
  red: "border-red-500/40 bg-red-500/15 text-red-950 hover:bg-red-500/25 dark:text-red-100",
  orange:
    "border-orange-500/40 bg-orange-500/15 text-orange-950 hover:bg-orange-500/25 dark:text-orange-100",
  amber:
    "border-amber-500/40 bg-amber-500/15 text-amber-950 hover:bg-amber-500/25 dark:text-amber-100",
  lime: "border-lime-500/40 bg-lime-500/15 text-lime-950 hover:bg-lime-500/25 dark:text-lime-100",
  green:
    "border-green-500/40 bg-green-500/15 text-green-950 hover:bg-green-500/25 dark:text-green-100",
  cyan: "border-cyan-500/40 bg-cyan-500/15 text-cyan-950 hover:bg-cyan-500/25 dark:text-cyan-100",
  blue: "border-blue-500/40 bg-blue-500/15 text-blue-950 hover:bg-blue-500/25 dark:text-blue-100",
  violet:
    "border-violet-500/40 bg-violet-500/15 text-violet-950 hover:bg-violet-500/25 dark:text-violet-100",
  pink: "border-pink-500/40 bg-pink-500/15 text-pink-950 hover:bg-pink-500/25 dark:text-pink-100",
  rose: "border-rose-500/40 bg-rose-500/15 text-rose-950 hover:bg-rose-500/25 dark:text-rose-100",
} satisfies Record<ProjectSkillShortcutColor, string>;

const shortcutColorSwatchClassNames = {
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  lime: "bg-lime-500",
  green: "bg-green-500",
  cyan: "bg-cyan-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
  rose: "bg-rose-500",
} satisfies Record<ProjectSkillShortcutColor, string>;

function SortableShortcut(props: {
  shortcut: string;
  color: ProjectSkillShortcutColor | undefined;
  onInvoke: (shortcut: string) => void;
  onInsert: (shortcut: string) => void;
  onColorChange: (shortcut: string, color: ProjectSkillShortcutColor | null) => void;
  onRemove: (shortcut: string) => void;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.shortcut,
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
                  type="button"
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-md border border-border/70 bg-background px-2 py-1 text-xs font-medium hover:bg-accent",
                    props.color && shortcutColorClassNames[props.color],
                    isDragging && "opacity-50",
                  )}
                  style={{ transform: CSS.Transform.toString(transform), transition }}
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
                    setPaletteOpen(true);
                  }}
                  {...attributes}
                  {...listeners}
                />
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
      <PopoverPopup align="start" side="top" className="w-auto" viewportClassName="p-2">
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Button color
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {PROJECT_SKILL_SHORTCUT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`${color} button color`}
              aria-pressed={props.color === color}
              className={cn(
                "flex size-6 items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-popover hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring",
                shortcutColorSwatchClassNames[color],
                props.color === color && "ring-2 ring-foreground/70",
              )}
              onClick={() => {
                props.onColorChange(props.shortcut, color);
                setPaletteOpen(false);
              }}
            >
              {props.color === color ? (
                <CheckIcon aria-hidden className="size-3.5 text-white drop-shadow-sm" />
              ) : null}
            </button>
          ))}
        </div>
        <div className="mt-2 border-t border-border/70 pt-1.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent"
            onClick={() => {
              props.onColorChange(props.shortcut, null);
              setPaletteOpen(false);
            }}
          >
            <span className="flex size-4 items-center justify-center rounded-full border border-border bg-background">
              {props.color === undefined ? <CheckIcon aria-hidden className="size-2.5" /> : null}
            </span>
            Default
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-destructive hover:bg-destructive/10"
            onClick={() => {
              props.onRemove(props.shortcut);
              setPaletteOpen(false);
            }}
          >
            <Trash2Icon aria-hidden className="size-3.5" />
            Remove
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ProjectSkillShortcutBar(props: {
  shortcuts: readonly string[];
  colors: ProjectSkillShortcutColors;
  onChange: (shortcuts: string[], colors: ProjectSkillShortcutColors) => void;
  onInvoke: (shortcut: string) => void;
  onInsert: (shortcut: string) => void;
}) {
  const [shortcuts, setShortcuts] = useState(() => [...props.shortcuts]);
  const [colors, setColors] = useState<ProjectSkillShortcutColors>(() => ({ ...props.colors }));
  const shortcutsRef = useRef(shortcuts);
  const colorsRef = useRef(colors);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useEffect(() => {
    if (
      shortcutsEqual(shortcutsRef.current, props.shortcuts) &&
      shortcutColorsEqual(colorsRef.current, props.colors)
    ) {
      return;
    }
    const nextShortcuts = [...props.shortcuts];
    const nextColors = { ...props.colors };
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
    setShortcuts(next.shortcuts);
    setColors(next.colors);
    props.onChange(next.shortcuts, next.colors);
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
    <div className={projectSkillShortcutBarClassName} aria-label="Project quick slots">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shortcuts} strategy={rectSortingStrategy}>
          {shortcuts.map((shortcut) => (
            <SortableShortcut
              key={shortcut}
              shortcut={shortcut}
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
