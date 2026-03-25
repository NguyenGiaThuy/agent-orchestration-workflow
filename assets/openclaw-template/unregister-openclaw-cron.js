#!/usr/bin/env node
/**
 * Removes all OpenClaw cron jobs whose names start with the repo prefix.
 * Safe to re-run; idempotent when no matching jobs exist.
 *
 * Usage:
 *   node .openclaw/unregister-openclaw-cron.js            # remove all repo jobs
 *   node .openclaw/unregister-openclaw-cron.js --dry-run  # preview what would be removed
 */

const path = require('path');

const AutonomousScrumOrchestrator = require('./orchestrator');
const { resolveSchedulerBackend } = require('./scheduler-backends');

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

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const schedulerModeIndex = process.argv.indexOf('--scheduler-mode');
    const schedulerMode = schedulerModeIndex >= 0 ? process.argv[schedulerModeIndex + 1] || '' : '';
    const orchestrator = new AutonomousScrumOrchestrator('');
    const runtimeConfig = buildEffectiveRuntimeConfig(orchestrator.runtimeConfig, schedulerMode);
    const schedulerBackend = resolveSchedulerBackend(runtimeConfig, { workspaceDir: path.resolve(__dirname, '..') });

    const jobs = schedulerBackend.listJobs().filter(job => job.name.startsWith(schedulerBackend.jobPrefix));

    if (jobs.length === 0) {
        console.log(JSON.stringify({
            dryRun,
            removed: [],
            schedulerMode: schedulerBackend.mode,
            message: `No scheduler jobs found with prefix "${schedulerBackend.jobPrefix}".`
        }, null, 2));
        return;
    }

    const removed = [];
    const errors = [];

    jobs.forEach(job => {
        if (!dryRun) {
            try {
                schedulerBackend.removeJob(job.id);
            } catch (error) {
                errors.push({ id: job.id, name: job.name, error: error.message });
                return;
            }
        }

        removed.push({ id: job.id, name: job.name });
    });

    console.log(JSON.stringify({ dryRun, schedulerMode: schedulerBackend.mode, removed, errors }, null, 2));

    if (errors.length > 0) {
        process.exitCode = 1;
    }
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
