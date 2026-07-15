from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger("leash.scoring.llm")

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"
REQUEST_TIMEOUT = 30.0

# Hard safety limits — keep Groq usage well within the free tier.
MAX_ITEMS_PER_BATCH = 5
MAX_BATCHES_PER_CYCLE = 3

PROMPT_TEMPLATE = """
You are scoring research and news for market impact on Solana ecosystem assets.

For each item below, evaluate its potential impact on the listed assets.
Return strict JSON only — an array of objects, one per item, with these fields:

- "item_index": integer, 0-based index of the item in the list below
- "asset": string, the most relevant tracked asset ticker (one of: {assets})
- "sentiment": float between -1.0 (very bearish) and 1.0 (very bullish)
- "confidence": float between 0.0 (no confidence) and 1.0 (very confident)
- "reasoning": string, one sentence explaining the score

If an item is irrelevant to all tracked assets, return sentiment 0.0 and confidence 0.0.

Items:
{items}

Return ONLY a JSON array. No markdown, no explanation, no preamble.
""".strip()


def _build_prompt(items: list[dict[str, str]], tracked_assets: list[str]) -> str:
    """Format the scoring prompt with the given items."""
    formatted = []
    for i, item in enumerate(items):
        title = item.get("title", "untitled")
        content = item.get("content", "")[:500]  # truncate to control token usage
        source = item.get("source", "unknown")
        formatted.append(f"[{i}] ({source}) {title}\n    {content}")

    return PROMPT_TEMPLATE.format(
        assets=", ".join(tracked_assets),
        items="\n".join(formatted),
    )


def _parse_scores(raw: str, item_count: int) -> list[dict[str, Any]]:
    """Parse the LLM JSON response into validated score dicts.

    Returns only well-formed entries. Malformed entries are dropped with a
    warning — fail narrow, not wide.
    """
    # Strip markdown code fences if present.
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
    if text.endswith("```"):
        text = text.rsplit("```", 1)[0]
    text = text.strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("LLM returned unparseable JSON: %.200s", text)
        return []

    if not isinstance(data, list):
        logger.warning("LLM returned non-array JSON: %s", type(data).__name__)
        return []

    valid: list[dict[str, Any]] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        try:
            idx = int(entry.get("item_index", -1))
            sentiment = float(entry.get("sentiment", 0.0))
            confidence = float(entry.get("confidence", 0.0))
            asset = str(entry.get("asset", ""))
            reasoning = str(entry.get("reasoning", ""))
        except (TypeError, ValueError):
            logger.debug("skipping malformed score entry: %s", entry)
            continue

        # Clamp values to valid ranges.
        sentiment = max(-1.0, min(1.0, sentiment))
        confidence = max(0.0, min(1.0, confidence))

        if idx < 0 or idx >= item_count:
            logger.debug("skipping score with out-of-range item_index: %d", idx)
            continue

        valid.append({
            "item_index": idx,
            "asset": asset,
            "sentiment": sentiment,
            "confidence": confidence,
            "reasoning": reasoning,
        })

    return valid


async def score_items(
    items: list[dict[str, str]] | None = None,
    tracked_assets: list[str] | None = None,
    groq_api_key: str = "",
    model: str = DEFAULT_MODEL,
) -> list[dict[str, Any]]:
    """Score ingested items for market sentiment using Groq.

    Parameters
    ----------
    items:
        Raw items to score (each should have ``title`` and ``content`` keys).
    tracked_assets:
        Tickers the LLM should evaluate against.
    groq_api_key:
        Groq API key.  If empty, returns ``[]`` — fail closed.
    model:
        Groq model ID to use.

    Returns
    -------
    list[dict[str, Any]]
        Scored items with ``item_index``, ``asset``, ``sentiment``,
        ``confidence``, and ``reasoning``.  Batched to respect rate limits.
    """
    if not items:
        return []

    if not groq_api_key:
        logger.warning("GROQ_API_KEY not set — skipping scoring (fail closed)")
        return []

    if tracked_assets is None:
        tracked_assets = ["SOL", "RNDR", "IO", "PYTH"]

    all_scores: list[dict[str, Any]] = []
    global_index_offset = 0

    # Process in batches to stay within rate limits.
    batches = [items[i:i + MAX_ITEMS_PER_BATCH] for i in range(0, len(items), MAX_ITEMS_PER_BATCH)]
    batches = batches[:MAX_BATCHES_PER_CYCLE]  # hard cap on batches per cycle

    if len(items) > MAX_ITEMS_PER_BATCH * MAX_BATCHES_PER_CYCLE:
        logger.info(
            "capping scoring to %d/%d items (%d batches)",
            MAX_ITEMS_PER_BATCH * MAX_BATCHES_PER_CYCLE,
            len(items),
            MAX_BATCHES_PER_CYCLE,
        )

    headers = {
        "Authorization": f"Bearer {groq_api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        for batch in batches:
            prompt = _build_prompt(batch, tracked_assets)

            payload = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens": 1024,
            }

            try:
                response = await client.post(GROQ_CHAT_URL, headers=headers, json=payload)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                logger.warning("Groq API call failed: %s", exc)
                global_index_offset += len(batch)
                continue

            body = response.json()
            choices = body.get("choices", [])
            if not choices:
                logger.warning("Groq returned empty choices")
                global_index_offset += len(batch)
                continue

            raw_content = choices[0].get("message", {}).get("content", "")
            batch_scores = _parse_scores(raw_content, len(batch))

            # Remap item_index to global offset.
            for score in batch_scores:
                score["item_index"] += global_index_offset
                score["model"] = model
                score["scored_at"] = (
                    datetime.now(timezone.utc)
                    .replace(microsecond=0)
                    .isoformat()
                    .replace("+00:00", "Z")
                )

            all_scores.extend(batch_scores)
            global_index_offset += len(batch)

    logger.info("scored %d items, got %d valid scores", len(items), len(all_scores))
    return all_scores
