# Plan: Solidify the in-app project-hook system

## ERRATA — 2026-08-13

DISK WINS over contradicting prescriptions below. `T3HookPlan.hasPreToolUseHooksNow` resolves to
`true` when live config resolution fails, regardless of the prepare-time snapshot, so Codex keeps
routing approvals through the fail-closed hook path. The focused runner coverage also includes
deleting `.t3code/hooks.json` after `prepare`.

**Branch:** `feat/in-app-hook-confirmation` (worktree `G:/t3-code/worktrees/t3-hook-confirmation`, HEAD `8a9f99719`)
**Shape:** one reversible commit, server-only, 8 files.

## Goal

Make `.t3code/hooks.json` behave like a live project config instead of a session-spawn snapshot, and stop silently swallowing hook event keys the runner does not implement. After this change: (a) `T3HookPlan.evaluatePreToolUse` re-resolves the config from disk on every evaluation, so a hooks file that is created, edited, or deleted mid-session changes the next tool decision without a session restart — for Claude threads on the very next tool call, for Codex threads on the next tool approval, with Codex's approval *routing* (`approvalPolicy`) recomputed at the start of each turn; (b) a config whose `hooks` object contains event names other than `PreToolUse` emits exactly one `Effect.logWarning` per distinct (config path, unsupported-key-set) through the server logger, naming the ignored events. Testable via `apps/server/src/hooks/T3HookRunner.test.ts` (live re-read, live `hasPreToolUseHooksNow`, warning emitted once) and `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts` (`buildTurnStartParams` policy mapping both ways).

## Locks

Frozen after investigation. The executing agent chooses nothing.

1. **Staleness mechanism = unconditional re-resolve per evaluation. No mtime check, no cache, no TTL, no watcher.** Every `evaluatePreToolUse` call re-walks from `cwd` for `.t3code/hooks.json` and re-reads/decodes it. Rationale: hook evaluation already spawns a child process (tens of ms); a walk-up of `fileSystem.exists` plus one small `readFileString` is noise next to that, and it removes an entire class of invalidation bugs. A full re-walk (not just re-reading a remembered `configPath`) is required so that *creating* the file mid-session is picked up.
2. **`ClaudeAdapter.ts` changes are limited to one edit: the no-hook-runner fallback literal inside `getHookPlan` (the object `satisfies T3HookPlan`) gains `hasPreToolUseHooksNow: Effect.succeed(false)`.** Nothing else in the file is touched. The `hookPlans` Map caches only a closure over `cwd`; `ClaudeAdapter` reads nothing but `plan.evaluatePreToolUse` from it, so once evaluation is live the cache is harmless. `prepare` still runs once per cwd per adapter lifetime.
3. **New plan member: `readonly hasPreToolUseHooksNow: Effect.Effect<boolean>`** on `T3HookPlan` — required (not optional), never fails; on a config error it resolves to the snapshot `hasPreToolUseHooks` value taken at `prepare` time. This is the only interface change.
4. **Per-provider semantics, stated as-is in the docs:**
   - **Claude** (`ClaudeAdapter` `canUseTool`): fully live. Creating, editing, or deleting `.t3code/hooks.json` affects the next tool call in an already-running full-access session.
   - **Codex**: hook *content* (commands, matchers, decisions) is live for every approval. Whether Codex routes approvals to us at all is `approvalPolicy`, which is sent both at `openCodexThread` and again in every `buildTurnStartParams`; therefore `interceptApprovals` is recomputed once per `sendTurn` from `hasPreToolUseHooksNow`. Practical consequence: enabling hooks mid-session takes effect from the **next user message** in that thread, not mid-turn. The spawn-time value stays a snapshot for the `start` path only.
5. **Warning channel = `Effect.logWarning` from inside `T3HookRunner`,** i.e. the server logger (`apps/server/src/serverLogger.ts`), matching the two existing project-config precedents: `apps/server/src/project/T3ProjectFileLoader.ts` and `apps/server/src/keybindings.ts` ("ignoring invalid keybinding entry"). No new contract type, no `ServerConfigIssue` (that type is keybindings-only, 2 call sites, and reusing it would mean a new UI surface), no thread event, no approval-prompt hijack.
6. **Exact warning call:**
   `Effect.logWarning("ignoring unsupported T3 hook events", { path: configPath, unsupportedEvents, supportedEvents: ["PreToolUse"] })` where `unsupportedEvents` is the sorted array of keys of the raw `hooks` object minus `"PreToolUse"`. (`Effect.logWarning` is variadic — extra args become message parts, per `effect@4.0.0-beta.103`.)
7. **Warning dedupe key** = `` `${configPath}|${unsupportedEvents.join(",")}` `` held in a `Set<string>` created inside `T3HookRunner.make` (per service instance, i.e. per driver instance). Editing the file to add another unsupported key warns again; re-reading the same file on every tool call does not.
8. **Unsupported-key detection** reuses the same lenient parse, via a second schema decoded from the same raw string:
   `const HooksConfigEventKeys = Schema.Struct({ hooks: Schema.Record(Schema.String, Schema.Unknown) })` wrapped in `fromLenientJson`. If this secondary decode fails, skip the warning silently (the primary decode already governs correctness). `Schema.Record(Schema.String, Schema.Unknown)` is established in this codebase (`apps/server/src/vcs/GitVcsDriverCore.ts`).
9. **`evaluatePreToolUse`'s error channel stays `T3HookCommandError`.** A `T3HookConfigError` raised by the *live* re-resolve is converted inside the plan to a fail-closed decision:
   `{ decision: "ask", title: "T3 hook config failed", reason: \`T3 project hooks could not be loaded from ${error.configPath}.\` }`.
   Reason for the lock: both adapters already `Effect.catch` into an "ask", so no call-site type ripple, and the user gets a readable prompt instead of a bare error string.
10. **`prepare` keeps its current failure behavior** (`T3HookConfigError`): Codex still fails `startSession` on a malformed config at spawn, Claude still turns a first-call failure into an "ask". Not touched.
11. **`hasPreToolUseHooks` and `configPath` on the plan remain spawn-time snapshots** and keep their current meaning; only new code reads `hasPreToolUseHooksNow`.
12. **Test commands** (targeted only, per AGENTS.md — no repo-wide checks):
    `vp test run apps/server/src/hooks/T3HookRunner.test.ts apps/server/src/provider/Layers/CodexSessionRuntime.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts` and `pnpm --filter t3 typecheck`.

## Do

Ordered. Anchors are symbols, not line numbers.

### 1. `apps/server/src/hooks/T3HookRunner.ts` — schema + warning

1. Below the existing `HooksConfigJson` / `decodeHooksConfigJson` declarations, add:
   - `const HooksConfigEventKeys = Schema.Struct({ hooks: Schema.Record(Schema.String, Schema.Unknown) })`
   - `const decodeHooksConfigEventKeysJson = Schema.decodeUnknownEffect(fromLenientJson(HooksConfigEventKeys))`
   - `const SUPPORTED_HOOK_EVENTS = ["PreToolUse"] as const`
2. In `make`, next to the other `yield*`-ed services, add `const warnedUnsupportedEvents = new Set<string>()`.
3. In `readConfig`, after the existing `decodeHooksConfigJson` step and the matcher-validation loop, add a best-effort block: decode `raw` with `decodeHooksConfigEventKeysJson`, on failure do nothing (`Effect.option` / `Effect.orElseSucceed(() => undefined)` — use whichever matches the file's existing Effect style), otherwise compute `unsupportedEvents = Object.keys(keys.hooks).filter((key) => !SUPPORTED_HOOK_EVENTS.includes(key)).sort()`; if non-empty and the dedupe key (Lock 7) is not in `warnedUnsupportedEvents`, add it and `yield*` the warning from Lock 6. `readConfig` keeps returning the primary decoded config.

### 2. `apps/server/src/hooks/T3HookRunner.ts` — live resolution

4. Add a private helper `resolvePlanState` (`Effect.fn("T3HookRunner.resolvePlanState")`) taking `cwd`, which does what `prepare` does today: `findConfigPath`, and on `Option.none` return `{ configPath: undefined, entries: [] as ReadonlyArray<HookMatcherConfig>, projectDirectory: undefined }`; otherwise `readConfig` and return `{ configPath, entries: config.hooks.PreToolUse ?? [], projectDirectory: path.dirname(path.dirname(configPath)) }`. Error channel `T3HookConfigError`. Place it after `evaluateEntries`.
5. Rewrite `prepare` to: call `resolvePlanState(cwd)` once for the snapshot, then return a single `T3HookPlan` (no more two return shapes) with
   - `configPath: snapshot.configPath`, `hasPreToolUseHooks: snapshot.entries.length > 0`
   - `hasPreToolUseHooksNow`: `resolvePlanState(cwd)` mapped to `state.entries.length > 0`, with `Effect.catch(() => Effect.succeed(snapshotHasHooks))`
   - `evaluatePreToolUse: (input) =>` `resolvePlanState(cwd)` then: if `state.configPath === undefined` → `{ decision: "allow" }`; else `evaluateEntries({ entries: state.entries, configPath: state.configPath, projectDirectory: state.projectDirectory, payload: { ...input, cwd } })`; with `Effect.catchTag("T3HookConfigError", ...)` (or the file's equivalent) producing the Lock 9 "ask" decision. `T3HookCommandError` still propagates.
6. Update the `T3HookPlan` interface: add `readonly hasPreToolUseHooksNow: Effect.Effect<boolean>`; leave `evaluatePreToolUse`'s signature unchanged.

### 3. `apps/server/src/provider/Layers/ClaudeAdapter.ts` — fallback literal only

7. In `getHookPlan`, the no-`hookRunner` fallback object (`satisfies T3HookPlan`) gains `hasPreToolUseHooksNow: Effect.succeed(false)`. This is the entire edit to this file (Lock 2).

### 4. `apps/server/src/provider/Layers/CodexSessionRuntime.ts` — per-turn approval routing

8. At the `allowHookApprovalsForSessionRef` / `interceptApprovals` declarations inside `makeCodexSessionRuntime`, rename the const to `interceptApprovalsAtStart` (same initializer: `options.hookPlan?.hasPreToolUseHooks === true`). Update its single use in the `start` path's `openCodexThread({ ..., interceptApprovals })` call to pass `interceptApprovalsAtStart`.
9. In `sendTurn`, immediately before the `buildTurnStartParams` call, add
   `const interceptApprovals = options.hookPlan ? yield* options.hookPlan.hasPreToolUseHooksNow : false;`
   and keep passing `interceptApprovals` into `buildTurnStartParams` as it does today. Nothing else in the runtime changes — `evaluatePreToolUseHook`, the two approval handlers, and the `acceptForSession` ref are untouched.

### 5. Tests

10. `apps/server/src/hooks/T3HookRunner.test.ts` — add three `it.layer(testLayer(...))` blocks in the existing style (real temp dirs via `fileSystem.makeTempDirectoryScoped`, stubbed `ProcessRunner`):
    - **creation after prepare**: prepare on a temp dir with no config (assert `configPath === undefined`, `hasPreToolUseHooks === false`), then write `.t3code/hooks.json` with a `Bash` matcher; assert `yield* plan.hasPreToolUseHooksNow` is `true` and `evaluatePreToolUse({ toolName: "Bash", ... })` returns the stub's `deny` (stub: exit code 2, stderr reason).
    - **edit after prepare**: config initially matches `Bash`; first evaluate returns `ask`; rewrite the file with `matcher: "Write"`; second evaluate returns `{ decision: "allow" }` and the run counter stays at 1.
    - **unsupported events**: config with `PreToolUse` plus `PostToolUse` and `Stop`; capture logs with `Logger.make(({ logLevel, message }) => ...)` provided via `Logger.layer([logger], { mergeWithExisting: false })` (precedent: `apps/server/src/diagnostics/TraceDiagnostics.test.ts`, `apps/server/src/cli/connect.test.ts`); run `prepare` + two `evaluatePreToolUse` calls; assert exactly one captured `Warn` record whose `JSON.stringify(message)` contains `PostToolUse` and `Stop`, and that the `PreToolUse` hook still ran.
11. `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts` — in the existing `describe("buildTurnStartParams")`, next to "requests callbacks for T3 hooks without reducing full-access sandboxing", add a case asserting `interceptApprovals: false` in `full-access` yields `approvalPolicy === "never"` with `sandboxPolicy` `{ type: "dangerFullAccess" }` (guards the downgrade half of the per-turn recomputation).
12. `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` — in the `hookRunner` stub of "runs T3 project hooks before full-access Claude tools", add `hasPreToolUseHooksNow: Effect.succeed(true)` to the object returned by `prepare` so the `satisfies T3HookRunner["Service"]` stays valid. No assertion changes.
13. `apps/server/src/provider/Layers/CodexAdapter.test.ts` — in the `hookPlan` literal of "loads T3 project hooks for full-access Codex sessions", add `hasPreToolUseHooksNow: Effect.succeed(true)`. The `NodeAssert.equal(runtimeFactory.lastRuntime?.options.hookPlan, hookPlan)` identity assertion still holds.

### 6. Docs

14. `docs/user/permission-modes.md`, "Project Hooks" section — append after the existing final paragraph ("Hook approvals appear only in the thread that triggered them…"), keeping the current prose intact:
    - **Live changes.** T3 Code re-reads `.t3code/hooks.json` before every hook check, so edits do not need a restart. In a Claude thread, creating, editing, or deleting the file affects the very next tool call. In a Codex thread, edits to hook commands and matchers apply to the next tool approval; adding hooks to a project that had none (or removing the last hook) changes how Codex routes approvals starting with the next message you send in that thread.
    - **Supported events.** Only `PreToolUse` runs. Other event names copied from a Claude hooks file (`PostToolUse`, `Stop`, and so on) never run and are reported once as a warning in the T3 Code server log, naming the file and the ignored events.
    - **Unreadable config.** If the file becomes unreadable or invalid while a thread is running, the affected tool call turns into an approval prompt rather than being allowed silently.

## Don't

- Don't change the hook decision protocol: stdout JSON shape, `hookSpecificOutput`, `decision`/`reason`/`title`/`description`, exit-code semantics (0 = allow, 2 = deny with stderr as reason, anything else = command error), or the `allow|ask|deny` vocabulary.
- Don't change the config file name/location (`.t3code/hooks.json`), the upward search, `CLAUDE_PROJECT_DIR`/`T3_PROJECT_DIR`, or the Claude-compatible payload field names.
- Don't add hook event types. `PostToolUse`/`Stop`/etc. get a warning and stay unimplemented.
- Don't broaden Codex tool coverage: the two approval handlers keep mapping command → `"Bash"` and fileChange → `"Edit"`.
- Don't touch permission-mode gating: hooks stay full-access-only in both adapters; other modes bypass them.
- Don't touch `apps/server/src/provider/Layers/ClaudeAdapter.ts` beyond the fallback-literal field (Lock 2), nor `CodexAdapter.ts`, `ClaudeDriver.ts`, `CodexDriver.ts`, or anything under `apps/web`.
- Don't fold `allowHookApprovalsForSessionRef` into the recomputed `interceptApprovals` in `sendTurn`. It looks tempting (after "Always allow this session" the untrusted policy is pure overhead), but it changes session semantics and is out of scope.
- Don't add a file watcher, a debounce, or a cache with invalidation. Fragile parts identified: (a) Codex's `approvalPolicy` is per-turn wire state — the runtime has no test harness for `sendTurn`, so keep the change to a single `yield*` next to the existing `buildTurnStartParams` call; (b) `prepare` failure semantics differ per provider (Codex fails `startSession`, Claude degrades to "ask") — leave both alone; (c) the warning fires from `readConfig`, which now runs on every tool call, so the dedupe Set is load-bearing — do not drop it.
- Don't add a new UI surface, contract type, thread event, or toast for the warning.

## Lanes

Single lane. Owned files:

- `apps/server/src/hooks/T3HookRunner.ts`
- `apps/server/src/hooks/T3HookRunner.test.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` (fallback literal field only)
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` (stub field only)
- `apps/server/src/provider/Layers/CodexAdapter.test.ts` (stub field only)
- `docs/user/permission-modes.md`

## Test intent

| Behavior | File | Layer |
| --- | --- | --- |
| Config created after `prepare` is picked up by `hasPreToolUseHooksNow` and by evaluation | `apps/server/src/hooks/T3HookRunner.test.ts` | service, real temp FS + stubbed `ProcessRunner` |
| Edited matcher takes effect on the next evaluation without re-`prepare` | `apps/server/src/hooks/T3HookRunner.test.ts` | same |
| Unsupported event keys warn once and don't suppress `PreToolUse` | `apps/server/src/hooks/T3HookRunner.test.ts` | same, plus captured `Logger` |
| `interceptApprovals: false` in full-access maps to `approvalPolicy: "never"` (downgrade half of the per-turn recompute) | `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts` | pure `buildTurnStartParams` |
| Existing hook approval flows unchanged | `ClaudeAdapter.test.ts`, `CodexAdapter.test.ts` | adapter; stub-field edits only, assertions untouched |

Known gap, accepted and stated rather than papered over: there is no harness for `makeCodexSessionRuntime.sendTurn` in this repo (`CodexAdapter.test.ts` stubs the runtime via `makeRuntime`, and `CodexSessionRuntime.test.ts` only exercises pure builders and `openCodexThread`), so the per-turn `hasPreToolUseHooksNow` read is covered by its two ends — the runner-level liveness tests and the params-level policy mapping — not end-to-end. Building such a harness is out of scope for this commit.

## Surface reach

- **Docs:** `docs/user/permission-modes.md` "Project Hooks" gains live-reload semantics (explicitly per provider), the supported-events statement, and the unreadable-config behavior. This is the only user-facing doc for hooks; nothing else references them.
- **Warning visibility:** server log via `Effect.logWarning` → `apps/server/src/serverLogger.ts`, the same place `t3.json` and keybindings config problems already surface. Users running the server see it in server output/logs; the message names the config path and the ignored events.
- **Approval UI:** unchanged. Hook-sourced approvals keep `approvalSource: "hook"`, `approvalTitle`, `approvalDescription`, `approvalReason` and the existing web rendering (`ComposerPendingApprovalPanel`, `Sidebar`) from commit `c439a7f3c`. A live config error now surfaces as an "ask" through that same existing path, so it gains reach rather than losing it.
- **Nothing loses reach:** no removed fields, no removed doc text, no changed event payloads, no changed decision vocabulary. The only new plan member (`hasPreToolUseHooksNow`) is internal to the server.

### Critical Files for Implementation
- G:/t3-code/worktrees/t3-hook-confirmation/apps/server/src/hooks/T3HookRunner.ts
- G:/t3-code/worktrees/t3-hook-confirmation/apps/server/src/hooks/T3HookRunner.test.ts
- G:/t3-code/worktrees/t3-hook-confirmation/apps/server/src/provider/Layers/ClaudeAdapter.ts
- G:/t3-code/worktrees/t3-hook-confirmation/apps/server/src/provider/Layers/CodexSessionRuntime.ts
- G:/t3-code/worktrees/t3-hook-confirmation/apps/server/src/provider/Layers/CodexSessionRuntime.test.ts
- G:/t3-code/worktrees/t3-hook-confirmation/docs/user/permission-modes.md
