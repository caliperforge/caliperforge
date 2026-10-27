import base64
import json
import re
from pathlib import Path

from catalog_desk.net import Recorded, Response
from catalog_desk.offers import SOLANA, Offer, Offers, offers_of

FIXTURES = Path(__file__).parent / "fixtures"
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913"
USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"


def encode(value: object, urlsafe: bool = False) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode()
    return (base64.urlsafe_b64encode if urlsafe else base64.b64encode)(raw).decode()


ACCEPT = {"scheme": "exact", "network": "base", "amount": "10000", "asset": USDC_BASE, "payTo": "0xpay"}
X402 = {"x402Version": 2, "resource": {"url": "https://api.example.com/paid?"}, "accepts": [ACCEPT]}

BASE_OFFER = Offer("x402", "exact", "eip155:8453", "USDC", USDC_BASE, 0.01, "0xpay")

SOLANA_REQUEST = {
    "amount": "2500000000",
    "currency": USDC_SOLANA,
    "recipient": "Recipient1",
    "methodDetails": {"network": "mainnet-beta", "decimals": 9},
}
SOLANA_CHARGE = (
    'Payment id="a1", realm="api", method="solana", intent="charge", '
    f'request="{encode(SOLANA_REQUEST, urlsafe=True).rstrip("=")}"'
)


def test_d1_reads_the_x402_offer_from_the_header_alone():
    res = Response(402, {"Payment-Required": encode(X402)}, "{}")
    assert offers_of(res) == Offers([BASE_OFFER], "header", 2, "https://api.example.com/paid?")


def test_d2_reads_the_x402_offer_from_the_body_without_header():
    accept = {key: value for key, value in ACCEPT.items() if key != "amount"}
    v1 = {"x402Version": 1, "accepts": [{**accept, "maxAmountRequired": "10000"}]}
    assert offers_of(Response(402, {}, json.dumps(v1))) == Offers([BASE_OFFER], "body", 1, None)


def test_d3_url_safe_unpadded_header_matches_its_standard_form():
    standard = encode(X402)
    url_safe = encode(X402, urlsafe=True).rstrip("=")
    assert re.search(r"[+/=]", standard)
    expected = offers_of(Response(402, {"payment-required": standard}, ""))
    assert expected.offers == [BASE_OFFER]
    assert offers_of(Response(402, {"payment-required": url_safe}, "")) == expected


def test_d4_solana_charge_prices_at_its_own_decimals_on_mainnet():
    res = Response(402, {"www-authenticate": SOLANA_CHARGE}, "")
    assert offers_of(res).offers == [Offer("mpp", "charge", SOLANA, "USDC", USDC_SOLANA, 2.5, "Recipient1")]


def test_d5_a_tempo_challenge_maps_to_mpp_tempo():
    currency = "0x20c0000000000000000000000000000000000000"
    request = encode({"amount": "1000000", "currency": currency, "recipient": "0xr"})
    header = f'Payment method="tempo", intent="charge", request="{request}"'
    res = Response(402, {"WWW-Authenticate": header}, "")
    assert offers_of(res).offers == [Offer("mpp", "charge", "mpp:tempo", "0x20c00000", currency, 1, "0xr")]


def test_d6_returns_offers_for_both_x402_and_mpp():
    headers: dict[str, str | list[str]] = {
        "x-payment-required": encode(X402),
        "WWW-Authenticate": ['Bearer realm="api"', SOLANA_CHARGE],
    }
    res = offers_of(Response(402, headers, ""))
    assert [offer.proto for offer in res.offers] == ["x402", "mpp"]
    assert [offer.asset for offer in res.offers] == [USDC_BASE, USDC_SOLANA]
    assert res.x402_source == "header"


def test_d7_garbage_header_and_non_json_body_give_no_offers():
    res = Response(402, {"payment-required": "%%not base64%%"}, "<html>")
    assert offers_of(res) == Offers([], None, None, None)


def test_header_only_offer_ignores_the_json_body():
    res = Recorded.load(FIXTURES / "header-only.json").fetch("https://api.example.com/paid")
    offer = Offer("x402", "exact", SOLANA, "USDC", USDC_SOLANA, 0.01, None)
    assert offers_of(res) == Offers([offer], "header", 2, None)


def test_devnet_maps_x402_and_mpp_networks():
    res = Recorded.load(FIXTURES / "devnet.json").fetch("https://devnet.example.com/paid")
    assert offers_of(res) == Offers(
        [
            Offer("x402", "exact", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "USDC", USDC_DEVNET, 0.01, None),
            Offer("mpp", "charge", "solana:devnet", "USDC", USDC_DEVNET, 0.01, None),
        ],
        "body",
        1,
        None,
    )
