import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { usePaginatedSnapshotPages } from "./snapshotPages";

interface Page {
  readonly next: string | null;
}

type Result = AsyncResult.AsyncResult<Page, Error>;
type PageAtom = Atom.Atom<Result>;

const state = vi.hoisted(() => ({
  atoms: [] as Array<{
    readonly cursor: string | undefined;
    readonly generation: number;
    readonly target: string;
  }>,
  pageResults: new Map<PageAtom, () => Result>(),
  results: new Map<string, Result>(),
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
  useAtomValue: (atom: { readonly value: ReadonlyArray<Result> }) => atom.value,
}));

vi.mock("effect/unstable/reactivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/unstable/reactivity")>();
  return {
    ...actual,
    Atom: {
      ...actual.Atom,
      make: (create: unknown) => {
        if (typeof create !== "function") return actual.Atom.make(create);
        return {
          pipe: () => ({
            get value() {
              return create((atom: PageAtom) => state.pageResults.get(atom)!());
            },
          }),
        };
      },
      withLabel: () => (atom: unknown) => atom,
    },
  };
});

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: vi.fn() } }));

function page(next: string | null, waiting = false): Result {
  return AsyncResult.success({ next }, { waiting });
}

function expired(): Result {
  return AsyncResult.failure(Cause.fail(new Error("expired")));
}

function key(target: string, generation: number, cursor: string | undefined): string {
  return `${target}:${generation}:${cursor ?? "first"}`;
}

function render(targetKey: string) {
  hooks.beginRender();
  return usePaginatedSnapshotPages<Page, Error, string>({
    targetKey,
    label: "test:snapshot-pages",
    makePageAtom: (cursor, generation) => {
      state.atoms.push({ cursor, generation, target: targetKey });
      const resultKey = key(targetKey, generation, cursor);
      const initialResult = state.results.get(resultKey);
      if (initialResult === undefined) throw new Error(`Missing result for ${resultKey}`);
      const atom = Atom.make(initialResult);
      state.pageResults.set(atom, () => state.results.get(resultKey) ?? initialResult);
      return atom;
    },
    getNextCursor: (value) => value.next,
    isExpiredError: (cause) => {
      const error = Cause.squash(cause);
      return error instanceof Error && error.message === "expired";
    },
  });
}

describe("usePaginatedSnapshotPages", () => {
  beforeEach(() => {
    hooks.reset();
    state.atoms = [];
    state.pageResults.clear();
    state.results.clear();
  });

  it("retries consecutive expired responses only once", () => {
    state.results.set(key("A", 0, undefined), expired());
    state.results.set(key("A", 1, undefined), expired());

    render("A");
    render("A");
    render("A");

    expect(state.atoms.map((atom) => atom.generation)).toEqual([0, 1, 1]);
  });

  it("keeps the expiry recovery lock while a previous page is refreshing", () => {
    state.results.set(key("A", 0, undefined), expired());
    state.results.set(key("A", 1, undefined), page(null, true));

    render("A");
    render("A");
    state.results.set(key("A", 1, undefined), expired());
    render("A");

    expect(state.atoms.map((atom) => atom.generation)).toEqual([0, 1, 1]);
  });

  it("starts one fresh first page for a manual refresh", () => {
    state.results.set(key("A", 0, undefined), page(null));
    state.results.set(key("A", 1, undefined), page(null));

    const initial = render("A");
    initial.refresh();
    render("A");

    expect(state.atoms.map((atom) => atom.generation)).toEqual([0, 1]);
  });

  it("allows an expired target to recover again after a target switch", () => {
    state.results.set(key("A", 0, undefined), expired());
    state.results.set(key("A", 1, undefined), expired());
    state.results.set(key("A", 2, undefined), page(null));
    state.results.set(key("B", 1, undefined), page(null));

    render("A");
    render("A");
    render("B");
    render("A");
    render("A");

    expect(state.atoms.map((atom) => `${atom.target}:${atom.generation}`)).toEqual([
      "A:0",
      "A:1",
      "B:1",
      "A:1",
      "A:2",
    ]);
  });

  it("does not resurrect a previous target when its stale page callback runs", () => {
    state.results.set(key("A", 0, undefined), page("next-a"));
    state.results.set(key("B", 0, undefined), page(null));

    const targetA = render("A");
    render("B");
    targetA.loadNext();
    render("B");

    expect(state.atoms).toEqual([
      { target: "A", generation: 0, cursor: undefined },
      { target: "B", generation: 0, cursor: undefined },
      { target: "B", generation: 0, cursor: undefined },
    ]);
  });
});
