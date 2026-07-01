"""Authoritative source harvesting utilities."""

from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

from .ids import disease_profile_id, slugify


class UnsupportedDocumentError(ValueError):
    """Raised when a URL cannot be converted to text by the built-in harvester."""


@dataclass(frozen=True)
class SourceTarget:
    crop: str
    disease: str
    name: str
    url: str
    authority: str


def load_source_manifest(path: Path) -> list[SourceTarget]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [
        SourceTarget(
            crop=item["crop"],
            disease=item["disease"],
            name=item["name"],
            url=item["url"],
            authority=item.get("authority", "unknown"),
        )
        for item in data
    ]


def harvest_manifest(manifest_path: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for target in load_source_manifest(manifest_path):
        raw_text = fetch_clean_text(target.url)
        filename = f"{disease_profile_id(target.crop, target.disease)}_{slugify(target.name)}.json"
        path = out_dir / filename
        path.write_text(
            json.dumps(
                {
                    "crop": target.crop,
                    "disease": target.disease,
                    "source": {
                        "name": target.name,
                        "url": target.url,
                        "authority": target.authority,
                    },
                    "raw_text": raw_text,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        written.append(path)
    return written


def fetch_clean_text(url: str, timeout_seconds: int = 30) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "agronomy-disease-pipeline/0.1"})
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        content_type = response.headers.get("content-type", "")
        body = response.read()
    if "pdf" in content_type or url.lower().endswith(".pdf"):
        raise UnsupportedDocumentError("PDF extraction requires an external text extractor")
    encoding = "utf-8"
    match = re.search(r"charset=([\w.-]+)", content_type)
    if match:
        encoding = match.group(1)
    return html_to_text(body.decode(encoding, errors="replace"))


def html_to_text(html: str) -> str:
    parser = _TextHTMLParser()
    parser.feed(html)
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


class _TextHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self._ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self._ignored_depth:
            self._ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth and data.strip():
            self.parts.append(data.strip())
