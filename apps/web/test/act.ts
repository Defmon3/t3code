import { act as reactAct } from "react";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    return await reactAct(async () => await callback());
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}
