---
name: build-custom-desktop
description: Build and publish the custom T3 Code Windows and Linux desktop installers for Defmon3/t3code. Use when a maintainer asks to release the custom desktop build.
---

# Build and publish the custom desktop artifacts

This is an execution skill. When it is invoked, build both required artifacts, verify their updater
metadata, publish one GitHub Release, and report the release assets; do not stop at explaining the
commands.

## Invocation

Read the invocation arguments as:

```text
<version> [repository]
```

Require an explicit version. Do not invent a version or infer one from the current date. The
optional repository defaults to `Defmon3/t3code` and must be an `owner/repository` slug when
supplied. This release targets Windows x64 (`nsis`) and Linux x64 (`AppImage`).

The version must be valid SemVer, must be higher than the previous custom release, and must not
reuse a published upstream version. Versions matching `X.Y.Z-nightly.YYYYMMDD.N` select the
nightly updater channel; other release versions select the stable channel.

## Build procedure

Run from the repository root in the current checkout:

1. Confirm the requested version and repository. If an argument is
   missing or malformed, stop and ask for the exact value.
2. Leave existing worktree changes intact. Do not reset, clean, stash, or switch branches.
3. Confirm the current commit is the same source for both platform builds.
4. Set `T3CODE_DESKTOP_UPDATE_REPOSITORY` and `T3CODE_DESKTOP_VERSION` for each build process only.
5. Write to `release/custom/<version>/<platform>-<arch>` so artifacts from another build are not
   mistaken for this build.
6. Build Windows x64 with the Windows host builder:

   ```powershell
   $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = "<repository>"
   $env:T3CODE_DESKTOP_VERSION = "<version>"

   node scripts/build-desktop-artifact.ts `
     --platform win `
     --target nsis `
     --arch x64 `
     --build-version <version> `
     --output-dir release/custom/<version>/win-x64 `
     --verbose
   ```

7. Build Linux x64 on a Linux host from the same commit. The repository builder intentionally
   rejects Linux packaging on Windows because the browser-secret helper links against Linux
   `libsecret`. Use the configured Linux build host or a native Linux CI runner; do not substitute a
   Windows cross-build.

   ```bash
   T3CODE_DESKTOP_UPDATE_REPOSITORY=<repository> \
   T3CODE_DESKTOP_VERSION=<version> \
   node scripts/build-desktop-artifact.ts \
     --platform linux \
     --target AppImage \
     --arch x64 \
     --build-version <version> \
     --output-dir release/custom/<version>/linux-x64 \
     --verbose
   ```

The builder uses `--publish never`; it creates installers and updater metadata but does not upload
anything itself. Do not publish until both platform builds finish from the same commit.

## Verify the result

After both builds succeed:

- List both output directories and report every emitted installer, manifest, and blockmap.
- Confirm the Windows output contains one `.exe`, its `.blockmap`, and the stable channel manifest.
- Confirm the Linux output contains an `.AppImage` and its channel manifest when emitted.
- Confirm every manifest names the requested version and its matching installer.
- Exclude `builder-debug.yml` from release assets.
- Publish one tag and release to the configured repository:

  ```powershell
  $repo = "<repository>"
  $tag = "v<version>"
  $assets = @(Get-ChildItem release/custom/<version> -File -Recurse |
    Where-Object { $_.Name -ne 'builder-debug.yml' })
  gh release create $tag --repo $repo --title "T3 Code <version>" `
    --notes "Custom Windows and Linux desktop build <version>." @($assets.FullName)
  ```

- If that tag already exists, stop and inspect it before uploading; never overwrite a published
  version with different bytes.
- Verify the release with `gh release view <tag> --repo <repository>` and retain the previous
  installer for rollback.

If the build fails, return the command, exit status, and final error output. Do not claim an
installer or release was produced, and do not publish a partial release.
