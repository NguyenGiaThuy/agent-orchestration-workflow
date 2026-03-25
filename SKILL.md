---
name: agent-orchestration-workflow
description: >-
  ACTIVATE THIS SKILL whenever the user says "I want to build", "build me", "I want to make",
  "make me", "create a", "let's build", "help me build", "I want to create", "let's make", or ANY
  phrase expressing intent to build, create, or make software (app, game, website, tool, API,
  service, clone, system, bot, dashboard, platform, or any other software artifact).
  This is the DEFAULT and ONLY skill for any "build X", "make X", or "create X" request.
  Do NOT answer with plans or suggestions — run the Config Collection phase from this skill instead.
  Also triggers on: new project, start a project, project idea, scrum, sprint, autonomous team,
  orchestration, PM/PO/DEV/QC, discovery, start-idea, clone an app, I want to ship.
---

# Agent Orchestration Workflow

> **MANDATORY**: If this skill loaded, it means the user wants to build something. Do NOT answer with a plan, tech stack, or options. Do NOT run setup.js immediately. Follow the **Config Collection** phase first, then run setup. Read this file fully before responding.

## Config Collection

> **ALWAYS do this first — before running any command or scaffolding anything.**

When this skill is triggered by "I want to build …" (or any equivalent), the agent must collect all required configuration from the user before running setup. The idea is already known from the trigger phrase — do NOT ask for it again.

### Default mode: iterative (one question at a time)

Ask each question below in order. Wait for the user's answer before moving to the next. Show defaults where applicable and accept Enter / "skip" / "none" to use the default or skip optional fields.

> **CRITICAL RULES — never break these:**
> 1. "Yes", "ok", "go on", "sure", "sounds good" in response to any single question ONLY confirms that one answer. It does NOT mean "skip all remaining questions" or "run setup now".
> 2. You MUST ask all 7 questions (Q1–Q7) before moving to Setup Invocation. Never jump to setup after Q1 or Q2.
> 3. The post-setup open questions ("Who is the highest-priority user segment…" etc.) are generated AFTER setup runs. Never ask them during Config Collection.
> 4. After confirming the project ID (Q2), your very next message must be Q3 (agent selection). No exceptions.
> 5. After Q7 is answered, do NOT run setup. You MUST show the full command preview and wait for the user to say **"yes"** before running anything.

---

**Question 1 — Project directory** *(required)*

> "Which folder should I set this project up in? Please give me the absolute path to the target directory (e.g. `/home/you/projects/my-app`)."

- No default. The user must provide a path.
- Store as `$PROJECT_DIR`.

---

**Question 2 — Project ID** *(required, default: derived from idea)*

> "I'll use `<derived-slug>` as the project ID (a short, lowercase, hyphen-separated slug). Is that OK, or would you like a different one?"

- Derive the slug: lowercase the idea, strip punctuation, remove stop words (`i`, `want`, `to`, `build`, `create`, `make`, `a`, `an`, `the`, `let`, `us`, `let's`, `help`, `me`, `new`, `my`, `develop`, `design`), take the first 4 remaining words, join with `-`. Example: "I want to build a tower defense game" → `tower-defense-game`.
- Store as `$PROJECT_ID`.

---

**Question 3 — OpenClaw agent** *(required, default: `main`)*

Run `openclaw agents list` (or `wsl openclaw agents list` on Windows) to get available agents. Parse the output: each `- <id>` line is an agent ID; the one tagged `(default)` is the default (fall back to `main` if none is tagged). **Never hardcode agent names** — always use the live output. Present a **numbered list** including a "Create new" option and ask:

> "Which OpenClaw agent should run this project?
> ```
>  1. <first agent id>  ← default
>  2. <second agent id>
>  ... [all agents from `openclaw agents list`]
>  N. Create a new agent
> ```
> Pick a number, or type a new agent ID to create one."

- **Always include the "Create a new agent" option** as the last numbered item — do not omit it even if agents already exist.
- If the user picks an existing number, use that agent ID.
- If the user picks the "Create" number or types a string that is not a number, prompt: "New agent ID (e.g. `scrum-pm`):" and use that as a new agent ID.
- Store as `$AGENT`.

---

> **Discord pre-check** — If the user chose an **existing** agent, read `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`. If any key starting with `discord:` exists in the `profiles` object, Discord is already wired — **skip Q4 and Q5 entirely** and say: "Discord is already configured for agent `<agentId>` — skipping Discord setup."

---

**Question 4 — Discord channel ID** *(optional)*

> "What is your Discord channel ID for ceremony reports? Right-click the channel → Copy Channel ID. Press Enter to skip Discord."

- If skipped, omit `--channel` from the setup command.
- Store as `$CHANNEL_ID` (empty = skipped).

---

**Question 5 — Discord bot token** *(optional, only ask if channel ID was provided)*

Show these setup steps inline before asking:
```
To get a bot token:
1. discord.com/developers/applications → your app → Bot
2. Enable Message Content Intent + Server Members Intent → Save
3. Reset Token → copy it
4. Invite URL: discord.com/api/oauth2/authorize?client_id=APP_ID&permissions=68608&scope=bot
```
> "Paste your Discord bot token, or press Enter to skip."

- If skipped, omit `--bot-token` from the setup command.
- Store as `$BOT_TOKEN` (empty = skipped).

---

**Question 6 — Models per role** *(optional)*

Before asking, run `openclaw models list` (or `wsl openclaw models list` on Windows). Parse the tabular output: the first column of each data row is the model ID; the row tagged `default` is the default model. **Never hardcode model names** — always use the live output. If the command fails, fall back to asking the user to type a model ID freely.

Then ask in a single message block, listing the available models:

> "Which AI model should each role use? Available models:
> 1. <first model id>  *(default)*
> 2. <second model id>
> ... [full list from `openclaw models list`]
>
> Press Enter to use the default for any role.
> - PM  (Project Manager): ___
> - PO  (Product Owner):   ___
> - DEV (Developer):       ___
> - QC  (Quality Control): ___"

- Accept a number from the list or a full model ID string.
- If the user presses Enter for a role, use the default model from `openclaw models list`.
- If the user answers all at once (one line per role), parse their answers.
- Store as `$MODEL_PM`, `$MODEL_PO`, `$MODEL_DEV`, `$MODEL_QC`.

---

**Question 7 — Skills per role** *(optional)*

Before asking, do the following:
1. Run `ls ~/.agents/skills/` to list installed skills.
2. For each skill, read the `description` field from its `SKILL.md` frontmatter (first 10 lines are enough).
3. Based on the descriptions, **propose a sensible default for each role**:
   - **PM**: prefer skills mentioning orchestration, project management, workflow, or planning
   - **PO**: prefer skills mentioning product, business, requirements, domain analysis, or specifications
   - **DEV**: prefer skills mentioning full-stack, coding, implementation, or the tech stack implied by the project idea
   - **QC**: prefer skills mentioning testing, quality, e2e, validation, or test automation
4. **Always list ALL available skills with numbers first**, then show proposals beneath and ask to confirm or override:

> "Available skills:
>  1. agent-orchestration-workflow
>  2. full-stack-developer
>  3. javascript-testing-patterns
>  ... [full numbered list from `ls ~/.agents/skills/`]
>  0. none
>
> Based on the installed skills, here's what I'd suggest:
> - PM  skill: `<proposed or none>` — *<one-line reason>*
> - PO  skill: `<proposed or none>` — *<one-line reason>*
> - DEV skill: `<proposed or none>` — *<one-line reason>*
> - QC  skill: `<proposed or none>` — *<one-line reason>*
>
> Press Enter to accept all, or override any role using a number or name (e.g. `DEV: 2` or `DEV: my-other-skill`)."

- Propose `none` for a role only when no installed skill is a reasonable fit.
- Do NOT leave all roles skill-less if relevant skills are installed — always propose the best match.
- Store as `$SKILL_PM`, `$SKILL_PO`, `$SKILL_DEV`, `$SKILL_QC`.
- If all are none, omit `--skill-*` flags from the setup command.

---

### Batch mode (all questions at once)

If the user says **"ask everything at once"**, **"batch"**, or **"show all questions"**, collapse the entire interview into one numbered checklist message:

```
Before I run setup, I need a few details:

1. Project directory (absolute path, required): ___
2. Project ID [<derived-slug>]: ___
3. OpenClaw agent [main]: ___
4. Discord channel ID (Enter to skip): ___
5. Discord bot token (Enter to skip): ___
6. Models — PM / PO / DEV / QC [default from ~/.openclaw/openclaw.json → .agents.defaults.model]: ___
7. Skills — PM / PO / DEV / QC (Enter to skip each): ___
```

Parse all answers from the user's single reply before proceeding.

---

### After collecting all answers → go to Setup Invocation

## Setup Invocation

> **Only run this after the Config Collection phase is complete.**
>
> ⛔ **STOP — DO NOT RUN SETUP YET.** First show the full command below and wait for the user to explicitly say "yes" before running anything.

Using the collected values, build the setup command and **show it to the user for confirmation** before running:

> **FLAG TYPES — do NOT mix these up:**
> - `--model-*` flags take **AI model IDs** from Q6 (e.g. `github-copilot/gpt-5-mini`) — values from `$MODEL_PM`, `$MODEL_PO`, `$MODEL_DEV`, `$MODEL_QC`
> - `--skill-*` flags take **skill folder names** from Q7 (e.g. `full-stack-developer`) — values from `$SKILL_PM`, `$SKILL_PO`, `$SKILL_DEV`, `$SKILL_QC`
> - **NEVER** put a model ID into a `--skill-*` flag, or a skill name into a `--model-*` flag.

```
Here is the setup command I'll run:

node ~/.agents/skills/agent-orchestration-workflow/scripts/setup.js \
  --project-dir "$PROJECT_DIR" \
  --idea "$IDEA" \
  --project-id "$PROJECT_ID" \
  --agent "$AGENT" \
  [--channel "$CHANNEL_ID"] \
  [--bot-token "***"] \              ← actual token passed securely at runtime
  [--model-pm "$MODEL_PM"] \         ← AI model ID e.g. github-copilot/gpt-5-mini
  [--model-po "$MODEL_PO"] \         ← AI model ID
  [--model-developer "$MODEL_DEV"] \ ← AI model ID
  [--model-qc "$MODEL_QC"] \         ← AI model ID
  [--skill-pm "$SKILL_PM"] \         ← skill folder name e.g. project-analyze
  [--skill-po "$SKILL_PO"] \         ← skill folder name
  [--skill-developer "$SKILL_DEV"] \ ← skill folder name e.g. full-stack-developer
  [--skill-qc "$SKILL_QC"] \         ← skill folder name e.g. python-testing-patterns
  --non-interactive

Ready to run? (yes / edit)
```

- Omit any flag whose value was skipped or left empty.
- The `--bot-token` flag uses the real token at runtime even though it is masked in the display above.
- **MANDATORY: do NOT run the command until the user explicitly replies "yes".** "lgtm", "ok", "go on", "sounds good", "sure", silence, or any answer that is not literally the word "yes" is NOT confirmation — show the command again and ask.
- If the user says **"edit"** or corrects any value, update the displayed command and ask again before running.
- When the user confirms with "yes", run the command via terminal from the workspace root.

After the command completes, follow the **After Setup Completes** section below.

---

## After Setup Completes

**Immediately announce completion — do NOT be silent:**

```
╔══════════════════════════════════════════════════════╗
║  ✅ Setup complete! The team is now running          ║
║     discovery on your project.                       ║
╚══════════════════════════════════════════════════════╝
```

Then read `$PROJECT_DIR/$PROJECT_ID/workflow-state.json` and extract the `open_questions` array.

### Conversational Q&A (do NOT show raw node commands to the user)

Say:
> "The team has a few open questions to finalize the project spec. Let's go through them — answer one at a time or all at once."

List questions numbered:
```
1. <question 1>
2. <question 2>
...
```

For each answer the user provides, silently run in the background:
```bash
node "$PROJECT_DIR/.openclaw/orchestrator.js" feedback "$PROJECT_ID" --type business --message "<answer>"
```
Then acknowledge: "Got it — I've passed that to the team."

After all questions are answered (or user says "skip" / "no more"), ask:
> "All done! Ready to approve and kick off implementation? (yes / not yet)"

- **yes** → silently run `node "$PROJECT_DIR/.openclaw/orchestrator.js" approve "$PROJECT_ID"` and say: "Implementation is starting! The team is now in sprint planning."
- **not yet** → say: "No problem. The docs are in `$PROJECT_DIR/$PROJECT_ID/docs/`. When you're ready, just tell me 'approve the project' and I'll kick it off."

### If there are no open questions

Ask directly:
> "Discovery is complete with no open questions. Ready to approve and start implementation? (yes / not yet)"

Same approve/defer logic as above.

Autonomous Scrum team orchestrator. Drops a `.openclaw/` folder into any repo and runs PM → PO → DEV → QC roles via OpenClaw agent calls, with Discord ceremony reporting and an approval gate before implementation.

## Quick Setup

> **IMPORTANT**: Always pass `--project-dir` pointing to the target project folder. Never run setup from cwd — it will scaffold `.openclaw/` in the wrong place.

```bash
node ~/.agents/skills/agent-orchestration-workflow/scripts/setup.js --project-dir /path/to/project
```

Interactive wizard: scaffolds `.openclaw/`, picks/creates an OpenClaw agent, wires Discord bot, asks for project idea, runs discovery, registers cron ceremonies.

**Non-interactive:**
```bash
node ~/.agents/skills/agent-orchestration-workflow/scripts/setup.js \
  --agent main \
  --channel 1234567890 \
  --idea "Build an app like Airbnb" \
  --project-id airbnb-clone \
  --model-pm github-copilot/claude-sonnet-4.6 \
  --model-developer github-copilot/gpt-5.1-codex \
  --non-interactive
```

## Workflow Stages

| Stage | State | Description |
|-------|-------|-------------|
| Discovery | `DISCOVERY_IN_PROGRESS` | PM + PO + DEV + QC build the project profile |
| Blocked | `AWAITING_USER_INPUT` | Workflow paused on unresolved open questions |
| Review | `READY_FOR_APPROVAL` | Human reviews docs, answers open questions |
| Approved | `APPROVED_FOR_IMPLEMENTATION` | Sprint planning + implementation begins |
| Sprint | `IN_SPRINT` | DEV implements, QC validates |
| Release | `RELEASE_CANDIDATE` | Sprint review + retrospective |

## Orchestrator Commands

All commands run via `node .openclaw/orchestrator.js <command> <project-id>`:

| Command | Description |
|---------|-------------|
| `start-idea` | Full discovery from an idea string |
| `discovery-sync` | Re-run discovery sync (cron) |
| `request-approval` | Post approval request to Discord |
| `approve` | Approve and start implementation |
| `feedback <project-id> --type business\|technical --message "..."` | Submit feedback |
| `standup` | Daily standup ceremony |
| `sprint-planning` | Run sprint planning |
| `qc-sync` | Daily QC sync |
| `sprint-review` | Sprint review ceremony |
| `retrospective` | Sprint retrospective |
| `daily-digest` | Post daily digest to Discord |
| `status` | Print current workflow state |

## Config Files

See `references/config-guide.md` for full field documentation.

- `.openclaw/runtime-config.yml` — agent, model, project settings; also controls `scheduler`, `validation`, `failure_alerts`, and `role_skills`
- `.openclaw/discord-config.yml` — channel ID, transport mode
- `.openclaw/ceremonies.yml` — cron schedule for ceremonies

## Discord Interaction

When the orchestrator posts an approval request or open questions to Discord, reply in the channel. The agent routes replies via:

```bash
node .openclaw/orchestrator.js respond <project-id> --message "<your reply>"
```

Or send a Discord message — if `pending_interaction` is set in `workflow-state.json`, the agent auto-routes it.

## Discord Bot Setup

Before adding a bot token:
1. discord.com/developers/applications → your app → Bot
2. Enable **Message Content Intent** + **Server Members Intent**
3. Save → Reset Token → copy
4. Invite: `discord.com/api/oauth2/authorize?client_id=APP_ID&permissions=68608&scope=bot`

## Per-Role Model Config

Set in `.openclaw/runtime-config.yml`:
```yaml
role_models:
  pm:        "github-copilot/claude-sonnet-4.6"
  po:        "github-copilot/gpt-5-mini"
  developer: "github-copilot/gpt-5.1-codex"
  qc:        "github-copilot/gpt-5-mini"
```

## Per-Role Skill Config

Set in `.openclaw/runtime-config.yml`:
```yaml
role_skills:
  pm:        ""
  po:        ""
  developer: "full-stack-developer"
  qc:        "javascript-testing-patterns"
```

Each role loads the named skill from `~/.agents/skills/<name>/SKILL.md` and injects it into its prompts. Assign `""` to skip.

## Scheduler Modes

Set `scheduler.mode` in `.openclaw/runtime-config.yml`:

| Mode | Description |
|------|-------------|
| `openclaw-cron` *(default)* | Registers ceremonies with OpenClaw's cron scheduler |
| `direct-worker` *(experimental)* | File-backed scheduler that runs orchestrator commands directly |

**Direct worker commands:**

| Command | Description |
|---------|-------------|
| `node .openclaw/direct-scheduler.js sync` | Sync job registry from `ceremonies.yml` |
| `node .openclaw/direct-scheduler.js list` | Inspect current job state |
| `node .openclaw/direct-scheduler.js tick` | Run due ceremonies (cron evaluation) |
| `node .openclaw/direct-scheduler.js tick --dry-run` | Preview what would run without executing |
| `node .openclaw/direct-scheduler.js run --ceremony <cmd>` | Force-run a single ceremony |

Switch modes by setting `scheduler.mode: "direct-worker"` in runtime config and running `sync`. Override per-command with `--scheduler-mode <mode>` on `register-openclaw-cron.js` / `unregister-openclaw-cron.js`.

## Story Validation

When `validation.enabled: true` in `.openclaw/runtime-config.yml`, the orchestrator runs the configured command after writing implementation files. Stories move to `REVIEW` state immediately after writes and only advance to `DONE` when validation passes.

```yaml
validation:
  enabled: true
  command: "npm"
  args: ["test", "--", "--runInBand"]
  cwd: "."           # relative to project directory
  timeout_ms: 120000
```

Validation is optional — `enabled: false` keeps the legacy behavior where stories advance directly to `DONE` after file writes.

## Degraded Execution Reporting

When an OpenClaw agent call fails, the orchestrator falls back to template-based or partial-parse responses. Each turn records its execution source (`openclaw`, `template-fallback`, or `partial-parse-fallback`) in `workflow-state.json` under `execution_health`.

A concise Discord warning is sent on the first degraded turn of any ceremony. The full health log is written to `<project-id>/docs/execution-health.md`. Set `openclaw.fallback_to_templates: false` to disable fallback and fail hard instead.
