from pathlib import Path

import pytest
import yaml

from catalog_desk.listing import RANGES, URL_ONLY, Fault, Invalid, Listing, faults, read

FORMAT_FAIL = Path(__file__).parent / "fixtures" / "format-fail"
GOOD = {
    "service_url": "https://api.example.com",
    "title": "Example",
    "description": "A description.",
    "use_case": "A use case.",
    "pr": 7,
    "openapi": {"path": "openapi.json"},
}
BAD = {"service_url": 1, "title": 2, "description": 3, "use_case": 4, "pr": "seven", "openapi": {}}
FIELDS = ["service_url", "title", "description", "use_case", "pr", "openapi.path"]


def _write(dir: Path, front: dict[str, object]) -> None:
    (dir / "PAY.md").write_text(f"---\n{yaml.safe_dump(front)}---\n", encoding="utf-8")


def test_d2_no_front_matter_summary_is_measured():
    listing = read(FORMAT_FAIL)
    assert isinstance(listing, Listing)
    assert listing.front["pr"] == 0
    assert faults(listing.front) == []
    assert "summary" not in RANGES


def test_d2_absent_or_non_string_measures_0_in_code_points():
    front: dict[str, object] = {"summary": "x", "description": 64, "use_case": "🙂" * 256}
    assert faults(front) == [Fault("description", (64, 255), 0), Fault("use_case", (32, 255), 256)]
    assert faults({}) == [Fault(field, span, 0) for field, span in RANGES.items()]


@pytest.mark.parametrize(("openapi", "why"), [({"url": "https://api.example.com/openapi.json"}, URL_ONLY), ({}, "missing")])
def test_d3_d4_url_only_openapi_is_its_own_invalid(tmp_path: Path, openapi: dict[str, str], why: str):
    _write(tmp_path, {**GOOD, "openapi": openapi})
    assert read(tmp_path) == Invalid("openapi.path", why)


def test_d2_the_first_failing_field_wins(tmp_path: Path):
    keys = list(BAD)
    for i, field in enumerate(FIELDS):
        _write(tmp_path, {**GOOD, **{key: BAD[key] for key in keys[i:]}})
        invalid = read(tmp_path)
        assert isinstance(invalid, Invalid) and invalid.field == field


@pytest.mark.parametrize("pay", ["no front matter\n", "---\ntitle: [unclosed\n---\n"])
def test_d2_no_or_broken_front_matter_names_pay_md(tmp_path: Path, pay: str):
    (tmp_path / "PAY.md").write_text(pay, encoding="utf-8")
    invalid = read(tmp_path)
    assert isinstance(invalid, Invalid) and invalid.field == "PAY.md"


@pytest.mark.parametrize("spec", [None, "not json"])
def test_d2_an_unreadable_openapi_names_its_path(tmp_path: Path, spec: str | None):
    _write(tmp_path, GOOD)
    if spec is not None:
        (tmp_path / "openapi.json").write_text(spec, encoding="utf-8")
    invalid = read(tmp_path)
    assert isinstance(invalid, Invalid) and invalid.field == "openapi.path"
