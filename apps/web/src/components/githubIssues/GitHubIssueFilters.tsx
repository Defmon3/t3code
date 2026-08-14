import type { GitHubIssueListInput } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

export type GitHubIssueFiltersValue = NonNullable<GitHubIssueListInput["filters"]>;

interface GitHubIssueFiltersProps {
  readonly value: GitHubIssueFiltersValue;
  readonly sort: GitHubIssueListInput["sort"];
  readonly wide: boolean;
  readonly onChange: (value: GitHubIssueFiltersValue) => void;
  readonly onSortChange: (sort: GitHubIssueListInput["sort"]) => void;
}

const textFields = [
  ["author", "Author"],
  ["assignee", "Assignees"],
  ["milestone", "Milestones"],
  ["issueType", "Types"],
] as const;

function trimmed(value: string): string | undefined {
  const result = value.trim();
  return result.length === 0 ? undefined : result;
}

export function GitHubIssueFilters({
  value,
  sort,
  wide,
  onChange,
  onSortChange,
}: GitHubIssueFiltersProps) {
  const [labelInput, setLabelInput] = useState("");
  const activeCount = useMemo(
    () =>
      textFields.filter(([key]) => value[key] !== undefined).length + (value.labels?.length ?? 0),
    [value],
  );
  const updateText = (key: Exclude<keyof GitHubIssueFiltersValue, "labels">, next: string) => {
    const normalized = trimmed(next);
    onChange({
      ...value,
      ...(normalized === undefined ? { [key]: undefined } : { [key]: normalized }),
    });
  };
  const addLabel = () => {
    const label = trimmed(labelInput);
    if (!label || (value.labels?.length ?? 0) >= 10 || value.labels?.includes(label)) return;
    onChange({ ...value, labels: [...(value.labels ?? []), label] });
    setLabelInput("");
  };
  const controls = (
    <>
      {textFields.map(([key, label]) => (
        <label className="flex min-w-28 flex-col gap-1 text-xs text-muted-foreground" key={key}>
          <span>{label}</span>
          <Input
            size="sm"
            value={value[key] ?? ""}
            onChange={(event) => updateText(key, event.target.value)}
            placeholder={label}
            aria-label={label}
          />
        </label>
      ))}
      <div className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        <span>Labels</span>
        <div className="flex gap-1">
          <Input
            size="sm"
            value={labelInput}
            onChange={(event) => setLabelInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addLabel();
              }
            }}
            placeholder="Labels"
            aria-label="Labels"
          />
          <Button
            size="xs"
            variant="outline"
            onClick={addLabel}
            disabled={(value.labels?.length ?? 0) >= 10}
          >
            Add
          </Button>
        </div>
        {value.labels?.length ? (
          <div className="flex flex-wrap gap-1">
            {value.labels.map((label) => (
              <Button
                key={label}
                size="xs"
                variant="secondary"
                onClick={() =>
                  onChange({ ...value, labels: value.labels?.filter((item) => item !== label) })
                }
                aria-label={`Remove label ${label}`}
              >
                {label} <XIcon className="size-3" />
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
  const clearAll = () => onChange({});

  return (
    <div className="flex flex-wrap items-end gap-2">
      {wide ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">{controls}</div>
      ) : (
        <details className="relative">
          <summary className="inline-flex h-7 cursor-pointer items-center rounded-[var(--control-radius)] border border-input px-2 text-xs font-medium">
            Filters{activeCount ? ` (${activeCount})` : ""}
          </summary>
          <div className="absolute left-0 z-20 mt-1 flex w-[min(28rem,calc(100vw-2rem))] flex-wrap gap-2 rounded-lg border border-border bg-popover p-3 shadow-lg">
            {controls}
            <Button size="xs" variant="ghost" onClick={clearAll} disabled={activeCount === 0}>
              Clear all
            </Button>
          </div>
        </details>
      )}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>Sort</span>
        <select
          className="h-7 rounded-[var(--control-radius)] border border-input bg-background px-2 text-xs text-foreground"
          aria-label="Sort issues"
          value={sort}
          onChange={(event) => onSortChange(event.target.value as GitHubIssueListInput["sort"])}
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
        </select>
      </label>
      {wide ? (
        <Button size="xs" variant="ghost" onClick={clearAll} disabled={activeCount === 0}>
          Clear all
        </Button>
      ) : null}
    </div>
  );
}
