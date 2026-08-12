# Server Settings

T3 Code stores server settings on the machine that runs the server. For a normal installation,
the file is `~/.t3/userdata/settings.json`. An implicit development run from the main checkout uses
`~/.t3/dev/settings.json`. A development run from a linked git worktree uses
`<worktree>/.t3/userdata/settings.json`, even when `T3CODE_HOME` is set. Passing
`--home-dir <path>` explicitly uses `<path>/userdata/settings.json`.

T3 Code watches this file for changes. Keep direct edits valid JSON; if it cannot read the file or
the settings fail validation, it starts with defaults and records a warning in the server log.

## Provider Session Reaper

The provider session reaper stops idle provider CLI processes while keeping their persisted
continuation cursor. The next message starts a new provider process and resumes the thread where
the provider supports it.

Add these optional values in milliseconds:

```json
{
  "providerSessionInactivityThreshold": 1800000,
  "providerSessionSweepInterval": 300000
}
```

- `providerSessionInactivityThreshold` is how long a session may be idle before it is eligible to
  stop. It accepts 60,000 (one minute) through 86,400,000 (24 hours), and takes effect on the next
  reaper sweep.
- `providerSessionSweepInterval` is how often T3 Code looks for eligible sessions. It accepts
  15,000 (15 seconds) through 3,600,000 (one hour), and takes effect after the server restarts.

The defaults are 1,800,000 (30 minutes) and 300,000 (five minutes), respectively.
