// @effect-diagnostics nodeBuiltinImport:off -- Exercises the same byte-for-byte restoration and archive files as the release runner.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import {
  customReleaseVersion,
  verifyReleaseAssets,
  withSavedReleaseManifests,
  writeReleaseChecksums,
} from "./build-custom-release.ts";
import { releasePackageFiles } from "./lib/tagged-source-version.ts";

const version = "0.1.19-custom.20261121010203";
const winZip = `t3-${version}-win32-x64.zip`;
const linuxTar = `t3-${version}-linux-x64.tar.gz`;
const appImage = "T3-Code-x86_64.AppImage";
const deb = `T3-Code-${version}-amd64.deb`;
const exe = `T3-Code-${version}-x64.exe`;

async function withFixture(test: (directory: string) => Promise<void>) {
  const tmp = NodeURL.fileURLToPath(new URL("../tmp", import.meta.url));
  await NodeFSP.mkdir(tmp, { recursive: true });
  const directory = await NodeFSP.mkdtemp(NodePath.join(tmp, "tmp_release_test_"));
  try {
    await test(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

function manifest(release: string, installers: readonly string[]) {
  return [
    `version: ${release}`,
    "files:",
    ...installers.flatMap((name) => [
      `  - url: ${name}`,
      "    sha512: hash",
      "    size: 1",
      ...(name.endsWith(".AppImage") ? ["    blockMapSize: 1"] : []),
    ]),
    "releaseDate: '2026-11-21T01:02:03.000Z'",
  ].join("\n");
}

it.each(["0.1.18", "0.1.18-nightly.20261120.2"])(
  "increments the patch of %s and uses UTC for the custom version",
  (base) => {
    expect(customReleaseVersion(base, DateTime.makeUnsafe("2026-11-20T20:02:03-05:00"))).toBe(
      version,
    );
  },
);

it("rejects a malformed source version before naming a release", () => {
  expect(() => customReleaseVersion("0.1", DateTime.makeUnsafe("2026-11-21T01:02:03Z"))).toThrow(
    /Invalid server package version/,
  );
});

it("restores all manifests byte for byte after a partial alignment fails", async () => {
  await withFixture(async (directory) => {
    const files = releasePackageFiles.map((name) => NodePath.join(directory, name));
    const originals = files.map((_, index) => `{ "version": "0.${index}.0" }\r\n`);
    await Promise.all(
      files.map(async (file, index) => {
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, originals[index] ?? "");
      }),
    );

    const failure = new Error("alignment failed");
    await expect(
      withSavedReleaseManifests(directory, async () => {
        await NodeFSP.writeFile(NodePath.join(directory, releasePackageFiles[0]), "{}\n");
        await NodeFSP.rm(NodePath.join(directory, releasePackageFiles[1]));
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await Promise.all(files.map((file) => NodeFSP.readFile(file, "utf8")))).toEqual(
      originals,
    );
  });
});

it("writes the SHA-256 of each archive under its exact release name", async () => {
  await withFixture(async (directory) => {
    await NodeFSP.writeFile(NodePath.join(directory, winZip), "abc");
    await NodeFSP.writeFile(NodePath.join(directory, linuxTar), "hello");

    await writeReleaseChecksums(directory, version);

    expect(await NodeFSP.readFile(NodePath.join(directory, "SHA256SUMS"), "utf8")).toBe(
      `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  ${winZip}\n` +
        `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  ${linuxTar}\n`,
    );
  });
});

it("fails checksum generation if either CLI archive is missing", async () => {
  await withFixture(async (directory) => {
    await NodeFSP.writeFile(NodePath.join(directory, winZip), "abc");

    await expect(writeReleaseChecksums(directory, version)).rejects.toThrow(/ENOENT/);
    await expect(NodeFSP.readFile(NodePath.join(directory, "SHA256SUMS"))).rejects.toThrow(
      /ENOENT/,
    );
  });
});

it("verifies the emitted Windows installer and both Linux installers", async () => {
  await withFixture(async (directory) => {
    for (const name of [exe, `${exe}.blockmap`, winZip, appImage, deb, linuxTar]) {
      await NodeFSP.writeFile(NodePath.join(directory, name), "x");
    }
    await NodeFSP.writeFile(NodePath.join(directory, "latest.yml"), manifest(version, [exe]));
    await NodeFSP.writeFile(
      NodePath.join(directory, "latest-linux.yml"),
      manifest(version, [appImage, deb]),
    );

    await expect(verifyReleaseAssets(directory, version, "win")).resolves.toBeUndefined();
    await expect(verifyReleaseAssets(directory, version, "linux")).resolves.toBeUndefined();
  });
});

it.each([
  ["another version", "0.1.18", [appImage, deb]],
  ["another installer", version, [appImage, "wrong.deb"]],
  ["only one Linux installer", version, [appImage]],
] as const)("rejects a manifest listing %s", async (_case, release, names) => {
  await withFixture(async (directory) => {
    for (const name of [appImage, deb, linuxTar])
      await NodeFSP.writeFile(NodePath.join(directory, name), "x");
    await NodeFSP.writeFile(NodePath.join(directory, "latest-linux.yml"), manifest(release, names));

    await expect(verifyReleaseAssets(directory, version, "linux")).rejects.toThrow(
      /latest-linux\.yml must list/,
    );
  });
});
