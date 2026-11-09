import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "../HostProcess.ts";

const fileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* path.fromFileUrl(new URL("../../../../tmp/", import.meta.url));
    yield* fs.makeDirectory(directory, { recursive: true });
    const toPosix = (value: string) =>
      HostProcess.Platform.defaultValue() === "win32"
        ? value.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "")
        : value;
    return FileSystem.FileSystem.of({
      ...fs,
      makeTempDirectoryScoped: (options) =>
        fs
          .makeTempDirectoryScoped({ ...options, directory, prefix: "tmp_posix_" })
          .pipe(Effect.map(toPosix)),
      readLink: (target) => fs.readLink(target).pipe(Effect.map(toPosix)),
      realPath: (target) => fs.realPath(target).pipe(Effect.map(toPosix)),
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

// why: POSIX PATH entries cannot contain Windows drive colons or backslashes.
export const layer = Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, fileSystem);
