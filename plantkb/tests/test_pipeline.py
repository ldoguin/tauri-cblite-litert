from __future__ import annotations

import json
from pathlib import Path

from agronomy_pipeline.models import validate_profile
from agronomy_pipeline.pipeline import run_pipeline
from agronomy_pipeline.report import build_coverage_report


def test_pipeline_exports_valid_couchbase_documents(tmp_path: Path) -> None:
    profiles = run_pipeline(
        Path("data/seed_index.json"),
        Path("data/sources"),
        tmp_path,
    )

    assert len(profiles) == 38
    assert profiles[0]["id"] == "apple_scab"
    assert profiles[-1]["id"] == "tomato_healthy"
    for profile in profiles:
        validate_profile(profile)

    ndjson_path = tmp_path / "disease_profiles.ndjson"
    assert ndjson_path.exists()
    ndjson_docs = [json.loads(line) for line in ndjson_path.read_text().splitlines()]
    assert len(ndjson_docs) == 38
    assert (tmp_path / "documents" / "tomato_late_blight.json").exists()
    healthy = next(profile for profile in profiles if profile["id"] == "apple_healthy")
    assert healthy["type"] == "healthy_profile"
    assert "taxonomy" not in healthy


def test_tomato_late_blight_merges_authoritative_sources(tmp_path: Path) -> None:
    profiles = run_pipeline(
        Path("data/seed_index.json"),
        Path("data/sources"),
        tmp_path,
    )
    tomato = next(profile for profile in profiles if profile["id"] == "tomato_late_blight")

    assert tomato["taxonomy"]["pathogen_type"]["value"] == "oomycete"
    assert tomato["taxonomy"]["pathogen_type"]["evidence"]
    assert tomato["taxonomy"]["scientific_name"]["value"] == "Phytophthora infestans"
    assert tomato["conditions"]["temperature_c"]["value"] == [10, 25]
    assert tomato["confidence"]["overall"] >= 0.8
    assert len(tomato["sources"]) == 2
    assert tomato["review"]["status"] == "needs_review"
    assert any(item["name"] == "chlorothalonil" for item in tomato["treatment"]["chemical"])
    assert all(item["evidence"] for item in tomato["treatment"]["chemical"])
    assert any(item["description"] == "remove infected crop debris" for item in tomato["prevention"])


def test_unknown_treatment_fields_remain_empty(tmp_path: Path) -> None:
    profiles = run_pipeline(
        Path("data/seed_index.json"),
        Path("data/sources"),
        tmp_path,
    )
    apple = next(profile for profile in profiles if profile["id"] == "apple_scab")

    assert apple["treatment"]["chemical"] == []
    assert apple["treatment"]["organic"] == [
        {
            "name": "sulfur",
            "evidence": [
                {
                    "source_name": "FAO Example",
                    "source_url": "https://example.fao.org/apple-scab",
                    "quote": "sulfur",
                    "field": "treatment.organic",
                }
            ],
            "regions": [],
        }
    ]


def test_conflicting_taxonomy_is_reported(tmp_path: Path) -> None:
    seed_path = tmp_path / "seed.json"
    sources_dir = tmp_path / "sources"
    out_dir = tmp_path / "out"
    sources_dir.mkdir()
    seed_path.write_text(
        json.dumps([{"crop": "bell pepper", "disease": "bacterial spot"}]),
        encoding="utf-8",
    )
    (sources_dir / "a.json").write_text(
        json.dumps(
            {
                "crop": "bell pepper",
                "disease": "bacterial spot",
                "source": {"name": "Source A", "url": "https://a.example", "authority": "usda"},
                "raw_text": "Causal agent: Xanthomonas campestris. The organism is bacterial. Symptoms: leaf spots.",
            }
        ),
        encoding="utf-8",
    )
    (sources_dir / "b.json").write_text(
        json.dumps(
            {
                "crop": "bell pepper",
                "disease": "bacterial spot",
                "source": {"name": "Source B", "url": "https://b.example", "authority": "forum"},
                "raw_text": "Causal agent: Xanthomonas campestris. The organism is fungal. Symptoms: leaf spots.",
            }
        ),
        encoding="utf-8",
    )

    [profile] = run_pipeline(seed_path, sources_dir, out_dir)

    assert profile["taxonomy"]["pathogen_type"]["value"] == "bacterial"
    assert profile["conflicts"] == [
        {
            "field": "taxonomy.pathogen_type",
            "values": ["bacterial", "fungal"],
            "sources": ["Source A", "Source B"],
            "resolution": "kept_highest_authority",
        }
    ]


def test_coverage_report_and_export_are_deterministic(tmp_path: Path) -> None:
    out_a = tmp_path / "a"
    out_b = tmp_path / "b"

    run_pipeline(Path("data/seed_index.json"), Path("data/sources"), out_a)
    run_pipeline(Path("data/seed_index.json"), Path("data/sources"), out_b)

    assert (out_a / "disease_profiles.ndjson").read_bytes() == (
        out_b / "disease_profiles.ndjson"
    ).read_bytes()
    report = build_coverage_report(Path("data/seed_index.json"), Path("data/sources"))
    assert report["total_seeds"] == 38
    assert report["seeds_with_sources"] == 26
    assert "apple_healthy" in report["seeds_with_zero_sources"]
