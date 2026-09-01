import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { HostMarkdown } from "../sourceControl/HostMarkdown";
import { remarkRepositoryAutolinks } from "../sourceControl/hostMarkdown.logic";

export const PullRequestMarkdownContext = createContext<string | null>(null);

export function PullRequestMarkdown({
  text,
  cwd,
  environmentId,
  className,
}: {
  text: string;
  cwd: string;
  environmentId?: EnvironmentId | undefined;
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
      extraRemarkPlugins={extraRemarkPlugins}
      {...(className === undefined ? {} : { className })}
    />
  );
}
