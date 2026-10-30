# Custom desktop builds

This page is for maintainers of the custom `Defmon3/t3code` distribution. The upstream release
runbook in `docs/operations/release.md` describes `pingdotgg/t3code`; use this page when the
desktop build must update from our repository instead.

## What the updater supports

The desktop updater uses `electron-updater` with a GitHub Releases feed. The repository is written
into the packaged updater configuration while the desktop artifact is built:

```powershell
$env:T3CODE_DESKTOP_UPDATE_REPOSITORY = "Defmon3/t3code"
```

`T3CODE_DESKTOP_UPDATE_REPOSITORY` takes an `owner/repository` slug. If it is absent, the build
script falls back to `GITHUB_REPOSITORY`. Set the custom repository explicitly for local builds.
The build command always passes `--publish never`, so the build creates the installer and updater
metadata but does not upload anything. Publishing is a separate release step.

An installed app cannot be repointed by changing a setting. The feed is read from
`resources/app-update.yml`. An existing install without that file must be replaced with an
installer built with the custom repository configured.

The current production build supports GitHub Releases only. The generic provider is used only by
the local mock-update path; setting a generic HTTP URL requires a separate code change.

## Build a custom release

The `$build-custom-desktop` skill derives a valid, increasing custom version from the latest
`custom-main` package version. The manual commands below are a fallback and require setting
`T3CODE_DESKTOP_VERSION` yourself. Stable versions use the stable feed; versions matching
`X.Y.Z-nightly.YYYYMMDD.N` use the nightly feed.

The project skill `$build-custom-desktop` reads the latest `custom-main` checkout, derives the next
custom version from its package version, and builds the full application on this machine.
It never triggers GitHub Actions. Invoke it without a version:

```text
$build-custom-desktop
```

It embeds the custom updater repository and does not install the result on a host.

From the repository root, build the target platform locally:

```powershell
$env:T3CODE_DESKTOP_UPDATE_REPOSITORY = "Defmon3/t3code"
$env:T3CODE_DESKTOP_VERSION = "0.1.4-custom.20261026.1"

# Choose the target needed for this release.
vp run dist:desktop:win
vp run dist:desktop:linux
vp run dist:desktop:dmg
```

The artifacts are written to `release/`. Build each architecture separately when the release must
serve more than one architecture. A local release should either publish one architecture per
release or merge per-architecture manifests before
uploading a shared manifest.

Before publishing, inspect the output and keep only release payloads:

```powershell
Get-ChildItem release -File |
  Where-Object { $_.Extension -in '.exe', '.dmg', '.zip', '.AppImage', '.deb', '.yml', '.blockmap' }
```

Do not upload `builder-debug.yml`. For a non-preview build, the updater assets are:

- Windows: `.exe`, the channel manifest (`latest.yml` or `nightly.yml`), and `.blockmap` files.
- Linux: `.AppImage` and `.deb` packages, the matching channel manifests, and `.blockmap` files.
- macOS: `.dmg`, `.zip`, the matching macOS manifest, and `.blockmap` files.

## Publish to our GitHub repository

Create a release whose tag identifies the exact package version, then upload the files from
`release/`. The token used by `gh` needs permission to create releases and upload assets to the
custom repository.

```powershell
$repo = "Defmon3/t3code"
$version = $env:T3CODE_DESKTOP_VERSION
$tag = "v$version"
$assets = @(Get-ChildItem release -File |
  Where-Object { $_.Name -ne 'builder-debug.yml' }
)

gh release create $tag --repo $repo --title "T3 Code $version" --notes "Custom desktop build $version" @($assets.FullName)
```

If the release already exists and only an asset needs to be replaced, use an explicit upload:

```powershell
$uploadAssets = @(Get-ChildItem release -File |
  Where-Object { $_.Extension -in '.exe', '.yml', '.blockmap' -and $_.Name -ne 'builder-debug.yml' }
)
gh release upload $tag --repo $repo --clobber @($uploadAssets.FullName)
```

Keep the release channel consistent with the version. Stable clients look for `latest*.yml`;
nightly clients look for `nightly*.yml`. The manifest and every referenced installer must be in the
same GitHub Release. Never reuse a published version for different bytes. Publish a new, higher
version when a build changes.

## Repoint an existing installation

1. Build a replacement installer with `T3CODE_DESKTOP_UPDATE_REPOSITORY` set to `Defmon3/t3code`.
2. Install that replacement over the existing custom installation.
3. Confirm the installed app contains `resources/app-update.yml`. On Windows the usual path is:

   ```text
   %LOCALAPPDATA%\Programs\t3code\resources\app-update.yml
   ```

4. Confirm the file names our repository and the intended channel, then publish a higher custom
   version with its manifest and assets.
5. In the desktop app, use **Check for updates**. The app checks in the background, does not
   download automatically, and requires a second action after download to restart and install.

The Alpha and Omega installers built before this repository was configured have no
`resources/app-update.yml`; they cannot self-update until step 2 is completed.

## Rollback

Keep the previous known-good installer and its GitHub Release. If a published build is faulty,
publish a corrected build with the next higher custom version so clients can move forward. Do not
overwrite the faulty version or reuse its tag. For a machine that already installed the faulty
build, stop the desktop app and install the retained previous installer manually, then publish the
corrected higher version before enabling normal update checks again.

For every release, record the exact version, repository, channel, platforms, and the retained
rollback installer in the release notes or the deployment record. Do not delete the previous good
release until the newer build has passed a real-data dev-server smoke test and has been installed
on one canary machine.

## Verification checklist

- `release/` contains the expected installer, channel manifest, and blockmaps.
- The installed app contains `resources/app-update.yml` and names `Defmon3/t3code`.
- `gh release view v<version> --repo Defmon3/t3code` shows every asset referenced by the manifest.
- A canary install reports the custom build marker and can find a deliberately higher custom
  release through **Check for updates**.
- Keep the previous installer available and record the rollback version before wider deployment.

The implementation points for this behavior are
`scripts/build-desktop-artifact.ts`, `apps/desktop/src/updates/DesktopUpdates.ts`, and
`apps/desktop/src/electron/ElectronUpdater.ts`.
