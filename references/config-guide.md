# Configuration Guide

## runtime-config.yml

```yaml
project:
  active: "my-project"       # folder name of the active project at repo root

storage:
  docs_dir: "docs"           # docs subfolder inside project folder

workflow:
  approval_required_for_implementation: true   # block DEV until approved
  use_documented_assumptions: true
  stop_on_open_questions: false                # true = move workflow to AWAITING_USER_INPUT until the questions are answered

reporting:
  daily_digest_enabled: true
  send_ceremony_updates: true
  auto_request_approval_after_discovery: true  # PM auto-triggers request-approval

openclaw:
  mode: "auto"
  adapter: "agent-cli"       # "agent-cli" | "stdio-json"
  command: "wsl"             # binary to invoke (wsl on Windows, openclaw on Linux)
  args: ["openclaw"]
  agent: "main"              # agent id for role turns
  cron_agent: "main"         # agent id for scheduled ceremonies
  local: false               # true = embedded local execution
  timeout_ms: 120000
  fallback_to_templates: true
  save_transcripts: true
  transcript_dir: "agent-turns"

scheduler:
  mode: "openclaw-cron"      # "openclaw-cron" | "direct-worker"
  job_prefix: "agent-orchestration-workflow:"
  direct_worker:
    state_file: ".openclaw/direct-scheduler-state.json"
    lock_file: ".openclaw/direct-scheduler.lock"
    lock_timeout_ms: 900000
    retry_count: 2
    retry_backoff_ms: 1000
    command_timeout_ms: 600000

failure_alerts:
  enabled: true
  mode: "webhook"            # "webhook" | "announce"
  to: ""                     # empty = auto-read from discord-config.yml
  after: 1                   # consecutive failures before alert
  cooldown: "1h"

validation:
  enabled: false             # true = run a project validation command after implementation writes files
  command: ""                # executable name, e.g. npm
  args: []                   # argument array, e.g. ["test", "--", "--runInBand"]
  cwd: "."                   # relative to the active project directory
  timeout_ms: 120000
```

When validation is enabled, implementation moves stories into `REVIEW` first, runs the validation command, and only marks stories `DONE` when validation passes and acceptance succeeds. Without validation, stories remain in `REVIEW` until they are manually confirmed.

## Scheduler Mode

Scheduler registration is now isolated behind a backend interface.

- `scheduler.mode: openclaw-cron` uses the existing OpenClaw cron registration path through `register-openclaw-cron.js` and `unregister-openclaw-cron.js`.
- `scheduler.mode: direct-worker` uses `direct-scheduler.js` to keep a file-backed job registry and execute ceremonies directly with Node instead of going through an OpenClaw cron agent.
- `scheduler.job_prefix` controls the scheduler job naming prefix so cleanup and re-registration use the same namespace consistently.
- `scheduler.direct_worker.*` controls the experimental worker's state file, lock file, retry policy, and command timeout.

In the current implementation, `openclaw.cron_agent` only applies when `scheduler.mode` is `openclaw-cron`.

### Direct Worker Commands

When `scheduler.mode` is `direct-worker`, use:

```bash
node .openclaw/direct-scheduler.js sync   # sync job definitions from ceremonies.yml into the local state file
node .openclaw/direct-scheduler.js list   # inspect registered direct-worker jobs
node .openclaw/direct-scheduler.js tick   # run all jobs due right now
node .openclaw/direct-scheduler.js run --ceremony standup
```

The direct worker applies a global lock, tracks the last run minute for each job, retries failures using the configured backoff, and stores execution metadata in the scheduler state file.

## Execution Health

The orchestrator records degraded agent turns in `docs/workflow-state.json` under `execution_health` and writes a human-readable summary to `docs/execution-health.md`.

- `openclaw` means the turn executed normally through the configured runner.
- `template_fallback` means the workflow continued with the built-in fallback output because the runner failed or was unavailable.
- `partial_parse_fallback` means the runner executed, but the returned output could not be parsed as the expected JSON shape.

Ceremony records also include an `execution_health` summary when any turn metadata is present.

## discord-config.yml

```yaml
discord:
  enabled: true
  transport: "webhook"
  webhook_env: "OPENCLAW_DISCORD_WEBHOOK"   # env var name
  webhook_url: ""                            # fallback hardcoded URL

  username: "OpenClaw PM"
  avatar_url: ""

  mention_targets:
    daily_digest: ""          # empty = no mention
    blocker_escalation: "@here"
    approval_required: "@here"

  routing:
    daily_activity_label: "daily-activity"
    blockers_label: "blockers"
    approvals_label: "approvals"

  message_settings:
    include_blockers: true
    include_next_steps: true
    max_bullets: 6
```

## agent-config.yml

Defines the 4 role personas. Each role has:
- `name` / `slug` / `model`
- `persona` — injected as system context for that role's turns
- `capabilities` — symbolic capability labels for maintainers and prompts. These are not auto-bound runtime tools; executable tools still come from the OpenClaw agent configuration and the orchestrator command handlers.

Roles: `pm`, `po`, `developer`, `qc`

## discovery-profile-templates.js

Domain-specific discovery defaults live in `assets/openclaw-template/discovery-profile-templates.js`.

- `DEFAULT_DISCOVERY_PROFILE` holds the generic fallback used when no domain template matches.
- `DISCOVERY_PROFILE_TEMPLATES` is empty by default so the shipped skill stays domain-neutral; maintainers can add optional domain overrides later if they need them.
- `orchestrator.js` matches templates by keyword and materializes the final discovery profile without expanding prompt size.

## ceremonies.yml

Each ceremony entry:
```yaml
ceremonies:
  daily_standup:
    name: "Daily Standup"
    command: "standup"                          # orchestrator.js command
    schedule: "cron('0 9 * * 1-5')"           # OpenClaw cron expression
    timezone: "Asia/Bangkok"
    preconditions:
      states: [READY_FOR_APPROVAL, IN_SPRINT]  # only fires in these states
    payload:
      kind: "agentTurn"
      message: |
        <prompt sent to the agent>
      model: "gpt-4"
      thinking: "low"                          # low | medium | high
    delivery:
      provider: "discord"
      route_label: "daily-activity"
      mention_target: "daily_digest"           # maps to discord-config mention_targets
```

## Agent Wiring

The orchestrator uses two agent IDs from `runtime-config.yml`:

```yaml
openclaw:
  agent: "scrum-pm"       # agent for live role turns (PO, DEV, QC, PM prompts)
  cron_agent: "scrum-pm"  # agent that executes scheduled ceremonies
```

Both are set automatically by `setup.js`. To change them later, edit the YAML and re-run:
```bash
node .openclaw/register-openclaw-cron.js
```

For `direct-worker` mode, sync jobs with:
```bash
node .openclaw/direct-scheduler.js sync
```

## Discord Bot — Manual Wiring

If you skipped the bot token during setup:

```bash
# 1. Register the Discord bot account
openclaw channels add --channel discord \
  --token <BOT_TOKEN> \
  --account scrum-<agent-id> \
  --name "Scrum PM"

# 2. Bind the agent to that account
openclaw agents bind \
  --agent <agent-id> \
  --bind discord:scrum-<agent-id>

# 3. Restart the gateway
openclaw gateway restart
```

Required bot permissions: Send Messages, Read Message History, View Channels
Required intents: Message Content Intent, Server Members Intent
