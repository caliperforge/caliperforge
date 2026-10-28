import io
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from catalog_desk.brief import render
from catalog_desk.checks import next_fix
from catalog_desk.listing import Invalid, Listing, read
from catalog_desk.net import Net

PULL = re.compile(r"refs/pull/(\d+)/head")
NOT_SOLANA = "no Solana mainnet offer"


def sort(checkout: Path, net: Net) -> list[dict[str, object]]:
    refs = _lines(checkout, "for-each-ref", "--format=%(refname)", "refs/pull")
    heads = sorted((int(m[1]), ref) for ref in refs if (m := PULL.fullmatch(ref)))
    seen: dict[str, int] = {}
    rows: list[dict[str, object]] = []
    for pr, ref in heads:
        changed = _lines(checkout, "diff", "--name-only", f"HEAD...{ref}")
        listed = [p.removesuffix("/PAY.md") for p in _lines(checkout, "ls-tree", "-r", "--name-only", ref) if p.endswith("/PAY.md")]
        dirs = [d for d in listed if any(f.startswith(f"{d}/") for f in changed)]
        if not dirs:
            rows.append({"pr": pr, "listing": None, **_close("malformed", "changes no PAY.md listing")})
        for d in dirs:
            rows.append({"pr": pr, "listing": d, **_verdict(_unpacked(checkout, ref, d), net, seen, pr)})
    return rows


def _verdict(listing: Listing | Invalid, net: Net, seen: dict[str, int], pr: int) -> dict[str, object]:
    if isinstance(listing, Invalid):
        return _close("malformed", f"{listing.field}: {listing.why}")
    url = listing.front["service_url"]
    first = seen.setdefault(url.rstrip("/"), pr)
    if first != pr:
        return _close("duplicate", f"#{first}")
    if not net.resolve(urlsplit(url).hostname or ""):
        return _close("dead domain", url)
    fix = next_fix(listing, net)
    if fix is None:
        return {"verdict": "pass"}
    if fix.check == "network" and fix.rule.startswith(NOT_SOLANA):
        return _close("not Solana", fix.current)
    return {"verdict": "fix", "brief": render(fix)}


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
