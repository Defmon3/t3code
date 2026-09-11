# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

New threads start in **Full access** unless you choose another mode before sending. A thread
created from another thread inherits its mode.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, and Cursor; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking.

For Grok, **Always allow this session** remembers the matching command or tool input. Other
actions still require approval.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Use **Full access** for work in a worktree or a sandbox you can throw away.

Use **Supervised** on a repository where an unwanted command is expensive, or the first time you
run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## Provider Behavior

Each provider maps these modes onto its own approval and sandbox settings. Codex, for example,
translates the mode into its approval policy and sandbox level, so **Supervised** runs the CLI
with prompting enabled and a restricted workspace while **Full access** disables both. Grok
threads do the same: **Supervised** starts Grok in ask mode even if your Grok CLI config is
set to always-approve, and **Full access** starts Grok with always-approve. The labels above
describe what you get; the exact per-provider translation is internal and may change.

Mobile offers the same four modes with the same labels and descriptions.

## Project Hooks

Claude and Codex threads can add project-specific checks with
`.t3code/hooks.json`. T3 Code searches from the thread working directory toward the filesystem
root and uses the first configuration it finds.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${T3_PROJECT_DIR}/.t3code/check-tool.js\"",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${T3_PROJECT_DIR}/.t3code/confirm-stop.js\""
          }
        ]
      }
    ]
  }
}
```

The matcher is a regular expression over the normalized tool names exposed by the active provider;
examples include `Bash`, `Read`, `Edit`, and `Write`, but availability varies by provider.
`PreToolUse` commands receive JSON on standard input with `provider`,
`thread_id`, `cwd`, `tool_name`, and `tool_input`. `Stop` commands receive `provider`, `thread_id`,
`cwd`, and `hook_event_name` after a root agent turn finishes normally. T3 Code also sets
`T3_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` to the directory that contains `.t3code`.

A Codex `PreToolUse` `Edit` hook receives the native approval fields in `tool_input`, plus
`tool_input.changes`, for example `[ {"path":"package.json","kind":{"type":"update"}} ]`.
Each entry keeps the original path and omits its diff. If Codex does not report changed files, T3
asks for approval with the reason `Changed files unknown.`

A hook can return a small T3 response:

```json
{
  "decision": "ask",
  "title": "Push protected branch?",
  "description": "This command updates a shared remote branch.",
  "reason": "Project policy requires confirmation for git push."
}
```

`decision` can be `allow`, `ask`, or `deny`. Claude-compatible `hookSpecificOutput` responses are
also accepted. Empty output with exit code 0 allows the tool; exit code 2 denies it and uses
standard error as the reason. Other script failures are shown as an approval instead of being
silently ignored.

In **Full access**, Codex keeps native command, file-change, and MCP approvals disabled. Its
native requests do not create provider permission cards, and `.t3code` hooks do not enable them.

**Live changes.** T3 Code re-reads `.t3code/hooks.json` before every hook check, so edits do not
need a restart. In a Claude thread, creating, editing, or deleting the file affects the very next
tool call. In a Codex thread, `.t3code` hooks do not enable provider approvals in **Full access**.

**Supported events.** `PreToolUse` runs before matching tool calls. `Stop` runs once after a root
Claude or Codex turn finishes normally; an `ask` response keeps the turn open until the user
accepts or declines the confirmation. Child-agent completion, interruption, and shutdown do not
run `Stop`. Other event names copied from a Claude hooks file (such as `PostToolUse`) never run and
are reported once as a warning in the T3 Code server log, naming the file and the ignored events.

**Unreadable config.** If the file becomes unreadable or invalid while a thread is running, the
affected tool call turns into an approval prompt rather than being allowed silently, and the
problem is reported in the T3 Code server log. In a Codex thread that started without hooks, those
prompts begin with the next message you send, like any other change to whether the project has
hooks.
Use **Full access** for work in a worktree or a sandbox you can throw away.

Use **Supervised** on a repository where an unwanted command is expensive, or the first time you
run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## Provider Behavior

Each provider maps these modes onto its own approval and sandbox settings. Codex, for example,
translates the mode into its approval policy and sandbox level, so **Supervised** runs the CLI
with prompting enabled and a restricted workspace while **Full access** disables both. Grok
threads do the same: **Supervised** starts Grok in ask mode even if your Grok CLI config is
set to always-approve, and **Full access** starts Grok with always-approve. The labels above
describe what you get; the exact per-provider translation is internal and may change.

Mobile offers the same four modes with the same labels and descriptions.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.

## Custom hook approvals

Independent custom HTTP hooks can request approval in T3 even when a thread uses **Full access**.
They use a separate bridge from `.t3code` hooks and do not change the provider's permission mode.
Install a hook that supports T3 approvals on each server where you run agents. The hook decides
which actions need confirmation.

The approval controls in the relevant thread identify the command and scope
without blocking the rest of T3. **Allow** permits one request. **Allow for this session** remembers
the scope shown by the hook, such as Git commits in one repository, while other
scopes still require approval. It is available only when the hook supplies a
scope. **Deny** blocks the request. Hooks continue to enforce their explicit
blocks after a session allowance.

OpenCode does not currently support custom hook approvals.

You can respond from a connected remote client. Session allowances end when the
agent session stops or restarts. A request left unanswered for five minutes is
denied.
