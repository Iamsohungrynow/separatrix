from __future__ import annotations

import unittest

from agent.ingestion.arxiv import fetch_arxiv
from agent.ingestion.coingecko import fetch_fallback_prices
from agent.ingestion.jupiter_price import fetch_prices
from agent.ingestion.news_rss import fetch_news_rss


class IngestionPlaceholderTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_placeholder_fetchers_return_empty_shapes(self) -> None:
        self.assertEqual(await fetch_arxiv(), [])
        self.assertEqual(await fetch_news_rss(), [])
        self.assertEqual(await fetch_prices(), {})
        self.assertEqual(await fetch_fallback_prices(), {})


if __name__ == "__main__":
    unittest.main()
