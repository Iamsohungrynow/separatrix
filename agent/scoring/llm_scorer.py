from __future__ import annotations


PROMPT_TEMPLATE = """
You are scoring research and news for market impact on Solana ecosystem assets.
Return strict JSON only.
""".strip()


async def score_items() -> list[dict[str, float]]:
    """Placeholder for the future Groq integration."""

    return []
