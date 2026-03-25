#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const YAML = require('yaml');
const {
  DEFAULT_DISCOVERY_PROFILE,
  resolveDiscoveryProfileTemplate,
  buildDiscoveryProfileFromTemplate
} = require('./discovery-profile-templates');

const WORKFLOW_STATES = Object.freeze({
  DISCOVERY_IN_PROGRESS: 'DISCOVERY_IN_PROGRESS',
  AWAITING_USER_INPUT: 'AWAITING_USER_INPUT',
  READY_FOR_APPROVAL: 'READY_FOR_APPROVAL',
  APPROVED_FOR_IMPLEMENTATION: 'APPROVED_FOR_IMPLEMENTATION',
  IN_SPRINT: 'IN_SPRINT',
  RELEASE_CANDIDATE: 'RELEASE_CANDIDATE'
});

const DEFAULT_RUNTIME_CONFIG = {
  project: {
    active: ''
  },
  storage: {
    docs_dir: 'docs'
  },
  workflow: {
    approval_required_for_implementation: true,
    use_documented_assumptions: true,
    stop_on_open_questions: false
  },
  reporting: {
    daily_digest_enabled: true,
    send_ceremony_updates: true,
    auto_request_approval_after_discovery: true
  },
  openclaw: {
    mode: 'auto',
    adapter: 'stdio-json',
    command: 'openclaw',
    args: [],
    agent: 'main',
    local: true,
    timeout_ms: 120000,
    fallback_to_templates: true,
    save_transcripts: true,
    transcript_dir: 'agent-turns'
  },
  validation: {
    enabled: false,
    command: '',
    args: [],
    cwd: '.',
    timeout_ms: 120000
  }
};

const DEFAULT_DISCORD_CONFIG = {
  discord: {
    enabled: false,
    transport: 'channel',
    webhook_env: 'OPENCLAW_DISCORD_WEBHOOK',
    webhook_url: '',
    username: 'OpenClaw PM',
    avatar_url: '',
    mention_targets: {
      approval_required: '',
      blocker_escalation: '',
      daily_digest: ''
    },
    routing: {
      daily_activity_label: 'daily-activity',
      blockers_label: 'blockers',
      approvals_label: 'approvals'
    },
    message_settings: {
      include_blockers: true,
      include_next_steps: true,
      max_bullets: 5
    }
  }
};

class AutonomousScrumOrchestrator {
  constructor(projectId) {
    this.baseDir = path.dirname(__filename);
    this.workspaceRoot = path.resolve(this.baseDir, '..');
    this.runtimeConfig = this.loadConfig('runtime-config.yml', DEFAULT_RUNTIME_CONFIG);
    this.discordConfig = this.loadConfig('discord-config.yml', DEFAULT_DISCORD_CONFIG);
    this.agents = {
      pm: { name: 'Project Manager', slug: 'pm-orchestrator' },
      po: { name: 'Product Owner', slug: 'po-product' },
      developer: { name: 'Developer', slug: 'dev-implementation' },
      qc: { name: 'QC', slug: 'qc-quality' }
    };

    this.projectId = '';
    this.projectDir = null;
    this.docsDir = null;
    this.openClawRunnerStatus = {
      attempted: false,
      available: null,
      reason: ''
    };
    this.pendingExecutionEvents = [];
    this.setProjectContext(projectId || this.resolveActiveProjectId());
  }

  setProjectContext(projectId) {
    this.projectId = projectId || '';
    this.projectDir = this.projectId ? path.join(this.workspaceRoot, this.projectId) : null;
    this.docsDir = this.projectDir
      ? path.join(this.projectDir, this.getConfigValue(this.runtimeConfig, ['storage', 'docs_dir']) || 'docs')
      : null;
  }

  async startIdea(idea, requestedProjectId) {
    const normalizedIdea = String(idea || '').trim();
    if (!normalizedIdea) {
      throw new Error('start-idea requires --idea with a short product statement.');
    }

    const derivedProjectId = requestedProjectId || this.deriveProjectId(normalizedIdea);
    this.setProjectContext(derivedProjectId);
    return this.initProject(normalizedIdea);
  }

  async initProject(idea) {
    this.assertProjectSelected();
    const normalizedIdea = idea || this.titleizeProjectId(this.projectId);
    const profile = this.buildDiscoveryProfile(normalizedIdea);

    this.ensureProjectScaffold();

    const state = this.loadState();
    state.project_id = this.projectId;
    state.project_name = profile.projectName;
    state.idea = normalizedIdea;
    state.status = WORKFLOW_STATES.DISCOVERY_IN_PROGRESS;
    state.assumptions = profile.assumptions;
    state.open_questions = profile.openQuestions;
    state.approval = {
      required: true,
      status: 'PENDING',
      requested_at: null,
      approved_at: null
    };
    state.current_sprint_id = null;
    state.updated_at = new Date().toISOString();

    this.writeDiscoveryArtifacts(profile, state);
    this.saveState(state);

    return this.discoverySync();
  }

  async discoverySync() {
    this.assertProjectSelected();
    this.assertWorkflowStateAllowed('discovery-sync', [
      WORKFLOW_STATES.DISCOVERY_IN_PROGRESS,
      WORKFLOW_STATES.AWAITING_USER_INPUT,
      WORKFLOW_STATES.READY_FOR_APPROVAL
    ]);
    this.ensureProjectScaffold();

    const state = this.loadState();
    const idea = state.idea || this.titleizeProjectId(this.projectId);
    const profile = this.buildDiscoveryProfile(idea);

    state.project_name = profile.projectName;
    state.idea = idea;
    state.assumptions = profile.assumptions;
    state.open_questions = this.buildOpenQuestions(profile.openQuestions, state.open_questions, state.resolved_open_questions);
    state.last_sync = new Date().toISOString();
    state.updated_at = state.last_sync;
    this.syncDiscoveryApprovalState(state, {
      requestApproval: this.getConfigValue(this.runtimeConfig, ['reporting', 'auto_request_approval_after_discovery'])
    });

    const discoveryNotes = await this.collectDiscoveryNotes(profile, state);
    const backlog = this.buildBacklog(profile, state);
    this.writeDiscoveryArtifacts(profile, state, backlog, discoveryNotes);

    if (state.status === WORKFLOW_STATES.READY_FOR_APPROVAL || state.status === WORKFLOW_STATES.AWAITING_USER_INPUT) {
      this.writeMarkdown(
        path.join(this.docsDir, 'approval-request.md'),
        this.renderApprovalRequest(profile, state, backlog, discoveryNotes.pm)
      );
    }

    this.syncBacklogState(backlog, state);
    this.saveBacklog(backlog);
    this.saveState(state);
    const nextAction = this.buildNextActions(state, backlog)[0];
    const notificationKind = state.status === WORKFLOW_STATES.READY_FOR_APPROVAL ? 'approval_required' : 'ceremony_update';
    const executionWarningBullets = this.buildExecutionWarningBullets(discoveryNotes, 1);
    await this.sendDiscordNotification(notificationKind, {
      title: `${profile.projectName}: discovery package ${state.status === WORKFLOW_STATES.AWAITING_USER_INPUT ? 'updated' : 'ready'}`,
      summary: state.status === WORKFLOW_STATES.AWAITING_USER_INPUT
        ? `Discovery refreshed for **${profile.projectName}**. Approval is paused until the blocking open questions are answered.`
        : `Discovery complete for **${profile.projectName}**. Review and approve to unlock implementation.`,
      bullets: [
        `📁 Docs: ${this.docsDir}`,
        `❓ Open questions (${state.open_questions.length}): ${state.open_questions.length > 0 ? state.open_questions.slice(0, 3).map(q => typeof q === 'string' ? q : (q.question || JSON.stringify(q))).join(' · ') : 'none'}`,
        `📋 Backlog (${backlog.stories.length} stories): ${backlog.stories.slice(0, 3).map(s => s.title || s.id).join(' · ')}${backlog.stories.length > 3 ? ` (+${backlog.stories.length - 3} more)` : ''}`,
        ...executionWarningBullets,
        `✅ Next: ${nextAction}`
      ]
    });

    return { state, backlog, discovery_notes: discoveryNotes };
  }

  async requestApproval() {
    this.assertProjectSelected();
    this.assertWorkflowStateAllowed('request-approval', [
      WORKFLOW_STATES.DISCOVERY_IN_PROGRESS,
      WORKFLOW_STATES.AWAITING_USER_INPUT,
      WORKFLOW_STATES.READY_FOR_APPROVAL
    ]);
    const state = this.loadState();
    const backlog = this.loadBacklog();

    this.syncDiscoveryApprovalState(state, { requestApproval: true });
    state.updated_at = new Date().toISOString();
    this.syncBacklogState(backlog, state);
    this.saveBacklog(backlog);
    this.saveState(state);

    const profile = this.buildDiscoveryProfile(state.idea || this.titleizeProjectId(this.projectId));
    this.writeMarkdown(
      path.join(this.docsDir, 'approval-request.md'),
      this.renderApprovalRequest(profile, state, backlog)
    );

    const nextAction = this.buildNextActions(state, backlog)[0];
    const notificationKind = state.status === WORKFLOW_STATES.READY_FOR_APPROVAL ? 'approval_required' : 'ceremony_update';
    await this.sendDiscordNotification(notificationKind, {
      title: `${profile.projectName}: ${state.status === WORKFLOW_STATES.AWAITING_USER_INPUT ? 'approval blocked' : 'approval requested'}`,
      summary: state.status === WORKFLOW_STATES.AWAITING_USER_INPUT
        ? `**${profile.projectName}** still has blocking open questions. Capture the missing answers before requesting approval again.`
        : `**${profile.projectName}** is ready for your review. Docs at \`${this.docsDir}\`.`,
      bullets: [
        `❓ Open questions (${state.open_questions.length}): ${state.open_questions.length > 0 ? state.open_questions.slice(0, 3).map(q => typeof q === 'string' ? q : (q.question || JSON.stringify(q))).join(' · ') : 'none'}`,
        `📋 Backlog: ${backlog.stories.length} stories ready`,
        `📄 Approval doc: ${path.join(this.docsDir, 'approval-request.md')}`,
        `✅ Next: ${nextAction}`
      ]
    });

    return state;
  }

  async approveImplementation() {
    this.assertProjectSelected();
    const state = this.loadState();
    const backlog = this.loadBacklog();

    if (this.hasBlockingOpenQuestions(state)) {
      throw new Error(`Implementation cannot be approved while ${state.open_questions.length} blocking open question(s) remain. Record the missing answers first or set workflow.stop_on_open_questions=false.`);
    }

    if (state.status !== WORKFLOW_STATES.READY_FOR_APPROVAL && state.status !== WORKFLOW_STATES.APPROVED_FOR_IMPLEMENTATION) {
      throw new Error('Implementation can only be approved from READY_FOR_APPROVAL. Run request-approval first.');
    }

    if (state.status === WORKFLOW_STATES.APPROVED_FOR_IMPLEMENTATION && state.approval.status === 'APPROVED') {
      return state;
    }

    state.status = WORKFLOW_STATES.APPROVED_FOR_IMPLEMENTATION;
    state.approval.status = 'APPROVED';
    state.approval.approved_at = new Date().toISOString();
    state.updated_at = new Date().toISOString();
    this.syncBacklogState(backlog, state);
    this.saveBacklog(backlog);
    this.saveState(state);

    await this.sendDiscordNotification('approval_required', {
      title: `${state.project_name || this.titleizeProjectId(this.projectId)}: implementation approved ✅`,
      summary: `**${state.project_name || this.titleizeProjectId(this.projectId)}** approved — ${backlog.stories.length} stories queued for sprint planning.`,
      bullets: [
        `📋 Total stories: ${backlog.stories.length}`,
        `📋 Ready for planning: ${backlog.stories.filter(s => s.status !== 'DONE' && s.status !== 'IN_SPRINT').length}`,
        `▶️ Next: node .openclaw/orchestrator.js sprint-planning`
      ]
    });

    return state;
  }

  async standupCeremony() {
    this.assertProjectSelected();
    this.assertWorkflowStateAllowed('standup', [
      WORKFLOW_STATES.READY_FOR_APPROVAL,
      WORKFLOW_STATES.APPROVED_FOR_IMPLEMENTATION,
      WORKFLOW_STATES.IN_SPRINT,
      WORKFLOW_STATES.RELEASE_CANDIDATE
    ]);
    this.ensureProjectScaffold();

    const state = this.loadState();
    const backlog = this.loadBacklog();
    const profile = this.buildDiscoveryProfile(state.idea || this.titleizeProjectId(this.projectId));
    const ceremony = {
      timestamp: new Date().toISOString(),
      ceremony: 'daily_standup',
      state: state.status,
      attendees: Object.values(this.agents)
    };

    const standupReports = await Promise.all(
      Object.keys(this.agents).map(async role => [role, await this.buildStandupReport(role, state, profile, backlog)])
    );
    standupReports.forEach(([role, report]) => {
      ceremony[role] = report;
    });

    const blockers = this.extractBlockers(ceremony, state.status);
    if (blockers.length > 0) {
      await this.escalateBlockers(blockers, state.status);
    }

    this.saveCeremonyRecord('standups', `standup-${this.todayStamp()}.json`, ceremony);
    state.updated_at = ceremony.timestamp;
    this.saveState(state);

    await this.sendDailyActivityReport('daily_standup', state, blockers, ceremony);

    return ceremony;
  }

  async sprintPlanningCeremony() {
    this.assertImplementationApproved();
    this.assertWorkflowStateAllowed('sprint-planning', [WORKFLOW_STATES.APPROVED_FOR_IMPLEMENTATION]);
    const state = this.loadState();
    const backlog = this.loadBacklog();
    const profile = this.buildDiscoveryProfile(state.idea || this.titleizeProjectId(this.projectId));
    const sprintId = this.buildNextSprintId(state);
    const planningTimestamp = new Date().toISOString();
    const teamCapacityPoints = this.getConfigValue(backlog, ['sprint_constraints', 'team_capacity_story_points']) || 20;
    const candidateStories = backlog.stories.filter(story => story.status !== 'DONE').slice(0, 6);
    const prioritizedStories = [];
    let committedPoints = 0;

    candidateStories.forEach(story => {
      const nextCommitment = committedPoints + story.story_points;
      if (prioritizedStories.length > 0 && nextCommitment > teamCapacityPoints) {
        return;
      }

      prioritizedStories.push(story);
      committedPoints = nextCommitment;
    });

    const prioritizedStoryIds = new Set(prioritizedStories.map(story => story.id));

    backlog.stories = backlog.stories.map(story => {
      if (prioritizedStoryIds.has(story.id)) {
        return { ...story, status: 'IN_SPRINT' };
      }

      if (story.status === 'DONE') {
        return story;
      }

      if (story.status === 'IN_SPRINT') {
        return { ...story, status: 'READY_FOR_PLANNING' };
      }

      return story;
    });

    state.status = WORKFLOW_STATES.IN_SPRINT;
    state.current_sprint_id = sprintId;
    state.updated_at = planningTimestamp;

    this.syncBacklogState(backlog, state);
    const sprintStories = backlog.stories.filter(story => prioritizedStoryIds.has(story.id));
    const plannedPoints = sprintStories.reduce((total, story) => total + story.story_points, 0);
    const planningNotes = await this.collectPlanningNotes(
      profile,
      state,
      sprintStories,
      plannedPoints,
      sprintId,
      teamCapacityPoints
    );

    const plan = {
      timestamp: planningTimestamp,
      ceremony: 'sprint_planning',
      sprint_id: sprintId,
      sprint_goal: `Deliver the first validated slice of ${profile.projectName}`,
      attendees: Object.values(this.agents),
      agent_turns: planningNotes,
      po_scope: this.buildSprintScope(sprintStories),
      developer_plan: this.buildDeveloperPlan(sprintStories),
      qc_strategy: this.buildQcPlan(sprintStories),
      pm_notes: this.buildPmPlan(state, plannedPoints),
      stories: sprintStories,
      capacity_check: {
        planned_story_points: plannedPoints,
        team_capacity_story_points: teamCapacityPoints,
        fits_capacity: plannedPoints <= teamCapacityPoints
      }
    };

    this.saveBacklog(backlog);
    this.saveSprintPlan(plan);
    this.saveState(state);

    const executionWarningBullets = this.buildExecutionWarningBullets(planningNotes, 1);

    await this.sendDiscordNotification('ceremony_update', {
      title: `${profile.projectName}: ${sprintId} committed`,
      summary: `Sprint **${sprintId}** locked — ${sprintStories.length} stories, ${plannedPoints}/${teamCapacityPoints} pts committed.`,
      bullets: [
        `🎯 Goal: ${plan.sprint_goal}`,
        `📋 Stories (${sprintStories.length}): ${sprintStories.slice(0, 5).map(s => `${s.id} (${s.story_points}pt)`).join(' · ')}${sprintStories.length > 5 ? ` +${sprintStories.length - 5} more` : ''}`,
        `⚡ Capacity: ${plannedPoints}/${teamCapacityPoints} pts — ${plan.capacity_check.fits_capacity ? 'fits ✓' : 'over capacity ⚠️'}`,
        ...executionWarningBullets,
        `▶️ Daily standups are now active`
      ]
    });

    return plan;
  }

  async dailyQcSyncCeremony() {
    this.assertProjectSelected();
    this.assertWorkflowStateAllowed('qc-sync', [WORKFLOW_STATES.IN_SPRINT]);
    const state = this.loadState();
    const backlog = this.loadBacklog();
    const inSprint = backlog.stories.filter(story => this.isStoryActive(story) || this.isStoryDone(story));
    const qcSyncNotes = await this.collectQcSyncNotes(state, inSprint);

    const report = {
      timestamp: new Date().toISOString(),
      ceremony: 'daily_qc_sync',
      sprint_id: state.current_sprint_id,
      state: state.status,
      agent_turns: qcSyncNotes,
      developer: {
        completed_today: inSprint.filter(story => this.isStoryDone(story)).map(story => story.id),
        active_work: inSprint.filter(story => this.isStoryActive(story)).map(story => story.id),
        blockers: state.status === WORKFLOW_STATES.IN_SPRINT ? [] : ['Sprint has not started yet'],
        summary: qcSyncNotes.developer.summary
      },
      qc: {
        scenarios_ready: inSprint.map(story => ({
          story_id: story.id,
          scenarios: story.qc_scenarios
        })),
        bug_summary: {
          total: 0,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0
        },
        release_risks: state.status === WORKFLOW_STATES.IN_SPRINT ? [] : ['Awaiting approved sprint execution'],
        summary: qcSyncNotes.qc.summary
      }
    };

    this.saveCeremonyRecord('qc-sync', `qc-sync-${this.todayStamp()}.json`, report);
    const executionWarningBullets = this.buildExecutionWarningBullets(qcSyncNotes, 1);
    await this.sendDiscordNotification('ceremony_update', {
      title: `${state.project_name || this.titleizeProjectId(this.projectId)}: QC sync — ${state.current_sprint_id || 'no sprint'}`,
      summary: `QC sync for sprint **${state.current_sprint_id || 'none'}** — ${report.developer.completed_today.length} done, ${report.developer.active_work.length} active.`,
      bullets: [
        `✅ Completed: ${report.developer.completed_today.join(', ') || 'none'}`,
        `🔧 In progress: ${report.developer.active_work.join(', ') || 'none'}`,
        `🧪 Scenarios ready: ${report.qc.scenarios_ready.length} stories covered`,
        `🚧 Blockers: ${report.developer.blockers.length > 0 ? report.developer.blockers.join('; ') : 'none'}`,
        ...executionWarningBullets,
        `⚠️ Release risks: ${report.qc.release_risks.length > 0 ? report.qc.release_risks.join('; ') : 'none'}`
      ]
    });

    return report;
  }

  async implementStoriesCeremony() {
    this.assertImplementationApproved();
    this.ensureProjectScaffold();

    const state = this.loadState();
    const backlog = this.loadBacklog();
    const profile = this.buildDiscoveryProfile(state.idea || this.titleizeProjectId(this.projectId));
    const sprintStories = backlog.stories.filter(s => s.status === 'IN_SPRINT');

    if (sprintStories.length === 0) {
      throw new Error('No stories are currently IN_SPRINT. Run sprint-planning first.');
    }

    const implementationLog = [];
    const reviewStatus = 'REVIEW';

    for (const story of sprintStories) {
      // DEV: write source code files for this story
      const devFallback = this.buildFallbackImplementationResult('developer', story);
      const devResult = await this.runAgentTurn({
        role: 'developer',
        ceremony: 'story_implementation',
        prompt: this.buildImplementationPrompt('developer', story, profile, state),
        context: {
          story_id: story.id,
          story_title: story.title,
          workflow_state: state.status,
          project_name: profile.projectName
        },
        fallback: devFallback,
        normalize: (candidate, base) => this.normalizeImplementationTurn(candidate, base)
      });
      const writtenDevFiles = this.writeImplementationFiles(devResult.files || [], this.workspaceRoot);

      // QC: write test files for this story, given what DEV produced
      const qcFallback = this.buildFallbackImplementationResult('qc', story);
      const qcResult = await this.runAgentTurn({
        role: 'qc',
        ceremony: 'story_implementation',
        prompt: this.buildImplementationPrompt('qc', story, profile, state, writtenDevFiles),
        context: {
          story_id: story.id,
          story_title: story.title,
          workflow_state: state.status,
          project_name: profile.projectName,
          dev_files: writtenDevFiles.map(f => f.path)
        },
        fallback: qcFallback,
        normalize: (candidate, base) => this.normalizeImplementationTurn(candidate, base)
      });
      const writtenQcFiles = this.writeImplementationFiles(qcResult.files || [], this.workspaceRoot);

      // Move stories into review until validation and acceptance confirm they are complete.
      story.status = reviewStatus;
      story.implemented_at = new Date().toISOString();
      story.dev_files = writtenDevFiles.map(f => f.path);
      story.test_files = writtenQcFiles.map(f => f.path);

      implementationLog.push({
        story_id: story.id,
        story_title: story.title,
        dev_summary: devResult.summary,
        qc_summary: qcResult.summary,
        dev_files: story.dev_files,
        test_files: story.test_files,
        dev_execution: devResult.execution,
        qc_execution: qcResult.execution,
        status: reviewStatus
      });
    }

    const validationResult = this.runImplementationValidation(implementationLog);
    implementationLog.forEach(entry => {
      entry.validation = validationResult.summary;
    });

    // PM: summarise delivery and declare next action
    let remainingInSprint = backlog.stories.filter(s => s.status === 'IN_SPRINT').length;
    let reviewPending = backlog.stories.filter(s => this.isStoryInReview(s)).length;
    const pmDebrief = await this.runAgentTurn({
      role: 'pm',
      ceremony: 'story_implementation',
      prompt: this.buildImplementationDebriefPrompt('pm', implementationLog, state, remainingInSprint === 0, reviewPending === 0, validationResult),
      context: {
        sprint_id: state.current_sprint_id,
        stories_done: implementationLog.length,
        remaining_in_sprint: remainingInSprint,
        review_pending: reviewPending,
        validation_status: validationResult.ok
      },
      fallback: {
        summary: `PM: ${implementationLog.length} ${implementationLog.length === 1 ? 'story' : 'stories'} implemented in ${state.current_sprint_id}.`,
        next_action: remainingInSprint === 0
          ? (reviewPending === 0 ? 'sprint-review' : 'review')
          : 'implement'
      },
      normalize: (c, b) => ({ summary: c.summary || b.summary, next_action: c.next_action || b.next_action })
    });

    // PO: review delivered stories against acceptance criteria
    const poDebrief = await this.runAgentTurn({
      role: 'po',
      ceremony: 'story_implementation',
      prompt: this.buildImplementationDebriefPrompt('po', implementationLog, state, remainingInSprint === 0),
      context: { sprint_id: state.current_sprint_id, stories_done: implementationLog.length },
      fallback: {
        summary: `PO: ${implementationLog.length} delivered ${implementationLog.length === 1 ? 'story' : 'stories'} reviewed against acceptance criteria.`,
        accepted: implementationLog.map(e => e.story_id),
        flagged: []
      },
      normalize: (c, b) => ({
        summary: c.summary || b.summary,
        accepted: Array.isArray(c.accepted) ? c.accepted : b.accepted,
        flagged: Array.isArray(c.flagged) ? c.flagged : b.flagged
      })
    });

    const acceptedStoryIds = new Set(poDebrief.accepted || []);
    const flaggedStoryIds = new Set((poDebrief.flagged || []).map(flag => typeof flag === 'string' ? flag : flag.story_id).filter(Boolean));

    sprintStories.forEach(story => {
      const validationSummary = {
        configured: validationResult.configured,
        ok: validationResult.ok,
        summary: validationResult.summary,
        exitCode: validationResult.exitCode,
        ran_at: validationResult.ran_at
      };
      story.validation = validationSummary;

      if (validationResult.ok === true && acceptedStoryIds.has(story.id) && !flaggedStoryIds.has(story.id)) {
        story.status = 'DONE';
        story.reviewed_at = new Date().toISOString();
      } else {
        story.status = reviewStatus;
      }

      const logEntry = implementationLog.find(entry => entry.story_id === story.id);
      if (logEntry) {
        logEntry.status = story.status;
        logEntry.validation = validationSummary.summary;
      }
    });

    remainingInSprint = backlog.stories.filter(s => s.status === 'IN_SPRINT').length;
    reviewPending = backlog.stories.filter(s => this.isStoryInReview(s)).length;

    this.saveBacklog(backlog);
    this.saveCeremonyRecord('implementations', `implementation-${this.todayStamp()}.json`, {
      timestamp: new Date().toISOString(),
      ceremony: 'story_implementation',
      sprint_id: state.current_sprint_id,
      validation: validationResult,
      stories_implemented: implementationLog
    });

    const totalDevFiles = implementationLog.reduce((n, e) => n + e.dev_files.length, 0);
    const totalTestFiles = implementationLog.reduce((n, e) => n + e.test_files.length, 0);
    const flaggedCount = (poDebrief.flagged || []).length;
    const completedCount = implementationLog.filter(entry => entry.status === 'DONE').length;
    const reviewCount = implementationLog.filter(entry => entry.status === reviewStatus).length;
    const executionWarningBullets = this.buildExecutionWarningBullets({ implementationLog, pmDebrief, poDebrief }, 1);

    await this.sendDiscordNotification('ceremony_update', {
      title: `${profile.projectName}: ${sprintStories.length} ${sprintStories.length === 1 ? 'story' : 'stories'} implemented`,
      summary: `DEV wrote ${totalDevFiles} source file${totalDevFiles !== 1 ? 's' : ''} and QC wrote ${totalTestFiles} test file${totalTestFiles !== 1 ? 's' : ''} across ${sprintStories.length} sprint ${sprintStories.length === 1 ? 'story' : 'stories'}. ${completedCount} ${completedCount === 1 ? 'story is' : 'stories are'} DONE and ${reviewCount} ${reviewCount === 1 ? 'story remains' : 'stories remain'} in REVIEW.`,
      bullets: [
        ...implementationLog.map(e =>
          `${e.status === 'DONE' ? '\u2705' : '\uD83D\uDD0D'} ${e.story_id}: ${e.dev_files.length} src, ${e.test_files.length} tests \u2014 ${e.dev_summary}`
        ),
        `\uD83E\uDDEA Validation: ${validationResult.summary}`,
        ...executionWarningBullets,
        `\uD83D\uDCCB PM: ${pmDebrief.summary}`,
        flaggedCount > 0
          ? `\u26A0\uFE0F PO flagged ${flaggedCount} ${flaggedCount === 1 ? 'story' : 'stories'}: ${(poDebrief.flagged || []).map(f => typeof f === 'string' ? f : `${f.story_id} (${f.reason})`).join(', ')}`
          : `\u2714\uFE0F PO: all stories accepted \u2014 ${poDebrief.summary}`,
        `\u25B6\uFE0F Next: ${pmDebrief.next_action}`
      ]
    });

    return { stories_implemented: implementationLog, pm_debrief: pmDebrief, po_debrief: poDebrief };
  }

  buildImplementationDebriefPrompt(role, implementationLog, state, allSprintDone, allStoriesValidated, validationResult) {
    const storySummaries = implementationLog.map(e =>
      `- ${e.story_id}: ${e.story_title}\n  DEV: ${e.dev_summary}\n  QC: ${e.qc_summary}\n  Validation: ${e.validation || 'pending'}\n  Files: ${[...e.dev_files, ...e.test_files].join(', ') || 'none'}`
    ).join('\n');

    if (role === 'pm') {
      return [
        `You are the Project Manager reviewing implementation results for sprint ${state.current_sprint_id || 'current sprint'} of ${state.project_name || this.titleizeProjectId(this.projectId)}.`,
        'Return raw JSON only with keys "summary" and "next_action". Do not wrap in code fences.',
        `${implementationLog.length} ${implementationLog.length === 1 ? 'story was' : 'stories were'} just implemented.${allSprintDone ? ' No stories remain IN_SPRINT.' : ' Some stories remain IN_SPRINT.'}`,
        `Validation result: ${validationResult.summary}`,
        `Delivered:\n${storySummaries}`,
        '"next_action" must be exactly one of: "sprint-review" (if all delivered stories are validated and ready for closure), "review" (if review or validation follow-up is still needed), or "implement" (if stories remain IN_SPRINT).',
        `Correct next_action: ${allSprintDone ? (allStoriesValidated ? 'sprint-review' : 'review') : 'implement'}`
      ].join('\n');
    }

    // po
    return [
      `You are the Product Owner accepting or flagging delivered stories for sprint ${state.current_sprint_id || 'current sprint'} of ${state.project_name || this.titleizeProjectId(this.projectId)}.`,
      'Return raw JSON only with keys "summary", "accepted" (array of story IDs that meet acceptance criteria), and "flagged" (array of {"story_id", "reason"} objects). Do not wrap in code fences.',
      `Review the ${implementationLog.length} delivered ${implementationLog.length === 1 ? 'story' : 'stories'} against their acceptance criteria.`,
      `Delivered:\n${storySummaries}`
    ].join('\n');
  }

  buildImplementationPrompt(role, story, profile, state, devFiles) {
    if (role === 'developer') {
      return [
        `You are the Developer implementing story ${story.id} for ${profile.projectName}.`,
        `Story: ${story.title}`,
        `Technical notes: ${story.technical_notes || 'none'}`,
        `Acceptance criteria:\n${(story.acceptance_criteria || []).map(c => `- ${c}`).join('\n')}`,
        `Tech stack: ${(profile.technical_direction || []).join(', ')}`,
        '',
        'Write the complete production source code for this story.',
        'Return ONLY a JSON object (no markdown fences, no explanation outside JSON) with this exact shape:',
        '{ "files": [ { "path": "src/...", "content": "...full file content..." } ], "summary": "one sentence describing what was implemented" }',
        'Paths must be relative to the project root and start with src/.',
        'Write complete, working code — not stubs or placeholder TODOs.'
      ].join('\n');
    }

    // qc
    return [
      `You are the QC Engineer writing tests for story ${story.id} of ${profile.projectName}.`,
      `Story: ${story.title}`,
      `QC scenarios:\n${(story.qc_scenarios || []).map(s => `- ${s}`).join('\n')}`,
      `Acceptance criteria:\n${(story.acceptance_criteria || []).map(c => `- ${c}`).join('\n')}`,
      `Source files written by DEV: ${(devFiles || []).map(f => f.path).join(', ') || 'none yet'}`,
      `Tech stack: ${(profile.technical_direction || []).join(', ')}`,
      '',
      'Write complete test files covering all QC scenarios — unit tests and integration/e2e tests as appropriate.',
      'Return ONLY a JSON object (no markdown fences, no explanation outside JSON) with this exact shape:',
      '{ "files": [ { "path": "tests/...", "content": "...full test file content..." } ], "summary": "one sentence describing what was tested" }',
      'Paths must be relative to the project root and start with tests/.',
      'Write real, runnable tests — not placeholder comments.'
    ].join('\n');
  }

  buildFallbackImplementationResult(role, story) {
    if (role === 'developer') {
      return {
        files: [{
          path: `src/stories/${story.id}/index.js`,
          content: `// ${story.title}\n// TODO: implement story ${story.id}\n// Technical notes: ${story.technical_notes || 'none'}\n`
        }],
        summary: `Scaffold created for ${story.id} — implement manually.`
      };
    }

    return {
      files: [{
        path: `tests/stories/${story.id}/index.test.js`,
        content: `// Tests for: ${story.title}\n// TODO: implement QC scenarios for ${story.id}\n${(story.qc_scenarios || []).map(s => `// Scenario: ${s}`).join('\n')}\n`
      }],
      summary: `Test scaffold created for ${story.id} — implement scenarios manually.`
    };
  }

  normalizeImplementationTurn(candidate, fallback) {
    const files = Array.isArray(candidate.files)
      ? candidate.files.filter(f => f && typeof f.path === 'string' && typeof f.content === 'string')
      : [];

    return {
      files: files.length > 0 ? files : fallback.files,
      summary: candidate.summary || fallback.summary
    };
  }

  writeImplementationFiles(files, baseDir) {
    const resolvedBase = path.resolve(baseDir);
    const written = [];

    for (const file of files) {
      const resolved = path.resolve(baseDir, file.path);
      // Guard against path traversal (e.g. ../../etc/passwd)
      if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
        console.error(`[security] Blocked path traversal attempt: ${file.path}`);
        continue;
      }
      this.ensureDir(path.dirname(resolved));
      fs.writeFileSync(resolved, file.content, 'utf-8');
      written.push({ path: file.path, absPath: resolved });
    }

    return written;
  }

  runImplementationValidation(implementationLog) {
    const validationConfig = this.getConfigValue(this.runtimeConfig, ['validation']) || {};
    const command = typeof validationConfig.command === 'string' ? validationConfig.command.trim() : '';
    const args = Array.isArray(validationConfig.args) ? validationConfig.args : [];
    const enabled = validationConfig.enabled === true;
    const ranAt = new Date().toISOString();

    if (!enabled || !command) {
      return {
        configured: false,
        ok: null,
        skipped: true,
        ran_at: ranAt,
        summary: 'No validation command configured; stories remain in REVIEW until validation is supplied or manually confirmed.',
        story_ids: implementationLog.map(entry => entry.story_id)
      };
    }

    const cwdSetting = typeof validationConfig.cwd === 'string' && validationConfig.cwd.trim()
      ? validationConfig.cwd.trim()
      : '.';
    const validationCwd = path.resolve(this.projectDir || this.workspaceRoot, cwdSetting);
    const result = spawnSync(command, args, {
      cwd: validationCwd,
      encoding: 'utf-8',
      timeout: validationConfig.timeout_ms || 120000,
      windowsHide: true
    });
    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    const outputPreview = combinedOutput ? combinedOutput.split(/\r?\n/).slice(-10).join('\n') : '';

    if (result.error) {
      return {
        configured: true,
        ok: false,
        ran_at: ranAt,
        command,
        args,
        cwd: validationCwd,
        exitCode: null,
        summary: `Validation failed to start: ${result.error.message}`,
        output: outputPreview,
        story_ids: implementationLog.map(entry => entry.story_id)
      };
    }

    if (result.status !== 0) {
      return {
        configured: true,
        ok: false,
        ran_at: ranAt,
        command,
        args,
        cwd: validationCwd,
        exitCode: result.status,
        summary: `Validation command failed with exit code ${result.status}; stories remain in REVIEW.`,
        output: outputPreview,
        story_ids: implementationLog.map(entry => entry.story_id)
      };
    }

    return {
      configured: true,
      ok: true,
      ran_at: ranAt,
      command,
      args,
      cwd: validationCwd,
      exitCode: result.status,
      summary: 'Validation passed; stories can move from REVIEW to DONE when acceptance succeeds.',
      output: outputPreview,
      story_ids: implementationLog.map(entry => entry.story_id)
    };
  }

  async sprintReviewCeremony(sprintId) {
    this.assertProjectSelected();
    this.assertWorkflowStateAllowed('sprint-review', [WORKFLOW_STATES.IN_SPRINT, WORKFLOW_STATES.RELEASE_CANDIDATE]);
    const state = this.loadState();
    const backlog = this.loadBacklog();
    const reviewSprintId = sprintId || state.current_sprint_id || 'sprint-1';
    const review = {
      timestamp: new Date().toISOString(),
      ceremony: 'sprint_review',
      sprint_id: reviewSprintId,
      completed_stories: await this.getCompletedStories(reviewSprintId),
      metrics: {
        velocity: await this.calculateVelocity(reviewSprintId),
        qc_readiness: await this.getQcReadiness(reviewSprintId),
        bug_count: await this.getBugCount(reviewSprintId),
        open_blockers: await this.getOpenBlockers(reviewSprintId)
      },
      stakeholder_feedback: await this.gatherStakeholderFeedback(),
      go_nogo_decision: 'NO_GO_HOLD'
    };

    const readyToDeploy = await this.deploymentReadinessCheck(review);
    review.go_nogo_decision = readyToDeploy ? 'GO_DEPLOY' : 'NO_GO_HOLD';
    if (readyToDeploy) {
      state.status = WORKFLOW_STATES.RELEASE_CANDIDATE;
      await this.scheduleDeployment(reviewSprintId);
    }

    this.syncBacklogState(backlog, state);
    this.saveBacklog(backlog);
    this.saveSprintReview(review);
    this.saveState(state);

    await this.sendDiscordNotification('ceremony_update', {
      title: `${state.project_name || this.titleizeProjectId(this.projectId)}: sprint review — ${review.go_nogo_decision}`,
      summary: `**${reviewSprintId}** closed: ${review.completed_stories.length} stories done. Decision: **${review.go_nogo_decision}**.`,
      bullets: [
        `✅ Completed: ${review.completed_stories.length} stories (${review.metrics.velocity.completed}/${review.metrics.velocity.planned} pts)`,
        `🧪 QC readiness: ${review.metrics.qc_readiness.percentage}%`,
        `🐛 Bugs: ${review.metrics.bug_count}`,
        `🚧 Open blockers: ${review.metrics.open_blockers.length}`,
        review.go_nogo_decision === 'GO_DEPLOY' ? `🚀 Deployment scheduled` : `🔁 Next sprint planning required`
      ]
    });

    return review;
  }

  async retrospectiveCeremony(sprintId) {
    this.assertProjectSelected();
    this.assertWorkflowStateAllowed('retrospective', [WORKFLOW_STATES.IN_SPRINT, WORKFLOW_STATES.RELEASE_CANDIDATE]);
    const state = this.loadState();
    const activeSprintId = sprintId || state.current_sprint_id || 'sprint-1';
    const retro = {
      timestamp: new Date().toISOString(),
      ceremony: 'retrospective',
      sprint_id: activeSprintId,
      went_well: [
        { role: 'po', feedback: 'Domain assumptions were documented early enough for DEV and QC to work from the same source.' },
        { role: 'developer', feedback: 'Architecture risks were surfaced before implementation commitments.' },
        { role: 'qc', feedback: 'QC scenarios existed before code review, which reduced late surprises.' }
      ],
      went_poorly: [
        { role: 'pm', feedback: 'Approval wait time can delay sprint start if open questions are not summarized clearly.' },
        { role: 'developer', feedback: 'Some technical unknowns still depend on product decisions.' }
      ],
      action_items: [
        'PM: tighten the approval summary to one page plus links.',
        'PO: resolve trust-and-safety policy questions before the next sprint starts.',
        'QC: publish scenario priorities beside the sprint plan.'
      ],
      metrics: {
        planned_vs_completed: await this.getPlannedVsCompleted(activeSprintId),
        bug_escape_rate: await this.calculateBugEscapeRate(activeSprintId),
        qc_readiness: await this.getQcReadiness(activeSprintId),
        blockers_by_type: await this.getBlockerStats(activeSprintId)
      }
    };

    this.saveRetrospective(retro);

    await this.sendDiscordNotification('ceremony_update', {
      title: `${state.project_name || this.titleizeProjectId(this.projectId)}: retrospective — ${activeSprintId}`,
      summary: `**${activeSprintId}** retro closed — ${retro.action_items.length} action item${retro.action_items.length !== 1 ? 's' : ''} captured.`,
      bullets: [
        `👍 Went well: ${retro.went_well.slice(0, 2).map(w => `[${w.role.toUpperCase()}] ${w.feedback}`).join(' · ')}`,
        `👎 To improve: ${retro.went_poorly.slice(0, 2).map(w => `[${w.role.toUpperCase()}] ${w.feedback}`).join(' · ')}`,
        `🎯 Action items: ${retro.action_items.join(' · ')}`
      ]
    });

    return retro;
  }

  async dailyActivityDigest() {
    this.assertProjectSelected();
    this.assertWorkflowStateAllowed('daily-digest', [
      WORKFLOW_STATES.DISCOVERY_IN_PROGRESS,
      WORKFLOW_STATES.AWAITING_USER_INPUT,
      WORKFLOW_STATES.READY_FOR_APPROVAL,
      WORKFLOW_STATES.APPROVED_FOR_IMPLEMENTATION,
      WORKFLOW_STATES.IN_SPRINT,
      WORKFLOW_STATES.RELEASE_CANDIDATE
    ]);
    const state = this.loadState();
    const blockers = this.loadBlockerLog().filter(blocker => blocker.status !== 'RESOLVED');
    const backlog = this.loadBacklog();
    const pmDigest = await this.buildDailyDigestNote(state, backlog, blockers);
    const digest = {
      timestamp: new Date().toISOString(),
      ceremony: 'daily_activity_digest',
      project_id: this.projectId,
      state: state.status,
      blockers,
      agent_turn: pmDigest,
      next_actions: this.buildNextActions(state, backlog),
      summary: this.buildDigestSummary(state, backlog, blockers)
    };

    this.saveCeremonyRecord('digests', `daily-digest-${this.todayStamp()}.json`, digest);
    state.updated_at = digest.timestamp;
    this.saveState(state);
    await this.sendDailyActivityReport('daily_digest', state, blockers, pmDigest);
    return digest;
  }

  async submitFeedback(message, type) {
    this.assertProjectSelected();

    const normalizedType = String(type || 'business').toLowerCase();
    if (normalizedType !== 'technical' && normalizedType !== 'business') {
      throw new Error('Feedback type must be "technical" or "business".');
    }

    const normalizedMessage = String(message || '').trim();
    if (!normalizedMessage) {
      throw new Error('Feedback requires a non-empty --message.');
    }

    const state = this.loadState();
    const profile = this.buildDiscoveryProfile(state.idea || this.titleizeProjectId(this.projectId));
    const backlog = this.loadBacklog();
    const timestamp = new Date().toISOString();

    // Record the feedback in the persistent log
    const entry = {
      id: `FB-${Date.now()}`,
      timestamp,
      type: normalizedType,
      message: normalizedMessage,
      workflow_state_at_time: state.status
    };
    this.appendFeedbackLog(entry);

    // Route to the relevant agents based on type
    const agentResponses = {};
    const rolesToQuery = normalizedType === 'technical'
      ? ['developer', 'qc']
      : ['po', 'pm'];

    for (const role of rolesToQuery) {
      const fallback = this.buildFeedbackFallback(role, normalizedType, normalizedMessage, profile, state);
      agentResponses[role] = await this.runAgentTurn({
        role,
        ceremony: 'feedback',
        prompt: this.buildFeedbackPrompt(role, normalizedType, normalizedMessage, profile, state, backlog),
        context: {
          feedback_type: normalizedType,
          feedback_message: normalizedMessage,
          workflow_state: state.status,
          project_name: profile.projectName
        },
        fallback,
        normalize: (candidate, base) => this.normalizeFeedbackResponse(candidate, base)
      });
    }

    // Apply the agent responses back into the artifacts
    if (normalizedType === 'business') {
      this.consumeAnsweredOpenQuestion(state, normalizedMessage);
      this.applyBusinessFeedback(agentResponses, profile, state, backlog, normalizedMessage);
    } else {
      this.applyTechnicalFeedback(agentResponses, profile, state, backlog, normalizedMessage);
    }

    // Business feedback that changes scope resets approval so it must be re-reviewed
    const scopeChanged = normalizedType === 'business';
    if (scopeChanged) {
      this.syncDiscoveryApprovalState(state, { requestApproval: true });
      this.writeMarkdown(path.join(this.docsDir, 'open-questions.md'), this.renderOpenQuestions(profile, state));
      this.writeMarkdown(path.join(this.docsDir, 'delivery-plan.md'), this.renderDeliveryPlan(profile, backlog, state));
      this.writeMarkdown(
        path.join(this.docsDir, 'approval-request.md'),
        this.renderApprovalRequest(profile, state, backlog)
      );
    }

    state.updated_at = timestamp;
    this.saveState(state);
    this.saveBacklog(backlog);

    const result = {
      feedback_id: entry.id,
      type: normalizedType,
      message: normalizedMessage,
      workflow_state: state.status,
      approval_status: state.approval.status,
      scope_reset: scopeChanged && state.approval.status === 'PENDING',
      agent_responses: agentResponses
    };

    const executionWarningBullets = this.buildExecutionWarningBullets(agentResponses, 1);

    await this.sendDiscordNotification('ceremony_update', {
      title: `${profile.projectName}: ${normalizedType} feedback received`,
      summary: normalizedType === 'business'
        ? 'Business feedback was applied. Discovery artifacts updated; approval requires re-review.'
        : 'Technical feedback was applied. Technical design and QC strategy updated.',
      bullets: [
        `Type: ${normalizedType}`,
        `Message: ${normalizedMessage.slice(0, 120)}${normalizedMessage.length > 120 ? '...' : ''}`,
        `Approval status: ${state.approval.status}`,
        ...executionWarningBullets,
        `Next: ${this.buildNextActions(state, backlog)[0]}`
      ]
    });

    return result;
  }

  applyBusinessFeedback(agentResponses, profile, state, backlog, feedbackMessage) {
    const poResponse = agentResponses.po || {};
    const pmResponse = agentResponses.pm || {};

    // Append feedback impact to open questions resolved/added
    const impactBullets = [
      ...(poResponse.scope_changes || []),
      ...(poResponse.removed_items || []),
      ...(poResponse.added_items || [])
    ].filter(Boolean);

    // Write updated product requirements with feedback section appended
    this.writeMarkdown(
      path.join(this.docsDir, 'product-requirements.md'),
      this.renderProductRequirements(profile, backlog, null) +
      this.renderFeedbackSection('Business Feedback Applied', feedbackMessage, poResponse, pmResponse)
    );

    // Write updated delivery plan
    // Update open questions if the agents surfaced new ones
    const newQuestions = [
      ...(poResponse.open_questions || []),
      ...(pmResponse.open_questions || [])
    ].filter(q => typeof q === 'string' && q.trim());

    if (newQuestions.length > 0) {
      const existing = new Set(this.normalizeQuestionList(state.open_questions));
      newQuestions.forEach(q => existing.add(q.trim()));
      state.open_questions = Array.from(existing);
    }

    // Append an entry to the feedback log doc
    this.writeFeedbackLogDoc();
  }

  applyTechnicalFeedback(agentResponses, profile, state, backlog, feedbackMessage) {
    const devResponse = agentResponses.developer || {};
    const qcResponse = agentResponses.qc || {};

    // Write updated technical design with feedback section appended
    this.writeMarkdown(
      path.join(this.docsDir, 'technical-design.md'),
      this.renderTechnicalDesign(profile, backlog, null) +
      this.renderFeedbackSection('Technical Feedback Applied', feedbackMessage, devResponse, qcResponse)
    );

    // Write updated QC strategy with feedback impact
    this.writeMarkdown(
      path.join(this.docsDir, 'qc-strategy.md'),
      this.renderQcStrategy(profile, backlog, null) +
      this.renderFeedbackSection('QC Impact of Technical Feedback', feedbackMessage, qcResponse, null)
    );

    this.writeFeedbackLogDoc();
  }

  renderFeedbackSection(title, message, primaryResponse, secondaryResponse) {
    const lines = [`\n## ${title}\n`, `**Feedback:** ${message}\n`];

    if (primaryResponse && primaryResponse.summary) {
      lines.push(`\n**Assessment:** ${primaryResponse.summary}\n`);
    }

    const bullets = [
      ...(primaryResponse && Array.isArray(primaryResponse.bullets) ? primaryResponse.bullets : []),
      ...(primaryResponse && Array.isArray(primaryResponse.action_items) ? primaryResponse.action_items : []),
      ...(secondaryResponse && Array.isArray(secondaryResponse.bullets) ? secondaryResponse.bullets : [])
    ].filter(Boolean);

    if (bullets.length > 0) {
      lines.push(bullets.map(b => `- ${b}`).join('\n') + '\n');
    }

    return lines.join('\n');
  }

  appendFeedbackLog(entry) {
    const log = this.loadFeedbackLog();
    log.push(entry);
    this.writeJson(path.join(this.docsDir, 'feedback-log.json'), log);
  }

  loadFeedbackLog() {
    const file = path.join(this.docsDir, 'feedback-log.json');
    if (!fs.existsSync(file)) {
      return [];
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }

  writeFeedbackLogDoc() {
    const log = this.loadFeedbackLog();
    if (log.length === 0) {
      return;
    }

    const lines = ['# Feedback Log\n'];
    log.forEach((entry, index) => {
      lines.push(`## ${index + 1}. [${entry.type.toUpperCase()}] ${entry.timestamp.split('T')[0]}\n`);
      lines.push(`**ID:** ${entry.id}  `);
      lines.push(`**State at time:** ${entry.workflow_state_at_time}\n`);
      lines.push(`> ${entry.message}\n`);
    });

    this.writeMarkdown(path.join(this.docsDir, 'feedback-log.md'), lines.join('\n'));
  }

  buildFeedbackPrompt(role, type, message, profile, state, backlog) {
    const roleInstructions = {
      po: [
        `You are the Product Owner for ${profile.projectName}.`,
        'Business feedback has been submitted. Assess its impact on scope and requirements.',
        'Return raw JSON only with keys: "summary", "bullets", "scope_changes", "added_items", "removed_items", "open_questions".',
        '"scope_changes" is an array of strings describing what changed in scope.',
        '"added_items" is an array of new features or requirements introduced.',
        '"removed_items" is an array of features or requirements to drop.',
        '"open_questions" is an array of NEW questions this feedback raises (empty array if none).',
        'Do not wrap the response in code fences.'
      ],
      pm: [
        `You are the Project Manager for ${profile.projectName}.`,
        'Business feedback has been submitted. Assess the delivery and sprint impact.',
        'Return raw JSON only with keys: "summary", "bullets", "action_items", "open_questions".',
        '"action_items" is an array of concrete PM actions required as a result of this feedback.',
        '"open_questions" is an array of NEW questions this feedback raises (empty array if none).',
        'Do not wrap the response in code fences.'
      ],
      developer: [
        `You are the Developer for ${profile.projectName}.`,
        'Technical feedback has been submitted. Assess its impact on architecture, patterns, and tech stack.',
        'Return raw JSON only with keys: "summary", "bullets", "action_items", "risks".',
        '"action_items" is an array of concrete technical tasks or changes required.',
        '"risks" is an array of risks introduced or resolved by this feedback.',
        'Do not wrap the response in code fences.'
      ],
      qc: [
        `You are the QC Engineer for ${profile.projectName}.`,
        'Technical feedback has been submitted. Assess its impact on test scenarios and release risk.',
        'Return raw JSON only with keys: "summary", "bullets", "new_scenarios", "invalidated_scenarios".',
        '"new_scenarios" is an array of new QC scenarios this feedback introduces.',
        '"invalidated_scenarios" is an array of existing scenarios that may no longer apply.',
        'Do not wrap the response in code fences.'
      ]
    };

    const base = roleInstructions[role] || roleInstructions.pm;
    return [
      ...base,
      `Feedback type: ${type}`,
      `Feedback message: ${message}`,
      `Project: ${profile.projectName}`,
      `Workflow state: ${state.status}`,
      `Current open questions: ${(state.open_questions || []).slice(0, 3).map(q => typeof q === 'string' ? q : (q.question || JSON.stringify(q))).join(' | ') || 'None'}`,
      `Relevant stories: ${(backlog.stories || []).filter(s => role === 'developer' || role === 'qc' ? (s.status === 'IN_SPRINT' || this.isStoryInReview(s)) : true).slice(0, 6).map(s => s.id + ': ' + s.title).join(' | ') || 'None'}`,
      this.selectBoundedContext(role, 'feedback', state, backlog)
    ].filter(Boolean).join('\n');
  }

  buildFeedbackFallback(role, type, message, profile, state) {
    const shortMessage = message.length > 80 ? message.slice(0, 80) + '...' : message;
    const fallbacks = {
      po: {
        summary: `PO reviewed the business feedback for ${profile.projectName} and assessed scope impact.`,
        bullets: [`Feedback received: ${shortMessage}`, 'PO will update product requirements to reflect the change.'],
        scope_changes: [`Scope updated based on: ${shortMessage}`],
        added_items: [],
        removed_items: [],
        open_questions: []
      },
      pm: {
        summary: `PM logged the business feedback and flagged delivery impact for ${profile.projectName}.`,
        bullets: [`Feedback received: ${shortMessage}`, 'Approval gate reset — review updated artifacts before approving.'],
        action_items: ['Re-review discovery artifacts with updated scope.', 'Re-approve implementation when ready.'],
        open_questions: []
      },
      developer: {
        summary: `DEV assessed the technical feedback for ${profile.projectName}.`,
        bullets: [`Technical direction updated based on: ${shortMessage}`, 'Review technical-design.md for the updated approach.'],
        action_items: [`Apply technical direction: ${shortMessage}`],
        risks: []
      },
      qc: {
        summary: `QC assessed the technical feedback impact on test coverage for ${profile.projectName}.`,
        bullets: [`QC scenarios may need revision based on: ${shortMessage}`],
        new_scenarios: [],
        invalidated_scenarios: []
      }
    };
    return fallbacks[role] || fallbacks.pm;
  }

  normalizeFeedbackResponse(candidate, fallback) {
    const normalized = this.coerceAgentCandidate(candidate);
    if (!normalized || typeof normalized !== 'object') {
      return { ...fallback };
    }

    // Merge all known keys from fallback structure, keeping agent values where valid
    const result = { ...fallback };
    Object.keys(fallback).forEach(key => {
      if (key === 'summary') {
        result.summary = this.coerceText(normalized.summary, fallback.summary);
      } else if (key === 'bullets' || key === 'action_items' || key === 'risks' ||
        key === 'scope_changes' || key === 'added_items' || key === 'removed_items' ||
        key === 'open_questions' || key === 'new_scenarios' || key === 'invalidated_scenarios') {
        result[key] = this.coerceStringArray(normalized[key], fallback[key]);
      }
    });
    return result;
  }

  getStatus() {
    this.assertProjectSelected();
    return this.loadState();
  }

  buildDiscoveryProfile(idea) {
    const normalizedIdea = (idea || '').trim();
    const projectName = this.deriveProjectName(normalizedIdea || this.titleizeProjectId(this.projectId));
    const matchedTemplate = resolveDiscoveryProfileTemplate(normalizedIdea);
    if (matchedTemplate) {
      return buildDiscoveryProfileFromTemplate(matchedTemplate, normalizedIdea, projectName);
    }

    return {
      projectName,
      problem_statement: `Users need ${normalizedIdea || 'this product'} to solve a clear workflow problem with enough quality and documentation for iterative Scrum delivery.`,
      business_goals: [...DEFAULT_DISCOVERY_PROFILE.business_goals],
      core_capabilities: [...DEFAULT_DISCOVERY_PROFILE.core_capabilities],
      personas: [...DEFAULT_DISCOVERY_PROFILE.personas],
      assumptions: [...DEFAULT_DISCOVERY_PROFILE.assumptions],
      openQuestions: [...DEFAULT_DISCOVERY_PROFILE.openQuestions],
      technical_direction: [...DEFAULT_DISCOVERY_PROFILE.technical_direction],
      qc_focus: [...DEFAULT_DISCOVERY_PROFILE.qc_focus]
    };
  }

  buildBacklog(profile, state) {
    const ideas = profile.core_capabilities;
    const qualityScenarios = profile.qc_focus;
    const stories = ideas.map((capability, index) => ({
      id: `STORY-${index + 1}`,
      epic_id: `EPIC-${Math.min(index + 1, 3)}`,
      title: `As a target user, I want ${capability.toLowerCase()}, so that the core value of ${profile.projectName} is visible early.`,
      description: `PO scoped ${capability.toLowerCase()} as a release-critical capability for ${profile.projectName}.`,
      acceptance_criteria: [
        `PO can explain the business value and boundaries of ${capability.toLowerCase()}.`,
        `DEV has a clear implementation slice for ${capability.toLowerCase()}.`,
        `QC has at least one priority scenario for ${capability.toLowerCase()}.`
      ],
      definition_of_done: [
        'Code reviewed and merged',
        'QC scenarios executed or automated',
        'Docs updated in the active project docs folder',
        'PM confirms no unresolved sprint blocker remains'
      ],
      po_notes: `PO priority: ${index < 2 ? 'MUST_HAVE' : 'SHOULD_HAVE'}`,
      technical_notes: profile.technical_direction[index % profile.technical_direction.length],
      qc_scenarios: [qualityScenarios[index % qualityScenarios.length]],
      status: 'READY_FOR_PLANNING',
      approval_status: state.approval.status,
      story_points: [3, 5, 8, 5][index % 4]
    }));

    return {
      project_id: this.projectId,
      created_at: new Date().toISOString(),
      workflow_status: state.status,
      approval_status: state.approval.status,
      epics: [
        {
          id: 'EPIC-1',
          title: 'Core Product Experience',
          owner: 'po',
          priority: 'MUST_HAVE'
        },
        {
          id: 'EPIC-2',
          title: 'Technical Delivery Foundation',
          owner: 'developer',
          priority: 'MUST_HAVE'
        },
        {
          id: 'EPIC-3',
          title: 'Quality Control and Release Safety',
          owner: 'qc',
          priority: 'MUST_HAVE'
        }
      ],
      stories,
      open_questions: state.open_questions,
      sprint_constraints: {
        sprint_duration_days: 10,
        team_capacity_story_points: 20,
        approval_gate_required: true,
        active_roles: ['pm', 'po', 'developer', 'qc']
      }
    };
  }

  syncBacklogState(backlog, state) {
    const approvalStatus = state.approval && state.approval.status ? state.approval.status : 'PENDING';

    backlog.workflow_status = state.status;
    backlog.approval_status = approvalStatus;
    backlog.updated_at = new Date().toISOString();
    backlog.stories = (backlog.stories || []).map(story => ({
      ...story,
      approval_status: approvalStatus
    }));

    return backlog;
  }

  async buildStandupReport(role, state, profile, backlog) {
    const fallback = this.buildFallbackStandupReport(role, state, profile, backlog);
    return this.runAgentTurn({
      role,
      ceremony: 'daily_standup',
      prompt: this.buildStandupPrompt(role, state, profile, backlog),
      context: {
        workflow_state: state.status,
        project_name: profile.projectName,
        open_questions: state.open_questions,
        approval_status: state.approval.status
      },
      fallback,
      normalize: (candidate, base) => this.normalizeStandupTurn(candidate, base)
    });
  }

  buildFallbackStandupReport(role, state, profile, backlog) {
    const doneCount = backlog ? backlog.stories.filter(story => this.isStoryDone(story)).length : 0;
    const inSprintCount = backlog ? backlog.stories.filter(story => story.status === 'IN_SPRINT').length : 0;
    const reviewCount = backlog ? backlog.stories.filter(story => this.isStoryInReview(story)).length : 0;
    const allSprintDone = state.status === WORKFLOW_STATES.IN_SPRINT && inSprintCount === 0 && reviewCount === 0 && doneCount > 0;

    const reports = {
      pm: {
        summary: `PM is keeping ${profile.projectName} aligned to the current workflow state and blocker posture.`,
        yesterday: 'Consolidated the current workflow state, artifacts, and blocker view.',
        today: allSprintDone
          ? `All ${doneCount} sprint stories are DONE. Run sprint-review to close the sprint.`
          : state.status === WORKFLOW_STATES.IN_SPRINT
            ? reviewCount > 0
              ? `Keep the sprint moving — ${doneCount} done, ${reviewCount} in review, ${inSprintCount} still in implementation.`
              : `Keep the sprint moving — ${doneCount} done, ${inSprintCount} remaining.`
            : 'Drive the discovery package to a clean approval decision and keep assumptions visible.',
        blockers: []
      },
      po: {
        summary: `PO is protecting the product scope and clarifying open product questions for ${profile.projectName}.`,
        yesterday: `Refined the business framing for ${profile.projectName}.`,
        today: allSprintDone
          ? `All ${doneCount} stories delivered. Review acceptance before sprint-review.`
          : state.status === WORKFLOW_STATES.IN_SPRINT
            ? reviewCount > 0
              ? `${doneCount} stories done, ${reviewCount} in review, ${inSprintCount} still in progress. Answer DEV/QC questions without reopening scope.`
              : `${doneCount} stories done, ${inSprintCount} in progress. Answer DEV/QC questions without reopening scope.`
            : 'Reduce ambiguity in the product requirements and close top open questions.',
        blockers: state.open_questions.length > 0
          ? [`Need user confirmation on: ${state.open_questions[0]}`]
          : []
      },
      developer: {
        summary: `DEV is translating the approved scope for ${profile.projectName} into executable delivery slices.`,
        yesterday: doneCount > 0
          ? `Implemented ${doneCount} ${doneCount === 1 ? 'story' : 'stories'}.`
          : 'Mapped the first implementation slices and technical risks.',
        today: allSprintDone
          ? 'All assigned stories are DONE. Await sprint-review.'
          : state.status === WORKFLOW_STATES.IN_SPRINT
            ? reviewCount > 0
              ? `Address validation and review follow-ups for ${reviewCount} ${reviewCount === 1 ? 'story' : 'stories'} and implement the remaining ${inSprintCount} active sprint ${inSprintCount === 1 ? 'story' : 'stories'}.`
              : `Implement remaining ${inSprintCount} sprint ${inSprintCount === 1 ? 'story' : 'stories'} and surface feasibility risks early.`
            : 'Wait on product approval before turning architecture into implementation work.',
        blockers: state.status === WORKFLOW_STATES.APPROVED_FOR_IMPLEMENTATION || state.status === WORKFLOW_STATES.IN_SPRINT
          ? []
          : ['Implementation cannot start until approval is granted.']
      },
      qc: {
        summary: `QC is keeping the highest-risk scenarios visible for ${profile.projectName}.`,
        yesterday: doneCount > 0
          ? `Wrote tests covering ${doneCount} completed ${doneCount === 1 ? 'story' : 'stories'}.`
          : 'Prepared QC scenarios, release risks, and acceptance checks.',
        today: allSprintDone
          ? 'All stories have test coverage. Confirm no open release risks before sprint-review.'
          : state.status === WORKFLOW_STATES.IN_SPRINT
            ? reviewCount > 0
              ? `Validate ${reviewCount} ${reviewCount === 1 ? 'story' : 'stories'} in review and keep an eye on the ${inSprintCount} still in implementation.`
              : `Validate active work — ${inSprintCount} ${inSprintCount === 1 ? 'story' : 'stories'} still in progress.`
            : 'Refine QC coverage around the highest-risk product assumptions.',
        blockers: []
      }
    };

    return reports[role];
  }

  buildSprintScope(stories) {
    return stories.map(story => ({
      story_id: story.id,
      title: story.title,
      po_focus: story.po_notes
    }));
  }

  buildDeveloperPlan(stories) {
    return stories.map(story => ({
      story_id: story.id,
      implementation_slice: story.technical_notes,
      estimate_points: story.story_points
    }));
  }

  buildQcPlan(stories) {
    return stories.map(story => ({
      story_id: story.id,
      scenarios: story.qc_scenarios,
      gate: 'QC must verify the story before PM marks it ready for review.'
    }));
  }

  buildPmPlan(state, plannedPoints) {
    return {
      approval_mode: state.approval.status,
      planned_story_points: plannedPoints,
      blocker_policy: 'Escalate blockers immediately and post them to Discord if they threaten the sprint goal.',
      reporting: 'Publish a daily Discord digest and sprint-level ceremony summary.'
    };
  }

  buildNextActions(state, backlog) {
    if (state.status === WORKFLOW_STATES.AWAITING_USER_INPUT) {
      return [
        state.open_questions.length > 0
          ? `Answer the ${state.open_questions.length} blocking open question${state.open_questions.length === 1 ? '' : 's'} and submit the answers as business feedback.`
          : 'Record the missing business clarification before requesting approval again.',
        'Run discovery-sync or request-approval again after the missing answers are recorded.'
      ];
    }

    if (state.status === WORKFLOW_STATES.READY_FOR_APPROVAL) {
      return [
        'Review the discovery package and approve implementation.',
        'Answer the remaining open questions if any assumptions are not acceptable.'
      ];
    }

    if (state.status === WORKFLOW_STATES.APPROVED_FOR_IMPLEMENTATION) {
      return ['Run sprint-planning to move the approved backlog into active delivery.'];
    }

    if (state.status === WORKFLOW_STATES.IN_SPRINT) {
      const remainingInSprint = backlog.stories.filter(s => s.status === 'IN_SPRINT').length;
      const reviewPending = backlog.stories.filter(story => this.isStoryInReview(story)).length;
      const hasDone = backlog.stories.some(story => this.isStoryDone(story));
      if (remainingInSprint === 0 && reviewPending === 0 && hasDone) {
        return [
          'All sprint stories are implemented. Run sprint-review to close the sprint.',
          'Run retrospective after sprint-review to capture learnings before the next sprint.'
        ];
      }

      if (reviewPending > 0) {
        return [
          `Resolve validation or review follow-up for the ${reviewPending} ${reviewPending === 1 ? 'story' : 'stories'} currently in REVIEW.`,
          remainingInSprint > 0
            ? `Then run implement again for the ${remainingInSprint} remaining IN_SPRINT ${remainingInSprint === 1 ? 'story' : 'stories'}.`
            : 'After review follow-up is cleared, run sprint-review to close the sprint.'
        ];
      }

      return [
        remainingInSprint > 0
          ? `Run implement to have DEV write code and QC write tests for the ${remainingInSprint} remaining IN_SPRINT ${remainingInSprint === 1 ? 'story' : 'stories'}.`
          : 'Run sprint-planning to commit stories to the next sprint.',
        'Use daily standup and QC sync to track progress and surface blockers.'
      ];
    }

    return [
      `Refresh discovery artifacts for ${state.project_name || this.titleizeProjectId(this.projectId)}.`,
      `Prepare ${backlog.stories.length} stories for approval.`
    ];
  }

  buildDigestSummary(state, backlog, blockers) {
    return {
      state: state.status,
      project_name: state.project_name || this.titleizeProjectId(this.projectId),
      backlog_stories: backlog.stories.length,
      blockers: blockers.length,
      pending_approval: state.approval.status !== 'APPROVED'
    };
  }

  async collectDiscoveryNotes(profile, state) {
    const notes = {};
    const roles = ['po', 'developer', 'qc', 'pm'];

    for (const role of roles) {
      const fallback = this.buildFallbackDiscoveryNote(role, profile, state);
      notes[role] = await this.runAgentTurn({
        role,
        ceremony: 'discovery_sync',
        prompt: this.buildDiscoveryPrompt(role, profile, state),
        context: {
          idea: state.idea || profile.projectName,
          workflow_state: state.status,
          project_name: profile.projectName,
          business_goals: profile.business_goals,
          core_capabilities: profile.core_capabilities,
          open_questions: state.open_questions
        },
        fallback,
        normalize: (candidate, base) => this.normalizeSummaryNote(candidate, base)
      });
    }

    return notes;
  }

  buildFallbackDiscoveryNote(role, profile, state) {
    const notes = {
      po: {
        summary: `PO framed ${profile.projectName} around the core user problem, scope boundaries, and business outcomes.`,
        bullets: [
          `Primary business goal: ${profile.business_goals[0]}`,
          `Most important MVP capability: ${profile.core_capabilities[0]}`,
          `Top unresolved product question: ${state.open_questions[0] || 'None currently flagged'}`
        ]
      },
      developer: {
        summary: `DEV translated ${profile.projectName} into implementation-friendly slices and highlighted the highest-risk technical path.`,
        bullets: [
          `Primary technical direction: ${profile.technical_direction[0]}`,
          `Second technical concern: ${profile.technical_direction[1] || profile.technical_direction[0]}`,
          'Delivery needs to stay vertical and testable from the first sprint.'
        ]
      },
      qc: {
        summary: `QC mapped the release-critical scenarios and quality gates for ${profile.projectName}.`,
        bullets: [
          `Highest-risk scenario: ${profile.qc_focus[0]}`,
          `Secondary risk area: ${profile.qc_focus[1] || profile.qc_focus[0]}`,
          'QC evidence should exist before PM advances the workflow.'
        ]
      },
      pm: {
        summary: `PM consolidated discovery and prepared ${profile.projectName} for an approval decision.`,
        bullets: [
          `Current workflow state: ${state.status}`,
          `Approval remains ${state.approval.status}.`,
          `Next recommended action: ${this.buildNextActions(state, { stories: profile.core_capabilities.map(() => null) })[0]}`
        ]
      }
    };

    return notes[role];
  }

  async collectPlanningNotes(profile, state, sprintStories, plannedPoints, sprintId, teamCapacityPoints) {
    const notes = {};
    const roles = ['po', 'developer', 'qc', 'pm'];

    for (const role of roles) {
      const fallback = this.buildFallbackPlanningNote(
        role,
        profile,
        sprintStories,
        plannedPoints,
        sprintId,
        teamCapacityPoints
      );
      notes[role] = await this.runAgentTurn({
        role,
        ceremony: 'sprint_planning',
        prompt: this.buildPlanningPrompt(role, profile, state, sprintStories, plannedPoints, sprintId, teamCapacityPoints),
        context: {
          workflow_state: state.status,
          sprint_id: sprintId,
          planned_story_points: plannedPoints,
          team_capacity_story_points: teamCapacityPoints,
          story_ids: sprintStories.map(story => story.id)
        },
        fallback,
        normalize: (candidate, base) => this.normalizeSummaryNote(candidate, base)
      });
    }

    return notes;
  }

  buildFallbackPlanningNote(role, profile, sprintStories, plannedPoints, sprintId, teamCapacityPoints) {
    const storyCount = sprintStories.length;
    const notes = {
      po: {
        summary: `PO confirmed the ${sprintId} scope for ${profile.projectName} against the approved business priorities.`,
        bullets: [
          `Stories in scope: ${storyCount}`,
          `Highest-priority story: ${sprintStories[0] ? sprintStories[0].id : 'None'}`,
          'Scope changes should stay outside the sprint unless explicitly approved.'
        ]
      },
      developer: {
        summary: `DEV reviewed the sprint slices for ${profile.projectName} and flagged the delivery load against team capacity.`,
        bullets: [
          `Planned story points: ${plannedPoints}`,
          `Capacity check: ${plannedPoints <= teamCapacityPoints ? 'within target' : 'over target'}`,
          'Technical slices should stay independently shippable where possible.'
        ]
      },
      qc: {
        summary: `QC aligned coverage for the ${sprintId} stories and kept release risk visible before execution starts.`,
        bullets: [
          `QC-covered stories: ${storyCount}`,
          `Most sensitive path: ${sprintStories[0] ? sprintStories[0].title : 'No stories selected'}`,
          'Critical flows require executable QC evidence before review.'
        ]
      },
      pm: {
        summary: `PM finalized ${sprintId} for ${profile.projectName} with capacity, blocker, and reporting guardrails.`,
        bullets: [
          `Sprint goal is tied to the first validated slice of ${profile.projectName}.`,
          `Planned story points: ${plannedPoints}`,
          'Daily standups and QC syncs remain mandatory once delivery begins.'
        ]
      }
    };

    return notes[role];
  }

  async collectQcSyncNotes(state, inSprint) {
    const notes = {};
    const roles = ['developer', 'qc'];

    for (const role of roles) {
      const fallback = this.buildFallbackQcSyncNote(role, state, inSprint);
      notes[role] = await this.runAgentTurn({
        role,
        ceremony: 'daily_qc_sync',
        prompt: this.buildQcSyncPrompt(role, state, inSprint),
        context: {
          workflow_state: state.status,
          sprint_id: state.current_sprint_id,
          in_sprint_story_ids: inSprint.map(story => story.id)
        },
        fallback,
        normalize: (candidate, base) => this.normalizeSummaryNote(candidate, base)
      });
    }

    return notes;
  }

  buildFallbackQcSyncNote(role, state, inSprint) {
    const notes = {
      developer: {
        summary: `DEV reported ${inSprint.length} active or completed stories for ${state.current_sprint_id || 'the current sprint'}.`,
        bullets: [
          `Active sprint stories: ${inSprint.filter(story => story.status === 'IN_SPRINT').length}`,
          `Completed stories: ${inSprint.filter(story => story.status === 'DONE').length}`,
          state.status === WORKFLOW_STATES.IN_SPRINT ? 'No delivery blocker reported in the baseline update.' : 'Sprint execution has not started yet.'
        ]
      },
      qc: {
        summary: `QC reviewed the latest scenario coverage and release posture for ${state.current_sprint_id || 'the current sprint'}.`,
        bullets: [
          `Stories with QC scenarios: ${inSprint.length}`,
          state.status === WORKFLOW_STATES.IN_SPRINT ? 'Release risk is being monitored against active sprint work.' : 'Release risk is waiting on sprint execution.',
          'Critical scenario drift should be surfaced immediately.'
        ]
      }
    };

    return notes[role];
  }

  async buildDailyDigestNote(state, backlog, blockers) {
    const fallback = {
      summary: `PM summarized the daily status for ${state.project_name || this.titleizeProjectId(this.projectId)}.`,
      bullets: [
        `Workflow state: ${state.status}`,
        `Stories tracked: ${backlog.stories.length}`,
        `Open blockers: ${blockers.length}`
      ]
    };

    return this.runAgentTurn({
      role: 'pm',
      ceremony: 'daily_activity_digest',
      prompt: this.buildDailyDigestPrompt(state, backlog, blockers),
      context: {
        workflow_state: state.status,
        project_name: state.project_name || this.titleizeProjectId(this.projectId),
        backlog_story_count: backlog.stories.length,
        blocker_count: blockers.length,
        approval_status: state.approval.status
      },
      fallback,
      normalize: (candidate, base) => this.normalizeSummaryNote(candidate, base)
    });
  }

  /**
   * Returns a bounded, role-filtered context snippet for appending to any prompt.
   *
   * Caps: 3 recent feedback entries (type-filtered), 3 unresolved questions,
   * 5 active sprint stories (IN_SPRINT + REVIEW only).
   * Returns empty string when no relevant context exists.
   */
  selectBoundedContext(role, ceremony, state, backlog) {
    const MAX_FEEDBACK = 3;
    const MAX_QUESTIONS = 3;
    const MAX_SPRINT_STORIES = 5;
    const lines = [];

    // 1. Recent relevant feedback — business for PM/PO, technical for DEV/QC
    const feedbackTypes = (role === 'developer' || role === 'qc') ? ['technical'] : ['business'];
    let recentFeedback = [];
    try {
      recentFeedback = this.loadFeedbackLog()
        .filter(e => feedbackTypes.includes(e.type))
        .slice(-MAX_FEEDBACK);
    } catch { /* feedback log absent */ }

    if (recentFeedback.length > 0) {
      lines.push(`Recent ${feedbackTypes[0]} feedback (latest ${recentFeedback.length}):`);
      recentFeedback.forEach(e => {
        const short = e.message.length > 100 ? e.message.slice(0, 100) + '...' : e.message;
        lines.push(`  [${e.timestamp.split('T')[0]}] ${short}`);
      });
    }

    // 2. Unresolved questions — top N only, normalized to strings
    const questions = (state.open_questions || [])
      .slice(0, MAX_QUESTIONS)
      .map(q => (typeof q === 'string' ? q : (q.question || JSON.stringify(q))));
    if (questions.length > 0) {
      lines.push(`Unresolved questions (top ${questions.length}): ${questions.join(' | ')}`);
    }

    // 3. Active sprint stories — only for ceremonies that benefit from story-level context
    const SPRINT_CEREMONIES = new Set(['daily_standup', 'daily_qc_sync', 'sprint_planning', 'feedback']);
    if (SPRINT_CEREMONIES.has(ceremony) && backlog && Array.isArray(backlog.stories)) {
      const active = backlog.stories
        .filter(s => s.status === 'IN_SPRINT' || this.isStoryInReview(s))
        .slice(0, MAX_SPRINT_STORIES)
        .map(s => `  ${s.id} [${s.status}]: ${s.title}`);
      if (active.length > 0) {
        lines.push(`Active sprint stories (${active.length}):`);
        active.forEach(l => lines.push(l));
      }
    }

    return lines.length > 0 ? '\n' + lines.join('\n') : '';
  }

  buildDiscoveryPrompt(role, profile, state) {
    const focus = {
      po: 'Focus on business framing, scope, assumptions, and unanswered product questions.',
      developer: 'Focus on technical slices, dependencies, and the highest-risk implementation decisions.',
      qc: 'Focus on scenario coverage, release risks, and the evidence needed before review.',
      pm: 'Focus on workflow readiness, approval gating, blocker posture, and the next Scrum move.'
    };

    const topQuestions = (state.open_questions || []).slice(0, 3)
      .map(q => (typeof q === 'string' ? q : (q.question || JSON.stringify(q))));
    return [
      `You are the ${this.agents[role].name} for ${profile.projectName}.`,
      focus[role],
      'Return raw JSON only with keys "summary" and "bullets". Do not wrap the response in code fences.',
      `Idea: ${state.idea || profile.projectName}`,
      `Workflow state: ${state.status}`,
      `Business goals: ${profile.business_goals.slice(0, 3).join(' | ')}`,
      `Core capabilities: ${profile.core_capabilities.slice(0, 4).join(' | ')}`,
      `Open questions: ${topQuestions.join(' | ') || 'None'}`,
      this.selectBoundedContext(role, 'discovery_sync', state, null)
    ].filter(Boolean).join('\n');
  }

  buildStandupPrompt(role, state, profile, backlog) {
    const doneCount = backlog ? backlog.stories.filter(story => this.isStoryDone(story)).length : 0;
    const inSprintCount = backlog ? backlog.stories.filter(story => story.status === 'IN_SPRINT').length : 0;
    const reviewCount = backlog ? backlog.stories.filter(story => this.isStoryInReview(story)).length : 0;
    return [
      `You are the ${this.agents[role].name} for ${profile.projectName}.`,
      'Return raw JSON only with keys "yesterday", "today", and "blockers". Do not wrap the response in code fences.',
      'Keep the update short and action-oriented.',
      `Workflow state: ${state.status}`,
      `Approval status: ${state.approval.status}`,
      `Sprint progress: ${doneCount} DONE, ${reviewCount} REVIEW, ${inSprintCount} IN_SPRINT`,
      this.selectBoundedContext(role, 'daily_standup', state, backlog)
    ].filter(Boolean).join('\n');
  }

  buildPlanningPrompt(role, profile, state, sprintStories, plannedPoints, sprintId, teamCapacityPoints) {
    const storyLines = sprintStories.slice(0, 8)
      .map(s => `${s.id} (${s.story_points}pt): ${s.title}`);
    return [
      `You are the ${this.agents[role].name} for ${profile.projectName}.`,
      'Return raw JSON only with keys "summary" and "bullets". Do not wrap the response in code fences.',
      `Ceremony: sprint planning for ${sprintId}`,
      `Planned story points: ${plannedPoints} / capacity ${teamCapacityPoints}`,
      `Stories in scope (${sprintStories.length}): ${storyLines.join(' | ') || 'None'}`,
      'Focus on what your role must confirm before the sprint starts.',
      this.selectBoundedContext(role, 'sprint_planning', state, { stories: sprintStories })
    ].filter(Boolean).join('\n');
  }

  buildQcSyncPrompt(role, state, inSprint) {
    const storyLines = inSprint.slice(0, 8)
      .map(s => `${s.id} [${s.status}]: ${s.title}`);
    return [
      `You are the ${this.agents[role].name} in the daily QC sync.`,
      'Return raw JSON only with keys "summary" and "bullets". Do not wrap the response in code fences.',
      `Workflow state: ${state.status}`,
      `Sprint: ${state.current_sprint_id || 'Not started'}`,
      `Stories tracked (${inSprint.length}): ${storyLines.join(' | ') || 'None'}`,
      'Focus on release risk, scenario readiness, and the most important next move.',
      this.selectBoundedContext(role, 'daily_qc_sync', state, { stories: inSprint })
    ].filter(Boolean).join('\n');
  }

  buildDailyDigestPrompt(state, backlog, blockers) {
    const topBlockers = blockers.slice(0, 2).map(b => (typeof b === 'string' ? b : (b.description || JSON.stringify(b))));
    return [
      `You are the ${this.agents.pm.name} publishing the daily digest for ${state.project_name || this.titleizeProjectId(this.projectId)}.`,
      'Return raw JSON only with keys "summary" and "bullets". Do not wrap the response in code fences.',
      `Workflow state: ${state.status}`,
      `Approval status: ${state.approval.status}`,
      `Stories tracked: ${backlog.stories.length}`,
      topBlockers.length > 0 ? `Active blockers: ${topBlockers.join(' | ')}` : 'Active blockers: none',
      'Keep the message concise enough for a Discord channel summary.',
      this.selectBoundedContext('pm', 'daily_activity_digest', state, backlog)
    ].filter(Boolean).join('\n');
  }

  async runAgentTurn({ role, ceremony, prompt, context, fallback, normalize }) {
    const runnerConfig = this.getConfigValue(this.runtimeConfig, ['openclaw']) || {};
    // Inject skill context for this role if configured
    const skillContext = role ? this.loadRoleSkill(role) : '';
    if (skillContext) prompt = prompt + skillContext;
    const safeFallback = { ...fallback };
    let execution = {
      source: (runnerConfig.mode || 'auto') === 'template' ? 'template_mode' : 'template_fallback',
      degraded: (runnerConfig.mode || 'auto') !== 'template',
      reason: (runnerConfig.mode || 'auto') === 'template' ? 'configured_template_mode' : 'runner_not_attempted'
    };
    let candidate = {};
    let runnerError = '';

    if (this.shouldAttemptOpenClawRunner(runnerConfig)) {
      try {
        candidate = this.executeOpenClawTurn({ role, ceremony, prompt, context }, runnerConfig);
        const candidateMeta = this.extractTurnExecutionMeta(candidate);
        candidate = this.stripTurnExecutionMeta(candidate);
        execution = candidateMeta || {
          source: 'openclaw',
          degraded: false,
          reason: ''
        };
        this.openClawRunnerStatus = {
          attempted: true,
          available: true,
          reason: ''
        };
      } catch (error) {
        runnerError = error.message;
        if (this.isRunnerUnavailableError(error)) {
          this.openClawRunnerStatus = {
            attempted: true,
            available: false,
            reason: error.message
          };
        }

        execution = {
          source: 'template_fallback',
          degraded: true,
          reason: this.isRunnerUnavailableError(error) ? 'runner_unavailable' : 'runner_error'
        };

        if (runnerConfig.fallback_to_templates === false && (runnerConfig.mode || 'auto') !== 'template') {
          throw new Error(`OpenClaw runner failed for ${role} during ${ceremony}: ${error.message}`);
        }
      }
    } else if ((runnerConfig.mode || 'auto') !== 'template') {
      execution = {
        source: 'template_fallback',
        degraded: true,
        reason: this.openClawRunnerStatus.available === false ? 'runner_previously_unavailable' : 'runner_not_attempted'
      };
    }

    const normalized = normalize ? normalize(candidate, safeFallback) : { ...safeFallback };
    const result = {
      ...safeFallback,
      ...normalized,
      source: execution.source,
      execution
    };

    if (runnerError) {
      result.runner_error = runnerError;
      result.execution.runner_error = runnerError;
    }

    if (runnerConfig.save_transcripts !== false && this.docsDir) {
      this.saveAgentTurnTranscript(ceremony, role, prompt, context, result);
    }

    if (execution.degraded) {
      this.noteTurnExecutionEvent(ceremony, role, result.execution);
    }

    return result;
  }

  shouldAttemptOpenClawRunner(runnerConfig) {
    const mode = runnerConfig.mode || 'auto';
    if (mode === 'template') {
      return false;
    }

    if (mode === 'auto' && this.openClawRunnerStatus.attempted && this.openClawRunnerStatus.available === false) {
      return false;
    }

    return true;
  }

  isRunnerUnavailableError(error) {
    return /ENOENT|not recognized|command not found|The system cannot find the file specified|executable file not found/i.test(
      String(error && error.message ? error.message : error)
    );
  }


  loadRoleSkill(role) {
    // Load SKILL.md for the role from role_skills config, if set
    const roleSkills = (this.runtimeConfig.role_skills || {});
    const skillName = roleSkills[role];
    if (!skillName || !skillName.trim()) return '';

    // Search common skill locations
    const os = require('os');
    const searchPaths = [
      path.join(os.homedir(), '.agents', 'skills', skillName, 'SKILL.md'),
      path.join(os.homedir(), '.openclaw', 'skills', skillName, 'SKILL.md'),
      path.join('/usr/local/lib/openclaw/skills', skillName, 'SKILL.md'),
    ];

    for (const skillPath of searchPaths) {
      if (fs.existsSync(skillPath)) {
        try {
          const raw = fs.readFileSync(skillPath, 'utf8');
          // Strip YAML frontmatter
          const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
          return body ? `\n\n---\n**Skill Context (${skillName}):**\n${body}\n---` : '';
        } catch { /* skip */ }
      }
    }
    return '';
  }

  executeOpenClawTurn(payload, runnerConfig) {
    const adapter = runnerConfig.adapter || 'stdio-json';
    if (adapter === 'agent-cli') {
      return this.executeOpenClawAgentTurn(payload, runnerConfig);
    }

    const command = runnerConfig.command || 'openclaw';
    const args = Array.isArray(runnerConfig.args) ? runnerConfig.args : [];
    const result = spawnSync(command, args, {
      cwd: this.workspaceRoot,
      input: JSON.stringify(payload, null, 2),
      encoding: 'utf-8',
      timeout: runnerConfig.timeout_ms || 120000,
      windowsHide: true
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `Runner exited with code ${result.status}`).trim());
    }

    const stdout = (result.stdout || '').trim();
    if (!stdout) {
      return {
        __turnMeta: {
          source: 'partial_parse_fallback',
          degraded: true,
          reason: 'empty_runner_output'
        }
      };
    }

    try {
      return JSON.parse(stdout);
    } catch (error) {
      return {
        __turnMeta: {
          source: 'partial_parse_fallback',
          degraded: true,
          reason: 'non_json_runner_output'
        },
        summary: stdout,
        bullets: [stdout]
      };
    }
  }

  executeOpenClawAgentTurn(payload, runnerConfig) {
    const command = runnerConfig.command || 'openclaw';
    const args = Array.isArray(runnerConfig.args) ? [...runnerConfig.args] : [];
    const agentId = runnerConfig.agent || 'main';
    const thinking = this.mapOpenClawThinkingLevel(payload.ceremony);

    args.push('agent', '--agent', agentId, '--json', '--message', payload.prompt);

    if (runnerConfig.local !== false) {
      args.push('--local');
    }

    if (thinking) {
      args.push('--thinking', thinking);
    }

    const result = spawnSync(command, args, {
      cwd: this.workspaceRoot,
      encoding: 'utf-8',
      timeout: runnerConfig.timeout_ms || 120000,
      windowsHide: true
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `Runner exited with code ${result.status}`).trim());
    }

    return this.parseOpenClawAgentOutput((result.stdout || '').trim());
  }

  mapOpenClawThinkingLevel(ceremony) {
    const thinkingMap = {
      discovery_sync: 'medium',
      sprint_planning: 'medium',
      sprint_review: 'medium',
      retrospective: 'medium',
      story_implementation: 'high',
      daily_standup: 'low',
      daily_qc_sync: 'low',
      daily_activity_digest: 'minimal'
    };

    return thinkingMap[ceremony] || 'low';
  }

  parseOpenClawAgentOutput(stdout) {
    if (!stdout) {
      return {};
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      return {
        __turnMeta: {
          source: 'partial_parse_fallback',
          degraded: true,
          reason: 'non_json_agent_output'
        },
        summary: stdout,
        bullets: [stdout]
      };
    }

    const payloadContainer = parsed && parsed.result && Array.isArray(parsed.result.payloads)
      ? parsed.result
      : parsed;
    const responseText = this.extractOpenClawPayloadText(payloadContainer);
    if (!responseText) {
      return parsed;
    }

    const jsonText = this.extractJsonText(responseText);
    if (jsonText) {
      try {
        return JSON.parse(jsonText);
      } catch (error) {
        return {
          __turnMeta: {
            source: 'partial_parse_fallback',
            degraded: true,
            reason: 'invalid_json_payload'
          },
          summary: responseText,
          bullets: [responseText]
        };
      }
    }

    return {
      __turnMeta: {
        source: 'partial_parse_fallback',
        degraded: true,
        reason: 'non_json_payload_text'
      },
      summary: responseText,
      bullets: [responseText]
    };
  }

  extractTurnExecutionMeta(candidate) {
    return candidate && typeof candidate === 'object' && !Array.isArray(candidate) && candidate.__turnMeta
      ? candidate.__turnMeta
      : null;
  }

  stripTurnExecutionMeta(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !candidate.__turnMeta) {
      return candidate;
    }

    const stripped = { ...candidate };
    delete stripped.__turnMeta;
    return stripped;
  }

  extractOpenClawPayloadText(parsed) {
    if (!parsed || !Array.isArray(parsed.payloads)) {
      return '';
    }

    return parsed.payloads
      .map(payload => (payload && typeof payload.text === 'string' ? payload.text.trim() : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  extractJsonText(text) {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return '';
    }

    const fencedMatch = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fencedMatch) {
      return fencedMatch[1].trim();
    }

    if ((normalized.startsWith('{') && normalized.endsWith('}')) || (normalized.startsWith('[') && normalized.endsWith(']'))) {
      return normalized;
    }

    return '';
  }

  saveAgentTurnTranscript(ceremony, role, prompt, context, response) {
    const transcriptDir = this.getConfigValue(this.runtimeConfig, ['openclaw', 'transcript_dir']) || 'agent-turns';
    const fileName = `${this.fileSafeTimestamp(new Date().toISOString())}-${role}.json`;
    this.writeJson(path.join(this.docsDir, transcriptDir, ceremony, fileName), {
      timestamp: new Date().toISOString(),
      ceremony,
      role,
      prompt,
      context,
      response
    });
  }

  normalizeSummaryNote(candidate, fallback) {
    const normalized = this.coerceAgentCandidate(candidate);
    return {
      summary: this.coerceText(normalized.summary, fallback.summary),
      bullets: this.coerceStringArray(normalized.bullets, fallback.bullets)
    };
  }

  normalizeStandupTurn(candidate, fallback) {
    const normalized = this.coerceAgentCandidate(candidate);
    return {
      summary: this.coerceText(normalized.summary, fallback.summary),
      yesterday: this.coerceText(normalized.yesterday, fallback.yesterday),
      today: this.coerceText(normalized.today, fallback.today),
      blockers: this.coerceStringArray(normalized.blockers, fallback.blockers)
    };
  }

  coerceAgentCandidate(candidate) {
    if (!candidate) {
      return {};
    }

    if (typeof candidate === 'string') {
      const summary = candidate.trim();
      return summary ? { summary, bullets: [summary] } : {};
    }

    if (typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate;
    }

    return {};
  }

  coerceText(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  coerceStringArray(value, fallback) {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const items = value
      .map(item => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);

    return items.length > 0 ? items : fallback;
  }

  writeDiscoveryArtifacts(profile, state, backlog = this.buildBacklog(profile, state), discoveryNotes = null) {
    this.writeMarkdown(path.join(this.docsDir, 'project-charter.md'), this.renderProjectCharter(profile, state, discoveryNotes));
    this.writeMarkdown(path.join(this.docsDir, 'product-requirements.md'), this.renderProductRequirements(profile, backlog, discoveryNotes));
    this.writeMarkdown(path.join(this.docsDir, 'technical-design.md'), this.renderTechnicalDesign(profile, backlog, discoveryNotes));
    this.writeMarkdown(path.join(this.docsDir, 'qc-strategy.md'), this.renderQcStrategy(profile, backlog, discoveryNotes));
    this.writeMarkdown(path.join(this.docsDir, 'open-questions.md'), this.renderOpenQuestions(profile, state));
    this.writeMarkdown(path.join(this.docsDir, 'delivery-plan.md'), this.renderDeliveryPlan(profile, backlog, state, discoveryNotes));
    this.saveBacklog(backlog);
  }

  renderProjectCharter(profile, state, discoveryNotes) {
    return `# Project Charter\n\n**Project Name:** ${profile.projectName}\n**Project ID:** ${this.projectId}\n**Workflow State:** ${state.status}\n**Team:** 1 PM, 1 PO, 1 DEV, 1 QC\n\n## Problem Statement\n\n${profile.problem_statement}\n\n## Business Goals\n\n${profile.business_goals.map(goal => `- ${goal}`).join('\n')}\n\n## Core Capabilities\n\n${profile.core_capabilities.map(capability => `- ${capability}`).join('\n')}\n\n## Primary Personas\n\n${profile.personas.map(persona => `- ${persona}`).join('\n')}\n\n## Assumptions\n\n${profile.assumptions.map(assumption => `- ${assumption}`).join('\n')}\n${this.renderAgentNotesSection('PM Consolidation', discoveryNotes && discoveryNotes.pm)}\n## Approval Gate\n\nImplementation may not start until the user explicitly approves the discovery package. PM owns the gate, PO owns business clarity, DEV owns feasibility, and QC owns scenario readiness.\n`;
  }

  renderProductRequirements(profile, backlog, discoveryNotes) {
    return `# Product Requirements\n\n## Product Summary\n\n${profile.projectName} is being shaped through a PO-first workflow. The PO package defines the business outcome, the DEV package translates it into delivery slices, and QC prepares scenario coverage before implementation starts.\n\n## Release Scope\n\n${profile.core_capabilities.map(capability => `- ${capability}`).join('\n')}\n${this.renderAgentNotesSection('PO Notes', discoveryNotes && discoveryNotes.po)}\n## Backlog Ready For Planning\n\n${backlog.stories.map(story => `- ${story.id}: ${story.title}`).join('\n')}\n\n## Acceptance Direction\n\n${backlog.stories.map(story => `### ${story.id}\n${story.acceptance_criteria.map(item => `- ${item}`).join('\n')}`).join('\n\n')}\n`;
  }

  renderTechnicalDesign(profile, backlog, discoveryNotes) {
    return `# Technical Design\n\n## Delivery Principles\n\n${profile.technical_direction.map(item => `- ${item}`).join('\n')}\n${this.renderAgentNotesSection('DEV Notes', discoveryNotes && discoveryNotes.developer)}\n## Planned Delivery Slices\n\n${backlog.stories.map(story => `### ${story.id}\n- Scope: ${story.title}\n- Technical note: ${story.technical_notes}\n- Estimate: ${story.story_points} points`).join('\n\n')}\n\n## Implementation Gate\n\nDEV does not begin implementation until PM records user approval in docs/workflow-state.json.\n`;
  }

  renderQcStrategy(profile, backlog, discoveryNotes) {
    return `# QC Strategy\n\n## QC Focus Areas\n\n${profile.qc_focus.map(item => `- ${item}`).join('\n')}\n${this.renderAgentNotesSection('QC Notes', discoveryNotes && discoveryNotes.qc)}\n## Story-Level QC Scenarios\n\n${backlog.stories.map(story => `### ${story.id}\n${story.qc_scenarios.map(item => `- ${item}`).join('\n')}`).join('\n\n')}\n\n## Release Gate\n\nQC signs off on story completion and release readiness before PM can move a sprint to review or release-candidate status.\n`;
  }

  renderOpenQuestions(profile, state) {
    const questions = this.normalizeQuestionList(state.open_questions);
    const resolved = Array.isArray(state.resolved_open_questions) ? state.resolved_open_questions : [];
    const workingRule = this.shouldStopOnOpenQuestions()
      ? 'Discovery and approval pause when open questions remain unresolved. Record the answers as business feedback, then rerun discovery-sync or request-approval.'
      : 'The team may continue planning with documented assumptions, but implementation stays paused until approval is recorded.';
    const openQuestionsSection = questions.length > 0
      ? questions.map((question, index) => `${index + 1}. ${question}`).join('\n')
      : 'None.';
    const resolvedSection = resolved.length > 0
      ? `\n\n## Recently Answered\n\n${resolved.slice(-5).map((entry, index) => `${index + 1}. ${entry.question}\n   - Answer: ${entry.answer}`).join('\n')}`
      : '';

    return `# Open Questions\n\n${openQuestionsSection}${resolvedSection}\n\n## Working Rule\n\n${workingRule}\n`;
  }

  renderDeliveryPlan(profile, backlog, state, discoveryNotes) {
    return `# Delivery Plan\n\n## Workflow Sequence\n\n1. PO completes business and domain framing.\n2. DEV translates approved requirements into implementation slices.\n3. QC defines scenario coverage and release risks.\n4. PM manages approval, sprint entry, daily reporting, and blockers.\n\n## Current State\n\n- Workflow state: ${state.status}\n- Approval status: ${state.approval.status}\n- Stories prepared: ${backlog.stories.length}\n${this.renderAgentNotesSection('PM Delivery Notes', discoveryNotes && discoveryNotes.pm)}\n## Next Actions\n\n${this.buildNextActions(state, backlog).map(action => `- ${action}`).join('\n')}\n`;
  }

  renderApprovalRequest(profile, state, backlog, pmNote) {
    const blockedByQuestions = this.hasBlockingOpenQuestions(state);
    const pmSummary = blockedByQuestions
      ? `The discovery package is complete, but approval is blocked until ${state.open_questions.length} blocking open question${state.open_questions.length === 1 ? '' : 's'} ${state.open_questions.length === 1 ? 'is' : 'are'} answered.`
      : pmNote && pmNote.summary
        ? pmNote.summary
        : 'The team has completed the discovery package and is waiting for explicit approval before DEV starts implementation work.';
    const pmBullets = pmNote && Array.isArray(pmNote.bullets) && pmNote.bullets.length > 0
      ? `\n\n${pmNote.bullets.map(item => `- ${item}`).join('\n')}`
      : '';

    return `# Approval Request\n\n**Project:** ${profile.projectName}\n**State:** ${state.status}\n\n## Ready For Review\n\n- Project charter\n- Product requirements\n- Technical design\n- QC strategy\n- Backlog (${backlog.stories.length} stories)\n- Open questions\n\n## Approval Gate\n\n${blockedByQuestions ? 'Blocked until the open questions are answered.' : 'Ready for human review and approval.'}\n\n## PM Summary\n\n${pmSummary}${pmBullets}\n`;
  }

  renderAgentNotesSection(title, note) {
    if (!note) {
      return '';
    }

    const bullets = Array.isArray(note.bullets) && note.bullets.length > 0
      ? `\n\n${note.bullets.map(item => `- ${item}`).join('\n')}`
      : '';
    const source = note.source ? `\n\n_Source: ${note.source}_` : '';

    return `\n## ${title}\n\n${note.summary || 'No notes captured.'}${source}${bullets}\n`;
  }

  extractBlockers(standup, stage) {
    const blockers = [];

    for (const [role, report] of Object.entries(standup)) {
      if (!this.agents[role] || !Array.isArray(report.blockers)) {
        continue;
      }

      report.blockers.forEach(description => {
        blockers.push({
          id: `BLK-${Date.now()}-${blockers.length + 1}`,
          role,
          description,
          detected_at: new Date().toISOString(),
          stage,
          status: 'OPEN',
          resolution_target: '2 hours'
        });
      });
    }

    return blockers;
  }

  async escalateBlockers(blockers, stage) {
    for (const blocker of blockers) {
      const owner = this.classifyBlocker(blocker.role);
      const enriched = {
        ...blocker,
        owner,
        sla_due_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      };

      this.logBlocker(enriched);
      await this.sendDiscordNotification('blocker_escalation', {
        title: `${this.titleizeProjectId(this.projectId)}: blocker escalated`,
        summary: `PM escalated a ${stage} blocker to ${owner}.`,
        bullets: [
          `Role: ${blocker.role}`,
          `Description: ${blocker.description}`,
          `Owner: ${owner}`,
          `SLA due: ${enriched.sla_due_at}`
        ]
      });
    }
  }

  classifyBlocker(role) {
    const blockerMap = {
      po: 'po-product',
      developer: 'dev-implementation',
      qc: 'qc-quality',
      pm: 'pm-orchestrator'
    };

    return blockerMap[role] || 'pm-orchestrator';
  }

  async getCompletedStories() {
    const backlog = this.loadBacklog();
    return backlog.stories.filter(story => this.isStoryDone(story));
  }

  async calculateVelocity() {
    const backlog = this.loadBacklog();
    const planned = backlog.stories
      .filter(story => this.isStoryActive(story) || this.isStoryDone(story))
      .reduce((total, story) => total + story.story_points, 0);
    const completed = backlog.stories
      .filter(story => this.isStoryDone(story))
      .reduce((total, story) => total + story.story_points, 0);

    return {
      planned,
      completed,
      percentage: planned > 0 ? Math.round((completed / planned) * 100) : 0
    };
  }

  async getQcReadiness() {
    const backlog = this.loadBacklog();
    const scopedStories = backlog.stories.filter(story => this.isStoryActive(story) || this.isStoryDone(story));
    const qcReady = scopedStories.filter(story => Array.isArray(story.qc_scenarios) && story.qc_scenarios.length > 0);
    return {
      percentage: scopedStories.length > 0 ? Math.round((qcReady.length / scopedStories.length) * 100) : 100,
      scoped_stories: scopedStories.length,
      qc_ready_stories: qcReady.length
    };
  }

  async getBugCount() {
    const qcSyncDir = path.join(this.docsDir, 'ceremonies', 'qc-sync');
    if (!fs.existsSync(qcSyncDir)) {
      return { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    }

    const files = fs.readdirSync(qcSyncDir).sort();
    if (files.length === 0) {
      return { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    }

    const latest = JSON.parse(fs.readFileSync(path.join(qcSyncDir, files[files.length - 1]), 'utf-8'));
    return latest.qc ? latest.qc.bug_summary : { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
  }

  async getOpenBlockers() {
    return this.loadBlockerLog().filter(blocker => blocker.status !== 'RESOLVED');
  }

  async gatherStakeholderFeedback() {
    const state = this.loadState();
    return `Stakeholders have an approval-first summary for ${state.project_name || this.titleizeProjectId(this.projectId)} and should review release readiness after QC signs off.`;
  }

  async deploymentReadinessCheck(review) {
    const readiness = {
      critical_bugs: review.metrics.bug_count.critical === 0,
      qc_readiness: review.metrics.qc_readiness.percentage >= 80,
      no_blockers: review.metrics.open_blockers.length === 0,
      stakeholder_ok: true
    };

    return Object.values(readiness).every(Boolean);
  }

  async scheduleDeployment(sprintId) {
    console.log(`Deployment scheduled for ${sprintId}.`);
  }

  async getPlannedVsCompleted() {
    const velocity = await this.calculateVelocity();
    return {
      planned: velocity.planned,
      completed: velocity.completed,
      ratio: velocity.planned > 0 ? Number((velocity.completed / velocity.planned).toFixed(2)) : 0
    };
  }

  async calculateBugEscapeRate() {
    const bugs = await this.getBugCount();
    return {
      production_bugs: 0,
      total_bugs: bugs.total,
      rate: bugs.total > 0 ? 0 : 0
    };
  }

  async getBlockerStats() {
    return this.loadBlockerLog().reduce((stats, blocker) => {
      const key = blocker.role || 'unknown';
      stats[key] = (stats[key] || 0) + 1;
      return stats;
    }, {});
  }

  async sendDailyActivityReport(source, state, blockers, executionContext) {
    const backlog = this.loadBacklog();
    const bullets = [
      `Project: ${state.project_name || this.titleizeProjectId(this.projectId)}`,
      `State: ${state.status}`,
      `Stories tracked: ${backlog.stories.length}`,
      `Pending approval: ${state.approval.status !== 'APPROVED' ? 'yes' : 'no'}`
    ];

    if (this.getConfigValue(this.discordConfig, ['discord', 'message_settings', 'include_blockers'])) {
      bullets.push(`Open blockers: ${blockers.length}`);
    }

    if (this.getConfigValue(this.discordConfig, ['discord', 'message_settings', 'include_next_steps'])) {
      bullets.push(`Next: ${this.buildNextActions(state, backlog)[0]}`);
    }

    const executionWarningBullets = this.buildExecutionWarningBullets(executionContext, 1);
    bullets.push(...executionWarningBullets);

    await this.sendDiscordNotification('daily_digest', {
      title: `${state.project_name || this.titleizeProjectId(this.projectId)}: ${source}`,
      summary: `**${state.project_name || this.titleizeProjectId(this.projectId)}** — ${state.status}${blockers.length > 0 ? ` | ⚠️ ${blockers.length} open blocker${blockers.length > 1 ? 's' : ''}` : ''}`,
      bullets
    });
  }

  async sendDiscordNotification(kind, message) {
    if (!this.shouldSendNotification(kind)) {
      return { delivered: false, reason: `Notification type ${kind} disabled by runtime config` };
    }

    const discord = this.getConfigValue(this.discordConfig, ['discord']) || {};
    if (!discord.enabled) {
      return { delivered: false, reason: 'Discord delivery disabled' };
    }

    const transport = discord.transport || 'webhook';
    const mentionTarget = this.resolveDiscordMention(kind, discord);
    const maxBullets = this.getConfigValue(this.discordConfig, ['discord', 'message_settings', 'max_bullets']) || 5;
    const lines = [];

    if (mentionTarget) lines.push(mentionTarget);
    lines.push(`**${message.title}**`);
    lines.push(message.summary);
    (message.bullets || []).slice(0, maxBullets).forEach(item => lines.push(`- ${item}`));
    const content = lines.join('\n');

    if (transport === 'channel') {
      const channelId = discord.channel_id;
      if (!channelId) {
        console.warn('Discord notification skipped: channel_id not configured.');
        return { delivered: false, reason: 'Missing channel_id' };
      }
      // Use openclaw message CLI (respects runtime config command/args for WSL support)
      const { spawnSync: _sp } = require('child_process');
      const discordAccount = discord.account || 'nova';
      const oclCmd = this.getConfigValue(this.runtimeConfig, ['openclaw', 'command']) || 'openclaw';
      const oclBaseArgs = Array.isArray(this.getConfigValue(this.runtimeConfig, ['openclaw', 'args']))
        ? this.getConfigValue(this.runtimeConfig, ['openclaw', 'args']) : [];
      const result = _sp(oclCmd, [...oclBaseArgs,
        'message', 'send',
        '--channel', 'discord',
        '--account', discordAccount,
        '--target', channelId,
        '--message', content
      ], { encoding: 'utf-8', timeout: 30000 });
      if (result.error || result.status !== 0) {
        console.warn('Discord channel send failed:', result.stderr || result.error);
        return { delivered: false, reason: result.stderr || String(result.error) };
      }
      return { delivered: true, transport: 'channel', channel_id: channelId };
    }

    // Fallback: webhook transport
    const webhook = this.resolveDiscordWebhook(discord);
    if (!webhook.url) {
      console.warn(`Discord notification skipped: webhook not configured. Expected ${webhook.expected}.`);
      return { delivered: false, reason: 'Missing webhook configuration' };
    }

    const payload = {
      username: discord.username || 'OpenClaw PM',
      content
    };
    if (discord.avatar_url) payload.avatar_url = discord.avatar_url;
    return this.postJson(webhook.url, payload);
  }

  resolveDiscordMention(kind, discord) {
    const mentionMap = {
      daily_digest: discord.mention_targets && discord.mention_targets.daily_digest,
      blocker_escalation: discord.mention_targets && discord.mention_targets.blocker_escalation,
      approval_required: discord.mention_targets && discord.mention_targets.approval_required,
      ceremony_update: ''
    };

    return mentionMap[kind] || '';
  }

  shouldSendNotification(kind) {
    const reporting = this.getConfigValue(this.runtimeConfig, ['reporting']) || {};

    if (kind === 'daily_digest') {
      return reporting.daily_digest_enabled !== false;
    }

    if (kind === 'ceremony_update') {
      return reporting.send_ceremony_updates !== false;
    }

    return true;
  }

  resolveDiscordWebhook(discord) {
    const directWebhookUrl = typeof discord.webhook_url === 'string' ? discord.webhook_url.trim() : '';
    if (directWebhookUrl) {
      return {
        url: directWebhookUrl,
        expected: 'discord.webhook_url'
      };
    }

    const configuredEnv = typeof discord.webhook_env === 'string' ? discord.webhook_env.trim() : '';
    if (/^https?:\/\//i.test(configuredEnv)) {
      return {
        url: configuredEnv,
        expected: 'discord.webhook_env or OPENCLAW_DISCORD_WEBHOOK'
      };
    }

    if (configuredEnv && process.env[configuredEnv]) {
      return {
        url: process.env[configuredEnv],
        expected: configuredEnv
      };
    }

    if (process.env.OPENCLAW_DISCORD_WEBHOOK) {
      return {
        url: process.env.OPENCLAW_DISCORD_WEBHOOK,
        expected: 'OPENCLAW_DISCORD_WEBHOOK'
      };
    }

    return {
      url: '',
      expected: configuredEnv || 'discord.webhook_url or OPENCLAW_DISCORD_WEBHOOK'
    };
  }

  postJson(webhookUrl, payload) {
    return new Promise((resolve, reject) => {
      const endpoint = new URL(webhookUrl);
      const request = https.request(
        {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          path: `${endpoint.pathname}${endpoint.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(payload))
          }
        },
        response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            resolve({
              delivered: response.statusCode >= 200 && response.statusCode < 300,
              statusCode: response.statusCode,
              body: Buffer.concat(chunks).toString('utf-8')
            });
          });
        }
      );

      request.on('error', reject);
      request.write(JSON.stringify(payload));
      request.end();
    });
  }

  loadConfig(fileName, defaults) {
    const filePath = path.join(this.baseDir, fileName);
    if (!fs.existsSync(filePath)) {
      return JSON.parse(JSON.stringify(defaults));
    }

    const parsed = YAML.parse(fs.readFileSync(filePath, 'utf-8')) || {};
    return this.mergeObjects(defaults, parsed);
  }

  mergeObjects(base, override) {
    if (Array.isArray(base)) {
      return Array.isArray(override) ? override : base;
    }

    if (!base || typeof base !== 'object') {
      return override === undefined ? base : override;
    }

    const merged = { ...base };
    Object.entries(override || {}).forEach(([key, value]) => {
      if (merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
        merged[key] = this.mergeObjects(merged[key], value);
      } else {
        merged[key] = value;
      }
    });
    return merged;
  }

  resolveActiveProjectId() {
    return process.env.OPENCLAW_ACTIVE_PROJECT || this.getConfigValue(this.runtimeConfig, ['project', 'active']) || '';
  }

  getConfigValue(source, keys) {
    return keys.reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), source);
  }

  assertProjectSelected() {
    if (!this.projectId) {
      throw new Error('No active project selected. Provide a project id or set project.active in .openclaw/runtime-config.yml.');
    }
  }

  assertWorkflowStateAllowed(commandName, allowedStates) {
    const state = this.loadState();
    if (!allowedStates.includes(state.status)) {
      throw new Error(`${commandName} is only allowed in ${allowedStates.join(', ')}. Current state: ${state.status}.`);
    }
  }

  assertImplementationApproved() {
    this.assertProjectSelected();
    const state = this.loadState();
    const approvalRequired = this.getConfigValue(this.runtimeConfig, ['workflow', 'approval_required_for_implementation']);
    if (approvalRequired && state.approval.status !== 'APPROVED') {
      throw new Error('Implementation is blocked until approval is granted. Run request-approval and approve first.');
    }
  }

  ensureProjectScaffold() {
    this.ensureDir(this.projectDir);
    this.ensureDir(this.docsDir);
    this.ensureDir(path.join(this.docsDir, 'ceremonies', 'standups'));
    this.ensureDir(path.join(this.docsDir, 'ceremonies', 'reviews'));
    this.ensureDir(path.join(this.docsDir, 'ceremonies', 'retros'));
    this.ensureDir(path.join(this.docsDir, 'ceremonies', 'qc-sync'));
    this.ensureDir(path.join(this.docsDir, 'ceremonies', 'digests'));
    this.ensureDir(path.join(this.docsDir, 'blockers'));
  }

  loadState() {
    if (!fs.existsSync(this.stateFilePath())) {
      return {
        project_id: this.projectId,
        project_name: this.titleizeProjectId(this.projectId),
        idea: '',
        status: WORKFLOW_STATES.DISCOVERY_IN_PROGRESS,
        approval: {
          required: true,
          status: 'PENDING',
          requested_at: null,
          approved_at: null
        },
        assumptions: [],
        open_questions: [],
        resolved_open_questions: [],
        execution_health: this.buildDefaultExecutionHealth(),
        current_sprint_id: null,
        updated_at: new Date().toISOString()
      };
    }

    const loaded = JSON.parse(fs.readFileSync(this.stateFilePath(), 'utf-8'));
    if (!Array.isArray(loaded.open_questions)) {
      loaded.open_questions = [];
    }
    if (!Array.isArray(loaded.resolved_open_questions)) {
      loaded.resolved_open_questions = [];
    }
    if (!loaded.execution_health || typeof loaded.execution_health !== 'object') {
      loaded.execution_health = this.buildDefaultExecutionHealth();
    } else {
      loaded.execution_health = this.normalizeExecutionHealth(loaded.execution_health);
    }

    return loaded;
  }

  saveState(state) {
    state.execution_health = this.applyPendingExecutionEvents(state.execution_health);
    this.writeJson(this.stateFilePath(), state);
    this.writeExecutionHealthDoc(state);
  }

  loadBacklog() {
    const file = path.join(this.docsDir, 'backlog.json');
    if (!fs.existsSync(file)) {
      return {
        project_id: this.projectId,
        created_at: new Date().toISOString(),
        workflow_status: WORKFLOW_STATES.DISCOVERY_IN_PROGRESS,
        epics: [],
        stories: [],
        open_questions: []
      };
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }

  saveBacklog(backlog) {
    this.writeJson(path.join(this.docsDir, 'backlog.json'), backlog);
  }

  saveSprintPlan(plan) {
    this.writeJson(path.join(this.docsDir, 'sprint-plan.json'), plan);
  }

  saveSprintReview(review) {
    this.saveCeremonyRecord('reviews', `review-${review.sprint_id}.json`, review);
  }

  saveRetrospective(retro) {
    this.saveCeremonyRecord('retros', `retro-${retro.sprint_id}.json`, retro);
  }

  saveCeremonyRecord(category, fileName, payload) {
    const executionHealth = this.summarizeExecutionMetadata(payload);
    const enrichedPayload = executionHealth.total_turns > 0
      ? { ...payload, execution_health: executionHealth }
      : payload;
    this.writeJson(path.join(this.docsDir, 'ceremonies', category, fileName), enrichedPayload);
  }

  stateFilePath() {
    return path.join(this.docsDir, 'workflow-state.json');
  }

  shouldStopOnOpenQuestions() {
    return this.getConfigValue(this.runtimeConfig, ['workflow', 'stop_on_open_questions']) === true;
  }

  hasOpenQuestions(state) {
    return this.normalizeQuestionList(state && state.open_questions).length > 0;
  }

  hasBlockingOpenQuestions(state) {
    return this.shouldStopOnOpenQuestions() && this.hasOpenQuestions(state);
  }

  normalizeQuestionList(questions) {
    if (!Array.isArray(questions)) {
      return [];
    }

    return questions
      .map(question => (typeof question === 'string' ? question.trim() : ''))
      .filter(Boolean);
  }

  isStoryDone(story) {
    return story && story.status === 'DONE';
  }

  isStoryInReview(story) {
    return story && story.status === 'REVIEW';
  }

  isStoryActive(story) {
    return story && (story.status === 'IN_SPRINT' || story.status === 'REVIEW');
  }

  buildDefaultExecutionHealth() {
    return {
      degraded_events: 0,
      last_event_at: null,
      last_degraded_event: null,
      recent_degraded_events: []
    };
  }

  normalizeExecutionHealth(executionHealth) {
    const normalized = {
      ...this.buildDefaultExecutionHealth(),
      ...(executionHealth || {})
    };

    if (!Array.isArray(normalized.recent_degraded_events)) {
      normalized.recent_degraded_events = [];
    }

    return normalized;
  }

  noteTurnExecutionEvent(ceremony, role, execution) {
    this.pendingExecutionEvents.push({
      ceremony,
      role,
      ...execution,
      occurred_at: new Date().toISOString()
    });
  }

  applyPendingExecutionEvents(executionHealth) {
    const normalized = this.normalizeExecutionHealth(executionHealth);

    if (this.pendingExecutionEvents.length === 0) {
      return normalized;
    }

    this.pendingExecutionEvents.forEach(event => {
      normalized.degraded_events += 1;
      normalized.last_event_at = event.occurred_at;
      normalized.last_degraded_event = event;
      normalized.recent_degraded_events.push(event);
    });

    normalized.recent_degraded_events = normalized.recent_degraded_events.slice(-10);
    this.pendingExecutionEvents = [];
    return normalized;
  }

  writeExecutionHealthDoc(state) {
    if (!this.docsDir) {
      return;
    }

    const executionHealth = this.normalizeExecutionHealth(state.execution_health);
    const recent = executionHealth.recent_degraded_events;
    const recentSection = recent.length > 0
      ? recent.slice().reverse().map((event, index) => `${index + 1}. [${event.ceremony}/${event.role}] ${event.source}${event.reason ? ` — ${event.reason}` : ''}${event.runner_error ? ` — ${event.runner_error}` : ''}`).join('\n')
      : 'None.';

    this.writeMarkdown(
      path.join(this.docsDir, 'execution-health.md'),
      `# Execution Health\n\n- Degraded events recorded: ${executionHealth.degraded_events}\n- Last degraded event at: ${executionHealth.last_event_at || 'None'}\n\n## Recent Degraded Events\n\n${recentSection}\n\n## Working Rule\n\nOpenClaw turns should normally report \`source: openclaw\`. Template fallback or partial parse fallback means the workflow continued in degraded mode and should be reviewed before relying on the output blindly.\n`
    );
  }

  isExecutionMetadata(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.source === 'string' &&
      typeof value.degraded === 'boolean'
    );
  }

  summarizeExecutionMetadata(payload) {
    const degradedTurns = [];
    let totalTurns = 0;

    const visit = (value, pathParts = []) => {
      if (!value || typeof value !== 'object') {
        return;
      }

      if (this.isExecutionMetadata(value)) {
        totalTurns += 1;
        if (value.degraded) {
          degradedTurns.push({
            source: value.source,
            reason: value.reason || '',
            runner_error: value.runner_error || '',
            path: pathParts.join('.') || 'root'
          });
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, [...pathParts, String(index)]));
        return;
      }

      Object.entries(value).forEach(([key, child]) => {
        visit(child, [...pathParts, key]);
      });
    };

    visit(payload);

    return {
      total_turns: totalTurns,
      degraded_turns_count: degradedTurns.length,
      degraded_turns: degradedTurns.slice(0, 10)
    };
  }

  buildExecutionWarningBullets(payload, maxDetails = 1) {
    const executionHealth = this.summarizeExecutionMetadata(payload);
    if (executionHealth.degraded_turns_count === 0) {
      return [];
    }

    const detailBullets = executionHealth.degraded_turns.slice(0, maxDetails).map(turn => {
      const reason = turn.reason ? ` (${turn.reason})` : '';
      return `Execution fallback: ${turn.source}${reason}`;
    });

    return [
      `Execution degraded in ${executionHealth.degraded_turns_count} turn${executionHealth.degraded_turns_count === 1 ? '' : 's'}. See docs/execution-health.md for details.`,
      ...detailBullets
    ];
  }

  buildOpenQuestions(...questionLists) {
    const resolvedQuestions = new Set(
      (Array.isArray(questionLists[questionLists.length - 1]) ? questionLists.pop() : [])
        .map(entry => entry && typeof entry.question === 'string' ? entry.question.trim() : '')
        .filter(Boolean)
    );
    const merged = new Set();

    questionLists.forEach(list => {
      this.normalizeQuestionList(list).forEach(question => {
        if (!resolvedQuestions.has(question)) {
          merged.add(question);
        }
      });
    });

    return Array.from(merged);
  }

  syncDiscoveryApprovalState(state, { requestApproval = false } = {}) {
    state.approval.required = true;
    state.approval.status = 'PENDING';
    state.approval.approved_at = null;

    if (this.hasBlockingOpenQuestions(state)) {
      state.status = WORKFLOW_STATES.AWAITING_USER_INPUT;
      state.approval.requested_at = null;
      return state;
    }

    if (requestApproval) {
      state.status = WORKFLOW_STATES.READY_FOR_APPROVAL;
      state.approval.requested_at = new Date().toISOString();
      return state;
    }

    state.status = WORKFLOW_STATES.DISCOVERY_IN_PROGRESS;
    state.approval.requested_at = null;
    return state;
  }

  consumeAnsweredOpenQuestion(state, answer) {
    const questions = this.normalizeQuestionList(state.open_questions);
    const normalizedAnswer = typeof answer === 'string' ? answer.trim() : '';
    if (questions.length === 0 || !normalizedAnswer) {
      return null;
    }

    const [resolvedQuestion, ...remainingQuestions] = questions;
    state.open_questions = remainingQuestions;
    if (!Array.isArray(state.resolved_open_questions)) {
      state.resolved_open_questions = [];
    }
    state.resolved_open_questions.push({
      question: resolvedQuestion,
      answer: normalizedAnswer,
      resolved_at: new Date().toISOString()
    });

    return resolvedQuestion;
  }

  logBlocker(blocker) {
    const log = this.loadBlockerLog();
    log.push(blocker);
    this.writeJson(path.join(this.docsDir, 'blockers', 'blocker-log.json'), log);
  }

  loadBlockerLog() {
    const file = path.join(this.docsDir, 'blockers', 'blocker-log.json');
    if (!fs.existsSync(file)) {
      return [];
    }

    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }

  writeJson(filePath, value) {
    this.ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  }

  writeMarkdown(filePath, content) {
    this.ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${content.trim()}\n`);
  }

  buildNextSprintId(state) {
    if (!state.current_sprint_id) {
      return 'sprint-1';
    }

    const match = state.current_sprint_id.match(/(\d+)$/);
    if (!match) {
      return 'sprint-1';
    }

    return `sprint-${Number(match[1]) + 1}`;
  }

  titleizeProjectId(projectId) {
    return this.titleCase((projectId || '').replace(/[-_]+/g, ' '));
  }

  deriveProjectId(input) {
    const slug = this.deriveProjectName(input)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return slug || 'new-project';
  }

  deriveProjectName(input) {
    const normalized = String(input || '')
      .replace(/^i want to\s+/i, '')
      .replace(/^(build|create|make|design|develop)\s+/i, '')
      .replace(/^(an?|the)\s+/i, '')
      .trim();

    return this.titleCase(normalized || input);
  }

  titleCase(input) {
    return String(input || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  todayStamp() {
    return new Date().toISOString().split('T')[0];
  }

  fileSafeTimestamp(timestamp) {
    return String(timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function parseCliArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current.startsWith('--')) {
      const [rawKey, inlineValue] = current.slice(2).split('=', 2);
      if (inlineValue !== undefined) {
        args[rawKey] = inlineValue;
      } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
        args[rawKey] = argv[index + 1];
        index += 1;
      } else {
        args[rawKey] = true;
      }
    } else {
      args._.push(current);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
OpenClaw Autonomous Scrum Orchestrator

Usage:
  node .openclaw/orchestrator.js <command> [project-id] [options]

Commands:
  start-idea         Derive a project id from an idea and initialize the discovery package
  init-project        Create or refresh a root-level project workspace and discovery docs
  discovery-sync      Refresh PO, DEV, QC, and PM discovery artifacts
  request-approval    Mark the discovery package as ready for user approval
  approve             Clear the implementation gate
  feedback            Submit business or technical feedback to steer the project
  standup             Run the daily standup
  sprint-planning     Create the sprint plan after approval
  qc-sync             Run the daily QC sync
  implement           DEV writes source code + unit tests, QC writes integration/e2e tests for all IN_SPRINT stories
  sprint-review       Run the sprint review
  retrospective       Run the retrospective
  daily-digest        Publish the daily activity digest
  status              Print workflow state

Feedback options:
  --message "..."     The feedback message (required)
  --type business     Business/domain feedback: new features, scope changes, dropped requirements (default)
  --type technical    Technical feedback: architecture, patterns, tech stack, implementation approach

Examples:
  node .openclaw/orchestrator.js start-idea --idea "Build a customer feedback portal"
  node .openclaw/orchestrator.js feedback customer-feedback-portal --type business --message "Prioritize workspace admins first. Email notifications only in v1."
  node .openclaw/orchestrator.js feedback customer-feedback-portal --type technical --message "Use PostgreSQL and background jobs for report exports."
  node .openclaw/orchestrator.js request-approval customer-feedback-portal
  node .openclaw/orchestrator.js approve customer-feedback-portal
  node .openclaw/orchestrator.js sprint-planning customer-feedback-portal
  node .openclaw/orchestrator.js daily-digest customer-feedback-portal
  `);
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  const projectId = args._[1] || args.project || '';
  const sprintId = args._[2] || args.sprint || '';
  const idea = args.idea || '';
  const orchestrator = new AutonomousScrumOrchestrator(projectId);

  const feedbackMessage = args.message || '';
  const feedbackType = args.type || 'business';

  const commands = {
    'start-idea': () => orchestrator.startIdea(idea, projectId),
    'init-project': () => orchestrator.initProject(idea),
    'discovery-sync': () => orchestrator.discoverySync(),
    'request-approval': () => orchestrator.requestApproval(),
    approve: () => orchestrator.approveImplementation(),
    feedback: () => orchestrator.submitFeedback(feedbackMessage, feedbackType),
    standup: () => orchestrator.standupCeremony(),
    'sprint-planning': () => orchestrator.sprintPlanningCeremony(),
    'qc-sync': () => orchestrator.dailyQcSyncCeremony(),
    implement: () => orchestrator.implementStoriesCeremony(),
    'sprint-review': () => orchestrator.sprintReviewCeremony(sprintId),
    retrospective: () => orchestrator.retrospectiveCeremony(sprintId),
    'daily-digest': () => orchestrator.dailyActivityDigest(),
    status: () => Promise.resolve(orchestrator.getStatus()),
    help: async () => printHelp()
  };

  const action = commands[command] || commands.help;

  action()
    .then(result => {
      if (result) {
        console.log(JSON.stringify(result, null, 2));
      }
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = AutonomousScrumOrchestrator;
