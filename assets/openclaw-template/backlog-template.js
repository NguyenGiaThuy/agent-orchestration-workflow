#!/usr/bin/env node

/**
 * Backlog template for the PM/PO/DEV/QC workflow.
 * Use this as a starting point for a new root-level project docs/backlog.json file.
 */

const backlogTemplate = {
  project_id: "ecommerce-app",
  workflow_status: "READY_FOR_APPROVAL",
  approval_status: "PENDING",
  created_at: "2026-03-18",
  version: "2.0",

  epics: [
    {
      id: "EPIC-1",
      title: "Catalog discovery and merchandising",
      owner: "po",
      priority: "MUST_HAVE",
      description: "Create a product discovery experience that helps shoppers find, compare, and shortlist the right items quickly.",
      acceptance_criteria: [
        "Shoppers can browse catalog categories, search products, and apply core filters",
        "Merchandising priorities and sort rules are explicit",
        "PO can explain why the initial discovery flow is enough for MVP"
      ]
    },
    {
      id: "EPIC-2",
      title: "Cart and checkout conversion",
      owner: "developer",
      priority: "MUST_HAVE",
      description: "Deliver the smallest reliable path from product detail to order placement.",
      acceptance_criteria: [
        "Shoppers can add products to cart and review totals before checkout",
        "Checkout captures address, payment, and order confirmation",
        "DEV can deliver the flow in sprint-sized slices"
      ]
    },
    {
      id: "EPIC-3",
      title: "Post-purchase reliability and quality control",
      owner: "qc",
      priority: "MUST_HAVE",
      description: "Make order accuracy, payment reliability, and support readiness visible from the first release.",
      acceptance_criteria: [
        "Shoppers can view order status and request support or returns",
        "QC scenarios exist for all critical purchase and fulfillment flows",
        "Release readiness cannot be claimed without QC evidence"
      ]
    }
  ],

  stories: [
    {
      id: "STORY-1",
      epic_id: "EPIC-1",
      title: "As a shopper, I want to browse and search the catalog, so that I can discover products quickly.",
      description: "PO defines the minimum catalog taxonomy, search behavior, and filter set needed for the MVP.",
      acceptance_criteria: [
        "Catalog browsing supports category navigation, search, and basic filtering",
        "Product cards show the most important merchandising signals",
        "PO confirms the discovery flow covers the MVP shopping journey"
      ],
      definition_of_done: [
        "Code reviewed by peer",
        "PO acceptance passes",
        "QC onboarding scenarios executed",
        "Documentation updated in docs/"
      ],
      po_notes: "MUST_HAVE for shopper activation.",
      technical_notes: "Keep search and category APIs modular so ranking and personalization can evolve later.",
      qc_scenarios: [
        "Validate search, filter, and category combinations return consistent product sets",
        "Validate merchandising badges and pricing are rendered consistently"
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
      title: "As a shopper, I want accurate product detail pages, so that I can decide whether to add an item to cart.",
      description: "DEV breaks the catalog-to-detail journey into the smallest usable delivery slice.",
      acceptance_criteria: [
        "Product details include price, stock state, delivery estimate, and key product attributes",
        "Inventory and pricing signals remain consistent between list and detail views",
        "DEV documents the detail-page slice and known consistency risks"
      ],
      definition_of_done: [
        "Code reviewed",
        "PO acceptance passes",
        "QC matching scenarios executed",
        "No unresolved sprint blocker remains"
      ],
      po_notes: "MUST_HAVE for informed purchase decisions.",
      technical_notes: "Treat price and stock reads as consistency-sensitive and auditable.",
      qc_scenarios: [
        "Validate price and inventory updates do not drift between search and detail views",
        "Validate unavailable products cannot be added to cart from stale detail pages"
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
      title: "As a shopper, I want to complete checkout reliably, so that I can place an order with confidence.",
      description: "QC and DEV align on cart, payment, and confirmation boundaries before the checkout flow is released.",
      acceptance_criteria: [
        "Cart totals, discounts, shipping, and taxes are calculated consistently",
        "Checkout captures shipping, payment, and order confirmation without data loss",
        "QC confirms the critical checkout scenarios are covered before release"
      ],
      definition_of_done: [
        "Code reviewed",
        "PO confirms the user flow",
        "QC messaging scenarios executed or automated",
        "Release risks documented"
      ],
      po_notes: "MUST_HAVE for core revenue capture.",
      technical_notes: "Use idempotent order placement and payment handoff so retries do not create duplicate orders.",
      qc_scenarios: [
        "Validate payment failures do not create confirmed orders",
        "Validate cart totals remain stable from review screen through confirmation"
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
      title: "Fix: cart totals diverge after a promotion is applied at checkout",
      description: "QC identified a revenue-impacting issue where the checkout summary does not match the cart review total after a promotion is applied.",
      acceptance_criteria: [
        "Cart and checkout totals match after promotions are applied",
        "Order confirmation reflects the same final amount captured at payment time",
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
      "STORY-1: Catalog discovery and search",
      "STORY-2: Product detail integrity",
      "STORY-3: Checkout reliability",
      "STORY-4: Promotion-total consistency fix"
    ],
    should_have: [
      "Order tracking and self-service support",
      "Saved carts or wishlists"
    ],
    could_have: [
      "Personalized recommendations",
      "Advanced merchandising experiments"
    ],
    wont_have_now: [
      "Third-party seller marketplace management",
      "Complex financing or buy-now-pay-later flows",
      "Multi-region launch support"
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
