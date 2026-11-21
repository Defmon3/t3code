import { cn } from "~/lib/utils";

function GhostBar({ className }: { className?: string | undefined }) {
  return <div aria-hidden className={cn("h-3 rounded bg-muted-foreground/15", className)} />;
}

/** The detail's own shape: a title, a byline, the facts rows, the description. */
export function DetailGhost({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="motion-safe:animate-skeleton flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <div className="shrink-0 border-b border-border/60">
        <div className="flex h-7 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <GhostBar className="w-24" />
            <GhostBar className="w-9" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <GhostBar className="h-5 w-16 rounded-md" />
            <GhostBar className="size-5 rounded-md" />
          </div>
        </div>

        <div className="px-4 pb-4 pt-1">
          <GhostBar className="h-5 w-4/5 max-w-md" />
          <div className="mt-2 flex items-center gap-1.5">
            <GhostBar className="size-4 rounded-full" />
            <GhostBar className="w-24" />
          </div>
        </div>

        <div className="flex min-h-10 items-center justify-between gap-3 border-t border-border/60 px-4 py-2">
          <div className="flex items-center gap-1 p-0.5">
            <GhostBar className="h-6 w-16 rounded-md" />
            <GhostBar className="h-6 w-16 rounded-md" />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <section className="px-4 py-3">
          {(
            [
              ["w-14", "w-24"],
              ["w-10", "w-20"],
              ["w-14", "w-20"],
            ] as const
          ).map(([name, value]) => (
            <div
              key={name + value}
              className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2"
            >
              <div className="flex items-center gap-1.5">
                <GhostBar className="size-3.5 rounded-full" />
                <GhostBar className={name} />
              </div>
              <GhostBar className={value} />
            </div>
          ))}
        </section>

        <section className="border-t border-border/60">
          <div className="flex min-h-11 items-center gap-1.5 px-4 py-3">
            <GhostBar className="h-4 w-24" />
            <GhostBar className="size-3.5 rounded-full" />
          </div>
          <div className="space-y-2 px-4 pb-4">
            <GhostBar className="w-full" />
            <GhostBar className="w-11/12" />
            <GhostBar className="w-4/5" />
            <GhostBar className="w-2/3" />
          </div>
        </section>
      </div>
    </div>
  );
}
