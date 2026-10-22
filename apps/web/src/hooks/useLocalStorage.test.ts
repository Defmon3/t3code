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
});
