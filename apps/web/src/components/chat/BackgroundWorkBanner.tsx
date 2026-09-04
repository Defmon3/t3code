import type { BackgroundWorkItem } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

export function backgroundWorkSummary(items: ReadonlyArray<BackgroundWorkItem>): {
  readonly title: string;
  readonly description: string | undefined;
} {
  const first = items[0];
  return {
    title: `${items.length} background ${items.length === 1 ? "task" : "tasks"}`,
    description: first?.title,
  };
}

export function BackgroundWorkBanner({
  items,
  isStopping,
  onStop,
}: {
  readonly items: ReadonlyArray<BackgroundWorkItem>;
  readonly isStopping: boolean;
  readonly onStop: () => void;
}) {
  const [detailsVisible, setDetailsVisible] = useState(false);
  const detailsId = useId();
  const summary = backgroundWorkSummary(items);
  const working = items.some((item) => item.category === "agent");

  return (
    <>
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon>
          <ComposerBanner.Dot
            className={working ? "animate-status-pulse bg-foreground" : "bg-foreground"}
          />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="whitespace-nowrap">
          <span className="min-w-0 font-medium leading-7 sm:leading-6">{summary.title}</span>
          {summary.description ? (
            <span className="min-w-0 shrink-[9999] truncate text-muted-foreground">
              {summary.description}
            </span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={detailsVisible}
            aria-controls={detailsId}
            onClick={() => setDetailsVisible((visible) => !visible)}
          >
            {detailsVisible ? "Hide details" : "Details"}
          </Button>
          <Button size="xs" variant="ghost" disabled={isStopping} onClick={onStop}>
            {isStopping ? "Stopping..." : "Stop"}
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {detailsVisible ? (
        <ComposerBanner.Scroll>
          <ComposerBanner.Children id={detailsId} role="list" aria-label="Background work details">
            {items.map((item) => (
              <ComposerBanner.Row key={item.taskId} role="listitem">
                <ComposerBanner.Icon>
                  <ComposerBanner.Dot className="bg-muted-foreground" />
                </ComposerBanner.Icon>
                <ComposerBanner.Content className="min-w-0">
                  <span className="truncate">{item.title ?? item.taskType ?? item.taskId}</span>
                  <span className="truncate text-muted-foreground">
                    {item.category} · {item.status}
                  </span>
                </ComposerBanner.Content>
              </ComposerBanner.Row>
            ))}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      ) : null}
    </>
  );
}
