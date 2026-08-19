interface PreviewPresentationWaitOptions {
  readonly deadline: number;
  readonly isVisible: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

export const waitForPreviewPresentation = async ({
  deadline,
  isVisible,
  now = Date.now,
  sleep = (durationMs) => new Promise<void>((resolve) => window.setTimeout(resolve, durationMs)),
}: PreviewPresentationWaitOptions): Promise<boolean> => {
  while (now() <= deadline) {
    if (isVisible()) return true;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    await sleep(Math.min(16, remainingMs));
  }
  return false;
};
