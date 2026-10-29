import json
import re
import shutil
from pathlib import Path

import pytest

from catalog_desk.checks import HEADER_ONLY
from catalog_desk.listing import read
from catalog_desk.net import Recorded
from catalog_desk.sort import _verdict

ORACLE = Path(__file__).parent / "fixtures" / "pay-oracle"
ANSI = re.compile(r"\x1b\[[0-9;]*m")
PROVIDER = re.compile(r"providers/(?:[\w.-]+/)*([\w.-]+)")


def _stderr(fixture: Path) -> str:
    return ANSI.sub("", (fixture / "pay.stderr").read_text(encoding="utf-8"))


def _parent(fixture: Path) -> str:
    return PROVIDER.findall(_stderr(fixture))[0]


def _desk(fixture: Path, tmp_path: Path) -> dict[str, object]:
    parent = _parent(fixture)
    copy = tmp_path / parent
    shutil.copytree(fixture, copy)
    return _verdict(read(copy), Recorded.load(fixture / "recorded.json"), int(fixture.name), parent)


def _oracle(fixture: Path, verdict: dict[str, object]) -> None:
    code = int((fixture / "pay.exit").read_text(encoding="utf-8"))
    stderr = _stderr(fixture)
    if code == 0:
        assert verdict["verdict"] != "close"
    if code != 0 and "validation error" in stderr.lower():
        assert verdict["verdict"] != "pass"
    if code == 0 and verdict["verdict"] == "fix":
        brief = {k: v for k, _, v in (line.partition(": ") for line in str(verdict["brief"]).splitlines())}
        authed = any(line.endswith("(auth_required)") and f" {brief['current']} " in line for line in stderr.splitlines())
        assert brief["rule"] == HEADER_ONLY or authed


@pytest.mark.parametrize("pr", sorted(p.name for p in ORACLE.iterdir()))
def test_d2_to_d6_live_verdict_agrees_with_pay_and_desk_json(pr: str, tmp_path: Path):
    fixture = ORACLE / pr
    verdict = _desk(fixture, tmp_path)
    _oracle(fixture, verdict)
    recorded = json.loads((fixture / "desk.json").read_text(encoding="utf-8"))
    assert verdict["verdict"] == recorded["verdict"]
    if verdict["verdict"] == "fix":
        assert str(verdict["brief"]).splitlines()[2:6] == recorded["brief"].splitlines()
    if verdict["verdict"] == "close":
        assert (verdict["cause"], verdict["reason"]) == (recorded["cause"], recorded["reason"])


def test_d1_a_pay_pass_closed_by_the_desk_fails_the_oracle():
    recorded = json.loads((ORACLE / "37" / "desk.json").read_text(encoding="utf-8"))
    with pytest.raises(AssertionError):
        _oracle(ORACLE / "37", {**recorded, "verdict": "close"})
