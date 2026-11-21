// @effect-diagnostics nodeBuiltinImport:off -- Release commands share log descriptors and stop their OS process trees on failure.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import workspace from "../package.json" with { type: "json" };
import { releasePackageFiles } from "./lib/tagged-source-version.ts";
import { parseUpdateManifest } from "./lib/update-manifest.ts";
import { windowsSystemTar } from "./lib/windows-tar.ts";

const repository = "Defmon3/t3code";
const sourceBranch = "custom-main";
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const nodeVersion = workspace.engines.node;
const hostPlatform = Effect.runSync(HostProcess.Platform);
const hostArch = Effect.runSync(HostProcess.Architecture);
const linuxImage =
  "node:26.12.1-bookworm@sha256:3b764117159bda01d2396391e7789b6a9106af9729cfd001ef55e98557868310";
const publicKeys = [
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_RELAY_URL",
] as const;

type Platform = "win" | "linux";
type LinuxHost = "notrory" | "hotel";

export function customReleaseVersion(base: string, now: DateTime.DateTime): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/.exec(base);
  if (!match?.[3]) throw new Error(`Invalid server package version: ${base}`);
  const timestamp = DateTime.formatIso(now).slice(0, 19).replace(/\D/g, "");
  return `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}-custom.${timestamp}`;
}

export async function withSavedReleaseManifests<T>(repo: string, build: () => Promise<T>) {
  const files = await Promise.all(
    releasePackageFiles.map(async (relativePath) => {
      const file = NodePath.join(repo, relativePath);
      return { file, original: await NodeFSP.readFile(file) };
    }),
  );
  try {
    return await build();
  } finally {
    await Promise.allSettled(
      files.map(async ({ file, original }) => {
        const current = await NodeFSP.readFile(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!current?.equals(original)) await NodeFSP.writeFile(file, original);
      }),
    ).then((restored) => {
      const failures = restored.flatMap((result) =>
        result.status === "rejected" ? [String(result.reason)] : [],
      );
      if (failures.length)
        throw new Error(`Could not restore release manifests: ${failures.join("; ")}`);
    });
  }
}

function releaseFiles(version: string) {
  const windowsInstaller = `T3-Code-${version}-x64.exe`;
  return {
    win: {
      manifest: "latest.yml",
      installers: [windowsInstaller],
      other: [`${windowsInstaller}.blockmap`],
      archive: `t3-${version}-win32-x64.zip`,
    },
    linux: {
      manifest: "latest-linux.yml",
      installers: ["T3-Code-x86_64.AppImage", `T3-Code-${version}-amd64.deb`],
      other: [],
      archive: `t3-${version}-linux-x64.tar.gz`,
    },
  };
}

function platformAssets(files: ReturnType<typeof releaseFiles>[Platform]) {
  return [files.manifest, ...files.installers, ...files.other, files.archive];
}

export async function writeReleaseChecksums(directory: string, version: string) {
  const { win, linux } = releaseFiles(version);
  const lines = await Promise.all(
    [win.archive, linux.archive].map(async (name) => {
      const hash = NodeCrypto.createHash("sha256");
      for await (const chunk of NodeFS.createReadStream(NodePath.join(directory, name)))
        hash.update(chunk);
      return `${hash.digest("hex")}  ${name}\n`;
    }),
  );
  await NodeFSP.writeFile(NodePath.join(directory, "SHA256SUMS"), lines.join(""));
}

export async function verifyReleaseAssets(directory: string, version: string, platform: Platform) {
  const files = releaseFiles(version)[platform];
  for (const name of platformAssets(files)) {
    const file = await NodeFSP.stat(NodePath.join(directory, name));
    if (!file.isFile() || file.size === 0)
      throw new Error(`Expected a nonempty release file: ${name}`);
  }
  const raw = await NodeFSP.readFile(NodePath.join(directory, files.manifest), "utf8");
  const manifest = parseUpdateManifest(raw, files.manifest, platform);
  const referenced = manifest.files.map(({ url }) => url);
  if (
    manifest.version !== version ||
    referenced.length !== files.installers.length ||
    !files.installers.every((name) => referenced.includes(name))
  ) {
    throw new Error(
      `${files.manifest} must list version ${version} and ${files.installers.join(", ")}`,
    );
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly minutes: number;
    readonly output: number;
    readonly capture?: boolean;
  },
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = hostPlatform === "win32";
    const child = NodeChildProcess.spawn(command, args, {
      cwd: root,
      env: options.env,
      detached: !windows,
      windowsHide: true,
      stdio: ["ignore", options.capture ? "pipe" : options.output, options.output],
    });
    let stdout = "";
    let interruption: Error | undefined;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    const stop = (error: Error) => {
      interruption = error;
      if (child.pid === undefined) return;
      if (windows) {
        const killed = NodeChildProcess.spawnSync(
          "taskkill.exe",
          ["/T", "/F", "/PID", String(child.pid)],
          {
            timeout: 10 * 60_000,
            stdio: ["ignore", options.output, options.output],
            windowsHide: true,
          },
        );
        if (killed.status !== 0) child.kill("SIGKILL");
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (cause) {
          if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ESRCH") {
            interruption = new Error(`Could not stop ${command}: ${String(cause)}`, {
              cause: error,
            });
          }
        }
      }
    };
    const abort = () => stop(new Error("Cancelled after another release step failed"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const deadline = AbortSignal.timeout(options.minutes * 60_000);
    const timeout = () => stop(new Error(`${command} timed out after ${options.minutes} minutes`));
    deadline.addEventListener("abort", timeout, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      deadline.removeEventListener("abort", timeout);
      options.signal?.removeEventListener("abort", abort);
      if (interruption) reject(interruption);
      else if (code !== 0) {
        const detail = stdout.trim();
        reject(new Error(`${command} exited with ${signal ?? code}${detail ? `: ${detail}` : ""}`));
      } else resolve(stdout.trim());
    });
  });
}

type ReleaseCommand = (
  command: string,
  args: readonly string[],
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly minutes?: number;
    readonly capture?: boolean;
  },
) => Promise<string>;

function releaseSteps(directory: string | undefined, signal?: AbortSignal) {
  return async function step<T>(
    name: string,
    action: (run: ReleaseCommand) => Promise<T>,
    cleanup = false,
  ): Promise<T> {
    const logPath = directory && NodePath.join(directory, `${name}.log`);
    const output = logPath ? NodeFS.openSync(logPath, "a") : 1;
    const log = (message: string) => NodeFS.writeSync(output, `${message}\n`);
    const run: ReleaseCommand = async (command, args, options) => {
      log(`> ${command} ${args.join(" ")}`);
      const result = await runCommand(command, args, {
        output,
        ...(!cleanup && signal ? { signal } : {}),
        ...options,
        minutes: options?.minutes ?? 20,
      });
      if (result) log(result);
      return result;
    };
    try {
      if (!cleanup) signal?.throwIfAborted();
      process.stdout.write(`${logPath ? `${name}: ${logPath}` : name}\n`);
      return await action(run);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      log(detail);
      throw new Error(`${name} failed: ${detail}${logPath ? ` (log: ${logPath})` : ""}`, { cause });
    } finally {
      if (logPath) NodeFS.closeSync(output);
    }
  };
}

async function buildEnvironment() {
  const parsed = NodeUtil.parseEnv(
    await NodeFSP.readFile(NodePath.join(root, ".env.example"), "utf8"),
  );
  const publicEnv = Object.fromEntries(
    publicKeys.map((key) => {
      const value = parsed[key]?.trim();
      if (!value) throw new Error(`Missing ${key} in .env.example`);
      return [key, value];
    }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  return {
    ...env,
    ...publicEnv,
    PATH: [NodePath.join(root, "node_modules", ".bin"), process.env.PATH].join(NodePath.delimiter),
    T3CODE_DESKTOP_UPDATE_REPOSITORY: repository,
    T3CODE_DESKTOP_SKIP_BUILD: "false",
    T3CODE_DESKTOP_KEEP_STAGE: "false",
    T3CODE_DESKTOP_MOCK_UPDATES: "false",
    T3CODE_FEATURE_SECRETS: "",
    ...(hostPlatform === "linux" ? { RAYON_NUM_THREADS: "4" } : {}),
  };
}

async function verifyBuiltBundles(env: NodeJS.ProcessEnv) {
  const server = NodePath.join(root, "apps/server/dist");
  const client = NodePath.join(server, "client/assets");
  const missing = new Map(publicKeys.map((key) => [key, JSON.stringify(env[key])]));
  for (const name of await NodeFSP.readdir(client)) {
    if (!name.endsWith(".js")) continue;
    const js = await NodeFSP.readFile(NodePath.join(client, name), "utf8");
    for (const [key, value] of missing) {
      if (value && js.includes(value.slice(1, -1))) missing.delete(key);
    }
    if (!missing.size) break;
  }
  if (missing.size)
    throw new Error(
      `Public settings missing from the bundled web client: ${[...missing.keys()].join(", ")}`,
    );

  for (const name of await NodeFSP.readdir(server)) {
    if (!name.endsWith(".mjs")) continue;
    const js = await NodeFSP.readFile(NodePath.join(server, name), "utf8");
    if (
      js.includes(":generateContent") &&
      /thinkingBudget\s*:\s*0\b/.test(js) &&
      /responseMimeType\s*:\s*["']application\/json["']/.test(js) &&
      js.includes("responseJsonSchema")
    )
      return;
  }
  throw new Error(
    "The server bundle is missing structured Gemini approval explanations with thinking disabled",
  );
}

async function buildPlatform(
  platform: Platform,
  version: string,
  directory: string,
  step: ReturnType<typeof releaseSteps>,
) {
  const env = await step(`${platform}-environment`, buildEnvironment);
  const output = NodePath.join(directory, "release");
  const windows = platform === "win";
  const target = windows ? "nsis" : "AppImage";
  const files = releaseFiles(version)[platform];
  await step(`${platform}-desktop`, (run) =>
    withSavedReleaseManifests(root, () =>
      run(
        process.execPath,
        [
          "scripts/build-desktop-artifact.ts",
          "--platform",
          platform,
          "--target",
          target,
          "--arch",
          "x64",
          "--build-version",
          version,
          "--output-dir",
          output,
          "--verbose",
        ],
        { env, minutes: 90 },
      ),
    ),
  );
  await step(`${platform}-verify-bundles`, () => verifyBuiltBundles(env));
  await step(`${platform}-cli`, (run) =>
    withSavedReleaseManifests(root, async () => {
      await run(process.execPath, ["scripts/update-release-package-versions.ts", version], { env });
      await run(
        process.execPath,
        ["node_modules/vite-plus/bin/vp", "run", "--filter", "t3", "build:exe"],
        {
          env,
          minutes: 60,
        },
      );
      const resourceMonitor = NodePath.join(directory, `tmp_${platform}_resource_monitor`);
      const triple = windows ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
      const executable = windows ? "t3-resource-monitor.exe" : "t3-resource-monitor";
      await NodeFSP.mkdir(resourceMonitor);
      await NodeFSP.copyFile(
        NodePath.join(root, "native/resource-monitor/target", triple, "release", executable),
        NodePath.join(resourceMonitor, executable),
      );
      await run(
        process.execPath,
        [
          "scripts/build-cli-archive.ts",
          "--platform",
          platform,
          "--arch",
          "x64",
          "--version",
          version,
          "--output-dir",
          output,
          "--resource-monitor-dir",
          resourceMonitor,
        ],
        { env, minutes: 45 },
      );
    }),
  );
  await step(`${platform}-verify-artifacts`, () => verifyReleaseAssets(output, version, platform));
  await step(`${platform}-verify-cli`, (run) =>
    run(
      process.execPath,
      [
        "scripts/smoke-cli-archive.ts",
        "--archive",
        NodePath.join(output, files.archive),
        "--expect-version",
        version,
        "--version-only",
      ],
      { env },
    ),
  );
}

const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
  "-o",
  "ForwardAgent=no",
];

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

const linuxPreflight = `
set -eu
[ "$(uname -sm)" = 'Linux x86_64' ] || { echo "Linux x86_64 is required" >&2; exit 1; }
check_space() {
  free=$(df -Pk "$1" | awk 'NR == 2 {print $4}')
  if [ "$free" -lt "$(($2 * 1024 * 1024))" ]; then
    echo "Insufficient space on $1: $free KiB available, need $2 GiB" >&2
    exit 1
  fi
  echo "$1 has $free KiB free"
}
docker_root=$(docker info --format '{{.DockerRootDir}}')
if [ "$(stat -c %d /var/tmp)" = "$(stat -c %d "$docker_root")" ]; then
  check_space /var/tmp 20
else
  check_space /var/tmp 4
  check_space "$docker_root" 16
fi
`;

const linuxBootstrap = `
set -eu
export DEBIAN_FRONTEND=noninteractive
export PATH=/root/.cargo/bin:$PATH
sed -i 's|http://deb.debian.org/debian$|https://snapshot.debian.org/archive/debian/20261120T000000Z/|; s|http://deb.debian.org/debian-security$|https://snapshot.debian.org/archive/debian-security/20261120T000000Z/|' /etc/apt/sources.list.d/debian.sources
timeout -k 60s 20m apt-get -o Acquire::Check-Valid-Until=false update
timeout -k 60s 30m apt-get install -y --no-install-recommends build-essential fakeroot imagemagick libatomic1 libsecret-1-dev patchelf pkg-config python3
timeout -k 60s 20m curl -fsSLo /tmp/rustup-init https://static.rust-lang.org/rustup/archive/1.29.0/x86_64-unknown-linux-gnu/rustup-init
chmod +x /tmp/rustup-init
timeout -k 60s 20m /tmp/rustup-init -y --profile minimal --default-toolchain 1.99.1
mkdir /source /build
cd /source
timeout -k 60s 20m tar --no-same-owner -xf /transfer/source.tar
timeout -k 60s 20m git restore --source=HEAD --staged --worktree -- .
[ "$(git rev-parse HEAD)" = "$RELEASE_COMMIT" ] || { echo "Unexpected source commit" >&2; exit 1; }
manager=$(node -p 'require("./package.json").packageManager')
timeout -k 60s 20m npm install --global --no-audit --no-fund "$manager"
timeout -k 60s 40m pnpm install --frozen-lockfile
exec node --input-type=module -e 'import { buildLinuxRelease } from "./scripts/build-custom-release.ts"; await buildLinuxRelease(process.env.RELEASE_VERSION);'
`;

export async function buildLinuxRelease(version: string | undefined) {
  if (hostPlatform !== "linux" || hostArch !== "x64" || process.versions.node !== nodeVersion) {
    throw new Error(`Linux release worker requires Linux x64 and Node ${nodeVersion}`);
  }
  if (!version || !/^\d+\.\d+\.\d+-custom\.\d{14}$/.test(version)) {
    throw new Error("Missing or invalid Linux release version");
  }
  const step = releaseSteps(undefined);
  await buildPlatform("linux", version, "/build", step);
  await step("linux-stage-assets", async () => {
    for (const name of platformAssets(releaseFiles(version).linux)) {
      await NodeFSP.copyFile(
        NodePath.join("/build/release", name),
        NodePath.join("/transfer", name),
      );
    }
  });
}

async function buildOverSsh(
  host: LinuxHost,
  version: string,
  commit: string,
  directory: string,
  step: ReturnType<typeof releaseSteps>,
) {
  const container = `t3-custom-release-${NodeCrypto.randomUUID()}`;
  const remote = `/var/tmp/${container}`;
  const ssh = (command: string) => [...sshOptions, "-o", "ClearAllForwardings=yes", host, command];
  const snapshot = NodePath.join(directory, "tmp_snapshot");
  const source = NodePath.join(directory, "tmp_source.tar");
  await step("linux-source", async (run) => {
    await run(
      "git",
      [
        "clone",
        "--no-local",
        "--no-checkout",
        "--depth=1",
        "--single-branch",
        "--branch",
        sourceBranch,
        "--no-tags",
        root,
        snapshot,
      ],
      // why: git refuses to clone a repo whose config sets core.hooksPath; the source is this checkout.
      { env: { ...process.env, GIT_CLONE_PROTECTION_ACTIVE: "false" } },
    );
    if ((await run("git", ["-C", snapshot, "rev-parse", "HEAD"], { capture: true })) !== commit) {
      throw new Error("custom-main moved before the Linux snapshot was created");
    }
    await run(windowsSystemTar(), ["-cf", source, "-C", snapshot, ".git"]);
  });
  await step("linux-create-workspace", (run) => run("ssh", ssh(`umask 077 && mkdir ${remote}`)));
  let buildError: unknown;
  try {
    await step("linux-upload-source", (run) =>
      run("scp", [...sshOptions, source, `${host}:${remote}/source.tar`]),
    );
    await step("linux-pull-image", (run) =>
      run("ssh", ssh(`timeout -k 60s 29m docker pull --platform linux/amd64 ${linuxImage}`), {
        minutes: 30,
      }),
    );
    const dockerArgs = [
      "docker",
      "run",
      "--rm",
      "--init",
      "--pull=never",
      "--platform",
      "linux/amd64",
      "--name",
      container,
      "--mount",
      `type=bind,src=${remote},dst=/transfer`,
      "--env",
      `RELEASE_VERSION=${version}`,
      "--env",
      `RELEASE_COMMIT=${commit}`,
      linuxImage,
      "bash",
      "-c",
      linuxBootstrap.trim(),
    ];
    await step("linux-build", (run) =>
      run("ssh", ssh(`exec ${dockerArgs.map(shellQuote).join(" ")}`), {
        minutes: 260,
      }),
    );
    await step("linux-download-assets", (run) =>
      run("scp", [
        ...sshOptions,
        ...platformAssets(releaseFiles(version).linux).map((name) => `${host}:${remote}/${name}`),
        NodePath.join(directory, "release"),
      ]),
    );
  } catch (error) {
    buildError = error;
    throw error;
  } finally {
    await step(
      "linux-cleanup",
      (run) =>
        run(
          "ssh",
          ssh(`
set -eu
id=$(docker container ls -aq --filter 'name=^/${container}$')
if [ -n "$id" ]; then docker rm -f "$id"; fi
rm -rf -- ${remote}
`),
        ),
      true,
    ).catch((cleanupError: unknown) => {
      if (!buildError) throw cleanupError;
      process.stderr.write(`${String(cleanupError)}\n`);
    });
  }
}

function isPublishedRelease(value: unknown, expected: readonly string[]) {
  if (typeof value !== "object" || value === null) return false;
  if (!("isDraft" in value) || value.isDraft !== false) return false;
  if (!("isPrerelease" in value) || value.isPrerelease !== false) return false;
  const assets = "assets" in value ? value.assets : undefined;
  if (!Array.isArray(assets) || assets.length !== expected.length) {
    return false;
  }
  return expected.every((name) =>
    assets.some(
      (asset: unknown) =>
        typeof asset === "object" && asset !== null && "name" in asset && asset.name === name,
    ),
  );
}

async function publishRelease(
  version: string,
  commit: string,
  directory: string,
  step: ReturnType<typeof releaseSteps>,
) {
  const files = releaseFiles(version);
  const assets = [...platformAssets(files.win), ...platformAssets(files.linux), "SHA256SUMS"];
  const tag = `v${version}`;
  await step("push-version-tag", (run) =>
    run("git", [
      "push",
      "--no-follow-tags",
      "--no-recurse-submodules",
      `https://github.com/${repository}.git`,
      `${commit}:refs/tags/${tag}`,
    ]),
  );
  await step("create-release", (run) =>
    run(
      "gh",
      [
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--verify-tag",
        "--latest",
        "--title",
        `T3 Code ${version}`,
        "--notes",
        `Custom desktop build ${version}`,
        ...assets.map((name) => NodePath.join(directory, name)),
      ],
      { minutes: 45 },
    ),
  );
  await step("verify-release", async (run) => {
    const result = await run(
      "gh",
      ["release", "view", tag, "--repo", repository, "--json", "isDraft,isPrerelease,assets"],
      { capture: true },
    );
    const published: unknown = JSON.parse(result);
    if (!isPublishedRelease(published, assets)) {
      throw new Error(`Expected a published stable release with assets: ${assets.join(", ")}`);
    }
  });
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: { "linux-host": { type: "string", default: "notrory" } },
  });
  const host = values["linux-host"];
  if (host !== "notrory" && host !== "hotel")
    throw new Error("--linux-host must be notrory or hotel");
  const manifest: unknown = JSON.parse(
    await NodeFSP.readFile(NodePath.join(root, "apps/server/package.json"), "utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("Missing version in apps/server/package.json");
  }
  const version = customReleaseVersion(manifest.version, DateTime.nowUnsafe());
  const scratch = NodePath.join(root, "tmp");
  const directory = NodePath.join(scratch, `tmp_local_desktop_${version}`);
  await NodeFSP.mkdir(scratch, { recursive: true });
  await NodeFSP.mkdir(directory);
  const output = NodePath.join(directory, "release");
  await NodeFSP.mkdir(output);
  const step = releaseSteps(directory);
  const lock = NodePath.join(scratch, "tmp_custom_release_lock");
  await step("lock-release", async () => {
    try {
      await NodeFSP.mkdir(lock);
    } catch (cause) {
      throw new Error(`Cannot acquire the release lock at ${lock}`, { cause });
    }
  });
  try {
    const commit = await step("source-preflight", async (run) => {
      if (hostPlatform !== "win32" || hostArch !== "x64" || process.versions.node !== nodeVersion) {
        throw new Error(`Run the release from Windows x64 with Node ${nodeVersion}`);
      }
      if ((await run("git", ["branch", "--show-current"], { capture: true })) !== sourceBranch) {
        throw new Error(`Release must run on ${sourceBranch}`);
      }
      if (
        await run("git", ["status", "--porcelain=v1", "--untracked-files=no"], { capture: true })
      ) {
        throw new Error("Tracked files must be clean");
      }
      if (NodeFS.existsSync(NodePath.join(root, ".desktop-build.lock"))) {
        throw new Error(
          "This checkout has a desktop build lock. Inspect the desktop build before retrying.",
        );
      }
      await NodeFSP.stat(NodePath.join(root, "node_modules/vite-plus/bin/vp"));
      await buildEnvironment();
      return run("git", ["rev-parse", "HEAD"], { capture: true });
    });
    await step("linux-preflight", (run) =>
      run(
        "ssh",
        [
          ...sshOptions,
          "-o",
          "ClearAllForwardings=yes",
          host,
          `bash -c ${shellQuote(linuxPreflight)} 2>&1`,
        ],
        { capture: true },
      ),
    );
    const abort = new AbortController();
    const platformStep = releaseSteps(directory, abort.signal);
    const stopOnFailure = (failure: unknown) => abort.abort(failure);
    const interrupted = () => stopOnFailure(new Error(`Release interrupted. Logs: ${directory}`));
    process.on("SIGINT", interrupted);
    process.on("SIGTERM", interrupted);
    try {
      await Promise.allSettled([
        buildPlatform("win", version, directory, platformStep).catch(stopOnFailure),
        buildOverSsh(host, version, commit, directory, platformStep).catch(stopOnFailure),
      ]);
    } finally {
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
    }
    abort.signal.throwIfAborted();
    await step("verify-source", async (run) => {
      if (
        (await run("git", ["rev-parse", "HEAD"], { capture: true })) !== commit ||
        (await run("git", ["status", "--porcelain=v1", "--untracked-files=no"], { capture: true }))
      ) {
        throw new Error("Tracked source changed during the build");
      }
    });
    await step("verify-release-assets", async () => {
      await verifyReleaseAssets(output, version, "win");
      await verifyReleaseAssets(output, version, "linux");
      await writeReleaseChecksums(output, version);
    });
    await publishRelease(version, commit, output, step);
    process.stdout.write(`Published https://github.com/${repository}/releases/tag/v${version}\n`);
    for (const platform of Object.values(releaseFiles(version))) {
      for (const installer of platform.installers)
        process.stdout.write(`${NodePath.join(output, installer)}\n`);
    }
  } finally {
    await NodeFSP.rm(lock, { recursive: true });
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
