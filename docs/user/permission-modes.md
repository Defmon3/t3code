# Permission Modes

A permission mode controls how much the agent does on its own and when it stops to ask you.

The mode is set per thread, from the mode control in the message composer. Changing it in one
thread does not change any other thread. A thread created from inside another thread keeps that
thread's mode; otherwise new threads start in **Full access** unless you pick something else
before sending.

## The Modes

**Supervised**: ask before commands and file changes. The agent pauses and shows you what it
wants to run or edit, and waits for approval. Work outside the workspace is restricted.

**Auto-accept edits**: auto-approve edits, ask before other actions. File changes go through
without prompting; commands and anything else still stop for approval.

**Auto**: routine actions proceed without you; risky ones still ask. How this is enforced depends
on the provider: Codex delegates routine approvals to an AI reviewer, Claude uses its own auto
permission mode, and providers without an equivalent (such as OpenCode) fall back to asking, like
Supervised.

**Full access**: allow commands and edits without prompts. The default. The agent runs
unattended until it finishes or asks a question of its own.

Approvals appear inline in the conversation. Approve or reject one and the agent continues from
there.

## Choosing a Mode

Use **Full access** for work in a worktree or a sandbox you can throw away.

Use **Supervised** on a repository where an unwanted command is expensive, or the first time you
run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## Provider Behavior

Each provider maps these modes onto its own approval and sandbox settings. Codex, for example,
translates the mode into its approval policy and sandbox level, so **Supervised** runs the CLI
with prompting enabled and a restricted workspace while **Full access** disables both. The
labels above describe what you get; the exact per-provider translation is internal and may
change.

Mobile offers the same four modes with the same labels and descriptions.

## Project Hooks

Claude and Codex threads can add project-specific checks to **Full access** with
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
    ]
  }
}
```

The matcher is a regular expression over T3's normalized tool names, such as `Bash`, `Read`,
`Edit`, and `Write`. Each command receives JSON on standard input with `provider`, `thread_id`,
`cwd`, `tool_name`, and `tool_input`. T3 Code also sets `T3_PROJECT_DIR` and
`CLAUDE_PROJECT_DIR` to the directory that contains `.t3code`.

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

Hook approvals appear only in the thread that triggered them. **Always allow this session** skips
later hook prompts for that provider session. Other permission modes keep their provider's built-in
protections and do not run T3 project hooks.

**Live changes.** T3 Code re-reads `.t3code/hooks.json` before every hook check, so edits do not
need a restart. In a Claude thread, creating, editing, or deleting the file affects the very next
tool call. In a Codex thread, edits to hook commands and matchers apply to the next tool approval;
adding hooks to a project that had none (or removing the last hook) changes how Codex routes
approvals starting with the next message you send in that thread.

**Supported events.** Only `PreToolUse` runs. Other event names copied from a Claude hooks file
(`PostToolUse`, `Stop`, and so on) never run and are reported once as a warning in the T3 Code
server log, naming the file and the ignored events.

**Unreadable config.** If the file becomes unreadable or invalid while a thread is running, the
affected tool call turns into an approval prompt rather than being allowed silently, and the
problem is reported in the T3 Code server log. In a Codex thread that started without hooks, those
prompts begin with the next message you send, like any other change to whether the project has
hooks.
