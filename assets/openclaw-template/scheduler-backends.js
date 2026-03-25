const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
    mode: 'openclaw-cron',
    job_prefix: 'agent-orchestration-workflow:',
    direct_worker: {
        state_file: '.openclaw/direct-scheduler-state.json',
        lock_file: '.openclaw/direct-scheduler.lock',
        lock_timeout_ms: 900000,
        retry_count: 2,
        retry_backoff_ms: 1000,
        command_timeout_ms: 600000
    }
});

function resolveSchedulerConfig(runtimeConfig) {
    return {
        ...DEFAULT_SCHEDULER_CONFIG,
        ...((runtimeConfig && runtimeConfig.scheduler) || {}),
        direct_worker: {
            ...DEFAULT_SCHEDULER_CONFIG.direct_worker,
            ...((((runtimeConfig && runtimeConfig.scheduler) || {}).direct_worker) || {})
        }
    };
}

function resolveSchedulerBackend(runtimeConfig, options = {}) {
    const schedulerConfig = resolveSchedulerConfig(runtimeConfig);

    if (schedulerConfig.mode === 'openclaw-cron') {
        return createOpenClawCronBackend(schedulerConfig);
    }

    if (schedulerConfig.mode === 'direct-worker') {
        return createDirectWorkerBackend(schedulerConfig, options);
    }

    throw new Error(`Unsupported scheduler mode "${schedulerConfig.mode}". Expected "openclaw-cron" or "direct-worker".`);
}

function createOpenClawCronBackend(schedulerConfig) {
    return {
        mode: schedulerConfig.mode,
        jobPrefix: schedulerConfig.job_prefix,
        registrationSupported: true,
        supportsFailureAlerts: true,
        listJobs() {
            const output = runOpenClaw(['cron', 'list', '--json']);
            const parsed = parseJsonOutput(output);
            return parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
        },
        listAgents() {
            const output = runOpenClaw(['agents', 'list', '--json']);
            const parsed = parseJsonOutput(output);
            return Array.isArray(parsed) ? parsed : [];
        },
        removeJob(jobId) {
            runOpenClaw(['cron', 'rm', jobId, '--json']);
        },
        addJob(job, dryRun) {
            const args = [
                'cron',
                'add',
                '--json',
                '--name', job.name,
                '--description', job.description,
                '--agent', job.agent,
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
                return { dryRun: true, args };
            }

            return parseJsonOutput(runOpenClaw(args));
        },
        applyFailureAlert(jobId, alertConfig, dryRun) {
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
                const safeArgs = args.map((arg, index) =>
                    arg === alertConfig.to && args[index - 1] === '--failure-alert-to' ? '<webhook-url>' : arg
                );
                return { dryRun: true, args: safeArgs };
            }

            try {
                const raw = runOpenClaw(args);
                return { ok: true, output: raw.slice(0, 120) };
            } catch (error) {
                const message = error.message || String(error);
                if (message.includes('unexpected property') || message.includes('failureAlert')) {
                    console.error(`Warning: failure alert not applied to ${jobId} - gateway does not support this field yet.`);
                    return { ok: false, skipped: true, reason: 'gateway_unsupported' };
                }

                throw error;
            }
        }
    };
}

function createDirectWorkerBackend(schedulerConfig, options) {
    const workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    const stateFilePath = path.resolve(workspaceDir, schedulerConfig.direct_worker.state_file);
    const lockFilePath = path.resolve(workspaceDir, schedulerConfig.direct_worker.lock_file);

    const readState = () => {
        const stored = readJsonFile(stateFilePath);
        if (!stored || typeof stored !== 'object') {
            return {
                scheduler_mode: 'direct-worker',
                job_prefix: schedulerConfig.job_prefix,
                jobs: []
            };
        }

        return {
            scheduler_mode: 'direct-worker',
            job_prefix: schedulerConfig.job_prefix,
            jobs: Array.isArray(stored.jobs) ? stored.jobs : []
        };
    };

    const writeState = state => {
        writeJsonFile(stateFilePath, state);
    };

    const upsertJob = job => {
        const state = readState();
        const existingIndex = state.jobs.findIndex(existingJob => existingJob.id === job.id);
        const existingJob = existingIndex >= 0 ? state.jobs[existingIndex] : null;
        const storedJob = {
            ...(existingJob || {}),
            ...job,
            enabled: job.enabled !== false,
            scheduler_mode: 'direct-worker',
            updated_at: new Date().toISOString()
        };

        if (existingIndex >= 0) {
            state.jobs[existingIndex] = storedJob;
        } else {
            state.jobs.push(storedJob);
        }

        writeState(state);
        return storedJob;
    };

    return {
        mode: schedulerConfig.mode,
        jobPrefix: schedulerConfig.job_prefix,
        registrationSupported: true,
        supportsFailureAlerts: false,
        stateFilePath,
        lockFilePath,
        directWorkerConfig: schedulerConfig.direct_worker,
        listJobs() {
            return readState().jobs;
        },
        listAgents: () => [],
        removeJob(jobId) {
            const state = readState();
            state.jobs = state.jobs.filter(job => job.id !== jobId);
            writeState(state);
        },
        addJob(job, dryRun) {
            const storedJob = {
                id: job.id || job.name,
                name: job.name,
                description: job.description,
                schedule: job.schedule,
                timezone: job.timezone,
                ceremonyCommand: job.ceremonyCommand,
                projectId: job.projectId,
                enabled: job.enabled !== false,
                last_run_at: job.last_run_at || null,
                last_success_at: job.last_success_at || null,
                last_run_key: job.last_run_key || '',
                consecutive_failures: Number.isInteger(job.consecutive_failures) ? job.consecutive_failures : 0,
                last_error: job.last_error || '',
                last_exit_code: job.last_exit_code === undefined ? null : job.last_exit_code,
                last_output_preview: job.last_output_preview || '',
                last_duration_ms: job.last_duration_ms === undefined ? null : job.last_duration_ms
            };

            if (dryRun) {
                return {
                    dryRun: true,
                    stateFilePath,
                    job: storedJob
                };
            }

            return upsertJob(storedJob);
        },
        applyFailureAlert: () => ({ skipped: true, reason: 'unsupported_backend' })
    };
}

function readJsonFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonFile(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function resolveOcl() {
    const probe = spawnSync('openclaw', ['--version'], { encoding: 'utf-8' });
    if (!probe.error) {
        return { cmd: 'openclaw', prefix: [] };
    }

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

module.exports = {
    DEFAULT_SCHEDULER_CONFIG,
    resolveSchedulerConfig,
    resolveSchedulerBackend
};