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

function findLaneIndex(lanes: ReadonlyArray<Lane>, hash: string): number {
  return lanes.findIndex((lane) => lane.hash === hash);
}

function uniqueHashes(hashes: ReadonlyArray<string>): string[] {
  return Array.from(new Set(hashes));
}

function nextColorIndex(lanes: ReadonlyArray<Lane>): number {
  const usedColors = new Set(lanes.map((lane) => lane.colorIndex));
  let colorIndex = 0;

  while (usedColors.has(colorIndex)) {
    colorIndex += 1;
  }

  return colorIndex;
}

function createParentLanes(
  parentHashes: ReadonlyArray<string>,
  currentLane: Lane,
  remainingLanes: ReadonlyArray<Lane>,
): Lane[] {
  const created: Lane[] = [];
  const occupiedLanes = [...remainingLanes];

  for (const [parentIndex, parentHash] of parentHashes.entries()) {
    if (findLaneIndex(remainingLanes, parentHash) !== -1) {
      continue;
    }

    const colorIndex = parentIndex === 0 ? currentLane.colorIndex : nextColorIndex(occupiedLanes);
    const lane = { hash: parentHash, colorIndex };
    created.push(lane);
    occupiedLanes.push(lane);
  }

  return created;
}

function parentEdges(
  parentHashes: ReadonlyArray<string>,
  nodeLane: number,
  lanes: ReadonlyArray<Lane>,
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
  beforeLanes: ReadonlyArray<Lane>,
  nodeLane: number,
  afterLanes: ReadonlyArray<Lane>,
): GitHistoryGraphEdge[] {
  return beforeLanes.flatMap((lane, fromLane) => {
    if (fromLane === nodeLane) {
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
  let lanes: Lane[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    let nodeLane = findLaneIndex(lanes, commit.hash);
    const hasIncoming = nodeLane !== -1;
    if (nodeLane === -1) {
      nodeLane = lanes.length;
      lanes = [...lanes, { hash: commit.hash, colorIndex: nextColorIndex(lanes) }];
    }

    const beforeLanes = lanes;
    const currentLane = beforeLanes[nodeLane];
    if (!currentLane) {
      continue;
    }

    const parentHashes = uniqueHashes(commit.parentHashes);
    const remainingLanes = beforeLanes.filter((_, laneIndex) => laneIndex !== nodeLane);
    const createdParentLanes = createParentLanes(parentHashes, currentLane, remainingLanes);
    const afterLanes = [
      ...remainingLanes.slice(0, nodeLane),
      ...createdParentLanes,
      ...remainingLanes.slice(nodeLane),
    ];

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
