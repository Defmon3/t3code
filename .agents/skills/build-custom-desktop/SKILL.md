---
name: build-custom-desktop
description: Build the full custom T3 Code desktop application locally. Never use GitHub Actions or hosted runners.
---

# Build the custom desktop locally

Build Windows x64 NSIS and Linux x64 AppImage and DEB artifacts on this machine only.
Never trigger, enable, dispatch, rerun, or push to a branch that
triggers a GitHub Actions build. Never use hosted runners as a fallback. GitHub may store
published release assets, but it must not execute the build.

## Include the full application

- Include all completed, requested changes on `custom-main`. Preserve unrelated work.
- Include the desktop shell, web client, server, native helpers, and required workers.
- Load these public settings from `.env.example` into the build process, and fail if any is missing:
  `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `T3CODE_RELAY_URL`.
- Include direct Gemini approval explanations with structured responses and thinking disabled.
- Keep private API keys outside the installers. Preserve the custom updater configuration.

## Build

1. Read the current branch and working-tree status. Require `custom-main`. Never reset, clean,
   stash, or switch branches to build. Commit only completed, requested changes.
2. Read `apps/server/package.json`. Strip any prerelease suffix, increment its patch component,
   and append `-custom.<UTC yyyyMMddHHmmss>`. Do not ask for a version.
3. Use the repository-local Vite+ executable. Put `node_modules/.bin` on the build process PATH
   so nested commands use it too.
4. Load the four public settings. Set `T3CODE_DESKTOP_UPDATE_REPOSITORY=Defmon3/t3code`.
5. Create a version-specific output directory under `tmp/tmp_local_desktop_<version>` and capture
   build output there. Run the full native artifact build without `--skip-build`:

   ```powershell
   node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64 --build-version <version> --output-dir tmp/tmp_local_desktop_<version>/release --verbose
   ```

6. Resolve missing local prerequisites on this machine. Do not bypass validation or move the build
   to GitHub. Never stop another running build without the user's confirmation.
7. Linux artifacts require a Linux runtime on this machine. Use an installed local WSL distribution
   if it is prepared for the build, with checkout and build state isolated from the Windows build.
   Run the same artifact entry point with `--platform linux --target AppImage`. If no usable local
   Linux runtime exists, report the blocker. Never use another host or hosted runner without the
   user's explicit authorization.

## Verify and report

- Require the native artifact command to succeed, including packaged-payload validation.
- Verify the Windows `.exe`, `.blockmap`, and updater manifest contain the new version, and that
  the manifest references the emitted installer.
- For Linux artifacts, verify the `.AppImage`, `.deb`, and matching updater manifest.
- Confirm builds include the public configuration and approval explanations.
- Report the local installer path. Never claim a failed or unrun build succeeded.
- Do not install, restart the app, push, or publish unless the user requested that action.
- Preserve previous installers and releases for rollback.
