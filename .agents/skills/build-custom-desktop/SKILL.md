---
name: build-custom-desktop
description: Build and publish the custom T3 Code Windows and Linux desktop installers for Defmon3/t3code. Use when a maintainer asks to release the custom desktop build.
---

# Build and publish the custom desktop artifacts

This is an execution skill. When it is invoked, build both required artifacts, verify their updater
metadata, publish one GitHub Release, and report the release assets; do not stop at explaining the
commands.

## Always build the full application

Every custom release includes the full app and all integrated features. Before triggering the
release, ensure all completed changes requested for that release are committed on `custom-main`.
Preserve unrelated work. Never silently omit requested changes or ship a reduced build.

- Include the desktop shell, web client, server, native helpers, and required workers on both platforms.
- Include T3 Connect's public configuration in the built client and server. Require all four values:
  `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `T3CODE_RELAY_URL`. The custom workflow loads these from
  `.env.example`; a missing value must fail the build instead of disabling Connect.
- Include approval explanations in the server on both platforms. Gemini requests run directly
  in T3, with structured responses and thinking disabled; no separate worker is required.
- Preserve all integrated features and the custom updater configuration. Missing required
  configuration, dependencies, or bundled components must be fixed before publishing.
- Keep private API keys in encrypted environment settings, outside the published installers.

## Invocation

Read the invocation arguments as:

```text
[repository]
```

Do not ask for a version. Require the current checkout to be the `custom-main` branch and derive
the release version from the latest `apps/server/package.json` on that branch. The workflow strips
any upstream prerelease suffix, increments the patch component, and appends a UTC custom-build
stamp. The optional repository defaults to `Defmon3/t3code` and must be an `owner/repository` slug
when supplied. This release targets Windows x64 (`nsis`) and Linux x64 (`AppImage`).

## Trigger the release

Run from the repository root in the current checkout:

1. Confirm the current branch is `custom-main` and the optional repository is valid. Do not ask for
   a version.
2. Leave existing worktree changes intact. Do not reset, clean, stash, or switch branches.
3. Confirm `.github/workflows/custom-desktop-release.yml` is present in the current commit.
4. Confirm the current package version is valid SemVer:

   ```powershell
   git branch --show-current
   node -p "require('./apps/server/package.json').version"
   ```

   The workflow derives a new version from this package version and refuses malformed values.

5. Push the exact current commit to the fixed release-trigger branch. This push is the build trigger:

   ```powershell
   git push origin HEAD:refs/heads/custom-desktop-release
   ```

6. The workflow derives a new custom version, then runs Windows x64 (`nsis`) and Linux x64
   (`AppImage`) on native GitHub runners with
   `T3CODE_DESKTOP_UPDATE_REPOSITORY` set to the configured repository. It verifies the emitted
   manifests and publishes one GitHub Release only after both jobs pass.
7. Wait for the workflow run to complete. If either build or manifest validation fails, stop and
   return the failed job; do not create a partial release manually.

## Verify the result

After the workflow succeeds:

- Identify the newly published tag from the completed workflow and verify it with
  `gh release view <new-tag> --repo <repository>`.
- Confirm the assets include the Windows `.exe` and `.blockmap`, the Linux `.AppImage` and `.deb`,
  `latest.yml`, and `latest-linux.yml`.
- Confirm both manifests contain the requested version and reference their matching installers.
- Confirm both platform builds loaded T3 Connect's public configuration and include approval
  explanations in the server.
- Retain the previous installer and release for rollback.

If the build fails, return the command, exit status, and final error output. Do not claim an
installer or release was produced, and do not publish a partial release.
