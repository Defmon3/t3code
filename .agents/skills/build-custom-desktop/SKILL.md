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

## Trigger the release

Run from the repository root in the current checkout:

1. Confirm the requested version and repository. If an argument is missing or malformed, stop and
   ask for the exact value.
2. Leave existing worktree changes intact. Do not reset, clean, stash, or switch branches.
3. Confirm `.github/workflows/custom-desktop-release.yml` is present in the current commit.
4. Confirm the release tag and branch do not already exist:

   ```powershell
   gh release view "v<version>" --repo <repository>
   git ls-remote --exit-code --heads origin "custom-build-release/<version>"
   ```

   Both commands must report that the target is absent. Never overwrite a published version.

5. Push the exact current commit to the versioned release branch. This push is the build trigger:

   ```powershell
   git push origin HEAD:refs/heads/custom-build-release/<version>
   ```

6. The workflow runs Windows x64 (`nsis`) and Linux x64 (`AppImage`) on native GitHub runners with
   `T3CODE_DESKTOP_UPDATE_REPOSITORY` set to the configured repository. It verifies the emitted
   manifests and publishes one GitHub Release only after both jobs pass.
7. Wait for the workflow run to complete. If either build or manifest validation fails, stop and
   return the failed job; do not create a partial release manually.

## Verify the result

After the workflow succeeds:

- Verify the release with `gh release view v<version> --repo <repository>`.
- Confirm the assets include the Windows `.exe` and `.blockmap`, the Linux `.AppImage` and `.deb`,
  `latest.yml`, and `latest-linux.yml`.
- Confirm both manifests contain the requested version and reference their matching installers.
- Retain the previous installer and release for rollback.

If the build fails, return the command, exit status, and final error output. Do not claim an
installer or release was produced, and do not publish a partial release.
