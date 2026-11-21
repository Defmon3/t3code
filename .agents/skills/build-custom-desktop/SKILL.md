---
name: build-custom-desktop
description: Build and publish the custom T3 Code desktop and CLI release on our own machines. Never use GitHub Actions or hosted runners.
---

# Build the custom desktop release

From a clean `custom-main` checkout on Windows x64 with the repository's Node version and workspace dependencies installed, run:

```powershell
node scripts/build-custom-release.ts
```

The runner builds Windows on this machine and Linux in Docker on `notrory`. Use
`node scripts/build-custom-release.ts --linux-host hotel` to build Linux on `hotel`.
Use only these machines. Never trigger, enable, dispatch, or rerun GitHub Actions.

On failure, read the named step log under `tmp/tmp_local_desktop_<version>/`,
fix the cause, and rerun the same command. For a missing prerequisite, inspect
the repository-local binaries, Cargo, Visual Studio, and `vswhere` before installing
anything. Do not reset, clean, stash, or switch branches, or stop another build.

The runner publishes only the version tag and the nine verified assets to one
stable release on `Defmon3/t3code`. Completion requires successful release
verification. Report the printed installer paths and release URL. Preserve
previous installers and releases for rollback. Keep private keys outside
installers. Never push a branch, install the build, or restart the app as part of
this workflow.
