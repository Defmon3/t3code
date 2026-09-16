import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  HISTORY_MERGE_TAG,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_TAB_COMMAND,
  type NodeKey,
} from "lexical";
import { useEffect } from "react";
import {
  $createComposerAutocompleteNode,
  $getComposerDraftText,
  COMPOSER_AUTOCOMPLETE_SESSION,
  ComposerAutocompleteNode,
} from "./ComposerAutocompleteNode";

const QUERY_DELAY_MS = 250;

export function ComposerAutocompletePlugin(props: {
  enabled: boolean;
  query: (draft: string) => Promise<string | null>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let autocompleteNodeKey: NodeKey | null = null;
    let suggestion: string | null = null;
    let querySequence = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastDraft: string | null = null;

    const clearSuggestion = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      querySequence += 1;
      const node = autocompleteNodeKey === null ? null : $getNodeByKey(autocompleteNodeKey);
      if (node?.isAttached()) node.remove();
      autocompleteNodeKey = null;
      suggestion = null;
      lastDraft = null;
    };

    const readEligibleDraft = (): string | null => {
      if (!props.enabled) return null;
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
      const node = selection.anchor.getNode();
      if (!$isTextNode(node) || !node.isSimpleText()) return null;
      if (selection.anchor.offset !== node.getTextContentSize()) return null;
      const nextSibling = node.getNextSibling();
      if (nextSibling !== null && !(nextSibling instanceof ComposerAutocompleteNode)) return null;
      const draft = $getComposerDraftText();
      if (draft.trim().length < 8 || !/\s$/.test(draft)) return null;
      return draft;
    };

    const handleUpdate = () => {
      editor.update(
        () => {
          const draft = readEligibleDraft();
          if (draft === null) {
            if (lastDraft !== null || autocompleteNodeKey !== null || timer !== null) {
              clearSuggestion();
            }
            return;
          }
          if (draft === lastDraft) return;
          clearSuggestion();
          lastDraft = draft;
          const sequence = querySequence;
          timer = setTimeout(() => {
            timer = null;
            void props.query(draft).then((result) => {
              if (sequence !== querySequence || result === null) return;
              editor.update(
                () => {
                  const currentDraft = readEligibleDraft();
                  if (currentDraft !== draft) return;
                  const selection = $getSelection();
                  if (!$isRangeSelection(selection)) return;
                  const selectionCopy = selection.clone();
                  const node = $createComposerAutocompleteNode(
                    result,
                    COMPOSER_AUTOCOMPLETE_SESSION,
                  );
                  autocompleteNodeKey = node.getKey();
                  selection.insertNodes([node]);
                  $setSelection(selectionCopy);
                  suggestion = result;
                  lastDraft = draft;
                },
                { tag: HISTORY_MERGE_TAG },
              );
            });
          }, QUERY_DELAY_MS);
        },
        { tag: HISTORY_MERGE_TAG },
      );
    };

    const acceptSuggestion = (event: KeyboardEvent | null): boolean => {
      if (suggestion === null || autocompleteNodeKey === null) return false;
      const node = $getNodeByKey(autocompleteNodeKey);
      if (!(node instanceof ComposerAutocompleteNode)) return false;
      const textNode = $createTextNode(suggestion);
      node.replace(textNode);
      textNode.selectEnd();
      autocompleteNodeKey = null;
      suggestion = null;
      lastDraft = null;
      querySequence += 1;
      event?.preventDefault();
      return true;
    };

    const unregisterTransform = editor.registerNodeTransform(ComposerAutocompleteNode, (node) => {
      if (
        node.__session === COMPOSER_AUTOCOMPLETE_SESSION &&
        node.getKey() !== autocompleteNodeKey
      ) {
        clearSuggestion();
      }
    });
    const unregisterUpdate = editor.registerUpdateListener(handleUpdate);
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      acceptSuggestion,
      COMMAND_PRIORITY_LOW,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      acceptSuggestion,
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      if (timer !== null) clearTimeout(timer);
      unregisterTransform();
      unregisterUpdate();
      unregisterTab();
      unregisterRight();
      editor.update(clearSuggestion, { tag: HISTORY_MERGE_TAG });
    };
  }, [editor, props.enabled, props.query]);

  return null;
}
