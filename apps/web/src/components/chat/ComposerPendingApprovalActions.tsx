import { type ProviderApprovalOption, type RuntimeRequestId } from "@t3tools/contracts";
import { hookApprovalDurations } from "@t3tools/client-runtime/state/hook-approvals";
import type { ApprovalResponder } from "@t3tools/client-runtime/state/thread-requests";
import {
  approvalRejectionReason,
  type ApprovalExplanationView,
  type ApprovalRejectionDraft,
} from "@t3tools/client-runtime/state/approval-explanations";
import { memo, useId, useState } from "react";
import { ChevronDownIcon, EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  persistClientSettingsPatch,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  supportsFeedback?: boolean | undefined;
  explanation?: ApprovalExplanationView | undefined;
  supportsTimedApproval?: boolean | undefined;
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
  explanation,
  supportsTimedApproval = false,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
  commandExpansion,
}: ComposerPendingApprovalActionsProps) {
  const rememberedDuration = useClientSettings(
    (settings) => settings.rememberedHookApprovalDuration,
  );
  const preferencesReady = useClientSettingsHydrated();
  const [draft, setDraft] = useState<ApprovalRejectionDraft>({ status: "untouched" });
  const [feedbackFailed, setFeedbackFailed] = useState(false);
  const reasonId = useId();
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
  const reason = approvalRejectionReason(draft, explanation, canRejectWithReason);

  function closeReason() {
    setDraft({ status: "dismissed" });
    setFeedbackFailed(false);
  }

  async function rejectWithReason() {
    if (responseDisabled || !canRejectWithReason || !reason?.trim()) return;
    setDraft({ status: "edited", reason });
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
            autoFocus={draft.status === "manual"}
            aria-label="Reason for rejection"
            placeholder="Tell the agent what to change"
            value={reason}
            disabled={responseDisabled}
            onChange={(event) => {
              setDraft({ status: "edited", reason: event.target.value });
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
              {isResponding ? "Rejecting…" : "Reject with reason"}
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
        if (supportsTimedApproval && option.decision === "acceptForSession") {
          return (
            <span key={option.decision} className="flex max-w-full items-center gap-1">
              <Button
                size="sm-multiline"
                variant="outline"
                disabled={responseDisabled || !preferencesReady}
                onClick={() => {
                  if (!responseDisabled && preferencesReady)
                    void onRespondToApproval(
                      requestId,
                      "acceptForSession",
                      undefined,
                      rememberedDuration,
                    );
                }}
              >
                {hookApprovalDurations[rememberedDuration].approvalLabel}
              </Button>
              <Menu>
                <MenuTrigger
                  disabled={responseDisabled || !preferencesReady}
                  render={
                    <Button size="icon-sm" variant="outline" aria-label="Approval duration" />
                  }
                >
                  <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
                  {Object.values(hookApprovalDurations).map((choice) => (
                    <MenuItem
                      key={choice.duration}
                      disabled={responseDisabled || !preferencesReady}
                      onClick={() => {
                        if (!responseDisabled && preferencesReady) {
                          void persistClientSettingsPatch({
                            rememberedHookApprovalDuration: choice.duration,
                          });
                          void onRespondToApproval(
                            requestId,
                            "acceptForSession",
                            undefined,
                            choice.duration,
                          );
                        }
                      }}
                    >
                      {choice.label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </span>
          );
        }
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
      {canRejectWithReason && reason === null ? (
        <Button
          autoFocus={draft.status === "dismissed"}
          size="sm-multiline"
          variant="outline"
          disabled={responseDisabled}
          aria-expanded={reason !== null}
          aria-controls={reasonId}
          onClick={() => setDraft({ status: "manual" })}
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
