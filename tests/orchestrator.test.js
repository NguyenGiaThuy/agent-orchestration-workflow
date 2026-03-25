'use strict';

/**
 * Integration tests for AutonomousScrumOrchestrator.
 * Uses node:test (Node 18+) with no external dependencies.
 *
 * Each suite creates an isolated temp dir, seeds state/backlog, and exercises
 * the orchestrator against that workspace.
 *
 * Suites:
 *   1. State machine transitions
 *   2. Degraded execution / execution_health tracking
 *   3. selectBoundedContext — prompt context capping
 *   4. writeImplementationFiles — path-traversal guard
 *   5. runImplementationValidation — REVIEW/DONE gating
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMPLATE_DIR = path.resolve(__dirname, '..', 'assets', 'openclaw-template');
const Orchestrator = require(path.join(TEMPLATE_DIR, 'orchestrator.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated .openclaw-like workspace in a temp dir.
 * Returns { workspaceDir, openclawDir, cleanup }.
 * The returned Orchestrator has workspaceRoot pointing to workspaceDir and
 * baseDir pointing to openclawDir (so loadConfig reads from there).
 */
function makeSandbox(projectId = 'test-proj') {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  const openclawDir = path.join(workspaceDir, '.openclaw');
  fs.mkdirSync(openclawDir, { recursive: true });

  // Minimal runtime-config.yml: template mode (no openclaw binary needed),
  // approval required, stop_on_open_questions off by default.
  fs.writeFileSync(
    path.join(openclawDir, 'runtime-config.yml'),
    [
      'project:',
      `  active: "${projectId}"`,
      'openclaw:',
      '  mode: "template"',
      '  fallback_to_templates: true',
      '  save_transcripts: false',
    ].join('\n')
  );

  // Minimal discord-config.yml: disabled
  fs.writeFileSync(
    path.join(openclawDir, 'discord-config.yml'),
    'discord:\n  enabled: false\n'
  );

  function makeOrchestrator(pid = projectId) {
    const orc = new Orchestrator(pid);
    // Redirect baseDir and workspaceRoot to the sandbox
    orc.baseDir = openclawDir;
    orc.workspaceRoot = workspaceDir;
    orc.runtimeConfig = orc.loadConfig('runtime-config.yml', orc.runtimeConfig);
    orc.discordConfig = orc.loadConfig('discord-config.yml', orc.discordConfig);
    orc.setProjectContext(pid);
    return orc;
  }

  function cleanup() {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }

  return { workspaceDir, openclawDir, makeOrchestrator, cleanup };
}

/**
 * Seed a workflow-state.json file directly.
 */
function seedState(orc, partial) {
  orc.ensureProjectScaffold();
  const base = orc.loadState();
  const merged = { ...base, ...partial };
  orc.saveState(merged);
}

/**
 * Seed a backlog.json directly.
 */
function seedBacklog(orc, partial) {
  orc.ensureProjectScaffold();
  const base = orc.loadBacklog();
  const merged = { ...base, ...partial };
  orc.saveBacklog(merged);
}

// ---------------------------------------------------------------------------
// Suite 1: State machine transitions
// ---------------------------------------------------------------------------

describe('State machine transitions', () => {
  let sandbox;
  let orc;

  before(() => {
    sandbox = makeSandbox('sm-proj');
    orc = sandbox.makeOrchestrator('sm-proj');
    orc.ensureProjectScaffold();
  });

  after(() => sandbox.cleanup());

  it('loadState returns DISCOVERY_IN_PROGRESS when no state file exists', () => {
    // Fresh project, no state file yet
    const orc2 = sandbox.makeOrchestrator('fresh-proj');
    orc2.ensureProjectScaffold();
    const state = orc2.loadState();
    assert.equal(state.status, 'DISCOVERY_IN_PROGRESS');
    assert.equal(state.approval.status, 'PENDING');
    assert.deepEqual(state.open_questions, []);
  });

  it('seedState + loadState round-trips status correctly', () => {
    seedState(orc, { status: 'READY_FOR_APPROVAL' });
    const loaded = orc.loadState();
    assert.equal(loaded.status, 'READY_FOR_APPROVAL');
  });

  it('assertWorkflowStateAllowed throws when state is wrong', () => {
    seedState(orc, { status: 'DISCOVERY_IN_PROGRESS' });
    assert.throws(
      () => orc.assertWorkflowStateAllowed('sprint-planning', ['APPROVED_FOR_IMPLEMENTATION', 'IN_SPRINT']),
      /sprint-planning is only allowed/
    );
  });

  it('assertWorkflowStateAllowed passes when state matches', () => {
    seedState(orc, { status: 'APPROVED_FOR_IMPLEMENTATION' });
    assert.doesNotThrow(() =>
      orc.assertWorkflowStateAllowed('sprint-planning', ['APPROVED_FOR_IMPLEMENTATION', 'IN_SPRINT'])
    );
  });

  it('hasBlockingOpenQuestions is false when stop_on_open_questions=false (default)', () => {
    seedState(orc, { open_questions: ['What auth method?', 'What DB?'] });
    const state = orc.loadState();
    // stop_on_open_questions defaults to false in the template runtime config
    assert.equal(orc.hasBlockingOpenQuestions(state), false);
  });

  it('hasBlockingOpenQuestions is true when stop_on_open_questions=true + questions exist', () => {
    orc.runtimeConfig.workflow = orc.runtimeConfig.workflow || {};
    orc.runtimeConfig.workflow.stop_on_open_questions = true;
    seedState(orc, { open_questions: ['Unresolved?'] });
    const state = orc.loadState();
    assert.equal(orc.hasBlockingOpenQuestions(state), true);
    // Reset
    orc.runtimeConfig.workflow.stop_on_open_questions = false;
  });

  it('approveImplementation throws when open questions block (stop_on_open_questions=true)', async () => {
    orc.runtimeConfig.workflow = orc.runtimeConfig.workflow || {};
    orc.runtimeConfig.workflow.stop_on_open_questions = true;
    seedState(orc, {
      status: 'READY_FOR_APPROVAL',
      open_questions: ['Still unresolved.'],
      approval: { required: true, status: 'PENDING', requested_at: null, approved_at: null }
    });

    await assert.rejects(
      () => orc.approveImplementation(),
      /blocking open question/
    );
    // Reset
    orc.runtimeConfig.workflow.stop_on_open_questions = false;
  });

  it('approveImplementation moves state to APPROVED_FOR_IMPLEMENTATION', async () => {
    seedState(orc, {
      status: 'READY_FOR_APPROVAL',
      open_questions: [],
      approval: { required: true, status: 'PENDING', requested_at: null, approved_at: null }
    });
    seedBacklog(orc, { stories: [] });

    await orc.approveImplementation();

    const state = orc.loadState();
    assert.equal(state.status, 'APPROVED_FOR_IMPLEMENTATION');
    assert.equal(state.approval.status, 'APPROVED');
  });

  it('assertImplementationApproved throws when not approved', () => {
    seedState(orc, {
      status: 'READY_FOR_APPROVAL',
      approval: { required: true, status: 'PENDING', requested_at: null, approved_at: null }
    });
    assert.throws(() => orc.assertImplementationApproved(), /Implementation is blocked/);
  });

  it('assertImplementationApproved passes when approved', () => {
    seedState(orc, {
      approval: { required: true, status: 'APPROVED', requested_at: null, approved_at: new Date().toISOString() }
    });
    assert.doesNotThrow(() => orc.assertImplementationApproved());
  });

  it('AWAITING_USER_INPUT state is preserved through save/load cycle', () => {
    seedState(orc, { status: 'AWAITING_USER_INPUT', open_questions: ['Question 1', 'Question 2'] });
    const state = orc.loadState();
    assert.equal(state.status, 'AWAITING_USER_INPUT');
    assert.equal(state.open_questions.length, 2);
  });

  it('consumeAnsweredOpenQuestion removes matched question from state', () => {
    seedState(orc, {
      status: 'AWAITING_USER_INPUT',
      open_questions: ['Use OAuth2?', 'Which database?']
    });
    const state = orc.loadState();
    orc.consumeAnsweredOpenQuestion(state, 'Use OAuth2? Yes, use OAuth2.');
    orc.saveState(state);
    const updated = orc.loadState();
    // The question "Use OAuth2?" should be consumed
    assert.equal(updated.open_questions.length < 2 || !updated.open_questions.includes('Use OAuth2?'), true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Degraded execution / execution_health
// ---------------------------------------------------------------------------

describe('Degraded execution and execution_health', () => {
  let sandbox;
  let orc;

  before(() => {
    sandbox = makeSandbox('deg-proj');
    orc = sandbox.makeOrchestrator('deg-proj');
    orc.ensureProjectScaffold();
  });

  after(() => sandbox.cleanup());

  it('runAgentTurn in template mode records source=template_mode, degraded=false', async () => {
    const result = await orc.runAgentTurn({
      role: 'pm',
      ceremony: 'test_ceremony',
      prompt: 'Return JSON.',
      context: {},
      fallback: { summary: 'Fallback summary', bullets: [] },
      normalize: (c, b) => ({ ...b, ...c })
    });
    // Template mode is configured so degraded should be false (it's intentional mode)
    assert.equal(result.execution.source, 'template_mode');
    assert.equal(result.execution.degraded, false);
  });

  it('noteTurnExecutionEvent batches events on pendingExecutionEvents', () => {
    orc.pendingExecutionEvents = [];
    orc.noteTurnExecutionEvent('discovery_sync', 'po', {
      source: 'template_fallback',
      degraded: true,
      reason: 'runner_unavailable'
    });
    assert.equal(orc.pendingExecutionEvents.length, 1);
    assert.equal(orc.pendingExecutionEvents[0].source, 'template_fallback');
  });

  it('applyPendingExecutionEvents increments degraded_events and clears queue', () => {
    orc.pendingExecutionEvents = [];
    orc.noteTurnExecutionEvent('standup', 'pm', { source: 'template_fallback', degraded: true, reason: 'test' });
    orc.noteTurnExecutionEvent('standup', 'po', { source: 'partial_parse_fallback', degraded: true, reason: 'test' });

    const health = orc.applyPendingExecutionEvents(orc.buildDefaultExecutionHealth());
    assert.equal(health.degraded_events, 2);
    assert.equal(health.recent_degraded_events.length, 2);
    assert.equal(orc.pendingExecutionEvents.length, 0);
  });

  it('saveState persists execution_health from pending events', () => {
    orc.pendingExecutionEvents = [];
    orc.noteTurnExecutionEvent('qc_sync', 'qc', { source: 'template_fallback', degraded: true, reason: 'forced' });
    const state = orc.loadState();
    orc.saveState(state);

    const reloaded = orc.loadState();
    assert.equal(reloaded.execution_health.degraded_events >= 1, true,
      'Expected at least 1 degraded event after saveState');
  });

  it('execution-health.md is written after saveState with degraded events', () => {
    orc.pendingExecutionEvents = [];
    orc.noteTurnExecutionEvent('feedback', 'developer', { source: 'template_fallback', degraded: true, reason: 'injected' });
    const state = orc.loadState();
    orc.saveState(state);

    const healthDoc = path.join(orc.docsDir, 'execution-health.md');
    assert.equal(fs.existsSync(healthDoc), true, 'execution-health.md should exist');
    const content = fs.readFileSync(healthDoc, 'utf-8');
    assert.match(content, /Degraded events recorded/);
    assert.match(content, /template_fallback/);
  });

  it('recent_degraded_events is capped at 10 entries', () => {
    orc.pendingExecutionEvents = [];
    for (let i = 0; i < 12; i++) {
      orc.noteTurnExecutionEvent('standup', 'pm', { source: 'template_fallback', degraded: true, reason: `event-${i}` });
    }
    const seed = { ...orc.buildDefaultExecutionHealth(), recent_degraded_events: [] };
    const health = orc.applyPendingExecutionEvents(seed);
    assert.equal(health.recent_degraded_events.length, 10);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: selectBoundedContext — prompt context bounding
// ---------------------------------------------------------------------------

describe('selectBoundedContext', () => {
  let sandbox;
  let orc;

  before(() => {
    sandbox = makeSandbox('ctx-proj');
    orc = sandbox.makeOrchestrator('ctx-proj');
    orc.ensureProjectScaffold();
  });

  after(() => sandbox.cleanup());

  it('returns empty string when no feedback, no questions, no active stories', () => {
    const state = { open_questions: [], status: 'DISCOVERY_IN_PROGRESS' };
    const result = orc.selectBoundedContext('pm', 'discovery_sync', state, null);
    assert.equal(result, '');
  });

  it('includes unresolved questions up to 3', () => {
    const state = {
      open_questions: ['Q1?', 'Q2?', 'Q3?', 'Q4?', 'Q5?'],
      status: 'READY_FOR_APPROVAL'
    };
    const result = orc.selectBoundedContext('pm', 'discovery_sync', state, null);
    assert.match(result, /Unresolved questions \(top 3\)/);
    assert.match(result, /Q1\?/);
    assert.match(result, /Q3\?/);
    // Q4 and Q5 are beyond the cap
    assert.doesNotMatch(result, /Q4\?/);
    assert.doesNotMatch(result, /Q5\?/);
  });

  it('caps business feedback to 3 for PM role', () => {
    // Write 5 feedback entries to the log
    orc.ensureProjectScaffold();
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `FB-${i}`,
      timestamp: new Date().toISOString(),
      type: 'business',
      message: `Business feedback number ${i + 1}`,
      workflow_state_at_time: 'DISCOVERY_IN_PROGRESS'
    }));
    orc.writeJson(path.join(orc.docsDir, 'feedback-log.json'), entries);

    const state = { open_questions: [], status: 'READY_FOR_APPROVAL' };
    const result = orc.selectBoundedContext('pm', 'discovery_sync', state, null);
    // Should show at most 3 entries (the last 3: indices 2, 3, 4)
    assert.match(result, /Recent business feedback \(latest 3\)/);
    assert.match(result, /number 5/);
    assert.doesNotMatch(result, /number 1/);
    assert.doesNotMatch(result, /number 2/);
  });

  it('filters to technical feedback for developer role', () => {
    const entries = [
      { id: 'FB-B', timestamp: new Date().toISOString(), type: 'business', message: 'Business only', workflow_state_at_time: 'x' },
      { id: 'FB-T', timestamp: new Date().toISOString(), type: 'technical', message: 'Technical note', workflow_state_at_time: 'x' }
    ];
    orc.writeJson(path.join(orc.docsDir, 'feedback-log.json'), entries);

    const state = { open_questions: [], status: 'IN_SPRINT' };
    const result = orc.selectBoundedContext('developer', 'feedback', state, { stories: [] });
    assert.match(result, /Technical note/);
    assert.doesNotMatch(result, /Business only/);
  });

  it('includes active sprint stories for sprint ceremonies', () => {
    const state = { open_questions: [], status: 'IN_SPRINT', current_sprint_id: 'sprint-1' };
    const backlog = {
      stories: [
        { id: 'STORY-1', status: 'IN_SPRINT', title: 'First story' },
        { id: 'STORY-2', status: 'DONE', title: 'Done story' },
        { id: 'STORY-3', status: 'REVIEW', title: 'In review story' }
      ]
    };
    orc.writeJson(path.join(orc.docsDir, 'feedback-log.json'), []);
    const result = orc.selectBoundedContext('pm', 'daily_standup', state, backlog);
    assert.match(result, /STORY-1/);
    assert.match(result, /STORY-3/);
    // DONE stories are not active
    assert.doesNotMatch(result, /STORY-2/);
  });

  it('does not include sprint stories for non-sprint ceremonies', () => {
    const state = { open_questions: [], status: 'DISCOVERY_IN_PROGRESS' };
    const backlog = {
      stories: [{ id: 'STORY-1', status: 'IN_SPRINT', title: 'Should not appear' }]
    };
    orc.writeJson(path.join(orc.docsDir, 'feedback-log.json'), []);
    const result = orc.selectBoundedContext('pm', 'discovery_sync', state, backlog);
    assert.doesNotMatch(result, /STORY-1/);
  });

  it('caps active sprint stories at 5', () => {
    const state = { open_questions: [], status: 'IN_SPRINT' };
    const stories = Array.from({ length: 8 }, (_, i) => ({
      id: `STORY-${i + 1}`,
      status: 'IN_SPRINT',
      title: `Story ${i + 1}`
    }));
    orc.writeJson(path.join(orc.docsDir, 'feedback-log.json'), []);
    const result = orc.selectBoundedContext('pm', 'daily_standup', state, { stories });
    assert.match(result, /Active sprint stories \(5\)/);
    assert.doesNotMatch(result, /STORY-6/);
    assert.doesNotMatch(result, /STORY-7/);
    assert.doesNotMatch(result, /STORY-8/);
  });

  it('normalizes object-shaped open questions to strings', () => {
    const state = {
      open_questions: [{ question: 'Object question?' }, 'String question?'],
      status: 'READY_FOR_APPROVAL'
    };
    orc.writeJson(path.join(orc.docsDir, 'feedback-log.json'), []);
    const result = orc.selectBoundedContext('pm', 'discovery_sync', state, null);
    assert.match(result, /Object question\?/);
    assert.match(result, /String question\?/);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: writeImplementationFiles — path-traversal guard
// ---------------------------------------------------------------------------

describe('writeImplementationFiles — path-traversal guard', () => {
  let sandbox;
  let orc;

  before(() => {
    sandbox = makeSandbox('sec-proj');
    orc = sandbox.makeOrchestrator('sec-proj');
    orc.ensureProjectScaffold();
  });

  after(() => sandbox.cleanup());

  it('writes a safe file inside baseDir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-safe-'));
    try {
      const written = orc.writeImplementationFiles(
        [{ path: 'src/feature.js', content: '// ok' }],
        tmpDir
      );
      assert.equal(written.length, 1);
      assert.match(written[0].absPath, /src\/feature\.js$/);
      assert.equal(fs.existsSync(written[0].absPath), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('blocks a path-traversal attempt (../../etc)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-trav-'));
    try {
      const written = orc.writeImplementationFiles(
        [{ path: '../../etc/malicious', content: 'BAD' }],
        tmpDir
      );
      assert.equal(written.length, 0, 'Path traversal should be blocked, nothing written');
      const malicious = path.resolve(tmpDir, '../../etc/malicious');
      assert.equal(fs.existsSync(malicious), false, 'Malicious file should not exist');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('blocks an absolute path outside baseDir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-abs-'));
    try {
      const outsidePath = path.join(os.tmpdir(), 'outside-file.txt');
      const written = orc.writeImplementationFiles(
        [{ path: outsidePath, content: 'BAD' }],
        tmpDir
      );
      assert.equal(written.length, 0, 'Absolute outside path should be blocked');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes multiple safe files and skips the one traversal in the batch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-batch-'));
    try {
      const written = orc.writeImplementationFiles(
        [
          { path: 'src/a.js', content: '// a' },
          { path: '../../evil.sh', content: 'rm -rf /' },
          { path: 'src/b.js', content: '// b' }
        ],
        tmpDir
      );
      assert.equal(written.length, 2, 'Only the 2 safe files should be written');
      assert.equal(fs.existsSync(path.join(tmpDir, 'src/a.js')), true);
      assert.equal(fs.existsSync(path.join(tmpDir, 'src/b.js')), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 5: runImplementationValidation — REVIEW/DONE gating
// ---------------------------------------------------------------------------

describe('runImplementationValidation — REVIEW/DONE gating', () => {
  let sandbox;
  let orc;

  before(() => {
    sandbox = makeSandbox('val-proj');
    orc = sandbox.makeOrchestrator('val-proj');
    orc.ensureProjectScaffold();
  });

  after(() => sandbox.cleanup());

  it('returns skipped=true when validation disabled', () => {
    orc.runtimeConfig.validation = { enabled: false, command: '', args: [], cwd: '.', timeout_ms: 5000 };
    const result = orc.runImplementationValidation([{ story_id: 'STORY-1' }]);
    assert.equal(result.skipped, true);
    assert.equal(result.configured, false);
    assert.equal(result.ok, null);
  });

  it('returns skipped=true when enabled but command is empty', () => {
    orc.runtimeConfig.validation = { enabled: true, command: '', args: [], cwd: '.', timeout_ms: 5000 };
    const result = orc.runImplementationValidation([{ story_id: 'STORY-1' }]);
    assert.equal(result.skipped, true);
  });

  it('returns ok=true when validation command exits 0', () => {
    orc.runtimeConfig.validation = {
      enabled: true,
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: '.',
      timeout_ms: 5000
    };
    const result = orc.runImplementationValidation([{ story_id: 'STORY-1' }]);
    assert.equal(result.configured, true);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.summary, /Validation passed/);
  });

  it('returns ok=false when validation command exits non-zero', () => {
    orc.runtimeConfig.validation = {
      enabled: true,
      command: 'node',
      args: ['-e', 'process.exit(1)'],
      cwd: '.',
      timeout_ms: 5000
    };
    const result = orc.runImplementationValidation([{ story_id: 'STORY-1' }]);
    assert.equal(result.configured, true);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /REVIEW/);
  });

  it('returns ok=false when validation command does not exist', () => {
    orc.runtimeConfig.validation = {
      enabled: true,
      command: 'nonexistent-cmd-xyz',
      args: [],
      cwd: '.',
      timeout_ms: 5000
    };
    const result = orc.runImplementationValidation([{ story_id: 'STORY-1' }]);
    assert.equal(result.configured, true);
    assert.equal(result.ok, false);
  });

  it('story_ids in result match the input implementation log', () => {
    orc.runtimeConfig.validation = { enabled: false, command: '', args: [], cwd: '.', timeout_ms: 5000 };
    const log = [{ story_id: 'STORY-A' }, { story_id: 'STORY-B' }];
    const result = orc.runImplementationValidation(log);
    assert.deepEqual(result.story_ids, ['STORY-A', 'STORY-B']);
  });
});
