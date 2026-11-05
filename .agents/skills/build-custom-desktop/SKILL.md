---
name: build-custom-desktop
description: Build the full custom T3 Code desktop application locally. Never use GitHub Actions or hosted runners.
---

# Build the custom desktop locally

Build Windows x64 NSIS and Linux x64 AppImage and DEB artifacts on this machine only.
Never trigger, enable, dispatch, rerun, or push to a branch that
triggers a GitHub Actions build. Never use hosted runners as a fallback. GitHub may store
published release assets, but it must not execute the build.

## Definition of done

This skill is not complete when local files exist. It is complete only when all of these
steps have succeeded:

1. Windows and Linux desktop artifacts build locally.
2. Windows and Linux CLI archives build locally and report the requested version.
3. Both updater manifests and `SHA256SUMS` are verified.
4. One stable GitHub release on `Defmon3/t3code` contains the nine required assets.
5. `gh release view` shows that release as published and non-draft.

If the release does not exist, the updater has nothing to see. Do not report success after
the local build alone.

## Prerequisite failure rule

When a command reports that a tool is missing, stop and inspect the machine before declaring
the prerequisite absent. Check the repository-local binaries, `C:\Users\defmon3\.cargo\bin`,
Visual Studio and `vswhere`, WSL, and the cached Linux Node runtime. A tool installed outside
the inherited build `PATH` is available once its real path is prepended. Fix the build `PATH`
and retry before changing dependencies, installing software, or reporting a blocker.

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

   The release must also contain self-contained Windows and Linux CLI archives for `t3 update`
   and background-service hosts. Build both from the same source and version after the desktop
   artifact succeeds. Use the Node version required by `package.json` in each build environment.
   Before each CLI executable build, save the original release manifest contents and align versions
   with `node scripts/update-release-package-versions.ts <version>`. Restore the saved contents
   after the build, including on failure; the executable embeds the server manifest's version.
   Run the Windows commands on Windows x64:

   ```powershell
   vp run --filter t3 build:exe
   $resourceMonitorDir = "tmp/tmp_local_desktop_<version>/tmp_windows_resource_monitor"
   New-Item -ItemType Directory -Path $resourceMonitorDir -Force | Out-Null
   Copy-Item -LiteralPath native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe -Destination $resourceMonitorDir
   node scripts/build-cli-archive.ts --platform win --arch x64 --version <version> --output-dir tmp/tmp_local_desktop_<version>/release --resource-monitor-dir $resourceMonitorDir
   ```

   Run the Linux commands in the isolated local Linux build environment from step 7, using its
   repository-local Vite+ and writing the archive into the shared release directory:

   ```bash
   vp run --filter t3 build:exe
   resource_monitor_dir="tmp/tmp_local_desktop_<version>/tmp_linux_resource_monitor"
   mkdir -p "$resource_monitor_dir"
   cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor "$resource_monitor_dir/"
   node scripts/build-cli-archive.ts --platform linux --arch x64 --version <version> --output-dir tmp/tmp_local_desktop_<version>/release --resource-monitor-dir "$resource_monitor_dir"
   ```

   After both archives succeed, write both checksum entries from Windows PowerShell:

   ```powershell
   $archives = Get-Item -LiteralPath "tmp/tmp_local_desktop_<version>/release/t3-<version>-win32-x64.zip", "tmp/tmp_local_desktop_<version>/release/t3-<version>-linux-x64.tar.gz" -ErrorAction Stop
   $archives | ForEach-Object { "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)" } | Set-Content tmp/tmp_local_desktop_<version>/release/SHA256SUMS
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
- Require `t3-<version>-win32-x64.zip`, `t3-<version>-linux-x64.tar.gz`, and `SHA256SUMS` with
  one SHA-256 entry for each archive; `t3 update` and background-service hosts use these assets.
- Require both CLI build and archive commands to succeed. Extract each archive into an isolated
  temporary directory and run its CLI with `--version` on the matching local operating system.
  Require the release version before reporting that platform's CLI archive as verified.
- For Linux artifacts, verify the `.AppImage`, `.deb`, and matching updater manifest.
- Confirm builds include the public configuration and approval explanations.
- Report the local installer path. Never claim a failed or unrun build succeeded.
- Publish the finished installers, updater manifests, both CLI archives, and `SHA256SUMS` as one
  GitHub Release after all local builds and archive checks pass. Upload existing files only;
  never trigger a hosted build. Exclude `builder-debug.yml`.
- Push only the version tag needed for that release. Then create the stable release and verify it
  with `gh release view --repo Defmon3/t3code <tag>`. Require `isDraft: false`, `isPrerelease: false`,
  and all nine expected assets before reporting completion.
- Do not install, restart the app, or push source unless the user requested that action.
- Preserve previous installers and releases for rollback.
