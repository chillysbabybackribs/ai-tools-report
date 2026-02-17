# AMI Hardening Pass — Design Document

**Date:** 2026-02-17
**Status:** Approved
**Scope:** Source catalog enrichment, spec hash locking, anti-inflation QA gates, assessment integrity hash, publish gating

---

## Problem

AMI v1.0 validation enforces structural correctness (gates 1-4) but lacks:
- Resolvable source references (evidence `source_id` is a FK but catalog schema is minimal)
- Spec immutability guarantee (spec can drift without version bump)
- Score inflation defense (a dimension can score 5/5 with a single self-reported source)
- Tamper detection (no integrity hash on assessment JSON)
- Draft/publish lifecycle (all assessments are immediately public)

## Design

### A. Source Catalog Enhancement

**Location:** `data/source-catalog.json` (existing, enriched in-place). Symlink at `data/ami/source-catalog.json` for AMI code locality.

**SourceEntry schema:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| source_id | string | yes | e.g. "SRC_001" |
| title | string | yes | |
| url | string | yes | primary locator |
| type | enum | yes | url, doc, commit, issue, log, metric, screenshot, video, dataset, other |
| publisher | string | no | |
| published_date | ISO string | yes | existing field |
| captured_at | ISO string | no | when evidence was captured |
| hash | string | no | content hash for reproducibility |
| access | enum | yes | public, private |
| reliability | enum | no | primary, secondary, self_reported |
| tier | enum | yes | T1, T2, T3 (kept for backward compat) |

**Evidence schema change:**
- Add `source_ids: string[]` (min 1) as canonical field
- Legacy `source_id: string` accepted in validation, auto-normalized to `source_ids: [source_id]`
- New assessments must use `source_ids`
- Validation cross-references every ID in `source_ids` against catalog

### B. Spec Hash Contract

- `scripts/hash-spec.js` computes SHA-256 of `docs/ami-v1-spec.md`
- `data/ami/meta.json` gains `spec_hash` field
- `validate-ami.js` recomputes spec hash:
  - If hash differs AND `ami_version` unchanged: **FAIL**
  - If `ami_version` changed: warn that `spec_hash` must be updated in meta.json

### C. Anti-Inflation QA Gates

Added to `schema.js validateAssessment()` after existing gates 1-4:

| Gate | Rule | Trigger |
|------|------|---------|
| GATE 5 | Dimension score >= 4 requires >= 2 distinct source_ids in that dimension's evidence | Per-dimension |
| GATE 6 | Dimension score == 5 requires >= 1 source with reliability=primary OR type in {commit, log, metric} | Per-dimension, checks catalog |
| GATE 7 | SCORED assessment requires >= 3 distinct source_ids across all evidence | Assessment-wide |

Gate 6 requires the source catalog to be passed into validation. `validateAssessment()` gains an optional `sourceCatalog` parameter (map of source_id -> SourceEntry). When provided, gate 6 is enforced. When absent (e.g. lightweight client-side checks), gate 6 is skipped with a warning.

### D. Integrity Hash

**Schema:** `assessment.integrity = { assessment_hash, hash_algorithm, hashed_at }`

**Canonicalization:**
1. Deep-clone the assessment object
2. Delete the `integrity` key
3. Recursively sort all object keys
4. `JSON.stringify()` with no indentation
5. SHA-256 of the resulting string

**Enforcement:**
- `validate-ami.js` recomputes hash and fails on mismatch
- POST API and `new-ami-assessment.js` auto-compute after all fields set
- `store.js` gains `computeIntegrityHash(assessment)` helper

### E. Publish Gating

**Schema:** `assessment.review = { state, reviewed_by, reviewed_at }`

| state | Meaning |
|-------|---------|
| draft | New assessment, not yet reviewed |
| reviewed | Reviewed but not published |
| published | Visible in public API index |

**API behavior:**
- `GET /api/ami` returns only `published` by default
- `?include=draft` or `?include=all` requires `x-internal-token` auth
- `GET /api/ami/:assessmentId` returns any state (direct lookup)
- `GET /api/systems/:id/ami` returns all states (internal view)
- POST creates with `state: "draft"` always

### Migration

`scripts/migrate-ami-sourceid-to-sourceids.js`:
1. Convert `evidence.source_id` -> `evidence.source_ids: [source_id]` in all assessments
2. Enrich `data/source-catalog.json` entries with new fields (type, access, reliability defaults based on existing data)
3. Add `review: { state: "published", reviewed_by: null, reviewed_at: null }` to existing assessments
4. Recompute and set `integrity` block on each assessment
5. Update `data/ami/latest/` materialized files
6. Revalidate all assessments

## Files

**New:**
- `scripts/hash-spec.js`
- `scripts/migrate-ami-sourceid-to-sourceids.js`
- `data/ami/source-catalog.json` (symlink -> `../../data/source-catalog.json`)

**Modified:**
- `data/source-catalog.json` — enriched schema
- `data/ami/meta.json` — add spec_hash
- `data/ami/assessments/openclaw/...` — source_ids, review, integrity
- `data/ami/latest/openclaw.json` — same
- `data/ami/templates/ami-assessment-template.v1.0.0.json` — review, integrity placeholders
- `lib/ami/schema.js` — gates 5-7, source_ids, integrity, review validation, catalog param
- `lib/ami/schema.d.ts` — updated types
- `lib/ami/store.js` — computeIntegrityHash helper
- `api/ami.js` — publish gating
- `api/systems/[id]/ami.js` — POST sets draft, computes integrity
- `scripts/validate-ami.js` — spec hash, integrity, anti-inflation via schema
- `scripts/new-ami-assessment.js` — review block, integrity
