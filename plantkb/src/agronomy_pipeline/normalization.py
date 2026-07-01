"""Normalization helpers used before merge and export."""

from __future__ import annotations

import re
from typing import Iterable

from .ids import slugify


CROP_ALIASES = {
    "tomatoes": "tomato",
    "lycopersicon": "tomato",
    "solanum lycopersicum": "tomato",
    "potatoes": "potato",
}

CHEMICAL_ALIASES = {
    "copper fungicides": "copper",
    "chlorothalonil fungicide": "chlorothalonil",
}


def normalize_crop(value: str) -> str:
    cleaned = _clean_phrase(value)
    return CROP_ALIASES.get(cleaned, slugify(cleaned))


def normalize_disease(value: str) -> str:
    return slugify(_clean_phrase(value))


def normalize_phrase(value: str) -> str:
    return _clean_phrase(value)


def normalize_chemical(value: str) -> str:
    cleaned = _clean_phrase(value)
    return CHEMICAL_ALIASES.get(cleaned, cleaned)


def unique_ordered(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        cleaned = _clean_phrase(value)
        if cleaned and cleaned not in seen:
            result.append(cleaned)
            seen.add(cleaned)
    return result


def _clean_phrase(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"\s+", " ", value)
    return value.strip(" .;:,")
