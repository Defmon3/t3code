/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Browser surfaces point at preview tab ids,
 * terminal surfaces point at terminal session ids, file surfaces point at
 * workspace paths, and diff/files remain singleton surfaces.
 */
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChatFileAttachment as ChatFileAttachmentSchema } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useClosedViewStore } from "./closedViewStore";
import { resolveStorage } from "./lib/storage";
import type { ThreadPanelPresentation } from "./rightPanelLayout";
import type { ChatFileAttachment } from "./types";

const RIGHT_PANEL_KINDS = [
  "diff",
  "repository",
  "processes",
  "files",
  "file",
  "preview",
  "device",
  "terminal",
  "pull-request",
  "issue",
] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export type RepositoryView = "history" | "issues" | "pull-requests";
export type RepositoryItemSelection = {
  projectId: string;
  provider?: string;
  repository: string;
  number: number;
};
export type IssueSelection = RepositoryItemSelection;

export interface DeviceTabTarget {
  hostId: string;
  deviceId: string;
  platform: "ios" | "android";
  name: string;
}

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | { id: "device" | `device:${string}`; kind: "device"; target?: DeviceTabTarget; title?: string }
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      terminalIds: string[];
      activeTerminalId: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { id: "diff"; kind: "diff" }
  | {
      id: "repository";
      kind: "repository";
      view: RepositoryView;
      selectedIssue?: IssueSelection | null;
    }
  | { id: "processes"; kind: "processes" }
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}` | `attachment:${string}`;
      kind: "file";
      /** Workspace-relative, or absolute for a host file outside the workspace. */
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
      /** Present when the file lives in the thread's attachment store rather
          than at a workspace or host path. */
      attachment?: ChatFileAttachment;
    }
  | {
      /**
       * A change request opened beside a thread or in the pull-request list's shared panel.
       * The reference lives in the id so several pull requests can remain open as peer tabs.
       */
      id: `pull-request:${string}`;
      kind: "pull-request";
      /**
       * Which server the change request was read from. The list spans every connected one, so
       * two of them can hold the same project id; a panel beside a thread leaves this out and
       * takes the environment from its own ref.
       */
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
    }
  | {
      /**
       * An issue opened beside a thread or in the issues list's shared panel. The reference
       * lives in the id so several issues can remain open as peer tabs.
       */
      id: `issue:${string}`;
      kind: "issue";
      /** The server that owns the issue when it came from a multi-server list. */
      environmentId?: string;
      projectId: string;
      provider?: string;
      repository: string;
      number: number;
    };

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
// v9 removed the "plan" surface kind (plans render inline in the transcript).
// v10 keys pull-request surfaces by reference instead of a singleton tab.
// v11 stops persisting the pull-request list's shared panel, so a restart opens the page fresh.
// v12 adds the device surface.
// v14 removes the agents surface; lineage lives in the thread title bar.
const RIGHT_PANEL_STORAGE_VERSION = 16;

const PersistedRightPanelState = Schema.Struct({
  byThreadKey: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  threadPanelVisibilityByThreadKey: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Unknown),
  ),
});
type PersistedRightPanelState = typeof PersistedRightPanelState.Type;
const PersistedThreadRightPanelState = Schema.Struct({
  isOpen: Schema.optionalKey(Schema.Boolean),
  activeSurfaceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  surfaces: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  dismissedDeviceSurfaceIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
type PersistedThreadRightPanelState = typeof PersistedThreadRightPanelState.Type;
const SurfaceId = <const Prefix extends string>(prefix: Prefix) =>
  Schema.TemplateLiteral([prefix, Schema.String]);
const DeviceTabTarget = Schema.Struct({
  hostId: Schema.String,
  deviceId: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  name: Schema.String,
});
const PersistedIssueSelection = Schema.Struct({
  projectId: Schema.String,
  provider: Schema.optionalKey(Schema.String),
  repository: Schema.String,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
});
const PersistedRightPanelSurface = Schema.Union([
  Schema.Struct({ id: Schema.Literal("diff"), kind: Schema.Literal("diff") }),
  Schema.Struct({ id: Schema.Literal("files"), kind: Schema.Literal("files") }),
  Schema.Struct({ id: Schema.Literal("processes"), kind: Schema.Literal("processes") }),
  Schema.Struct({
    id: Schema.Literal("repository"),
    kind: Schema.Literal("repository"),
    view: Schema.Literals(["history", "issues", "pull-requests"]),
    selectedIssue: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    id: Schema.Literal("browser:new"),
    kind: Schema.Literal("preview"),
    resourceId: Schema.Null,
  }),
  Schema.Struct({
    id: SurfaceId("browser:"),
    kind: Schema.Literal("preview"),
    resourceId: Schema.String,
  }),
  Schema.Struct({
    id: Schema.Union([Schema.Literal("device"), SurfaceId("device:")]),
    kind: Schema.Literal("device"),
    target: Schema.optionalKey(DeviceTabTarget),
    title: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    id: SurfaceId("file:"),
    kind: Schema.Literal("file"),
    relativePath: Schema.String,
    revealLine: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    revealRequestId: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    id: SurfaceId("attachment:"),
    kind: Schema.Literal("file"),
    relativePath: Schema.String,
    revealLine: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    revealRequestId: Schema.optionalKey(Schema.Finite),
    attachment: ChatFileAttachmentSchema,
  }),
  Schema.Struct({
    id: SurfaceId("terminal:"),
    kind: Schema.Literal("terminal"),
    resourceId: Schema.String,
    terminalIds: Schema.optionalKey(Schema.Array(Schema.String)),
    activeTerminalId: Schema.optionalKey(Schema.String),
    splitDirection: Schema.optionalKey(Schema.Literals(["horizontal", "vertical"])),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("pull-request"),
    projectId: Schema.String,
    repository: Schema.String,
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    environmentId: Schema.optionalKey(Schema.String),
    host: Schema.optionalKey(Schema.String),
    url: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("issue"),
    projectId: Schema.String,
    repository: Schema.String,
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    environmentId: Schema.optionalKey(Schema.String),
    provider: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    id: Schema.Literal("issues"),
    kind: Schema.Literal("issues"),
    selected: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({ id: Schema.Literal("pull-requests"), kind: Schema.Literal("pull-requests") }),
  Schema.Struct({ id: Schema.Literal("git-history"), kind: Schema.Literal("git-history") }),
  Schema.Struct({ id: Schema.Literal("plan"), kind: Schema.Literal("plan") }),
]);
type PersistedRightPanelSurface = typeof PersistedRightPanelSurface.Type;

const decodePersistedRightPanelState = Schema.decodeUnknownOption(PersistedRightPanelState);
const decodePersistedThreadRightPanelState = Schema.decodeUnknownOption(
  PersistedThreadRightPanelState,
);
const decodePersistedRightPanelSurface = Schema.decodeUnknownOption(PersistedRightPanelSurface);
const decodePersistedIssueSelection = Schema.decodeUnknownOption(PersistedIssueSelection);

/** A fixed workspace-level ref: each PR surface carries its own real environment. */
export const PULL_REQUESTS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("pull-requests-panel"),
  ThreadId.make("pull-requests-panel"),
);

/**
 * The pull-request list's shared panel is session
 * state: reopening the app should show the list, not last session's tabs and detail fetches.
 */
const isPullRequestsPanelKey = (threadKey: string) => threadKey.endsWith(":pull-requests-panel");

/** Same reasoning as `isPullRequestsPanelKey`, for the issues list's shared panel. */
const isIssuesPanelKey = (threadKey: string) => threadKey.endsWith(":issues-panel");

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
  dismissedDeviceSurfaceIds?: string[];
}

export interface ThreadPanelVisibility {
  inlineOpen: boolean;
  popoverOpen: boolean;
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  threadPanelVisibilityByThreadKey: Record<string, ThreadPanelVisibility>;
  /** Session-only count of user panel choices per thread. Automatic updates do not advance it. */
  userActionRevisionByThreadKey: Record<string, number>;
  closeRevisionByThreadKey: Record<string, number>;
  getUserActionRevision: (ref: ScopedThreadRef) => number;
  /**
   * Open a surface on behalf of the app, not the user. Refused when the user
   * made a panel choice after `expectedUserActionRevision` was read.
   */
  openProactive: (
    ref: ScopedThreadRef,
    surface: Extract<RightPanelSurface, { kind: "diff" | "pull-request" | "repository" }>,
    expectedUserActionRevision: number,
  ) => boolean;
  open: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request" | "issue">,
  ) => void;
  openDevice: (ref: ScopedThreadRef, target: DeviceTabTarget, automatic?: boolean) => void;
  renameDevice: (ref: ScopedThreadRef, surfaceId: string, title: string) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  openAttachment: (ref: ScopedThreadRef, attachment: ChatFileAttachment) => void;
  openPullRequest: (
    ref: ScopedThreadRef,
    target: {
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
    },
  ) => void;
  openIssue: (
    ref: ScopedThreadRef,
    target: {
      environmentId?: string;
      projectId: string;
      provider?: string;
      repository: string;
      number: number;
    },
  ) => void;
  openRepository: (ref: ScopedThreadRef, view: RepositoryView) => void;
  selectRepositoryView: (ref: ScopedThreadRef, view: RepositoryView) => void;
  /** What the issue browser is showing: an issue, or null for the list it was picked from. */
  selectRepositoryIssue: (ref: ScopedThreadRef, target: IssueSelection | null) => void;
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  reconcileBrowserSurfaces: (
    ref: ScopedThreadRef,
    tabIds: readonly string[],
    hiddenTabIds?: ReadonlySet<string>,
  ) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request" | "issue" | "repository">,
  ) => void;
  setThreadPanelOpen: (
    ref: ScopedThreadRef,
    presentation: ThreadPanelPresentation,
    open: boolean,
  ) => void;
  toggleThreadPanel: (ref: ScopedThreadRef, presentation: ThreadPanelPresentation) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const DEFAULT_THREAD_PANEL_VISIBILITY: ThreadPanelVisibility = {
  inlineOpen: true,
  popoverOpen: false,
};

const singletonSurface = (
  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal" | "pull-request" | "issue">,
): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "repository":
      return { id: "repository", kind, view: "history" };
    case "processes":
      return { id: "processes", kind };
    case "files":
      return { id: "files", kind };

    case "device":
      return { id: "device", kind };
  }
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
});

const attachmentSurface = (attachment: ChatFileAttachment): RightPanelSurface => ({
  id: `attachment:${attachment.id}`,
  kind: "file",
  relativePath: attachment.name,
  revealLine: null,
  revealRequestId: 0,
  attachment,
});

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

export type PullRequestSurface = Extract<RightPanelSurface, { kind: "pull-request" }>;

export function pullRequestSurfaceId(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
}): PullRequestSurface["id"] {
  // The environment leads the id where there is one, so the same change request read from two
  // servers is two tabs rather than one tab that changes its mind about which server it is on.
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  const host = target.host === undefined ? "" : `${encodeURIComponent(target.host.toLowerCase())}:`;
  return `pull-request:${scope}${encodeURIComponent(target.projectId)}:${host}${encodeURIComponent(target.repository)}:${target.number}`;
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
  url?: string;
}): PullRequestSurface {
  return {
    id: pullRequestSurfaceId(target),
    kind: "pull-request",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    projectId: target.projectId,
    ...(typeof target.host === "string" ? { host: target.host.toLowerCase() } : {}),
    repository: target.repository,
    number: target.number,
    ...(typeof target.url === "string" ? { url: target.url } : {}),
  };
}

export type IssueSurface = Extract<RightPanelSurface, { kind: "issue" }>;

export function issueSurfaceId(target: {
  environmentId?: string;
  projectId: string;
  provider?: string;
  repository: string;
  number: number;
}): IssueSurface["id"] {
  return `issue:${encodeURIComponent(
    JSON.stringify([
      target.environmentId ?? null,
      target.provider ?? null,
      target.projectId,
      target.repository,
      target.number,
    ]),
  )}`;
}

function issueSurface(target: {
  environmentId?: string;
  projectId: string;
  provider?: string;
  repository: string;
  number: number;
}): IssueSurface {
  return {
    id: issueSurfaceId(target),
    kind: "issue",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    ...(target.provider === undefined ? {} : { provider: target.provider }),
    projectId: target.projectId,
    repository: target.repository,
    number: target.number,
  };
}

function normalizeIssueSelection(value: unknown): IssueSelection | null {
  return Option.getOrElse(decodePersistedIssueSelection(value), () => null);
}

export function updateIssueTabStatus<Status extends { state: unknown; stateReason: unknown }>(
  statuses: Readonly<Record<string, Status>>,
  surfaceId: string,
  status: Status,
): Readonly<Record<string, Status>> {
  return statuses[surfaceId]?.state === status.state &&
    statuses[surfaceId]?.stateReason === status.stateReason
    ? statuses
    : { ...statuses, [surfaceId]: status };
}

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  ...current,
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const updateThreadStateMap = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (
    !next.isOpen &&
    next.activeSurfaceId === null &&
    next.surfaces.length === 0 &&
    !next.dismissedDeviceSurfaceIds?.length
  ) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

const updateThreadPanelVisibilityMap = (
  byThreadKey: Record<string, ThreadPanelVisibility>,
  threadKey: string,
  updater: (current: ThreadPanelVisibility) => ThreadPanelVisibility,
): Record<string, ThreadPanelVisibility> => {
  const current = byThreadKey[threadKey] ?? DEFAULT_THREAD_PANEL_VISIBILITY;
  const next = updater(current);
  if (next.inlineOpen && !next.popoverOpen) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

type RightPanelStoreData = Pick<
  RightPanelStoreState,
  "byThreadKey" | "threadPanelVisibilityByThreadKey"
>;

/**
 * Applies a real right-panel mutation and its thread-panel transition atomically.
 * This is the only path real panel actions use, so visibility never has to be
 * reconciled after the fact in React.
 */
const updateThread = (
  state: RightPanelStoreData,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): RightPanelStoreData => {
  const current = state.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const byThreadKey = updateThreadStateMap(state.byThreadKey, threadKey, updater);
  const next = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  let threadPanelVisibilityByThreadKey = state.threadPanelVisibilityByThreadKey;

  if (!current.isOpen && next.isOpen) {
    threadPanelVisibilityByThreadKey = updateThreadPanelVisibilityMap(
      threadPanelVisibilityByThreadKey,
      threadKey,
      (visibility) => (visibility.popoverOpen ? { ...visibility, popoverOpen: false } : visibility),
    );
  } else if (current.isOpen && !next.isOpen) {
    threadPanelVisibilityByThreadKey = updateThreadPanelVisibilityMap(
      threadPanelVisibilityByThreadKey,
      threadKey,
      (visibility) =>
        visibility.popoverOpen && !visibility.inlineOpen
          ? { ...visibility, inlineOpen: true }
          : visibility,
    );
  }

  return { byThreadKey, threadPanelVisibilityByThreadKey };
};

// Every store action is a user choice unless it goes through `automaticUpdate`.
// Only `openProactive` and resource reconciliation are automatic, so a new
// action counts as a user choice by default.
const automaticUpdate = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  ...updateThread(state, threadKey, updater),
});

const userAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
  closesView = false,
): Partial<RightPanelStoreState> => ({
  ...updateThread(state, threadKey, (current) => {
    const next = updater(current);
    if (next === current) return current;
    const removedDevices = current.surfaces.filter(
      (surface) =>
        surface.kind === "device" && !next.surfaces.some((entry) => entry.id === surface.id),
    );
    if (removedDevices.length === 0) return next;
    return {
      ...next,
      dismissedDeviceSurfaceIds: [
        ...new Set([
          ...(next.dismissedDeviceSurfaceIds ?? []),
          ...removedDevices.map((surface) => surface.id),
        ]),
      ],
    };
  }),
  userActionRevisionByThreadKey: {
    ...state.userActionRevisionByThreadKey,
    [threadKey]: (state.userActionRevisionByThreadKey[threadKey] ?? 0) + 1,
  },
  ...(closesView
    ? {
        closeRevisionByThreadKey: {
          ...state.closeRevisionByThreadKey,
          [threadKey]: (state.closeRevisionByThreadKey[threadKey] ?? 0) + 1,
        },
      }
    : {}),
});

const closeAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => userAction(state, threadKey, updater, true);

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
  threadPanelVisibilityByThreadKey: Record<string, ThreadPanelVisibility>;
} {
  const state = Option.getOrElse(
    decodePersistedRightPanelState(persistedState),
    (): PersistedRightPanelState => ({}),
  );
  const byThreadKey = state.byThreadKey
    ? Object.fromEntries(
        Object.entries(state.byThreadKey)
          .filter(
            ([threadKey]) => !isPullRequestsPanelKey(threadKey) && !isIssuesPanelKey(threadKey),
          )
          .map(([threadKey, rawThreadState]) => {
            const threadState = Option.getOrElse(
              decodePersistedThreadRightPanelState(rawThreadState),
              (): PersistedThreadRightPanelState => ({}),
            );
            const rawActiveSurfaceId = threadState.activeSurfaceId;
            const persistedSurfaces = (threadState.surfaces ?? []).flatMap((rawSurface) =>
              Option.toArray(decodePersistedRightPanelSurface(rawSurface)),
            );
            const persistedRepository = persistedSurfaces.find(
              (surface) => surface.kind === "repository",
            );
            const persistedIssues = persistedSurfaces.find((surface) => surface.kind === "issues");
            const persistedRepositoryView =
              persistedRepository?.kind === "repository" ? persistedRepository.view : "history";
            const repositoryView =
              rawActiveSurfaceId === "issues"
                ? "issues"
                : rawActiveSurfaceId === "pull-requests"
                  ? "pull-requests"
                  : rawActiveSurfaceId === "git-history"
                    ? "history"
                    : persistedRepositoryView;
            const legacySelection = normalizeIssueSelection(
              persistedIssues?.kind === "issues" ? persistedIssues.selected : undefined,
            );
            const repositorySelection = normalizeIssueSelection(
              persistedRepository?.kind === "repository"
                ? persistedRepository.selectedIssue
                : undefined,
            );
            const issueSelectionSource = legacySelection ?? repositorySelection;
            const repositorySurface: RightPanelSurface = {
              id: "repository",
              kind: "repository",
              view: repositoryView,
              selectedIssue: issueSelectionSource,
            };
            let repositoryIncluded = false;
            const surfaces = persistedSurfaces.flatMap<RightPanelSurface>((surface) => {
              // Dropped surface kind: plans now render inline in the
              // transcript (v9).
              if (surface.kind === "plan") return [];
              if (
                surface.kind === "git-history" ||
                surface.kind === "pull-requests" ||
                surface.kind === "repository" ||
                surface.kind === "issues"
              ) {
                if (repositoryIncluded) return [];
                repositoryIncluded = true;
                return [repositorySurface];
              }
              if (surface.kind === "file") {
                const revealLine =
                  surface.revealLine === undefined || surface.revealLine === null
                    ? null
                    : Number.isFinite(surface.revealLine)
                      ? Math.max(1, Math.trunc(surface.revealLine))
                      : null;
                const revealRequestId =
                  surface.revealRequestId !== undefined &&
                  Number.isSafeInteger(surface.revealRequestId) &&
                  surface.revealRequestId >= 0
                    ? surface.revealRequestId
                    : 0;
                return "attachment" in surface
                  ? [
                      {
                        id: surface.id,
                        kind: "file",
                        relativePath: surface.relativePath,
                        revealLine,
                        revealRequestId,
                        attachment: surface.attachment,
                      },
                    ]
                  : [
                      {
                        id: surface.id,
                        kind: "file",
                        relativePath: surface.relativePath,
                        revealLine,
                        revealRequestId,
                      },
                    ];
              }
              if (surface.kind === "pull-request") {
                return [
                  pullRequestSurface({
                    projectId: surface.projectId,
                    repository: surface.repository,
                    number: surface.number,
                    ...(surface.host === undefined ? {} : { host: surface.host }),
                    ...(surface.url === undefined ? {} : { url: surface.url }),
                    ...(surface.environmentId === undefined
                      ? {}
                      : { environmentId: surface.environmentId }),
                  }),
                ];
              }
              if (surface.kind === "issue") {
                return [
                  issueSurface({
                    projectId: surface.projectId,
                    repository: surface.repository,
                    number: surface.number,
                    ...(surface.provider === undefined ? {} : { provider: surface.provider }),
                    ...(surface.environmentId === undefined
                      ? {}
                      : { environmentId: surface.environmentId }),
                  }),
                ];
              }
              if (
                surface.kind === "diff" ||
                surface.kind === "files" ||
                surface.kind === "processes"
              )
                return [surface];
              if (surface.kind === "preview") return [surface];
              if (surface.kind === "device") return [surface];
              if (surface.id !== `terminal:${surface.resourceId}`) return [];
              const terminalIds = surface.terminalIds
                ? [...new Set(surface.terminalIds)]
                : [surface.resourceId];
              const activeTerminalId =
                surface.activeTerminalId !== undefined &&
                terminalIds.includes(surface.activeTerminalId)
                  ? surface.activeTerminalId
                  : (terminalIds[0] ?? surface.resourceId);
              return [
                {
                  id: `terminal:${surface.resourceId}`,
                  kind: "terminal",
                  resourceId: surface.resourceId,
                  terminalIds: terminalIds.length > 0 ? terminalIds : [surface.resourceId],
                  activeTerminalId,
                  ...(surface.splitDirection === undefined
                    ? {}
                    : { splitDirection: surface.splitDirection }),
                },
              ];
            });
            const persistedActiveSurfaceId = surfaces.some(
              (surface) => surface.id === rawActiveSurfaceId,
            )
              ? (rawActiveSurfaceId ?? null)
              : rawActiveSurfaceId === "pull-request"
                ? (surfaces.find((surface) => surface.kind === "pull-request")?.id ?? null)
                : rawActiveSurfaceId === "git-history" ||
                    rawActiveSurfaceId === "pull-requests" ||
                    rawActiveSurfaceId === "issues"
                  ? (surfaces.find((surface) => surface.kind === "repository")?.id ?? null)
                  : null;
            // A migration that dropped every surface (e.g. plan-only panels
            // in v9) must not reopen an empty panel.
            const isOpen =
              surfaces.length > 0 &&
              (threadState.isOpen !== undefined
                ? threadState.isOpen
                : persistedActiveSurfaceId !== null);
            // An open panel needs an active surface: if migration dropped
            // the persisted one (e.g. plan was active), fall back to the
            // first survivor instead of rendering an open empty panel.
            const activeSurfaceId =
              persistedActiveSurfaceId ??
              (isOpen || rawActiveSurfaceId === "agents" ? (surfaces[0]?.id ?? null) : null);
            return [
              threadKey,
              {
                isOpen,
                surfaces,
                activeSurfaceId,
                ...(threadState.dismissedDeviceSurfaceIds
                  ? {
                      dismissedDeviceSurfaceIds: [...threadState.dismissedDeviceSurfaceIds],
                    }
                  : {}),
              },
            ];
          }),
      )
    : {};
  const threadPanelVisibilityByThreadKey = Object.fromEntries(
    Object.entries(state.threadPanelVisibilityByThreadKey ?? {}).flatMap(([key, raw]) => {
      const value = Schema.decodeUnknownOption(Schema.Struct({ inlineOpen: Schema.Boolean }))(raw);
      return Option.isSome(value) && !value.value.inlineOpen
        ? [[key, { inlineOpen: false, popoverOpen: false }]]
        : [];
    }),
  );
  return { byThreadKey, threadPanelVisibilityByThreadKey };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {},
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
      getUserActionRevision: (ref) =>
        get().userActionRevisionByThreadKey[scopedThreadKey(ref)] ?? 0,
      openProactive: (ref, surface, expectedUserActionRevision) => {
        let opened = false;
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            (state.userActionRevisionByThreadKey[threadKey] ?? 0) !== expectedUserActionRevision
          ) {
            return state;
          }
          // A linked PR takes priority over a completed-turn diff. Manual actions
          // always apply, and later user choices reject both proactive requests.
          if (
            surface.kind === "diff" &&
            (selectActiveRightPanel(state.byThreadKey, ref) === "pull-request" ||
              selectActiveRightPanel(state.byThreadKey, ref) === "repository")
          ) {
            return state;
          }
          opened = true;
          return automaticUpdate(state, threadKey, (current) => {
            if (surface.kind !== "repository") return upsertSurface(current, surface);
            const existing = current.surfaces.find(
              (entry): entry is Extract<RightPanelSurface, { kind: "repository" }> =>
                entry.kind === "repository",
            );
            const repositorySurface = {
              ...surface,
              selectedIssue: surface.selectedIssue ?? existing?.selectedIssue ?? null,
            };
            return upsertSurface(
              {
                ...current,
                surfaces: current.surfaces.map((entry) =>
                  entry.id === repositorySurface.id ? repositorySurface : entry,
                ),
              },
              repositorySurface,
            );
          });
        });
        return opened;
      },
      open: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        ),
      openDevice: (ref, target, automatic = false) =>
        set((state) =>
          (automatic ? automaticUpdate : userAction)(state, scopedThreadKey(ref), (current) => {
            const id =
              `device:${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.deviceId)}` as const;
            if (automatic && current.dismissedDeviceSurfaceIds?.includes(id)) return current;
            const surface: RightPanelSurface = { id, kind: "device", target };
            const existing = current.surfaces.find((entry) => entry.id === id);
            const surfaces = existing
              ? current.surfaces.filter((entry) => entry.id !== "device")
              : current.surfaces.map((entry) => (entry.id === "device" ? surface : entry));
            return upsertSurface(
              {
                ...current,
                surfaces,
                dismissedDeviceSurfaceIds: (current.dismissedDeviceSurfaceIds ?? []).filter(
                  (entry) => entry !== id,
                ),
              },
              existing ?? surface,
            );
          }),
        ),
      renameDevice: (ref, surfaceId, title) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "device"
                ? { ...surface, title: title.trim() || surface.target?.name || "Device" }
                : surface,
            ),
          })),
        ),
      openBrowser: (ref, tabId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
          }),
        ),
      openPullRequest: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = pullRequestSurface(target);
            const next = upsertSurface(current, surface);
            return target.url
              ? {
                  ...next,
                  surfaces: next.surfaces.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  ),
                }
              : next;
          }),
        ),
      openIssue: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(current, issueSurface(target)),
          ),
        ),
      openRepository: (ref, view) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const existing = current.surfaces.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "repository" }> =>
                surface.kind === "repository",
            );
            const surface = {
              id: "repository" as const,
              kind: "repository" as const,
              view,
              selectedIssue: existing?.selectedIssue ?? null,
            };
            return upsertSurface(
              {
                ...current,
                surfaces: existing
                  ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
                  : current.surfaces,
              },
              surface,
            );
          }),
        ),
      selectRepositoryView: (ref, view) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.kind === "repository" ? { ...surface, view } : surface,
            ),
          })),
        ),
      selectRepositoryIssue: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.kind === "repository" ? { ...surface, selectedIssue: target } : surface,
            ),
          })),
        ),
      openFile: (ref, requestedPath, line) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            if (requestedPath === ".") {
              return upsertSurface(current, singletonSurface("files"));
            }
            // Workspace entry paths use '/', including on Windows.
            const relativePath = /^[A-Za-z]:\/+$/.test(requestedPath)
              ? requestedPath
              : requestedPath.replace(/\/+$/, "") || requestedPath;
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            const surfaceId = `file:${relativePath}` as const;
            const existing = withoutStandaloneExplorer.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const surface = fileSurface(
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            );
            return {
              ...current,
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? withoutStandaloneExplorer.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  )
                : [...withoutStandaloneExplorer, surface],
            };
          }),
        ),
      openAttachment: (ref, attachment) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            return upsertSurface(
              { ...current, surfaces: withoutStandaloneExplorer },
              attachmentSurface(attachment),
            );
          }),
        ),
      openTerminal: (ref, terminalId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        ),
      splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) => {
              if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
              const { splitDirection: _splitDirection, ...baseSurface } = surface;
              return {
                ...baseSurface,
                terminalIds: surface.terminalIds.includes(terminalId)
                  ? surface.terminalIds
                  : [...surface.terminalIds, terminalId],
                activeTerminalId: terminalId,
                ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
              };
            }),
          })),
        ),
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        ),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
              return {
                ...current,
                isOpen: surfaces.length > 0 && current.isOpen,
                surfaces,
                activeSurfaceId:
                  current.activeSurfaceId === surfaceId
                    ? (fallback?.id ?? null)
                    : current.activeSurfaceId,
              };
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        ),
      activateSurface: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        ),
      closeSurface: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            const next = {
              ...current,
              isOpen: surfaces.length > 0 && current.isOpen,
              surfaces,
            };
            if (current.activeSurfaceId !== surfaceId) {
              return next;
            }
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
            return {
              ...next,
              activeSurfaceId: fallback?.id ?? null,
            };
          }),
        ),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        ),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        ),
      closeAllSurfaces: (ref) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        ),
      reconcileBrowserSurfaces: (ref, tabIds, hiddenTabIds) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                surface.kind === "preview" &&
                surface.id !== "browser:new" &&
                validIds.has(surface.id),
            );
            const knownIds = new Set(existingBrowser.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`) && !hiddenTabIds?.has(tabId))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...nonBrowser, ...existingBrowser, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        ),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            if (workspaceAvailable) return current;
            const surfaces = current.surfaces.filter(
              (surface) =>
                surface.kind !== "files" &&
                (surface.kind !== "file" || surface.attachment !== undefined),
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              isOpen: surfaces.length > 0 ? current.isOpen : false,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (surfaces.at(-1)?.id ?? null),
            };
          }),
        ),
      show: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        ),
      close: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        ),
      toggleVisibility: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        ),
      toggle: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        ),
      setThreadPanelOpen: (ref, presentation, open) =>
        set((state) => ({
          threadPanelVisibilityByThreadKey: updateThreadPanelVisibilityMap(
            state.threadPanelVisibilityByThreadKey,
            scopedThreadKey(ref),
            (visibility) => {
              const key = presentation === "inline" ? "inlineOpen" : "popoverOpen";
              return visibility[key] === open ? visibility : { ...visibility, [key]: open };
            },
          ),
        })),
      toggleThreadPanel: (ref, presentation) =>
        set((state) => ({
          threadPanelVisibilityByThreadKey: updateThreadPanelVisibilityMap(
            state.threadPanelVisibilityByThreadKey,
            scopedThreadKey(ref),
            (visibility) =>
              presentation === "inline"
                ? { ...visibility, inlineOpen: !visibility.inlineOpen }
                : { ...visibility, popoverOpen: !visibility.popoverOpen },
          ),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.threadPanelVisibilityByThreadKey) &&
            !(threadKey in state.userActionRevisionByThreadKey) &&
            !(threadKey in state.closeRevisionByThreadKey)
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _visibility, ...threadPanelVisibilityByThreadKey } =
            state.threadPanelVisibilityByThreadKey;
          const { [threadKey]: _revision, ...userActionRevisionByThreadKey } =
            state.userActionRevisionByThreadKey;
          const { [threadKey]: _closeRevision, ...closeRevisionByThreadKey } =
            state.closeRevisionByThreadKey;
          return {
            byThreadKey,
            threadPanelVisibilityByThreadKey,
            userActionRevisionByThreadKey,
            closeRevisionByThreadKey,
          };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: Object.fromEntries(
          Object.entries(state.byThreadKey).filter(
            ([threadKey]) => !isPullRequestsPanelKey(threadKey) && !isIssuesPanelKey(threadKey),
          ),
        ),
        threadPanelVisibilityByThreadKey: Object.fromEntries(
          Object.entries(state.threadPanelVisibilityByThreadKey).flatMap(
            ([threadKey, visibility]) =>
              visibility.inlineOpen ? [] : [[threadKey, { inlineOpen: false, popoverOpen: false }]],
          ),
        ),
      }),
      migrate: migratePersistedRightPanelState,
    },
  ),
);

useRightPanelStore.subscribe((next, previous) => {
  if (next.closeRevisionByThreadKey === previous.closeRevisionByThreadKey) return;
  for (const [threadKey, revision] of Object.entries(next.closeRevisionByThreadKey)) {
    if (revision === previous.closeRevisionByThreadKey[threadKey]) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef) continue;
    const before = previous.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
    const after = next.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
    const removed = before.surfaces.filter(
      (surface) => !after.surfaces.some((entry) => entry.id === surface.id),
    );
    const closedInOrder = [
      ...removed.filter((surface) => surface.id !== before.activeSurfaceId),
      ...removed.filter((surface) => surface.id === before.activeSurfaceId),
    ];
    for (const surface of closedInOrder) {
      if (
        surface.kind === "terminal" ||
        (surface.kind === "preview" && surface.resourceId !== null)
      )
        continue;
      useClosedViewStore.getState().remember({ kind: "panel-tab", threadRef, surface });
    }
  }
});

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectThreadPanelVisibility(
  byThreadKey: Record<string, ThreadPanelVisibility>,
  ref: ScopedThreadRef | null | undefined,
): ThreadPanelVisibility {
  if (!ref) return DEFAULT_THREAD_PANEL_VISIBILITY;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_THREAD_PANEL_VISIBILITY;
}

export function selectThreadPanelOpen(
  byThreadKey: Record<string, ThreadPanelVisibility>,
  ref: ScopedThreadRef | null | undefined,
  presentation: ThreadPanelPresentation,
): boolean {
  const visibility = selectThreadPanelVisibility(byThreadKey, ref);
  return presentation === "inline" ? visibility.inlineOpen : visibility.popoverOpen;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return selectSelectedRightPanelSurface(byThreadKey, ref);
}

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
