import pytest

from catalog_desk.net import Recorded, Response, Unrecorded

PAID = Response(402, {"www-authenticate": ['Payment method="solana"']}, "{}")
PARAMS: list[object] = ["Payee1", {"encoding": "jsonParsed"}]
NET = Recorded(
    {"GET https://api.example.com/paid": PAID},
    {"api.example.com"},
    {'getAccountInfo ["Payee1", {"encoding": "jsonParsed"}]': {"owner": "Owner1"}},
)


def test_recorded_replays_fetches_rpc_values_and_hosts():
    assert NET.fetch("https://api.example.com/paid") is PAID
    assert NET.rpc("getAccountInfo", PARAMS) == {"owner": "Owner1"}
    assert NET.resolve("api.example.com")


def test_d5_an_unrecorded_fetch_or_rpc_raises():
    with pytest.raises(Unrecorded):
        NET.fetch("https://api.example.com/paid", "POST")
    with pytest.raises(Unrecorded):
        NET.rpc("getAccountInfo", [])


def test_d5_an_unknown_host_resolves_false():
    assert not NET.resolve("unknown.example.com")
