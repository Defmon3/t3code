import { useEffect, useState } from "react";

/**
 * Every tab the reader has opened stays mounted behind the active one, so returning to one is not
 * a rebuild: a long description and a long conversation both re-parse their whole markdown, and a
 * diff virtualizes against its own scroll position. The caller hides the inactive ones with
 * `visibility`, which keeps boxes, sizes and scroll offsets.
 */
export function useMountedTabs<Tab extends string>(tab: Tab, scope?: string): ReadonlySet<Tab> {
  const [mountState, setMountState] = useState(() => ({ scope, tabs: new Set<Tab>([tab]) }));
  const mountedTabs = mountState.scope === scope ? mountState.tabs : new Set<Tab>([tab]);
  useEffect(() => {
    setMountState((previous) => {
      if (previous.scope !== scope) return { scope, tabs: new Set<Tab>([tab]) };
      return previous.tabs.has(tab)
        ? previous
        : { scope, tabs: new Set<Tab>(previous.tabs).add(tab) };
    });
  }, [scope, tab]);
  return mountedTabs;
}
