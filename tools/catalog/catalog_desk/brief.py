from dataclasses import dataclass

STOP = "stop: the cause is on the seller's server"


@dataclass(frozen=True)
class Fix:
    check: str
    rule: str
    current: str
    replacement: str
    server: bool


def render(fix: Fix | None) -> str:
    if fix is None:
        return "green"
    lines = [f"check: {fix.check}", f"rule: {fix.rule}", f"current: {fix.current}", f"replacement: {fix.replacement}"]
    return "\n".join([*lines, STOP] if fix.server else lines)
