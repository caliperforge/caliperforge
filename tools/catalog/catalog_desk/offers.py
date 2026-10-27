import base64
import json
import re
from dataclasses import dataclass, replace
from typing import Any, Literal, TypeGuard

from catalog_desk.net import Response

SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

NETWORKS = {
    "base": "eip155:8453",
    "base-sepolia": "eip155:84532",
    "solana": SOLANA,
    "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
}

COINS = {
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913": "USDC",
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e": "USDC",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
}

PARAM = re.compile(r'(\w+)="([^"]*)"')
CHALLENGE = re.compile(r"(?=\bPayment\s)")
DIGITS = re.compile(r"[0-9]+")

Source = Literal["header", "body"]


@dataclass(frozen=True)
class Offer:
    proto: Literal["x402", "mpp"]
    scheme: str | None
    network: str
    coin: str
    asset: str
    usd: float | None
    pay_to: str | None


@dataclass(frozen=True)
class Offers:
    offers: list[Offer]
    x402_source: Source | None
    x402_version: float | None
    resource_url: str | None


def offers_of(res: Response) -> Offers:
    raw = [*_values(res.headers, "payment-required"), *_values(res.headers, "x-payment-required"), ""][0]
    found = _x402(_b64json(raw), "header") or _x402(_json(res.body), "body") or Offers([], None, None, None)
    mpp = [offer for value in _values(res.headers, "www-authenticate") for offer in _mpp(value)]
    return replace(found, offers=found.offers + mpp)


def _values(headers: dict[str, str | list[str]], name: str) -> list[str]:
    return [
        one
        for key, value in headers.items()
        if key.lower() == name
        for one in ([value] if isinstance(value, str) else value)
    ]


def _json(text: str) -> object:
    try:
        return json.loads(text)
    except ValueError:
        return None


def _b64json(text: str) -> object:
    padded = text + "=" * (-len(text) % 4)
    for decode in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            value = _json(decode(padded).decode("utf-8", errors="replace"))
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _has(value: dict[str, Any], key: str, kind: type | tuple[type, ...], required: bool = True) -> bool:
    if key not in value:
        return not required
    return isinstance(value[key], kind) and not isinstance(value[key], bool)


def _x402(value: object, source: Source) -> Offers | None:
    if not isinstance(value, dict):
        return None
    accepts, resource = value.get("accepts"), value.get("resource", {})
    if not (
        isinstance(accepts, list)
        and all(_valid_accept(accept) for accept in accepts)
        and _has(value, "x402Version", (int, float), required=False)
        and _has(value, "resource", dict, required=False)
        and ("resource" not in value or _has(resource, "url", str))
    ):
        return None
    return Offers([_accepted(accept) for accept in accepts], source, value.get("x402Version"), resource.get("url"))


def _valid_accept(value: object) -> TypeGuard[dict[str, Any]]:
    return (
        isinstance(value, dict)
        and _has(value, "network", str)
        and _has(value, "asset", str)
        and _has(value, "scheme", str, required=False)
        and _has(value, "payTo", str, required=False)
    )


def _accepted(accept: dict[str, Any]) -> Offer:
    amount = accept.get("amount")
    network: str = accept["network"]
    return Offer(
        "x402",
        accept.get("scheme"),
        NETWORKS.get(network, network),
        _coin(accept["asset"]),
        accept["asset"],
        _usd(accept.get("maxAmountRequired") if amount is None else amount, 6),
        accept.get("payTo"),
    )


def _mpp(value: str) -> list[Offer]:
    return [offer for segment in CHALLENGE.split(value) if segment.startswith("Payment") for offer in _challenge(segment)]


def _challenge(segment: str) -> list[Offer]:
    params = dict(PARAM.findall(segment))
    request = _b64json(params.get("request", ""))
    if "method" not in params or not _valid_request(request):
        return []
    details = request.get("methodDetails", {})
    method = params["method"]
    network = _solana(details.get("network")) if method == "solana" else f"mpp:{method}"
    usd = _usd(request.get("amount"), details.get("decimals", 6))
    return [Offer("mpp", params.get("intent"), network, _coin(request["currency"]), request["currency"], usd, request.get("recipient"))]


def _valid_request(value: object) -> TypeGuard[dict[str, Any]]:
    if not (
        isinstance(value, dict)
        and _has(value, "currency", str)
        and _has(value, "recipient", str, required=False)
        and _has(value, "methodDetails", dict, required=False)
    ):
        return False
    details = value.get("methodDetails", {})
    return _has(details, "network", str, required=False) and _has(details, "decimals", int, required=False)


def _solana(network: str | None) -> str:
    return SOLANA if network in (None, "mainnet", "mainnet-beta") else f"solana:{network}"


def _coin(asset: str) -> str:
    return COINS.get(asset, asset[:10])


def _usd(amount: object, decimals: int) -> float | None:
    return float(f"{amount}e{-decimals}") if isinstance(amount, str) and DIGITS.fullmatch(amount) else None
