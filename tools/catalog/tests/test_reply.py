import subprocess
from pathlib import Path

import pytest
from test_sort import FIXTURES, _head, _listing, _repo

from catalog_desk import main
from catalog_desk.net import Recorded
from catalog_desk.reply import Refused, check
from catalog_desk.sort import sort

GREEN = {"/paid": {"get": {"x-price-usd": 0.01}}}


def _net() -> Recorded:
    asked, devnet = Recorded.load(FIXTURES / "asked-above.json"), Recorded.load(FIXTURES / "devnet.json")
    return Recorded({**asked.fetches, **devnet.fetches}, asked.hosts | devnet.hosts, {})


def _sha(repo: Path, ref: str) -> str:
    return subprocess.run(["git", "-C", str(repo), "rev-parse", ref], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    repo = _repo(tmp_path)
    _head(repo, 1, _listing("asked-above", "skills/paid"), "skills/paid")
    _head(repo, 2, _listing("devnet", "skills/devnet"), "skills/devnet")
    return repo


def _fixed(brief: str, commit: str) -> str:
    return f"brief: {brief}\nstatus: fixed\nchanged: listed price\n{commit}verify output:\n  green\n"


@pytest.mark.parametrize("commit", ["", "commit:\n"])
def test_d2_a_fixed_reply_without_a_commit_is_refused(repo: Path, commit: str):
    rows = sort(repo, _net())
    assert check(_fixed("ps-0002-devnet-04", commit), rows, repo, _net()) == Refused("commit missing")


def test_d2_reply_prints_the_refusal_and_exits_1(repo: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    assert main(["sort", str(repo)], _net()) == 0
    (tmp_path / "sorted.jsonl").write_text(capsys.readouterr().out, encoding="utf-8")
    (tmp_path / "reply.txt").write_text(_fixed("ps-0002-devnet-04", ""), encoding="utf-8")
    assert main(["reply", str(repo), str(tmp_path / "sorted.jsonl"), str(tmp_path / "reply.txt")], _net()) == 1
    assert capsys.readouterr().out == "refused: commit missing\n"


def test_d3_a_commit_that_still_fails_the_same_check_is_not_fixed(repo: Path):
    rows = sort(repo, _net())
    reply = _fixed("ps-0002-devnet-04", f"commit: {_sha(repo, 'refs/pull/2/head')}\n")
    assert check(reply, rows, repo, _net()) == Refused("not fixed")


def test_d4_a_commit_that_reruns_green_is_accepted(repo: Path):
    rows = sort(repo, _net())
    _head(repo, 1, _listing("asked-above", "skills/paid", paths=GREEN), "skills/paid")
    commit = _sha(repo, "refs/pull/1/head")
    reply = f"brief: ps-0001-paid-05\nstatus: fixed\nchanged: listed price\ncommit: {commit}\nverify output:\n  green\n  done\n"
    assert check(reply, rows, repo, _net()) == {
        "brief": "ps-0001-paid-05",
        "status": "fixed",
        "changed": "listed price",
        "commit": commit,
        "verify output": "green\ndone",
    }


def test_d4_a_disputed_reply_is_printed_as_its_record(repo: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    assert main(["sort", str(repo)], _net()) == 0
    (tmp_path / "sorted.jsonl").write_text(capsys.readouterr().out, encoding="utf-8")
    (tmp_path / "reply.txt").write_text("brief: ps-0002-devnet-04\nstatus: disputed\nreason: devnet is our test tier\n", encoding="utf-8")
    assert main(["reply", str(repo), str(tmp_path / "sorted.jsonl"), str(tmp_path / "reply.txt")], _net()) == 0
    out = capsys.readouterr().out
    assert out == '{"brief": "ps-0002-devnet-04", "status": "disputed", "reason": "devnet is our test tier"}\n'


@pytest.mark.parametrize(
    ("reply", "why"),
    [
        ("status: disputed\nreason: r\n", "brief missing"),
        ("brief: ps-0099-x-01\nstatus: disputed\nreason: r\n", "unknown brief ps-0099-x-01"),
        ("brief: ps-0002-devnet-04\nreason: r\n", "status missing"),
        ("brief: ps-0002-devnet-04\nstatus: done\n", "status must be fixed or disputed"),
        ("brief: ps-0002-devnet-04\nstatus: disputed\nreason:\n", "reason missing"),
    ],
)
def test_d5_a_reply_missing_its_header_is_refused_in_order(repo: Path, reply: str, why: str):
    assert check(reply, sort(repo, _net()), repo, _net()) == Refused(why)
