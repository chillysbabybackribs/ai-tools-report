# AMI Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden AMI with source catalog enrichment, spec hash locking, anti-inflation QA gates, integrity hashing, and publish gating.

**Architecture:** Extend the existing zero-dependency CommonJS AMI library (`lib/ami/`) with new validation gates, integrity computation, and review state. Enrich the flat-file JSON data layer. All changes are backward-compatible — the migration script handles existing data.

**Tech Stack:** Node.js (CommonJS, zero npm deps), JSON flat-file storage, Vercel serverless functions.

---

### Task 1: Integrity hash helper in store.js

Add `canonicalize(obj)` and `computeIntegrityHash(assessment)` to `lib/ami/store.js`. These are pure functions with no side effects and will be used by tasks 2-7.

**Files:**
- Modify: `lib/ami/store.js` (add after line 56, before "Public API" section)

**Step 1: Add canonicalize and computeIntegrityHash functions**

Insert after line 56 (after `writeJsonAtomic`) and before the "Public API" comment on line 58:

```javascript
// ── Integrity hashing ────────────────────────────────────────────────────────

/**
 * Recursively sort all object keys for deterministic JSON.
 */
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}

/**
 * Compute SHA-256 integrity hash of an assessment.
 * Excludes the `integrity` block itself from the hash input.
 * Returns { assessment_hash, hash_algorithm, hashed_at }.
 */
function computeIntegrityHash(assessment) {
  const clone = JSON.parse(JSON.stringify(assessment));
  delete clone.integrity;
  const canonical = JSON.stringify(canonicalize(clone));
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    assessment_hash: hash,
    hash_algorithm: 'sha256',
    hashed_at: new Date().toISOString(),
  };
}
```

**Step 2: Export the new functions**

In the `module.exports` block at the bottom of `store.js`, add after `readJsonFile`:

```javascript
  canonicalize,
  computeIntegrityHash,
```

**Step 3: Verify no syntax errors**

Run: `node -e "require('./lib/ami/store.js'); console.log('OK')"`
Expected: `OK`

**Step 4: Smoke-test the hash function**

Run:
```bash
node -e "
const s = require('./lib/ami/store.js');
const h = s.computeIntegrityHash({ system_id: 'test', version: 1, integrity: { old: true } });
console.log(h.assessment_hash.length === 64 ? 'PASS' : 'FAIL');
console.log(h.hash_algorithm === 'sha256' ? 'PASS' : 'FAIL');
"
```
Expected: `PASS` twice.

**Step 5: Commit**

```bash
git add lib/ami/store.js
git commit -m "feat(ami): add canonicalize + computeIntegrityHash to store"
```

---

### Task 2: Enrich source catalog schema + constants

Update `data/source-catalog.json` with new fields per source entry. Add `SOURCE_TYPES` and `SOURCE_RELIABILITY` constants to `lib/ami/schema.js`.

**Files:**
- Modify: `lib/ami/schema.js` (add constants after line 72)
- Modify: `data/source-catalog.json` (enrich all 10 entries)

**Step 1: Add SOURCE_TYPES and SOURCE_RELIABILITY to schema.js**

After line 72 (`const SOURCE_ACCESS = ['public', 'private'];`), add:

```javascript
const SOURCE_TYPES = [
  'url', 'doc', 'commit', 'issue', 'log', 'metric',
  'screenshot', 'video', 'dataset', 'other',
];

const SOURCE_RELIABILITY = ['primary', 'secondary', 'self_reported'];

const REVIEW_STATES = ['draft', 'reviewed', 'published'];
```

**Step 2: Export the new constants**

In the `module.exports` block, add after `SOURCE_ACCESS`:

```javascript
  SOURCE_TYPES,
  SOURCE_RELIABILITY,
  REVIEW_STATES,
```

**Step 3: Enrich data/source-catalog.json**

Replace the full file content. Each source entry gains: `type`, `publisher`, `access`, `reliability`, `captured_at`, `hash` (null for now). Derive `type` and `reliability` from existing data:

- SRC_001 (Reuters news) → type: "url", reliability: "secondary", publisher: "Reuters"
- SRC_002 (Anthropic blog) → type: "url", reliability: "primary", publisher: "Anthropic"
- SRC_003 (Kaspersky blog) → type: "url", reliability: "primary", publisher: "Kaspersky"
- SRC_004 (SecurityScorecard) → type: "url", reliability: "primary", publisher: "SecurityScorecard"
- SRC_005 (Anthropic MCP) → type: "url", reliability: "primary", publisher: "Anthropic"
- SRC_006 (LangChain docs) → type: "doc", reliability: "primary", publisher: "LangChain"
- SRC_007 (CrewAI GitHub) → type: "commit", reliability: "primary", publisher: "CrewAI"
- SRC_008 (n8n docs) → type: "doc", reliability: "primary", publisher: "n8n"
- SRC_009 (OpenClaw GitHub) → type: "commit", reliability: "primary", publisher: "OpenClaw Foundation"
- SRC_010 (Anthropic docs) → type: "doc", reliability: "primary", publisher: "Anthropic"

All get `access: "public"`, `captured_at: null`, `hash: null`.

**Step 4: Verify schema.js loads**

Run: `node -e "const s = require('./lib/ami/schema.js'); console.log(s.SOURCE_TYPES.length, s.SOURCE_RELIABILITY.length, s.REVIEW_STATES.length)"`
Expected: `10 3 3`

**Step 5: Verify source-catalog.json is valid JSON**

Run: `node -e "const c = require('./data/source-catalog.json'); console.log(c.sources.length, c.sources[0].type, c.sources[0].reliability)"`
Expected: `10 url secondary`

**Step 6: Commit**

```bash
git add lib/ami/schema.js data/source-catalog.json
git commit -m "feat(ami): enrich source catalog schema + add SOURCE_TYPES/RELIABILITY/REVIEW_STATES constants"
```

---

### Task 3: Update schema.js validation — source_ids, review, integrity, anti-inflation gates

This is the core task. Modify `validateEvidenceItem()`, `validateDimensionScore()`, and `validateAssessment()` to support:
- `source_ids` (with backward-compat `source_id` normalization)
- `review` block validation
- `integrity` hash verification
- Gates 5, 6, 7

**Files:**
- Modify: `lib/ami/schema.js`

**Step 1: Update validateEvidenceItem to support source_ids**

In `validateEvidenceItem()` (line 160-188), replace the `source_id` check on line 165:

Old (line 165):
```javascript
  if (!isNonEmptyString(ev?.source_id)) errors.push(`${prefix}: missing source_id`);
```

New:
```javascript
  // source_ids is canonical; source_id accepted for backward compat
  const sourceIds = ev?.source_ids || (ev?.source_id ? [ev.source_id] : null);
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    errors.push(`${prefix}: missing source_ids (or legacy source_id)`);
  } else {
    for (const sid of sourceIds) {
      if (!isNonEmptyString(sid)) errors.push(`${prefix}: source_ids contains empty value`);
    }
  }
```

**Step 2: Add resolveSourceIds helper**

Add after the `countWords` function (after line 155):

```javascript
/**
 * Resolve source_ids from evidence, supporting legacy source_id fallback.
 * Returns string[] or empty array.
 */
function resolveSourceIds(ev) {
  if (Array.isArray(ev?.source_ids) && ev.source_ids.length > 0) return ev.source_ids;
  if (isNonEmptyString(ev?.source_id)) return [ev.source_id];
  return [];
}
```

**Step 3: Update validateDimensionScore for source_ids and gate 5**

In `validateDimensionScore()`, replace the GATE 2 block (lines 224-231):

Old:
```javascript
    // GATE 2: Evidence must have source_id (>= 1 source)
    if (Array.isArray(dim.evidence)) {
      for (let i = 0; i < dim.evidence.length; i++) {
        if (!isNonEmptyString(dim.evidence[i]?.source_id)) {
          errors.push(`${prefix}: GATE VIOLATION — evidence[${i}] has no source_id`);
        }
      }
    }
```

New:
```javascript
    // GATE 2: Evidence must have source_ids (>= 1 source)
    if (Array.isArray(dim.evidence)) {
      for (let i = 0; i < dim.evidence.length; i++) {
        const sids = resolveSourceIds(dim.evidence[i]);
        if (sids.length === 0) {
          errors.push(`${prefix}: GATE VIOLATION — evidence[${i}] has no source_ids`);
        }
      }
    }

    // GATE 5: score >= 4 requires >= 2 distinct source_ids
    if (dim.score >= 4 && Array.isArray(dim.evidence)) {
      const allSids = new Set();
      for (const ev of dim.evidence) {
        for (const sid of resolveSourceIds(ev)) allSids.add(sid);
      }
      if (allSids.size < 2) {
        errors.push(`${prefix}: GATE VIOLATION — score ${dim.score} requires >= 2 distinct sources (found ${allSids.size})`);
      }
    }
```

**Step 4: Update validateAssessment signature and add gate 6, 7, review, integrity**

Change `validateAssessment` signature from:
```javascript
function validateAssessment(assessment) {
```
to:
```javascript
function validateAssessment(assessment, options) {
  const sourceCatalog = options?.sourceCatalog || null; // Map<source_id, SourceEntry>
```

Then, after the existing aggregation verification block (after line 411, before `return`), add:

```javascript
  // ── GATE 6: score 5 requires primary/commit/log/metric source ──
  if (sourceCatalog && assessment.status === 'scored') {
    for (const dim of assessment.dimensions) {
      if (dim.scored && dim.score === 5 && Array.isArray(dim.evidence)) {
        const allSids = new Set();
        for (const ev of dim.evidence) {
          for (const sid of resolveSourceIds(ev)) allSids.add(sid);
        }
        const hasPrimaryOrHardEvidence = [...allSids].some((sid) => {
          const src = sourceCatalog.get(sid);
          if (!src) return false;
          return src.reliability === 'primary' ||
                 ['commit', 'log', 'metric'].includes(src.type);
        });
        if (!hasPrimaryOrHardEvidence) {
          errors.push(
            `dimension "${dim.dimension_id}": GATE VIOLATION — score 5 requires >= 1 primary or hard-evidence source`
          );
        }
      }
    }
  }

  // ── GATE 7: SCORED assessment requires >= 3 distinct source_ids total ──
  if (assessment.status === 'scored') {
    const allSourceIds = new Set();
    for (const dim of assessment.dimensions) {
      if (Array.isArray(dim.evidence)) {
        for (const ev of dim.evidence) {
          for (const sid of resolveSourceIds(ev)) allSourceIds.add(sid);
        }
      }
    }
    if (allSourceIds.size < 3) {
      errors.push(
        `GATE VIOLATION — SCORED assessment requires >= 3 distinct sources (found ${allSourceIds.size})`
      );
    }
  }

  // ── Review state validation ──
  if (assessment.review) {
    if (!REVIEW_STATES.includes(assessment.review.state)) {
      errors.push(`invalid review.state "${assessment.review.state}"`);
    }
  }

  // ── Integrity hash validation ──
  if (assessment.integrity) {
    if (assessment.integrity.hash_algorithm !== 'sha256') {
      errors.push(`unsupported integrity hash_algorithm "${assessment.integrity.hash_algorithm}"`);
    }
    // Actual hash verification is done by the caller (validate-ami.js / store.js)
    // since it requires the computeIntegrityHash function from store.js
  }
```

**Step 5: Export resolveSourceIds**

Add `resolveSourceIds` to the exports block.

**Step 6: Verify schema.js loads and existing validation still works**

Run:
```bash
node -e "
const schema = require('./lib/ami/schema.js');
console.log(typeof schema.resolveSourceIds === 'function' ? 'PASS' : 'FAIL');
console.log(typeof schema.validateAssessment === 'function' ? 'PASS' : 'FAIL');
"
```
Expected: `PASS` twice.

**Step 7: Commit**

```bash
git add lib/ami/schema.js
git commit -m "feat(ami): add gates 5-7, source_ids support, review/integrity validation to schema"
```

---

### Task 4: Update TypeScript definitions

Update `lib/ami/schema.d.ts` with new types for source catalog, review, integrity, and updated evidence.

**Files:**
- Modify: `lib/ami/schema.d.ts`

**Step 1: Add new types**

After the `SourceTier` type (line 47), add:

```typescript
export type SourceType =
  | 'url' | 'doc' | 'commit' | 'issue' | 'log' | 'metric'
  | 'screenshot' | 'video' | 'dataset' | 'other';

export type SourceReliability = 'primary' | 'secondary' | 'self_reported';

export type SourceAccess = 'public' | 'private';

export type ReviewState = 'draft' | 'reviewed' | 'published';

export interface SourceEntry {
  source_id: string;
  title: string;
  url: string;
  type: SourceType;
  publisher?: string;
  published_date: string;
  captured_at?: string;
  hash?: string;
  access: SourceAccess;
  reliability?: SourceReliability;
  tier: SourceTier;
}

export interface ReviewBlock {
  state: ReviewState;
  reviewed_by?: string;
  reviewed_at?: string;
}

export interface IntegrityBlock {
  assessment_hash: string;
  hash_algorithm: 'sha256';
  hashed_at: string;
}
```

**Step 2: Update EvidenceItem interface**

Add `source_ids` field after `source_id` (line 55):

```typescript
  /** @deprecated Use source_ids instead */
  source_id?: string;
  /** FK(s) to source-catalog.json source_ids */
  source_ids: string[];
```

**Step 3: Update AmiAssessment interface**

Add after `notes` (line 165):

```typescript
  /** Review/publish lifecycle state */
  review?: ReviewBlock;
  /** Integrity hash for tamper detection */
  integrity?: IntegrityBlock;
```

**Step 4: Update exported constants and functions**

Add to the exported constants section:

```typescript
export const SOURCE_TYPES: readonly SourceType[];
export const SOURCE_RELIABILITY: readonly SourceReliability[];
export const REVIEW_STATES: readonly ReviewState[];
```

Add to exported functions:

```typescript
export function resolveSourceIds(ev: EvidenceItem): string[];
```

Update `validateAssessment` signature:

```typescript
export function validateAssessment(
  assessment: AmiAssessment,
  options?: { sourceCatalog?: Map<string, SourceEntry> }
): ValidationResult;
```

**Step 5: Commit**

```bash
git add lib/ami/schema.d.ts
git commit -m "feat(ami): update TypeScript definitions for hardening features"
```

---

### Task 5: Spec hash script + meta.json update

Create `scripts/hash-spec.js` and update `data/ami/meta.json`.

**Files:**
- Create: `scripts/hash-spec.js`
- Modify: `data/ami/meta.json`

**Step 1: Create scripts/hash-spec.js**

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.cwd();
const SPEC_PATH = path.join(ROOT, 'docs', 'ami-v1-spec.md');

function main() {
  if (!fs.existsSync(SPEC_PATH)) {
    console.error(`Spec file not found: ${SPEC_PATH}`);
    process.exit(1);
  }
  const content = fs.readFileSync(SPEC_PATH, 'utf8');
  const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  console.log(hash);
}

main();
```

**Step 2: Update data/ami/meta.json**

Add `spec_hash` field with the current hash value. The current hash of `docs/ami-v1-spec.md` is:

```
e40f86bc6348add440f17abe4cc129555ed40853f2c771d748154b8d5a8d407d
```

Updated meta.json:

```json
{
  "ami_version": "1.0",
  "spec_hash": "e40f86bc6348add440f17abe4cc129555ed40853f2c771d748154b8d5a8d407d",
  "methodology_url": "/methodology",
  "last_updated": "2026-02-17T12:00:00Z",
  "dimensions": [
    { "id": "execution_reliability", "name": "Execution Reliability", "weight": 0.20 },
    { "id": "tooling_integration", "name": "Tooling & Integration Breadth", "weight": 0.15 },
    { "id": "safety_guardrails", "name": "Safety & Guardrails", "weight": 0.20 },
    { "id": "observability", "name": "Observability", "weight": 0.15 },
    { "id": "deployment_maturity", "name": "Deployment Maturity", "weight": 0.15 },
    { "id": "real_world_validation", "name": "Real-World Validation", "weight": 0.15 }
  ],
  "grades": {
    "A": [80, 100],
    "B": [60, 79],
    "C": [40, 59],
    "D": [20, 39],
    "F": [0, 19]
  }
}
```

**Step 3: Verify hash-spec.js works**

Run: `node scripts/hash-spec.js`
Expected: `e40f86bc6348add440f17abe4cc129555ed40853f2c771d748154b8d5a8d407d`

**Step 4: Commit**

```bash
git add scripts/hash-spec.js data/ami/meta.json
git commit -m "feat(ami): add spec hash contract — hash-spec.js + meta.json spec_hash"
```

---

### Task 6: Update validate-ami.js — spec hash, integrity, source_ids, catalog passing

Extend the CI/build validation script with spec hash checking, integrity verification, source_ids cross-referencing, and passing catalog to schema validation.

**Files:**
- Modify: `scripts/validate-ami.js`

**Step 1: Add spec hash verification**

After `loadSourceCatalog()` function (after line 27), add:

```javascript
function verifySpecHash() {
  const metaPath = path.join(ROOT, 'data', 'ami', 'meta.json');
  const specPath = path.join(ROOT, 'docs', 'ami-v1-spec.md');
  if (!fs.existsSync(metaPath) || !fs.existsSync(specPath)) return [];

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (!meta.spec_hash) return []; // no hash to verify yet

  const crypto = require('node:crypto');
  const specContent = fs.readFileSync(specPath, 'utf8');
  const computed = crypto.createHash('sha256').update(specContent, 'utf8').digest('hex');

  if (computed !== meta.spec_hash) {
    return [`Spec hash mismatch: meta.json says "${meta.spec_hash}" but docs/ami-v1-spec.md hashes to "${computed}". Update spec_hash in meta.json or revert spec changes.`];
  }
  return [];
}
```

**Step 2: Add integrity hash verification function**

After `verifySpecHash()`:

```javascript
function verifyIntegrity(assessment, relPath) {
  if (!assessment.integrity) return []; // no integrity block = skip
  const store = require(path.join(ROOT, 'lib', 'ami', 'store.js'));
  const computed = store.computeIntegrityHash(assessment);
  if (computed.assessment_hash !== assessment.integrity.assessment_hash) {
    return [
      `integrity hash mismatch in ${relPath}: stored "${assessment.integrity.assessment_hash}" vs computed "${computed.assessment_hash}"`
    ];
  }
  return [];
}
```

**Step 3: Call spec hash verification in main()**

At the beginning of `main()`, after `const sourceCatalog = loadSourceCatalog();` (line 39), add:

```javascript
    // Spec hash verification
    const specErrors = verifySpecHash();
    if (specErrors.length > 0) {
      allErrors.push({ file: 'data/ami/meta.json', errors: specErrors });
    }
```

(Move `let totalFiles`, `let totalValid`, etc. before this block if needed — they should already be declared above.)

**Step 4: Pass sourceCatalog to validateAssessment**

Change line 70 from:
```javascript
      const result = schema.validateAssessment(assessment);
```
to:
```javascript
      const result = schema.validateAssessment(assessment, { sourceCatalog });
```

**Step 5: Update source cross-referencing to use source_ids**

Replace the source catalog cross-reference block (lines 76-101) with:

```javascript
      // 2. Source catalog cross-reference (source_ids, with source_id fallback)
      if (Array.isArray(assessment.dimensions)) {
        for (const dim of assessment.dimensions) {
          if (Array.isArray(dim.evidence)) {
            for (const ev of dim.evidence) {
              const sids = schema.resolveSourceIds(ev);
              for (const sid of sids) {
                if (sourceCatalog.size > 0 && !sourceCatalog.has(sid)) {
                  fileErrors.push(
                    `evidence "${ev.id}" references source_id "${sid}" not found in source-catalog.json`
                  );
                }
              }
            }

            // Verify T1/T2 requirement for "verified" confidence
            if (dim.scored && dim.confidence === 'verified') {
              const hasT1T2 = dim.evidence.some((ev) => {
                const sids = schema.resolveSourceIds(ev);
                return sids.some((sid) => {
                  const src = sourceCatalog.get(sid);
                  return src && (src.tier === 'T1' || src.tier === 'T2');
                });
              });
              if (sourceCatalog.size > 0 && !hasT1T2) {
                fileErrors.push(
                  `dimension "${dim.dimension_id}" has confidence "verified" but no T1/T2 source found`
                );
              }
            }
          }
        }
      }
```

**Step 6: Add integrity verification call**

After the source cross-reference block, add:

```javascript
      // 3. Integrity hash verification
      fileErrors.push(...verifyIntegrity(assessment, relPath));
```

And renumber existing "3. Verify system_id matches directory" to "4.":

```javascript
      // 4. Verify system_id matches directory
```

**Step 7: Verify validate-ami.js loads without error**

Run: `node -e "require('./scripts/validate-ami.js')"` — note this will actually run since it calls `main()` at the bottom. Instead verify syntax:

Run: `node -c scripts/validate-ami.js`
Expected: no error output

**Step 8: Commit**

```bash
git add scripts/validate-ami.js
git commit -m "feat(ami): validate-ami.js gains spec hash, integrity, source_ids, catalog passing"
```

---

### Task 7: Migration script + data migration

Create `scripts/migrate-ami-sourceid-to-sourceids.js` that:
1. Converts `evidence.source_id` → `evidence.source_ids: [source_id]`
2. Adds `review: { state: "published" }` to existing scored assessments
3. Computes and sets `integrity` block
4. Updates latest/ materialized files

Then run it to migrate the OpenClaw assessment.

**Files:**
- Create: `scripts/migrate-ami-sourceid-to-sourceids.js`

**Step 1: Create the migration script**

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const store = require(path.join(ROOT, 'lib', 'ami', 'store.js'));

function main() {
  const assessmentsBase = path.join(ROOT, 'data', 'ami', 'assessments');
  if (!fs.existsSync(assessmentsBase)) {
    console.log('No assessments directory found. Nothing to migrate.');
    return;
  }

  const systemDirs = fs.readdirSync(assessmentsBase).filter((entry) =>
    fs.statSync(path.join(assessmentsBase, entry)).isDirectory()
  );

  let migrated = 0;

  for (const sysDir of systemDirs) {
    const dirPath = path.join(assessmentsBase, sysDir);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const assessment = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let changed = false;

      // 1. Migrate evidence source_id -> source_ids
      if (Array.isArray(assessment.dimensions)) {
        for (const dim of assessment.dimensions) {
          if (Array.isArray(dim.evidence)) {
            for (const ev of dim.evidence) {
              if (ev.source_id && !ev.source_ids) {
                ev.source_ids = [ev.source_id];
                delete ev.source_id;
                changed = true;
              }
            }
          }
        }
      }

      // 2. Add review block if missing
      if (!assessment.review) {
        assessment.review = {
          state: assessment.status === 'scored' ? 'published' : 'draft',
          reviewed_by: null,
          reviewed_at: null,
        };
        changed = true;
      }

      // 3. Compute integrity hash
      const integrity = store.computeIntegrityHash(assessment);
      assessment.integrity = integrity;
      changed = true;

      if (changed) {
        store.writeJsonAtomic(filePath, assessment);
        migrated++;
        console.log(`Migrated: ${path.relative(ROOT, filePath)}`);

        // Update latest/ if this is the latest version for the system
        const latest = store.getLatestAssessment(sysDir);
        if (latest && latest.assessment_id === assessment.assessment_id) {
          const latestPath = path.join(store.latestDir(), `${sysDir}.json`);
          store.writeJsonAtomic(latestPath, assessment);
          console.log(`Updated latest: ${path.relative(ROOT, latestPath)}`);
        }
      }
    }
  }

  console.log(`\nMigration complete. ${migrated} file(s) migrated.`);
}

main();
```

**Step 2: Run the migration**

Run: `node scripts/migrate-ami-sourceid-to-sourceids.js`
Expected output includes:
```
Migrated: data/ami/assessments/openclaw/AMI_ASSESS_20260217_openclaw_v1.json
Updated latest: data/ami/latest/openclaw.json
Migration complete. 1 file(s) migrated.
```

**Step 3: Verify migrated data**

Run:
```bash
node -e "
const a = require('./data/ami/assessments/openclaw/AMI_ASSESS_20260217_openclaw_v1.json');
const ev = a.dimensions[0].evidence[0];
console.log('source_ids:', ev.source_ids);
console.log('source_id removed:', ev.source_id === undefined);
console.log('review.state:', a.review.state);
console.log('integrity.hash_algorithm:', a.integrity.hash_algorithm);
console.log('integrity.assessment_hash length:', a.integrity.assessment_hash.length);
"
```
Expected:
```
source_ids: [ 'SRC_009' ]
source_id removed: true
review.state: published
integrity.hash_algorithm: sha256
integrity.assessment_hash length: 64
```

**Step 4: Create symlink for AMI code locality**

Run: `ln -sf ../../data/source-catalog.json data/ami/source-catalog.json`

Verify: `ls -la data/ami/source-catalog.json`
Expected: symlink pointing to `../../data/source-catalog.json`

**Step 5: Commit**

```bash
git add scripts/migrate-ami-sourceid-to-sourceids.js data/ami/assessments/ data/ami/latest/ data/ami/source-catalog.json
git commit -m "feat(ami): migration script + migrate openclaw to source_ids/review/integrity"
```

---

### Task 8: Update template with review and integrity placeholders

**Files:**
- Modify: `data/ami/templates/ami-assessment-template.v1.0.0.json`

**Step 1: Add review and integrity blocks to template**

After the `notes` field (line 103), add before the closing `}`:

```json
  "review": {
    "state": "draft",
    "reviewed_by": null,
    "reviewed_at": null
  },
  "integrity": null
```

The `integrity` is null in the template — it gets computed after the assessment is filled in.

**Step 2: Commit**

```bash
git add data/ami/templates/ami-assessment-template.v1.0.0.json
git commit -m "feat(ami): add review + integrity placeholders to assessment template"
```

---

### Task 9: Update api/ami.js — publish gating

**Files:**
- Modify: `api/ami.js`

**Step 1: Add include param handling and publish gating**

After the existing query filters (after the maxScore filter block, around line 58), add:

```javascript
    // Publish gating: default to published only
    const includeParam = q.include || null;
    if (includeParam && !['draft', 'all'].includes(includeParam)) {
      res.status(400).json({ error: 'invalid_parameter', parameter: 'include', valid_values: ['draft', 'all'] });
      return;
    }

    if (includeParam) {
      // Require auth for non-published access
      const { requireAuth } = require(path.join(process.cwd(), 'lib', 'ami', 'api-util.js'));
      if (!requireAuth(req, res)) return;
    }

    // Filter by review state
    if (!includeParam) {
      // Default: only published
      results = results.filter((a) => a.review?.state === 'published' || !a.review);
    } else if (includeParam === 'draft') {
      results = results.filter((a) => a.review?.state === 'draft');
    }
    // includeParam === 'all' → no filtering by review state
```

**Step 2: Verify syntax**

Run: `node -c api/ami.js`
Expected: no error output

**Step 3: Commit**

```bash
git add api/ami.js
git commit -m "feat(ami): api/ami.js publish gating — default to published only"
```

---

### Task 10: Update api/systems/[id]/ami.js — POST sets draft + computes integrity

**Files:**
- Modify: `api/systems/[id]/ami.js`

**Step 1: Add review and integrity to POST handler**

In the POST handler, after the aggregation computation block (after line 113, `body.overall_confidence = ...`), add:

```javascript
      // Set review state to draft for new assessments
      if (!body.review) {
        body.review = { state: 'draft', reviewed_by: null, reviewed_at: null };
      }

      // Compute integrity hash after all fields are set (done after validation below)
```

Then, after the validation check passes but before `store.upsertAssessment(body)` (between lines 123 and 126), add:

```javascript
      // Compute integrity hash (after validation, before storage)
      const storeModule = require(path.join(process.cwd(), 'lib', 'ami', 'store.js'));
      body.integrity = storeModule.computeIntegrityHash(body);
```

**Step 2: Verify syntax**

Run: `node -c api/systems/\\[id\\]/ami.js`
Expected: no error output

**Step 3: Commit**

```bash
git add "api/systems/[id]/ami.js"
git commit -m "feat(ami): POST sets review=draft + computes integrity hash"
```

---

### Task 11: Update new-ami-assessment.js — review block + integrity

**Files:**
- Modify: `scripts/new-ami-assessment.js`

**Step 1: Add review block after template fields**

After `template.category = category;` (line 64), add:

```javascript
  // Set review to draft
  template.review = { state: 'draft', reviewed_by: null, reviewed_at: null };
```

**Step 2: Compute integrity before writing**

Replace the write block (lines 76-78):

Old:
```javascript
  if (!fs.existsSync(assessDir)) fs.mkdirSync(assessDir, { recursive: true });
  const outPath = path.join(assessDir, `${assessmentId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
```

New:
```javascript
  // Compute integrity hash
  const store = require(path.join(ROOT, 'lib', 'ami', 'store.js'));
  template.integrity = store.computeIntegrityHash(template);

  if (!fs.existsSync(assessDir)) fs.mkdirSync(assessDir, { recursive: true });
  const outPath = path.join(assessDir, `${assessmentId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
```

**Step 3: Verify syntax**

Run: `node -c scripts/new-ami-assessment.js`
Expected: no error output

**Step 4: Commit**

```bash
git add scripts/new-ami-assessment.js
git commit -m "feat(ami): new-ami-assessment.js sets review=draft + computes integrity"
```

---

### Task 12: Add validate:ami script to package.json + run full validation

**Files:** (no new modifications — just run validation)

**Step 1: Run full validation**

Run: `npm run validate:ami`

Expected: all assessments valid (exit 0). The OpenClaw assessment should pass with source_ids, review, integrity, and gates 5-7.

**Step 2: If validation fails, fix issues**

Common fixes:
- If gate 5 fails on tooling_integration (score=4, only 1 source SRC_009): the OpenClaw assessment needs a second source for that dimension. Add a second evidence item referencing a different source (e.g. SRC_001 or SRC_005).
- If integrity hash mismatches: rerun migration to recompute hashes.

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(ami): resolve validation issues from hardening gates"
```

---

### Task 13: Final verification + summary commit

**Step 1: List all files changed/created**

Run: `git diff --name-status HEAD~12..HEAD` (or however many commits since task 1)

**Step 2: Verify validate:ami passes**

Run: `npm run validate:ami`
Expected: exit 0, "All assessments valid."

**Step 3: Verify example source entries**

Run:
```bash
node -e "
const c = require('./data/source-catalog.json');
console.log(JSON.stringify(c.sources[0], null, 2));
console.log(JSON.stringify(c.sources[8], null, 2));
"
```

Should show enriched entries with type, publisher, access, reliability fields.

**Step 4: Verify OpenClaw assessment excerpt**

Run:
```bash
node -e "
const a = require('./data/ami/assessments/openclaw/AMI_ASSESS_20260217_openclaw_v1.json');
console.log('source_ids:', a.dimensions[0].evidence[0].source_ids);
console.log('review:', a.review);
console.log('integrity.hash:', a.integrity.assessment_hash.slice(0, 16) + '...');
"
```

Should show source_ids array, review block with state=published, and integrity hash.
