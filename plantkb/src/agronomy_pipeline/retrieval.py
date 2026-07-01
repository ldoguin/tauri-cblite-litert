"""Deterministic source chunking and local vector-style retrieval."""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from .ids import slugify
from .ingestion import load_source_documents
from .models import SourceDocument


DEFAULT_VECTOR_DIMENSIONS = 128
TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9-]*")


def build_chunk_index(
    sources: list[SourceDocument],
    max_words: int = 90,
    overlap_words: int = 15,
    dimensions: int = DEFAULT_VECTOR_DIMENSIONS,
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for source in sorted(sources, key=lambda item: (item.crop, item.disease, item.name, item.url)):
        chunks.extend(chunk_source(source, max_words=max_words, overlap_words=overlap_words, dimensions=dimensions))
    return sorted(chunks, key=lambda item: item["id"])


def chunk_source(
    source: SourceDocument,
    max_words: int = 90,
    overlap_words: int = 15,
    dimensions: int = DEFAULT_VECTOR_DIMENSIONS,
) -> list[dict[str, Any]]:
    if max_words < 20:
        raise ValueError("max_words must be at least 20")
    if overlap_words < 0 or overlap_words >= max_words:
        raise ValueError("overlap_words must be non-negative and smaller than max_words")

    sentences = _sentences(source.raw_text)
    chunks: list[dict[str, Any]] = []
    current: list[str] = []
    for sentence in sentences:
        sentence_words = sentence.split()
        if current and len(current) + len(sentence_words) > max_words:
            chunks.append(_chunk_dict(source, len(chunks), " ".join(current), dimensions))
            current = current[-overlap_words:] if overlap_words else []
        current.extend(sentence_words)
    if current:
        chunks.append(_chunk_dict(source, len(chunks), " ".join(current), dimensions))
    return chunks


def search_chunks(
    chunks: list[dict[str, Any]],
    query: str,
    top_k: int = 5,
    crop: str | None = None,
    disease: str | None = None,
) -> list[dict[str, Any]]:
    query_vector = embed_text(query, dimensions=_dimensions_for_chunks(chunks))
    crop_slug = slugify(crop) if crop else None
    disease_slug = slugify(disease) if disease else None
    scored: list[dict[str, Any]] = []
    for chunk in chunks:
        if crop_slug and chunk["crop"] != crop_slug:
            continue
        if disease_slug and chunk["disease"] != disease_slug:
            continue
        score = cosine_similarity(query_vector, chunk["vector"])
        if score > 0:
            scored.append({**chunk, "score": round(score, 4)})
    return sorted(scored, key=lambda item: (-item["score"], item["id"]))[:top_k]


def write_chunk_index(
    sources_dir: Path,
    out_path: Path,
    max_words: int = 90,
    overlap_words: int = 15,
    dimensions: int = DEFAULT_VECTOR_DIMENSIONS,
) -> list[dict[str, Any]]:
    sources = load_source_documents(sources_dir)
    chunks = build_chunk_index(
        sources,
        max_words=max_words,
        overlap_words=overlap_words,
        dimensions=dimensions,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(chunks, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return chunks


def embed_text(text: str, dimensions: int = DEFAULT_VECTOR_DIMENSIONS) -> list[float]:
    vector = [0.0] * dimensions
    for token in _tokens(text):
        index = _stable_bucket(token, dimensions)
        vector[index] += 1.0
    norm = math.sqrt(sum(value * value for value in vector))
    if not norm:
        return vector
    return [round(value / norm, 6) for value in vector]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        raise ValueError("vectors must have the same dimensions")
    return sum(left * right for left, right in zip(a, b))


def _chunk_dict(
    source: SourceDocument, chunk_index: int, text: str, dimensions: int
) -> dict[str, Any]:
    chunk_hash = hashlib.sha256(
        f"{source.name}\n{source.url}\n{chunk_index}\n{text}".encode("utf-8")
    ).hexdigest()[:16]
    return {
        "id": f"{source.id}:chunk:{chunk_hash}",
        "crop": slugify(source.crop),
        "disease": slugify(source.disease),
        "source_name": source.name,
        "source_url": source.url,
        "authority": source.authority,
        "chunk_index": chunk_index,
        "text": text,
        "vector_model": "local_hashing_v1",
        "vector": embed_text(text, dimensions=dimensions),
    }


def _sentences(text: str) -> list[str]:
    return [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", text)
        if sentence.strip()
    ]


def _tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def _stable_bucket(token: str, dimensions: int) -> int:
    digest = hashlib.sha256(token.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % dimensions


def _dimensions_for_chunks(chunks: list[dict[str, Any]]) -> int:
    if not chunks:
        return DEFAULT_VECTOR_DIMENSIONS
    return len(chunks[0]["vector"])
