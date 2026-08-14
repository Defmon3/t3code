import type {
  EnvironmentId,
  GitHubIssueFilters as GitHubIssueFiltersValue,
  GitHubIssueListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

interface FilterProps {
  readonly onChange: (value: GitHubIssueFiltersValue) => void;
  readonly onSortChange: (sort: "newest" | "oldest") => void;
}

interface ButtonProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly children?: unknown;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}

const paneState = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  invalidate: vi.fn(),
  list: vi.fn(() => ({})),
  refresh: vi.fn(),
  results: [
    {
      _tag: "Success" as const,
      waiting: false,
      value: {
        repository: {
          nameWithOwner: "owner/repo",
          url: "https://github.com/owner/repo",
          canCreateIssue: false as const,
          newIssueUrl: null,
        },
        items: [
          {
            number: 42,
            title: "Issue",
            url: "https://github.com/owner/repo/issues/42",
            state: "open" as const,
            author: null,
            createdAt: "2026-01-01T00:00:00Z",
            labels: [],
            assignees: [],
            milestone: null,
            issueType: null,
            commentCount: 0,
          },
        ],
        openCount: 1,
        closedCount: 0,
        totalCount: 1,
        nextCursor: null,
        hasMore: false,
        searchCapReached: false,
      },
    },
  ],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => {
      paneState.effects.push(effect);
    },
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => paneState.results }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
}));
vi.mock("effect/Option", () => ({ getOrNull: <Value,>(value: Value) => value }));
vi.mock("effect/unstable/reactivity", () => ({
  AsyncResult: { value: (result: (typeof paneState.results)[number]) => result.value },
  Atom: { make: () => ({ pipe: () => ({}) }), withLabel: () => (atom: unknown) => atom },
}));
vi.mock("../../state/githubIssues", () => ({
  githubIssuesEnvironment: { invalidate: {}, list: paneState.list },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => paneState.invalidate }));
vi.mock("../../localApi", () => ({ readLocalApi: () => null }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: paneState.refresh } }));
vi.mock("@legendapp/list/react", () => ({ LegendList: () => null }));
vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("../ui/input", () => ({ Input: () => null }));
vi.mock("./GitHubIssueFilters", () => ({ GitHubIssueFilters: () => null }));
vi.mock("./GitHubIssueRow", () => ({ GitHubIssueRow: () => null }));

import { GitHubIssueFilters } from "./GitHubIssueFilters";
import { GitHubIssuesPane } from "./GitHubIssuesPane";

function initialResult(): (typeof paneState.results)[number] {
  return {
    _tag: "Success",
    waiting: false,
    value: {
      repository: {
        nameWithOwner: "owner/repo",
        url: "https://github.com/owner/repo",
        canCreateIssue: false,
        newIssueUrl: null,
      },
      items: [
        {
          number: 42,
          title: "Issue",
          url: "https://github.com/owner/repo/issues/42",
          state: "open",
          author: null,
          createdAt: "2026-01-01T00:00:00Z",
          labels: [],
          assignees: [],
          milestone: null,
          issueType: null,
          commentCount: 0,
        },
      ],
      openCount: 1,
      closedCount: 0,
      totalCount: 1,
      nextCursor: null,
      hasMore: false,
      searchCapReached: false,
    },
  } as (typeof paneState.results)[number];
}

function renderPane(environmentId: EnvironmentId = "environment" as EnvironmentId) {
  hooks.beginRender();
  return GitHubIssuesPane({ environmentId, cwd: "C:\\repo", wide: false });
}

function findButton(tree: unknown, label: string): ButtonProps {
  const element = visitElements(tree, (candidate) => candidate.props["aria-label"] === label);
  if (element === null) throw new Error(`Missing ${label} button.`);
  return element.props as ButtonProps;
}

function findFilters(tree: unknown): FilterProps {
  const element = visitElements(tree, (candidate) => candidate.type === GitHubIssueFilters);
  if (element === null) throw new Error("Missing issue filters.");
  return element.props as unknown as FilterProps;
}

function findNewIssueButton(tree: unknown): ButtonProps {
  const element = visitElements(
    tree,
    (candidate) =>
      candidate.props.children === "New issue" ||
      (Array.isArray(candidate.props.children) &&
        candidate.props.children.some((child) => child === " New issue")),
  );
  if (element === null) throw new Error("Missing New issue button.");
  return element.props as ButtonProps;
}

describe("GitHubIssuesPane", () => {
  beforeEach(() => {
    hooks.reset();
    paneState.effects.length = 0;
    paneState.results.splice(0, paneState.results.length, initialResult());
    paneState.invalidate.mockReset();
    paneState.invalidate.mockResolvedValue({ _tag: "Success", value: undefined });
    paneState.list.mockClear();
    paneState.refresh.mockReset();
  });

  it("configures stable, recycled issue rows in a bounded viewport", () => {
    const tree = renderPane();
    const list = visitElements(tree, (candidate) => candidate.props.recycleItems === true);

    expect(list?.props).toMatchObject({
      className: "h-full",
      estimatedItemSize: 56,
      recycleItems: true,
    });
    expect(
      (
        list?.props.keyExtractor as
          | ((issue: GitHubIssueListResult["items"][number]) => string)
          | undefined
      )?.(paneState.results[0]!.value.items[0]!),
    ).toBe("42");
    expect(
      visitElements(tree, (candidate) => candidate.props.className === "min-h-0 flex-1"),
    ).not.toBeNull();
  });

  it("bounds search input and hides New issue when the repository cannot create issues", () => {
    const tree = renderPane();

    expect(
      visitElements(tree, (candidate) => candidate.props["aria-label"] === "Search GitHub issues")
        ?.props.maxLength,
    ).toBe(256);
    expect(
      visitElements(
        tree,
        (candidate) =>
          Array.isArray(candidate.props.children) &&
          candidate.props.children.some(
            (child) => typeof child === "string" && child.includes("New issue"),
          ),
      ),
    ).toBeNull();
  });

  it("uses GitHub green styling for the externally opened New issue action", () => {
    const repository = paneState.results[0]!.value.repository as unknown as {
      canCreateIssue: boolean;
      newIssueUrl: string | null;
    };
    repository.canCreateIssue = true;
    repository.newIssueUrl = "https://github.com/owner/repo/issues/new";

    const className = findNewIssueButton(renderPane()).className ?? "";

    expect(className).toContain("bg-[#1f883d]");
    expect(className).toContain("hover:bg-[#1a7f37]");
    expect(className).toContain("dark:bg-[#238636]");
    expect(className).toContain("text-white");
    expect(findNewIssueButton(renderPane()).children).toBe("New issue");
  });

  it("uses a new issue request when the environment changes", () => {
    renderPane();
    paneState.list.mockClear();

    renderPane("other-environment" as EnvironmentId);

    expect(paneState.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentId: "other-environment" }),
    );
  });

  it("does not merge cached pages after a failed page", () => {
    paneState.results.push(
      {
        _tag: "Failure",
        waiting: false,
        cause: Cause.fail(new Error("Failed page")),
      } as unknown as (typeof paneState.results)[number],
      {
        _tag: "Success",
        waiting: false,
        value: {
          ...paneState.results[0]!.value,
          items: [{ ...paneState.results[0]!.value.items[0]!, number: 43 }],
        },
      } as (typeof paneState.results)[number],
    );

    const tree = renderPane();
    const list = visitElements(tree, (candidate) => candidate.props.recycleItems === true);

    expect(list?.props.data as ReadonlyArray<unknown> | undefined).toHaveLength(1);
  });

  it("hides Load more when a continuation request failed", () => {
    const page = paneState.results[0]!.value as unknown as {
      nextCursor: string | null;
      hasMore: boolean;
    };
    page.nextCursor = "next-page";
    page.hasMore = true;
    paneState.results.push({
      _tag: "Failure",
      waiting: false,
      cause: Cause.fail(new Error("Failed page")),
    } as unknown as (typeof paneState.results)[number]);

    const tree = renderPane();

    expect(visitElements(tree, (candidate) => candidate.props.children === "Load more")).toBeNull();
  });

  it("waits to apply filter edits before issuing the next issue request", () => {
    findFilters(renderPane()).onChange({ author: "theo" });
    paneState.list.mockClear();
    const effectStart = paneState.effects.length;

    renderPane();

    expect(paneState.list).not.toHaveBeenCalled();

    const timeouts: Array<() => void> = [];
    vi.stubGlobal("window", {
      clearTimeout: () => undefined,
      setTimeout: (callback: () => void) => {
        timeouts.push(callback);
        return 0;
      },
    });
    paneState.effects[effectStart + 1]?.();
    timeouts[0]?.();
    renderPane();

    expect(paneState.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ filters: { author: "theo" } }) }),
    );
    vi.unstubAllGlobals();
  });

  it("prevents duplicate refreshes while invalidation is running and reports failures", async () => {
    let settle: ((result: { readonly _tag: "Failure" }) => void) | undefined;
    paneState.invalidate.mockImplementation(
      () =>
        new Promise((resolve: (result: { readonly _tag: "Failure" }) => void) => {
          settle = resolve;
        }),
    );
    const refresh = findButton(renderPane(), "Refresh GitHub issues");
    refresh.onClick?.();
    refresh.onClick?.();

    expect(paneState.invalidate).toHaveBeenCalledTimes(1);
    expect(findButton(renderPane(), "Refresh GitHub issues").disabled).toBe(true);

    settle?.({ _tag: "Failure" });
    await Promise.resolve();

    const tree = renderPane();
    expect(
      visitElements(
        tree,
        (candidate) => candidate.props.children === "Could not refresh GitHub issues. Try again.",
      ),
    ).not.toBeNull();
  });

  it("does not refresh a stale request after its filters change", async () => {
    let settle:
      | ((result: { readonly _tag: "Success"; readonly value: undefined }) => void)
      | undefined;
    paneState.invalidate.mockImplementation(
      () =>
        new Promise(
          (resolve: (result: { readonly _tag: "Success"; readonly value: undefined }) => void) => {
            settle = resolve;
          },
        ),
    );
    const tree = renderPane();
    findButton(tree, "Refresh GitHub issues").onClick?.();
    findFilters(tree).onSortChange("oldest");
    renderPane();

    settle?.({ _tag: "Success", value: undefined });
    await Promise.resolve();

    expect(paneState.refresh).toHaveBeenCalledOnce();
    expect(paneState.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ sort: "oldest" }) }),
    );
  });

  it("does not show a refresh failure after changing repositories", async () => {
    let settle: ((result: { readonly _tag: "Failure" }) => void) | undefined;
    paneState.invalidate.mockImplementation(
      () =>
        new Promise((resolve: (result: { readonly _tag: "Failure" }) => void) => {
          settle = resolve;
        }),
    );
    findButton(renderPane(), "Refresh GitHub issues").onClick?.();
    renderPane("other-environment" as EnvironmentId);

    settle?.({ _tag: "Failure" });
    await Promise.resolve();

    expect(
      visitElements(
        renderPane("other-environment" as EnvironmentId),
        (candidate) => candidate.props.children === "Could not refresh GitHub issues. Try again.",
      ),
    ).toBeNull();
  });
});
