// @effect-diagnostics nodeBuiltinImport:off - Executes the generated remote launcher in an isolated shell with fake commands and clock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeZlib from "node:zlib";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { launchOrReuseRemoteServer, type RemoteT3RunnerOptions } from "./tunnel.ts";

export const windowsHost = HostProcess.Platform.defaultValue() === "win32";
export const fixtureShell = windowsHost
  ? `${process.env.ProgramFiles}/Git/bin/bash.exe`
  : "/bin/sh";

export function shellPath(path: string): string {
  return windowsHost
    ? path
        .replaceAll("\\", "/")
        .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    : path;
}

export function transportedScript(command: ChildProcess.Command): string {
  if (command._tag !== "StandardCommand") throw new Error("SSH command must be a standard command");
  const payload = /[A-Za-z0-9+/]{40,}={0,2}/u.exec(command.args.map(String).join(" "))?.[0];
  if (payload === undefined) throw new Error("SSH script payload is missing");
  return NodeZlib.gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
}

export const captureLauncherFor = Effect.fn("test.captureLauncher")(function* (
  runner: RemoteT3RunnerOptions,
) {
  let script = "";
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand") {
        script = transportedScript(command);
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: Stream.make(new TextEncoder().encode('{"remotePort":3773}\n')),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  yield* launchOrReuseRemoteServer(
    { alias: "test", hostname: "test.invalid", username: null, port: null },
    undefined,
    runner,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  );
  return script;
});

export const captureLauncher = captureLauncherFor({ nodeScriptPath: "/fake/server.ts" });

function holdLock(path: string) {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec("BEGIN EXCLUSIVE;");
  return { [Symbol.dispose]: () => db.close() };
}

export function runLauncher(
  script: string,
  options: {
    readonly marker?: unknown;
    readonly archive?: boolean;
    readonly clearMarkerOnReady?: boolean;
    readonly recordedKind?: "managed" | "external";
    readonly clockJump?: number;
    readonly readyAt?: number;
    readonly initialPort?: number;
    // A boot service between two servers holds the home with no runtime record yet.
    readonly serviceServing?: boolean;
    readonly allowFailure?: boolean;
    // The desktop publishes runtime and removes the marker right after the first runtime read.
    readonly publishAfterFirstRuntimeRead?: boolean;
  },
) {
  const stateKey = "test-target";
  const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const home = NodeFS.mkdtempSync(NodePath.join(root, "packages/ssh/.ssh-launcher-test-"));
  try {
    const bin = NodePath.join(home, "bin");
    const runtime = NodePath.join(home, ".t3/runtime");
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(runtime, { recursive: true });
    const markerPath = NodePath.join(runtime, "desktop-update-in-progress");
    if (options.marker)
      NodeFS.writeFileSync(
        markerPath,
        typeof options.marker === "string" ? options.marker : JSON.stringify(options.marker),
      );
    NodeFS.writeFileSync(NodePath.join(home, "clock"), "0\n");
    NodeFS.writeFileSync(NodePath.join(home, "events"), "");
    const executable = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, {
        mode: 0o755,
      });
    NodeFS.writeFileSync(
      NodePath.join(home, "clock.cjs"),
      `
const fs = require('node:fs');
Date.now = () => Number(fs.readFileSync(process.env.HOME + '/clock', 'utf8'));
`,
    );
    executable(
      options.archive ? "test-node" : "node",
      `
case "\${2:-}" in
  */server-runtime.json)
    if [ -e "$HOME/picked-port" ]; then
      read -r PID < "$HOME/.t3/ssh-launch/${stateKey}/pid"
      read -r NOW < "$HOME/clock"
      printf 'record %s\\n' "$NOW" >> "$HOME/events"
      printf '%s 5999' "$PID"
      exit 0
    fi
    read -r NOW < "$HOME/clock"
    printf 'runtime %s\\n' "$NOW" >> "$HOME/events"
    if [ "$NOW" -ge "$TEST_READY_AT" ] || [ -e "$2" ]; then printf '%s %s' "$TEST_SERVER_PID" 4888
    elif [ "$TEST_PUBLISH_AFTER_FIRST_READ" = 1 ]; then
      mkdir -p "\${2%/*}"
      printf '{}' > "$2"
      rm -f "$HOME/.t3/runtime/desktop-update-in-progress"
      exit 1
    elif [ -n "$TEST_INITIAL_PORT" ]; then printf '%s %s' "$TEST_SERVER_PID" "$TEST_INITIAL_PORT"
    else exit 1; fi ;;
  */port)
    : > "$HOME/picked-port"
    printf 5999 ;;
  [0-9]*)
    read -r NOW < "$HOME/clock"
    printf 'probe %s %s\\n' "$2" "$NOW" >> "$HOME/events"
    [ "$2" = 5999 ] || { [ "$2" = 4888 ] && { [ "$NOW" -ge "$TEST_READY_AT" ] || [ -e "$HOME/.t3/userdata/server-runtime.json" ]; }; } ;;
  */desktop-update-in-progress)
    read -r NOW < "$HOME/clock"
    printf 'marker %s\\n' "$NOW" >> "$HOME/events"
    exec "$TEST_REAL_NODE" --require "$HOME/clock.cjs" "$@" ;;
  *) exec "$TEST_REAL_NODE" --require "$HOME/clock.cjs" "$@" ;;
esac`,
    );
    // The test process stands in for a recorded server; report the serve command it would run.
    executable(
      "ps",
      `if [ "$*" = "-ww -o args= -p $TEST_SERVER_PID" ]; then
  printf '/bin/sh %s/.t3/ssh-launch/${stateKey}/run-t3.sh serve --host 127.0.0.1 --port 5999\\n' "$HOME"
  exit 0
fi
PATH=/usr/bin:/bin exec ps "$@"`,
    );
    if (options.recordedKind) {
      const state = NodePath.join(home, ".t3/ssh-launch", stateKey);
      NodeFS.mkdirSync(state, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(state, "pid"), String(process.pid));
      NodeFS.writeFileSync(NodePath.join(state, "port"), "5999");
      NodeFS.writeFileSync(NodePath.join(state, "managed"), options.recordedKind);
      const runner = script.split("cat >\"$RUNNER_NEXT\" <<'SH'\n")[1]?.split("\nSH\n")[0];
      if (!runner) throw new Error("runner missing");
      NodeFS.writeFileSync(NodePath.join(state, "run-t3.sh"), runner + "\n");
    }
    if (options.archive) {
      executable("node", 'printf "unexpected host node invocation\\n" >&2; exit 1');
      const version = NodePath.join(home, ".t3/runtime/versions/1.2.3");
      NodeFS.mkdirSync(version, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(version, ".install-complete"), "1.2.3");
      NodeFS.writeFileSync(
        NodePath.join(home, "archive-marker.cjs"),
        `
const fs = require("node:fs");
const marker = process.argv[2];
if (fs.existsSync(marker)) {
  const { startedAt, expiresAt } = JSON.parse(fs.readFileSync(marker, "utf8"));
  const now = Date.now();
  if (startedAt <= now && now < expiresAt) process.stdout.write(String(expiresAt - now));
}
`,
      );
      NodeFS.writeFileSync(
        NodePath.join(version, "t3"),
        `#!/bin/sh
set -eu
if [ "$1" = --version ]; then printf 1.2.3; exit; fi
[ "$1" = __ssh-helper ]
case "$2" in
  update-remaining)
    read -r NOW < "$HOME/clock"
    printf 'marker %s\\n' "$NOW" >> "$HOME/events"
    exec "$TEST_REAL_NODE" --require "$HOME/clock.cjs" "$HOME/archive-marker.cjs" "$3" ;;
  home-owned) [ "$TEST_SERVICE_SERVING" = 1 ] ;;
  runtime-port | pick-port | wait-ready) exec "$HOME/bin/test-node" - "$3" ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o755 },
      );
    }
    using _serving = options.serviceServing
      ? holdLock(NodePath.join(runtime, "service-serving.lock"))
      : undefined;
    // why: Git Bash prepends system tools to the inherited PATH during startup.
    const result = NodeChildProcess.spawnSync(fixtureShell, ["-s", "--", stateKey], {
      input: `PATH="$HOME/bin:/usr/bin:/bin"
export PATH
sleep() {
  case "$1" in
    0.1) DELAY_MS=100 ;;
    1) DELAY_MS=1000 ;;
    *) printf 'Unexpected fixture sleep: %s\\n' "$1" >&2; return 1 ;;
  esac
  read -r CLOCK_MS < "$HOME/clock"
  CLOCK_MS=$((CLOCK_MS + DELAY_MS))
  if [ "$TEST_CLEAR_MARKER" = 1 ] && [ "$CLOCK_MS" -ge "$TEST_READY_AT" ]; then
    rm -f "$HOME/.t3/runtime/desktop-update-in-progress"
  fi
  if [ -n "$TEST_CLOCK_JUMP" ] && [ ! -e "$HOME/jumped" ]; then
    CLOCK_MS="$TEST_CLOCK_JUMP"
    : > "$HOME/jumped"
  fi
  printf '%s\\n' "$CLOCK_MS" > "$HOME/clock"
}
date() {
  if [ "$1" != +%s ]; then
    printf 'Unexpected fixture date format: %s\\n' "$1" >&2
    return 1
  fi
  read -r CLOCK_MS < "$HOME/clock"
  printf '%s\\n' "$((CLOCK_MS / 1000))"
}
kill() {
  if [ "$1" = -0 ]; then
    [ "$2" = "$TEST_SERVER_PID" ] || command kill "$@"
  else
    printf 'kill %s\\n' "$*" >> "$HOME/events"
    return 1
  fi
}
nohup() {
  read -r CLOCK_MS < "$HOME/clock"
  printf 'start %s\\n' "$CLOCK_MS" >> "$HOME/events"
}
${script}
wait`,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home.replaceAll("\\", "/"),
        TEST_REAL_NODE: shellPath(process.execPath),
        TEST_CLEAR_MARKER: options.clearMarkerOnReady ? "1" : "0",
        TEST_CLOCK_JUMP: options.clockJump === undefined ? "" : String(options.clockJump),
        TEST_SERVER_PID: String(process.pid),
        TEST_READY_AT: String(options.readyAt ?? 1_000_000),
        TEST_INITIAL_PORT: options.initialPort === undefined ? "" : String(options.initialPort),
        TEST_PUBLISH_AFTER_FIRST_READ: options.publishAfterFirstRuntimeRead ? "1" : "0",
        TEST_SERVICE_SERVING: options.serviceServing ? "1" : "0",
      },
    });
    if (result.error || (result.status !== 0 && !options.allowFailure))
      throw new Error(
        `launcher failed: ${result.error ?? result.status}\n${result.stderr}\n${result.stdout}\n${NodeFS.readFileSync(NodePath.join(home, "events"), "utf8")}`,
      );
    return {
      status: result.status,
      stderr: result.stderr,
      output: result.status === 0 ? JSON.parse(result.stdout.trim()) : undefined,
      events: NodeFS.readFileSync(NodePath.join(home, "events"), "utf8").trim().split("\n"),
      now: Number(NodeFS.readFileSync(NodePath.join(home, "clock"), "utf8")),
      markerExists: NodeFS.existsSync(markerPath),
    };
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}
