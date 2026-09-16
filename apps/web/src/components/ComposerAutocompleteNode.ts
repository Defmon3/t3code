import {
  TextNode,
  $getRoot,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

export const COMPOSER_AUTOCOMPLETE_SESSION = Math.random().toString(36).slice(2);

export type SerializedComposerAutocompleteNode = Spread<
  { session: string; type: "composer-autocomplete"; version: 1 },
  SerializedTextNode
>;

export class ComposerAutocompleteNode extends TextNode {
  __session: string;

  static override clone(node: ComposerAutocompleteNode): ComposerAutocompleteNode {
    return new ComposerAutocompleteNode(node.__text, node.__session, node.__key);
  }

  static override getType(): string {
    return "composer-autocomplete";
  }

  static override importDOM(): null {
    return null;
  }

  static override importJSON(
    serializedNode: SerializedComposerAutocompleteNode,
  ): ComposerAutocompleteNode {
    return $createComposerAutocompleteNode(
      serializedNode.text,
      serializedNode.session,
    ).updateFromJSON(serializedNode);
  }

  constructor(text: string, session: string, key?: NodeKey) {
    super(text, key);
    this.__session = session;
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.classList.add("text-muted-foreground/55");
    dom.dataset.composerAutocomplete = "true";
    if (this.__session !== COMPOSER_AUTOCOMPLETE_SESSION) dom.style.display = "none";
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  override exportDOM(_editor: LexicalEditor): DOMExportOutput {
    return { element: null };
  }

  excludeFromCopy(): boolean {
    return true;
  }

  override exportJSON(): SerializedComposerAutocompleteNode {
    return {
      ...super.exportJSON(),
      session: this.__session,
      type: "composer-autocomplete",
      version: 1,
    };
  }
}

export function $createComposerAutocompleteNode(
  text: string,
  session = COMPOSER_AUTOCOMPLETE_SESSION,
): ComposerAutocompleteNode {
  return new ComposerAutocompleteNode(text, session).setMode("token");
}

export function $isComposerAutocompleteNode(node: unknown): node is ComposerAutocompleteNode {
  return node instanceof ComposerAutocompleteNode;
}

export function $getComposerDraftText(): string {
  const root = $getRoot();
  const text = root.getTextContent();
  const autocompleteNode = root
    .getAllTextNodes()
    .find((node) => node instanceof ComposerAutocompleteNode);
  if (!autocompleteNode) return text;
  const suggestion = autocompleteNode.getTextContent();
  return text.endsWith(suggestion) ? text.slice(0, -suggestion.length) : text;
}
