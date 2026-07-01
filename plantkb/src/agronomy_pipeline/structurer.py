"""Strict source text to partial profile extraction."""

from __future__ import annotations

import re
from typing import Any

from .llm import LLMProvider, build_extraction_request
from .models import SourceDocument, empty_disease_profile, evidence_for, text_fact, treatment_fact, value_fact
from .normalization import normalize_chemical, normalize_phrase, unique_ordered


PATHOGEN_TYPES = {
    "oomycete": ("oomycete", "phytophthora", "water mold"),
    "fungal": ("fungal", "fungus", "fungi", "venturia", "alternaria"),
    "bacterial": ("bacterial", "bacterium", "bacteria"),
    "viral": ("viral", "virus"),
}

SEVERITY_KEYWORDS = {
    "high": ("severe", "devastating", "rapidly destroy", "serious", "high"),
    "medium": ("moderate", "can reduce", "common"),
    "low": ("minor", "cosmetic", "low"),
}


def build_strict_extraction_prompt(source: SourceDocument) -> str:
    """Prompt template for a future LLM provider."""
    return f"""Extract a disease_profile JSON fragment from the source text.

Rules:
- Return valid JSON only.
- Extract only facts explicitly supported by the source text.
- Do not invent pesticide chemicals or brands.
- If a field is unknown, use an empty string or empty array.
- Preserve source name and URL exactly.

Crop: {source.crop}
Disease: {source.disease}
Source name: {source.name}
Source URL: {source.url}

Required keys:
taxonomy, symptoms, conditions, severity, treatment, prevention, images, sources

Source text:
{source.raw_text}
"""


class DeterministicStructurer:
    """Offline extractor for deterministic MVP runs and tests."""

    def structure(self, source: SourceDocument) -> dict[str, Any]:
        profile = empty_disease_profile(source.crop, source.disease)
        text = source.raw_text
        lowered = text.lower()
        pathogen_type = _extract_pathogen_type(lowered)
        scientific_name = _extract_scientific_name(text)
        profile["taxonomy"] = {
            "pathogen_type": value_fact(
                pathogen_type,
                _evidence_if_value(source, "taxonomy.pathogen_type", pathogen_type),
            ),
            "scientific_name": value_fact(
                scientific_name,
                _evidence_if_value(source, "taxonomy.scientific_name", scientific_name),
            ),
        }
        profile["symptoms"] = _extract_symptoms(source)
        profile["conditions"] = _extract_conditions(source)
        severity, severity_quote = _extract_severity(text)
        profile["severity"] = value_fact(
            severity,
            [evidence_for(source, "severity", severity_quote)] if severity else [],
        )
        profile["treatment"] = {
            "organic": [
                treatment_fact(item, [evidence_for(source, "treatment.organic", item)])
                for item in _extract_list_after_labels(text, ("Organic treatment", "Organic"))
            ],
            "chemical": [
                treatment_fact(
                    normalize_chemical(item),
                    [evidence_for(source, "treatment.chemical", item)],
                )
                for item in _extract_list_after_labels(text, ("Chemical treatment", "Chemical"))
            ],
            "cultural": [],
        }
        profile["prevention"] = [
            text_fact(item, [evidence_for(source, "prevention", item)])
            for item in _extract_list_after_labels(text, ("Prevention", "Management"))
        ]
        profile["sources"] = [source.source_ref()]
        return profile


class LLMStructurer:
    """Extractor backed by a schema-constrained LLMProvider (see ``llm.py``).

    Still passes through the same validator/merger pipeline as DeterministicStructurer —
    the LLM only supplies fact values and evidence, never an exported document directly.
    """

    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    def structure(self, source: SourceDocument) -> dict[str, Any]:
        request = build_extraction_request(source)
        extracted = self._provider.extract_json(request)
        extracted = _truncate_evidence_quotes(extracted)
        extracted = _pin_evidence_source(extracted, source)
        profile = empty_disease_profile(source.crop, source.disease)
        profile["taxonomy"] = extracted["taxonomy"]
        profile["symptoms"] = _drop_unevidenced([s for s in extracted["symptoms"]])
        profile["conditions"] = _sanitize_conditions(extracted["conditions"])
        profile["severity"] = extracted["severity"]
        profile["treatment"] = {
            key: _drop_unevidenced(extracted["treatment"][key]) for key in ("organic", "chemical", "cultural")
        }
        profile["prevention"] = _drop_unevidenced(extracted["prevention"])
        profile["sources"] = [source.source_ref()]
        return profile


def _drop_unevidenced(facts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop facts the model emitted without evidence — usually a placeholder like
    'No specific treatment mentioned' rather than the empty array the prompt asks for."""
    return [fact for fact in facts if fact.get("evidence")]


def _sanitize_conditions(conditions: dict[str, Any]) -> dict[str, Any]:
    """Drop a malformed temperature_c.value (the schema allows 0-2 items, but only
    exactly 2 — [min, max] with min <= max — is meaningful downstream) and any
    environment fact the model emitted without evidence."""
    temperature = conditions.get("temperature_c", {})
    value = temperature.get("value", [])
    conditions = {**conditions, "environment": _drop_unevidenced(conditions.get("environment", []))}
    if len(value) != 2 or value[0] > value[1]:
        conditions = {**conditions, "temperature_c": {"value": [], "evidence": []}}
    return conditions


def _pin_evidence_source(node: Any, source: SourceDocument) -> Any:
    """Force every evidence object's source_name/source_url to the actual source
    document — build_extraction_request always scopes one request to one source, but
    the model doesn't reliably echo the name/URL we gave it byte-for-byte."""
    if isinstance(node, dict):
        if "source_name" in node and "source_url" in node:
            node = {**node, "source_name": source.name, "source_url": source.url}
        return {key: _pin_evidence_source(value, source) for key, value in node.items()}
    if isinstance(node, list):
        return [_pin_evidence_source(item, source) for item in node]
    return node


def _truncate_evidence_quotes(node: Any, max_words: int = 30) -> Any:
    """Cap evidence quote length defensively — the validator rejects quotes over
    30 words, but real-world prose makes LLM providers unreliable about the limit
    even when told in the prompt."""
    if isinstance(node, dict):
        if isinstance(node.get("quote"), str):
            words = node["quote"].split()
            if len(words) > max_words:
                node = {**node, "quote": " ".join(words[:max_words])}
        return {key: _truncate_evidence_quotes(value, max_words) for key, value in node.items()}
    if isinstance(node, list):
        return [_truncate_evidence_quotes(item, max_words) for item in node]
    return node


def _extract_pathogen_type(lowered: str) -> str:
    for pathogen_type, markers in PATHOGEN_TYPES.items():
        if any(marker in lowered for marker in markers):
            return pathogen_type
    return ""


def _extract_scientific_name(text: str) -> str:
    patterns = (
        r"(?:caused by|pathogen:|causal agent:)\s+([A-Z][a-z]+(?:\s+[a-z][a-z-]+){1,2})",
        r"\(([A-Z][a-z]+(?:\s+[a-z][a-z-]+){1,2})\)",
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1).strip(" .;:,")
    return ""


def _extract_symptoms(source: SourceDocument) -> list[dict[str, Any]]:
    text = source.raw_text
    symptoms: list[dict[str, Any]] = []
    label_patterns = {
        "early": ("Early symptoms", "Early symptom"),
        "general": ("Symptoms", "Symptom"),
        "late": ("Late symptoms", "Late symptom"),
    }
    for stage, labels in label_patterns.items():
        for phrase in _extract_list_after_labels(text, labels):
            symptoms.append(
                {
                    "stage": stage,
                    "description": phrase,
                    "evidence": [evidence_for(source, "symptoms.description", phrase)],
                }
            )
    seen: set[tuple[str, str]] = set()
    result: list[dict[str, str]] = []
    for symptom in symptoms:
        key = (symptom["stage"], symptom["description"])
        if key not in seen:
            result.append(symptom)
            seen.add(key)
    return result


def _extract_conditions(source: SourceDocument) -> dict[str, Any]:
    text = source.raw_text
    lowered = text.lower()
    temperature, temperature_quote = _extract_temperature_range(text)
    humidity, humidity_quote = _extract_humidity(lowered, text)
    return {
        "temperature_c": value_fact(
            temperature,
            [evidence_for(source, "conditions.temperature_c", temperature_quote)] if temperature else [],
        ),
        "humidity": value_fact(
            humidity,
            [evidence_for(source, "conditions.humidity", humidity_quote)] if humidity else [],
        ),
        "environment": [
            text_fact(item["description"], [evidence_for(source, "conditions.environment", item["quote"])])
            for item in _extract_environment(text)
        ],
    }


def _extract_temperature_range(text: str) -> tuple[list[int], str]:
    patterns = (
        r"(\d{1,2})\s*(?:-|to|and)\s*(\d{1,2})\s*(?:degrees\s*)?(?:c|°c)",
        r"between\s+(\d{1,2})\s+and\s+(\d{1,2})\s*(?:degrees\s*)?(?:c|°c)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            low, high = int(match.group(1)), int(match.group(2))
            return [min(low, high), max(low, high)], match.group(0)
    return [], ""


def _extract_humidity(lowered: str, text: str) -> tuple[str, str]:
    for marker in ("high humidity", "humid", "wet"):
        if marker in lowered:
            return "high", _source_quote_for_value(text, marker)
    return "", ""


def _extract_environment(text: str) -> list[dict[str, str]]:
    values = [
        {"description": item, "quote": _source_quote_for_value(text, item)}
        for item in _extract_list_after_labels(text, ("Environment",))
    ]
    lowered = text.lower()
    markers = {
        "wet leaves": ("wet leaves", "leaf wetness", "wet foliage"),
        "poor airflow": ("poor airflow", "poor air circulation", "dense canopy"),
        "cool weather": ("cool weather", "cool nights"),
        "rain": ("rain", "rainy"),
    }
    for phrase, needles in markers.items():
        for needle in needles:
            if needle in lowered:
                values.append({"description": phrase, "quote": _source_quote_for_value(text, needle)})
                break
    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for item in values:
        if item["description"] not in seen:
            result.append(item)
            seen.add(item["description"])
    return result


def _extract_severity(text: str) -> tuple[str, str]:
    lowered = text.lower()
    for severity, markers in SEVERITY_KEYWORDS.items():
        for marker in markers:
            if marker in lowered:
                return severity, _source_quote_for_value(text, marker)
    return "", ""


def _extract_list_after_labels(text: str, labels: tuple[str, ...]) -> list[str]:
    values: list[str] = []
    for label in labels:
        pattern = rf"(?:^|[.;]\s+|\n){re.escape(label)}\s*:\s*([^.\n]+)"
        for match in re.finditer(pattern, text, flags=re.IGNORECASE | re.MULTILINE):
            values.extend(_split_items(match.group(1)))
    return unique_ordered(values)


def _split_items(value: str) -> list[str]:
    parts = re.split(r";|\n|,(?=\s+[a-z])", value)
    return [normalize_phrase(part) for part in parts if normalize_phrase(part)]


def _evidence_if_value(source: SourceDocument, field: str, value: str) -> list[dict[str, str]]:
    if not value:
        return []
    return [evidence_for(source, field, _source_quote_for_value(source.raw_text, value))]


def _source_quote_for_value(text: str, value: str) -> str:
    if not value:
        return ""
    escaped = re.escape(value)
    match = re.search(rf"[^.]*{escaped}[^.]*", text, flags=re.IGNORECASE)
    if match:
        return match.group(0).strip(" .")
    return value
