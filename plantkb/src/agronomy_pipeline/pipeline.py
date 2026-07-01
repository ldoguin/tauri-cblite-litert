"""End-to-end disease profile pipeline orchestration."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .exporter import export_profiles
from .ingestion import group_sources_by_seed, load_seed_index, load_source_documents
from .merger import merge_healthy_profile, merge_profiles
from .structurer import DeterministicStructurer


def run_pipeline(
    seed_path: Path,
    sources_dir: Path,
    out_dir: Path,
    version: int = 1,
    structurer: Any = None,
) -> list[dict[str, Any]]:
    seeds = load_seed_index(seed_path)
    sources = load_source_documents(sources_dir)
    grouped_sources = group_sources_by_seed(seeds, sources)
    if structurer is None:
        structurer = DeterministicStructurer()
    profiles: list[dict[str, Any]] = []
    for seed in seeds:
        partials = [
            (source, structurer.structure(source))
            for source in grouped_sources.get(seed.id, [])
        ]
        if seed.is_healthy:
            profiles.append(merge_healthy_profile(seed.crop, partials, version=version))
        else:
            profiles.append(merge_profiles(seed.crop, seed.disease, partials, version=version))
    export_profiles(profiles, out_dir)
    return profiles
