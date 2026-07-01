"""Merge source-specific profiles into canonical disease documents."""

from __future__ import annotations

from typing import Any, Iterable

from .models import (
    SourceDocument,
    default_review,
    empty_disease_profile,
    empty_healthy_profile,
    validate_profile,
    value_fact,
)
from .normalization import unique_ordered


def merge_profiles(
    crop: str,
    disease: str,
    source_profiles: list[tuple[SourceDocument, dict[str, Any]]],
    version: int = 1,
) -> dict[str, Any]:
    profile = empty_disease_profile(crop, disease, version=version)
    if not source_profiles:
        return validate_profile(profile)

    profile["sources"] = _merge_sources([item[1] for item in source_profiles])
    profile["taxonomy"] = _merge_taxonomy(source_profiles)
    profile["symptoms"] = _merge_symptoms([item[1] for item in source_profiles])
    profile["conditions"] = _merge_conditions([item[1] for item in source_profiles])
    profile["severity"] = _merge_severity([item[1] for item in source_profiles])
    profile["treatment"] = {
        "organic": _merge_treatment_facts(
            fact
            for _, partial in source_profiles
            for fact in partial.get("treatment", {}).get("organic", [])
        ),
        "chemical": _merge_treatment_facts(
            fact
            for _, partial in source_profiles
            for fact in partial.get("treatment", {}).get("chemical", [])
        ),
        "cultural": _merge_treatment_facts(
            fact
            for _, partial in source_profiles
            for fact in partial.get("treatment", {}).get("cultural", [])
        ),
    }
    profile["prevention"] = _merge_text_facts(
        fact for _, partial in source_profiles for fact in partial.get("prevention", [])
    )
    profile["conflicts"] = _detect_conflicts(source_profiles)
    profile["confidence"] = _field_confidence(source_profiles, profile)
    profile["review"] = default_review(bool(profile["treatment"]["chemical"]))
    return validate_profile(profile)


def merge_healthy_profile(
    crop: str,
    source_profiles: list[tuple[SourceDocument, dict[str, Any]]] | None = None,
    version: int = 1,
) -> dict[str, Any]:
    profile = empty_healthy_profile(crop, version=version)
    if source_profiles:
        profile["sources"] = _merge_sources([item[1] for item in source_profiles])
    return validate_profile(profile)


def _merge_taxonomy(source_profiles: list[tuple[SourceDocument, dict[str, Any]]]) -> dict[str, Any]:
    best = {
        "pathogen_type": value_fact(""),
        "scientific_name": value_fact(""),
    }
    for _, partial in sorted(source_profiles, key=lambda item: item[0].authority_score, reverse=True):
        taxonomy = partial.get("taxonomy", {})
        for key in best:
            incoming = taxonomy.get(key, value_fact(""))
            if not best[key]["value"] and incoming.get("value"):
                best[key] = {
                    "value": incoming["value"],
                    "evidence": _merge_evidence(incoming.get("evidence", [])),
                }
            elif best[key]["value"] == incoming.get("value"):
                best[key]["evidence"] = _merge_evidence(
                    [*best[key]["evidence"], *incoming.get("evidence", [])]
                )
    return best


def _merge_symptoms(profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for profile in profiles:
        for symptom in profile.get("symptoms", []):
            key = (symptom["stage"], symptom["description"])
            if key not in by_key:
                by_key[key] = {
                    "stage": symptom["stage"],
                    "description": symptom["description"],
                    "evidence": [],
                }
            by_key[key]["evidence"] = _merge_evidence(
                [*by_key[key]["evidence"], *symptom.get("evidence", [])]
            )
    return [by_key[key] for key in sorted(by_key)]


def _merge_conditions(profiles: list[dict[str, Any]]) -> dict[str, Any]:
    ranges = [
        profile.get("conditions", {}).get("temperature_c", {}).get("value", [])
        for profile in profiles
        if profile.get("conditions", {}).get("temperature_c", {}).get("value")
    ]
    temperature_evidence = _merge_evidence(
        evidence
        for profile in profiles
        for evidence in profile.get("conditions", {}).get("temperature_c", {}).get("evidence", [])
    )
    temperature = [min(item[0] for item in ranges), max(item[1] for item in ranges)] if ranges else []

    humidity_fact = value_fact("")
    for profile in profiles:
        incoming = profile.get("conditions", {}).get("humidity", value_fact(""))
        if incoming.get("value"):
            if not humidity_fact["value"]:
                humidity_fact = {
                    "value": incoming["value"],
                    "evidence": _merge_evidence(incoming.get("evidence", [])),
                }
            elif humidity_fact["value"] == incoming["value"]:
                humidity_fact["evidence"] = _merge_evidence(
                    [*humidity_fact["evidence"], *incoming.get("evidence", [])]
                )

    return {
        "temperature_c": {"value": temperature, "evidence": temperature_evidence if temperature else []},
        "humidity": humidity_fact,
        "environment": _merge_text_facts(
            fact
            for profile in profiles
            for fact in profile.get("conditions", {}).get("environment", [])
        ),
    }


def _merge_severity(profiles: list[dict[str, Any]]) -> dict[str, Any]:
    rank = {"": 0, "low": 1, "medium": 2, "high": 3}
    selected = value_fact("")
    for profile in profiles:
        incoming = profile.get("severity", value_fact(""))
        if rank.get(incoming.get("value", ""), 0) > rank.get(selected["value"], 0):
            selected = {
                "value": incoming["value"],
                "evidence": _merge_evidence(incoming.get("evidence", [])),
            }
        elif incoming.get("value") == selected["value"]:
            selected["evidence"] = _merge_evidence(
                [*selected["evidence"], *incoming.get("evidence", [])]
            )
    return selected


def _merge_text_facts(facts: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    by_description: dict[str, dict[str, Any]] = {}
    for fact in facts:
        description = fact.get("description", "")
        if not description:
            continue
        if description not in by_description:
            by_description[description] = {"description": description, "evidence": []}
        by_description[description]["evidence"] = _merge_evidence(
            [*by_description[description]["evidence"], *fact.get("evidence", [])]
        )
    return [by_description[key] for key in sorted(by_description)]


def _merge_treatment_facts(facts: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    by_name: dict[str, dict[str, Any]] = {}
    for fact in facts:
        name = fact.get("name", "")
        if not name:
            continue
        if name not in by_name:
            by_name[name] = {"name": name, "evidence": [], "regions": []}
        by_name[name]["evidence"] = _merge_evidence(
            [*by_name[name]["evidence"], *fact.get("evidence", [])]
        )
        by_name[name]["regions"] = unique_ordered([*by_name[name]["regions"], *fact.get("regions", [])])
    return [by_name[key] for key in sorted(by_name)]


def _merge_sources(profiles: list[dict[str, Any]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str]] = set()
    sources: list[dict[str, str]] = []
    for profile in profiles:
        for source in profile.get("sources", []):
            key = (source["name"], source["url"])
            if key not in seen:
                sources.append(source)
                seen.add(key)
    return sorted(sources, key=lambda item: (item["name"], item["url"]))


def _detect_conflicts(
    source_profiles: list[tuple[SourceDocument, dict[str, Any]]]
) -> list[dict[str, Any]]:
    conflicts: list[dict[str, Any]] = []
    conflicts.extend(_taxonomy_conflicts(source_profiles, "pathogen_type"))
    conflicts.extend(_taxonomy_conflicts(source_profiles, "scientific_name"))
    return conflicts


def _taxonomy_conflicts(
    source_profiles: list[tuple[SourceDocument, dict[str, Any]]], key: str
) -> list[dict[str, Any]]:
    values: dict[str, list[str]] = {}
    for source, partial in source_profiles:
        value = partial.get("taxonomy", {}).get(key, {}).get("value", "")
        if value:
            values.setdefault(value, []).append(source.name)
    if len(values) <= 1:
        return []
    return [
        {
            "field": f"taxonomy.{key}",
            "values": sorted(values),
            "sources": sorted(source for sources in values.values() for source in sources),
            "resolution": "kept_highest_authority",
        }
    ]


def _field_confidence(
    source_profiles: list[tuple[SourceDocument, dict[str, Any]]], profile: dict[str, Any]
) -> dict[str, float]:
    if not source_profiles:
        return {
            "taxonomy": 0.0,
            "symptoms": 0.0,
            "conditions": 0.0,
            "treatment": 0.0,
            "prevention": 0.0,
            "overall": 0.0,
        }
    authority = sum(source.authority_score for source, _ in source_profiles) / len(source_profiles)
    diversity = min(0.15, 0.05 * max(0, len(source_profiles) - 1))
    conflict_penalty = 0.15 if profile["conflicts"] else 0.0

    scores = {
        "taxonomy": _score_field(
            authority,
            diversity,
            bool(
                profile["taxonomy"]["pathogen_type"]["value"]
                and profile["taxonomy"]["scientific_name"]["value"]
            ),
            _has_evidence(profile["taxonomy"].values()),
            conflict_penalty,
        ),
        "symptoms": _score_field(
            authority, diversity, bool(profile["symptoms"]), _has_evidence(profile["symptoms"]), 0.0
        ),
        "conditions": _score_field(
            authority,
            diversity,
            bool(
                profile["conditions"]["temperature_c"]["value"]
                or profile["conditions"]["humidity"]["value"]
                or profile["conditions"]["environment"]
            ),
            _has_evidence(
                [
                    profile["conditions"]["temperature_c"],
                    profile["conditions"]["humidity"],
                    *profile["conditions"]["environment"],
                ]
            ),
            0.0,
        ),
        "treatment": _score_field(
            authority,
            diversity,
            bool(
                profile["treatment"]["organic"]
                or profile["treatment"]["chemical"]
                or profile["treatment"]["cultural"]
            ),
            _has_evidence(
                [
                    *profile["treatment"]["organic"],
                    *profile["treatment"]["chemical"],
                    *profile["treatment"]["cultural"],
                ]
            ),
            0.0,
        ),
        "prevention": _score_field(
            authority, diversity, bool(profile["prevention"]), _has_evidence(profile["prevention"]), 0.0
        ),
    }
    scores["overall"] = round(sum(scores.values()) / len(scores), 2)
    return scores


def _score_field(
    authority: float, diversity: float, complete: bool, has_evidence: bool, penalty: float
) -> float:
    if not complete:
        return 0.0
    evidence_bonus = 0.1 if has_evidence else 0.0
    return round(max(0.0, min(1.0, authority * 0.75 + diversity + evidence_bonus - penalty)), 2)


def _has_evidence(facts: Iterable[dict[str, Any]]) -> bool:
    return any(bool(fact.get("evidence")) for fact in facts)


def _merge_evidence(evidence: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str, str, str]] = set()
    result: list[dict[str, str]] = []
    for item in evidence:
        key = (item["source_name"], item["source_url"], item["quote"], item["field"])
        if key not in seen:
            result.append(item)
            seen.add(key)
    return sorted(result, key=lambda item: (item["source_name"], item["field"], item["quote"]))
