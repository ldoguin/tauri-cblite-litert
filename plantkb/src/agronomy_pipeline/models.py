"""Typed models and schema validation for exported documents."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .ids import disease_profile_id, slugify


AUTHORITY_SCORES = {
    "eppo": 1.0,
    "usda": 0.95,
    "university_extension": 0.9,
    "fao": 0.9,
    "research": 0.8,
    "government": 0.8,
    "forum": 0.25,
    "unknown": 0.5,
}

PATHOGEN_TYPES = {
    "",
    "fungal",
    "oomycete",
    "bacterial",
    "viral",
    "insect",
    "mite",
    "nematode",
    "abiotic",
}

REVIEW_STATUSES = {"machine_generated", "needs_review", "expert_reviewed", "rejected"}


@dataclass(frozen=True)
class SeedDisease:
    crop: str
    disease: str

    @property
    def id(self) -> str:
        return disease_profile_id(self.crop, self.disease)

    @property
    def is_healthy(self) -> bool:
        return slugify(self.disease) == "healthy"


@dataclass(frozen=True)
class SourceDocument:
    crop: str
    disease: str
    name: str
    url: str
    authority: str
    raw_text: str

    @property
    def id(self) -> str:
        return disease_profile_id(self.crop, self.disease)

    @property
    def authority_score(self) -> float:
        return AUTHORITY_SCORES.get(self.authority, AUTHORITY_SCORES["unknown"])

    def source_ref(self) -> dict[str, str]:
        return {"name": self.name, "url": self.url}


class ValidationError(ValueError):
    """Raised when a profile cannot be exported safely."""


def evidence_for(source: SourceDocument, field: str, quote: str) -> dict[str, str]:
    return {
        "source_name": source.name,
        "source_url": source.url,
        "quote": _short_quote(quote),
        "field": field,
    }


def value_fact(value: Any, evidence: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {"value": value, "evidence": evidence or []}


def text_fact(
    description: str, evidence: list[dict[str, str]] | None = None
) -> dict[str, Any]:
    return {"description": description, "evidence": evidence or []}


def treatment_fact(
    name: str, evidence: list[dict[str, str]] | None = None, regions: list[str] | None = None
) -> dict[str, Any]:
    return {"name": name, "evidence": evidence or [], "regions": regions or []}


def empty_disease_profile(crop: str, disease: str, version: int = 1) -> dict[str, Any]:
    crop_slug = slugify(crop)
    disease_slug = slugify(disease)
    return {
        "type": "disease_profile",
        "id": disease_profile_id(crop, disease),
        "version": version,
        "crop": crop_slug,
        "disease": disease_slug,
        "taxonomy": {
            "pathogen_type": value_fact(""),
            "scientific_name": value_fact(""),
        },
        "symptoms": [],
        "conditions": {
            "temperature_c": value_fact([]),
            "humidity": value_fact(""),
            "environment": [],
        },
        "severity": value_fact(""),
        "treatment": {
            "organic": [],
            "chemical": [],
            "cultural": [],
        },
        "prevention": [],
        "images": [],
        "sources": [],
        "confidence": {
            "taxonomy": 0.0,
            "symptoms": 0.0,
            "conditions": 0.0,
            "treatment": 0.0,
            "prevention": 0.0,
            "overall": 0.0,
        },
        "conflicts": [],
        "review": default_review(False),
    }


def empty_healthy_profile(crop: str, version: int = 1) -> dict[str, Any]:
    crop_slug = slugify(crop)
    return {
        "type": "healthy_profile",
        "id": disease_profile_id(crop, "healthy"),
        "version": version,
        "crop": crop_slug,
        "class": "healthy",
        "visual_traits": [],
        "common_false_positives": [],
        "images": [],
        "sources": [],
        "confidence": {
            "visual_traits": 0.0,
            "false_positives": 0.0,
            "overall": 0.0,
        },
        "review": default_review(False),
    }


def empty_profile(crop: str, disease: str, version: int = 1) -> dict[str, Any]:
    if slugify(disease) == "healthy":
        return empty_healthy_profile(crop, version=version)
    return empty_disease_profile(crop, disease, version=version)


def default_review(has_chemical_controls: bool) -> dict[str, str | None]:
    return {
        "status": "needs_review" if has_chemical_controls else "machine_generated",
        "reviewed_by": None,
        "reviewed_at": None,
    }


def validate_profile(profile: dict[str, Any]) -> dict[str, Any]:
    profile_type = profile.get("type")
    if profile_type == "disease_profile":
        return _validate_disease_profile(profile)
    if profile_type == "healthy_profile":
        return _validate_healthy_profile(profile)
    raise ValidationError("type must be disease_profile or healthy_profile")


def _validate_disease_profile(profile: dict[str, Any]) -> dict[str, Any]:
    required = {
        "type",
        "id",
        "version",
        "crop",
        "disease",
        "taxonomy",
        "symptoms",
        "conditions",
        "severity",
        "treatment",
        "prevention",
        "images",
        "sources",
        "confidence",
        "conflicts",
        "review",
    }
    _validate_required(profile, required)
    if profile["id"] != disease_profile_id(profile["crop"], profile["disease"]):
        raise ValidationError("id must match crop and disease slugs")
    _validate_common(profile)
    _validate_source_refs(profile["sources"])
    source_keys = {(source["name"], source["url"]) for source in profile["sources"]}
    _validate_taxonomy(profile["taxonomy"], source_keys)
    _validate_symptoms(profile["symptoms"], source_keys)
    _validate_conditions(profile["conditions"], source_keys)
    _validate_value_fact(profile["severity"], str, "severity", source_keys)
    _validate_treatment(profile["treatment"], source_keys)
    _validate_text_fact_array(profile["prevention"], "prevention", source_keys)
    _validate_confidence(profile["confidence"])
    _validate_conflicts(profile["conflicts"])
    _validate_review(profile["review"])
    return profile


def _validate_healthy_profile(profile: dict[str, Any]) -> dict[str, Any]:
    required = {
        "type",
        "id",
        "version",
        "crop",
        "class",
        "visual_traits",
        "common_false_positives",
        "images",
        "sources",
        "confidence",
        "review",
    }
    _validate_required(profile, required)
    if profile["class"] != "healthy":
        raise ValidationError("healthy profile class must be healthy")
    if profile["id"] != disease_profile_id(profile["crop"], "healthy"):
        raise ValidationError("healthy profile id must match crop_healthy")
    _validate_common(profile)
    _validate_source_refs(profile["sources"])
    source_keys = {(source["name"], source["url"]) for source in profile["sources"]}
    _validate_text_fact_array(profile["visual_traits"], "visual_traits", source_keys)
    _validate_text_fact_array(profile["common_false_positives"], "common_false_positives", source_keys)
    _validate_confidence(profile["confidence"])
    _validate_review(profile["review"])
    return profile


def _validate_required(profile: dict[str, Any], required: set[str]) -> None:
    missing = sorted(required - set(profile))
    if missing:
        raise ValidationError(f"missing required fields: {', '.join(missing)}")


def _validate_common(profile: dict[str, Any]) -> None:
    if not isinstance(profile["version"], int) or profile["version"] < 1:
        raise ValidationError("version must be a positive integer")
    if not isinstance(profile["images"], list):
        raise ValidationError("images must be an array")


def _validate_taxonomy(taxonomy: Any, source_keys: set[tuple[str, str]]) -> None:
    if not isinstance(taxonomy, dict):
        raise ValidationError("taxonomy must be an object")
    for key in ("pathogen_type", "scientific_name"):
        _validate_value_fact(taxonomy.get(key), str, f"taxonomy.{key}", source_keys)
    pathogen_type = taxonomy["pathogen_type"]["value"]
    if pathogen_type not in PATHOGEN_TYPES:
        raise ValidationError("taxonomy.pathogen_type has unsupported value")


def _validate_symptoms(symptoms: Any, source_keys: set[tuple[str, str]]) -> None:
    if not isinstance(symptoms, list):
        raise ValidationError("symptoms must be an array")
    for symptom in symptoms:
        if not isinstance(symptom, dict):
            raise ValidationError("each symptom must be an object")
        if set(symptom) != {"stage", "description", "evidence"}:
            raise ValidationError("symptoms must contain stage, description, and evidence")
        if not isinstance(symptom["stage"], str) or not isinstance(symptom["description"], str):
            raise ValidationError("symptom stage and description must be strings")
        _validate_evidence_array(symptom["evidence"], "symptoms.description", source_keys)


def _validate_conditions(conditions: Any, source_keys: set[tuple[str, str]]) -> None:
    if not isinstance(conditions, dict):
        raise ValidationError("conditions must be an object")
    _validate_value_fact(conditions.get("temperature_c"), list, "conditions.temperature_c", source_keys)
    temps = conditions["temperature_c"]["value"]
    if temps:
        if (
            len(temps) != 2
            or not all(isinstance(value, (int, float)) for value in temps)
            or temps[0] > temps[1]
        ):
            raise ValidationError("conditions.temperature_c must be [min, max]")
    _validate_value_fact(conditions.get("humidity"), str, "conditions.humidity", source_keys)
    _validate_text_fact_array(conditions.get("environment"), "conditions.environment", source_keys)


def _validate_treatment(treatment: Any, source_keys: set[tuple[str, str]]) -> None:
    if not isinstance(treatment, dict):
        raise ValidationError("treatment must be an object")
    for key in ("organic", "chemical", "cultural"):
        values = treatment.get(key)
        if not isinstance(values, list):
            raise ValidationError(f"treatment.{key} must be an array")
        for item in values:
            if not isinstance(item, dict) or set(item) != {"name", "evidence", "regions"}:
                raise ValidationError(f"treatment.{key} entries must contain name, evidence, regions")
            if not isinstance(item["name"], str):
                raise ValidationError(f"treatment.{key}.name must be a string")
            if not isinstance(item["regions"], list) or not all(
                isinstance(region, str) for region in item["regions"]
            ):
                raise ValidationError(f"treatment.{key}.regions must be an array of strings")
            _validate_evidence_array(item["evidence"], f"treatment.{key}", source_keys)
            if key == "chemical":
                lowered = item["name"].lower()
                if any(token in lowered for token in ("®", " brand", " tm", "trade name")):
                    raise ValidationError("chemical treatments must be active ingredients, not brands")
                if item["name"] and not item["evidence"]:
                    raise ValidationError("chemical treatments require evidence")


def _validate_text_fact_array(values: Any, field: str, source_keys: set[tuple[str, str]]) -> None:
    if not isinstance(values, list):
        raise ValidationError(f"{field} must be an array")
    for item in values:
        if not isinstance(item, dict) or set(item) != {"description", "evidence"}:
            raise ValidationError(f"{field} entries must contain description and evidence")
        if not isinstance(item["description"], str):
            raise ValidationError(f"{field}.description must be a string")
        _validate_evidence_array(item["evidence"], field, source_keys)


def _validate_value_fact(
    fact: Any, value_type: type, field: str, source_keys: set[tuple[str, str]]
) -> None:
    if not isinstance(fact, dict) or set(fact) != {"value", "evidence"}:
        raise ValidationError(f"{field} must contain value and evidence")
    if not isinstance(fact["value"], value_type):
        raise ValidationError(f"{field}.value has wrong type")
    _validate_evidence_array(fact["evidence"], field, source_keys)


def _validate_evidence_array(evidence: Any, field: str, source_keys: set[tuple[str, str]]) -> None:
    if not isinstance(evidence, list):
        raise ValidationError(f"{field}.evidence must be an array")
    for item in evidence:
        if not isinstance(item, dict):
            raise ValidationError("evidence entries must be objects")
        if set(item) != {"source_name", "source_url", "quote", "field"}:
            raise ValidationError("evidence entries must contain source_name, source_url, quote, field")
        if not all(isinstance(item[key], str) for key in ("source_name", "source_url", "quote", "field")):
            raise ValidationError("evidence fields must be strings")
        if (item["source_name"], item["source_url"]) not in source_keys:
            raise ValidationError("evidence must reference an existing source")
        if len(item["quote"].split()) > 30:
            raise ValidationError("evidence quotes must be short")


def _validate_confidence(confidence: Any) -> None:
    if not isinstance(confidence, dict):
        raise ValidationError("confidence must be an object")
    for key, value in confidence.items():
        if not isinstance(key, str) or not isinstance(value, (int, float)) or not 0.0 <= value <= 1.0:
            raise ValidationError("confidence scores must be between 0 and 1")


def _validate_conflicts(conflicts: Any) -> None:
    if not isinstance(conflicts, list):
        raise ValidationError("conflicts must be an array")
    for conflict in conflicts:
        if not isinstance(conflict, dict):
            raise ValidationError("conflict entries must be objects")
        if set(conflict) != {"field", "values", "sources", "resolution"}:
            raise ValidationError("conflicts must contain field, values, sources, resolution")
        if not isinstance(conflict["field"], str) or not isinstance(conflict["resolution"], str):
            raise ValidationError("conflict field and resolution must be strings")
        if not isinstance(conflict["values"], list) or not all(
            isinstance(value, str) for value in conflict["values"]
        ):
            raise ValidationError("conflict values must be an array of strings")
        if not isinstance(conflict["sources"], list) or not all(
            isinstance(source, str) for source in conflict["sources"]
        ):
            raise ValidationError("conflict sources must be an array of strings")


def _validate_review(review: Any) -> None:
    if not isinstance(review, dict):
        raise ValidationError("review must be an object")
    if set(review) != {"status", "reviewed_by", "reviewed_at"}:
        raise ValidationError("review must contain status, reviewed_by, reviewed_at")
    if review["status"] not in REVIEW_STATUSES:
        raise ValidationError("review status is unsupported")
    if review["reviewed_by"] is not None and not isinstance(review["reviewed_by"], str):
        raise ValidationError("review.reviewed_by must be null or string")
    if review["reviewed_at"] is not None and not isinstance(review["reviewed_at"], str):
        raise ValidationError("review.reviewed_at must be null or string")


def _validate_source_refs(sources: Any) -> None:
    if not isinstance(sources, list):
        raise ValidationError("sources must be an array")
    for source in sources:
        if not isinstance(source, dict):
            raise ValidationError("each source must be an object")
        if set(source) != {"name", "url"}:
            raise ValidationError("sources must contain only name and url")
        if not all(isinstance(source[k], str) for k in ("name", "url")):
            raise ValidationError("source fields must be strings")


def _short_quote(value: str) -> str:
    words = value.strip().split()
    return " ".join(words[:30])
