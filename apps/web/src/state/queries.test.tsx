import {
  VcsSnapshotExpiredError,
  type EnvironmentId,
  type VcsListHistoryRefsResult,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { usePaginatedHistoryRefs } from "./queries";

type PageResult =
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

type PageAtom = {
  readonly input: {
    readonly cursor?: string;
    readonly queryGeneration: number;
  };
  readonly result: PageResult;
};

const refsState = vi.hoisted(() => ({
  atoms: [] as PageAtom[],
  refresh: vi.fn(),
  results: new Map<string, PageResult>(),
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
    listHistoryRefs: ({ input }: { readonly input: PageAtom["input"] }) => {
      const result = refsState.results.get(`${input.queryGeneration}:${input.cursor ?? "first"}`);
      if (result === undefined)
        throw new Error(`Missing result for ${input.queryGeneration}:${input.cursor ?? "first"}`);
      const atom = { input, result };
      refsState.atoms.push(atom);
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
  return usePaginatedHistoryRefs(target);
}

describe("usePaginatedHistoryRefs", () => {
  beforeEach(() => {
    hooks.reset();
    refsState.atoms = [];
    refsState.refresh.mockReset();
    refsState.results.clear();
  });

  it("uses a new page generation when refreshed", () => {
    refsState.results.set("0:first", page("cursor-4"));
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
    refsState.results.set("0:first", page("cursor-4"));
    refsState.results.set("0:cursor-4", {
      _tag: "Failure",
      cause: new Error("temporary failure"),
      waiting: false,
    });

    const initial = render();
    initial.loadNext();
    const withFailedPage = render();
    withFailedPage.loadNext();
    withFailedPage.retry();

    expect(refsState.atoms.map((atom) => atom.input.cursor)).toEqual([
      undefined,
      undefined,
      "cursor-4",
    ]);
    expect(refsState.refresh).toHaveBeenCalledTimes(1);
    expect(refsState.refresh).toHaveBeenCalledWith(refsState.atoms.at(-1));
  });

  it("recovers an expired snapshot once per generation, including after a later refresh", () => {
    const expired = (cursor: string) =>
      new VcsSnapshotExpiredError({ operation: "GitVcsDriver.listHistoryRefs", cursor });
    refsState.results.set("0:first", { _tag: "Failure", cause: expired("first"), waiting: false });
    refsState.results.set("1:first", page(null));

    render();
    render();
    render();

    expect(refsState.atoms.map((atom) => atom.input.queryGeneration)).toEqual([0, 1]);

    const recovered = render();
    recovered.refresh();
    refsState.results.set("2:first", { _tag: "Failure", cause: expired("second"), waiting: false });
    refsState.results.set("3:first", page(null));
    render();
    render();

    expect(refsState.atoms.map((atom) => atom.input.queryGeneration)).toEqual([0, 1, 2, 3]);
  });
});
