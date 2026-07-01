from __future__ import annotations

import json
from pathlib import Path

from agronomy_pipeline.ingestion import load_source_documents
from agronomy_pipeline.llm import build_extraction_request, request_to_json
from agronomy_pipeline.retrieval import build_chunk_index, search_chunks, write_chunk_index


def test_build_chunk_index_and_search_by_crop_disease() -> None:
    sources = load_source_documents(Path("data/sources"))
    chunks = build_chunk_index(sources, max_words=30, overlap_words=5, dimensions=32)

    assert chunks
    assert all(len(chunk["vector"]) == 32 for chunk in chunks)
    results = search_chunks(
        chunks,
        "water-soaked leaf lesions late blight",
        crop="tomato",
        disease="late blight",
        top_k=2,
    )

    assert results
    assert all(result["crop"] == "tomato" for result in results)
    assert all(result["disease"] == "late_blight" for result in results)
    assert results[0]["score"] > 0


def test_write_chunk_index_is_deterministic(tmp_path: Path) -> None:
    out_a = tmp_path / "a" / "chunks.json"
    out_b = tmp_path / "b" / "chunks.json"

    write_chunk_index(Path("data/sources"), out_a, max_words=30, overlap_words=5, dimensions=32)
    write_chunk_index(Path("data/sources"), out_b, max_words=30, overlap_words=5, dimensions=32)

    assert out_a.read_bytes() == out_b.read_bytes()


def test_llm_extraction_request_contains_schema_and_retrieved_context() -> None:
    source = next(
        item
        for item in load_source_documents(Path("data/sources"))
        if item.id == "tomato_late_blight"
    )
    chunks = search_chunks(
        build_chunk_index([source], max_words=30, overlap_words=5, dimensions=32),
        "chemical treatment",
        top_k=1,
    )

    request = build_extraction_request(source, chunks)
    body = json.loads(request_to_json(request))

    assert body["schema"]["strict"] is True
    assert body["schema"]["schema"]["additionalProperties"] is False
    assert "Every non-empty extracted fact must include evidence" in body["prompt"]
    assert "[chunk 1" in body["prompt"]
