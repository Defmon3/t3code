import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { mayContainStandaloneIssueLink } from "@t3tools/client-runtime/issue-links";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  pullRequestLinkProject,
  resolveLinkPullRequestInput,
} from "@t3tools/client-runtime/pull-request-link-input";
import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, T, useGT } from "gt-react";
import { useRef, useState } from "react";
import { m } from "~/i18n/messages";

import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useIssueLinking } from "~/hooks/useIssueLinking";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Atom } from "effect/reactivity";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

// Host in chat to survive command palette dismissal.
const linkPullRequestDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pull-requests:link-dialog-thread"),
);

export function openLinkPullRequestDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkPullRequestDialogThreadAtom, threadRef);
}

interface LinkPullRequestDialogProps {
  open: boolean;
  threadRef: ScopedThreadRef;
  projectId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function LinkPullRequestDialogHost() {
  const threadRef = useAtomValue(linkPullRequestDialogThreadAtom);
  const thread = useThreadShell(threadRef);
  const linking = usePullRequestLinking(threadRef?.environmentId);
  const configs = useServerConfigs();
  if (threadRef === null) return null;
  const supportsIssueLinks =
    configs.get(threadRef.environmentId)?.environment.capabilities.issueLinkedThreads === true;
  if (linking.mode === "unsupported" && !supportsIssueLinks) return null;
  return (
    <LinkPullRequestDialog
      open
      threadRef={threadRef}
      projectId={thread?.projectId ?? null}
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(linkPullRequestDialogThreadAtom, null);
      }}
    />
  );
}

function LinkPullRequestDialog({
  open,
  threadRef,
  projectId,
  onOpenChange,
}: LinkPullRequestDialogProps) {
  const gt = useGT();
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [reference, setReference] = useState("");
  const [dirty, setDirty] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const projects = useProjects();
  const ownProject = pullRequestLinkProject(
    projects.find(
      (project) => project.environmentId === threadRef.environmentId && project.id === projectId,
    )?.repositoryIdentity,
  );
  const linking = usePullRequestLinking(threadRef.environmentId);
  const issueLinking = useIssueLinking(
    threadRef.environmentId,
    mayContainStandaloneIssueLink(reference),
  );
  const [pending, setPending] = useState(false);

  const [openSeen, setOpenSeen] = useState(open);
  if (openSeen !== open) {
    setOpenSeen(open);
    if (open) {
      setReference("");
      setDirty(false);
      setSubmitError(null);
    }
  }

  const resolved = resolveLinkPullRequestInput({
    reference,
    project: ownProject,
    hasProject: (reference) => linking.canLink(reference.url),
  });
  const issueUrl = reference.trim();
  const canLinkIssue = issueLinking.canLink(threadRef, issueUrl);

  const submit = async () => {
    if (submittingRef.current) return;
    setDirty(true);
    const submitLink = canLinkIssue
      ? () => issueLinking.changeLink(threadRef, issueUrl, true)
      : resolved !== null && "link" in resolved
        ? () => linking.changeLink(threadRef, resolved.link.url, true)
        : null;
    if (submitLink === null) return;
    submittingRef.current = true;
    setSubmitError(null);
    setPending(true);
    const result = await settlePromise(submitLink);
    submittingRef.current = false;
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setSubmitError(thrownErrorMessage(error, m) ?? m(msg("Could not link the pull request.")));
      return;
    }
    onOpenChange(false);
  };

  const validation =
    !dirty || canLinkIssue
      ? null
      : reference.trim().length === 0
        ? gt("Paste a pull request URL or enter 123 / #123.")
        : resolved === null
          ? gt("Use a pull request URL, 123, or #123.")
          : "error" in resolved
            ? resolved.error
            : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-xl" initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>
            <T>Link issue or pull request</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Attach an issue or pull request by its URL. For a pull request in this thread's
              repository, you can also enter its number.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder={gt("Issue or pull request URL")}
            value={reference}
            readOnly={pending}
            onChange={(event) => {
              setDirty(true);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.repeat ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              ) {
                return;
              }
              event.preventDefault();
              void submit();
            }}
          />
          {resolved !== null && "link" in resolved ? (
            <p className="truncate text-muted-foreground text-xs">
              {resolved.link.host}/{resolved.link.repository} #{resolved.link.number}
            </p>
          ) : null}
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            <T>Cancel</T>
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || (!canLinkIssue && (resolved === null || "error" in resolved))}
          >
            {pending ? gt("Linking...") : gt("Link", { $context: "verb, button" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
