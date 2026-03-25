#!/usr/bin/env node
/**
 * scrum-orchestrator setup.js
 * Mirrors agent layout of ~/.openclaw/agents/main and frieren.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const YAML = require('yaml');

const SKILL_DIR = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(SKILL_DIR, 'assets', 'openclaw-template');
// --project-dir <path>  workspace root; --project-id <id> creates the project subfolder inside it
const _pdIdx = process.argv.indexOf('--project-dir');
const _piIdx = process.argv.indexOf('--project-id');
const _baseDir = _pdIdx !== -1 ? path.resolve(process.argv[_pdIdx + 1]) : process.cwd();
const _earlyProjectId = _piIdx !== -1 ? process.argv[_piIdx + 1] : null;
const REPO_ROOT = _earlyProjectId ? path.join(_baseDir, _earlyProjectId) : _baseDir;
const OPENCLAW_DIR = path.join(REPO_ROOT, '.openclaw');
const RUNTIME_CFG = path.join(OPENCLAW_DIR, 'runtime-config.yml');
const DISCORD_CFG = path.join(OPENCLAW_DIR, 'discord-config.yml');
const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
const OPENCLAW_AGENTS = path.join(OPENCLAW_HOME, 'agents');

const argv = process.argv.slice(2);
function getArg(f) { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] || null : null; }
const NON_INTERACTIVE = argv.includes('--non-interactive');

function step(m) { console.log(`\n✦ ${m}`); }
function ok(m) { console.log(`  ✔ ${m}`); }
function warn(m) { console.log(`  ⚠ ${m}`); }
function info(m) { console.log(`  ℹ ${m}`); }

function ask(rl, q, def) {
  return new Promise(r => rl.question(`${q}${def ? ` [${def}]` : ''}: `, a => r(a.trim() || def || '')));
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, d) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 4)); }

function patchYamlLine(file, key, value) {
  let c = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`(^[ \\t]*${key}:[ \\t]*).*$`, 'm');
  c = re.test(c) ? c.replace(re, `$1${value}`) : c + `\n${key}: ${value}`;
  fs.writeFileSync(file, c);
}

function run(cmd, cwd) {
  const r = spawnSync(cmd, { shell: true, cwd: cwd || REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`\n[setup] Command failed: ${cmd}`); process.exit(r.status || 1); }
}

function ocl(...a) {
  for (const [cmd, extra] of [['openclaw', []], ['wsl', ['openclaw']]]) {
    const r = spawnSync(cmd, [...extra, ...a], { encoding: 'utf8' });
    if (!r.error) return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  return { ok: false, stdout: '', stderr: 'openclaw not found' };
}

function oclJson(...a) {
  const r = ocl(...a, '--json');
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function deriveProjectId(idea) {
  const stop = new Set(['i', 'want', 'to', 'build', 'create', 'make', 'a', 'an', 'the', 'let', 'us', 'lets', 'help', 'me', 'new', 'some', 'my', 'develop', 'design']);
  return idea.toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => !stop.has(w))
    .slice(0, 4)
    .join('-');
}

function listAgents() {
  const r = oclJson('agents', 'list');
  if (!r) return [];
  return Array.isArray(r) ? r : (r.agents || []);
}

function agentExists(id) { return listAgents().some(a => a.id === id); }

function getAgentDiscordAccount(agentId) {
  const authFile = path.join(OPENCLAW_AGENTS, agentId, 'agent', 'auth-profiles.json');
  const auth = readJson(authFile);
  if (!auth) return null;
  const lastGood = auth.lastGood && auth.lastGood['discord'];
  if (lastGood) return lastGood.replace('discord:', '');
  const key = Object.keys(auth.profiles || {}).find(k => k.startsWith('discord:'));
  return key ? key.replace('discord:', '') : null;
}

function createAgent(agentId) {
  step(`Creating agent: ${agentId}`);

  const agentDir = path.join(OPENCLAW_AGENTS, agentId, 'agent');
  const workspaceDir = path.join(OPENCLAW_HOME, `workspace-${agentId}`);

  // Step 1: Let openclaw scaffold the agent first
  const r = ocl('agents', 'add', agentId, '--workspace', workspaceDir, '--model', 'github-copilot/gpt-5-mini', '--non-interactive');
  if (!r.ok) {
    warn(`openclaw agents add failed: ${r.stderr.trim()}`);
    warn('Falling back to manual scaffold...');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
  } else {
    ok(`Agent '${agentId}' created via openclaw`);
    info(`  workspace : ${workspaceDir}`);
    info(`  agent dir : ${agentDir}`);
  }

  // Step 2: Mirror github-copilot auth + models from main (merge, don't overwrite)
  const mainAuth = readJson(path.join(OPENCLAW_AGENTS, 'main', 'agent', 'auth-profiles.json'));
  const mainModels = readJson(path.join(OPENCLAW_AGENTS, 'main', 'agent', 'models.json'));

  if (mainAuth) {
    const existing = readJson(path.join(agentDir, 'auth-profiles.json')) || { version: 1, profiles: {}, lastGood: {}, usageStats: {} };
    for (const [k, v] of Object.entries(mainAuth.profiles || {})) {
      if (k.startsWith('github-copilot')) {
        existing.profiles[k] = v;
        existing.lastGood['github-copilot'] = k;
      }
    }
    writeJson(path.join(agentDir, 'auth-profiles.json'), existing);
    ok('auth-profiles.json updated (github-copilot token mirrored from main)');
  } else {
    warn('Could not read main auth-profiles.json — agent may need manual auth setup');
    if (!fs.existsSync(path.join(agentDir, 'auth-profiles.json'))) {
      writeJson(path.join(agentDir, 'auth-profiles.json'), { version: 1, profiles: {}, lastGood: {}, usageStats: {} });
    }
  }

  if (mainModels) { writeJson(path.join(agentDir, 'models.json'), mainModels); ok('models.json mirrored from main'); }

  return agentId;
}

function wireAgentToChannel(agentId, botToken) {
  step(`Registering Discord bot for agent '${agentId}'...`);
  const accountId = `discord-${agentId}`;

  const add = ocl('channels', 'add', '--channel', 'discord', '--token', botToken, '--account', accountId, '--name', `Scrum PM (${agentId})`);
  if (!add.ok) {
    warn(`Channel add failed: ${add.stderr.trim()}`);
    warn(`Run manually: openclaw channels add --channel discord --token <token> --account ${accountId}`);
    return false;
  }
  ok(`Discord account registered as '${accountId}'`);

  // Update auth-profiles.json (mirrors main/nova pattern: discord:<accountId> entry)
  const authFile = path.join(OPENCLAW_AGENTS, agentId, 'agent', 'auth-profiles.json');
  const auth = readJson(authFile) || { version: 1, profiles: {}, lastGood: {}, usageStats: {} };
  auth.profiles[`discord:${accountId}`] = { type: 'token', provider: 'discord' };
  auth.lastGood['discord'] = `discord:${accountId}`;
  writeJson(authFile, auth);
  ok('auth-profiles.json updated with discord account');

  const bind = ocl('agents', 'bind', '--agent', agentId, '--bind', `discord:${accountId}`);
  if (!bind.ok) {
    warn(`Agent binding failed: ${bind.stderr.trim()}`);
    warn(`Run manually: openclaw agents bind --agent ${agentId} --bind discord:${accountId}`);
    return false;
  }
  ok(`Agent '${agentId}' bound to discord:${accountId}`);

  // Verify .openclaw.json reflects the binding correctly
  step('Verifying ~/.openclaw/openclaw.json...');
  const oclJsonPath = path.join(OPENCLAW_HOME, 'openclaw.json');
  const oclConfig = readJson(oclJsonPath);
  let configOk = true;
  if (oclConfig) {
    // Check 1: channel account entry exists
    const channelEntry = oclConfig?.channels?.discord?.accounts?.[accountId];
    if (channelEntry) {
      ok(`openclaw.json: channels.discord.accounts.${accountId} ✔`);
    } else {
      warn(`openclaw.json: channels.discord.accounts.${accountId} not found — channel may not have registered cleanly`);
      info(`Run: openclaw channels list --json  to diagnose`);
      configOk = false;
    }
    // Check 2: agent binding entry exists
    const agentEntry = oclConfig?.agents?.[agentId];
    const bindings = agentEntry?.bindings || agentEntry?.channels || [];
    const hasBinding = Array.isArray(bindings)
      ? bindings.some(b => b === `discord:${accountId}` || b?.id === `discord:${accountId}`)
      : typeof bindings === 'object' && (`discord:${accountId}` in bindings);
    if (hasBinding) {
      ok(`openclaw.json: agent '${agentId}' binding to discord:${accountId} ✔`);
    } else {
      info(`openclaw.json: agent binding not found in config (may be stored separately — verify with: openclaw agents get ${agentId} --json)`);
    }
  } else {
    warn(`Could not read ~/.openclaw/openclaw.json — skipping config verification`);
    configOk = false;
  }
  if (configOk) { ok('Discord wiring verified in openclaw.json'); }
  return true;
}

async function main() {
  console.log('\n🦀 Scrum Orchestrator Setup\n');

  const rl = NON_INTERACTIVE
    ? { question: (_, cb) => cb(''), close: () => { } }
    : readline.createInterface({ input: process.stdin, output: process.stdout });

  // Step 1: Scaffold
  step('Scaffolding .openclaw/ template');
  if (fs.existsSync(OPENCLAW_DIR) && !NON_INTERACTIVE) {
    const a = await ask(rl, '.openclaw/ already exists. Overwrite? (y/N)', 'N');
    if (a.toLowerCase() === 'y') { fs.rmSync(OPENCLAW_DIR, { recursive: true }); fs.cpSync(TEMPLATE_DIR, OPENCLAW_DIR, { recursive: true }); ok('Scaffolded from template'); }
    else ok('Keeping existing .openclaw/');
  } else if (!fs.existsSync(OPENCLAW_DIR)) {
    fs.cpSync(TEMPLATE_DIR, OPENCLAW_DIR, { recursive: true }); ok('Scaffolded from template');
  }

  // Step 1b: Install .openclaw/ dependencies
  step('Installing .openclaw/ dependencies');
  {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const installResult = spawnSync(npmCmd, ['install', '--prefer-offline'], {
      cwd: OPENCLAW_DIR,
      stdio: 'inherit',
      shell: false
    });
    if (installResult.status !== 0) {
      warn('npm install failed — orchestrator may not work. Run `npm install` inside .openclaw/ manually.');
    } else {
      ok('node_modules installed');
    }
  }

  // Patch openclaw command for Windows (WSL) — template defaults to native openclaw
  if (process.platform === 'win32') {
    patchYamlLine(RUNTIME_CFG, 'command', '"wsl"');
    patchYamlLine(RUNTIME_CFG, 'args', '["openclaw"]');
    ok('runtime-config.yml → openclaw via wsl (Windows detected)');
  }

  // Step 2: Agent
  step('Agent setup');
  const existingAgents = listAgents();
  const agentIds = existingAgents.map(a => a.id);
  let chosenAgentId = getArg('--agent');

  if (!chosenAgentId && !NON_INTERACTIVE) {
    if (agentIds.length > 0) {
      console.log('\n  Existing agents:');
      agentIds.forEach((id, i) => console.log(`    ${i + 1}. ${id}`));
      console.log(`    ${agentIds.length + 1}. Create a new agent`);
      const a = await ask(rl, '\n  Pick number or type a new agent ID');
      const n = parseInt(a, 10);
      if (!isNaN(n) && n >= 1 && n <= agentIds.length) { chosenAgentId = agentIds[n - 1]; ok(`Using existing agent: ${chosenAgentId}`); }
      else chosenAgentId = (!isNaN(n) && n === agentIds.length + 1) ? await ask(rl, '  New agent ID', 'scrum-pm') : (a.trim() || 'scrum-pm');
    } else {
      info('No existing agents found.');
      chosenAgentId = await ask(rl, '  New agent ID', 'scrum-pm');
    }
  }
  chosenAgentId = chosenAgentId || 'scrum-pm';

  const isNewAgent = !agentExists(chosenAgentId);
  if (isNewAgent) { const c = createAgent(chosenAgentId); if (!c) warn(`Could not create agent. Continuing with config only.`); }
  else ok(`Using existing agent: ${chosenAgentId}`);

  // Step 3: Discord bot
  step('Discord bot setup');
  let channelId = getArg('--channel');
  let botToken = getArg('--bot-token');
  let skipBot = false;

  if (!NON_INTERACTIVE) {
    if (isNewAgent) {
      console.log('  ┌─ Before you paste a bot token ──────────────────────────────────┐');
      console.log('  │                                                                 │');
      console.log('  │  Discord WILL reject your token without these steps first:     │');
      console.log('  │                                                                 │');
      console.log('  │  1. discord.com/developers/applications                        │');
      console.log('  │  2. Select your app (or New Application) → Bot                 │');
      console.log('  │  3. Privileged Gateway Intents → enable both:                  │');
      console.log('  │       ✅ Message Content Intent                                 │');
      console.log('  │       ✅ Server Members Intent                                  │');
      console.log('  │  4. Save Changes                                               │');
      console.log('  │  5. Bot → Reset Token → copy it                                │');
      console.log('  │  6. Invite bot (replace APP_ID):                               │');
      console.log('  │     discord.com/api/oauth2/authorize                           │');
      console.log('  │       ?client_id=APP_ID&permissions=68608&scope=bot            │');
      console.log('  │                                                                 │');
      console.log('  └─────────────────────────────────────────────────────────────────┘\n');
      botToken = botToken || await ask(rl, '  Bot token (leave blank to skip)');
    } else {
      const existingAccount = getAgentDiscordAccount(chosenAgentId);
      if (existingAccount) {
        skipBot = true;
        ok(`Discord already wired for agent '${chosenAgentId}' (account: ${existingAccount}) — skipping token setup`);
      } else {
        const addBot = await ask(rl, `  Add a Discord bot token for '${chosenAgentId}'? (y/N)`, 'N');
        if (addBot.toLowerCase() === 'y') botToken = await ask(rl, '  Bot token (leave blank to skip)');
        else skipBot = true;
      }
    }
    if (!channelId) {
      console.log('\n  Discord Channel ID — right-click channel → Copy Channel ID\n');
      channelId = await ask(rl, '  Channel ID');
    }
  }

  let botWired = false;
  if (botToken && botToken.trim()) botWired = wireAgentToChannel(chosenAgentId, botToken.trim());
  else if (!skipBot && !NON_INTERACTIVE) {
    warn('No bot token — skipping Discord registration.');
    info(`Run later: openclaw channels add --channel discord --token <token> --account discord-${chosenAgentId}`);
    info(`Then:      openclaw agents bind --agent ${chosenAgentId} --bind discord:discord-${chosenAgentId}`);
  }

  // Step 4: discord-config.yml
  step('Configuring Discord delivery');
  if (channelId && channelId.trim()) {
    let dc = fs.readFileSync(DISCORD_CFG, 'utf8');
    dc = dc.replace(/(^\s*enabled:\s*).*/m, '$1true');
    dc = dc.replace(/(^\s*transport:\s*).*/m, '$1"channel"');
    if (/channel_id:/.test(dc)) dc = dc.replace(/(^\s*channel_id:\s*).*/m, `$1"${channelId.trim()}"`);
    else dc = dc.replace(/(^\s*transport:\s*"channel")/m, `$1\n  channel_id: "${channelId.trim()}"`);
    dc = dc.replace(/^\s*webhook_env:.*\n/m, '').replace(/^\s*webhook_url:.*\n/m, '');
    fs.writeFileSync(DISCORD_CFG, dc);
    ok(`Discord channel set → ${channelId.trim()}`);
  } else warn('No channel ID — Discord disabled. Set channel_id in .openclaw/discord-config.yml later.');

  // Step 5: runtime-config.yml
  patchYamlLine(RUNTIME_CFG, 'agent', `"${chosenAgentId}"`);
  patchYamlLine(RUNTIME_CFG, 'cron_agent', `"${chosenAgentId}"`);
  ok(`runtime-config.yml → agent: ${chosenAgentId}`);

  // Step 4b: Discord account selection
  // First try to auto-detect from the chosen agent's auth-profiles
  let discordAccount = getArg('--discord-account') || getAgentDiscordAccount(chosenAgentId) || '';
  if (!NON_INTERACTIVE && !discordAccount) {
    // Fall back: collect discord accounts from ALL agents
    const allDiscordAccounts = new Set();
    try {
      const agentDirs = fs.readdirSync(OPENCLAW_AGENTS);
      for (const dir of agentDirs) {
        try {
          const ap = JSON.parse(fs.readFileSync(path.join(OPENCLAW_AGENTS, dir, 'agent', 'auth-profiles.json'), 'utf8'));
          Object.keys(ap.profiles || {}).filter(k => k.startsWith('discord:')).forEach(k => allDiscordAccounts.add(k.replace('discord:', '')));
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    const discordAccountsList = [...allDiscordAccounts];
    if (discordAccountsList.length > 0) {
      console.log('  Available Discord accounts:');
      discordAccountsList.forEach((a, i) => console.log(`    ${i + 1}. ${a}`));
      const picked = await ask(rl, `  Discord account to use for posting`, discordAccountsList[0]);
      const num = parseInt(picked, 10);
      discordAccount = (!isNaN(num) && num >= 1 && num <= discordAccountsList.length)
        ? discordAccountsList[num - 1] : picked.trim() || discordAccountsList[0];
      ok(`Discord account → ${discordAccount}`);
    } else {
      discordAccount = await ask(rl, '  Discord account name to use for posting', '');
      ok(`Discord account → ${discordAccount}`);
    }
  } else if (discordAccount) {
    ok(`Discord account → ${discordAccount} (auto-detected)`);
  }
  // Write account to discord-config.yml
  let dcContent = fs.readFileSync(DISCORD_CFG, 'utf8');
  dcContent = dcContent.replace(/^(\s*account:\s*).*$/m, `$1"${discordAccount}"`);
  fs.writeFileSync(DISCORD_CFG, dcContent);

  // Step 5a: Role skills
  step('Role skill assignment (optional)');
  info('Each role can use an installed agent skill for domain-specific expertise.');
  info('E.g. assign "full-stack-developer" to DEV, "javascript-testing-patterns" to QC.\n');

  // Discover installed skills
  const skillsDir = path.join(os.homedir(), '.agents', 'skills');
  let availableSkills = [];
  try {
    availableSkills = fs.readdirSync(skillsDir)
      .filter(f => fs.existsSync(path.join(skillsDir, f, 'SKILL.md')));
  } catch { /* no skills dir */ }

  const ROLE_LABELS = [
    { key: 'pm', label: 'PM  (Project Manager)' },
    { key: 'po', label: 'PO  (Product Owner)' },
    { key: 'developer', label: 'DEV (Developer)' },
    { key: 'qc', label: 'QC  (Quality Control)' },
  ];

  const roleSkills = {};
  if (!NON_INTERACTIVE && availableSkills.length > 0) {
    console.log('  Available skills:');
    availableSkills.forEach((s, i) => console.log(`    ${(i + 1).toString().padStart(2)}. ${s}`));
    console.log('     0. None\n');
    for (const { key, label } of ROLE_LABELS) {
      const picked = await ask(rl, `  Skill for ${label} (name or number, 0=none)`, '0');
      const num = parseInt(picked, 10);
      if (!isNaN(num) && num >= 1 && num <= availableSkills.length) {
        roleSkills[key] = availableSkills[num - 1];
        ok(`${label.split('(')[0].trim()} → ${roleSkills[key]}`);
      } else if (picked && picked !== '0' && isNaN(num)) {
        roleSkills[key] = picked.trim();
        ok(`${label.split('(')[0].trim()} → ${roleSkills[key]}`);
      } else {
        roleSkills[key] = '';
      }
    }
  } else {
    ROLE_LABELS.forEach(({ key }) => { roleSkills[key] = getArg(`--skill-${key}`) || ''; });
  }

  // Patch role_skills into runtime-config.yml
  let rcSkill = fs.readFileSync(RUNTIME_CFG, 'utf8');
  if (/^role_skills:/m.test(rcSkill)) {
    for (const { key } of ROLE_LABELS) {
      const re = new RegExp(`(^\\s*${key}:\\s*).*$`, 'm');
      rcSkill = re.test(rcSkill) ? rcSkill.replace(re, `$1"${roleSkills[key]}"`) : rcSkill;
    }
  } else {
    rcSkill += `\nrole_skills:\n`;
    for (const { key } of ROLE_LABELS) rcSkill += `  ${key}: "${roleSkills[key]}"\n`;
  }
  fs.writeFileSync(RUNTIME_CFG, rcSkill);
  ok('role_skills written to runtime-config.yml');

  // Step 5b: Role models
  step('Model selection per role');
  const ROLES = [
    { key: 'pm', label: 'PM  (Project Manager)' },
    { key: 'po', label: 'PO  (Product Owner)' },
    { key: 'developer', label: 'DEV (Developer)' },
    { key: 'qc', label: 'QC  (Quality Control)' },
  ];

  // Show available models (best-effort)
  const modelsRaw = ocl('models', 'list');
  const modelLines = modelsRaw.stdout.split('\n').filter(l => l.includes('github-copilot/')).map(l => l.trim().split(/\s+/)[0]);
  const defaultModel = 'github-copilot/gpt-5-mini';

  if (!NON_INTERACTIVE && modelLines.length > 0) {
    console.log('\n  Available models:');
    modelLines.slice(0, 15).forEach((m, i) => console.log(`    ${(i + 1).toString().padStart(2)}. ${m}`));
    console.log();
  }

  const roleModels = {};
  for (const { key, label } of ROLES) {
    const envKey = `--model-${key}`;
    const fromArg = getArg(envKey);
    if (fromArg) {
      roleModels[key] = fromArg;
    } else if (!NON_INTERACTIVE) {
      const picked = await ask(rl, `  Model for ${label}`, defaultModel);
      roleModels[key] = picked || defaultModel;
    } else {
      roleModels[key] = defaultModel;
    }
    ok(`${label.split('(')[0].trim()} → ${roleModels[key]}`);
  }

  // Patch role_models section in runtime-config.yml
  let rc = fs.readFileSync(RUNTIME_CFG, 'utf8');
  if (/^role_models:/m.test(rc)) {
    for (const { key } of ROLES) {
      const re = new RegExp(`(^\\s*${key}:\\s*).*$`, 'm');
      const val = `"${roleModels[key]}"`;
      rc = re.test(rc) ? rc.replace(re, `$1${val}`) : rc;
    }
  } else {
    rc += `\nrole_models:\n`;
    for (const { key } of ROLES) rc += `  ${key}: "${roleModels[key]}"\n`;
  }
  fs.writeFileSync(RUNTIME_CFG, rc);
  ok('role_models written to runtime-config.yml');

  // Step 5c: Scheduler mode
  step('Scheduler mode');
  info('openclaw-cron (default) registers ceremonies with OpenClaw cron.');
  info('direct-worker (experimental) runs ceremonies directly via file-backed scheduler.\n');
  const SCHEDULER_MODES = ['openclaw-cron', 'direct-worker'];
  let chosenSchedulerMode = getArg('--scheduler-mode') || 'openclaw-cron';
  if (!NON_INTERACTIVE) {
    console.log('  1. openclaw-cron  ← default');
    console.log('  2. direct-worker  (experimental)\n');
    const picked = await ask(rl, '  Scheduler mode (1 or 2)', '1');
    const num = parseInt(picked, 10);
    if (num === 2) chosenSchedulerMode = 'direct-worker';
    else if (num !== 1 && SCHEDULER_MODES.includes(picked.trim())) chosenSchedulerMode = picked.trim();
  }
  ok(`Scheduler mode → ${chosenSchedulerMode}`);
  // Patch scheduler.mode in runtime-config.yml (targets only the scheduler block)
  {
    let rcRaw = fs.readFileSync(RUNTIME_CFG, 'utf8');
    const blockStart = rcRaw.indexOf('\nscheduler:');
    if (blockStart !== -1) {
      const before = rcRaw.slice(0, blockStart + 1);
      const after = rcRaw.slice(blockStart + 1).replace(/^(\s+mode:\s*)"[^"]*"/m, `$1"${chosenSchedulerMode}"`);
      fs.writeFileSync(RUNTIME_CFG, before + after);
    }
  }

  // Step 6: Project
  step('Project setup');
  let idea = getArg('--idea');
  if (!idea && !NON_INTERACTIVE) idea = await ask(rl, '  What do you want to build?\n  > ');
  if (!idea) { console.error('❌ No idea provided.'); rl.close(); process.exit(1); }

  let projectId = getArg('--project-id');
  if (!projectId && !NON_INTERACTIVE) projectId = await ask(rl, '  Project ID', deriveProjectId(idea));
  projectId = projectId || deriveProjectId(idea);
  patchYamlLine(RUNTIME_CFG, 'active', `"${projectId}"`);
  ok(`Project ID → ${projectId}`);
  rl.close();

  // Step 7: start-idea
  step(`Running discovery for: "${idea}"`);
  run(`node .openclaw/orchestrator.js start-idea --idea "${idea.replace(/"/g, '\\"')}" --project "${projectId}"`, REPO_ROOT);

  // Step 8: scheduler
  const runtimeConfig = YAML.parse(fs.readFileSync(RUNTIME_CFG, 'utf8')) || {};
  const schedulerMode = runtimeConfig.scheduler && runtimeConfig.scheduler.mode
    ? runtimeConfig.scheduler.mode
    : 'openclaw-cron';

  if (schedulerMode === 'direct-worker') {
    step('Syncing direct-worker scheduler jobs');
    run('node .openclaw/direct-scheduler.js sync', REPO_ROOT);
  } else {
    step('Registering OpenClaw cron ceremonies');
    run('node .openclaw/register-openclaw-cron.js', REPO_ROOT);
  }

  const botStatus = botWired ? `✔ Bot wired (account: discord-${chosenAgentId})`
    : skipBot ? `✔ Using existing account`
      : `⚠  Bot token not provided — wire manually`;

  console.log(`
╔══════════════════════════════════════════════════════╗
║  ✅ Scrum Orchestrator Setup Complete                ║
╚══════════════════════════════════════════════════════╝

  Agent:    ${chosenAgentId} (${isNewAgent ? 'newly created' : 'existing'})
  Discord:  ${channelId || '(not set)'}
  Bot:      ${botStatus}
  Project:  ${projectId}
  Docs:     ./docs/
  Scheduler:${schedulerMode === 'direct-worker' ? ' direct-worker (run node .openclaw/direct-scheduler.js tick)' : ' openclaw-cron'}

  Review docs then approve:
    node .openclaw/orchestrator.js status ${projectId}
    node .openclaw/orchestrator.js approve ${projectId}
`);
}

main().catch(err => { console.error('[setup] Fatal:', err.message); process.exit(1); });
