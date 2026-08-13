import { describe, expect, it } from "vite-plus/test";

import { shouldShowAutoSettleCompletedChangeRequestsSetting } from "./autoSettleCompletedChangeRequests";

describe("shouldShowAutoSettleCompletedChangeRequestsSetting", () => {
  it("shows the control only after preferences load for the list it changes", () => {
    expect(
      shouldShowAutoSettleCompletedChangeRequestsSetting({
        preferencesLoaded: false,
        threadListV2Enabled: true,
      }),
    ).toBe(false);
    expect(
      shouldShowAutoSettleCompletedChangeRequestsSetting({
        preferencesLoaded: true,
        threadListV2Enabled: false,
      }),
    ).toBe(false);
    expect(
      shouldShowAutoSettleCompletedChangeRequestsSetting({
        preferencesLoaded: true,
        threadListV2Enabled: true,
      }),
    ).toBe(true);
  });
});
