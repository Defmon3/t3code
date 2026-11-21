import { hookApprovalDurations } from "@t3tools/client-runtime/state/hook-approvals";
import type { ApprovalResponder } from "@t3tools/client-runtime/state/thread-requests";
import {
  approvalRejectionReason,
  type ApprovalExplanationView,
  type ApprovalRejectionDraft,
} from "@t3tools/client-runtime/state/approval-explanations";
import { memo, useId, useState } from "react";
import { ChevronDownIcon, EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { type ProviderApprovalOption, type RuntimeRequestId } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { Button, InlineButton } from "../ui/button";
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
  presentation?: "composer" | "inline";
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
  {
    decision: "cancel",
    label: msg("Cancel", { $context: "verb, response to an approval request" }),
  },
  {
    decision: "decline",
    label: msg("Decline", { $context: "verb, response to an approval request" }),
  },
  { decision: "acceptForSession", label: msg("Always allow this session") },
  {
    decision: "accept",
    label: msg("Approve", { $context: "verb, response to an approval request" }),
  },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  presentation = "composer",
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
  const gt = useGT();
  const m = useMessages();
  // Provider options carry server-authored labels; only the built-in defaults are translated.
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
            aria-label={gt("Reason for rejection")}
            placeholder={gt("Tell the agent what to change")}
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
              <T>Rejection failed. Your reason is kept. Try again.</T>
            </span>
          ) : null}
          <span className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm-multiline"
              variant="outline"
              disabled={isResponding}
              onClick={closeReason}
            >
              <T>Cancel</T>
            </Button>
            <Button
              size="sm-multiline"
              disabled={responseDisabled || !reason.trim()}
              onClick={() => void rejectWithReason()}
            >
              {isResponding ? gt("Rejecting…") : gt("Reject with reason")}
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
          {commandExpansion.expanded ? gt("Collapse") : gt("Expand")}
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
                {m(hookApprovalDurations[rememberedDuration].approvalLabel)}
              </Button>
              <Menu>
                <MenuTrigger
                  disabled={responseDisabled || !preferencesReady}
                  render={
                    <Button size="icon-sm" variant="outline" aria-label={gt("Approval duration")} />
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
                      {m(choice.label)}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </span>
          );
        }
        const content = (
          <>
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span
              className={
                presentation === "inline" ? "whitespace-normal" : "min-w-0 max-w-40 wrap-anywhere"
              }
            >
              {m(option.label)}
            </span>
          </>
        );
        const button =
          presentation === "inline" ? (
            <InlineButton
              key={option.decision}
              tone={option.decision === "accept" ? "default" : "muted"}
              disabled={responseDisabled}
              aria-description={option.warning}
              onClick={() => {
                if (!responseDisabled) void onRespondToApproval(requestId, option.decision);
              }}
            >
              {content}
            </InlineButton>
          ) : (
            <Button
              key={option.decision}
              size="sm-multiline"
              className="max-w-full"
              variant={option.decision === "accept" ? "default" : "outline"}
              disabled={responseDisabled}
              aria-description={option.warning}
              onClick={() => {
                if (!responseDisabled) void onRespondToApproval(requestId, option.decision);
              }}
            >
              {content}
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
          <T>Reject with reason</T>
        </Button>
      ) : null}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={responseDisabled}
            render={
              presentation === "inline" ? (
                <InlineButton tone="muted" aria-label={gt("More approval options")} />
              ) : (
                <Button size="icon-xs" variant="outline" aria-label={gt("More approval options")} />
              )
            }
          >
            {presentation === "inline" ? (
              gt("More", { $context: "button that opens more approval options" })
            ) : (
              <EllipsisIcon />
            )}
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
                  <span className="min-w-0 whitespace-normal wrap-break-word">
                    {m(option.label)}
                  </span>
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
