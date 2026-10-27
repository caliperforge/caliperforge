import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

RANGES = {"summary": (24, 63), "description": (64, 255), "use_case": (32, 255)}
FENCE = re.compile(r"^---$", re.MULTILINE)
STRINGS = (("service_url", True), ("title", True), ("description", False), ("use_case", False))


@dataclass(frozen=True)
class Listing:
    front: dict[str, Any]
    spec: dict[str, Any]


@dataclass(frozen=True)
class Invalid:
    field: str
    why: str


@dataclass(frozen=True)
class Fault:
    field: str
    range: tuple[int, int]
    length: int


def read(dir: Path) -> Listing | Invalid:
    parts = FENCE.split((dir / "PAY.md").read_text(encoding="utf-8"))
    if len(parts) < 2:
        return Invalid("PAY.md", "no --- front matter")
    try:
        front = yaml.safe_load(parts[1])
    except yaml.YAMLError as e:
        return Invalid("PAY.md", str(e))
    if not isinstance(front, dict):
        return Invalid("PAY.md", "front matter is not a mapping")
    invalid = _fields(front)
    if invalid is not None:
        return invalid
    try:
        spec = json.loads((dir / front["openapi"]["path"]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return Invalid("openapi.path", str(e))
    return Listing(front, spec)


def _fields(front: dict[str, Any]) -> Invalid | None:
    for field, required in STRINGS:
        if (required or field in front) and not isinstance(front.get(field), str):
            return Invalid(field, "not a string")
    pr = front.setdefault("pr", 0)
    if not isinstance(pr, int) or isinstance(pr, bool):
        return Invalid("pr", "not an integer")
    openapi = front.get("openapi")
    if not isinstance(openapi, dict) or not isinstance(openapi.get("path"), str):
        return Invalid("openapi.path", "missing")
    return None


def faults(front: dict[str, Any]) -> list[Fault]:
    found: list[Fault] = []
    for field, (low, high) in RANGES.items():
        value = front.get(field)
        length = len(value) if isinstance(value, str) else 0
        if not low <= length <= high:
            found.append(Fault(field, (low, high), length))
    return found
