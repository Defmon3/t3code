import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

async function loadWithStorage(storage: Storage) {
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return import("./useLocalStorage");
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("local storage errors", () => {
  it("does not access or subscribe to storage without a resolved key", async () => {
    const getItem = vi.fn();
    const setItem = vi.fn();
    const addEventListener = vi.fn();
    vi.stubGlobal("window", {
      localStorage: createStorage({ getItem, setItem }),
      addEventListener,
    });
    vi.doMock("react", () => ({
      useCallback: (callback: unknown) => callback,
      useMemo: (factory: () => unknown) => factory(),
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        snapshot: () => unknown,
      ) => {
        subscribe(() => undefined);
        return snapshot();
      },
    }));
    const { useLocalStorage } = await import("./useLocalStorage");

    const [value, setValue] = useLocalStorage(null, "initial", Schema.String);
    setValue("updated");

    expect(value).toBe("initial");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("preserves read failure context", async () => {
    const cause = new Error("storage unavailable");
    const { getLocalStorageItem, LocalStorageOperationError } = await loadWithStorage(
      createStorage({
        getItem: () => {
          throw cause;
        },
      }),
    );

    try {
      getLocalStorageItem("read-key", Schema.String);
      expect.unreachable("expected the read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "read-key",
        cause,
      });
    }
  });

  it("retries when access to browser storage becomes available", async () => {
    const storage = createStorage();
    storage.setItem("read-key", JSON.stringify("saved value"));
    let blocked = true;
    vi.stubGlobal("window", {
      get localStorage() {
        if (blocked) throw new Error("storage unavailable");
        return storage;
      },
    });
    const { getLocalStorageItem, LocalStorageOperationError } = await import("./useLocalStorage");

    expect(() => getLocalStorageItem("read-key", Schema.String)).toThrow(
      LocalStorageOperationError,
    );
    blocked = false;
    expect(getLocalStorageItem("read-key", Schema.String)).toBe("saved value");
  });

  it.each(["", "not-json"])("preserves decode failure context for %j", async (value) => {
    const { getLocalStorageItem, LocalStorageOperationError } = await loadWithStorage(
      createStorage({ getItem: () => value }),
    );

    try {
      getLocalStorageItem("decode-key", Schema.String);
      expect.unreachable("expected decoding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "decode",
        storageKey: "decode-key",
        cause: expect.anything(),
      });
    }
  });

  it("preserves write failure context", async () => {
    const cause = new Error("storage quota exceeded");
    const { LocalStorageOperationError, setLocalStorageItem } = await loadWithStorage(
      createStorage({
        setItem: () => {
          throw cause;
        },
      }),
    );

    try {
      setLocalStorageItem("write-key", "value", Schema.String);
      expect.unreachable("expected the write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "write-key",
        cause,
      });
    }
  });

  it("preserves removal failure context", async () => {
    const cause = new Error("storage unavailable");
    const { LocalStorageOperationError, removeLocalStorageItem } = await loadWithStorage(
      createStorage({
        removeItem: () => {
          throw cause;
        },
      }),
    );

    try {
      removeLocalStorageItem("remove-key");
      expect.unreachable("expected the removal to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "remove",
        storageKey: "remove-key",
        cause,
      });
    }
  });
});
