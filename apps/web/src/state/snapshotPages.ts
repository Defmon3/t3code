import { useAtomValue } from "@effect/atom-react";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";

const INITIAL_CURSORS = [undefined] as const;

type PageAtom<Value, Error> = Atom.Atom<AsyncResult.AsyncResult<Value, Error>>;

export interface PaginationState<Cursor> {
  readonly targetKey: string | null;
  readonly cursors: ReadonlyArray<Cursor | undefined>;
  readonly generation: number;
  readonly refreshFirstPage: boolean;
}

export function usePaginatedSnapshotPages<Value, Error, Cursor>(input: {
  readonly targetKey: string | null;
  readonly label: string;
  readonly makePageAtom:
    | ((
        cursor: Cursor | undefined,
        generation: number,
        refreshFirstPage: boolean,
      ) => PageAtom<Value, Error>)
    | null;
  readonly getNextCursor: (page: Value) => Cursor | null | undefined;
  readonly maxPages?: number;
  readonly isExpiredError?: (cause: Cause.Cause<Error>) => boolean;
  readonly refreshPage?: boolean;
  readonly initialPagination?: PaginationState<Cursor>;
  readonly onPaginationChange?: (pagination: PaginationState<Cursor>) => void;
}) {
  const onPaginationChange = input.onPaginationChange;
  const [expiredRecovery, setExpiredRecovery] = useState<string | null>(null);
  const initialPagination =
    input.initialPagination?.targetKey === input.targetKey
      ? input.initialPagination
      : {
          targetKey: input.targetKey,
          cursors: INITIAL_CURSORS,
          generation: 0,
          refreshFirstPage: false,
        };
  const [pagination, setPagination] = useState<PaginationState<Cursor>>(initialPagination);
  const activePagination: PaginationState<Cursor> =
    pagination.targetKey === input.targetKey
      ? pagination
      : {
          targetKey: input.targetKey,
          cursors: INITIAL_CURSORS,
          generation: pagination.generation,
          refreshFirstPage: false,
        };
  if (pagination.targetKey !== input.targetKey) {
    setPagination(activePagination);
    setExpiredRecovery(null);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the mounted panel pagination in its external state store
  useEffect(() => {
    onPaginationChange?.(activePagination);
  }, [activePagination, onPaginationChange]);
  const pageAtoms = (() => {
    const makePageAtom = input.makePageAtom;
    return input.targetKey === null || makePageAtom === null
      ? []
      : activePagination.cursors.map((cursor, index) =>
          makePageAtom(
            cursor,
            activePagination.generation,
            index === 0 && activePagination.refreshFirstPage,
          ),
        );
  })();
  const pagesAtom = Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
    Atom.withLabel(`${input.label}:${input.targetKey ?? "empty"}`),
  );
  const results = useAtomValue(pagesAtom);
  const values = results.flatMap((result) => {
    const value = Option.getOrNull(AsyncResult.value(result));
    return value === null ? [] : [value];
  });
  const failedIndex = results.findIndex((result) => result._tag === "Failure");
  const failed = failedIndex === -1 ? null : results[failedIndex]!;

  const recoveredForTarget = pagination.targetKey === input.targetKey ? expiredRecovery : null;
  if (
    failed?._tag === "Failure" &&
    input.isExpiredError?.(failed.cause) === true &&
    recoveredForTarget !== input.targetKey
  ) {
    setExpiredRecovery(input.targetKey);
    setPagination({
      targetKey: input.targetKey,
      cursors: INITIAL_CURSORS,
      generation: activePagination.generation + 1,
      refreshFirstPage: true,
    });
  } else if (
    recoveredForTarget === input.targetKey &&
    results.length > 0 &&
    results.every((result) => result._tag === "Success" && result.waiting === false)
  ) {
    setExpiredRecovery(null);
  }

  const refresh = () => {
    if (input.targetKey === null) return;
    const firstPage = pageAtoms[0];
    setPagination({
      targetKey: input.targetKey,
      cursors: INITIAL_CURSORS,
      generation: activePagination.generation + 1,
      refreshFirstPage: true,
    });
    setExpiredRecovery(null);
    if (input.refreshPage === true && firstPage !== undefined) appAtomRegistry.refresh(firstPage);
  };
  const retry = () => {
    const failedPage = failedIndex === -1 ? undefined : pageAtoms[failedIndex];
    if (failedPage !== undefined) appAtomRegistry.refresh(failedPage);
  };
  const loadNext = () => {
    const lastPage = values.at(-1);
    const nextCursor = lastPage === undefined ? null : input.getNextCursor(lastPage);
    if (input.targetKey === null || nextCursor === null || nextCursor === undefined) {
      return;
    }
    setPagination((current) => {
      if (current.targetKey !== input.targetKey) return current;
      const cursors = current.cursors;
      if (input.maxPages !== undefined && cursors.length >= input.maxPages) return current;
      return cursors.includes(nextCursor)
        ? current
        : {
            targetKey: input.targetKey,
            cursors: [...cursors, nextCursor],
            generation: current.generation,
            refreshFirstPage: current.refreshFirstPage,
          };
    });
  };

  const lastResult = results.at(-1);

  return {
    cursors: activePagination.cursors,
    generation: activePagination.generation,
    pageAtoms,
    results,
    values,
    failed,
    isPending: results.some((result) => result.waiting),
    isFetchingNextPage:
      results.length > 1 &&
      lastResult?.waiting === true &&
      Option.isNone(AsyncResult.value(lastResult)),
    refresh,
    retry,
    loadNext,
  };
}
