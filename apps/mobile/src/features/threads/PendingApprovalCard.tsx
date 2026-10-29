import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  approvalExplanationTarget,
  approvalExplanationView,
  approvalJudgementLabels,
} from "@t3tools/client-runtime/state/approval-explanations";
import { approvalExplanationAtom } from "../../state/approvalExplanations";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";
import { cn } from "../../lib/cn";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly threadRef: ScopedThreadRef;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [commandExpanded, setCommandExpanded] = useState(false);
  const isCommand = props.approval.requestKind === "command";
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Approval needed
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
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
          <Text selectable className="p-3 font-mono text-base leading-normal text-foreground">
            {props.approval.command ?? props.approval.detail ?? "Command details unavailable"}
          </Text>
        </ScrollView>
      ) : props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.approval.detail}
        </Text>
      ) : null}
      {isCommand && props.approval.cwd ? (
        <View className="gap-1">
          <Text className="font-t3-bold text-sm text-foreground">Working directory</Text>
          <Text selectable className="font-mono text-sm text-foreground">
            {props.approval.cwd}
          </Text>
        </View>
      ) : null}
      {props.approval.reason ? (
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
      <View className="flex-row flex-wrap gap-2.5">
        {isCommand ? (
          <Button
            label={commandExpanded ? "Collapse" : "Expand"}
            tone="secondary"
            expanded={commandExpanded}
            onPress={() => setCommandExpanded((expanded) => !expanded)}
          />
        ) : null}
        {options.map((option) => (
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
            disabled={disabled || !props.canOperateThread}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          />
        ))}
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
  const result = useAtomValue(
    approvalExplanationAtom(approvalExplanationTarget(threadRef, approval)),
  );
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
    </View>
  );
}
