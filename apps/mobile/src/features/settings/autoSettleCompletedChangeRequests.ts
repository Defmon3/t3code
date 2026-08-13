export function shouldShowAutoSettleCompletedChangeRequestsSetting(input: {
  readonly preferencesLoaded: boolean;
  readonly threadListV2Enabled: boolean;
}): boolean {
  return input.preferencesLoaded && input.threadListV2Enabled;
}
