import json
from pathlib import Path

import pytest
import yaml

from catalog_desk import main
from catalog_desk.listing import RANGES, URL_ONLY, Fault, Invalid, Listing, faults, read
from catalog_desk.net import Recorded

FIXTURES = Path(__file__).parent / "fixtures"
FORMAT_FAIL = Path(__file__).parent / "fixtures" / "format-fail"
ENDPOINTS_ONLY = Path(__file__).parent / "fixtures" / "endpoints-only"
SPEC = {"openapi": "3.0.0", "paths": {"/paid": {"get": {"summary": "Pays a fee"}}}}
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


@pytest.mark.parametrize(
    ("openapi", "why"), [({"url": "https://api.example.com/openapi.json"}, URL_ONLY), ({}, "missing"), ({"content": 5}, "missing")]
)
def test_d3_d4_url_only_openapi_is_its_own_invalid(tmp_path: Path, openapi: dict[str, object], why: str):
    _write(tmp_path, {**GOOD, "openapi": openapi})
    assert read(tmp_path) == Invalid("openapi.path", why)


def test_inline_json_content_is_the_spec():
    listing = read(FIXTURES / "inline-content")
    assert isinstance(listing, Listing)
    assert listing.spec == json.loads((FORMAT_FAIL / "openapi.json").read_text(encoding="utf-8"))


def test_inline_yaml_content_is_the_spec(tmp_path: Path):
    _write(tmp_path, {**GOOD, "openapi": {"content": yaml.safe_dump(SPEC)}})
    listing = read(tmp_path)
    assert isinstance(listing, Listing) and listing.spec == SPEC


def test_path_wins_over_content(tmp_path: Path):
    _write(tmp_path, {**GOOD, "openapi": {"path": "openapi.json", "content": json.dumps({"paths": {}})}})
    (tmp_path / "openapi.json").write_text(json.dumps(SPEC), encoding="utf-8")
    listing = read(tmp_path)
    assert isinstance(listing, Listing) and listing.spec == SPEC


def test_url_with_content_reads_the_content(tmp_path: Path):
    _write(tmp_path, {**GOOD, "openapi": {"url": "https://api.example.com/openapi.json", "content": json.dumps(SPEC)}})
    listing = read(tmp_path)
    assert isinstance(listing, Listing) and listing.spec == SPEC


def test_content_neither_json_nor_yaml_names_openapi_content(tmp_path: Path):
    broken = '{"openapi": "3.0.0", "paths": {'
    _write(tmp_path, {**GOOD, "openapi": {"content": broken}})
    with pytest.raises(yaml.YAMLError) as e:
        yaml.safe_load(broken)
    assert read(tmp_path) == Invalid("openapi.content", str(e.value))


@pytest.mark.parametrize("content", ["just text", "[1]", "5"])
def test_content_that_is_not_a_mapping_names_openapi_content(tmp_path: Path, content: str):
    _write(tmp_path, {**GOOD, "openapi": {"content": content}})
    assert read(tmp_path) == Invalid("openapi.content", "not a mapping")


def test_endpoints_only_reads_with_an_empty_spec(tmp_path: Path):
    endpoints = [{"method": "GET", "path": "/v1/invoices"}]
    _write(tmp_path, {**{k: v for k, v in GOOD.items() if k != "openapi"}, "endpoints": endpoints})
    listing = read(tmp_path)
    assert isinstance(listing, Listing) and listing.spec == {} and listing.dir == tmp_path.name


def test_a_relative_listing_dir_is_its_folder_name(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(ENDPOINTS_ONLY)
    listing = read(Path("PAY.md").parent)
    assert isinstance(listing, Listing) and listing.dir == "endpoints-only"


def test_next_on_a_relative_path_passes_the_name_check(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    net = Recorded.load(ENDPOINTS_ONLY.parent / "endpoints-only.json")
    monkeypatch.chdir(ENDPOINTS_ONLY)
    assert main(["next", "PAY.md"], net) == 0
    assert "check: format" not in capsys.readouterr().out


@pytest.mark.parametrize("endpoints", [None, [], [{"method": "GET"}], [{"method": 1, "path": "/x"}], ["GET /x"]])
def test_neither_openapi_nor_endpoints_is_missing(tmp_path: Path, endpoints: object):
    front = {k: v for k, v in GOOD.items() if k != "openapi"}
    _write(tmp_path, front if endpoints is None else {**front, "endpoints": endpoints})
    assert read(tmp_path) == Invalid("openapi.path", "missing")


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
