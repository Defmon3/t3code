import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("keeps the complete command readable in the compact row", () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(detail);
    expect(markup).toContain("max-h-20");
    expect(markup).toContain("overflow-auto");
    expect(markup).toContain("whitespace-pre");
    expect(markup).toContain("[scrollbar-width:thin]");
    expect(markup).toContain("[&amp;::-webkit-scrollbar]:h-1.5");
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
    expect(markup).toContain("min-w-0");
    expect(markup).not.toContain("Command approval requested");
  });

  it("falls back to the approval kind when the provider sends an empty detail", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-2"),
          requestKind: "file-read",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail: "",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("File read approval");
  });

  it("renders hook context inside the chat approval panel", () => {
    const reason = "Protected branch policy\nWorking Dir: G:\\argus\nBranch: main";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-hook-1"),
          requestKind: "command",
          createdAt: "2026-08-11T00:00:00.000Z",
          source: "hook",
          title: "Push protected branch?",
          description: "This command updates the shared remote branch.",
          reason,
          detail: "Bash: git push origin main",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Push protected branch?");
    expect(markup).toContain("Project hook");
    expect(markup).toContain('data-approval-reason="complete"');
    expect(markup).toContain(reason);
    expect(markup).toContain("This command updates the shared remote branch.");
    expect(markup).toContain("Bash: git push origin main");
    expect(markup).not.toContain('role="alertdialog"');
  });
});
