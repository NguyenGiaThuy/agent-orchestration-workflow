#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const AutonomousScrumOrchestrator = require('./orchestrator');
const { resolveSchedulerBackend } = require('./scheduler-backends');

function parseArgs(argv) {
    const args = {
        dryRun: false,
        alertsOnly: false,
        projectId: '',
        cronAgent: '',
        schedulerMode: ''
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
            continue;
        }

        if (current === '--scheduler-mode' && argv[index + 1]) {
            args.schedulerMode = argv[index + 1];
            index += 1;
        }
    }

    return args;
}

function buildEffectiveRuntimeConfig(runtimeConfig, schedulerMode) {
    if (!schedulerMode) {
        return runtimeConfig;
    }

    return {
        ...runtimeConfig,
        scheduler: {
            ...((runtimeConfig && runtimeConfig.scheduler) || {}),
            mode: schedulerMode
        }
    };
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

function resolveCronAgent(runtimeConfig, requestedCronAgent, schedulerBackend) {
    const configuredRunnerAgent = runtimeConfig.openclaw && runtimeConfig.openclaw.agent
        ? runtimeConfig.openclaw.agent
        : 'main';
    const configuredCronAgent = requestedCronAgent || runtimeConfig.openclaw && runtimeConfig.openclaw.cron_agent;
    const availableAgents = schedulerBackend.listAgents().map(agent => agent.id);

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

function main() {
    const args = parseArgs(process.argv.slice(2));
    const orchestrator = new AutonomousScrumOrchestrator('');
    const workspaceDir = toWslPath(path.resolve(__dirname, '..'));
    const absoluteWorkspaceDir = path.resolve(__dirname, '..');
    const effectiveRuntimeConfig = buildEffectiveRuntimeConfig(orchestrator.runtimeConfig, args.schedulerMode);
    const schedulerBackend = resolveSchedulerBackend(effectiveRuntimeConfig, { workspaceDir: absoluteWorkspaceDir });
    const nodeExecutable = process.platform === 'win32' ? toWslPath(process.execPath) : process.execPath;
    const projectId = args.projectId || orchestrator.resolveActiveProjectId();

    if (!projectId) {
        throw new Error('No active project configured. Set project.active in .openclaw/runtime-config.yml or pass --project <id>.');
    }

    const alertConfig = resolveFailureAlertConfig(effectiveRuntimeConfig, absoluteWorkspaceDir);
    const results = [];

    if (args.alertsOnly) {
        // Apply/update failure alerts on existing jobs without re-registering
        const existingJobs = schedulerBackend.listJobs().filter(job => job.name.startsWith(schedulerBackend.jobPrefix));
        if (existingJobs.length === 0) {
            console.log(JSON.stringify({ alertsOnly: true, message: 'No matching jobs found.', results: [] }, null, 2));
            return;
        }

        existingJobs.forEach(job => {
            const alertResult = schedulerBackend.applyFailureAlert(job.id, alertConfig, args.dryRun);
            results.push({ id: job.id, name: job.name, alertResult });
        });

        console.log(JSON.stringify({
            alertsOnly: true, dryRun: args.dryRun, schedulerMode: schedulerBackend.mode, alertConfig: alertConfig
                ? { mode: alertConfig.mode, after: alertConfig.after, cooldown: alertConfig.cooldown }
                : null, results
        }, null, 2));
        return;
    }

    const cronAgent = schedulerBackend.mode === 'openclaw-cron'
        ? resolveCronAgent(effectiveRuntimeConfig, args.cronAgent, schedulerBackend)
        : '';
    const ceremonyFile = path.join(__dirname, 'ceremonies.yml');
    const ceremonies = parseCeremoniesConfig(ceremonyFile);
    const existingJobs = schedulerBackend.listJobs();
    const existingByName = new Map(existingJobs.map(job => [job.name, job]));

    ceremonies.forEach(ceremony => {
        const name = `${schedulerBackend.jobPrefix}${ceremony.command}`;
        const commandText = buildCommand(workspaceDir, nodeExecutable, ceremony.command, projectId);
        const job = {
            id: name,
            name,
            description: `Runs ${ceremony.command} for ${projectId}`,
            schedule: ceremony.schedule,
            timezone: ceremony.timezone || 'UTC',
            message: buildCronMessage(ceremony, commandText),
            agent: cronAgent,
            ceremonyCommand: ceremony.command,
            projectId
        };

        const existingJob = existingByName.get(name);
        if (existingJob && !args.dryRun) {
            schedulerBackend.removeJob(existingJob.id);
        }

        const added = schedulerBackend.addJob(job, args.dryRun);
        const jobId = added && added.id ? added.id : null;
        const alertResult = schedulerBackend.supportsFailureAlerts
            ? schedulerBackend.applyFailureAlert(jobId || 'DRY_RUN_ID', alertConfig, args.dryRun || !jobId)
            : { skipped: true, reason: 'unsupported_backend' };

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
        schedulerMode: schedulerBackend.mode,
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