import {
  EnvironmentId,
  VcsSnapshotExpiredError,
  type GitCommitDetails,
  type GitHistoryCommit,
  type VcsGetHistoryResult,
  type VcsListCommitFilesResult,
  type VcsHistoryRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";

type PageResult =
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
  | {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: VcsGetHistoryResult | VcsListCommitFilesResult;
    };

type PageAtom = { readonly result: PageResult };

const effectQueue = vi.hoisted(() => ({
  cursor: 0,
  dependencies: [] as Array<ReadonlyArray<unknown> | undefined>,
  effects: [] as Array<() => void>,
  stateUpdates: 0,
}));

const historyState = vi.hoisted(() => ({
  commitDetails: null as GitCommitDetails | null,
  diff: { diff: "", isRepo: true, truncated: false },
  getCommitDetails: vi.fn(),
  listCommitFiles: vi.fn(),
  commitFiles: {
    files: [],
    isRepo: true,
    nextCursor: null,
    hasMore: false,
    capped: false,
  } as VcsListCommitFilesResult,
  commitFilesErrorCause: null as Cause.Cause<unknown> | null,
  commitFilesRefresh: vi.fn(),
  getCommitDiff: vi.fn(),
  getHistory: vi.fn(),
  historyRevision: 0,
  connection: { phase: "connected", generation: 1 } as {
    readonly phase: string;
    readonly generation: number;
  },
  pages: new Map<string | undefined, PageResult>(),
  refresh: vi.fn(),
  refreshRefs: vi.fn(),
  refreshRemoteRefs: vi.fn(),
  refreshTags: vi.fn(),
  toastAdd: vi.fn(),
  refs: [] as ReadonlyArray<VcsHistoryRef>,
  refsResolved: true,
  refsError: null as string | null,
  remoteRefsError: null as string | null,
  retryRefs: vi.fn(),
  tags: [] as ReadonlyArray<VcsHistoryRef>,
  tagsError: null as string | null,
  status: { aheadCount: 0, behindCount: 0 },
}));

function historyCacheGeneration(cacheKey: string | number | undefined): number | undefined {
  return typeof cacheKey === "string"
    ? cacheKey
        .slice(1, -1)
        .split(",")
        .map(Number)
        .reduce((sum, value) => sum + value, 0)
    : cacheKey;
}

const fontState = vi.hoisted(() => ({ interfaceSize: 16 }));

vi.mock("../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: (options?: { readonly onError?: (error: Error) => void }) => ({
    copyToClipboard: () => options?.onError?.(new Error("Clipboard permission was denied.")),
    isCopied: false,
  }),
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: <Value,>(
    selector: (settings: { readonly fontSizeInterface: number }) => Value,
  ) => selector({ fontSizeInterface: fontState.interfaceSize }),
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: historyState.toastAdd },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useDeferredValue: <Value,>(value: Value) => value,
    useEffect: (effect: () => void, dependencies?: ReadonlyArray<unknown>) => {
      const index = effectQueue.cursor++;
      const previous = effectQueue.dependencies[index];
      if (
        previous !== undefined &&
        dependencies !== undefined &&
        previous.length === dependencies.length &&
        previous.every((value, dependencyIndex) => Object.is(value, dependencies[dependencyIndex]))
      ) {
        return;
      }
      effectQueue.dependencies[index] = dependencies;
      effectQueue.effects.push(effect);
    },
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: <Value,>(initialValue: Value | (() => Value)) => {
      const [value, setValue] = reactHookHarness.useState(initialValue);
      return [
        value,
        (nextValue: Value | ((previous: Value) => Value)) => {
          effectQueue.stateUpdates += 1;
          setValue(nextValue);
        },
      ] as const;
    },
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../hooks/useLocalStorage", () => ({
  useLocalStorage: () => [[], vi.fn()],
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly value: ReadonlyArray<PageAtom["result"]> }) => atom.value,
}));

vi.mock("effect/unstable/reactivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/unstable/reactivity")>();
  return {
    ...actual,
    AsyncResult: {
      ...actual.AsyncResult,
      value: (result: PageAtom["result"]) =>
        result._tag === "Success" ? Option.some(result.value) : Option.none(),
    },
    Atom: {
      ...actual.Atom,
      make: (
        create: (get: (atom: PageAtom) => PageAtom["result"]) => ReadonlyArray<PageAtom["result"]>,
      ) => {
        let previous: ReadonlyArray<PageAtom["result"]> | undefined;
        const atom = {
          pipe: () => atom,
          get value() {
            const next = create((pageAtom) => pageAtom.result);
            if (
              previous !== undefined &&
              previous.length === next.length &&
              previous.every((result, index) => {
                const candidate = next[index]!;
                return (
                  result._tag === candidate._tag &&
                  ("waiting" in result ? result.waiting : false) ===
                    ("waiting" in candidate ? candidate.waiting : false) &&
                  (result._tag === "Success"
                    ? candidate._tag === "Success" && result.value === candidate.value
                    : candidate._tag === "Failure" && result.cause === candidate.cause)
                );
              })
            ) {
              return previous;
            }
            previous = next;
            return next;
          },
        };
        return atom;
      },
      withLabel: () => (atom: unknown) => atom,
    },
  };
});

vi.mock("@legendapp/list/react", () => ({
  LegendList: () => null,
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { refresh: historyState.refresh },
}));

vi.mock("../state/queries", () => ({
  useDebouncedValue: <Value,>(value: Value) => value,
  isVcsSnapshotExpiredCause: (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "VcsSnapshotExpiredError"
    );
  },
  makeVcsSnapshotCacheKey: (generation: number, revision: number) =>
    JSON.stringify([generation, revision]),
  usePaginatedHistoryRefs: (_target: unknown, options?: { readonly namespace?: string }) => {
    const refs = options?.namespace === "tag" ? historyState.tags : historyState.refs;
    return {
      data: historyState.refsResolved
        ? {
            refs,
            isRepo: true,
            repositoryKey: "C:/repositories/t3code/.git",
            nextCursor: null,
            currentRef: refs.find((ref) => ref.current) ?? null,
            isComplete: true,
          }
        : null,
      refs,
      error:
        options?.namespace === "local"
          ? historyState.refsError
          : options?.namespace === "remote"
            ? historyState.remoteRefsError
            : historyState.tagsError,
      isPending: false,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
      retry: historyState.retryRefs,
      refresh:
        options?.namespace === "tag"
          ? historyState.refreshTags
          : options?.namespace === "remote"
            ? historyState.refreshRemoteRefs
            : historyState.refreshRefs,
    };
  },
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (target: { readonly kind?: string } | null) => {
    const base = { error: null, errorCause: null, isPending: false, refresh: vi.fn() };
    if (target?.kind === "status") return { ...base, data: historyState.status };
    if (target?.kind === "commit-details")
      return { ...base, data: { commit: historyState.commitDetails } };
    if (target?.kind === "commit-files") {
      const errorCause = historyState.commitFilesErrorCause;
      return {
        ...base,
        data: errorCause === null ? historyState.commitFiles : null,
        error: errorCause === null ? null : "Git browsing snapshot expired.",
        errorCause,
        refresh: historyState.commitFilesRefresh,
      };
    }
    if (target?.kind === "commit-diff") return { ...base, data: historyState.diff };
    return { ...base, data: null };
  },
}));

vi.mock("../state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: historyState.connection }),
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    historyRevisionAtom: () => ({ value: historyState.historyRevision }),
    getHistory: (target: {
      readonly cacheKey?: string | number;
      readonly input: { readonly cursor?: string };
    }) => {
      historyState.getHistory({ ...target, cacheKey: historyCacheGeneration(target.cacheKey) });
      const value = historyState.pages.get(target.input.cursor);
      return { result: value ?? page([]) } satisfies PageAtom;
    },
    getCommitDetails: (target: unknown) => {
      historyState.getCommitDetails(target);
      return { kind: "commit-details" };
    },
    listCommitFiles: (target: { readonly cacheKey?: string | number; readonly input: unknown }) => {
      historyState.listCommitFiles({
        ...target,
        cacheKey: historyCacheGeneration(target.cacheKey),
      });
      return {
        get result() {
          return historyState.commitFilesErrorCause === null
            ? { _tag: "Success" as const, waiting: false as const, value: historyState.commitFiles }
            : {
                _tag: "Failure" as const,
                waiting: false as const,
                cause: historyState.commitFilesErrorCause,
              };
        },
      };
    },
    getCommitDiff: (target: unknown) => {
      historyState.getCommitDiff(target);
      return { kind: "commit-diff" };
    },
    status: () => ({ kind: "status" }),
  },
}));

import GitHistoryPanel from "./GitHistoryPanel";

const environmentId = EnvironmentId.make("environment-local");
const workspacePath = "C:/workspace";
const historyPageSize = 100;
const primaryCommitHash = "aaaaaaaa11111111111111111111111111111111";
const secondaryCommitHash = "bbbbbbbb22222222222222222222222222222222";
const newestMatchingCommitHash = "cccccccc33333333333333333333333333333333";

function commit(hash: string, subject: string, authorName = "Ada Lovelace"): GitHistoryCommit {
  return {
    hash,
    parentHashes: [],
    subject,
    authorName,
    authorEmail: "ada@example.com",
    authoredAt: "2026-08-01T12:00:00.000Z",
    refs: [],
  };
}

function page(
  commits: ReadonlyArray<GitHistoryCommit>,
  options?: {
    readonly capped?: boolean;
    readonly hasMore?: boolean;
    readonly nextCursor?: string | null;
  },
): PageResult {
  return {
    _tag: "Success",
    waiting: false,
    value: {
      commits,
      isRepo: true,
      hasMore: options?.hasMore ?? false,
      nextCursor: options?.nextCursor ?? null,
      capped: options?.capped ?? false,
    },
  };
}

const expiredHistoryPage = (): PageResult => ({
  _tag: "Failure",
  cause: Cause.fail(
    Object.assign(new Error("Git browsing snapshot expired."), { _tag: "VcsSnapshotExpiredError" }),
  ),
});

function expiredSnapshotCause(): Cause.Cause<unknown> {
  return Cause.fail(
    new VcsSnapshotExpiredError({
      operation: "GitVcsDriver.listCommitFiles",
      cursor: "expired-cursor",
    }),
  );
}

function gitRef(
  name: string,
  options?: {
    readonly aheadCount?: number;
    readonly behindCount?: number;
    readonly current?: boolean;
    readonly kind?: "local" | "remote" | "tag";
    readonly upstreamName?: string;
  },
): VcsHistoryRef {
  return {
    name,
    current: options?.current ?? false,
    isDefault: false,
    kind: options?.kind ?? "local",
    ...(options?.aheadCount === undefined ? {} : { aheadCount: options.aheadCount }),
    ...(options?.behindCount === undefined ? {} : { behindCount: options.behindCount }),
    ...(options?.upstreamName === undefined ? {} : { upstreamName: options.upstreamName }),
    worktreePath: null,
  };
}

function renderPanel(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  effectQueue.cursor = 0;
  const boundary = GitHistoryPanel({
    environmentId,
    cwd: workspacePath,
  }) as ReactElement<Record<string, unknown>>;
  return (
    boundary.type as (props: Record<string, unknown>) => ReactElement<Record<string, unknown>>
  )(boundary.props);
}

function flushEffects(): void {
  const effects = effectQueue.effects.splice(0);
  for (const effect of effects) effect();
}

function stubResizeObserver(initialWidth: number): (width: number) => void {
  let notify: ((width: number) => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: ReadonlyArray<{ contentRect: { width: number } }>) => void) {
        notify = (width) => callback([{ contentRect: { width } }]);
      }

      disconnect() {}

      observe() {
        notify?.(initialWidth);
      }
    },
  );
  return (width) => notify?.(width);
}

function historyList(panel: ReactElement<Record<string, unknown>>) {
  const list = visitElements(
    panel,
    (element) =>
      typeof element.props.estimatedItemSize === "number" &&
      typeof element.props.keyExtractor === "function",
  );
  expect(list).not.toBeNull();
  return list as ReactElement<{
    readonly data: ReadonlyArray<{
      readonly commit: GitHistoryCommit;
      readonly graph: { readonly edges: ReadonlyArray<{ readonly kind: string }> };
    }>;
    readonly renderItem: (props: {
      readonly item: {
        readonly commit: GitHistoryCommit;
        readonly graph: { readonly edges: ReadonlyArray<unknown> };
      };
    }) => ReactElement<Record<string, unknown>>;
    readonly estimatedItemSize: number;
    readonly onEndReached?: () => void;
    readonly recycleItems?: boolean;
  }>;
}

function loadMoreHistory(panel: ReactElement<Record<string, unknown>>): void {
  const footer = visitElements(
    panel,
    (element) =>
      element.props.className === "flex shrink-0 justify-center border-t border-border/50 p-2",
  );
  const loadMore = visitElements(footer, (element) => element.props.children === "Load more");
  expect(loadMore).not.toBeNull();
  (loadMore?.props.onClick as (() => void) | undefined)?.();
}

function renderComponent(
  element: ReactElement<Record<string, unknown>>,
): ReactElement<Record<string, unknown>> {
  const component = element.type as unknown as (
    props: Record<string, unknown>,
  ) => ReactElement<Record<string, unknown>>;
  return component(element.props);
}

function componentTree(
  panel: ReactElement<Record<string, unknown>>,
  componentName: string,
  props?: Partial<Record<string, unknown>>,
): ReactElement<Record<string, unknown>> {
  const component = visitElements(
    panel,
    (element) =>
      typeof element.type === "function" &&
      element.type.name === componentName &&
      Object.entries(props ?? {}).every(([key, value]) => element.props[key] === value),
  );
  expect(component).not.toBeNull();
  return renderComponent(component as ReactElement<Record<string, unknown>>);
}

function componentElement(
  panel: ReactElement<Record<string, unknown>>,
  componentName: string,
): ReactElement<Record<string, unknown>> {
  const component = visitElements(
    panel,
    (element) => typeof element.type === "function" && element.type.name === componentName,
  );
  expect(component).not.toBeNull();
  return component as ReactElement<Record<string, unknown>>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  hooks.reset();
  fontState.interfaceSize = 16;
  effectQueue.cursor = 0;
  effectQueue.dependencies.length = 0;
  effectQueue.effects.length = 0;
  effectQueue.stateUpdates = 0;
  historyState.commitDetails = null;
  historyState.diff = { diff: "", isRepo: true, truncated: false };
  historyState.getCommitDetails.mockReset();
  historyState.listCommitFiles.mockReset();
  historyState.commitFiles = {
    files: [],
    isRepo: true,
    nextCursor: null,
    hasMore: false,
    capped: false,
  };
  historyState.commitFilesErrorCause = null;
  historyState.commitFilesRefresh.mockReset();
  historyState.getCommitDiff.mockReset();
  historyState.getHistory.mockReset();
  historyState.historyRevision = 0;
  historyState.connection = { phase: "connected", generation: 1 };
  historyState.pages.clear();
  historyState.refresh.mockReset();
  historyState.refreshRefs.mockReset();
  historyState.refreshRemoteRefs.mockReset();
  historyState.refreshTags.mockReset();
  historyState.toastAdd.mockReset();
  historyState.refs = [];
  historyState.refsResolved = true;
  historyState.refsError = null;
  historyState.remoteRefsError = null;
  historyState.retryRefs.mockReset();
  historyState.tags = [];
  historyState.tagsError = null;
  historyState.status = { aheadCount: 0, behindCount: 0 };
});

export {
  componentElement,
  componentTree,
  commit,
  effectQueue,
  environmentId,
  expiredHistoryPage,
  expiredSnapshotCause,
  flushEffects,
  fontState,
  gitRef,
  historyCacheGeneration,
  historyList,
  historyPageSize,
  historyState,
  loadMoreHistory,
  newestMatchingCommitHash,
  page,
  primaryCommitHash,
  renderComponent,
  renderPanel,
  secondaryCommitHash,
  stubResizeObserver,
  visitElements,
  workspacePath,
};
