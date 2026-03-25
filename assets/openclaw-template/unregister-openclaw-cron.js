#!/usr/bin/env node
/**
 * Removes all OpenClaw cron jobs whose names start with the repo prefix.
 * Safe to re-run; idempotent when no matching jobs exist.
 *
 * Usage:
 *   node .openclaw/unregister-openclaw-cron.js            # remove all repo jobs
 *   node .openclaw/unregister-openclaw-cron.js --dry-run  # preview what would be removed
 */

const { spawnSync } = require('child_process');

const JOB_PREFIX = 'agent-orchestration-workflow:';

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
        timeout: 60000
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

function removeJob(jobId) {
    runOpenClaw(['cron', 'rm', jobId, '--json']);
}

function main() {
    const dryRun = process.argv.includes('--dry-run');

    const jobs = listJobs().filter(job => job.name.startsWith(JOB_PREFIX));

    if (jobs.length === 0) {
        console.log(JSON.stringify({
            dryRun,
            removed: [],
            message: `No cron jobs found with prefix "${JOB_PREFIX}".`
        }, null, 2));
        return;
    }

    const removed = [];
    const errors = [];

    jobs.forEach(job => {
        if (!dryRun) {
            try {
                removeJob(job.id);
            } catch (error) {
                errors.push({ id: job.id, name: job.name, error: error.message });
                return;
            }
        }

        removed.push({ id: job.id, name: job.name });
    });

    console.log(JSON.stringify({ dryRun, removed, errors }, null, 2));

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
