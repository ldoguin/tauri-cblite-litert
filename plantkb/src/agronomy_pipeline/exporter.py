"""Couchbase Lite JSON exporters."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import validate_profile


def export_profiles(profiles: list[dict[str, Any]], out_dir: Path) -> None:
    documents_dir = out_dir / "documents"
    documents_dir.mkdir(parents=True, exist_ok=True)
    ndjson_path = out_dir / "disease_profiles.ndjson"
    with ndjson_path.open("w", encoding="utf-8") as ndjson:
        for profile in sorted(profiles, key=lambda item: item["id"]):
            validate_profile(profile)
            body = json.dumps(profile, sort_keys=True, separators=(",", ":"))
            (documents_dir / f"{profile['id']}.json").write_text(
                json.dumps(profile, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            ndjson.write(body + "\n")
