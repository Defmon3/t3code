import { type ProviderApprovalOption, type RuntimeRequestId } from "@t3tools/contracts";
import type { ApprovalResponder } from "@t3tools/client-runtime/state/thread-requests";
import { memo, useId, useRef, useState } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  supportsFeedback?: boolean | undefined;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: ApprovalResponder;
  commandExpansion?: {
    readonly expanded: boolean;
    readonly detailId: string;
    readonly onToggle: () => void;
  };
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  supportsFeedback = false,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
  commandExpansion,
}: ComposerPendingApprovalActionsProps) {
  const [reason, setReason] = useState<string | null>(null);
  const [feedbackFailed, setFeedbackFailed] = useState(false);
  const reasonId = useId();
  const reasonTrigger = useRef<HTMLButtonElement>(null);
  const primaryOptions = options.filter(
    (option) =>
      option.decision === "decline" ||
      option.decision === "acceptForSession" ||
      option.decision === "accept",
  );
  const moreOptions = options.filter((option) => !primaryOptions.includes(option));
  const responseDisabled = disabled || isResponding || !canRespond;
  const canRejectWithReason =
    supportsFeedback && options.some((option) => option.decision === "decline");

  function closeReason() {
    setReason(null);
    setFeedbackFailed(false);
    reasonTrigger.current?.focus();
  }

  async function rejectWithReason() {
    if (responseDisabled || !canRejectWithReason || !reason?.trim()) return;
    const result = await onRespondToApproval(requestId, "decline", reason.trim());
    if (result?._tag === "Success") closeReason();
    else setFeedbackFailed(true);
  }

  return (
    <>
      {canRejectWithReason && reason !== null ? (
        <span className="flex w-full min-w-0 flex-col gap-2" id={reasonId}>
          <Textarea
            size="sm"
            autoFocus
            aria-label="Reason for rejection"
            placeholder="Tell the agent what to change"
            value={reason}
            disabled={responseDisabled}
            onChange={(event) => {
              setReason(event.target.value);
              setFeedbackFailed(false);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape" && !isResponding) {
                event.preventDefault();
                closeReason();
              }
            }}
          />
          {feedbackFailed ? (
            <span role="alert" className="text-sm text-destructive">
              Rejection failed. Your reason is kept. Try again.
            </span>
          ) : null}
          <span className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm-multiline"
              variant="outline"
              disabled={isResponding}
              onClick={closeReason}
            >
              Cancel
            </Button>
            <Button
              size="sm-multiline"
              disabled={responseDisabled || !reason.trim()}
              onClick={() => void rejectWithReason()}
            >
              {isResponding ? "Rejecting…" : "Reject and send reason"}
            </Button>
          </span>
        </span>
      ) : null}
      {commandExpansion ? (
        <Button
          size="sm-multiline"
          variant="outline"
          aria-expanded={commandExpansion.expanded}
          aria-controls={commandExpansion.detailId}
          onClick={commandExpansion.onToggle}
        >
          {commandExpansion.expanded ? "Collapse" : "Expand"}
        </Button>
      ) : null}
      {primaryOptions.map((option) => {
        const button = (
          <Button
            key={option.decision}
            size="sm-multiline"
            className="max-w-full"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={responseDisabled}
            aria-description={option.warning}
            onClick={() => {
              if (!responseDisabled) {
                void onRespondToApproval(requestId, option.decision);
              }
            }}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="min-w-0 max-w-40 wrap-anywhere">{option.label}</span>
          </Button>
        );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {canRejectWithReason ? (
        <Button
          ref={reasonTrigger}
          size="sm-multiline"
          variant="outline"
          disabled={responseDisabled}
          aria-expanded={reason !== null}
          aria-controls={reasonId}
          onClick={() => (reason === null ? setReason("") : closeReason())}
        >
          Reject with reason
        </Button>
      ) : null}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={responseDisabled}
            render={<Button size="icon-xs" variant="outline" aria-label="More approval options" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={responseDisabled}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!responseDisabled) void onRespondToApproval(requestId, option.decision);
                  }}
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});
