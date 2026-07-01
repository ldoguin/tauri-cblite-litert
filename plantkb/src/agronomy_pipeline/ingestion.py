"""Source ingestion for harvested disease documents."""

from __future__ import annotations

import json
from pathlib import Path

from .models import SeedDisease, SourceDocument


def load_seed_index(path: Path) -> list[SeedDisease]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [SeedDisease(crop=item["crop"], disease=item["disease"]) for item in data]


def load_source_documents(directory: Path) -> list[SourceDocument]:
    documents: list[SourceDocument] = []
    for path in sorted(directory.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        source = data["source"]
        documents.append(
            SourceDocument(
                crop=data["crop"],
                disease=data["disease"],
                name=source["name"],
                url=source.get("url", ""),
                authority=source.get("authority", "unknown"),
                raw_text=data["raw_text"],
            )
        )
    return documents


def group_sources_by_seed(
    seeds: list[SeedDisease], sources: list[SourceDocument]
) -> dict[str, list[SourceDocument]]:
    grouped = {seed.id: [] for seed in seeds}
    for source in sources:
        if source.id in grouped:
            grouped[source.id].append(source)
    return grouped
