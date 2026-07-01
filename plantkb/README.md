# Agronomy Disease Pipeline

Builds source-traceable crop disease documents for Couchbase Lite import.

The pipeline turns a seed disease index plus harvested source text into validated,
normalized, merged JSON documents:

```bash
python -m agronomy_pipeline harvest \
  --manifest data/source_manifest.example.json \
  --out data/sources
```

```bash
python -m agronomy_pipeline run \
  --seed data/seed_index.json \
  --sources data/sources \
  --out build/couchbase
```

Outputs:

- `build/couchbase/documents/*.json`: one document per disease profile
- `build/couchbase/disease_profiles.ndjson`: Couchbase-ready newline-delimited JSON

Generate a source coverage report:

```bash
python -m agronomy_pipeline report \
  --seed data/seed_index.json \
  --sources data/sources \
  --out build/coverage_report.json
```

Build and search a deterministic local chunk index:

```bash
python -m agronomy_pipeline index \
  --sources data/sources \
  --out build/source_chunks.json
```

```bash
python -m agronomy_pipeline search \
  --index build/source_chunks.json \
  --query "water-soaked leaf lesions late blight" \
  --crop tomato \
  --disease "late blight"
```

The default structurer is deterministic and offline-ready. It extracts only facts
visible in the input text, attaches compact source evidence to extracted facts,
and leaves unknown treatment fields empty.

An OpenAI-backed structurer is also available — it uses schema-constrained
structured outputs (`agronomy_pipeline.llm.build_extraction_request` /
`OpenAILLMProvider`) and still passes through the same validator before export:

```bash
pip install -e ".[llm]"
cp .env.example .env  # fill in OPENAI_API_KEY

python -m agronomy_pipeline run \
  --seed data/seed_index.json \
  --sources data/sources \
  --out build/couchbase \
  --structurer llm
```

Documents are exported as either:

- `disease_profile`: disease classes with evidence-backed taxonomy, symptoms,
  conditions, treatments, prevention, field-level confidence, conflicts, and
  review metadata.
- `healthy_profile`: healthy classes without pathogen/treatment requirements.

Pipeline modules:

- `scraper`: fetch authoritative HTML sources and store raw text blobs
- `structurer`: convert source text into schema-shaped fragments
- `models` and `normalization`: validate and standardize extracted facts
- `merger`: deduplicate source fragments and score confidence
- `exporter`: write per-document JSON and Couchbase-ready NDJSON
- `report`: audit source coverage across the seed index
- `retrieval`: chunk source text and build deterministic local vector-style indexes
- `llm`: prepare schema-constrained extraction requests for a future LLM provider
