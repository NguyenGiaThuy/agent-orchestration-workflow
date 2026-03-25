#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const YAML = require('yaml');

const AutonomousScrumOrchestrator = require('./orchestrator');
const { resolveSchedulerBackend } = require('./scheduler-backends');

const DEFAULT_DIRECT_WORKER_CONFIG = Object.freeze({
    state_file: '.openclaw/direct-scheduler-state.json',
    lock_file: '.openclaw/direct-scheduler.lock',
    lock_timeout_ms: 900000,
    retry_count: 2,
    retry_backoff_ms: 1000,
    command_timeout_ms: 600000
});

function parseArgs(argv) {
    const args = {
        command: 'tick',
        dryRun: false,
        projectId: '',
        ceremony: '',
        runAll: false,
        now: '',
        schedulerMode: ''
    };

    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];
        if (!current.startsWith('--') && index === 0) {
            args.command = current;
            continue;
        }

        if (current === '--dry-run') {
            args.dryRun = true;
            continue;
        }

        if (current === '--run-all') {
            args.runAll = true;
            continue;
        }

        if (current === '--project' && argv[index + 1]) {
            args.projectId = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--ceremony' && argv[index + 1]) {
            args.ceremony = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--now' && argv[index + 1]) {
            args.now = argv[index + 1];
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

function resolveDirectWorkerConfig(runtimeConfig) {
    return {
        ...DEFAULT_DIRECT_WORKER_CONFIG,
        ...((((runtimeConfig || {}).scheduler || {}).direct_worker) || {})
    };
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
            timezone: ceremony && ceremony.timezone ? ceremony.timezone : 'UTC'
        }))
        .filter(ceremony => ceremony.command && ceremony.schedule);
}

function extractCronExpression(value) {
    const match = String(value || '').match(/^cron\('(.+)'\)$/);
    return match ? match[1] : value;
}

function syncJobs(schedulerBackend, projectId, dryRun) {
    const ceremonies = parseCeremoniesConfig(path.join(__dirname, 'ceremonies.yml'));
    const existingJobs = schedulerBackend.listJobs();
    const desiredNames = new Set();
    const results = [];

    ceremonies.forEach(ceremony => {
        const job = {
            id: `${schedulerBackend.jobPrefix}${ceremony.command}`,
            name: `${schedulerBackend.jobPrefix}${ceremony.command}`,
            description: `Runs ${ceremony.command} for ${projectId}`,
            schedule: ceremony.schedule,
            timezone: ceremony.timezone || 'UTC',
            ceremonyCommand: ceremony.command,
            projectId
        };
        desiredNames.add(job.name);

        const existingJob = existingJobs.find(candidate => candidate.name === job.name);
        const result = schedulerBackend.addJob({ ...(existingJob || {}), ...job }, dryRun);
        results.push({ ceremony: ceremony.command, replaced: Boolean(existingJob), result });
    });

    const removed = existingJobs
        .filter(job => job.name && job.name.startsWith(schedulerBackend.jobPrefix) && !desiredNames.has(job.name))
        .map(job => {
            if (!dryRun) {
                schedulerBackend.removeJob(job.id);
            }
            return { id: job.id, name: job.name };
        });

    return {
        dryRun,
        schedulerMode: schedulerBackend.mode,
        projectId,
        jobs: results,
        removed
    };
}

function listJobs(schedulerBackend) {
    return {
        schedulerMode: schedulerBackend.mode,
        stateFilePath: schedulerBackend.stateFilePath,
        jobs: schedulerBackend.listJobs()
    };
}

function tickJobs(schedulerBackend, runtimeConfig, workspaceDir, projectId, args) {
    const directWorkerConfig = resolveDirectWorkerConfig(runtimeConfig);
    const lock = acquireLock(schedulerBackend.lockFilePath, directWorkerConfig.lock_timeout_ms, args.dryRun);

    try {
        const referenceTime = args.now ? new Date(args.now) : new Date();
        if (Number.isNaN(referenceTime.getTime())) {
            throw new Error(`Invalid --now value: ${args.now}`);
        }

        const jobs = schedulerBackend.listJobs().filter(job => job.enabled !== false);
        const filteredJobs = args.ceremony
            ? jobs.filter(job => job.ceremonyCommand === args.ceremony)
            : jobs;

        const dueJobs = filteredJobs.filter(job => shouldRunJob(job, referenceTime, args.runAll));
        const results = dueJobs.map(job => runJobWithRetries(job, schedulerBackend, directWorkerConfig, workspaceDir, projectId, args.dryRun, referenceTime));

        return {
            dryRun: args.dryRun,
            schedulerMode: schedulerBackend.mode,
            now: referenceTime.toISOString(),
            evaluatedJobs: filteredJobs.length,
            dueJobs: dueJobs.length,
            results
        };
    } finally {
        releaseLock(lock, args.dryRun);
    }
}

function runSingleCeremony(schedulerBackend, runtimeConfig, workspaceDir, projectId, ceremony, dryRun) {
    if (!ceremony) {
        throw new Error('run requires --ceremony <command>.');
    }

    const directWorkerConfig = resolveDirectWorkerConfig(runtimeConfig);
    const jobs = schedulerBackend.listJobs();
    const job = jobs.find(candidate => candidate.ceremonyCommand === ceremony);
    if (!job) {
        throw new Error(`No direct-worker job found for ceremony "${ceremony}". Run direct-scheduler.js sync first.`);
    }

    return {
        dryRun,
        schedulerMode: schedulerBackend.mode,
        result: runJobWithRetries(job, schedulerBackend, directWorkerConfig, workspaceDir, projectId, dryRun, new Date(), true)
    };
}

function shouldRunJob(job, referenceTime, runAll) {
    if (runAll) {
        return true;
    }

    const zoned = getZonedDateParts(referenceTime, job.timezone || 'UTC');
    if (!cronMatches(job.schedule, zoned)) {
        return false;
    }

    return job.last_run_key !== buildRunKey(zoned);
}

function runJobWithRetries(job, schedulerBackend, directWorkerConfig, workspaceDir, projectId, dryRun, referenceTime, forced = false) {
    const targetProjectId = job.projectId || projectId;
    const zoned = getZonedDateParts(referenceTime, job.timezone || 'UTC');
    const runKey = forced ? `${buildRunKey(zoned)}:forced` : buildRunKey(zoned);
    const maxAttempts = Math.max(1, Number(directWorkerConfig.retry_count || 0) + 1);

    if (dryRun) {
        return {
            jobId: job.id,
            ceremony: job.ceremonyCommand,
            projectId: targetProjectId,
            attempts: 0,
            status: 'dry-run',
            runKey
        };
    }

    let lastFailure = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const startedAt = Date.now();
        const commandResult = spawnSync(process.execPath, ['.openclaw/orchestrator.js', job.ceremonyCommand, targetProjectId], {
            cwd: workspaceDir,
            encoding: 'utf-8',
            timeout: directWorkerConfig.command_timeout_ms || 600000,
            windowsHide: true
        });
        const durationMs = Date.now() - startedAt;
        const outputPreview = buildOutputPreview(commandResult.stdout, commandResult.stderr);

        if (!commandResult.error && commandResult.status === 0) {
            const updatedJob = {
                ...job,
                projectId: targetProjectId,
                last_run_at: new Date().toISOString(),
                last_success_at: new Date().toISOString(),
                last_run_key: runKey,
                consecutive_failures: 0,
                last_error: '',
                last_exit_code: 0,
                last_output_preview: outputPreview,
                last_duration_ms: durationMs
            };
            schedulerBackend.addJob(updatedJob, false);

            return {
                jobId: job.id,
                ceremony: job.ceremonyCommand,
                projectId: targetProjectId,
                attempts: attempt,
                status: 'success',
                durationMs,
                outputPreview
            };
        }

        lastFailure = {
            jobId: job.id,
            ceremony: job.ceremonyCommand,
            projectId: targetProjectId,
            attempts: attempt,
            status: 'failed',
            durationMs,
            outputPreview,
            error: commandResult.error ? commandResult.error.message : `Exit code ${commandResult.status}`,
            exitCode: commandResult.status === null || commandResult.status === undefined ? null : commandResult.status
        };

        if (attempt < maxAttempts) {
            sleepMs((directWorkerConfig.retry_backoff_ms || 0) * attempt);
        }
    }

    schedulerBackend.addJob({
        ...job,
        projectId: targetProjectId,
        last_run_at: new Date().toISOString(),
        last_run_key: runKey,
        consecutive_failures: Number(job.consecutive_failures || 0) + 1,
        last_error: lastFailure.error,
        last_exit_code: lastFailure.exitCode,
        last_output_preview: lastFailure.outputPreview,
        last_duration_ms: lastFailure.durationMs
    }, false);

    return lastFailure;
}

function acquireLock(lockFilePath, lockTimeoutMs, dryRun) {
    if (dryRun) {
        return { dryRun: true, lockFilePath };
    }

    ensureDir(path.dirname(lockFilePath));
    const payload = JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }, null, 2);

    try {
        fs.writeFileSync(lockFilePath, payload, { flag: 'wx' });
        return { lockFilePath };
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }

        const currentLock = readJsonFile(lockFilePath);
        const lockTime = currentLock && currentLock.acquired_at ? new Date(currentLock.acquired_at).getTime() : 0;
        if (lockTime > 0 && Date.now() - lockTime > lockTimeoutMs) {
            fs.rmSync(lockFilePath, { force: true });
            fs.writeFileSync(lockFilePath, payload, { flag: 'wx' });
            return { lockFilePath, replacedStaleLock: true };
        }

        throw new Error(`Direct scheduler lock is already held at ${lockFilePath}.`);
    }
}

function releaseLock(lock, dryRun) {
    if (dryRun || !lock || !lock.lockFilePath) {
        return;
    }

    fs.rmSync(lock.lockFilePath, { force: true });
}

function cronMatches(schedule, zonedParts) {
    const fields = String(schedule || '').trim().split(/\s+/);
    if (fields.length !== 5) {
        return false;
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    return fieldMatches(minute, zonedParts.minute, 0, 59)
        && fieldMatches(hour, zonedParts.hour, 0, 23)
        && fieldMatches(dayOfMonth, zonedParts.dayOfMonth, 1, 31)
        && fieldMatches(month, zonedParts.month, 1, 12)
        && fieldMatches(dayOfWeek, zonedParts.dayOfWeek, 0, 6, true);
}

function fieldMatches(field, value, min, max, isDayOfWeek = false) {
    return String(field || '').split(',').some(part => partMatches(part.trim(), value, min, max, isDayOfWeek));
}

function partMatches(part, value, min, max, isDayOfWeek) {
    if (!part) {
        return false;
    }

    const [base, rawStep] = part.split('/');
    const step = rawStep ? Number(rawStep) : 1;
    if (!Number.isFinite(step) || step <= 0) {
        return false;
    }

    if (base === '*') {
        return (value - min) % step === 0;
    }

    if (base.includes('-')) {
        const [rawStart, rawEnd] = base.split('-');
        const start = normalizeFieldValue(rawStart, isDayOfWeek);
        const end = normalizeFieldValue(rawEnd, isDayOfWeek);
        if (start === null || end === null) {
            return false;
        }

        if (start <= end) {
            return value >= start && value <= end && (value - start) % step === 0;
        }

        return (value >= start || value <= end) && (value - start) % step === 0;
    }

    const normalizedValue = normalizeFieldValue(base, isDayOfWeek);
    if (normalizedValue === null || normalizedValue < min || normalizedValue > max) {
        return false;
    }

    return value === normalizedValue;
}

function normalizeFieldValue(value, isDayOfWeek) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return null;
    }

    if (isDayOfWeek && parsed === 7) {
        return 0;
    }

    return parsed;
}

function getZonedDateParts(referenceTime, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hour12: false
    });
    const parts = formatter.formatToParts(referenceTime);
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return {
        year: Number(values.year),
        month: Number(values.month),
        dayOfMonth: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute),
        dayOfWeek: mapWeekday(values.weekday)
    };
}

function mapWeekday(weekday) {
    const mapping = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6
    };
    return mapping[weekday] === undefined ? 0 : mapping[weekday];
}

function buildRunKey(zonedParts) {
    return [
        zonedParts.year,
        String(zonedParts.month).padStart(2, '0'),
        String(zonedParts.dayOfMonth).padStart(2, '0')
    ].join('-') + `T${String(zonedParts.hour).padStart(2, '0')}:${String(zonedParts.minute).padStart(2, '0')}`;
}

function buildOutputPreview(stdout, stderr) {
    return [stdout, stderr]
        .filter(Boolean)
        .join('\n')
        .trim()
        .split(/\r?\n/)
        .slice(-10)
        .join('\n');
}

function sleepMs(durationMs) {
    if (!durationMs || durationMs <= 0) {
        return;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function readJsonFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const workspaceDir = path.resolve(__dirname, '..');
    const orchestrator = new AutonomousScrumOrchestrator('');
    const runtimeConfig = buildEffectiveRuntimeConfig(orchestrator.runtimeConfig, args.schedulerMode);
    const schedulerBackend = resolveSchedulerBackend(runtimeConfig, { workspaceDir });

    if (schedulerBackend.mode !== 'direct-worker') {
        throw new Error('direct-scheduler.js requires scheduler.mode="direct-worker". Set it in runtime-config.yml or pass --scheduler-mode direct-worker.');
    }

    const projectId = args.projectId || orchestrator.resolveActiveProjectId();
    if (!projectId && args.command !== 'list') {
        throw new Error('No active project configured. Set project.active in .openclaw/runtime-config.yml or pass --project <id>.');
    }

    let result;
    if (args.command === 'sync') {
        result = syncJobs(schedulerBackend, projectId, args.dryRun);
    } else if (args.command === 'list') {
        result = listJobs(schedulerBackend);
    } else if (args.command === 'run') {
        result = runSingleCeremony(schedulerBackend, runtimeConfig, workspaceDir, projectId, args.ceremony, args.dryRun);
    } else {
        result = tickJobs(schedulerBackend, runtimeConfig, workspaceDir, projectId, args);
    }

    console.log(JSON.stringify(result, null, 2));
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
