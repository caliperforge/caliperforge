import json
import os
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from email.message import Message
from pathlib import Path
from typing import Protocol, Self

AGENT = "pay-catalog-scanner/0.1 (+caliperforge)"
MAINNET = "https://api.mainnet-beta.solana.com"


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str | list[str]]
    body: str


class Net(Protocol):
    def fetch(self, url: str, method: str = "GET", body: object = None) -> Response: ...

    def resolve(self, host: str) -> bool: ...

    def rpc(self, method: str, params: list[object]) -> object: ...


class Unrecorded(Exception):
    pass


class _Unredirected(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Live:
    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(_Unredirected)

    def fetch(self, url: str, method: str = "GET", body: object = None) -> Response:
        headers = {"user-agent": AGENT}
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode()
        request = urllib.request.Request(url, data, headers, method=method)
        try:
            with self._opener.open(request, timeout=15) as res:
                return _response(res.status, res.headers, res.read())
        except urllib.error.HTTPError as e:
            return _response(e.code, e.headers, e.read())

    def resolve(self, host: str) -> bool:
        try:
            socket.getaddrinfo(host, None)
        except socket.gaierror:
            return False
        return True

    def rpc(self, method: str, params: list[object]) -> object:
        url = os.environ.get("CF_SOLANA_RPC", MAINNET)
        res = self.fetch(url, "POST", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        if not 200 <= res.status < 300:
            raise RuntimeError(f"HTTP {res.status}")
        reply = json.loads(res.body)
        result = reply.get("result") if isinstance(reply, dict) else None
        if not isinstance(result, dict) or "value" not in result:
            raise RuntimeError(f"{method} replied {res.body}")
        return result["value"]


def _response(status: int, headers: Message, raw: bytes) -> Response:
    named: dict[str, str | list[str]] = {key.lower(): headers.get_all(key) or [] for key in headers}
    return Response(status, named, raw.decode("utf-8", errors="replace"))


@dataclass(frozen=True)
class Recorded:
    fetches: dict[str, Response]
    hosts: set[str]
    replies: dict[str, object]

    @classmethod
    def load(cls, path: Path) -> Self:
        recorded = json.loads(path.read_text(encoding="utf-8"))
        fetches = {key: Response(**res) for key, res in recorded["fetch"].items()}
        return cls(fetches, set(recorded["hosts"]), recorded["rpc"])

    def fetch(self, url: str, method: str = "GET", body: object = None) -> Response:
        key = f"{method} {url}"
        if key not in self.fetches:
            raise Unrecorded(key)
        return self.fetches[key]

    def resolve(self, host: str) -> bool:
        return host in self.hosts

    def rpc(self, method: str, params: list[object]) -> object:
        key = f"{method} {json.dumps(params)}"
        if key not in self.replies:
            raise Unrecorded(key)
        return self.replies[key]
