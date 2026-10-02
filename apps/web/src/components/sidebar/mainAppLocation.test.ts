import { expect, it } from "vite-plus/test";

import { isSidebarUtilityPage } from "./mainAppLocation";

it.each([
  "/settings",
  "/settings/general",
  "/projects/project",
  "/usage",
  "/pull-requests",
  "/issues",
])("recognizes %s as a utility page", (pathname) => {
  expect(isSidebarUtilityPage(pathname)).toBe(true);
});

it.each(["/", "/environments/server/threads/thread", "/issues-other"])(
  "keeps %s in the main app",
  (pathname) => {
    expect(isSidebarUtilityPage(pathname)).toBe(false);
  },
);
