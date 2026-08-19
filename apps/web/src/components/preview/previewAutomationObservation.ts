import type {
  PreviewAutomationHarArtifact,
  PreviewAutomationObservationStatus,
  PreviewTabId,
} from "@t3tools/contracts";

export function projectPreviewObservationTabId<
  A extends PreviewAutomationObservationStatus & {
    readonly artifact?: PreviewAutomationHarArtifact | undefined;
  },
>(result: A, tabId: PreviewTabId) {
  return {
    ...result,
    tabId,
    ...(result.artifact ? { artifact: { ...result.artifact, tabId } } : {}),
  };
}
