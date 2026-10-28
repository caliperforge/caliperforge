import json
import shutil
from pathlib import Path

import pytest

from catalog_desk.brief import STOP, render
from catalog_desk.checks import HEADER_ONLY, next_fix
from catalog_desk.listing import Listing, read
from catalog_desk.net import Recorded

FIXTURES = Path(__file__).parent / "fixtures"


def _net(name: str) -> Recorded:
    return Recorded.load(FIXTURES / f"{name}.json")


def _copy(name: str, to: Path) -> Path:
    return Path(shutil.copytree(FIXTURES / name, to / name))


def _set_paths(dir: Path, paths: dict[str, object]) -> None:
    spec = json.loads((dir / "openapi.json").read_text(encoding="utf-8"))
    (dir / "openapi.json").write_text(json.dumps({**spec, "paths": paths}), encoding="utf-8")


def test_d1_format_fail_then_offer_once_the_summary_fits(tmp_path: Path):
    net = Recorded({}, set(), {})
    brief = render(next_fix(read(FIXTURES / "format-fail"), net)).splitlines()
    assert brief[:3] == ["check: format", "rule: GET /paid summary is 10 characters", "current: Pays a fee"]
    spec = _copy("format-fail", tmp_path) / "openapi.json"
    spec.write_text(spec.read_text(encoding="utf-8").replace("Pays a fee", "x" * 24), encoding="utf-8")
    fix = next_fix(read(spec.parent), net)
    assert fix is not None and (fix.check, fix.rule) == ("offer", "dead domain")


def test_d2_asked_above_listed_stops_then_listing_the_asked_price_is_green(tmp_path: Path):
    net = _net("asked-above")
    brief = render(next_fix(read(FIXTURES / "asked-above"), net)).splitlines()
    assert brief[:2] == ["check: price", "rule: price listed $0.001 vs asked $0.01"]
    assert brief[-1] == STOP
    raised = _copy("asked-above", tmp_path)
    _set_paths(raised, {"/paid": {"get": {"x-price-usd": 0.01}}})
    assert render(next_fix(read(raised), net)) == "green"


def test_d3_a_payee_with_no_usdc_account_stops():
    brief = render(next_fix(read(FIXTURES / "no-usdc"), _net("no-usdc"))).splitlines()
    assert brief[:2] == ["check: payee", "rule: recipient has no USDC token account"]
    assert brief[-1] == STOP


def test_d4_dropping_get_paid_is_declared_less_though_all_else_passes(tmp_path: Path):
    before = read(FIXTURES / "no-usdc")
    assert isinstance(before, Listing)
    dropped = _copy("no-usdc", tmp_path)
    _set_paths(dropped, {})
    net = _net("no-usdc")
    assert next_fix(read(dropped), net) is None
    fix = next_fix(read(dropped), net, before)
    assert fix is not None
    assert (fix.check, fix.current, fix.replacement) == ("declared_less", "GET /paid", "restore GET /paid")


@pytest.mark.parametrize(("name", "rule"), [("name: devnet\n", "name=devnet but parent directory is renamed"), ("", "name= but parent directory is renamed")])
def test_a_name_unlike_its_directory_is_a_format_fix(tmp_path: Path, name: str, rule: str):
    renamed = Path(shutil.copytree(FIXTURES / "devnet", tmp_path / "renamed"))
    pay = renamed / "PAY.md"
    pay.write_text(pay.read_text(encoding="utf-8").replace("name: devnet\n", name), encoding="utf-8")
    fix = next_fix(read(renamed), _net("devnet"))
    assert fix is not None and (fix.check, fix.rule) == ("format", rule)


def test_a_short_endpoint_description_is_a_format_fix(tmp_path: Path):
    pay = _copy("endpoints-only", tmp_path) / "PAY.md"
    pay.write_text(pay.read_text(encoding="utf-8").replace("Lists the invoices issued to the paying account.", "x" * 10), encoding="utf-8")
    brief = render(next_fix(read(pay.parent), Recorded({}, set(), {}))).splitlines()
    assert brief[:2] == ["check: format", "rule: GET /v1/invoices description is 10 characters"]


def test_endpoints_only_pricing_is_read_per_endpoint():
    asked = _net("asked-above").fetches["GET https://api.example.com/paid"]
    urls = ("https://endpoints.example.com/api/v1/invoices", "https://endpoints.example.com/api/v1/receipts")
    net = Recorded({f"GET {url}": asked for url in urls}, {"endpoints.example.com"}, {})
    fix = next_fix(read(FIXTURES / "endpoints-only"), net)
    assert fix is not None and (fix.check, fix.rule) == ("price", "price listed $0.001 vs asked $0.01")


def test_d5_devnet_stops_at_network_and_header_only_fails_offer():
    devnet = render(next_fix(read(FIXTURES / "devnet"), _net("devnet"))).splitlines()
    assert devnet[:2] == ["check: network", "rule: devnet only"]
    assert devnet[-1] == STOP
    fix = next_fix(read(FIXTURES / "header-only"), _net("header-only"))
    assert fix is not None and (fix.check, fix.rule, fix.server) == ("offer", HEADER_ONLY, False)
