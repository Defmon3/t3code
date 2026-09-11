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

See the [provider guides](./install.md#providers) for setup and provider-specific limits.

## Custom hook approvals

Custom hooks can request approval in T3 even when a thread uses **Full access**.
Install a hook that supports T3 approvals on each server where you run agents. The
hook decides which actions need confirmation.

The approval controls in the relevant thread identify the command and scope
without blocking the rest of T3. **Allow** permits one request. **Allow for this session** remembers
the scope shown by the hook, such as Git commits in one repository, while other
scopes still require approval. It is available only when the hook supplies a
scope. **Deny** blocks the request. Hooks continue to enforce their explicit
blocks after a session allowance.

Pending custom hook approvals mark their requesting thread in the sidebar, and the global approval indicator opens that thread.

OpenCode does not currently support custom hook approvals.

You can respond from a connected remote client. Session allowances end when the
agent session stops or restarts. A request left unanswered for five minutes is
denied.
