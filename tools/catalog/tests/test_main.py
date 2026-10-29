from pathlib import Path

import pytest

from catalog_desk import main
from catalog_desk.net import Recorded

FIXTURES = Path(__file__).parent / "fixtures"


def test_no_command_exits_2():
    with pytest.raises(SystemExit) as exited:
        main([])
    assert exited.value.code == 2


@pytest.mark.parametrize("name", ["format-fail", "header-only", "devnet", "asked-above", "no-usdc", "endpoints-only", "inline-content"])
def test_d6_next_prints_exactly_one_brief(name: str, capsys: pytest.CaptureFixture[str]):
    recorded = FIXTURES / f"{name}.json"
    net = Recorded.load(recorded) if recorded.exists() else Recorded({}, set(), {})
    assert main(["next", str(FIXTURES / name / "PAY.md"), "--pr", "1"], net) == 0
    assert capsys.readouterr().out.count("check: ") == 1


def test_next_probes_an_endpoints_only_listing(capsys: pytest.CaptureFixture[str]):
    net = Recorded.load(FIXTURES / "endpoints-only.json")
    assert main(["next", str(FIXTURES / "endpoints-only" / "PAY.md"), "--pr", "1"], net) == 0
    out = capsys.readouterr().out
    assert out.splitlines()[2:5] == ["check: offer", "rule: HTTP 401", "current: GET /v1/invoices"]
    assert "openapi.path" not in out


def test_next_reads_the_summary_of_inline_content(capsys: pytest.CaptureFixture[str]):
    assert main(["next", str(FIXTURES / "inline-content" / "PAY.md"), "--pr", "1"], Recorded({}, set(), {})) == 0
    assert capsys.readouterr().out.splitlines()[2:4] == ["check: format", "rule: GET /paid summary is 10 characters"]
