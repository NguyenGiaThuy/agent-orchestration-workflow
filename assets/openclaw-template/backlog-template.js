#!/usr/bin/env node

/**
 * Backlog template for the PM/PO/DEV/QC workflow.
 * Use this as a starting point for a new root-level project docs/backlog.json file.
 */

const backlogTemplate = {
  project_id: "sample-project",
  workflow_status: "READY_FOR_APPROVAL",
  approval_status: "PENDING",
  created_at: "2026-03-18",
  version: "2.0",

  epics: [
    {
      id: "EPIC-1",
      title: "Core user workflow definition",
      owner: "po",
      priority: "MUST_HAVE",
      description: "Define the smallest end-to-end user journey that proves the product's core value.",
      acceptance_criteria: [
        "The primary user can complete the main workflow from entry to outcome",
        "Scope boundaries and out-of-scope behaviors are documented",
        "PO can explain why this journey is enough for the MVP"
      ]
    },
    {
      id: "EPIC-2",
      title: "Implementation foundation and vertical slices",
      owner: "developer",
      priority: "MUST_HAVE",
      description: "Deliver the smallest reliable implementation slice with clear state, data, and error handling.",
      acceptance_criteria: [
        "The core workflow is decomposed into sprint-sized implementation slices",
        "Key state transitions and data ownership are explicit",
        "DEV can deliver the flow incrementally without blocking QC"
      ]
    },
    {
      id: "EPIC-3",
      title: "Quality control and release readiness",
      owner: "qc",
      priority: "MUST_HAVE",
      description: "Make validation, exception handling, and release readiness visible from the first release.",
      acceptance_criteria: [
        "QC scenarios exist for all critical user and operator flows",
        "Exception handling and recovery paths are covered",
        "Release readiness cannot be claimed without QC evidence"
      ]
    }
  ],

  stories: [
    {
      id: "STORY-1",
      epic_id: "EPIC-1",
      title: "As a primary user, I want to complete the core workflow, so that I can realize the product's main value quickly.",
      description: "PO defines the minimum end-to-end journey, decision points, and outcomes needed for the MVP.",
      acceptance_criteria: [
        "The user can move through the core flow without dead ends",
        "The most important decision points and success states are explicit",
        "PO confirms the journey covers the MVP's primary outcome"
      ],
      definition_of_done: [
        "Code reviewed by peer",
        "PO acceptance passes",
        "QC onboarding scenarios executed",
        "Documentation updated in docs/"
      ],
      po_notes: "MUST_HAVE because it proves the product's main value.",
      technical_notes: "Keep the core workflow modular so follow-up capabilities can extend it without a rewrite.",
      qc_scenarios: [
        "Validate the happy path completes successfully from start to finish",
        "Validate incomplete or invalid user inputs fail safely with clear recovery guidance"
      ],
      story_points: 5,
      estimate_confidence: 0.85,
      assigned_to: null,
      priority: "MUST_HAVE",
      status: "READY_FOR_PLANNING",
      approval_status: "PENDING",
      dependencies: ["Project charter approved"],
      created_by: "po-1",
      created_at: "2026-03-18"
    },
    {
      id: "STORY-2",
      epic_id: "EPIC-2",
      title: "As an internal operator, I want visibility into workflow state and core records, so that I can support the product reliably.",
      description: "DEV breaks operational visibility into the smallest usable delivery slice that supports the main workflow.",
      acceptance_criteria: [
        "Key workflow state and records can be reviewed in one place",
        "Operational visibility stays consistent with the primary user workflow",
        "DEV documents the slice and known consistency risks"
      ],
      definition_of_done: [
        "Code reviewed",
        "PO acceptance passes",
        "QC matching scenarios executed",
        "No unresolved sprint blocker remains"
      ],
      po_notes: "MUST_HAVE for supportability and controlled rollout.",
      technical_notes: "Treat state changes and audit fields as consistency-sensitive and observable.",
      qc_scenarios: [
        "Validate state changes are reflected consistently in operator-facing views",
        "Validate stale or invalid records cannot be acted on silently"
      ],
      story_points: 8,
      estimate_confidence: 0.75,
      assigned_to: null,
      priority: "MUST_HAVE",
      status: "READY_FOR_PLANNING",
      approval_status: "PENDING",
      dependencies: ["STORY-1"],
      created_by: "po-1",
      created_at: "2026-03-18"
    },
    {
      id: "STORY-3",
      epic_id: "EPIC-3",
      title: "As the delivery team, we want validation and release checks, so that each increment is safe to ship.",
      description: "QC and DEV align on validation, regression coverage, and exception handling before the first release.",
      acceptance_criteria: [
        "Automated or documented validation exists for the highest-risk paths",
        "Failures and recovery paths are exercised before release",
        "QC confirms the critical scenarios are covered before release"
      ],
      definition_of_done: [
        "Code reviewed",
        "PO confirms the user flow",
        "QC messaging scenarios executed or automated",
        "Release risks documented"
      ],
      po_notes: "MUST_HAVE because release confidence depends on it.",
      technical_notes: "Use repeatable validation and safe retry behavior so failures do not corrupt workflow state.",
      qc_scenarios: [
        "Validate failures do not leave the system in a partially completed state",
        "Validate the release checklist catches regressions in the core workflow"
      ],
      story_points: 8,
      estimate_confidence: 0.7,
      assigned_to: null,
      priority: "MUST_HAVE",
      status: "READY_FOR_PLANNING",
      approval_status: "PENDING",
      dependencies: ["STORY-2"],
      created_by: "po-1",
      created_at: "2026-03-18"
    },
    {
      id: "STORY-4",
      type: "BUG_FIX",
      epic_id: "EPIC-3",
      title: "Fix: workflow status diverges between user-facing and operator-facing views",
      description: "QC identified a high-impact issue where the visible workflow status does not stay consistent across the main experience and the operational view.",
      acceptance_criteria: [
        "Workflow status remains consistent across all supported views after updates",
        "User-visible confirmations reflect the same final state stored by the system",
        "QC can reproduce the fix and close the defect"
      ],
      severity: "HIGH",
      reported_by: "qc-1",
      reported_date: "2026-03-18",
      status: "READY_FOR_PLANNING",
      story_points: 3,
      assigned_to: null,
      approval_status: "PENDING",
      dependencies: ["STORY-3"],
      created_by: "qc-1",
      created_at: "2026-03-18"
    }
  ],

  backlog_prioritization: {
    method: "MoSCoW",
    description: "Must-have, Should-have, Could-have, Won't-have",
    must_have: [
      "STORY-1: Core workflow completion",
      "STORY-2: Operational visibility",
      "STORY-3: Validation and release readiness",
      "STORY-4: Workflow-status consistency fix"
    ],
    should_have: [
      "Self-service support tooling",
      "Secondary workflow enhancements"
    ],
    could_have: [
      "Automation for low-risk operator tasks",
      "Advanced analytics and experimentation"
    ],
    wont_have_now: [
      "Large workflow rewrites before MVP validation",
      "Complex multi-tenant or multi-region expansion",
      "Nice-to-have automations that do not affect the core workflow"
    ]
  },

  sprint_constraints: {
    sprint_duration_days: 10,
    team_capacity_story_points: 20,
    velocity_buffer_percent: 15,
    team_members: 4,
    available_hours_per_day: 8,
    approval_gate_required: true
  },

  estimation_guide: {
    "1": "Trivial: already understood and nearly done",
    "2": "Tiny: simple and low risk",
    "3": "Small: narrow slice with low uncertainty",
    "5": "Medium: one or two meaningful unknowns",
    "8": "Large: multiple moving parts or notable risk",
    "13": "Very large: should be challenged or split",
    "21": "Too large: break it down before planning"
  },

  definition_of_ready: [
    "Story has a clear title and business outcome",
    "Acceptance criteria are specific and testable",
    "Dependencies and assumptions are identified",
    "Technical feasibility reviewed by DEV",
    "QC scenarios are defined for the highest-risk path",
    "PO has answered the critical open questions",
    "Implementation approval has been granted"
  ],

  field_guide: {
    id: "Unique identifier such as STORY-N or EPIC-N",
    type: "USER_STORY, BUG_FIX, TECHNICAL_DEBT, or SPIKE",
    title: "Story statement describing user value",
    description: "Context and scope detail from the PO or QC",
    acceptance_criteria: "Specific, testable statements for PO acceptance",
    definition_of_done: "Conditions that must be satisfied before PM can close the work",
    po_notes: "Business priority or scope note from the Product Owner",
    technical_notes: "Implementation guidance or risk note from DEV",
    qc_scenarios: "Priority QC scenarios that must be covered",
    approval_status: "PENDING, APPROVED, or REJECTED",
    story_points: "Fibonacci estimate: 1, 2, 3, 5, 8, 13, 21",
    status: "BACKLOG, READY_FOR_PLANNING, IN_SPRINT, IN_PROGRESS, REVIEW, DONE"
  }
};

module.exports = backlogTemplate;

if (require.main === module) {
  console.log(JSON.stringify(backlogTemplate, null, 2));
}
