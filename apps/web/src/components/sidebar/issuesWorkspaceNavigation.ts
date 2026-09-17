export function issuesWorkspaceNavigation() {
  return {
    to: "/issues" as const,
    search: { involvement: "all" as const, state: "open" as const },
  };
}
