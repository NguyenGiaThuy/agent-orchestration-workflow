#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const AutonomousScrumOrchestrator = require('./orchestrator');

const JOB_PREFIX = 'agent-orchestration-workflow:';

function parseArgs(argv) {
    const args = {
        dryRun: false,
        alertsOnly: false,
        projectId: '',
        cronAgent: ''
    };

    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];
        if (current === '--dry-run') {
            args.dryRun = true;
            continue;
        }

        if (current === '--alerts-only') {
            args.alertsOnly = true;
            continue;
        }

        if (current === '--project' && argv[index + 1]) {
            args.projectId = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--cron-agent' && argv[index + 1]) {
            args.cronAgent = argv[index + 1];
            index += 1;
        }
    }

    return args;
}

function toWslPath(inputPath) {
    const normalized = path.resolve(inputPath);
    const driveMatch = normalized.match(/^([A-Za-z]):\\(.*)$/);
    if (!driveMatch) {
        return normalized.replace(/\\/g, '/');
    }

    const drive = driveMatch[1].toLowerCase();
    const remainder = driveMatch[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${remainder}`;
}

function parseCeremoniesConfig(filePath) {
    const parsed = YAML.parse(fs.readFileSync(filePath, 'utf-8')) || {};
    const ceremonies = parsed.ceremonies && typeof parsed.ceremonies === 'object'
        ? parsed.ceremonies
        : {};

    return Object.entries(ceremonies)
        .map(([key, ceremony]) => ({
            key,
            name: ceremony && ceremony.name ? ceremony.name : '',
            command: ceremony && ceremony.command ? ceremony.command : '',
            schedule: extractCronExpression(ceremony && ceremony.schedule ? ceremony.schedule : ''),
            timezone: ceremony && ceremony.timezone ? ceremony.timezone : ''
        }))
        .filter(ceremony => ceremony.command && ceremony.schedule);
}

function extractCronExpression(value) {
    const match = String(value || '').match(/^cron\('(.+)'\)$/);
    return match ? match[1] : value;
}

function resolveOcl() {
    // Try native openclaw first; fall back to wsl openclaw on Windows
    const probe = spawnSync('openclaw', ['--version'], { encoding: 'utf-8' });
    if (!probe.error) return { cmd: 'openclaw', prefix: [] };
    return { cmd: 'wsl', prefix: ['openclaw'] };
}

function runOpenClaw(args) {
    const { cmd, prefix } = resolveOcl();
    const result = spawnSync(cmd, [...prefix, ...args], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 120000
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || `openclaw exited with code ${result.status}`).trim());
    }

    return (result.stdout || '').trim();
}

function parseJsonOutput(rawOutput) {
    const trimmed = String(rawOutput || '').trim();
    if (!trimmed) {
        return null;
    }

    const jsonStart = trimmed.indexOf('{');
    const arrayStart = trimmed.indexOf('[');
    let start = -1;

    if (jsonStart === -1) {
        start = arrayStart;
    } else if (arrayStart === -1) {
        start = jsonStart;
    } else {
        start = Math.min(jsonStart, arrayStart);
    }

    if (start === -1) {
        return null;
    }

    return JSON.parse(trimmed.slice(start));
}

function listJobs() {
    const output = runOpenClaw(['cron', 'list', '--json']);
    const parsed = parseJsonOutput(output);
    return parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

function listAgents() {
    const output = runOpenClaw(['agents', 'list', '--json']);
    const parsed = parseJsonOutput(output);
    return Array.isArray(parsed) ? parsed : [];
}

function resolveCronAgent(runtimeConfig, requestedCronAgent) {
    const configuredRunnerAgent = runtimeConfig.openclaw && runtimeConfig.openclaw.agent
        ? runtimeConfig.openclaw.agent
        : 'main';
    const configuredCronAgent = requestedCronAgent || runtimeConfig.openclaw && runtimeConfig.openclaw.cron_agent;
    const availableAgents = listAgents().map(agent => agent.id);

    if (configuredCronAgent && availableAgents.includes(configuredCronAgent)) {
        return configuredCronAgent;
    }

    if (availableAgents.includes('main') && configuredRunnerAgent !== 'main') {
        return 'main';
    }

    if (availableAgents.includes(configuredRunnerAgent)) {
        return configuredRunnerAgent;
    }

    if (availableAgents.length === 0) {
        throw new Error('No OpenClaw agents are configured. Run `openclaw agents list --json` to confirm agent setup.');
    }

    return availableAgents[0];
}

function buildCommand(workspaceDir, nodeExecutable, ceremonyCommand, projectId) {
    return `cd ${shellQuote(workspaceDir)} && ${shellQuote(nodeExecutable)} .openclaw/orchestrator.js ${ceremonyCommand} ${shellQuote(projectId)}`;
}

function shellQuote(value) {
    const normalized = String(value || '');
    return `'${normalized.replace(/'/g, `'\\''`)}'`;
}

function buildCronMessage(ceremony, commandText) {
    return [
        `Run the scheduled ceremony \"${ceremony.name}\" for the agent orchestration workflow.`,
        'Use the exec tool exactly once and do not edit files manually.',
        'Run this exact WSL shell command and wait for it to finish:',
        commandText,
        'After the command finishes, return raw JSON only with keys "summary" and "bullets".',
        'Keep bullets short and include the ceremony name plus the most important execution outcome.',
        'If the command fails, return raw JSON only with a failure summary and the key error line.',
        'Do not wrap the JSON in code fences.'
    ].join('\n\n');
}

function readDiscordWebhookUrl(workspaceDir) {
    const configPath = path.join(workspaceDir, '.openclaw', 'discord-config.yml');
    if (!fs.existsSync(configPath)) {
        return null;
    }

    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf-8')) || {};
    const webhookUrl = parsed.discord && typeof parsed.discord.webhook_url === 'string'
        ? parsed.discord.webhook_url.trim()
        : '';
    return webhookUrl || null;
}

function resolveFailureAlertConfig(runtimeConfig, workspaceDir) {
    const alertConfig = runtimeConfig.failure_alerts || {};
    if (alertConfig.enabled === false) {
        return null;
    }

    const mode = alertConfig.mode || 'webhook';
    const after = alertConfig.after || 1;
    const cooldown = alertConfig.cooldown || '1h';
    let to = alertConfig.to || '';
    const channel = alertConfig.channel || '';

    if (mode === 'webhook' && !to) {
        to = readDiscordWebhookUrl(workspaceDir) || '';
    }

    if (!to && mode !== 'announce') {
        console.error('Warning: failure alerts enabled but no destination URL found. Skipping alert setup.');
        return null;
    }

    return { mode, channel, after, cooldown, to };
}

function applyFailureAlert(jobId, alertConfig, dryRun) {
    if (!alertConfig) {
        return null;
    }

    const args = [
        'cron', 'edit', jobId,
        '--failure-alert',
        '--failure-alert-mode', alertConfig.mode,
        '--failure-alert-after', String(alertConfig.after),
        '--failure-alert-cooldown', alertConfig.cooldown
    ];

    if (alertConfig.to) {
        args.push('--failure-alert-to', alertConfig.to);
    }

    if (alertConfig.channel) {
        args.push('--failure-alert-channel', alertConfig.channel);
    }

    if (dryRun) {
        // Redact webhook URL from dry-run output
        const safeArgs = args.map((arg, index) =>
            arg === alertConfig.to && args[index - 1] === '--failure-alert-to' ? '<webhook-url>' : arg
        );
        return { dryRun: true, args: safeArgs };
    }

    // cron edit does not output JSON; capture raw output as confirmation
    try {
        const raw = runOpenClaw(args);
        return { ok: true, output: raw.slice(0, 120) };
    } catch (error) {
        // The connected gateway may not support failureAlert yet — warn but don't fail registration
        const msg = error.message || String(error);
        if (msg.includes('unexpected property') || msg.includes('failureAlert')) {
            console.error(`Warning: failure alert not applied to ${jobId} - gateway does not support this field yet.`);
            return { ok: false, skipped: true, reason: 'gateway_unsupported' };
        }

        throw error;
    }
}

function removeExistingJob(jobId) {
    runOpenClaw(['cron', 'rm', jobId, '--json']);
}

function addCronJob(job, cronAgent, dryRun) {
    const args = [
        'cron',
        'add',
        '--json',
        '--name', job.name,
        '--description', job.description,
        '--agent', cronAgent,
        '--session', 'isolated',
        '--cron', job.schedule,
        '--tz', job.timezone,
        '--message', job.message,
        '--thinking', 'minimal',
        '--timeout', '600000',
        '--expect-final',
        '--no-deliver'
    ];

    if (dryRun) {
        return {
            dryRun: true,
            args
        };
    }

    return parseJsonOutput(runOpenClaw(args));
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const orchestrator = new AutonomousScrumOrchestrator('');
    const workspaceDir = toWslPath(path.resolve(__dirname, '..'));
    const absoluteWorkspaceDir = path.resolve(__dirname, '..');
    const nodeExecutable = process.platform === 'win32' ? toWslPath(process.execPath) : process.execPath;
    const projectId = args.projectId || orchestrator.resolveActiveProjectId();

    if (!projectId) {
        throw new Error('No active project configured. Set project.active in .openclaw/runtime-config.yml or pass --project <id>.');
    }

    const alertConfig = resolveFailureAlertConfig(orchestrator.runtimeConfig, absoluteWorkspaceDir);
    const results = [];

    if (args.alertsOnly) {
        // Apply/update failure alerts on existing jobs without re-registering
        const existingJobs = listJobs().filter(job => job.name.startsWith(JOB_PREFIX));
        if (existingJobs.length === 0) {
            console.log(JSON.stringify({ alertsOnly: true, message: 'No matching jobs found.', results: [] }, null, 2));
            return;
        }

        existingJobs.forEach(job => {
            const alertResult = applyFailureAlert(job.id, alertConfig, args.dryRun);
            results.push({ id: job.id, name: job.name, alertResult });
        });

        console.log(JSON.stringify({
            alertsOnly: true, dryRun: args.dryRun, alertConfig: alertConfig
                ? { mode: alertConfig.mode, after: alertConfig.after, cooldown: alertConfig.cooldown }
                : null, results
        }, null, 2));
        return;
    }

    const cronAgent = resolveCronAgent(orchestrator.runtimeConfig, args.cronAgent);
    const ceremonyFile = path.join(__dirname, 'ceremonies.yml');
    const ceremonies = parseCeremoniesConfig(ceremonyFile);
    const existingJobs = listJobs();
    const existingByName = new Map(existingJobs.map(job => [job.name, job]));

    ceremonies.forEach(ceremony => {
        const name = `${JOB_PREFIX}${ceremony.command}`;
        const commandText = buildCommand(workspaceDir, nodeExecutable, ceremony.command, projectId);
        const job = {
            name,
            description: `Runs ${ceremony.command} for ${projectId}`,
            schedule: ceremony.schedule,
            timezone: ceremony.timezone || 'UTC',
            message: buildCronMessage(ceremony, commandText)
        };

        const existingJob = existingByName.get(name);
        if (existingJob && !args.dryRun) {
            removeExistingJob(existingJob.id);
        }

        const added = addCronJob(job, cronAgent, args.dryRun);
        const jobId = added && added.id ? added.id : null;
        const alertResult = applyFailureAlert(jobId || 'DRY_RUN_ID', alertConfig, args.dryRun || !jobId);

        results.push({
            ceremony: ceremony.command,
            name,
            timezone: job.timezone,
            schedule: job.schedule,
            replaced: Boolean(existingJob),
            result: added,
            alertResult
        });
    });

    console.log(JSON.stringify({
        dryRun: args.dryRun,
        projectId,
        cronAgent,
        alertConfig: alertConfig
            ? { mode: alertConfig.mode, after: alertConfig.after, cooldown: alertConfig.cooldown }
            : null,
        jobs: results
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}