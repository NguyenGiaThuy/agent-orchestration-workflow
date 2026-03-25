const DEFAULT_DISCOVERY_PROFILE = Object.freeze({
  business_goals: [
    'Define a focused MVP that can be validated with real users.',
    'Create an implementation-ready backlog with explicit approval gates.',
    'Establish QC coverage before development starts.'
  ],
  core_capabilities: [
    'User-facing product flows',
    'Core business logic and data model',
    'Operational visibility and exception handling'
  ],
  personas: [
    'Primary end user',
    'Internal business operator',
    'QC or support reviewer'
  ],
  assumptions: [
    'The first release should optimize for clarity over breadth.',
    'A single active project is managed at a time through the OpenClaw workflow.',
    'Discord is the default daily reporting channel.'
  ],
  openQuestions: [
    'Who is the highest-priority user segment for the MVP?',
    'What non-functional targets matter most for launch?',
    'Which integrations are mandatory in phase one?'
  ],
  technical_direction: [
    'Separate product, delivery, and QC artifacts by design.',
    'Keep the architecture deployable in small vertical slices.',
    'Track workflow state in docs so PM can pause and resume cleanly.'
  ],
  qc_focus: [
    'Critical path scenarios',
    'Validation of business rules',
    'Release readiness and regression coverage'
  ]
});

const DISCOVERY_PROFILE_TEMPLATES = Object.freeze([]);

function normalizeIdea(input) {
  return String(input || '').trim().toLowerCase();
}

function matchesTemplate(idea, template) {
  const normalizedIdea = normalizeIdea(idea);
  const keywords = Array.isArray(template && template.keywords) ? template.keywords : [];
  return keywords.some(keyword => normalizedIdea.includes(String(keyword || '').toLowerCase()));
}

function resolveDiscoveryProfileTemplate(idea) {
  return DISCOVERY_PROFILE_TEMPLATES.find(template => matchesTemplate(idea, template)) || null;
}

function resolveProjectName(template, idea, fallbackProjectName) {
  const projectNameConfig = template && template.project_name ? template.project_name : {};
  const variants = Array.isArray(projectNameConfig.variants) ? projectNameConfig.variants : [];
  const normalizedIdea = normalizeIdea(idea);
  const matchedVariant = variants.find(variant => normalizedIdea.includes(String(variant.keyword || '').toLowerCase()));

  if (matchedVariant && matchedVariant.value) {
    return matchedVariant.value;
  }

  return projectNameConfig.default || fallbackProjectName;
}

function buildDiscoveryProfileFromTemplate(template, idea, fallbackProjectName) {
  return {
    projectName: resolveProjectName(template, idea, fallbackProjectName),
    problem_statement: template.problem_statement,
    business_goals: [...template.business_goals],
    core_capabilities: [...template.core_capabilities],
    personas: [...template.personas],
    assumptions: [...template.assumptions],
    openQuestions: [...template.openQuestions],
    technical_direction: [...template.technical_direction],
    qc_focus: [...template.qc_focus]
  };
}

module.exports = {
  DEFAULT_DISCOVERY_PROFILE,
  DISCOVERY_PROFILE_TEMPLATES,
  resolveDiscoveryProfileTemplate,
  buildDiscoveryProfileFromTemplate
};