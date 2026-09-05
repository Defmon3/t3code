import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { HostMarkdown } from "../sourceControl/HostMarkdown";
import { remarkRepositoryAutolinks } from "../sourceControl/hostMarkdown.logic";

export const PullRequestMarkdownContext = createContext<string | null>(null);

/**
 * A pull request body, rendered with the app's markdown renderer plus a card for each upload
 * embedded in it, which that renderer drops on the floor.
 *
 * The card links out instead of playing in place, so an original upload can be opened or
 * downloaded even when its codec cannot play in the client.
 */
export function PullRequestMarkdown({
  text,
  cwd,
  environmentId,
  threadRef,
  className,
}: {
  text: string;
  cwd: string;
  environmentId: EnvironmentId;
  /** Thread the body is shown beside, so its links can open in that thread's in-app browser. */
  threadRef?: ScopedThreadRef | null;
  className?: string;
}) {
  const repositoryUrl = useContext(PullRequestMarkdownContext);
  const extraRemarkPlugins = useMemo<NonNullable<ReactMarkdownOptions["remarkPlugins"]>>(
    () => (repositoryUrl ? [[remarkRepositoryAutolinks, { repositoryUrl }]] : []),
    [repositoryUrl],
  );
  return (
    <HostMarkdown
      text={text}
      cwd={cwd}
      environmentId={environmentId}
      {...(threadRef === undefined ? {} : { threadRef })}
      extraRemarkPlugins={extraRemarkPlugins}
      {...(className === undefined ? {} : { className })}
    />
  );
}
