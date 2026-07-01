from __future__ import annotations

from typing import Any

from agronomy_pipeline.llm import ExtractionRequest
from agronomy_pipeline.merger import merge_profiles
from agronomy_pipeline.models import SourceDocument, validate_profile
from agronomy_pipeline.structurer import LLMStructurer


class FakeLLMProvider:
    """Stands in for a real provider so tests never make network/LLM calls."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.requests: list[ExtractionRequest] = []

    def extract_json(self, request: ExtractionRequest) -> dict[str, Any]:
        self.requests.append(request)
        return self.payload


def _source() -> SourceDocument:
    return SourceDocument(
        crop="tomato",
        disease="late blight",
        name="EPPO",
        url="https://example.org/late-blight",
        authority="eppo",
        raw_text="Late blight is caused by Phytophthora infestans, an oomycete.",
    )


def _extraction_payload(source: SourceDocument) -> dict[str, Any]:
    evidence = [
        {
            "source_name": source.name,
            "source_url": source.url,
            "quote": "Phytophthora infestans",
            "field": "taxonomy.scientific_name",
        }
    ]
    return {
        "taxonomy": {
            "pathogen_type": {"value": "oomycete", "evidence": evidence},
            "scientific_name": {"value": "Phytophthora infestans", "evidence": evidence},
        },
        "symptoms": [],
        "conditions": {
            "temperature_c": {"value": [], "evidence": []},
            "humidity": {"value": "", "evidence": []},
            "environment": [],
        },
        "severity": {"value": "", "evidence": []},
        "treatment": {"organic": [], "chemical": [], "cultural": []},
        "prevention": [],
    }


def test_llm_structurer_builds_request_and_maps_response_into_partial_profile() -> None:
    source = _source()
    provider = FakeLLMProvider(_extraction_payload(source))
    structurer = LLMStructurer(provider)

    partial = structurer.structure(source)

    assert len(provider.requests) == 1
    assert provider.requests[0].crop == "tomato"
    assert partial["taxonomy"]["pathogen_type"]["value"] == "oomycete"
    assert partial["sources"] == [source.source_ref()]


def test_llm_structurer_output_merges_and_validates() -> None:
    source = _source()
    provider = FakeLLMProvider(_extraction_payload(source))
    structurer = LLMStructurer(provider)

    partial = structurer.structure(source)
    profile = merge_profiles("tomato", "late blight", [(source, partial)])

    validate_profile(profile)
    assert profile["taxonomy"]["scientific_name"]["value"] == "Phytophthora infestans"
