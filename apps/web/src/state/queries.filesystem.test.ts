import {
  AuthFilesystemReadScope,
  EnvironmentId,
  type AuthSessionState,
  type VcsListHistoryRefsResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { act } from "../../test/act";

const state = vi.hoisted(() => ({
  realHooks: false,
  historyResults: [] as ReadonlyArray<AsyncResult.AsyncResult<VcsListHistoryRefsResult, unknown>>,
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  sessionWaiting: false,
  phase: "connected" as "connected" | "offline",
  sessionAtom: {},
  searchAtom: {},
  contentAtom: {},
  contentRequests: vi.fn(),
  contentError: null as string | null,
  contentData: {
    matches: [{ path: "src/index.ts", lineNumber: 3, lineContent: "a match", matchRanges: [] }],
    truncated: false,
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <A>(callback: A) => callback,
    useEffect: () => {},
    useMemo: <A>(factory: () => A) => factory(),
    useState: <A>(value: A) => (state.realHooks ? actual.useState(value) : [value, vi.fn()]),
  };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.historyResults }));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./projects", () => ({
  projectEnvironment: { searchEntries: () => state.searchAtom },
  projectContentSearch: (target: unknown) => {
    state.contentRequests(target);
    return state.contentAtom;
  },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./threads", () => ({ useEnvironmentThread: vi.fn() }));
vi.mock("./vcs", () => ({ vcsEnvironment: { listHistoryRefs: () => ({}) } }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === state.sessionAtom
        ? state.session
        : atom === state.searchAtom
          ? { entries: [{ path: "src/index.ts", kind: "file" }] }
          : atom === state.contentAtom
            ? state.contentData
            : null,
    error:
      atom === state.sessionAtom
        ? state.sessionError
        : atom === state.contentAtom
          ? state.contentError
          : null,
    isPending:
      atom === state.sessionAtom &&
      (state.sessionWaiting || (state.session === null && state.sessionError === null)),
    refresh: vi.fn(),
  }),
}));

import { usePaginatedHistoryRefs, useProjectContentSearch } from "./queries";

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  cwd: "/repo",
  query: "src",
};

beforeEach(() => {
  state.realHooks = false;
  state.historyResults = [];
  state.session = null;
  state.sessionError = null;
  state.sessionWaiting = false;
  state.phase = "connected";
  state.contentRequests.mockClear();
  state.contentError = null;
});

it("settles history refs in React and retains refresh data only within its repository scope", async () => {
  const branch = {
    name: "main",
    current: true,
    isDefault: true,
    isRemote: false,
    isTag: false,
    worktreePath: null,
  };
  const firstPage: VcsListHistoryRefsResult = {
    refs: [branch],
    currentRef: branch,
    isRepo: true,
    repositoryKey: target.cwd,
    hasPrimaryRemote: true,
    nextCursor: null,
    isComplete: true,
  };
  state.historyResults = [AsyncResult.success(firstPage)];
  state.realHooks = true;
  let renderer: ReactTestRenderer | undefined;
  function HistoryRefsProbe({ cwd }: { readonly cwd: string }) {
    const view = usePaginatedHistoryRefs({ ...target, cwd, query: "" });
    return createElement(
      "button",
      { type: "button", onClick: view.refresh },
      view.refs.map((ref) => ref.name).join(","),
    );
  }
  try {
    await act(() => {
      renderer = create(createElement(HistoryRefsProbe, { cwd: target.cwd }));
    });
    expect(renderer!.root.findByType("button").props.children).toBe("main");
    await act(() => renderer!.update(createElement(HistoryRefsProbe, { cwd: target.cwd })));
    expect(renderer!.root.findByType("button").props.children).toBe("main");

    const continuation = { ...firstPage, refs: [{ ...branch, name: "continuation" }] };
    state.historyResults = [AsyncResult.success(firstPage), AsyncResult.success(continuation)];
    await act(() => renderer!.update(createElement(HistoryRefsProbe, { cwd: target.cwd })));
    expect(renderer!.root.findByType("button").props.children).toBe("main,continuation");

    const replacement = { ...firstPage, refs: [{ ...branch, name: "replacement" }] };
    state.historyResults = [AsyncResult.success(replacement)];
    await act(() => renderer!.update(createElement(HistoryRefsProbe, { cwd: target.cwd })));
    expect(renderer!.root.findByType("button").props.children).toBe("replacement");

    state.historyResults = [AsyncResult.initial(true)];
    await act(() => renderer!.root.findByType("button").props.onClick());
    expect(renderer!.root.findByType("button").props.children).toBe("replacement");

    state.historyResults = [AsyncResult.success({ ...firstPage, refs: [], currentRef: null })];
    await act(() => renderer!.update(createElement(HistoryRefsProbe, { cwd: target.cwd })));
    expect(renderer!.root.findByType("button").props.children).toBe("");

    state.historyResults = [AsyncResult.success(firstPage)];
    await act(() => renderer!.update(createElement(HistoryRefsProbe, { cwd: target.cwd })));
    state.historyResults = [AsyncResult.initial(true)];
    await act(() =>
      renderer!.update(createElement(HistoryRefsProbe, { cwd: "/other-repository" })),
    );
    expect(renderer!.root.findByType("button").props.children).toBe("");
  } finally {
    await act(() => renderer?.unmount());
    state.realHooks = false;
  }
});

const contentTarget = {
  ...target,
  query: " a match ",
  caseSensitive: true,
  wholeWord: true,
  useRegex: false,
};

it("shows content-search denial before typing and never issues an unauthorized request", () => {
  state.session = { authenticated: true, scopes: [] };
  for (const query of ["", contentTarget.query]) {
    const result = useProjectContentSearch({ ...contentTarget, query });
    expect(state.contentRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      canReadFiles: false,
      isCheckingAccess: false,
      matches: [],
      error: "This connection cannot search host files.",
      isPending: false,
    });
  }
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("keeps confirmed content access during revalidation and drops results when it is revoked", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionWaiting = true;
  expect(useProjectContentSearch(contentTarget)).toMatchObject({
    matches: state.contentData.matches,
    isPending: false,
  });

  state.contentRequests.mockClear();
  state.sessionWaiting = false;
  state.session = { authenticated: true, scopes: [] };
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: "This connection cannot search host files.",
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("fails closed after a session check fails, even with a cached grant and matches", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = "The session has expired.";
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: state.sessionError,
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});
