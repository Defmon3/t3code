import type { EnvironmentId, VcsListRefsResult } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { usePaginatedBranches } from "./queries";

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
    readonly cursor?: number;
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
    useEffect: () => {},
    useMemo: reactHookHarness.useMemo,
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
  },
}));

const target = {
  environmentId: "environment" as EnvironmentId,
  cwd: "C:/workspace",
  query: "",
};

function page(nextCursor: number | null): PageResult {
  return {
    _tag: "Success",
    waiting: false,
    value: {
      refs: [],
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor,
      totalCount: 0,
    },
  };
}

function render() {
  hooks.beginRender();
  return usePaginatedBranches(target);
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
      { cwd: "C:/workspace", limit: 100, queryGeneration: 0 },
      { cwd: "C:/workspace", limit: 100, queryGeneration: 1 },
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
});
