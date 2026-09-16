import { describe, expect, it } from "vite-plus/test";
import branchToolbarSource from "./BranchToolbar.tsx?raw";

describe("BranchToolbar label overflow observation", () => {
  it("measures initially and when label content changes", () => {
    expect(branchToolbarSource).toMatch(
      /if \(!element\) return;\s+measure\(\);\s+\s+const resizeObserver = new ResizeObserver\(measure\);\s+const contentObserver = new MutationObserver\(measure\);/,
    );
    expect(branchToolbarSource).toMatch(
      /contentObserver\.observe\(element, \{\s+childList: true,\s+characterData: true,\s+subtree: true,\s+\}\);/,
    );
  });

  it("ignores attribute-only updates and disconnects both observers", () => {
    expect(branchToolbarSource).not.toContain("attributes: true");
    expect(branchToolbarSource).not.toMatch(/useEffect\(\(\) => \{\s*measure\(\);\s*\}\);/);
    expect(branchToolbarSource).toMatch(
      /resizeObserver\.disconnect\(\);\s+contentObserver\.disconnect\(\);/,
    );
  });
});
