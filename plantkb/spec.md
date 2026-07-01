# Agronomy Disease Pipeline Precision Upgrade Spec

## Objective

Improve the existing agronomy disease pipeline so it produces more precise, thorough, source-traceable, offline-ready JSON documents for Couchbase Lite import.

The upgraded system must preserve deterministic exports while adding:

- Separate handling for healthy crop classes.
- Evidence-backed extracted facts.
- Field-level confidence scoring.
- Conflict detection across sources.
- Stronger agronomy safety validation.
- Better source manifest coverage tracking.
- A clear path for schema-constrained LLM extraction without making tests depend on live model calls.

## Current Baseline

The repository already contains a Python pipeline with:

- `data/seed_index.json` containing 38 crop/class seeds.
- Source JSON fixtures under `data/sources`.
- A deterministic structurer.
- Validation, normalization, merging, confidence scoring, and Couchbase JSON/NDJSON export.
- CLI commands:
  - `python3 -m agronomy_pipeline harvest`
  - `python3 -m agronomy_pipeline run`

Current limitations:

- Healthy classes are exported as empty `disease_profile` documents.
- Source traceability exists only at document level, not per extracted fact.
- Confidence is only an overall score.
- Contradictory source facts are silently resolved by merge priority.
- Treatment validation blocks obvious brand markers but does not enforce evidence or region awareness.
- Source coverage is not auditable per seed.

## Requirements

### 1. Profile Types

The pipeline must support two output document types.

#### Disease Profile

Used for seed rows where `disease != "healthy"`.

Required top-level shape:

```json
{
  "type": "disease_profile",
  "id": "tomato_late_blight",
  "version": 1,
  "crop": "tomato",
  "disease": "late_blight",
  "taxonomy": {},
  "symptoms": [],
  "conditions": {},
  "severity": "",
  "treatment": {},
  "prevention": [],
  "images": [],
  "sources": [],
  "confidence": {},
  "conflicts": [],
  "review": {}
}
```

#### Healthy Profile

Used for seed rows where `disease == "healthy"`.

Required top-level shape:

```json
{
  "type": "healthy_profile",
  "id": "apple_healthy",
  "version": 1,
  "crop": "apple",
  "class": "healthy",
  "visual_traits": [],
  "common_false_positives": [],
  "images": [],
  "sources": [],
  "confidence": {},
  "review": {}
}
```

Healthy profiles must not require pathogen taxonomy, disease conditions, severity, treatment, or prevention.

### 2. Evidence-Backed Facts

Every extracted fact that came from source text must carry evidence metadata.

Use a compact evidence object:

```json
{
  "source_name": "EPPO",
  "source_url": "https://example.org/page",
  "quote": "short source-supported excerpt",
  "field": "symptoms.description"
}
```

Evidence requirements:

- Evidence quotes must be short.
- Evidence must come from the source text used during extraction.
- Unknown values must remain empty rather than inferred.
- The exporter must preserve evidence in JSON output.
- The validator must reject facts with evidence pointing to a missing source.

Recommended fact shapes:

```json
{
  "stage": "early",
  "description": "small dark water-soaked spots on leaves",
  "evidence": []
}
```

```json
{
  "name": "chlorothalonil",
  "evidence": [],
  "regions": []
}
```

For MVP compatibility, treatment values may remain string arrays internally until the schema migration is complete, but the target schema should use evidence-backed objects.

### 3. Source Manifest Coverage

Add or extend a source manifest that maps every seed to expected source coverage.

Target manifest shape:

```json
[
  {
    "crop": "tomato",
    "disease": "late blight",
    "min_authoritative_sources": 2,
    "sources": [
      {
        "name": "EPPO",
        "url": "",
        "authority": "eppo",
        "document_type": "html"
      }
    ]
  }
]
```

Coverage rules:

- Disease profiles should aim for at least 2 authoritative sources.
- Healthy profiles may use dataset metadata, extension guidance, or curated visual trait sources.
- A coverage report must identify seeds with no source documents.
- Missing sources must not block export, but must reduce confidence.

### 4. Field-Level Confidence

Replace or extend the single `confidence.data_quality` score with field-level confidence.

Target shape:

```json
{
  "confidence": {
    "taxonomy": 0.95,
    "symptoms": 0.9,
    "conditions": 0.8,
    "treatment": 0.65,
    "prevention": 0.8,
    "overall": 0.85
  }
}
```

Scoring inputs:

- Source authority.
- Number of independent sources.
- Field completeness.
- Agreement across sources.
- Presence of direct evidence.
- Whether a value is region-specific.

Healthy profiles should use:

```json
{
  "confidence": {
    "visual_traits": 0.0,
    "false_positives": 0.0,
    "overall": 0.0
  }
}
```

### 5. Conflict Detection

The merger must detect conflicts instead of silently discarding contradictions.

Target shape:

```json
{
  "conflicts": [
    {
      "field": "taxonomy.pathogen_type",
      "values": ["fungal", "oomycete"],
      "sources": ["Source A", "Source B"],
      "resolution": "kept_highest_authority"
    }
  ]
}
```

Conflict rules:

- Taxonomy conflicts must be reported.
- Temperature ranges may be merged by expanding range, but materially different ranges should be reported.
- Treatment conflicts should not be resolved into a recommendation unless region rules support it.
- Source-specific facts may be retained if a conflict is region-specific or context-specific.

### 6. Treatment Safety

Treatment extraction must be conservative.

Rules:

- No pesticide brand names.
- No chemical treatment without evidence.
- No generated treatment advice.
- No dosage, interval, or application schedule unless explicitly source-backed and region-specific.
- Chemical treatments should be represented as active ingredients.
- Organic and cultural controls must also include evidence when available.

Recommended target shape:

```json
{
  "treatment": {
    "organic": [],
    "chemical": [],
    "cultural": []
  },
  "region_rules": {
    "US": {
      "chemical": []
    },
    "EU": {
      "chemical": []
    }
  }
}
```

Region rules are optional for the first implementation pass, but the schema should not prevent adding them later.

### 7. Review Metadata

Every exported profile must include review metadata.

```json
{
  "review": {
    "status": "machine_generated",
    "reviewed_by": null,
    "reviewed_at": null
  }
}
```

Allowed statuses:

- `machine_generated`
- `needs_review`
- `expert_reviewed`
- `rejected`

Machine-generated treatment fields should default to `needs_review` if they contain chemical controls.

### 8. Determinism

Exports must be deterministic.

Rules:

- Stable IDs from normalized crop and disease/class names.
- Stable sort order for documents, sources, facts, and evidence.
- Stable JSON formatting.
- No live web calls during tests.
- No live LLM calls during tests.
- Same input files must produce byte-stable NDJSON output.

### 9. Validation

Validation must reject unsafe or malformed data.

Disease profile validation:

- Required fields present.
- `id` matches `crop` and `disease`.
- `type == "disease_profile"`.
- `version` is positive integer.
- `taxonomy.pathogen_type` must be one of:
  - `""`
  - `fungal`
  - `oomycete`
  - `bacterial`
  - `viral`
  - `insect`
  - `mite`
  - `nematode`
  - `abiotic`
- Scientific name must be a string.
- Temperature range must be `[min, max]` with `min <= max`.
- Confidence scores must be between `0.0` and `1.0`.
- Evidence must reference an existing source.
- Chemical treatment objects must not contain brand markers.

Healthy profile validation:

- Required fields present.
- `id` matches `crop + "_healthy"`.
- `type == "healthy_profile"`.
- No disease-only fields required.
- Confidence scores must be between `0.0` and `1.0`.

### 10. CLI Behavior

Existing CLI commands should keep working.

Required commands:

```bash
python3 -m agronomy_pipeline run \
  --seed data/seed_index.json \
  --sources data/sources \
  --out build/couchbase
```

```bash
python3 -m agronomy_pipeline harvest \
  --manifest data/source_manifest.example.json \
  --out data/sources
```

Add a coverage/report command if practical:

```bash
python3 -m agronomy_pipeline report \
  --seed data/seed_index.json \
  --sources data/sources \
  --manifest data/source_manifest.example.json
```

The report should list:

- Total seeds.
- Seeds with at least one source.
- Seeds with zero sources.
- Seeds below minimum source coverage.
- Seeds containing conflicts.

## Constraints

- Do not require network access for tests.
- Do not require an LLM API key for tests.
- Preserve offline-ready Couchbase JSON/NDJSON export.
- Keep the pipeline deterministic.
- Keep generated exports out of git unless explicitly requested.
- Use only Python standard library unless a dependency is clearly justified.
- Avoid broad refactors unrelated to schema precision.
- Do not hallucinate agricultural facts.
- Do not infer pesticide recommendations from disease name alone.
- Treat source data as untrusted input.
- Keep schema migration explicit and tested.

## Architecture

Target modules:

```text
Source Manifest
      |
      v
Harvester
      |
      v
Raw Source JSON
      |
      v
Structurer
      |
      v
Evidence-Backed Partial Profiles
      |
      v
Validator + Normalizer
      |
      v
Merger + Conflict Detector
      |
      v
Confidence Scorer
      |
      v
Couchbase Exporter
      |
      v
NDJSON + per-document JSON
```

### Module Responsibilities

#### `models`

- Define empty disease and healthy profile builders.
- Define validation rules.
- Define source, evidence, conflict, confidence, and review shapes.

#### `ingestion`

- Load seed index.
- Load source documents.
- Group sources by seed.
- Recognize healthy seeds.

#### `scraper`

- Fetch HTML source documents from a manifest.
- Convert HTML to text.
- Store raw source JSON.
- Leave PDF extraction behind a clear unsupported-document error until implemented.

#### `structurer`

- Convert raw text to partial profile fragments.
- Preserve source evidence.
- Keep deterministic extractor for tests.
- Expose strict LLM prompt/schema interface for future model-backed extraction.

#### `normalization`

- Normalize crop names, disease names, pathogen types, active ingredients, symptoms, and environment phrases.
- Deduplicate arrays deterministically.

#### `merger`

- Merge partial profiles.
- Detect conflicts.
- Preserve evidence from all retained facts.
- Keep source ordering deterministic.

#### `confidence`

- Compute field-level and overall confidence.
- Penalize missing sources, conflicts, incomplete fields, and low-authority sources.

#### `exporter`

- Validate every profile.
- Write stable per-document JSON.
- Write stable Couchbase-ready NDJSON.

#### `report`

- Generate source coverage and quality reports.
- This can be a standalone module or CLI subcommand.

## Implementation Steps

### Step 1: Add Profile Type Support

- Add `healthy_profile` builder.
- Update pipeline routing:
  - `disease == "healthy"` -> healthy profile.
  - all others -> disease profile.
- Update validator for both profile types.
- Update tests for healthy output shape.

### Step 2: Add Review Metadata

- Add review metadata to every exported profile.
- Default status:
  - `machine_generated` for profiles without chemical controls.
  - `needs_review` for profiles with chemical controls.
- Validate allowed statuses.

### Step 3: Add Evidence Model

- Define evidence object validation.
- Update deterministic structurer to attach evidence snippets where it extracts facts.
- Keep snippets short and source-backed.
- Update tests to assert evidence exists for sourced symptoms/treatments.

### Step 4: Add Field-Level Confidence

- Replace current `data_quality` with field-level scores, or temporarily support both during migration.
- Add tests for:
  - empty healthy profile confidence.
  - sourced disease profile confidence.
  - confidence penalty for no sources.

### Step 5: Add Conflict Detection

- Detect taxonomy conflicts first.
- Add conflict output to disease profiles.
- Add tests with two conflicting source fixtures.
- Ensure chosen value is deterministic and conflict is recorded.

### Step 6: Strengthen Treatment Schema

- Move treatment entries toward objects with `name`, `evidence`, and optional `regions`.
- Validate no brand names.
- Validate chemicals have evidence.
- Add tests for rejection of unsupported chemical treatments.

### Step 7: Add Coverage Report

- Add report module or CLI command.
- Compute source coverage for all 38 seeds.
- Include below-minimum coverage.
- Add tests using fixture sources.

### Step 8: Preserve Export Compatibility

- Regenerate sample export.
- Confirm NDJSON line count remains 38.
- Confirm per-document JSON files are emitted.
- Confirm byte-stable export across repeated runs.

## Success Criteria

The upgrade is complete when:

- All 38 seed rows export deterministically.
- Healthy rows export as `healthy_profile`, not empty disease profiles.
- Disease rows export as `disease_profile`.
- Every sourced symptom, treatment, prevention item, and taxonomy value includes evidence where possible.
- Documents include review metadata.
- Confidence is available at field level and overall level.
- Taxonomy conflicts are detected and serialized.
- Chemical treatments without evidence are rejected.
- Brand-name pesticide entries are rejected.
- Source coverage report identifies seeds with missing or insufficient source coverage.
- Tests pass without network access or LLM calls.
- Running the export twice with the same input produces identical NDJSON.

Verification commands:

```bash
PYTHONPATH=src python3 -m pytest -q
```

```bash
rm -rf build/couchbase
PYTHONPATH=src python3 -m agronomy_pipeline run \
  --seed data/seed_index.json \
  --sources data/sources \
  --out build/couchbase
```

```bash
wc -l build/couchbase/disease_profiles.ndjson
```

Expected final count:

```text
38
```

## Out of Scope for First Implementation Pass

- Full web search automation.
- PDF parsing beyond explicit unsupported-document handling.
- Region-specific pesticide legality databases.
- Direct Couchbase Sync Gateway upload.
- Expert review UI.
- Live LLM extraction as a required runtime dependency.
