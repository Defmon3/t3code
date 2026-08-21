import {
  VcsSnapshotExpiredError,
  type EnvironmentId,
  type VcsListHistoryRefsResult,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { usePaginatedBranches, usePaginatedHistoryRefs } from "./queries";

type PageResult =
  | {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: VcsListRefsResult;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: Error;
      readonly waiting: false;
    };

type PageAtom = {
  readonly input: {
    readonly cursor?: string;
    readonly queryGeneration: number;
  };
  readonly result: PageResult;
};

type HistoryPageResult =
  | {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: VcsListHistoryRefsResult;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: Error;
      readonly waiting: false;
    };

type HistoryPageAtom = {
  readonly cacheKey?: string | number;
  readonly input: {
    readonly cursor?: string;
  };
  readonly result: HistoryPageResult;
};

const refsState = vi.hoisted(() => ({
  atoms: [] as PageAtom[],
  refresh: vi.fn(),
  results: new Map<string, PageResult>(),
}));

const historyRefsState = vi.hoisted(() => ({
  atoms: [] as HistoryPageAtom[],
  refresh: vi.fn(),
  results: new Map<string, HistoryPageResult>(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => effect(),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly value: ReadonlyArray<PageResult> }) => atom.value,
}));

vi.mock("effect/Cause", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/Cause")>();
  return { ...actual, squash: (cause: Error) => cause };
});

vi.mock("effect/unstable/reactivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/unstable/reactivity")>();
  return {
    ...actual,
    AsyncResult: {
      ...actual.AsyncResult,
      value: (result: PageResult) =>
        result._tag === "Success" ? { _tag: "Some", value: result.value } : { _tag: "None" },
    },
    Atom: {
      ...actual.Atom,
      make: (create: unknown) => {
        if (typeof create !== "function") return actual.Atom.make(create);
        const value = create((atom) => atom.result);
        return {
          pipe: () => ({ value }),
          value,
        };
      },
      withLabel: () => (atom: unknown) => atom,
    },
  };
});

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { refresh: refsState.refresh },
}));

vi.mock("@t3tools/client-runtime/state/thread-search", () => ({
  createThreadSearchResultsAtomFamily: () => () => ({}),
  makeThreadSearchKey: () => "",
}));

vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./projects", () => ({ projectContentSearch: {}, projectEnvironment: {} }));
vi.mock("./query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("./threads", () => ({ useEnvironmentThread: () => ({}) }));

vi.mock("./vcs", () => ({
  vcsEnvironment: {
    listRefs: ({ input }: { readonly input: PageAtom["input"] }) => {
      const result = refsState.results.get(`${input.queryGeneration}:${input.cursor ?? "first"}`);
      if (result === undefined)
        throw new Error(`Missing result for ${input.queryGeneration}:${input.cursor ?? "first"}`);
      const atom = { input, result };
      refsState.atoms.push(atom);
      return atom;
    },
    listHistoryRefs: ({
      cacheKey,
      input,
    }: {
      readonly cacheKey?: string | number;
      readonly input: HistoryPageAtom["input"];
    }) => {
      const result = historyRefsState.results.get(`${cacheKey ?? 0}:${input.cursor ?? "first"}`);
      if (result === undefined)
        throw new Error(`Missing result for ${cacheKey ?? 0}:${input.cursor ?? "first"}`);
      const atom = { cacheKey, input, result };
      historyRefsState.atoms.push(atom);
      return atom;
    },
  },
}));

const target = {
  environmentId: "environment" as EnvironmentId,
  cwd: "C:/workspace",
  query: "",
};

function page(nextCursor: string | null): PageResult {
  return {
    _tag: "Success",
    waiting: false,
    value: {
      refs: [],
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor,
      currentRef: null,
      isComplete: true,
    },
  };
}

function render() {
  hooks.beginRender();
  return usePaginatedBranches(target);
}

function historyPage(nextCursor: string | null): HistoryPageResult {
  return {
    _tag: "Success",
    waiting: false,
    value: {
      refs: [],
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor,
      currentRef: null,
      isComplete: true,
    },
  };
}

function renderHistory(options?: { readonly revision?: number }) {
  hooks.beginRender();
  return usePaginatedHistoryRefs(target, options);
}

describe("usePaginatedBranches", () => {
  beforeEach(() => {
    hooks.reset();
    refsState.atoms = [];
    refsState.refresh.mockReset();
    refsState.results.clear();
  });

  it("uses a new page generation when refreshed", () => {
    refsState.results.set("0:first", page(4));
    refsState.results.set("1:first", page(null));

    const initial = render();
    initial.refresh();
    render();

    expect(refsState.atoms.map((atom) => atom.input)).toEqual([
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 0 },
      { cwd: "C:/workspace", limit: 100, namespace: "local", queryGeneration: 1, refresh: true },
    ]);
  });

  it("retries the failed appended page without duplicating its cursor", () => {
    refsState.results.set("0:first", page(4));
    refsState.results.set("0:4", {
      _tag: "Failure",
      cause: new Error("temporary failure"),
      waiting: false,
    });

    const initial = render();
    initial.loadNext();
    const withFailedPage = render();
    withFailedPage.loadNext();
    withFailedPage.retry();

    expect(refsState.atoms.map((atom) => atom.input.cursor)).toEqual([undefined, undefined, 4]);
    expect(refsState.refresh).toHaveBeenCalledTimes(1);
    expect(refsState.refresh).toHaveBeenCalledWith(refsState.atoms.at(-1));
  });

  it("recovers an expired snapshot once per generation, including after a later refresh", () => {
    const expired = (cursor: string) =>
      new VcsSnapshotExpiredError({ operation: "GitVcsDriver.listRefs", cursor });
    refsState.results.set("0:first", { _tag: "Failure", cause: expired("first"), waiting: false });
    refsState.results.set("1:first", page(null));

    render();
    render();
    render();

    expect(refsState.atoms.map((atom) => atom.input.queryGeneration)).toEqual([0, 1, 1]);

    const recovered = render();
    recovered.refresh();
    refsState.results.set("2:first", { _tag: "Failure", cause: expired("second"), waiting: false });
    refsState.results.set("3:first", page(null));
    render();
    render();

    expect(refsState.atoms.map((atom) => atom.input.queryGeneration)).toEqual([0, 1, 1, 1, 2, 3]);
  });
});

describe("usePaginatedHistoryRefs", () => {
  beforeEach(() => {
    hooks.reset();
    historyRefsState.atoms = [];
    historyRefsState.refresh.mockReset();
    historyRefsState.results.clear();
  });

  it("uses a string cache identity for each refresh generation", () => {
    historyRefsState.results.set("0:0:first", historyPage(null));
    historyRefsState.results.set("0:1:first", historyPage(null));

    const initial = renderHistory();
    initial.refresh();
    renderHistory();

    expect(historyRefsState.atoms.map((atom) => atom.cacheKey)).toEqual(["0:0", "0:1"]);
    expect(historyRefsState.atoms.map((atom) => atom.input)).toEqual([
      { cwd: "C:/workspace", limit: 100, namespace: "local" },
      { cwd: "C:/workspace", limit: 100, namespace: "local", refresh: true },
    ]);
  });

  it("recovers an expired snapshot once per generation, including after a later refresh", () => {
    const expired = (cursor: string) =>
      new VcsSnapshotExpiredError({ operation: "GitVcsDriver.listHistoryRefs", cursor });
    historyRefsState.results.set("0:0:first", {
      _tag: "Failure",
      cause: expired("first"),
      waiting: false,
    });
    historyRefsState.results.set("0:1:first", historyPage(null));

    renderHistory();
    renderHistory();
    renderHistory();

    expect(historyRefsState.atoms.map((atom) => atom.cacheKey)).toEqual(["0:0", "0:1", "0:1"]);

    const recovered = renderHistory();
    recovered.refresh();
    historyRefsState.results.set("0:2:first", {
      _tag: "Failure",
      cause: expired("second"),
      waiting: false,
    });
    historyRefsState.results.set("0:3:first", historyPage(null));
    renderHistory();
    renderHistory();

    expect(historyRefsState.atoms.map((atom) => atom.cacheKey)).toEqual([
      "0:0",
      "0:1",
      "0:1",
      "0:1",
      "0:2",
      "0:3",
    ]);
  });

  it("distinguishes revision and generation pairs while recovering expired snapshots", () => {
    const expired = (cursor: string) =>
      new VcsSnapshotExpiredError({ operation: "GitVcsDriver.listHistoryRefs", cursor });
    historyRefsState.results.set("1:0:first", {
      _tag: "Failure",
      cause: expired("revision-one"),
      waiting: false,
    });
    historyRefsState.results.set("0:1:first", {
      _tag: "Failure",
      cause: expired("revision-zero"),
      waiting: false,
    });
    historyRefsState.results.set("0:2:first", historyPage(null));

    renderHistory({ revision: 1 });
    renderHistory({ revision: 0 });
    renderHistory({ revision: 0 });

    expect(historyRefsState.atoms.map((atom) => atom.cacheKey)).toEqual(["1:0", "0:1", "0:2"]);
  });
});
