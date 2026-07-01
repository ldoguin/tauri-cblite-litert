"""Schema-constrained LLM extraction interfaces.

This module prepares requests for an LLM extractor but does not require any
network provider. Production integrations can implement ``LLMProvider`` and
return JSON that still has to pass the same deterministic validation pipeline.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Protocol

from .models import PATHOGEN_TYPES, SourceDocument


EXTRACTION_SCHEMA: dict[str, Any] = {
    "name": "agronomy_disease_extraction",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "taxonomy",
            "symptoms",
            "conditions",
            "severity",
            "treatment",
            "prevention",
        ],
        "properties": {
            "taxonomy": {
                "type": "object",
                "additionalProperties": False,
                "required": ["pathogen_type", "scientific_name"],
                "properties": {
                    "pathogen_type": {"$ref": "#/$defs/pathogen_type_fact"},
                    "scientific_name": {"$ref": "#/$defs/value_fact_string"},
                },
            },
            "symptoms": {
                "type": "array",
                "items": {"$ref": "#/$defs/symptom_fact"},
            },
            "conditions": {
                "type": "object",
                "additionalProperties": False,
                "required": ["temperature_c", "humidity", "environment"],
                "properties": {
                    "temperature_c": {"$ref": "#/$defs/value_fact_number_array"},
                    "humidity": {"$ref": "#/$defs/value_fact_string"},
                    "environment": {
                        "type": "array",
                        "items": {"$ref": "#/$defs/text_fact"},
                    },
                },
            },
            "severity": {"$ref": "#/$defs/value_fact_string"},
            "treatment": {
                "type": "object",
                "additionalProperties": False,
                "required": ["organic", "chemical", "cultural"],
                "properties": {
                    "organic": {"type": "array", "items": {"$ref": "#/$defs/treatment_fact"}},
                    "chemical": {"type": "array", "items": {"$ref": "#/$defs/treatment_fact"}},
                    "cultural": {"type": "array", "items": {"$ref": "#/$defs/treatment_fact"}},
                },
            },
            "prevention": {
                "type": "array",
                "items": {"$ref": "#/$defs/text_fact"},
            },
        },
        "$defs": {
            "evidence": {
                "type": "object",
                "additionalProperties": False,
                "required": ["source_name", "source_url", "quote", "field"],
                "properties": {
                    "source_name": {"type": "string"},
                    "source_url": {"type": "string"},
                    "quote": {"type": "string"},
                    "field": {"type": "string"},
                },
            },
            "value_fact_string": {
                "type": "object",
                "additionalProperties": False,
                "required": ["value", "evidence"],
                "properties": {
                    "value": {"type": "string"},
                    "evidence": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
                },
            },
            "pathogen_type_fact": {
                "type": "object",
                "additionalProperties": False,
                "required": ["value", "evidence"],
                "properties": {
                    "value": {"type": "string", "enum": sorted(PATHOGEN_TYPES)},
                    "evidence": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
                },
            },
            "value_fact_number_array": {
                "type": "object",
                "additionalProperties": False,
                "required": ["value", "evidence"],
                "properties": {
                    "value": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 0,
                        "maxItems": 2,
                    },
                    "evidence": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
                },
            },
            "text_fact": {
                "type": "object",
                "additionalProperties": False,
                "required": ["description", "evidence"],
                "properties": {
                    "description": {"type": "string"},
                    "evidence": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
                },
            },
            "symptom_fact": {
                "type": "object",
                "additionalProperties": False,
                "required": ["stage", "description", "evidence"],
                "properties": {
                    "stage": {"type": "string"},
                    "description": {"type": "string"},
                    "evidence": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
                },
            },
            "treatment_fact": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "evidence", "regions"],
                "properties": {
                    "name": {"type": "string"},
                    "evidence": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
                    "regions": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    },
    "strict": True,
}


@dataclass(frozen=True)
class ExtractionRequest:
    crop: str
    disease: str
    source_name: str
    source_url: str
    prompt: str
    schema: dict[str, Any]


class LLMProvider(Protocol):
    def extract_json(self, request: ExtractionRequest) -> dict[str, Any]:
        """Return a JSON object matching ``request.schema``."""


def build_extraction_request(
    source: SourceDocument,
    chunks: list[dict[str, Any]] | None = None,
) -> ExtractionRequest:
    context = _context_text(source, chunks)
    prompt = f"""Extract agronomy facts for a Couchbase Lite disease profile.

Rules:
- Return JSON matching the supplied schema.
- Extract only facts explicitly supported by the source text or retrieved chunks.
- Every non-empty extracted fact must include evidence with an exact short quote.
- Do not invent pesticide chemicals, dosages, schedules, regions, or advice.
- Use empty strings or empty arrays when a field is not stated.
- Chemical treatments must be active ingredients, not product brands.

Crop: {source.crop}
Disease: {source.disease}
Source name: {source.name}
Source URL: {source.url}

Context:
{context}
"""
    return ExtractionRequest(
        crop=source.crop,
        disease=source.disease,
        source_name=source.name,
        source_url=source.url,
        prompt=prompt,
        schema=EXTRACTION_SCHEMA,
    )


def request_to_json(request: ExtractionRequest) -> str:
    return json.dumps(
        {
            "crop": request.crop,
            "disease": request.disease,
            "source_name": request.source_name,
            "source_url": request.source_url,
            "prompt": request.prompt,
            "schema": request.schema,
        },
        indent=2,
        sort_keys=True,
    )


def _context_text(source: SourceDocument, chunks: list[dict[str, Any]] | None) -> str:
    if not chunks:
        return source.raw_text
    lines = []
    for index, chunk in enumerate(chunks, start=1):
        lines.append(f"[chunk {index} | {chunk['source_name']} | {chunk['source_url']}]\n{chunk['text']}")
    return "\n\n".join(lines)


class OpenAILLMProvider:
    """LLMProvider backed by the OpenAI API, using structured outputs to enforce EXTRACTION_SCHEMA.

    Requires the optional ``openai`` dependency (``pip install agronomy-disease-pipeline[llm]``)
    and an ``OPENAI_API_KEY`` environment variable. Never reads tests-only or hardcoded keys.
    """

    def __init__(self, model: str | None = None, max_tokens: int = 4096) -> None:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY is not set. Copy .env.example to .env and fill in a real key."
            )
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError(
                "the 'openai' package is required for OpenAILLMProvider: "
                "pip install agronomy-disease-pipeline[llm]"
            ) from exc
        self._client = OpenAI(api_key=api_key)
        self._model = model or os.environ.get("OPENAI_MODEL", "gpt-4o")
        self._max_tokens = max_tokens

    def extract_json(self, request: ExtractionRequest) -> dict[str, Any]:
        response = self._client.chat.completions.create(
            model=self._model,
            max_completion_tokens=self._max_tokens,
            messages=[{"role": "user", "content": request.prompt}],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": request.schema["name"],
                    "schema": request.schema["schema"],
                    "strict": True,
                },
            },
        )
        content = response.choices[0].message.content
        if content is None:
            raise RuntimeError("model response did not include structured output content")
        return json.loads(content)
