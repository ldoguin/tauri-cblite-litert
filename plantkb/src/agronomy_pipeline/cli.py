"""Command-line entry point."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .llm import OpenAILLMProvider
from .pipeline import run_pipeline
from .report import build_coverage_report, write_coverage_report
from .retrieval import search_chunks, write_chunk_index
from .scraper import harvest_manifest
from .structurer import LLMStructurer


def _load_dotenv(path: Path = Path(".env")) -> None:
    """Populate os.environ from a .env file without overriding already-set vars."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()


def main() -> int:
    _load_dotenv()
    parser = argparse.ArgumentParser(prog="agronomy-pipeline")
    subparsers = parser.add_subparsers(dest="command", required=True)
    harvest = subparsers.add_parser("harvest", help="download source text from a URL manifest")
    harvest.add_argument("--manifest", required=True, type=Path)
    harvest.add_argument("--out", required=True, type=Path)
    run = subparsers.add_parser("run", help="generate Couchbase disease profile JSON")
    run.add_argument("--seed", required=True, type=Path)
    run.add_argument("--sources", required=True, type=Path)
    run.add_argument("--out", required=True, type=Path)
    run.add_argument("--version", default=1, type=int)
    run.add_argument(
        "--structurer",
        choices=["deterministic", "llm"],
        default="deterministic",
        help="'llm' calls OpenAI (requires OPENAI_API_KEY) instead of the offline extractor",
    )
    report = subparsers.add_parser("report", help="report seed/source coverage")
    report.add_argument("--seed", required=True, type=Path)
    report.add_argument("--sources", required=True, type=Path)
    report.add_argument("--manifest", type=Path)
    report.add_argument("--out", type=Path)
    index = subparsers.add_parser("index", help="build a local source chunk vector index")
    index.add_argument("--sources", required=True, type=Path)
    index.add_argument("--out", required=True, type=Path)
    index.add_argument("--max-words", default=90, type=int)
    index.add_argument("--overlap-words", default=15, type=int)
    index.add_argument("--dimensions", default=128, type=int)
    search = subparsers.add_parser("search", help="search a local source chunk vector index")
    search.add_argument("--index", required=True, type=Path)
    search.add_argument("--query", required=True)
    search.add_argument("--crop")
    search.add_argument("--disease")
    search.add_argument("--top-k", default=5, type=int)
    args = parser.parse_args()
    if args.command == "harvest":
        paths = harvest_manifest(args.manifest, args.out)
        print(f"harvested {len(paths)} source documents to {args.out}")
        return 0
    if args.command == "run":
        structurer = LLMStructurer(OpenAILLMProvider()) if args.structurer == "llm" else None
        profiles = run_pipeline(args.seed, args.sources, args.out, version=args.version, structurer=structurer)
        print(f"exported {len(profiles)} disease profiles to {args.out}")
        return 0
    if args.command == "report":
        report_data = build_coverage_report(args.seed, args.sources, args.manifest)
        print(write_coverage_report(report_data, args.out))
        return 0
    if args.command == "index":
        chunks = write_chunk_index(
            args.sources,
            args.out,
            max_words=args.max_words,
            overlap_words=args.overlap_words,
            dimensions=args.dimensions,
        )
        print(f"indexed {len(chunks)} source chunks to {args.out}")
        return 0
    if args.command == "search":
        chunks = json.loads(args.index.read_text(encoding="utf-8"))
        results = search_chunks(
            chunks,
            args.query,
            top_k=args.top_k,
            crop=args.crop,
            disease=args.disease,
        )
        print(json.dumps(results, indent=2, sort_keys=True))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
