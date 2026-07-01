"""Coverage and quality reporting for seed/source readiness."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ids import disease_profile_id
from .ingestion import group_sources_by_seed, load_seed_index, load_source_documents


def build_coverage_report(
    seed_path: Path,
    sources_dir: Path,
    manifest_path: Path | None = None,
) -> dict[str, Any]:
    seeds = load_seed_index(seed_path)
    sources = load_source_documents(sources_dir)
    grouped = group_sources_by_seed(seeds, sources)
    minimums = _manifest_minimums(manifest_path) if manifest_path else {}

    zero_sources: list[str] = []
    below_minimum: list[dict[str, Any]] = []
    with_sources = 0
    for seed in seeds:
        count = len(grouped.get(seed.id, []))
        if count:
            with_sources += 1
        else:
            zero_sources.append(seed.id)
        minimum = minimums.get(seed.id, 0 if seed.is_healthy else 2)
        if count < minimum:
            below_minimum.append({"id": seed.id, "sources": count, "minimum": minimum})

    return {
        "total_seeds": len(seeds),
        "seeds_with_sources": with_sources,
        "seeds_with_zero_sources": zero_sources,
        "seeds_below_minimum_source_coverage": below_minimum,
    }


def write_coverage_report(report: dict[str, Any], out_path: Path | None = None) -> str:
    body = json.dumps(report, indent=2, sort_keys=True)
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(body + "\n", encoding="utf-8")
    return body


def _manifest_minimums(path: Path) -> dict[str, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    minimums: dict[str, int] = {}
    for item in data:
        if "sources" in item:
            minimum = int(item.get("min_authoritative_sources", 0))
            minimums[disease_profile_id(item["crop"], item["disease"])] = minimum
        else:
            minimums[disease_profile_id(item["crop"], item["disease"])] = int(
                item.get("min_authoritative_sources", 1)
            )
    return minimums
