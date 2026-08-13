import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

import { ProcessRunner, type ProcessRunError } from "../processRunner.ts";

const HookCommand = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.Trimmed.check(Schema.isNonEmpty()),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(300)),
  ),
  timeout: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(300)),
  ),
});

const HookMatcher = Schema.Struct({
  matcher: Schema.optional(Schema.String),
  hooks: Schema.Array(HookCommand),
});

const HooksConfig = Schema.Struct({
  hooks: Schema.Struct({
    PreToolUse: Schema.optional(Schema.Array(HookMatcher)),
  }),
});

const HooksConfigJson = fromLenientJson(HooksConfig);
const decodeHooksConfigJson = Schema.decodeUnknownEffect(HooksConfigJson);

const HooksConfigEventKeys = Schema.Struct({
  hooks: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeHooksConfigEventKeysJson = Schema.decodeUnknownEffect(
  fromLenientJson(HooksConfigEventKeys),
);

const SUPPORTED_HOOK_EVENTS = ["PreToolUse"] as const;

const HookSpecificOutput = Schema.Struct({
  hookEventName: Schema.optional(Schema.String),
  permissionDecision: Schema.optional(Schema.Literals(["allow", "ask", "deny"])),
  permissionDecisionReason: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const HookCommandOutput = Schema.Struct({
  decision: Schema.optional(Schema.Literals(["allow", "ask", "deny"])),
  reason: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  hookSpecificOutput: Schema.optional(HookSpecificOutput),
});

const HookCommandOutputJson = fromLenientJson(HookCommandOutput);
const decodeHookCommandOutputJson = Schema.decodeUnknownEffect(HookCommandOutputJson);

const PreToolUsePayload = Schema.Struct({
  hook_event_name: Schema.Literal("PreToolUse"),
  provider: Schema.String,
  thread_id: Schema.String,
  cwd: Schema.String,
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
});
const encodePreToolUsePayloadJson = Schema.encodeSync(Schema.fromJsonString(PreToolUsePayload));

type HookCommandConfig = typeof HookCommand.Type;
type HookMatcherConfig = typeof HookMatcher.Type;

export type T3HookDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "ask" | "deny";
      readonly reason: string;
      readonly title?: string | undefined;
      readonly description?: string | undefined;
    };

export interface T3PreToolUseInput {
  readonly provider: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly toolName: string;
  readonly toolInput: unknown;
}

export interface T3HookPlan {
  readonly configPath: string | undefined;
  readonly hasPreToolUseHooks: boolean;
  readonly hasPreToolUseHooksNow: Effect.Effect<boolean>;
  readonly evaluatePreToolUse: (
    input: Omit<T3PreToolUseInput, "cwd">,
  ) => Effect.Effect<T3HookDecision, T3HookCommandError>;
}

export class T3HookConfigError extends Schema.TaggedErrorClass<T3HookConfigError>()(
  "T3HookConfigError",
  {
    operation: Schema.Literals(["inspect", "read", "decode", "matcher"]),
    configPath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class T3HookCommandError extends Schema.TaggedErrorClass<T3HookCommandError>()(
  "T3HookCommandError",
  {
    command: Schema.String,
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class T3HookRunner extends Context.Service<
  T3HookRunner,
  {
    readonly prepare: (cwd: string) => Effect.Effect<T3HookPlan, T3HookConfigError>;
  }
>()("t3/hooks/T3HookRunner") {}

function normalizedDecision(output: typeof HookCommandOutput.Type): T3HookDecision {
  const nested = output.hookSpecificOutput;
  const decision = nested?.permissionDecision ?? output.decision ?? "allow";
  if (decision === "allow") {
    return { decision };
  }
  return {
    decision,
    reason:
      nested?.permissionDecisionReason?.trim() ||
      output.reason?.trim() ||
      "A T3 project hook requires confirmation.",
    ...(nested?.title?.trim() || output.title?.trim()
      ? { title: nested?.title?.trim() || output.title?.trim() }
      : {}),
    ...(nested?.description?.trim() || output.description?.trim()
      ? { description: nested?.description?.trim() || output.description?.trim() }
      : {}),
  };
}

function logConfigFailure(error: T3HookConfigError) {
  return Effect.logWarning("T3 project hooks could not be loaded", {
    path: error.configPath,
    operation: error.operation,
    cause: error.cause,
  });
}

function expandProjectDirectory(command: string, projectDirectory: string): string {
  return command
    .replaceAll("${T3_PROJECT_DIR}", projectDirectory)
    .replaceAll("${CLAUDE_PROJECT_DIR}", projectDirectory);
}

function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher.length === 0) {
    return true;
  }
  return new RegExp(`^(?:${matcher})$`).test(toolName);
}

function commandInvocation(platform: string, command: string) {
  if (platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command] as const,
    };
  }
  return {
    command: "/bin/sh",
    args: ["-lc", command] as const,
  };
}

function commandFailureDetail(input: {
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
}): string {
  if (input.timedOut) {
    return "Hook command timed out.";
  }
  const stderr = input.stderr.trim();
  return stderr.length > 0 ? stderr : `Hook command exited with code ${input.code ?? "unknown"}.`;
}

export const make = Effect.fn("T3HookRunner.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const warnedUnsupportedEvents = new Set<string>();

  const findConfigPath = Effect.fn("T3HookRunner.findConfigPath")(function* (cwd: string) {
    let current = cwd;
    while (true) {
      const candidate = path.join(current, ".t3code", "hooks.json");
      const exists = yield* fileSystem.exists(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new T3HookConfigError({
              operation: "inspect",
              configPath: candidate,
              cause,
            }),
        ),
      );
      if (exists) {
        return Option.some(candidate);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return Option.none();
      }
      current = parent;
    }
  });

  const readConfig = Effect.fn("T3HookRunner.readConfig")(function* (configPath: string) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new T3HookConfigError({
            operation: "read",
            configPath,
            cause,
          }),
      ),
    );
    const config = yield* decodeHooksConfigJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new T3HookConfigError({
            operation: "decode",
            configPath,
            cause,
          }),
      ),
    );
    for (const entry of config.hooks.PreToolUse ?? []) {
      if (entry.matcher) {
        yield* Effect.try({
          try: () => new RegExp(`^(?:${entry.matcher})$`),
          catch: (cause) =>
            new T3HookConfigError({
              operation: "matcher",
              configPath,
              cause,
            }),
        });
      }
    }

    const declaredEvents = yield* decodeHooksConfigEventKeysJson(raw).pipe(
      Effect.map((decoded) => Object.keys(decoded.hooks)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );
    const unsupportedEvents = declaredEvents
      .filter((event) => !SUPPORTED_HOOK_EVENTS.some((supported) => supported === event))
      .sort();
    if (unsupportedEvents.length > 0) {
      const warningKey = [configPath, ...unsupportedEvents]
        .map((part) => `${part.length}:${part}`)
        .join("");
      if (!warnedUnsupportedEvents.has(warningKey)) {
        warnedUnsupportedEvents.add(warningKey);
        yield* Effect.logWarning("ignoring unsupported T3 hook events", {
          path: configPath,
          unsupportedEvents,
          supportedEvents: SUPPORTED_HOOK_EVENTS,
        });
      }
    }

    return config;
  });

  const runCommand = Effect.fn("T3HookRunner.runCommand")(function* (input: {
    readonly command: HookCommandConfig;
    readonly configPath: string;
    readonly projectDirectory: string;
    readonly payload: T3PreToolUseInput;
  }) {
    const expanded = expandProjectDirectory(input.command.command, input.projectDirectory);
    const invocation = commandInvocation(platform, expanded);
    const result = yield* processRunner
      .run({
        command: invocation.command,
        args: invocation.args,
        cwd: input.projectDirectory,
        stdin: encodePreToolUsePayloadJson({
          hook_event_name: "PreToolUse",
          provider: input.payload.provider,
          thread_id: input.payload.threadId,
          cwd: input.payload.cwd,
          tool_name: input.payload.toolName,
          tool_input: input.payload.toolInput,
        }),
        env: {
          T3_PROJECT_DIR: input.projectDirectory,
          CLAUDE_PROJECT_DIR: input.projectDirectory,
        },
        timeout: `${input.command.timeoutSeconds ?? input.command.timeout ?? 60} seconds`,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause: ProcessRunError) =>
            new T3HookCommandError({
              command: expanded,
              configPath: input.configPath,
              detail: cause.message,
              cause,
            }),
        ),
      );

    if (result.code === 2) {
      return {
        decision: "deny",
        reason: commandFailureDetail(result),
      } satisfies T3HookDecision;
    }
    if (result.code !== 0 || result.timedOut) {
      return yield* new T3HookCommandError({
        command: expanded,
        configPath: input.configPath,
        detail: commandFailureDetail(result),
      });
    }
    const stdout = result.stdout.trim();
    if (stdout.length === 0) {
      return { decision: "allow" } satisfies T3HookDecision;
    }
    const output = yield* decodeHookCommandOutputJson(stdout).pipe(
      Effect.mapError(
        (cause) =>
          new T3HookCommandError({
            command: expanded,
            configPath: input.configPath,
            detail: "Hook command returned invalid JSON.",
            cause,
          }),
      ),
    );
    return normalizedDecision(output);
  });

  const evaluateEntries = Effect.fn("T3HookRunner.evaluateEntries")(function* (input: {
    readonly entries: ReadonlyArray<HookMatcherConfig>;
    readonly configPath: string;
    readonly projectDirectory: string;
    readonly payload: T3PreToolUseInput;
  }) {
    for (const entry of input.entries) {
      if (!matchesTool(entry.matcher, input.payload.toolName)) {
        continue;
      }
      for (const command of entry.hooks) {
        const decision = yield* runCommand({
          command,
          configPath: input.configPath,
          projectDirectory: input.projectDirectory,
          payload: input.payload,
        });
        if (decision.decision !== "allow") {
          return decision;
        }
      }
    }
    return { decision: "allow" } satisfies T3HookDecision;
  });

  const resolvePlanState = Effect.fn("T3HookRunner.resolvePlanState")(function* (cwd: string) {
    const configPathOption = yield* findConfigPath(cwd);
    if (Option.isNone(configPathOption)) {
      return {
        configPath: undefined,
        entries: [] as ReadonlyArray<HookMatcherConfig>,
        projectDirectory: undefined,
      };
    }

    const configPath = configPathOption.value;
    const config = yield* readConfig(configPath);
    return {
      configPath,
      entries: config.hooks.PreToolUse ?? ([] as ReadonlyArray<HookMatcherConfig>),
      projectDirectory: path.dirname(path.dirname(configPath)),
    };
  });

  const prepare: T3HookRunner["Service"]["prepare"] = Effect.fn("T3HookRunner.prepare")(
    function* (cwd) {
      const snapshot = yield* resolvePlanState(cwd);
      const snapshotHasHooks = snapshot.entries.length > 0;
      return {
        configPath: snapshot.configPath,
        hasPreToolUseHooks: snapshotHasHooks,
        hasPreToolUseHooksNow: resolvePlanState(cwd).pipe(
          Effect.map((state) => state.entries.length > 0),
          Effect.catchTag("T3HookConfigError", (error) =>
            logConfigFailure(error).pipe(Effect.as(true)),
          ),
        ),
        evaluatePreToolUse: (input) =>
          Effect.gen(function* () {
            const state = yield* resolvePlanState(cwd);
            if (state.configPath === undefined) {
              return { decision: "allow" } satisfies T3HookDecision;
            }
            return yield* evaluateEntries({
              entries: state.entries,
              configPath: state.configPath,
              projectDirectory: state.projectDirectory,
              payload: { ...input, cwd },
            });
          }).pipe(
            Effect.catchTag("T3HookConfigError", (error) =>
              logConfigFailure(error).pipe(
                Effect.as({
                  decision: "ask",
                  title: "T3 hook config failed",
                  reason: `T3 project hooks could not be loaded from ${error.configPath}.`,
                } satisfies T3HookDecision),
              ),
            ),
          ),
      } satisfies T3HookPlan;
    },
  );

  return T3HookRunner.of({ prepare });
});

export const layer = Layer.effect(T3HookRunner, make());
