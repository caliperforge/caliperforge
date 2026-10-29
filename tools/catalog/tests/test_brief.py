from pathlib import Path

import pytest

from catalog_desk import main
from catalog_desk.brief import STOP, render
from catalog_desk.checks import next_fix
from catalog_desk.listing import read
from catalog_desk.net import Recorded

FIXTURES = Path(__file__).parent / "fixtures"
DEVNET = FIXTURES / "devnet"


def test_d1_render_puts_id_and_listing_first_and_verify_and_reply_before_stop():
    fix = next_fix(read(DEVNET), Recorded.load(FIXTURES / "devnet.json"))
    assert fix is not None
    assert render(fix, 2, str(DEVNET)).splitlines() == [
        "brief: ps-0002-devnet-04",
        f"listing: {DEVNET}/PAY.md (PR #2)",
        "check: network",
        "rule: devnet only",
        f"current: {fix.current}",
        "replacement: a stablecoin offer on Solana mainnet",
        f"verify: pay catalog next {DEVNET}/PAY.md",
        "reply: fixed | disputed, using the reply block",
        STOP,
    ]


def test_d1_next_prints_the_same_brief_on_two_runs(capsys: pytest.CaptureFixture[str]):
    net = Recorded.load(FIXTURES / "devnet.json")
    outs = []
    for _ in range(2):
        assert main(["next", str(DEVNET / "PAY.md"), "--pr", "2"], net) == 0
        outs.append(capsys.readouterr().out)
    assert outs[0] == outs[1]
    assert outs[0].startswith(f"brief: ps-0002-devnet-04\nlisting: {DEVNET}/PAY.md (PR #2)\n")


def test_no_fix_is_still_green():
    assert render(None, 2, "x") == "green"
