import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeWorktreeBranchName, sanitizeWorktreeBranchNameInput } from "@t3tools/shared/git";
import { useDeferredValue, useEffect, useRef } from "react";

import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";

interface BranchToolbarWorktreeNameInputProps {
  environmentId: EnvironmentId;
  /** Project root the refs are checked against (the worktree doesn't exist yet). */
  cwd: string;
  value: string;
  onValueChange: (value: string) => void;
  onConflictChange?: (conflict: boolean) => void;
}

/**
 * Low-profile input naming the branch the next worktree is created with.
 * Left empty, the branch name is generated from the first message instead.
 * Marks itself invalid when a local branch with that name already exists.
 */
export function BranchToolbarWorktreeNameInput({
  environmentId,
  cwd,
  value,
  onValueChange,
  onConflictChange,
}: BranchToolbarWorktreeNameInputProps) {
  const normalizedValue = normalizeWorktreeBranchName(value);
  const deferredNormalizedValue = useDeferredValue(normalizedValue);
  const conflictRefsQuery = useEnvironmentQuery(
    deferredNormalizedValue === null
      ? null
      : vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd,
            query: deferredNormalizedValue,
            limit: 20,
          },
        }),
  );
  const conflict =
    deferredNormalizedValue !== null &&
    (conflictRefsQuery.data?.refs.some(
      (refName) => !refName.isRemote && refName.name === deferredNormalizedValue,
    ) ??
      false);

  const onConflictChangeRef = useRef(onConflictChange);
  onConflictChangeRef.current = onConflictChange;
  useEffect(() => {
    onConflictChangeRef.current?.(conflict);
  }, [conflict]);
  // The conflict gate must not outlive the input (e.g. switching back to
  // "Current checkout"), or it would block sends it no longer applies to.
  useEffect(() => () => onConflictChangeRef.current?.(false), []);

  return (
    <input
      type="text"
      value={value}
      onChange={(event) => onValueChange(sanitizeWorktreeBranchNameInput(event.target.value))}
      placeholder="custom branch name"
      spellCheck={false}
      autoComplete="off"
      aria-label="Branch name for the new worktree"
      aria-invalid={conflict || undefined}
      title={conflict ? `Branch "${deferredNormalizedValue}" already exists.` : undefined}
      className={cn(
        "h-7 min-w-0 flex-1 max-w-44 rounded-md bg-transparent px-2 font-mono text-xs outline-none transition-colors sm:h-6",
        "placeholder:font-sans placeholder:text-muted-foreground/50",
        "hover:bg-muted/40 focus:bg-muted/40",
        conflict ? "text-destructive" : "text-muted-foreground/70 focus:text-foreground/80",
      )}
    />
  );
}
