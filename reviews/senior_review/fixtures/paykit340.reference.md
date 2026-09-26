## python/src/solana_pay_kit/config.py

````
"""Settings read from the environment."""

from __future__ import annotations

import os

TRUE = {"true", "yes", "on"}
FALSE = {"false", "no", "off"}
DEFAULT_EXPIRY = 900


class Config:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self._env = os.environ if env is None else env

    @property
    def debug(self) -> bool:
        value = self._env.get("PAY_KIT_DEBUG", "false").strip().lower()
        if value in TRUE:
            return True
        if value in FALSE:
            return False
        raise ValueError(f"PAY_KIT_DEBUG must be one of {sorted(TRUE | FALSE)}, got {value!r}")

    @property
    def rpc_url(self) -> str | None:
        return self._env.get("PAY_KIT_RPC_URL", "").strip() or None

    @property
    def expiry(self) -> int:
        seconds = int(self._env.get("PAY_KIT_EXPIRY", DEFAULT_EXPIRY))
        if seconds <= 0:
            raise ValueError(f"PAY_KIT_EXPIRY must be positive, got {seconds}")
        return seconds
````
