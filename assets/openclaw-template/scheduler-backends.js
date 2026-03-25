const { spawnSync } = require('child_process');

const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
    mode: 'openclaw-cron',
    job_prefix: 'agent-orchestration-workflow:'
});

function resolveSchedulerConfig(runtimeConfig) {
    return {
        ...DEFAULT_SCHEDULER_CONFIG,
        ...((runtimeConfig && runtimeConfig.scheduler) || {})
    };
}

function resolveSchedulerBackend(runtimeConfig) {
    const schedulerConfig = resolveSchedulerConfig(runtimeConfig);

    if (schedulerConfig.mode === 'openclaw-cron') {
        return createOpenClawCronBackend(schedulerConfig);
    }

    if (schedulerConfig.mode === 'direct-worker') {
        return createDirectWorkerBackend(schedulerConfig);
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

function createDirectWorkerBackend(schedulerConfig) {
    const notImplemented = () => {
        throw new Error('Scheduler mode "direct-worker" is not implemented yet. Keep scheduler.mode="openclaw-cron" until the direct worker backend is added.');
    };

    return {
        mode: schedulerConfig.mode,
        jobPrefix: schedulerConfig.job_prefix,
        registrationSupported: false,
        supportsFailureAlerts: false,
        listJobs: notImplemented,
        listAgents: () => [],
        removeJob: notImplemented,
        addJob: notImplemented,
        applyFailureAlert: () => ({ skipped: true, reason: 'unsupported_backend' })
    };
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