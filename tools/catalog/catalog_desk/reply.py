from dataclasses import dataclass
from pathlib import Path
from typing import Any

from catalog_desk.brief import brief_id
from catalog_desk.checks import next_fix
from catalog_desk.net import Net
from catalog_desk.sort import _unpacked

FIXED = ("changed", "commit", "verify output")
DISPUTED = ("reason",)


@dataclass(frozen=True)
class Refused:
    why: str


def check(text: str, rows: list[dict[str, Any]], checkout: Path, net: Net) -> dict[str, str] | Refused:
    fields = _fields(text)
    brief = fields.get("brief")
    if not brief:
        return Refused("brief missing")
    row = next((r for r in rows if r.get("verdict") == "fix" and r.get("id") == brief), None)
    if row is None:
        return Refused(f"unknown brief {brief}")
    status = fields.get("status")
    if not status:
        return Refused("status missing")
    if status not in ("fixed", "disputed"):
        return Refused("status must be fixed or disputed")
    for field in FIXED if status == "fixed" else DISPUTED:
        if not fields.get(field):
            return Refused(f"{field} missing")
    if status == "fixed":
        fix = next_fix(_unpacked(checkout, fields["commit"], row["listing"]), net)
        if fix is not None and brief_id(fix, row["pr"], row["listing"]) == brief:
            return Refused("not fixed")
    return fields


def _fields(text: str) -> dict[str, str]:
    parts: dict[str, list[str]] = {}
    key = ""
    for line in text.splitlines():
        if line.startswith("  ") and key:
            parts[key].append(line[2:])
        else:
            key, _, value = line.partition(":")
            key = key.strip()
            parts[key] = [value.strip()]
    return {k: "\n".join(v).strip() for k, v in parts.items() if k}
