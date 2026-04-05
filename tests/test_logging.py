from __future__ import annotations

import logging
import unittest

from agent.utils.logging import configure_logging


class LoggingTestCase(unittest.TestCase):
    def test_configure_logging_reapplies_requested_level(self) -> None:
        configure_logging("warning")
        self.assertEqual(logging.getLogger().getEffectiveLevel(), logging.WARNING)

        configure_logging("debug")
        self.assertEqual(logging.getLogger().getEffectiveLevel(), logging.DEBUG)

    def test_invalid_level_falls_back_to_info(self) -> None:
        configure_logging("not-a-real-level")
        self.assertEqual(logging.getLogger().getEffectiveLevel(), logging.INFO)


if __name__ == "__main__":
    unittest.main()
