'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// AMI v1.0 Schema — Enums, Constants, Validation, Computation
// Pure JS (zero dependencies). Aligned with docs/ami-v1-spec.md
// ─────────────────────────────────────────────────────────────────────────────

// ── Enums ────────────────────────────────────────────────────────────────────

const DIMENSION_IDS = [
  'execution_reliability',
  'tooling_integration',
  'safety_guardrails',
  'observability',
  'deployment_maturity',
  'real_world_validation',
];

const DIMENSION_DISPLAY_NAMES = {
  execution_reliability: 'Execution Reliability',
  tooling_integration: 'Tooling & Integration Breadth',
  safety_guardrails: 'Safety & Guardrails',
  observability: 'Observability',
  deployment_maturity: 'Deployment Maturity',
  real_world_validation: 'Real-World Validation',
};

const DIMENSION_WEIGHTS = {
  execution_reliability: 0.20,
  safety_guardrails: 0.20,
  tooling_integration: 0.15,
  observability: 0.15,
  deployment_maturity: 0.15,
  real_world_validation: 0.15,
};

const CONFIDENCE_LEVELS = ['verified', 'inferred', 'unverified'];
const OVERALL_CONFIDENCE_LEVELS = ['high', 'medium', 'low'];
const AMI_GRADES = ['A', 'B', 'C', 'D', 'F'];

const SYSTEM_STATUSES = [
  'scored',
  'insufficient_evidence',
  'inactive',
  'excluded',
  'under_review',
];

const SYSTEM_CATEGORIES = [
  'cloud_autonomous',
  'cloud_workflow',
  'local_autonomous',
  'enterprise',
  'vertical_agent',
];

const EVIDENCE_TYPES = [
  'official_docs',
  'source_code',
  'security_audit',
  'incident_report',
  'changelog',
  'independent_analysis',
  'case_study',
  'compliance',
  'community_metrics',
  'news_report',
];

const SOURCE_TIERS = ['T1', 'T2', 'T3'];

const SOURCE_ACCESS = ['public', 'private'];

const SOURCE_TYPES = [
  'url', 'doc', 'commit', 'issue', 'log', 'metric',
  'screenshot', 'video', 'dataset', 'other',
];

const SOURCE_RELIABILITY = ['primary', 'secondary', 'self_reported'];

const REVIEW_STATES = ['draft', 'reviewed', 'published'];

// ── Grade Mapping ────────────────────────────────────────────────────────────

function scoreToGrade(score) {
  if (score == null) return null;
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}

// ── Confidence Computation (spec Section C) ──────────────────────────────────

function computeOverallConfidence(dimensions) {
  const scored = dimensions.filter((d) => d.scored && d.score != null);
  if (scored.length === 0) return 'low';

  const confidences = scored.map((d) => d.confidence);
  if (confidences.every((c) => c === 'verified')) return 'high';
  if (confidences.some((c) => c === 'unverified')) return 'low';
  return 'medium';
}

// ── Aggregation (spec Section C) ─────────────────────────────────────────────
// AMI = round( SUM(score_i * weight_i) / SUM(5 * weight_i) * 100 )
// When dimensions are not_scored: renormalize weights among scored dimensions.

function computeAggregation(dimensions) {
  const scored = dimensions.filter((d) => d.scored && d.score != null);

  if (scored.length === 0) {
    return {
      scored_count: 0,
      not_scored_count: dimensions.length,
      renormalized_weights: {},
      raw_weighted_sum: 0,
      max_possible_weighted: 0,
      score_percent: null,
      grade: null,
    };
  }

  // Sum weights of scored dimensions
  const totalScoredWeight = scored.reduce((sum, d) => sum + (DIMENSION_WEIGHTS[d.dimension_id] || 0), 0);

  // Renormalize: each scored dimension's effective weight = original_weight / totalScoredWeight
  const renormalized = {};
  for (const d of scored) {
    renormalized[d.dimension_id] = DIMENSION_WEIGHTS[d.dimension_id] / totalScoredWeight;
  }

  // Compute: AMI = round( SUM(score_i * renorm_weight_i) / 5 * 100 )
  const rawWeightedSum = scored.reduce((sum, d) => sum + d.score * renormalized[d.dimension_id], 0);
  const maxPossibleWeighted = 5; // max score per dimension
  const scorePercent = Math.round((rawWeightedSum / maxPossibleWeighted) * 100);

  return {
    scored_count: scored.length,
    not_scored_count: dimensions.length - scored.length,
    renormalized_weights: renormalized,
    raw_weighted_sum: rawWeightedSum,
    max_possible_weighted: maxPossibleWeighted,
    score_percent: scorePercent,
    grade: scoreToGrade(scorePercent),
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

function isISODate(str) {
  if (typeof str !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/.test(str);
}

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

function countWords(str) {
  if (!str) return 0;
  return str.trim().split(/\s+/).length;
}

/**
 * Validate a single EvidenceItem. Returns array of error strings.
 */
function validateEvidenceItem(ev, idx) {
  const errors = [];
  const prefix = `evidence[${idx}] (${ev?.id || 'unknown'})`;

  if (!isNonEmptyString(ev?.id)) errors.push(`${prefix}: missing or empty id`);
  if (!isNonEmptyString(ev?.source_id)) errors.push(`${prefix}: missing source_id`);
  if (!isNonEmptyString(ev?.url)) errors.push(`${prefix}: missing url`);
  if (!isNonEmptyString(ev?.title)) errors.push(`${prefix}: missing title`);
  if (!isNonEmptyString(ev?.publisher)) errors.push(`${prefix}: missing publisher`);
  if (!isISODate(ev?.published_date)) errors.push(`${prefix}: invalid published_date`);
  if (!isNonEmptyString(ev?.excerpt)) {
    errors.push(`${prefix}: missing excerpt`);
  } else if (countWords(ev.excerpt) > 25) {
    errors.push(`${prefix}: excerpt exceeds 25 words (${countWords(ev.excerpt)})`);
  }
  if (!isNonEmptyString(ev?.claim_supported)) errors.push(`${prefix}: missing claim_supported`);
  if (!EVIDENCE_TYPES.includes(ev?.evidence_type)) {
    errors.push(`${prefix}: invalid evidence_type "${ev?.evidence_type}"`);
  }
  if (!CONFIDENCE_LEVELS.includes(ev?.confidence_contribution)) {
    errors.push(`${prefix}: invalid confidence_contribution "${ev?.confidence_contribution}"`);
  }
  if (typeof ev?.relevance_weight !== 'number' || ev.relevance_weight < 0 || ev.relevance_weight > 1) {
    errors.push(`${prefix}: relevance_weight must be 0.0-1.0`);
  }
  if (!isISODate(ev?.captured_at)) errors.push(`${prefix}: invalid captured_at`);

  return errors;
}

/**
 * Validate a single AmiDimensionScore. Returns array of error strings.
 */
function validateDimensionScore(dim, evidenceMap) {
  const errors = [];
  const prefix = `dimension "${dim?.dimension_id}"`;

  if (!DIMENSION_IDS.includes(dim?.dimension_id)) {
    errors.push(`${prefix}: invalid dimension_id`);
    return errors; // can't validate further
  }

  // Check display name
  if (dim.dimension_name !== DIMENSION_DISPLAY_NAMES[dim.dimension_id]) {
    errors.push(`${prefix}: dimension_name should be "${DIMENSION_DISPLAY_NAMES[dim.dimension_id]}"`);
  }

  // Check weight
  const expectedWeight = DIMENSION_WEIGHTS[dim.dimension_id];
  if (typeof dim.weight !== 'number' || Math.abs(dim.weight - expectedWeight) > 0.001) {
    errors.push(`${prefix}: weight should be ${expectedWeight}, got ${dim.weight}`);
  }

  if (dim.scored) {
    // ── SCORED DIMENSION ──
    if (dim.score == null || !Number.isInteger(dim.score) || dim.score < 0 || dim.score > 5) {
      errors.push(`${prefix}: scored=true but score is not integer 0-5 (got ${dim.score})`);
    }

    // GATE 1: No dimension score without evidence
    if (!Array.isArray(dim.evidence) || dim.evidence.length === 0) {
      errors.push(`${prefix}: GATE VIOLATION — scored dimension has no evidence items`);
    }

    // GATE 2: Evidence must have source_id (>= 1 source)
    if (Array.isArray(dim.evidence)) {
      for (let i = 0; i < dim.evidence.length; i++) {
        if (!isNonEmptyString(dim.evidence[i]?.source_id)) {
          errors.push(`${prefix}: GATE VIOLATION — evidence[${i}] has no source_id`);
        }
      }
    }

    // GATE 3: Confidence must be present
    if (!CONFIDENCE_LEVELS.includes(dim.confidence)) {
      errors.push(`${prefix}: GATE VIOLATION — scored dimension missing valid confidence`);
    }

    // Rationale required for scored dimensions
    if (!isNonEmptyString(dim.rationale)) {
      errors.push(`${prefix}: scored dimension missing rationale`);
    }

    // Validate each evidence item inline
    if (Array.isArray(dim.evidence)) {
      for (let i = 0; i < dim.evidence.length; i++) {
        errors.push(...validateEvidenceItem(dim.evidence[i], i));
      }
    }
  } else {
    // ── NOT SCORED DIMENSION ──
    if (dim.score != null) {
      errors.push(`${prefix}: scored=false but score is not null`);
    }
    if (!isNonEmptyString(dim.not_scored_reason)) {
      errors.push(`${prefix}: not_scored dimension missing not_scored_reason`);
    }
  }

  return errors;
}

/**
 * Validate eligibility fields on an assessment.
 */
function validateEligibility(elig, status) {
  const errors = [];
  if (!elig) {
    errors.push('missing eligibility object');
    return errors;
  }

  if (typeof elig.agent_system !== 'boolean') errors.push('eligibility.agent_system must be boolean');
  if (typeof elig.public_artifact !== 'boolean') errors.push('eligibility.public_artifact must be boolean');
  if (typeof elig.active_development !== 'boolean') errors.push('eligibility.active_development must be boolean');
  if (typeof elig.maintainer_identifiable !== 'boolean') errors.push('eligibility.maintainer_identifiable must be boolean');
  if (typeof elig.verified_sources_count !== 'number') {
    errors.push('eligibility.verified_sources_count must be a number');
  }

  // For SCORED status, enforce inclusion criteria
  if (status === 'scored') {
    if (!elig.agent_system) errors.push('SCORED status requires agent_system=true');
    if (!elig.public_artifact) errors.push('SCORED status requires public_artifact=true');
    if (!elig.active_development) errors.push('SCORED status requires active_development=true');
    if (!elig.maintainer_identifiable) errors.push('SCORED status requires maintainer_identifiable=true');
    if (elig.verified_sources_count < 3) {
      errors.push(`SCORED status requires verified_sources_count >= 3 (got ${elig.verified_sources_count})`);
    }
  }

  // Exclusion criteria
  if (elig.exclusion_flags) {
    const flags = elig.exclusion_flags;
    if (status === 'scored') {
      if (flags.base_llm_only) errors.push('SCORED but exclusion_flags.base_llm_only is true');
      if (flags.prompt_library_only) errors.push('SCORED but exclusion_flags.prompt_library_only is true');
      if (flags.research_prototype_only) errors.push('SCORED but exclusion_flags.research_prototype_only is true');
      if (flags.wrapper_only) errors.push('SCORED but exclusion_flags.wrapper_only is true');
    }
  }

  return errors;
}

/**
 * Validate a full AmiAssessment object.
 * Returns { valid: boolean, errors: string[] }
 */
function validateAssessment(assessment) {
  const errors = [];

  // ── Top-level fields ──
  if (!isNonEmptyString(assessment?.assessment_id)) errors.push('missing assessment_id');
  if (!isNonEmptyString(assessment?.system_id)) errors.push('missing system_id');
  if (!Number.isInteger(assessment?.version) || assessment.version < 1) {
    errors.push('version must be a positive integer');
  }
  if (!isISODate(assessment?.assessed_at)) errors.push('invalid assessed_at');
  if (!isNonEmptyString(assessment?.methodology_version)) errors.push('missing methodology_version');
  if (!isNonEmptyString(assessment?.assessed_by)) errors.push('missing assessed_by');

  // Status
  if (!SYSTEM_STATUSES.includes(assessment?.status)) {
    errors.push(`invalid status "${assessment?.status}"`);
    return { valid: false, errors }; // can't continue
  }

  // Category
  if (!SYSTEM_CATEGORIES.includes(assessment?.category)) {
    errors.push(`invalid category "${assessment?.category}"`);
  }

  // ── Eligibility ──
  errors.push(...validateEligibility(assessment?.eligibility, assessment?.status));

  // ── Dimensions ──
  if (!Array.isArray(assessment?.dimensions) || assessment.dimensions.length !== 6) {
    errors.push(`dimensions must be an array of exactly 6 items (got ${assessment?.dimensions?.length})`);
    return { valid: false, errors };
  }

  // Check all 6 dimension IDs present
  const presentIds = new Set(assessment.dimensions.map((d) => d.dimension_id));
  for (const id of DIMENSION_IDS) {
    if (!presentIds.has(id)) errors.push(`missing dimension: ${id}`);
  }

  // Build evidence map for cross-reference
  const evidenceMap = new Map();
  for (const dim of assessment.dimensions) {
    if (Array.isArray(dim.evidence)) {
      for (const ev of dim.evidence) {
        evidenceMap.set(ev.id, ev);
      }
    }
  }

  // Validate each dimension
  for (const dim of assessment.dimensions) {
    errors.push(...validateDimensionScore(dim, evidenceMap));
  }

  // ── Aggregation verification (GATE 4) ──
  if (assessment.status === 'scored') {
    const scoredDims = assessment.dimensions.filter((d) => d.scored && d.score != null);
    const notScoredCount = assessment.dimensions.filter((d) => !d.scored || d.score == null).length;

    // Systems with >= 3 not_scored dimensions cannot be SCORED
    if (notScoredCount >= 3) {
      errors.push(`GATE VIOLATION — ${notScoredCount} dimensions not scored; status cannot be "scored" (max 2 allowed)`);
    }

    // Verify aggregation math
    const computed = computeAggregation(assessment.dimensions);

    if (assessment.overall_score != null && computed.score_percent != null) {
      if (assessment.overall_score !== computed.score_percent) {
        errors.push(
          `GATE VIOLATION — stored overall_score (${assessment.overall_score}) ` +
          `does not match computed (${computed.score_percent}). ` +
          `Raw weighted sum: ${computed.raw_weighted_sum.toFixed(4)}`
        );
      }
    }

    if (assessment.grade != null && computed.grade != null) {
      if (assessment.grade !== computed.grade) {
        errors.push(
          `grade mismatch: stored "${assessment.grade}" vs computed "${computed.grade}"`
        );
      }
    }

    // Verify overall confidence
    const computedConfidence = computeOverallConfidence(assessment.dimensions);
    if (assessment.overall_confidence !== computedConfidence) {
      errors.push(
        `overall_confidence mismatch: stored "${assessment.overall_confidence}" ` +
        `vs computed "${computedConfidence}"`
      );
    }

    // GATE 3 (overall): confidence must be present for SCORED
    if (!OVERALL_CONFIDENCE_LEVELS.includes(assessment?.overall_confidence)) {
      errors.push('GATE VIOLATION — SCORED assessment missing valid overall_confidence');
    }
  } else {
    // Non-scored: overall_score should be null
    if (assessment.overall_score != null) {
      errors.push(`status is "${assessment.status}" but overall_score is not null`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  DIMENSION_IDS,
  DIMENSION_DISPLAY_NAMES,
  DIMENSION_WEIGHTS,
  CONFIDENCE_LEVELS,
  OVERALL_CONFIDENCE_LEVELS,
  AMI_GRADES,
  SYSTEM_STATUSES,
  SYSTEM_CATEGORIES,
  EVIDENCE_TYPES,
  SOURCE_TIERS,
  SOURCE_ACCESS,
  SOURCE_TYPES,
  SOURCE_RELIABILITY,
  REVIEW_STATES,

  // Functions
  scoreToGrade,
  computeOverallConfidence,
  computeAggregation,
  validateAssessment,
  validateEvidenceItem,
  validateDimensionScore,
  validateEligibility,
};
