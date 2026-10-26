---
name: build-custom-desktop
description: Build a custom T3 Code desktop installer for Defmon3/t3code with embedded updater metadata. Use when a maintainer asks to build the Windows, Linux, or macOS custom desktop artifact.
---

# Build the custom desktop artifact

This is an execution skill. When it is invoked, run the build and report the emitted artifact
paths; do not stop at explaining the command.

## Invocation

Read the invocation arguments as:

```text
<platform> <arch> <version> [repository]
```

Supported values are:

- `win x64` or `win arm64`; target `nsis`.
- `linux x64` or `linux arm64`; target `AppImage`.
- `mac x64`, `mac arm64`, or `mac universal`; target `dmg`.

Require an explicit platform, architecture, and version. Do not invent a version or infer one from
the current date. The optional repository defaults to `Defmon3/t3code` and must be an
`owner/repository` slug when supplied.

The version must be valid SemVer, must be higher than the previous custom release, and must not
reuse a published upstream version. Versions matching `X.Y.Z-nightly.YYYYMMDD.N` select the
nightly updater channel; other release versions select the stable channel.

## Build procedure

Run from the repository root in the current checkout:

1. Confirm the requested platform, architecture, version, and repository. If an argument is
   missing or malformed, stop and ask for the exact value.
2. Leave existing worktree changes intact. Do not reset, clean, stash, or switch branches.
3. Set `T3CODE_DESKTOP_UPDATE_REPOSITORY` and `T3CODE_DESKTOP_VERSION` for this process only.
4. Choose the target from the platform table above.
5. Write to `release/custom/<version>/<platform>-<arch>` so artifacts from another build are not
   mistaken for this build.
6. Execute the builder directly:

   ```powershell
   $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = "<repository>"
   $env:T3CODE_DESKTOP_VERSION = "<version>"

   node scripts/build-desktop-artifact.ts `
     --platform <platform> `
     --target <target> `
     --arch <arch> `
     --build-version <version> `
     --output-dir release/custom/<version>/<platform>-<arch> `
     --verbose
   ```

The builder uses `--publish never`. It creates the installer and updater metadata but never creates
a GitHub Release or uploads assets. Use [custom-builds](../../../docs/operations/custom-builds.md)
for the separately authorized publishing step.

## Verify the result

After a successful command:

- List the output directory and report every emitted installer, manifest, and blockmap.
- Confirm the output contains the requested platform artifact and does not include
  `builder-debug.yml` as a release asset.
- Report the exact output directory and the configured updater repository.
- Do not install the artifact, publish it, SSH to another host, or delete older release artifacts
  unless the invoking request explicitly asks for that separate action.

If the build fails, return the command, exit status, and final error output. Do not claim an
installer was produced.
