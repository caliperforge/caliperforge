from dataclasses import dataclass
from pathlib import Path

STOP = "stop: the cause is on the seller's server"
CHECKS = ("format", "declared_less", "offer", "network", "price", "payee")


@dataclass(frozen=True)
class Fix:
    check: str
    rule: str
    current: str
    replacement: str
    server: bool


def brief_id(fix: Fix, pr: int, path: str) -> str:
    return f"ps-{pr:04d}-{Path(path).resolve().name}-{CHECKS.index(fix.check) + 1:02d}"


def render(fix: Fix | None, pr: int, path: str) -> str:
    if fix is None:
        return "green"
    lines = [
        f"brief: {brief_id(fix, pr, path)}",
        f"listing: {path}/PAY.md (PR #{pr})",
        f"check: {fix.check}",
        f"rule: {fix.rule}",
        f"current: {fix.current}",
        f"replacement: {fix.replacement}",
        f"verify: pay catalog next {path}/PAY.md",
        "reply: fixed | disputed, using the reply block",
    ]
    return "\n".join([*lines, STOP] if fix.server else lines)
