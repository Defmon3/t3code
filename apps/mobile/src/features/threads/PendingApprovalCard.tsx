import { Button } from "../../components/ui/Button";
import type { ProviderApprovalOption, RuntimeRequestId, ScopedThreadRef } from "@t3tools/contracts";
import {
  hookApprovalBypassSteps,
  hookApprovalDurations,
} from "@t3tools/client-runtime/state/hook-approvals";
import { Menu } from "../../components/ui/Menu";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  sendApprovalFeedback,
  type ApprovalResponder,
} from "@t3tools/client-runtime/state/thread-requests";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  approvalExplanationTarget,
  approvalExplanationView,
  approvalJudgementLabels,
} from "@t3tools/client-runtime/state/approval-explanations";
import { approvalExplanationAtom } from "../../state/approvalExplanations";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { PendingApproval } from "../../lib/threadActivity";
import { cn } from "../../lib/cn";

export interface PendingApprovalCardProps {
  readonly disabled?: boolean;
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly threadRef: ScopedThreadRef;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: ApprovalResponder;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const rememberedDuration = AsyncResult.isSuccess(preferences)
    ? (preferences.value.rememberedHookApprovalDuration ??
      DEFAULT_CLIENT_SETTINGS.rememberedHookApprovalDuration)
    : DEFAULT_CLIENT_SETTINGS.rememberedHookApprovalDuration;
  const bypass = props.approval.bypass;
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled =
    props.disabled || !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [commandExpanded, setCommandExpanded] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [feedbackFailed, setFeedbackFailed] = useState(false);
  const isCommand = props.approval.requestKind === "command";
  const responseDisabled = disabled || !props.canOperateThread;
  const canRejectWithReason =
    props.approval.supportsFeedback && options.some((option) => option.decision === "decline");

  async function rejectWithReason() {
    if (responseDisabled || reason === null) return;
    if (await sendApprovalFeedback(props.approval, reason, props.onRespond)) {
      setReason(null);
      setFeedbackFailed(false);
    } else {
      setFeedbackFailed(true);
    }
  }
  return (
    <View
      className={cn(
        "gap-2.5 rounded-[20px] border p-4",
        bypass ? "border-danger-border bg-danger" : "border-border bg-card-alt",
      )}
    >
      {bypass ? (
        <View className="flex-row items-center gap-2">
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-danger-foreground"
          />
          <Text className="min-w-0 flex-1 font-t3-bold text-sm text-danger-foreground">
            BYPASS ATTEMPT
          </Text>
        </View>
      ) : (
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          Approval needed
        </Text>
      )}
      <Text className="font-t3-bold text-lg text-foreground">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
      {bypass ? (
        <View className="gap-1">
          <Text selectable className="font-t3-bold text-sm text-danger-foreground">
            Rule: {bypass.rule}
          </Text>
          <Text selectable className="text-sm text-foreground">
            Technique: {bypass.technique} · Tier {bypass.tier}
          </Text>
          <Text selectable className="text-sm leading-normal text-foreground">
            {bypass.reasoning}
          </Text>
        </View>
      ) : null}
      {isCommand ? (
        <ScrollView
          className={
            commandExpanded
              ? "max-h-96 rounded-lg border border-border bg-card"
              : "max-h-24 rounded-lg border border-border bg-card"
          }
          nestedScrollEnabled
          accessibilityLabel="Command"
          showsVerticalScrollIndicator
        >
          {bypass ? (
            <View className="gap-1 p-3">
              {hookApprovalBypassSteps(bypass).map((step, index) => (
                <Text
                  key={step.key}
                  selectable
                  className={cn(
                    "font-mono text-base leading-normal",
                    step.triggered
                      ? "bg-danger font-t3-bold text-danger-foreground"
                      : "text-foreground",
                  )}
                >
                  Step {index + 1}
                  {step.triggered ? " · TRIGGERED" : ""}: {step.command}
                </Text>
              ))}
            </View>
          ) : (
            <Text selectable className="p-3 font-mono text-base leading-normal text-foreground">
              {props.approval.command ?? props.approval.detail ?? "Command details unavailable"}
            </Text>
          )}
        </ScrollView>
      ) : props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.approval.detail}
        </Text>
      ) : null}
      {bypass ? (
        <View className="gap-1">
          <Text selectable className="text-xs text-foreground">
            Runtime: {bypass.runtime} · Model: {bypass.model}
          </Text>
          {commandExpanded ? (
            <>
              <Text selectable className="text-xs text-foreground">
                Session: {bypass.sessionId}
              </Text>
              <Text selectable className="text-xs text-foreground">
                Thread: {bypass.threadTitle}
              </Text>
              <Text selectable className="text-xs text-foreground">
                Thread ID: {bypass.threadId}
              </Text>
            </>
          ) : (
            <Text className="text-xs text-foreground-secondary">
              Expand to see session and thread details.
            </Text>
          )}
        </View>
      ) : null}
      {isCommand && props.approval.cwd ? (
        <View className="gap-1">
          <Text className="font-t3-bold text-sm text-foreground">Working directory</Text>
          <Text selectable className="font-mono text-sm text-foreground">
            {props.approval.cwd}
          </Text>
        </View>
      ) : null}
      {props.approval.reason && props.approval.reason !== bypass?.rule ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">
          {props.approval.reason}
        </Text>
      ) : null}
      {props.approval.sessionApprovalScope ? (
        <Text className="font-sans text-xs leading-normal text-foreground-secondary">
          {props.approval.sessionApprovalScope}
        </Text>
      ) : null}
      {props.approval.fullAccessOverride ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: explanationOpen }}
          onPress={() => setExplanationOpen((open) => !open)}
        >
          <Text className="font-t3-bold text-xs text-foreground-secondary underline">
            {FULL_ACCESS_OVERRIDE_QUESTION}
          </Text>
          {explanationOpen ? (
            <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
              {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      {isCommand ? (
        <CommandApprovalExplanation approval={props.approval} threadRef={props.threadRef} />
      ) : null}
      {canRejectWithReason && reason !== null ? (
        <View className="gap-2">
          <Text className="font-t3-bold text-sm text-foreground">Reason for rejection</Text>
          <AppTextInput
            autoFocus
            multiline
            accessibilityLabel="Reason for rejection"
            placeholder="Tell the agent what to change"
            textAlignVertical="top"
            value={reason}
            editable={!responseDisabled}
            onChangeText={(text) => {
              setReason(text);
              setFeedbackFailed(false);
            }}
          />
          {feedbackFailed ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              Rejection failed. Your reason is kept. Try again.
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2.5">
            <Button
              label="Cancel"
              tone="secondary"
              disabled={props.respondingApprovalId === props.approval.requestId}
              onPress={() => {
                setReason(null);
                setFeedbackFailed(false);
              }}
            />
            <Button
              label="Reject and send reason"
              tone="danger"
              loading={props.respondingApprovalId === props.approval.requestId}
              disabled={responseDisabled || !reason.trim()}
              onPress={() => void rejectWithReason()}
            />
          </View>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {isCommand ? (
          <Button
            label={commandExpanded ? "Collapse" : "Expand"}
            tone="secondary"
            expanded={commandExpanded}
            onPress={() => setCommandExpanded((expanded) => !expanded)}
          />
        ) : null}
        {options.map((option) =>
          props.approval.supportsTimedApproval && option.decision === "acceptForSession" ? (
            <View key={option.decision} className="flex-row flex-wrap items-center gap-2.5">
              <Button
                label={hookApprovalDurations[rememberedDuration].approvalLabel}
                tone="secondary"
                disabled={responseDisabled || !preferencesReady}
                onPress={() => {
                  if (!responseDisabled && preferencesReady)
                    void props.onRespond(
                      props.approval.requestId,
                      "acceptForSession",
                      undefined,
                      rememberedDuration,
                    );
                }}
              />
              <Menu
                title="Approval duration"
                actions={Object.values(hookApprovalDurations).map((choice) => ({
                  id: choice.duration,
                  title: choice.label,
                  attributes: { disabled: responseDisabled || !preferencesReady },
                }))}
                onPressAction={({ nativeEvent }) => {
                  const choice = Object.values(hookApprovalDurations).find(
                    (value) => value.duration === nativeEvent.event,
                  );
                  if (!responseDisabled && preferencesReady && choice) {
                    savePreferences({ rememberedHookApprovalDuration: choice.duration });
                    void props.onRespond(
                      props.approval.requestId,
                      "acceptForSession",
                      undefined,
                      choice.duration,
                    );
                  }
                }}
              >
                <Button
                  label="▾"
                  accessibilityLabel="Approval duration"
                  disabled={responseDisabled || !preferencesReady}
                  onPress={() => {}}
                />
              </Menu>
            </View>
          ) : (
            <Button
              key={option.decision}
              label={option.label}
              tone={
                option.decision === "accept"
                  ? "primary"
                  : option.decision === "decline"
                    ? "danger"
                    : "secondary"
              }
              disabled={responseDisabled}
              onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
            />
          ),
        )}
        {canRejectWithReason ? (
          <Button
            label="Reject with reason"
            tone="secondary"
            expanded={reason !== null}
            disabled={responseDisabled}
            onPress={() => {
              setReason((value) => (value === null ? "" : null));
              setFeedbackFailed(false);
            }}
          />
        ) : null}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </View>
  );
}

function CommandApprovalExplanation({
  approval,
  threadRef,
}: {
  readonly approval: PendingApproval;
  readonly threadRef: ScopedThreadRef;
}) {
  const explanationAtom = approvalExplanationAtom(approvalExplanationTarget(threadRef, approval));
  const result = useAtomValue(explanationAtom);
  const refreshExplanation = useAtomRefresh(explanationAtom);
  const explanation = approvalExplanationView(result);
  return (
    <View className="gap-2 border-t border-border pt-3" accessibilityLiveRegion="polite">
      <Text className="font-t3-bold text-sm text-foreground">AI explanation</Text>
      {explanation.status === "ready" ? (
        <>
          <Text
            className={cn(
              "font-t3-bold text-sm leading-normal",
              explanation.judgement.verdict === "safe"
                ? "text-foreground"
                : explanation.judgement.verdict === "unsafe"
                  ? "text-danger-foreground"
                  : "text-warning-foreground",
            )}
          >
            AI judgement: {approvalJudgementLabels[explanation.judgement.verdict]}
          </Text>
          <Text className="font-sans text-sm leading-normal text-foreground">
            {explanation.judgement.reason}
          </Text>
          <View className="gap-1" role="list">
            {explanation.operations.map((operation) => (
              <View
                key={JSON.stringify(operation)}
                className="flex-row items-start gap-2"
                role="listitem"
                accessible
              >
                <Text className="text-sm leading-normal text-foreground-secondary" aria-hidden>
                  •
                </Text>
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text selectable className="text-sm leading-normal text-foreground">
                    <Text className="font-t3-bold">{operation.action}: </Text>
                    <Text className="font-mono">{operation.detail}</Text>
                  </Text>
                  {operation.note ? (
                    <Text className="text-sm leading-normal text-foreground-secondary">
                      {operation.note}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        </>
      ) : (
        <Text className="font-sans text-sm leading-normal text-foreground">
          {explanation.message}
        </Text>
      )}
      {explanation.status === "error" ? (
        <Button
          label="Retry explanation"
          tone="secondary"
          disabled={result.waiting}
          loading={result.waiting}
          onPress={refreshExplanation}
        />
      ) : null}
    </View>
  );
}
