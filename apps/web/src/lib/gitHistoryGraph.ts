export interface GitHistoryGraphCommit {
  hash: string;
  parentHashes: ReadonlyArray<string>;
}

export interface GitHistoryGraphEdge {
  fromLane: number;
  toLane: number;
  colorIndex: number;
  kind: "continuation" | "parent";
  parentHash?: string;
  isMissingParent?: boolean;
}

export interface GitHistoryGraphRow {
  hash: string;
  lane: number;
  colorIndex: number;
  hasIncoming: boolean;
  edges: ReadonlyArray<GitHistoryGraphEdge>;
}

export interface GitHistoryGraphLayout {
  laneCount: number;
  rows: ReadonlyArray<GitHistoryGraphRow>;
}

interface Lane {
  hash: string;
  colorIndex: number;
}

type LaneSlot = Lane | null;

function findLaneIndex(lanes: ReadonlyArray<LaneSlot>, hash: string): number {
  return lanes.findIndex((lane) => lane?.hash === hash);
}

function uniqueHashes(hashes: ReadonlyArray<string>): string[] {
  return Array.from(new Set(hashes));
}

function nextColorIndex(lanes: ReadonlyArray<LaneSlot>): number {
  const usedColors = new Set(lanes.flatMap((lane) => (lane === null ? [] : [lane.colorIndex])));
  let colorIndex = 0;

  while (usedColors.has(colorIndex)) {
    colorIndex += 1;
  }

  return colorIndex;
}

function placeParentLanes(
  parentHashes: ReadonlyArray<string>,
  nodeLane: number,
  currentLane: Lane,
  beforeLanes: ReadonlyArray<LaneSlot>,
): LaneSlot[] {
  const afterLanes = [...beforeLanes];
  afterLanes[nodeLane] = null;

  for (const [parentIndex, parentHash] of parentHashes.entries()) {
    if (findLaneIndex(afterLanes, parentHash) !== -1) {
      continue;
    }

    const emptyLane = afterLanes.findIndex((lane) => lane === null);
    const targetLane = emptyLane === -1 ? afterLanes.length : emptyLane;
    const colorIndex = parentIndex === 0 ? currentLane.colorIndex : nextColorIndex(afterLanes);
    afterLanes[targetLane] = { hash: parentHash, colorIndex };
  }

  return afterLanes;
}

function parentEdges(
  parentHashes: ReadonlyArray<string>,
  nodeLane: number,
  lanes: ReadonlyArray<LaneSlot>,
  knownHashes: ReadonlySet<string>,
): GitHistoryGraphEdge[] {
  return parentHashes.flatMap((parentHash) => {
    const parentLane = findLaneIndex(lanes, parentHash);
    const target = lanes[parentLane];
    if (!target) {
      return [];
    }

    return [
      {
        fromLane: nodeLane,
        toLane: parentLane,
        colorIndex: target.colorIndex,
        kind: "parent" as const,
        parentHash,
        isMissingParent: !knownHashes.has(parentHash),
      },
    ];
  });
}

function continuationEdges(
  beforeLanes: ReadonlyArray<LaneSlot>,
  nodeLane: number,
  afterLanes: ReadonlyArray<LaneSlot>,
): GitHistoryGraphEdge[] {
  return beforeLanes.flatMap((lane, fromLane) => {
    if (fromLane === nodeLane || lane === null) {
      return [];
    }

    const toLane = findLaneIndex(afterLanes, lane.hash);
    if (toLane === -1) {
      return [];
    }

    return [
      {
        fromLane,
        toLane,
        colorIndex: lane.colorIndex,
        kind: "continuation" as const,
      },
    ];
  });
}

export function layoutGitHistoryGraph(
  commits: ReadonlyArray<GitHistoryGraphCommit>,
): GitHistoryGraphLayout {
  const knownHashes = new Set(commits.map((commit) => commit.hash));
  const rows: GitHistoryGraphRow[] = [];
  let lanes: LaneSlot[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    let nodeLane = findLaneIndex(lanes, commit.hash);
    const hasIncoming = nodeLane !== -1;
    if (nodeLane === -1) {
      const emptyLane = lanes.findIndex((lane) => lane === null);
      nodeLane = emptyLane === -1 ? lanes.length : emptyLane;
      lanes = [...lanes];
      lanes[nodeLane] = { hash: commit.hash, colorIndex: nextColorIndex(lanes) };
    }

    const beforeLanes = lanes;
    const currentLane = beforeLanes[nodeLane];
    if (!currentLane) {
      continue;
    }

    const parentHashes = uniqueHashes(commit.parentHashes);
    const afterLanes = placeParentLanes(parentHashes, nodeLane, currentLane, beforeLanes);

    rows.push({
      hash: commit.hash,
      lane: nodeLane,
      colorIndex: currentLane.colorIndex,
      hasIncoming,
      edges: [
        ...parentEdges(parentHashes, nodeLane, afterLanes, knownHashes),
        ...continuationEdges(beforeLanes, nodeLane, afterLanes),
      ],
    });

    laneCount = Math.max(laneCount, beforeLanes.length, afterLanes.length);
    lanes = afterLanes;
  }

  return { laneCount, rows };
}
