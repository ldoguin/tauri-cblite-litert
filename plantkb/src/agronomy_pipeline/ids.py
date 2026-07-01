"""Stable identifier helpers."""

from __future__ import annotations

import re


_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def slugify(value: str) -> str:
    """Return a deterministic lowercase slug."""
    slug = _NON_ALNUM.sub("_", value.strip().lower()).strip("_")
    return re.sub(r"_+", "_", slug)


def disease_profile_id(crop: str, disease: str) -> str:
    return f"{slugify(crop)}_{slugify(disease)}"
