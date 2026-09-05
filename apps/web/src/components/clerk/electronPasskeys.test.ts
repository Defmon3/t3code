import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { electronPasskeys } from "./ElectronManagedAuthShell";

const publicKeyOptions = {
  allowCredentials: [],
  challenge: new Uint8Array([1]),
  rpId: "clerk.t3.codes",
  timeout: 60_000,
  userVerification: "preferred" as const,
};

const stubNativePasskeys = () => {
  const get = vi.fn().mockResolvedValue({
    ok: false,
    error: { code: "cancelled", message: "user cancelled" },
  });

  vi.stubGlobal("location", { protocol: "t3code:", hostname: "app" });
  vi.stubGlobal("window", {
    PublicKeyCredential: vi.fn(),
    __clerk_internal_electron_passkeys: {
      platform: "darwin",
      electronMajor: 41,
      get,
    },
  });

  return get;
};

describe("Electron passkeys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables Clerk autofill without changing the native adapter", async () => {
    const get = stubNativePasskeys();

    expect(await electronPasskeys.isAutoFillSupported()).toBe(false);
    const result = await electronPasskeys.get({ publicKeyOptions, conditionalUI: true });

    expect(get).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({ code: "passkey_operation_aborted" });
  });

  it("keeps an explicit passkey request available", async () => {
    const get = stubNativePasskeys();

    await electronPasskeys.get({ publicKeyOptions, conditionalUI: false });

    expect(get).toHaveBeenCalledOnce();
  });
});
