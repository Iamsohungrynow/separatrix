from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch, MagicMock

import httpx

from agent.ingestion.arxiv import fetch_arxiv
from agent.ingestion.coingecko import fetch_fallback_prices, COINGECKO_IDS
from agent.ingestion.jupiter_price import fetch_prices, TOKEN_MINTS
from agent.ingestion.news_rss import fetch_news_rss


# ---------------------------------------------------------------------------
# arXiv fetcher
# ---------------------------------------------------------------------------

SAMPLE_ARXIV_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>DeFi Yield Optimization on Solana</title>
    <summary>We present a novel approach to yield optimization.</summary>
    <published>2026-04-01T00:00:00Z</published>
    <link href="http://arxiv.org/abs/2401.00001v1" type="text/html" />
    <author><name>Alice Nakamoto</name></author>
    <category term="cs.CR" />
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <title>LLM Trading Agents: A Survey</title>
    <summary>A comprehensive survey on LLM-driven trading systems.</summary>
    <published>2026-03-28T00:00:00Z</published>
    <link href="http://arxiv.org/abs/2401.00002v1" type="text/html" />
    <author><name>Bob Vitalik</name></author>
    <author><name>Carol Zhang</name></author>
    <category term="cs.AI" />
    <category term="q-fin.TR" />
  </entry>
</feed>
"""


def _mock_arxiv_response(xml: str) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.text = xml
    return resp


class ArxivTestCase(unittest.IsolatedAsyncioTestCase):
    """Tests for the arXiv ingestion client (HTTP mocked)."""

    @patch("agent.ingestion.arxiv.httpx.AsyncClient")
    async def test_parses_entries_correctly(self, mock_client_cls: MagicMock) -> None:
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_arxiv_response(SAMPLE_ARXIV_XML)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = await fetch_arxiv(queries=["test query"])

        self.assertEqual(len(items), 2)

        first = items[0]
        self.assertEqual(first["source"], "arxiv")
        self.assertEqual(first["url"], "http://arxiv.org/abs/2401.00001v1")
        self.assertEqual(first["title"], "DeFi Yield Optimization on Solana")
        self.assertIn("yield optimization", first["content"])
        self.assertEqual(first["published_at"], "2026-04-01T00:00:00Z")
        self.assertIn("Alice Nakamoto", first["metadata"])
        self.assertTrue(first["url_hash"])  # non-empty hash

        second = items[1]
        self.assertIn("Bob Vitalik", second["metadata"])
        self.assertIn("Carol Zhang", second["metadata"])
        self.assertIn("cs.AI", second["metadata"])

    @patch("agent.ingestion.arxiv.httpx.AsyncClient")
    async def test_deduplicates_across_queries(self, mock_client_cls: MagicMock) -> None:
        """Same paper appearing in two queries should only appear once."""
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_arxiv_response(SAMPLE_ARXIV_XML)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = await fetch_arxiv(queries=["query1", "query2"])

        # Two queries returning the same 2 papers → still 2 unique items
        self.assertEqual(len(items), 2)
        self.assertEqual(mock_client.get.call_count, 2)

    @patch("agent.ingestion.arxiv.httpx.AsyncClient")
    async def test_http_error_skips_query(self, mock_client_cls: MagicMock) -> None:
        """A failing query is skipped; others still return results."""
        ok_resp = _mock_arxiv_response(SAMPLE_ARXIV_XML)
        fail_resp = httpx.HTTPStatusError("fail", request=MagicMock(), response=MagicMock(status_code=500))

        mock_client = AsyncMock()
        mock_client.get.side_effect = [fail_resp, ok_resp]
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = await fetch_arxiv(queries=["bad", "good"])

        self.assertEqual(len(items), 2)  # only the "good" query's results

    @patch("agent.ingestion.arxiv.httpx.AsyncClient")
    async def test_empty_feed_returns_empty(self, mock_client_cls: MagicMock) -> None:
        empty_xml = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_arxiv_response(empty_xml)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = await fetch_arxiv(queries=["empty"])

        self.assertEqual(items, [])


# ---------------------------------------------------------------------------
# Google News RSS fetcher
# ---------------------------------------------------------------------------

SAMPLE_RSS_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Solana DeFi - Google News</title>
    <item>
      <title>Solana TVL Hits New High</title>
      <link>https://example.com/solana-tvl</link>
      <description>Total value locked in Solana DeFi protocols reached a new milestone.</description>
      <pubDate>Mon, 06 Apr 2026 12:00:00 GMT</pubDate>
      <source url="https://example.com">CryptoNews</source>
    </item>
    <item>
      <title>New AI Trading Bot Launches on Solana</title>
      <link>https://example.com/ai-trading-bot</link>
      <description>An AI-powered trading agent goes live.</description>
      <pubDate>Sun, 05 Apr 2026 08:30:00 GMT</pubDate>
      <source url="https://example2.com">DeFi Daily</source>
    </item>
  </channel>
</rss>
"""


def _mock_rss_response(xml: str) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.text = xml
    return resp


class NewsRssTestCase(unittest.IsolatedAsyncioTestCase):
    """Tests for the Google News RSS fetcher (HTTP mocked)."""

    @patch("agent.ingestion.news_rss.httpx.AsyncClient")
    async def test_parses_entries_correctly(self, mock_client_cls: MagicMock) -> None:
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_rss_response(SAMPLE_RSS_XML)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = await fetch_news_rss(search_terms=["Solana DeFi"])

        self.assertEqual(len(items), 2)

        first = items[0]
        self.assertEqual(first["source"], "google_news_rss")
        self.assertEqual(first["url"], "https://example.com/solana-tvl")
        self.assertEqual(first["title"], "Solana TVL Hits New High")
        self.assertIn("milestone", first["content"])
        self.assertTrue(first["url_hash"])
        self.assertTrue(first["fetched_at"])
        self.assertIn("Solana DeFi", first["metadata"])

    @patch("agent.ingestion.news_rss.httpx.AsyncClient")
    async def test_deduplicates_across_terms(self, mock_client_cls: MagicMock) -> None:
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_rss_response(SAMPLE_RSS_XML)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = await fetch_news_rss(search_terms=["term1", "term2"])

        self.assertEqual(len(items), 2)  # same 2 articles, deduplicated
        self.assertEqual(mock_client.get.call_count, 2)

    @patch("agent.ingestion.news_rss.httpx.AsyncClient")
    async def test_http_error_skips_term(self, mock_client_cls: MagicMock) -> None:
        ok_resp = _mock_rss_response(SAMPLE_RSS_XML)
        fail = httpx.HTTPStatusError("fail", request=MagicMock(), response=MagicMock(status_code=500))

        mock_client = AsyncMock()
        mock_client.get.side_effect = [fail, ok_resp]
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = await fetch_news_rss(search_terms=["bad", "good"])

        self.assertEqual(len(items), 2)

    @patch("agent.ingestion.news_rss.httpx.AsyncClient")
    async def test_empty_feed_returns_empty(self, mock_client_cls: MagicMock) -> None:
        empty_rss = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_rss_response(empty_rss)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = await fetch_news_rss(search_terms=["empty"])

        self.assertEqual(items, [])


# ---------------------------------------------------------------------------
# Jupiter price fetcher
# ---------------------------------------------------------------------------

def _mock_jupiter_response(data: dict) -> MagicMock:
    """Build a fake httpx.Response with the given data payload."""
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"data": data}
    return resp


class JupiterPriceTestCase(unittest.IsolatedAsyncioTestCase):
    """Tests for the real Jupiter price fetcher (HTTP mocked)."""

    @patch("agent.ingestion.jupiter_price.httpx.AsyncClient")
    async def test_fetch_all_default_assets(self, mock_client_cls: MagicMock) -> None:
        """Fetching with no args queries all TOKEN_MINTS and returns prices."""
        sol_mint = TOKEN_MINTS["SOL"]
        rndr_mint = TOKEN_MINTS["RNDR"]

        data = {
            sol_mint: {"id": sol_mint, "price": "148.32"},
            rndr_mint: {"id": rndr_mint, "price": "7.55"},
        }

        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_jupiter_response(data)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        prices = await fetch_prices()

        self.assertAlmostEqual(prices["SOL"], 148.32)
        self.assertAlmostEqual(prices["RNDR"], 7.55)
        # IO and PYTH weren't in the mock response → silently skipped
        self.assertNotIn("IO", prices)
        self.assertNotIn("PYTH", prices)

    @patch("agent.ingestion.jupiter_price.httpx.AsyncClient")
    async def test_fetch_specific_assets(self, mock_client_cls: MagicMock) -> None:
        """Only requested tickers are queried."""
        sol_mint = TOKEN_MINTS["SOL"]
        data = {sol_mint: {"id": sol_mint, "price": "150.00"}}

        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_jupiter_response(data)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        prices = await fetch_prices(assets=["SOL"])

        self.assertEqual(prices, {"SOL": 150.0})
        # Verify only SOL mint was in the request params
        call_kwargs = mock_client.get.call_args
        ids_param = call_kwargs.kwargs.get("params", call_kwargs.args[1] if len(call_kwargs.args) > 1 else {}).get("ids", "")
        self.assertIn(sol_mint, ids_param)
        self.assertNotIn(TOKEN_MINTS["RNDR"], ids_param)

    @patch("agent.ingestion.jupiter_price.httpx.AsyncClient")
    async def test_null_price_skipped(self, mock_client_cls: MagicMock) -> None:
        """Tokens with null prices are omitted from results."""
        sol_mint = TOKEN_MINTS["SOL"]
        data = {sol_mint: {"id": sol_mint, "price": None}}

        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_jupiter_response(data)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        prices = await fetch_prices(assets=["SOL"])

        self.assertEqual(prices, {})

    @patch("agent.ingestion.jupiter_price.httpx.AsyncClient")
    async def test_extra_mints(self, mock_client_cls: MagicMock) -> None:
        """Extra mint addresses can be passed for tokens not in the built-in map."""
        fake_mint = "FAKEaddress111111111111111111111111111111111"
        data = {fake_mint: {"id": fake_mint, "price": "1.23"}}

        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_jupiter_response(data)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        prices = await fetch_prices(
            assets=["BONK"],
            extra_mints={"BONK": fake_mint},
        )

        self.assertEqual(prices, {"BONK": 1.23})

    async def test_unknown_ticker_returns_empty(self) -> None:
        """Requesting an unknown ticker (no mint) returns empty without HTTP call."""
        prices = await fetch_prices(assets=["DOESNOTEXIST"])
        self.assertEqual(prices, {})

    @patch("agent.ingestion.jupiter_price.httpx.AsyncClient")
    async def test_http_error_propagates(self, mock_client_cls: MagicMock) -> None:
        """HTTP errors bubble up so callers can handle them."""
        mock_client = AsyncMock()
        mock_client.get.side_effect = httpx.HTTPStatusError(
            "Service Unavailable", request=MagicMock(), response=MagicMock(status_code=503)
        )
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        with self.assertRaises(httpx.HTTPStatusError):
            await fetch_prices(assets=["SOL"])


# ---------------------------------------------------------------------------
# CoinGecko fallback price fetcher
# ---------------------------------------------------------------------------

def _mock_coingecko_response(data: dict) -> MagicMock:
    """Build a fake httpx.Response with a CoinGecko-shaped payload."""
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = data
    return resp


class CoinGeckoTestCase(unittest.IsolatedAsyncioTestCase):
    """Tests for the CoinGecko fallback price fetcher (HTTP mocked)."""

    @patch("agent.ingestion.coingecko.httpx.AsyncClient")
    async def test_fetch_all_default_assets(self, mock_client_cls: MagicMock) -> None:
        data = {
            "solana": {"usd": 148.50},
            "render-token": {"usd": 7.60},
        }

        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_coingecko_response(data)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        prices = await fetch_fallback_prices()

        self.assertAlmostEqual(prices["SOL"], 148.50)
        self.assertAlmostEqual(prices["RNDR"], 7.60)
        self.assertNotIn("IO", prices)
        self.assertNotIn("PYTH", prices)

    @patch("agent.ingestion.coingecko.httpx.AsyncClient")
    async def test_fetch_specific_assets(self, mock_client_cls: MagicMock) -> None:
        data = {"solana": {"usd": 150.00}}

        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_coingecko_response(data)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        prices = await fetch_fallback_prices(assets=["SOL"])

        self.assertEqual(prices, {"SOL": 150.0})

    @patch("agent.ingestion.coingecko.httpx.AsyncClient")
    async def test_null_usd_price_skipped(self, mock_client_cls: MagicMock) -> None:
        data = {"solana": {"usd": None}}

        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_coingecko_response(data)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        prices = await fetch_fallback_prices(assets=["SOL"])

        self.assertEqual(prices, {})

    @patch("agent.ingestion.coingecko.httpx.AsyncClient")
    async def test_extra_ids(self, mock_client_cls: MagicMock) -> None:
        data = {"bonk": {"usd": 0.000023}}

        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_coingecko_response(data)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        prices = await fetch_fallback_prices(
            assets=["BONK"],
            extra_ids={"BONK": "bonk"},
        )

        self.assertAlmostEqual(prices["BONK"], 0.000023)

    async def test_unknown_ticker_returns_empty(self) -> None:
        prices = await fetch_fallback_prices(assets=["DOESNOTEXIST"])
        self.assertEqual(prices, {})

    @patch("agent.ingestion.coingecko.httpx.AsyncClient")
    async def test_http_error_propagates(self, mock_client_cls: MagicMock) -> None:
        mock_client = AsyncMock()
        mock_client.get.side_effect = httpx.HTTPStatusError(
            "Too Many Requests", request=MagicMock(), response=MagicMock(status_code=429)
        )
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        with self.assertRaises(httpx.HTTPStatusError):
            await fetch_fallback_prices(assets=["SOL"])


if __name__ == "__main__":
    unittest.main()
