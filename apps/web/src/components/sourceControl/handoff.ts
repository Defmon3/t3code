import {
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "~/composerDraftStore";
import { reviewCommentContextId } from "~/lib/composerContextRecords";
import { removeInlineContextReference } from "~/lib/composerContextReferences";
import type { ReviewCommentContext } from "~/reviewCommentContext";

/**
 * Every chip a hand-off leaves in the composer is named after the pull request or issue it came
 * from — `pull-request-context:`, `pull-request-finding:`, `pull-request-selection:`,
 * `issue-context:` — which is what tells them apart from the ones a reader attached themselves.
 */
const HANDOFF_COMMENT_ID_PATTERN = /^(?:pull-request|issue)-/u;

/**
 * What the last hand-off wrote into each composer, kept outside React because the panel that wrote
 * it is closed by the time the next one opens. It is how a prompt the reader has since edited is
 * told apart from the one they were handed: only the sentence still exactly as written may be
 * replaced.
 */
const lastHandoffPromptByDraft = new Map<string, string>();

function handoffPrompt(
  existing: {
    readonly prompt: string;
    /**
     * What the last hand-off into this draft wrote — its own contribution alone, never the
     * merged prompt it landed in, or a draft that held the reader's text before the first
     * hand-off would read as all hand-off and be replaced wholesale by the second.
     */
    readonly lastHandoffPrompt: string | undefined;
  },
  incoming: string,
): string {
  if (existing.prompt.trim().length === 0) return incoming;
  const last = existing.lastHandoffPrompt ?? "";
  // Only the sentence the last hand-off wrote is taken back: alone, or off the end of the
  // reader's own text it was appended under.
  const kept =
    last.length === 0
      ? existing.prompt
      : existing.prompt === last
        ? ""
        : existing.prompt.endsWith(`\n\n${last}`)
          ? existing.prompt.slice(0, -(last.length + 2))
          : existing.prompt;
  if (kept.trim().length === 0) return incoming;
  return incoming.length === 0 ? kept : `${kept}\n\n${incoming}`;
}

/**
 * The chips the composer should hold once a hand-off lands there: this one's, plus whatever the
 * reader attached themselves. What an earlier hand-off left goes, because a question about one
 * pull request carrying another one's context is not a question anybody meant to ask.
 */
function handoffReviewComments(
  existing: ReadonlyArray<ReviewCommentContext>,
  incoming: ReadonlyArray<ReviewCommentContext>,
): ReviewCommentContext[] {
  return [
    ...existing.filter((comment) => !HANDOFF_COMMENT_ID_PATTERN.test(comment.id)),
    ...incoming,
  ];
}

export function writeHandoffToComposer(
  target: ComposerThreadTarget,
  task: {
    readonly prompt: string;
    readonly reviewComments?: ReadonlyArray<ReviewCommentContext> | undefined;
  },
): void {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, target);
  if (key === null) return;
  const draft = store.getComposerDraft(target);
  const existing = draft?.reviewComments ?? [];
  let prompt = draft?.prompt ?? "";
  for (const comment of existing) {
    if (!HANDOFF_COMMENT_ID_PATTERN.test(comment.id)) continue;
    prompt = removeInlineContextReference(prompt, reviewCommentContextId(comment.id)).prompt;
  }
  store.setPrompt(
    target,
    handoffPrompt({ prompt, lastHandoffPrompt: lastHandoffPromptByDraft.get(key) }, task.prompt),
  );
  // Remember the hand-off's own contribution, not the merged prompt: only that sentence is
  // this panel's to take back next time, and the reader's text around it is not.
  lastHandoffPromptByDraft.set(key, task.prompt);
  store.setReviewComments(target, handoffReviewComments(existing, task.reviewComments ?? []));
}
