import { createStore, type StoreApi } from "zustand/vanilla";
import type { PaginationState } from "../../state/snapshotPages";

export interface GitHistoryRevisionState {
  readonly label: string;
  readonly revision: string;
}

export interface GitHistoryDiffRequest {
  readonly hash: string;
  readonly filePath?: string;
}

interface GitHistoryPanelState {
  readonly scopeKey: string | null;
  readonly targetKey: string | null;
  readonly filter: string;
  readonly selectedHash: string | null;
  readonly diffRequest: GitHistoryDiffRequest | null;
  readonly selectedRevision: GitHistoryRevisionState | null | undefined;
  readonly historyPagination: PaginationState<string>;
  readonly commitFilesTargetKey: string | null;
  readonly commitFilesPagination: PaginationState<string>;
  setScope: (scopeKey: string) => void;
  setTarget: (targetKey: string) => void;
  setFilter: (filter: string) => void;
  setSelectedHash: (hash: string | null) => void;
  setDiffRequest: (request: GitHistoryDiffRequest | null) => void;
  setSelectedRevision: (revision: GitHistoryRevisionState | null | undefined) => void;
  setHistoryPagination: (pagination: PaginationState<string>) => void;
  setCommitFilesTarget: (targetKey: string | null) => void;
  setCommitFilesPagination: (pagination: PaginationState<string>) => void;
}

const emptyState = {
  targetKey: null,
  filter: "",
  selectedHash: null,
  diffRequest: null,
  selectedRevision: undefined,
  historyPagination: {
    targetKey: null,
    cursors: [undefined],
    generation: 0,
    refreshFirstPage: false,
  },
  commitFilesTargetKey: null,
  commitFilesPagination: {
    targetKey: null,
    cursors: [undefined],
    generation: 0,
    refreshFirstPage: false,
  },
} as const;

export type GitHistoryPanelStore = StoreApi<GitHistoryPanelState>;

export function createGitHistoryPanelStore(): GitHistoryPanelStore {
  return createStore<GitHistoryPanelState>((set) => ({
    scopeKey: null,
    ...emptyState,
    setScope: (scopeKey) =>
      set((current) => (current.scopeKey === scopeKey ? current : { scopeKey, ...emptyState })),
    setTarget: (targetKey) =>
      set((current) =>
        current.targetKey === targetKey
          ? current
          : {
              ...current,
              targetKey,
              filter: "",
              selectedHash: null,
              diffRequest: null,
              historyPagination: {
                targetKey,
                cursors: [undefined],
                generation: 0,
                refreshFirstPage: false,
              },
              commitFilesTargetKey: null,
              commitFilesPagination: {
                targetKey: null,
                cursors: [undefined],
                generation: 0,
                refreshFirstPage: false,
              },
            },
      ),
    setFilter: (filter) => set({ filter }),
    setSelectedHash: (selectedHash) => set({ selectedHash, diffRequest: null }),
    setDiffRequest: (diffRequest) => set({ diffRequest }),
    setSelectedRevision: (selectedRevision) => set({ selectedRevision }),
    setHistoryPagination: (historyPagination) => set({ historyPagination }),
    setCommitFilesTarget: (commitFilesTargetKey) =>
      set((current) =>
        current.commitFilesTargetKey === commitFilesTargetKey
          ? current
          : {
              ...current,
              commitFilesTargetKey,
              commitFilesPagination: {
                targetKey: commitFilesTargetKey,
                cursors: [undefined],
                generation: 0,
                refreshFirstPage: false,
              },
            },
      ),
    setCommitFilesPagination: (commitFilesPagination) => set({ commitFilesPagination }),
  }));
}
