import { describe, expect, it } from "vite-plus/test";
import { normalizeComposerSuggestion } from "./composerAutocomplete.ts";

describe("normalizeComposerSuggestion", () => {
  it("removes a repeated prompt prefix", () => {
    expect(normalizeComposerSuggestion("Please fix the ", "Please fix the failing tests")).toBe(
      "failing tests",
    );
  });

  it("removes repeated trailing words without case sensitivity", () => {
    expect(normalizeComposerSuggestion("Please fix the ", "Fix the syntax error.")).toBe(
      "syntax error.",
    );
  });

  it("removes an echoed prefix despite apostrophe differences", () => {
    expect(normalizeComposerSuggestion("Lets create a new ", "Let's create a new project.")).toBe(
      "project.",
    );
  });

  it("preserves a direct continuation", () => {
    expect(normalizeComposerSuggestion("Please add ", " focused regression tests")).toBe(
      "focused regression tests",
    );
  });
});
