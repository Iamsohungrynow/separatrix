from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any
from xml.etree import ElementTree

import httpx

logger = logging.getLogger("qubitalpha.ingestion.arxiv")

# arXiv API — free, no key required.  Returns Atom XML.
ARXIV_API_URL = "http://export.arxiv.org/api/query"

# Default search queries targeting crypto/DeFi-relevant research.
DEFAULT_QUERIES: list[str] = [
    "blockchain AND (DeFi OR decentralized finance)",
    "Solana AND (smart contract OR validator)",
    "large language model AND (trading OR financial)",
]

REQUEST_TIMEOUT = 15.0
MAX_RESULTS_PER_QUERY = 10

# Atom XML namespace
ATOM_NS = "http://www.w3.org/2005/Atom"


def _parse_entry(entry: ElementTree.Element) -> dict[str, str]:
    """Extract a raw_items-shaped dict from a single Atom <entry>."""
    entry_id = entry.findtext(f"{{{ATOM_NS}}}id", default="")
    title = entry.findtext(f"{{{ATOM_NS}}}title", default="").strip().replace("\n", " ")
    summary = entry.findtext(f"{{{ATOM_NS}}}summary", default="").strip().replace("\n", " ")
    published = entry.findtext(f"{{{ATOM_NS}}}published", default="")

    # Prefer the abstract page link; fall back to the <id> (which is also a URL).
    url = entry_id
    for link in entry.findall(f"{{{ATOM_NS}}}link"):
        if link.get("type") == "text/html":
            url = link.get("href", entry_id)
            break

    authors = ", ".join(
        name.text
        for author in entry.findall(f"{{{ATOM_NS}}}author")
        if (name := author.find(f"{{{ATOM_NS}}}name")) is not None and name.text
    )

    categories = ",".join(
        cat.get("term", "")
        for cat in entry.findall(f"{{{ATOM_NS}}}category")
        if cat.get("term")
    )

    return {
        "source": "arxiv",
        "url": url,
        "url_hash": hashlib.sha256(url.encode()).hexdigest(),
        "title": title,
        "content": summary,
        "published_at": published,
        "fetched_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "metadata": f'{{"authors": "{authors}", "categories": "{categories}"}}',
    }


async def fetch_arxiv(
    queries: list[str] | None = None,
    max_results: int = MAX_RESULTS_PER_QUERY,
) -> list[dict[str, str]]:
    """Fetch recent papers from arXiv matching the given search queries.

    Parameters
    ----------
    queries:
        arXiv search query strings.  When *None*, ``DEFAULT_QUERIES`` are used.
    max_results:
        Maximum papers per query.

    Returns
    -------
    list[dict[str, str]]
        One dict per paper, shaped to match the ``raw_items`` table columns.
        Duplicates (same URL) across queries are removed.
    """
    if queries is None:
        queries = DEFAULT_QUERIES

    seen_urls: set[str] = set()
    items: list[dict[str, str]] = []

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        for query in queries:
            params = {
                "search_query": query,
                "start": 0,
                "max_results": max_results,
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            }

            try:
                response = await client.get(ARXIV_API_URL, params=params)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                logger.warning("arxiv query failed (%s): %s", query[:40], exc)
                continue

            try:
                root = ElementTree.fromstring(response.text)
            except ElementTree.ParseError as exc:
                logger.warning("arxiv returned invalid XML for query %s: %s", query[:40], exc)
                continue

            for entry in root.findall(f"{{{ATOM_NS}}}entry"):
                item = _parse_entry(entry)
                if item["url"] in seen_urls:
                    continue
                seen_urls.add(item["url"])
                items.append(item)

    logger.info("fetched %d unique papers from arXiv across %d queries", len(items), len(queries))
    return items
