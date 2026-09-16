import { describe, expect, it } from "vite-plus/test";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import {
  $createComposerAutocompleteNode,
  $getComposerDraftText,
  ComposerAutocompleteNode,
} from "./ComposerAutocompleteNode";

describe("ComposerAutocompleteNode", () => {
  it("keeps ghost text out of the controlled composer draft", () => {
    const editor = createEditor({ nodes: [ComposerAutocompleteNode] });

    editor.update(
      () => {
        const paragraph = $createParagraphNode().append(
          $createTextNode("Please fix the "),
          $createComposerAutocompleteNode("failing tests"),
        );
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );

    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "Please fix the failing tests",
    );
    expect(editor.getEditorState().read($getComposerDraftText)).toBe("Please fix the ");
  });

  it("becomes normal draft text only after replacement", () => {
    const editor = createEditor({ nodes: [ComposerAutocompleteNode] });

    editor.update(
      () => {
        const paragraph = $createParagraphNode().append($createTextNode("Please fix the "));
        const ghost = $createComposerAutocompleteNode("failing tests");
        paragraph.append(ghost);
        $getRoot().append(paragraph);
        ghost.replace($createTextNode(ghost.getTextContent()));
      },
      { discrete: true },
    );

    expect(editor.getEditorState().read($getComposerDraftText)).toBe(
      "Please fix the failing tests",
    );
  });
});
