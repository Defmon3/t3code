import { ChevronDownIcon } from "lucide-react";
import {
  useEffect,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ListFilterOption } from "./ListFilterMenu";

/** A compact stand-in for one pill group when the header is narrow. */
export function CompactFilterMenu<Value extends string>({
  label,
  triggerIcon,
  triggerLabel,
  outlined = false,
  iconOnly = false,
  value,
  options,
  onChange,
  className,
  children,
}: {
  label: string;
  triggerIcon?: ReactNode;
  triggerLabel?: string;
  outlined?: boolean;
  iconOnly?: boolean;
  value: Value;
  options: ReadonlyArray<ListFilterOption<Value>>;
  onChange: (value: Value) => void;
  className?: string;
  children?: ReactNode;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={triggerLabel || iconOnly ? `${label}: ${current.label}` : label}
        title={iconOnly ? `${label}: ${current.label}` : undefined}
        render={
          outlined ? (
            <Button variant="outline" size={iconOnly ? "icon" : "default"} />
          ) : (
            <Button variant="ghost-muted" size="sm" />
          )
        }
        className={cn("min-w-0", className)}
      >
        {iconOnly ? (
          <current.Icon aria-hidden className="size-4" />
        ) : triggerLabel ? (
          <>
            {triggerIcon}
            <span>{triggerLabel}</span>
          </>
        ) : (
          <>
            <span className="truncate">{current.label}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        {children ?? (
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (next !== value) onChange(next as Value);
            }}
          >
            {options.map((option) => {
              const item = (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={option.unavailable !== undefined}
                  className="data-disabled:pointer-events-auto"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <option.Icon aria-hidden className="size-3.5" />
                    {option.label}
                  </span>
                </MenuRadioItem>
              );
              return option.unavailable === undefined ? (
                item
              ) : (
                <Tooltip key={option.value}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="right">{option.unavailable}</TooltipPopup>
                </Tooltip>
              );
            })}
          </MenuRadioGroup>
        )}
      </MenuPopup>
    </Menu>
  );
}

export function useListSearchShortcut({
  active,
  condensed,
  inFlowSearchRef,
  setSearchOpen,
  setSearchFocusToken,
}: {
  active: boolean;
  condensed: boolean;
  inFlowSearchRef: RefObject<HTMLDivElement | null>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setSearchFocusToken: Dispatch<SetStateAction<number>>;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Listen for the editor search shortcut while this view is active.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      if (
        event.target instanceof HTMLElement &&
        !inFlowSearchRef.current?.contains(event.target) &&
        (event.target.isContentEditable || event.target.closest("input, textarea, select"))
      ) {
        return;
      }
      event.preventDefault();
      if (condensed) {
        setSearchOpen(true);
        setSearchFocusToken((token) => token + 1);
        return;
      }
      const input = inFlowSearchRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, condensed, inFlowSearchRef, setSearchFocusToken, setSearchOpen]);
}
