import { describe, expect, it } from "vite-plus/test";

import { layoutGitHistoryGraph } from "./gitHistoryGraph";

describe("layoutGitHistoryGraph", () => {
  it("lays out a linear history in one lane", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "c", parentHashes: ["b"] },
      { hash: "b", parentHashes: ["a"] },
      { hash: "a", parentHashes: [] },
    ]);

    expect(layout).toEqual({
      laneCount: 1,
      rows: [
        {
          hash: "c",
          lane: 0,
          colorIndex: 0,
          edges: [
            {
              fromLane: 0,
              toLane: 0,
              colorIndex: 0,
              kind: "parent",
              parentHash: "b",
              isMissingParent: false,
            },
          ],
        },
        {
          hash: "b",
          lane: 0,
          colorIndex: 0,
          edges: [
            {
              fromLane: 0,
              toLane: 0,
              colorIndex: 0,
              kind: "parent",
              parentHash: "a",
              isMissingParent: false,
            },
          ],
        },
        { hash: "a", lane: 0, colorIndex: 0, edges: [] },
      ],
    });
  });

  it("keeps branch lanes and colors stable through a merge", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "merge", parentHashes: ["main", "side"] },
      { hash: "main", parentHashes: ["base"] },
      { hash: "side", parentHashes: ["base"] },
      { hash: "base", parentHashes: [] },
    ]);

    expect(layout.laneCount).toBe(2);
    expect(layout.rows.map((row) => [row.hash, row.lane, row.colorIndex])).toEqual([
      ["merge", 0, 0],
      ["main", 0, 0],
      ["side", 1, 1],
      ["base", 0, 0],
    ]);
    expect(layout.rows[0]?.edges).toEqual([
      {
        fromLane: 0,
        toLane: 0,
        colorIndex: 0,
        kind: "parent",
        parentHash: "main",
        isMissingParent: false,
      },
      {
        fromLane: 0,
        toLane: 1,
        colorIndex: 1,
        kind: "parent",
        parentHash: "side",
        isMissingParent: false,
      },
    ]);
    expect(layout.rows[1]?.edges).toEqual([
      {
        fromLane: 0,
        toLane: 0,
        colorIndex: 0,
        kind: "parent",
        parentHash: "base",
        isMissingParent: false,
      },
      { fromLane: 1, toLane: 1, colorIndex: 1, kind: "continuation" },
    ]);
    expect(layout.rows[2]?.edges).toEqual([
      {
        fromLane: 1,
        toLane: 0,
        colorIndex: 0,
        kind: "parent",
        parentHash: "base",
        isMissingParent: false,
      },
      { fromLane: 0, toLane: 0, colorIndex: 0, kind: "continuation" },
    ]);
  });

  it("allocates one lane for each octopus parent", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "octopus", parentHashes: ["first", "second", "third"] },
      { hash: "first", parentHashes: [] },
      { hash: "second", parentHashes: [] },
      { hash: "third", parentHashes: [] },
    ]);

    expect(layout.laneCount).toBe(3);
    expect(layout.rows[0]?.edges).toEqual([
      {
        fromLane: 0,
        toLane: 0,
        colorIndex: 0,
        kind: "parent",
        parentHash: "first",
        isMissingParent: false,
      },
      {
        fromLane: 0,
        toLane: 1,
        colorIndex: 1,
        kind: "parent",
        parentHash: "second",
        isMissingParent: false,
      },
      {
        fromLane: 0,
        toLane: 2,
        colorIndex: 2,
        kind: "parent",
        parentHash: "third",
        isMissingParent: false,
      },
    ]);
    expect(layout.rows.map((row) => [row.hash, row.lane, row.colorIndex])).toEqual([
      ["octopus", 0, 0],
      ["first", 0, 0],
      ["second", 0, 1],
      ["third", 0, 2],
    ]);
  });

  it("keeps missing page-boundary parents visible and starts unrelated commits in a new lane", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "newest", parentHashes: ["older-than-page"] },
      { hash: "unrelated", parentHashes: [] },
    ]);

    expect(layout).toEqual({
      laneCount: 2,
      rows: [
        {
          hash: "newest",
          lane: 0,
          colorIndex: 0,
          edges: [
            {
              fromLane: 0,
              toLane: 0,
              colorIndex: 0,
              kind: "parent",
              parentHash: "older-than-page",
              isMissingParent: true,
            },
          ],
        },
        {
          hash: "unrelated",
          lane: 1,
          colorIndex: 1,
          edges: [{ fromLane: 0, toLane: 0, colorIndex: 0, kind: "continuation" }],
        },
      ],
    });
  });

  it("is deterministic and does not duplicate an edge for repeated parent hashes", () => {
    const commits = [
      { hash: "tip", parentHashes: ["base", "base"] },
      { hash: "base", parentHashes: [] },
    ];

    expect(layoutGitHistoryGraph(commits)).toEqual(layoutGitHistoryGraph(commits));
    expect(layoutGitHistoryGraph(commits).rows[0]?.edges).toHaveLength(1);
  });
});
