import io
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from catalog_desk.brief import brief_id, render
from catalog_desk.checks import next_fix
from catalog_desk.listing import URL_ONLY, Invalid, Listing, read
from catalog_desk.net import Net

PULL = re.compile(r"refs/pull/(\d+)/head")
NOT_SOLANA = "no Solana mainnet offer"


def sort(checkout: Path, net: Net) -> list[dict[str, object]]:
    heads = _heads(checkout)
    newest: dict[str, dict[str, int]] = {}
    for pr, _, author, dirs in heads:
        for d in dirs:
            newest.setdefault(d, {})[author] = pr
    rows: list[dict[str, object]] = []
    for pr, ref, author, dirs in heads:
        if not dirs:
            rows.append({"pr": pr, "listing": None, **_close("malformed", "changes no PAY.md listing")})
        for d in dirs:
            mine, oldest = newest[d][author], min(newest[d].values())
            if mine != pr:
                verdict = _close("superseded", f"by #{mine}")
            elif oldest != pr:
                verdict = _close("duplicate", f"of #{oldest}")
            else:
                verdict = _verdict(_unpacked(checkout, ref, d), net, pr, d)
            rows.append({"pr": pr, "listing": d, **verdict})
    return rows


def _heads(checkout: Path) -> list[tuple[int, str, str, list[str]]]:
    refs = _lines(checkout, "for-each-ref", "--format=%(refname)", "refs/pull")
    heads = []
    for pr, ref in sorted((int(m[1]), ref) for ref in refs if (m := PULL.fullmatch(ref))):
        changed = _lines(checkout, "diff", "--name-only", f"HEAD...{ref}")
        listed = [p.removesuffix("/PAY.md") for p in _lines(checkout, "ls-tree", "-r", "--name-only", ref) if p.endswith("/PAY.md")]
        dirs = [d for d in listed if any(f.startswith(f"{d}/") for f in changed)]
        heads.append((pr, ref, _lines(checkout, "log", "-1", "--format=%an", ref)[0], dirs))
    return heads


def _verdict(listing: Listing | Invalid, net: Net, pr: int, d: str) -> dict[str, object]:
    if isinstance(listing, Invalid):
        if listing.why != URL_ONLY and listing.field != "openapi.content":
            return _close("malformed", f"{listing.field}: {listing.why}")
    else:
        url = listing.front["service_url"]
        if not net.resolve(urlsplit(url).hostname or ""):
            return _close("dead domain", url)
    fix = next_fix(listing, net)
    if fix is None:
        return {"verdict": "pass"}
    if fix.check == "network" and fix.rule.startswith(NOT_SOLANA):
        return _close("not Solana", fix.current)
    return {"verdict": "fix", "id": brief_id(fix, pr, d), "brief": render(fix, pr, d)}


def _close(cause: str, reason: str) -> dict[str, object]:
    return {"verdict": "close", "cause": cause, "reason": reason}


def _unpacked(checkout: Path, ref: str, dir: str) -> Listing | Invalid:
    with tempfile.TemporaryDirectory() as tmp:
        with tarfile.open(fileobj=io.BytesIO(_git(checkout, "archive", ref, dir))) as tar:
            tar.extractall(tmp, filter="data")
        return read(Path(tmp) / dir)


def _lines(checkout: Path, *args: str) -> list[str]:
    return _git(checkout, *args).decode().splitlines()


def _git(checkout: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(checkout), *args], check=True, capture_output=True).stdout
