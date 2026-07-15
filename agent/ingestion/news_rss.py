from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx
import feedparser

logger = logging.getLogger("leash.ingestion.news_rss")

# Google News RSS — free, no key required.
GOOGLE_NEWS_RSS_URL = "https://news.google.com/rss/search"

# Default search terms for crypto/DeFi news.
DEFAULT_SEARCH_TERMS: list[str] = [
    "Solana DeFi",
    "crypto AI trading",
    "Solana ecosystem news",
]

REQUEST_TIMEOUT = 15.0


def _parse_published(entry: dict) -> str:
    """Try to extract a UTC ISO timestamp from a feedparser entry."""
    raw = entry.get("published", "")
    if not raw:
        return ""
    try:
        dt = parsedate_to_datetime(raw)
        return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    except (ValueError, TypeError):
        return raw


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


async def fetch_news_rss(
    search_terms: list[str] | None = None,
) -> list[dict[str, str]]:
    """Fetch recent news articles from Google News RSS.

    Parameters
    ----------
    search_terms:
        Terms to search Google News for.  When *None*, ``DEFAULT_SEARCH_TERMS``
        are used.

    Returns
    -------
    list[dict[str, str]]
        One dict per article, shaped to match the ``raw_items`` table columns.
        Duplicates (same URL) across search terms are removed.
    """
    if search_terms is None:
        search_terms = DEFAULT_SEARCH_TERMS

    seen_urls: set[str] = set()
    items: list[dict[str, str]] = []
    fetched_at = _now_iso()

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        for term in search_terms:
            params = {"q": term, "hl": "en-US", "gl": "US", "ceid": "US:en"}

            try:
                response = await client.get(GOOGLE_NEWS_RSS_URL, params=params)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                logger.warning("news rss fetch failed (%s): %s", term, exc)
                continue

            feed = feedparser.parse(response.text)

            for entry in feed.entries:
                url = entry.get("link", "")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)

                title = entry.get("title", "").strip()
                summary = entry.get("summary", "").strip()
                source_name = entry.get("source", {}).get("title", "") if hasattr(entry.get("source", ""), "get") else ""

                items.append({
                    "source": "google_news_rss",
                    "url": url,
                    "url_hash": hashlib.sha256(url.encode()).hexdigest(),
                    "title": title,
                    "content": summary,
                    "published_at": _parse_published(entry),
                    "fetched_at": fetched_at,
                    "metadata": f'{{"search_term": "{term}", "source_name": "{source_name}"}}',
                })

    logger.info("fetched %d unique articles from Google News across %d terms", len(items), len(search_terms))
    return items
