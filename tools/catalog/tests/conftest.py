import socket

import pytest


def _offline(*args: object, **kwargs: object) -> None:
    raise RuntimeError("a test touched the network")


@pytest.fixture(autouse=True)
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(socket.socket, "connect", _offline)
    monkeypatch.setattr(socket, "getaddrinfo", _offline)
