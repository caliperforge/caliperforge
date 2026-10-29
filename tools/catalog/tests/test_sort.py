import json
import re
import subprocess
from pathlib import Path

import pytest

from catalog_desk import main
from catalog_desk.brief import render
from catalog_desk.checks import next_fix
from catalog_desk.listing import URL_ONLY, Invalid, read
from catalog_desk.net import Recorded, Response

FIXTURES = Path(__file__).parent / "fixtures"
USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913"


def _git(repo: Path, *args: str, author: str = "catalog-desk") -> None:
    who = ["-c", f"user.name={author}", "-c", "user.email=desk@example.invalid"]
    subprocess.run(["git", "-C", str(repo), *who, *args], check=True, capture_output=True)


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "pay-skills"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _commit(repo, "main", _listing("no-usdc", "skills/old"), "skills/old")
    return repo


def _commit(repo: Path, message: str, files: dict[str, str], dir: str, author: str = "catalog-desk") -> None:
    for name, text in files.items():
        (repo / dir).mkdir(parents=True, exist_ok=True)
        (repo / dir / name).write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message, author=author)


def _head(repo: Path, pr: int, files: dict[str, str], dir: str, author: str = "catalog-desk") -> None:
    _git(repo, "checkout", "-q", "--detach", "main")
    _commit(repo, f"#{pr}", files, dir, author)
    _git(repo, "update-ref", f"refs/pull/{pr}/head", "HEAD")
    _git(repo, "checkout", "-q", "main")


def _listing(name: str, dir: str, url: str | None = None, paths: object = None) -> dict[str, str]:
    pay = (FIXTURES / name / "PAY.md").read_text(encoding="utf-8")
    spec = json.loads((FIXTURES / name / "openapi.json").read_text(encoding="utf-8"))
    pay = re.sub(r"name: .*", f"name: {dir.rsplit('/', 1)[-1]}", pay)
    if url is not None:
        pay = re.sub(r"service_url: .*", f"service_url: {url}", pay)
    if paths is not None:
        spec["paths"] = paths
    return {"PAY.md": pay, "openapi.json": json.dumps(spec)}


def _rows(repo: Path, net: Recorded, capsys: pytest.CaptureFixture[str]) -> list[dict[str, object]]:
    assert main(["sort", str(repo)], net) == 0
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_sort_writes_one_verdict_per_head_then_the_counts(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    repo = _repo(tmp_path)
    _head(repo, 1, _listing("asked-above", "skills/paid", paths={"/paid": {"get": {"x-price-usd": 0.01}}}), "skills/paid")
    _head(repo, 2, _listing("devnet", "skills/devnet"), "skills/devnet")
    _head(repo, 3, _listing("no-usdc", "skills/dead", url="https://dead.example.com"), "skills/dead")
    _head(repo, 4, _listing("asked-above", "skills/paid"), "skills/paid", "copier")
    _head(repo, 5, {"PAY.md": "title: Broken\n"}, "skills/broken")
    _head(repo, 6, _listing("devnet", "skills/base", url="https://base.example.com"), "skills/base")
    asked, devnet = Recorded.load(FIXTURES / "asked-above.json"), Recorded.load(FIXTURES / "devnet.json")
    offer = {"x402Version": 1, "accepts": [{"scheme": "exact", "network": "base", "maxAmountRequired": "10000", "asset": USDC_ON_BASE}]}
    fetches = {**asked.fetches, **devnet.fetches, "GET https://base.example.com/paid": Response(402, {}, json.dumps(offer))}
    net = Recorded(fetches, asked.hosts | devnet.hosts | {"base.example.com"}, {})
    brief = render(next_fix(read(FIXTURES / "devnet"), net), 2, "skills/devnet")
    assert brief.splitlines()[0] == "brief: ps-0002-devnet-04"
    assert "rule: devnet only" in brief.splitlines()
    assert _rows(repo, net, capsys) == [
        {"pr": 1, "listing": "skills/paid", "verdict": "pass"},
        {"pr": 2, "listing": "skills/devnet", "verdict": "fix", "id": "ps-0002-devnet-04", "brief": brief},
        {"pr": 3, "listing": "skills/dead", "verdict": "close", "cause": "dead domain", "reason": "https://dead.example.com"},
        {"pr": 4, "listing": "skills/paid", "verdict": "close", "cause": "duplicate", "reason": "of #1"},
        {"pr": 5, "listing": "skills/broken", "verdict": "close", "cause": "malformed", "reason": "PAY.md: no --- front matter"},
        {"pr": 6, "listing": "skills/base", "verdict": "close", "cause": "not Solana", "reason": "eip155:8453"},
        {"pass": 1, "fix": 1, "close": 4},
    ]


def test_sort_closes_by_listing_path_and_keeps_an_authors_newest(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    repo = _repo(tmp_path)
    _head(repo, 11, _listing("no-usdc", "skills/gen"), "skills/gen", "gentech")
    _head(repo, 12, _listing("no-usdc", "skills/gen"), "skills/gen", "gentech")
    _head(repo, 13, _listing("no-usdc", "skills/movie"), "skills/movie")
    _head(repo, 14, _listing("no-usdc", "skills/news"), "skills/news")
    _head(repo, 15, _listing("no-usdc", "skills/twin"), "skills/twin", "first")
    _head(repo, 16, _listing("no-usdc", "skills/twin"), "skills/twin", "second")
    dead = {"verdict": "close", "cause": "dead domain", "reason": "https://api.example.com"}
    assert _rows(repo, Recorded({}, set(), {}), capsys) == [
        {"pr": 11, "listing": "skills/gen", "verdict": "close", "cause": "superseded", "reason": "by #12"},
        {"pr": 12, "listing": "skills/gen", **dead},
        {"pr": 13, "listing": "skills/movie", **dead},
        {"pr": 14, "listing": "skills/news", **dead},
        {"pr": 15, "listing": "skills/twin", **dead},
        {"pr": 16, "listing": "skills/twin", "verdict": "close", "cause": "duplicate", "reason": "of #15"},
        {"pass": 0, "fix": 0, "close": 6},
    ]


def test_a_url_only_head_is_a_fix_and_openapi_empty_or_absent_closes(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    repo = _repo(tmp_path)
    pay = (FIXTURES / "no-usdc" / "PAY.md").read_text(encoding="utf-8")
    _head(repo, 8, {"PAY.md": pay.replace("path: openapi.json", "url: https://api.example.com/openapi.json")}, "skills/remote")
    _head(repo, 9, {"PAY.md": pay.replace("openapi:\n  path: openapi.json", "openapi: {}")}, "skills/empty")
    _head(repo, 10, {"PAY.md": pay.replace("openapi:\n  path: openapi.json\n", "")}, "skills/neither")
    net = Recorded({}, set(), {})
    brief = render(next_fix(Invalid("openapi.path", URL_ONLY), net), 8, "skills/remote")
    assert brief.splitlines()[0] == "brief: ps-0008-remote-01"
    assert "rule: openapi.path: url only" in brief
    assert _rows(repo, net, capsys) == [
        {"pr": 8, "listing": "skills/remote", "verdict": "fix", "id": "ps-0008-remote-01", "brief": brief},
        {"pr": 9, "listing": "skills/empty", "verdict": "close", "cause": "malformed", "reason": "openapi.path: missing"},
        {"pr": 10, "listing": "skills/neither", "verdict": "close", "cause": "malformed", "reason": "openapi.path: missing"},
        {"pass": 0, "fix": 1, "close": 2},
    ]


def test_a_broken_inline_head_is_a_fix_and_neither_still_closes(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    repo = _repo(tmp_path)
    pay = (FIXTURES / "broken-inline-content" / "PAY.md").read_text(encoding="utf-8")
    _head(repo, 11, {"PAY.md": pay}, "skills/inline")
    _head(repo, 12, {"PAY.md": pay.split("openapi:")[0] + "---\n"}, "skills/neither")
    net = Recorded({}, set(), {})
    brief = render(next_fix(read(FIXTURES / "broken-inline-content"), net), 11, "skills/inline")
    assert brief.splitlines()[0] == "brief: ps-0011-inline-01"
    assert "rule: openapi.content: " in brief
    assert _rows(repo, net, capsys) == [
        {"pr": 11, "listing": "skills/inline", "verdict": "fix", "id": "ps-0011-inline-01", "brief": brief},
        {"pr": 12, "listing": "skills/neither", "verdict": "close", "cause": "malformed", "reason": "openapi.path: missing"},
        {"pass": 0, "fix": 1, "close": 1},
    ]


def test_a_head_changing_no_listing_is_one_malformed_row(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    repo = _repo(tmp_path)
    _head(repo, 7, {"README.md": "notes\n"}, ".")
    assert _rows(repo, Recorded({}, set(), {}), capsys) == [
        {"pr": 7, "listing": None, "verdict": "close", "cause": "malformed", "reason": "changes no PAY.md listing"},
        {"pass": 0, "fix": 0, "close": 1},
    ]
