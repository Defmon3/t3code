import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_BUILD_VERSION__: string | undefined;

export const SERVER_VERSION =
  typeof __T3CODE_BUILD_VERSION__ === "undefined" ? packageJson.version : __T3CODE_BUILD_VERSION__;
