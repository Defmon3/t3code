// @effect-diagnostics nodeBuiltinImport:off - Runs the generated runner in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { remoteStateKey, shellSingleQuote } from "./command.ts";
import { SshCommandError, SshPasswordPromptError, SshReadinessError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const isSshCommandError = Schema.is(SshCommandError);

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args.map(String) : [];
}

const makeManagedLaunchProcess = (command: ChildProcess.Command) =>
  makeSuccessfulProcess(
    commandArgs(command).some((arg) => arg === "-G" || arg.includes("server-runtime.json"))
      ? ""
      : '{"remotePort":3773}\n',
  );

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const fixtureShell = windowsHost ? `${process.env.ProgramFiles}/Git/bin/bash.exe` : "/bin/sh";
const shellPath = (path: string) =>
  windowsHost
    ? path
        .replaceAll("\\", "/")
        .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    : path;

const runTransportedScript = (command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(fixtureShell, ["-c", command.join(" ")]));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode: Number(exitCode) };
  });

// Emulates `t3 serve`: it takes the home owner lock at startup, then binds
// once a second server has tried the same home (or after 2s), so a concurrent
// launch always sees the home still unclaimed. Like the real server, it
// publishes server-runtime.json after it starts answering HTTP, if at all.
const fakeT3Serve = (publishDelayMs: number | null) => `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const userdata = path.join(args[args.indexOf("--base-dir") + 1], "userdata");
const servers = path.join(process.env.HOME, "servers");
fs.mkdirSync(userdata, { recursive: true });
fs.appendFileSync(servers, process.pid + "\\n");
try {
  fs.writeFileSync(path.join(userdata, "server.lock"), String(process.pid), { flag: "wx" });
} catch {
  console.error("ServerAlreadyRunningError: another server owns " + userdata);
  process.exit(1);
}
setTimeout(() => process.exit(0), 60_000);
const serve = (tries) => {
  if (tries > 0 && fs.readFileSync(servers, "utf8").trim().split("\\n").length < 2) {
    setTimeout(() => serve(tries - 1), 50);
    return;
  }
  http.createServer((_, response) => response.end()).listen(port, "127.0.0.1", () => {
    const origin = "http://127.0.0.1:" + port;
    ${publishDelayMs === null ? "return;" : ""}
    setTimeout(() => {
      fs.writeFileSync(path.join(userdata, "server-runtime.json"), JSON.stringify({ pid: process.pid, port, origin }));
    }, ${publishDelayMs});
  });
};
serve(40);
`;

const localRemoteShellLayer = (home: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let launches = 0;
      return ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return spawner.spawn(command);
        const launchWait =
          launches++ === 0
            ? ""
            : 'i=0; while [ ! -s "$HOME/servers" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done; ';
        const args = commandArgs(command);
        const remoteCommand = args.slice(args.indexOf("sh")).join(" ").replace("sh -l ", "sh ");
        return spawner.spawn(
          ChildProcess.make(fixtureShell, ["-s"], {
            ...command.options,
            env: { ...command.options.env, HOME: home.replaceAll("\\", "/") },
            stdin: {
              stream: Stream.make(new TextEncoder().encode(`${launchWait}exec ${remoteCommand}\n`)),
              endOnDone: true,
            },
            // Like an SSH session ending, the shell's exit leaves its nohup'd server running.
            detached: false,
          }),
        );
      });
    }),
  );

describe("ssh tunnel scripts", () => {
  it.effect.each([true, false])(
    "checks external server protocol before reuse (compatible: %s)",
    (compatible) => {
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      let launches = 0;
      let stops = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        const args = commandArgs(command);
        if (args.includes("-G")) return Effect.succeed(makeSuccessfulProcess(""));
        if (args.includes("-N")) return Effect.succeed(makeRunningProcess(() => undefined));
        if (args.some((arg) => arg.includes("server-runtime.json"))) {
          return Effect.succeed(
            makeSuccessfulProcess(
              `${compatible ? "loaded profile\n" : ""}{"pid":123,"port":3773,"origin":"http://127.0.0.1:3773"}`,
            ),
          );
        }
        if (args.some((arg) => arg.includes("kill -0 123")))
          return Effect.succeed(makeSuccessfulProcess("alive"));
        if (args.at(-2) === "--") launches += 1;
        else stops += 1;
        return Effect.succeed(makeSuccessfulProcess(""));
      });
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              request.url.endsWith("/.well-known/t3/environment")
                ? JSON.stringify({
                    environmentId: "test",
                    label: "test",
                    platform: { os: "linux", arch: "x64" },
                    serverVersion: "1.0.0",
                    orchestrationProtocolVersion:
                      ORCHESTRATION_PROTOCOL_VERSION + (compatible ? 0 : 1),
                    capabilities: {},
                  })
                : "",
              { status: 200 },
            ),
          ),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(manager.ensureEnvironment(target));
        if (Result.isSuccess(result)) {
          assert.isTrue(compatible);
          assert.equal(result.success.remotePort, 3773);
          assert.equal(result.success.remoteServerKind, "external");
          yield* manager.disconnectEnvironment(target);
        } else {
          assert.isFalse(compatible);
          assert.equal(result.failure._tag, "SshLaunchError");
        }
        assert.equal(launches, 0);
        assert.equal(stops, 0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
  );
  it.effect.each(["", "managed"])("uses the launcher when the recorded process is %s", (status) => {
    const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
    let launches = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      const args = commandArgs(command);
      if (args.includes("-G")) return Effect.succeed(makeSuccessfulProcess(""));
      if (args.includes("-N")) return Effect.succeed(makeRunningProcess(() => undefined));
      if (args.some((arg) => arg.includes("server-runtime.json"))) {
        return Effect.succeed(
          makeSuccessfulProcess('{"pid":123,"port":3773,"origin":"http://127.0.0.1:3773"}'),
        );
      }
      if (args.some((arg) => arg.includes("kill -0 123")))
        return Effect.succeed(makeSuccessfulProcess(status));
      launches += 1;
      return Effect.succeed(makeSuccessfulProcess('{"remotePort":3774,"serverKind":"managed"}'));
    });
    const layer = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.SshPasswordPrompt.disabledLayer,
      SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
    );
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.ensureEnvironment(target);
      assert.equal(result.remotePort, 3774);
      assert.equal(result.remoteServerKind, "managed");
      assert.equal(launches, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
  it.effect(
    "executes a large quoted Unicode script and preserves its arguments without SSH stdin",
    () =>
      Effect.gen(function* () {
        const script = `${": 'café 東京 shell payload'\n".repeat(2_000)}printf '%s\\n' "$1" "$2"\n`;
        const args = ["a path with spaces and 'quotes'", "$(exit 99); café 東京"];
        const command = SshTunnel.buildRemoteScriptCommand(script, args);
        const result = yield* runTransportedScript(command);

        assert.isAbove(Buffer.byteLength(script), 24_000);
        assert.isBelow(command.join(" ").length, 16_000);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, `${args.join("\n")}\n`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("preserves a transported script's failure exit code", () =>
    Effect.gen(function* () {
      const command = SshTunnel.buildRemoteScriptCommand("exit 17\n");
      const result = yield* runTransportedScript(command);

      assert.equal(result.exitCode, 17, result.stderr);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.each([
    { host: "Darwin x86_64", system: "Darwin", machine: "x86_64", downloads: false },
    { host: "Darwin arm64", system: "Darwin", machine: "arm64", downloads: true },
  ])(
    "only downloads a release archive the host can run: $host",
    ({ system, machine, downloads }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runner-"));
      try {
        NodeFS.mkdirSync(NodePath.join(root, "home"));
        const runner = NodePath.join(root, "run-t3.sh");
        NodeFS.writeFileSync(runner, SshTunnel.buildRemoteT3RunnerScript(ARCHIVE));
        const result = NodeChildProcess.spawnSync(fixtureShell, ["-s"], {
          encoding: "utf8",
          input: [
            `uname() { case "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac; }`,
            "curl() { echo 'download attempt' >&2; echo 'curl: (6) Could not resolve host: github.com' >&2; return 6; }",
            `. ${shellSingleQuote(shellPath(runner))}`,
          ].join("\n"),
          env: { ...process.env, HOME: NodePath.join(root, "home").replaceAll("\\", "/") },
        });
        assert.ifError(result.error);
        assert.notEqual(result.status, 0);
        if (downloads) {
          assert.include(result.stderr, "download attempt");
          assert.include(result.stderr, ARCHIVE.archiveVersion);
          assert.include(result.stderr, "https://github.com/pingdotgg/t3code/releases/download");
        } else {
          assert.notInclude(result.stderr, "download attempt");
          assert.include(result.stderr, "has no t3 release archive.");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("names gzip when a host with tar but no gzip cannot unpack the release archive", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runner-"));
    try {
      const release = NodePath.join(root, "release");
      const archive = `t3-${ARCHIVE.archiveVersion}-linux-x64.tar.gz`;
      NodeFS.mkdirSync(NodePath.join(root, "home"));
      NodeFS.mkdirSync(NodePath.join(release, "t3"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(release, "t3", "t3"), "#!/bin/sh\necho ok\n", {
        mode: 0o755,
      });
      NodeChildProcess.execFileSync(fixtureShell, ["-s"], {
        input: `tar -czf ${archive} t3 && sha256sum ${archive} > SHA256SUMS`,
        cwd: release,
      });
      const commands = [
        "sh",
        "mkdir",
        "mktemp",
        "cat",
        "rm",
        "grep",
        "cut",
        "sha256sum",
        "tar",
        "mv",
      ];
      const functions = commands.map((command) => {
        const executable = NodeChildProcess.execFileSync(fixtureShell, ["-s"], {
          input: `command -v ${command}`,
          encoding: "utf8",
        }).trim();
        return `${command}() { ${shellSingleQuote(executable)} "$@"; }`;
      });
      const runner = NodePath.join(root, "run-t3.sh");
      NodeFS.writeFileSync(runner, SshTunnel.buildRemoteT3RunnerScript(ARCHIVE));
      const result = NodeChildProcess.spawnSync(fixtureShell, ["-s"], {
        encoding: "utf8",
        input: [
          ...functions,
          'uname() { case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac; }',
          `curl() { for last; do :; done; for a; do case "$a" in http*) src=${shellSingleQuote(shellPath(release))}/\${a##*/} ;; esac; done; cat "$src" > "$last"; }`,
          "PATH=''; export PATH",
          `. ${shellSingleQuote(shellPath(runner))}`,
        ].join("\n"),
        env: { ...process.env, HOME: NodePath.join(root, "home").replaceAll("\\", "/") },
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /(missing|needs) gzip/);
      assert.notInclude(result.stderr, "Cannot exec");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect("launches without streaming scripts through a forced PTY", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert.isTrue(ChildProcess.isStandardCommand(command));
        if (ChildProcess.isStandardCommand(command)) {
          const stdin = command.options.stdin;
          assert.isObject(stdin);
          if (
            stdin &&
            typeof stdin === "object" &&
            "stream" in stdin &&
            Stream.isStream(stdin.stream)
          ) {
            const chunks = yield* Stream.runCollect(stdin.stream);
            assert.equal(chunks.length, 0, "SSH stdin must not contain the launch script");
          }
        }
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.isTrue(spawnedCommands[0]?.includes("-c"));
      assert.isBelow(spawnedCommands.flat().join(" ").length, 16_000);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).some((arg) => arg.includes("server-runtime.json"))
            ? makeSuccessfulProcess("")
            : commandArgs(command).includes("-N")
              ? {
                  ...makeSuccessfulProcess(""),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                  stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
                }
              : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).some((arg) => arg.includes("server-runtime.json"))
            ? makeSuccessfulProcess("")
            : commandArgs(command).includes("-N")
              ? {
                  ...makeSuccessfulProcess(""),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                  stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                    Stream.concat(
                      Stream.fail(
                        PlatformError.systemError({
                          _tag: "Unknown",
                          module: "Stream",
                          method: "read",
                          description: "stderr read failed",
                        }),
                      ),
                    ),
                  ),
                }
              : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("waits for a tunnel whose ssh connection outlasts the readiness timeout", () =>
    Effect.gen(function* () {
      const LOCAL_PORT = 41_773;
      // ssh spends ConnectTimeout on each unreachable address before the forward listens.
      const SSH_CONNECT_MS = 25_000;
      let forwardListensAt = Number.POSITIVE_INFINITY;
      const tunnelSpawned = yield* Deferred.make<void>();
      const forwardListening = (port: number) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => port === LOCAL_PORT && now >= forwardListensAt),
        );
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Effect.gen(function* () {
              forwardListensAt = (yield* Clock.currentTimeMillis) + SSH_CONNECT_MS;
              yield* Deferred.succeed(tunnelSpawned, undefined);
              return makeRunningProcess(() => undefined);
            })
          : Effect.succeed(makeManagedLaunchProcess(command)),
      );
      const httpClient = HttpClient.make((request) =>
        forwardListening(LOCAL_PORT).pipe(
          Effect.flatMap((listening) =>
            listening
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response("", { status: 200 })),
                )
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: `connect ECONNREFUSED 127.0.0.1:${LOCAL_PORT}`,
                    }),
                  }),
                ),
          ),
        ),
      );
      const net = NetService.NetService.of({
        ...testNetService,
        reserveLoopbackPort: () => Effect.succeed(LOCAL_PORT),
        canListenOnHost: (port) =>
          forwardListening(port).pipe(Effect.map((listening) => !listening)),
        isPortAvailableOnLoopback: (port) =>
          forwardListening(port).pipe(Effect.map((listening) => !listening)),
        hasListenerOnHost: (port) => forwardListening(port),
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, net),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.seconds(60));
        const environment = yield* Fiber.join(ensure);
        assert.equal(environment.httpBaseUrl, `http://127.0.0.1:${LOCAL_PORT}/`);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("connects through a tunnel whose responses take longer than a second", () =>
    Effect.gen(function* () {
      // Over a ~1s RTT link each request through the forward takes a few round trips.
      const RESPONSE_MS = 2_500;
      const tunnelSpawned = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Deferred.succeed(tunnelSpawned, undefined).pipe(
              Effect.as(makeRunningProcess(() => undefined)),
            )
          : Effect.succeed(makeManagedLaunchProcess(command)),
      );
      const httpClient = HttpClient.make((request) =>
        Effect.sleep(Duration.millis(RESPONSE_MS)).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          Effect.result(
            manager.ensureEnvironment({
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
            }),
          ),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.seconds(60));
        const result = yield* Fiber.join(ensure);
        assert.isTrue(
          Result.isSuccess(result),
          Result.isFailure(result) ? result.failure.message : undefined,
        );
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reconnects a saved alias through the port its ssh config names now", () =>
    Effect.gen(function* () {
      let configPort = 53_791;
      const tunnelPorts: Array<string | undefined> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          return Effect.succeed(
            makeSuccessfulProcess(`hostname 127.0.0.1\nuser developer\nport ${configPort}\n`),
          );
        }
        if (args.includes("-N")) {
          tunnelPorts.push(args[args.indexOf("-p") + 1]);
          return Effect.succeed(makeRunningProcess(() => undefined));
        }
        return Effect.succeed(makeManagedLaunchProcess(command));
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const added = yield* manager.ensureEnvironment({
          alias: "lima-sandbox",
          hostname: "lima-sandbox",
          username: null,
          port: null,
        });
        // The VM restarts on a new port; the client reconnects with the target it saved.
        yield* manager.disconnectEnvironment(added.target);
        configPort = 53_812;
        yield* manager.ensureEnvironment(added.target);
        assert.deepStrictEqual(tunnelPorts, ["53791", "53812"]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("fails with a readiness error when ssh never connects", () =>
    Effect.gen(function* () {
      const tunnelSpawned = yield* Deferred.make<void>();
      let tunnelKilled = false;
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Deferred.succeed(tunnelSpawned, undefined).pipe(
              Effect.as(
                makeRunningProcess(() => {
                  tunnelKilled = true;
                }),
              ),
            )
          : Effect.succeed(makeManagedLaunchProcess(command)),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(
          NetService.NetService,
          NetService.NetService.of({
            ...testNetService,
            hasListenerOnHost: () => Effect.succeed(false),
          }),
        ),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          Effect.result(
            manager.ensureEnvironment({
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
            }),
          ),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.minutes(2));
        const result = yield* Fiber.join(ensure);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshReadinessError);
          assert.include(result.failure.message, "SSH connection to devbox did not come up");
        }
        assert.isTrue(tunnelKilled);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each([
    {
      name: "does not ask for a password when the agent cannot sign an accepted key",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519 "/home/julius/.ssh/id_ed25519" from agent: communication with agent failed\r\n' +
        "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when signing failure has no agent provenance",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519-CERT "key-cert.pub": agent refused operation\n' +
        "julius@devbox: Permission denied (publickey,password).\n",
      expectedPromptAttempts: [1],
    },
    {
      name: "does not ask for a password when the host key cannot be verified",
      stderr: "Host key verification failed.\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when the server rejects every key",
      stderr: "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [1],
    },
  ])("$name", ({ stderr, expectedPromptAttempts }) =>
    Effect.gen(function* () {
      const promptAttempts: Array<number> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-G")
            ? makeSuccessfulProcess("")
            : {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(stderr)),
              },
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: (request) =>
              Effect.sync(() => {
                promptAttempts.push(request.attempt);
                return null;
              }),
          }),
        ),
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(promptAttempts, expectedPromptAttempts);
        if (Result.isFailure(result)) {
          if (expectedPromptAttempts.length === 0) {
            assert.instanceOf(result.failure, SshCommandError);
            if (isSshCommandError(result.failure)) {
              assert.equal(result.failure.stderr, stderr);
            }
          } else {
            assert.instanceOf(result.failure, SshPasswordPromptError);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.some((arg) => arg.includes("server-runtime.json")))
              return makeSuccessfulProcess("");
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.at(-2) === "--") {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );

  it.live("concurrent launches on one remote home record the server that owns it", () =>
    // The second row's server never publishes server-runtime.json.
    Effect.forEach([1_500, null], (publishDelayMs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-launch-" });
        const serversFile = path.join(home, "servers");
        yield* Effect.addFinalizer(() =>
          fs.readFileString(serversFile).pipe(
            Effect.map((pids) => {
              for (const pid of pids.split("\n").filter(Boolean)) {
                try {
                  process.kill(Number(pid), "SIGKILL");
                } catch {}
              }
            }),
            Effect.ignore,
          ),
        );
        const serverScript = path.join(home, "fake-t3.cjs");
        yield* fs.writeFileString(serverScript, fakeT3Serve(publishDelayMs));
        // A launch that died holding the lock must not block or double-admit later ones.
        const launchLock = path.join(home, ".t3", "ssh-launch", ".launch.lock");
        yield* fs.makeDirectory(path.dirname(launchLock), { recursive: true });
        yield* fs.writeFileString(launchLock, "999999999\n");
        const targets = [
          { alias: "devbox", hostname: "devbox", username: null, port: null },
          { alias: "devbox-tailnet", hostname: "devbox-tailnet", username: null, port: null },
        ];

        const launches = yield* Effect.forEach(
          targets,
          (target) =>
            SshTunnel.launchOrReuseRemoteServer(target, undefined, {
              nodeScriptPath: serverScript,
            }),
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(localRemoteShellLayer(home)));

        const ownerPid = Number(
          yield* fs.readFileString(path.join(home, ".t3", "userdata", "server.lock")),
        );
        assert.sameMembers(
          launches.map((launch) => launch.remoteServerKind),
          ["managed", "external"],
        );
        assert.equal(launches[0]!.remotePort, launches[1]!.remotePort);
        assert.deepEqual((yield* fs.readFileString(serversFile)).trim().split("\n"), [
          String(ownerPid),
        ]);
        for (const [index, launch] of launches.entries()) {
          if (launch.remoteServerKind !== "managed") continue;
          const stateKey = yield* remoteStateKey(targets[index]!);
          const recordedPid = yield* fs.readFileString(
            path.join(home, ".t3", "ssh-launch", stateKey, "pid"),
          );
          let nativeRecordedPid = Number(recordedPid.trim());
          if (windowsHost) {
            const processIds = NodeChildProcess.execFileSync(fixtureShell, ["-s"], {
              input: `ps -l -p ${nativeRecordedPid}`,
              encoding: "utf8",
            });
            const matchingProcess = processIds
              .trim()
              .split(/\r?\n/u)
              .map((line) => line.trim().split(/\s+/u))
              .find(([pid]) => pid === String(nativeRecordedPid));
            if (matchingProcess?.[3] === undefined) {
              throw new Error(`Git ps did not report WINPID for POSIX PID ${nativeRecordedPid}.`);
            }
            nativeRecordedPid = Number(matchingProcess[3]);
          }
          assert.equal(
            nativeRecordedPid,
            ownerPid,
            `${targets[index]!.alias} reported a managed server, but its recorded PID is not the server that owns the remote home`,
          );
        }
        assert.isFalse(yield* fs.exists(launchLock));
      }).pipe(Effect.scoped),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

// On Linux kill -0 accepts a thread ID and kill <tid> signals its whole process,
// but ps lists only thread-group leaders. After a reboot the managed pid file can
// name a thread or a whole process that is not our server.
describe.runIf(HostProcess.Platform.defaultValue() === "linux")("stale managed pid file", () => {
  const FAKE_SERVER = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const server = http.createServer((_request, response) => response.end("ok"));
server.listen(Number(flag("--port") ?? 0), "127.0.0.1", () => {
  const port = server.address().port;
  const base = flag("--base-dir");
  if (base) {
    fs.mkdirSync(path.join(base, "userdata"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
    );
  }
  console.log(port);
});
`;
  const target = { alias: "devbox", hostname: "devbox", username: null, port: null } as const;
  const staleIds = ["a thread of an unrelated process", "an unrelated process"] as const;

  const isRunning = (pid: number) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(`/proc/${pid}/stat`)).pipe(
      Effect.map((stat) => !/^\d+ \(.*\) Z/u.test(stat)),
      Effect.orElseSucceed(() => false),
    );

  const prepare = (staleId: (typeof staleIds)[number]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stale-pid-" });
      const home = `${root}/home`;
      const fakeServer = `${root}/fake-t3.cjs`;
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(fakeServer, FAKE_SERVER);
      // Runs the remote command locally under the temp HOME, without -l so the test
      // machine's login profile cannot move HOME. setsid keeps a launched server alive
      // when the command's process group goes away, as sshd would.
      const sshAsLocalShell = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "ssh") {
          return realSpawner.spawn(command);
        }
        if (command.args.includes("-G")) return Effect.succeed(makeSuccessfulProcess(""));
        const remoteArgs = command.args.slice(command.args.indexOf("--") + 2);
        return realSpawner.spawn(
          ChildProcess.make(
            "setsid",
            ["-w", fixtureShell, "-c", remoteArgs.join(" ").replace("sh -l ", "sh ")],
            {
              ...command.options,
              env: { PATH: process.env.PATH ?? "", HOME: home },
              extendEnv: false,
            },
          ),
        );
      });
      const holder = yield* realSpawner.spawn(ChildProcess.make("node", [fakeServer]));
      const holderPort = Number(
        Option.getOrThrow(
          yield* holder.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
        ),
      );
      const tid = Number(
        (yield* fs.readDirectory(`/proc/${holder.pid}/task`)).find(
          (task) => task !== `${holder.pid}`,
        ),
      );
      assert.isTrue(Number.isInteger(tid));
      return {
        fs,
        home,
        fakeServer,
        holder,
        holderPort,
        sshAsLocalShell,
        staleId: staleId === "an unrelated process" ? holder.pid : tid,
        stateDir: `${home}/.t3/ssh-launch/${yield* remoteStateKey(target)}`,
      };
    });

  it.live.each(staleIds)("launches a fresh server when the managed pid file names %s", (kind) =>
    Effect.gen(function* () {
      const { fs, home, fakeServer, holderPort, sshAsLocalShell, staleId, stateDir } =
        yield* prepare(kind);
      const launch = SshTunnel.launchOrReuseRemoteServer(target, undefined, {
        nodeScriptPath: fakeServer,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell));
      const readPid = fs
        .readFileString(`${stateDir}/pid`)
        .pipe(Effect.map((pid) => Number(pid.trim())));
      const launchedPids: Array<number> = [];
      yield* Effect.addFinalizer(() =>
        Effect.forEach(launchedPids, (pid) =>
          Effect.sync(() => {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }),
        ),
      );

      const first = yield* launch;
      const firstPid = yield* readPid;
      launchedPids.push(firstPid);
      assert.deepEqual(yield* launch, first);
      assert.equal(yield* readPid, firstPid);

      // Reboot: our server is gone and its recorded PID now names something that
      // answers on the recorded port.
      process.kill(firstPid, "SIGKILL");
      yield* fs.remove(`${home}/.t3/userdata/server-runtime.json`);
      yield* fs.writeFileString(`${stateDir}/pid`, `${staleId}\n`);
      yield* fs.writeFileString(`${stateDir}/port`, `${holderPort}\n`);

      const relaunched = yield* launch;
      const pid = yield* readPid;
      if (pid !== staleId) launchedPids.push(pid);
      assert.notEqual(
        relaunched.remotePort,
        holderPort,
        `the launcher kept ${kind} as its running server`,
      );
      assert.isTrue(yield* isRunning(pid));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.each(staleIds)("disconnecting does not signal %s named by the managed pid file", (kind) =>
    Effect.gen(function* () {
      const { fs, holder, sshAsLocalShell, staleId, stateDir } = yield* prepare(kind);
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/pid`, `${staleId}\n`);
      yield* fs.writeFileString(`${stateDir}/managed`, "managed\n");
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );

      yield* Effect.flatMap(SshTunnel.SshEnvironmentManager, (manager) =>
        manager.disconnectEnvironment(target),
      ).pipe(Effect.provide(layer));
      assert.isTrue(yield* isRunning(holder.pid), `disconnecting signalled ${kind}`);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.
