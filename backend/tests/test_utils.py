"""Ticker normalization and money/quantity precision rules (§7, §8)."""

import re

import pytest

from app.utils import normalize_ticker, round_money, round_quantity, utc_now_iso

RFC3339_MS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class TestNormalizeTicker:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("aapl", "AAPL"),
            ("  aapl  ", "AAPL"),
            ("AAPL", "AAPL"),
            ("BRK.B", "BRK.B"),
            ("rds-a", "RDS-A"),
        ],
    )
    def test_accepts_and_normalizes_valid_tickers(self, raw, expected):
        assert normalize_ticker(raw) == expected

    @pytest.mark.parametrize("raw", ["", "   ", "12X", "AAPL1", "AA PL", "🚀", "A_B", None, 42])
    def test_rejects_invalid_input(self, raw):
        assert normalize_ticker(raw) is None


class TestRounding:
    def test_money_rounds_to_two_decimals(self):
        assert round_money(10.005678) == 10.01
        assert round_money(1899.999) == 1900.00

    def test_quantity_rounds_to_six_decimals(self):
        assert round_quantity(0.1234567) == 0.123457

    def test_rounding_always_returns_float(self):
        """round(0, 2) yields an int, which would leak `0` into JSON responses."""
        assert isinstance(round_money(0), float)
        assert isinstance(round_quantity(0), float)

    def test_repeated_rounding_is_stable(self):
        """Rounding on every write is what stops error accumulating across trades."""
        value = 10000.0
        for _ in range(100):
            value = round_money(value - 33.333333)
        assert value == round_money(value)


class TestTimestamps:
    def test_utc_now_iso_is_rfc3339_with_milliseconds(self):
        assert RFC3339_MS.match(utc_now_iso())

    def test_timestamps_are_monotonic_as_strings(self):
        """Lexicographic ordering must match chronological ordering, since
        history queries sort on the raw TEXT column."""
        stamps = [utc_now_iso() for _ in range(5)]
        assert stamps == sorted(stamps)
