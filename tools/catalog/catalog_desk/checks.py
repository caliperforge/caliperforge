import math
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from itertools import chain
from typing import Any
from urllib.parse import urlsplit

from catalog_desk.brief import Fix
from catalog_desk.listing import Invalid, Listing, faults
from catalog_desk.net import Net, Response
from catalog_desk.offers import NETWORKS, SOLANA, Offer, Offers, _values, offers_of

CAP = 60
SUMMARY = (24, 63)
DESCRIPTION = (32, 255)
METHODS = ("get", "post", "put", "patch", "delete")
OUTBOUND = {"send", "sms", "email", "mail", "tweet", "post", "publish", "message", "notify", "call", "transfer", "withdraw"}
WORDS = re.compile(r"[^A-Za-z]+|(?<=[a-z])(?=[A-Z])")
BRACED = re.compile(r"\{[^}]+\}")
STABLES = ("USDC", "USDT", "PYUSD", "USDG", "CASH")
HEADER_ONLY = "x402 offer only in header with JSON body (pay's indexer misses it)"
KEYS = ("price", "fixedPrice", "amount", "price_usd", "priceUsd")
PROGRAMS = ("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


@dataclass(frozen=True)
class _Answered:
    op: dict[str, Any]
    pricing: dict[str, Any]
    res: Response
    offers: Offers


def next_fix(listing: Listing | Invalid, net: Net, before: Listing | None = None) -> Fix | None:
    if isinstance(listing, Invalid):
        return Fix("format", f"{listing.field}: {listing.why}", listing.field, f"a valid {listing.field}", False)
    # _offer fills answered before the phases after it start reading it.
    answered: list[_Answered] = []
    fixes = chain(
        _format(listing),
        _declared_less(listing, before),
        _offer(listing, net, answered),
        _network(answered),
        _price(answered),
        _payee(answered, net),
    )
    return next(fixes, None)


def _targets(listing: Listing) -> list[tuple[str, str, str, dict[str, Any], dict[str, Any]]]:
    url = listing.front["service_url"]
    endpoints = _list(listing.front.get("endpoints"))
    if "openapi" in listing.front:
        pricing = _fields(_fields(next(iter(endpoints), None)).get("pricing"))
        return [(method, path, url.rstrip("/") + BRACED.sub("test", path), op, pricing) for method, path, op in _ops(listing.spec)]
    return [(e["method"].upper(), e["path"], f"{url}/{e['path'].removeprefix('/')}", {}, _fields(e.get("pricing"))) for e in endpoints]


def _format(listing: Listing) -> Iterator[Fix]:
    front = listing.front
    name = front.get("name")
    if name != listing.dir:
        current = name if isinstance(name, str) else ""
        yield Fix("format", f"name={current} but parent directory is {listing.dir}", current, listing.dir, False)
    for fault in faults(front):
        low, high = fault.range
        text = front.get(fault.field)
        current = text if isinstance(text, str) else ""
        yield Fix("format", f"{fault.field} is {fault.length} characters", current, f"a {fault.field} of {low}-{high} characters", False)
    low, high = DESCRIPTION
    for entry in [] if "openapi" in front else front["endpoints"]:
        text = entry.get("description")
        current = text if isinstance(text, str) else ""
        if not low <= len(current) <= high:
            rule = f"{entry['method'].upper()} {entry['path']} description is {len(current)} characters"
            yield Fix("format", rule, current, f"an endpoint description of {low}-{high} characters", False)
    low, high = SUMMARY
    for method, path, op in _ops(listing.spec):
        summary = op.get("summary")
        if isinstance(summary, str) and not low <= len(summary) <= high:
            rule = f"{method} {path} summary is {len(summary)} characters"
            yield Fix("format", rule, summary, f"an operation summary of {low}-{high} characters", False)


def _declared_less(listing: Listing, before: Listing | None) -> Iterator[Fix]:
    listed = {(method, path) for method, path, *_ in _targets(listing)}
    for method, path, *_ in [] if before is None else _targets(before):
        if (method, path) not in listed:
            endpoint = f"{method} {path}"
            yield Fix("declared_less", "a fix may not drop an endpoint the listing declared", endpoint, f"restore {endpoint}", False)


def _offer(listing: Listing, net: Net, answered: list[_Answered]) -> Iterator[Fix]:
    url = listing.front["service_url"]
    host = urlsplit(url).hostname or ""
    if not net.resolve(host):
        yield Fix("offer", "dead domain", url, "a service_url whose host resolves", False)
        return
    for method, path, target, op, pricing in _targets(listing)[:CAP]:
        if method != "GET" and _outbound(path, op):
            continue
        answer = _probe(net, target, method, path, op, pricing)
        if isinstance(answer, Fix):
            yield answer
            return
        yield from _shown(answer, host)
        answered.append(answer)


def _probe(net: Net, url: str, method: str, path: str, op: dict[str, Any], pricing: dict[str, Any]) -> Fix | _Answered:
    endpoint = f"{method} {path}"
    try:
        res = net.fetch(url, method, None if method == "GET" else {})
    except OSError as e:
        return Fix("offer", "unreachable", f"{endpoint}: {e}", f"{endpoint} answering", False)
    if res.status != 402:
        return Fix("offer", f"HTTP {res.status}", endpoint, f"{endpoint} answering 402 with an offer", False)
    offers = offers_of(res)
    if not offers.offers:
        return Fix("offer", "402 without a readable offer", endpoint, "an x402 or MPP offer in the 402", False)
    return _Answered(op, pricing, res, offers)


def _shown(answer: _Answered, host: str) -> Iterator[Fix]:
    resource = _elsewhere(answer.offers.resource_url, host)
    if resource is not None:
        yield Fix("offer", f"payment resource points at {resource}", resource, host, False)
    json_body = any("json" in value for value in _values(answer.res.headers, "content-type"))
    if answer.offers.x402_source == "header" and json_body:
        yield Fix("offer", HEADER_ONLY, "the x402 offer in the header only", "the same x402 offer in the JSON body too", False)


def _network(answered: list[_Answered]) -> Iterator[Fix]:
    for answer in answered:
        offers = answer.offers.offers
        paid = _usable(offers)
        networks = ", ".join(dict.fromkeys(o.network for o in offers))
        devnet = any(o.network == NETWORKS["solana-devnet"] or "devnet" in o.network for o in offers)
        if not paid:
            rule = "devnet only" if devnet else f"no Solana mainnet offer ({networks})"
            yield Fix("network", rule, networks, "a stablecoin offer on Solana mainnet", True)
        if devnet:
            yield Fix("network", "also advertises devnet", networks, "Solana mainnet offers only", True)
        if any(o.proto == "mpp" and o.network == "mpp:tempo" for o in offers) and not any(o.proto == "mpp" for o in paid):
            yield Fix("network", "MPP offered on Tempo, not Solana", "mpp:tempo", "an MPP offer on Solana mainnet", True)


def _price(answered: list[_Answered]) -> Iterator[Fix]:
    for answer in answered:
        paid = _usable(answer.offers.offers)
        exact = sorted({o.usd for o in paid if o.usd is not None and o.scheme in ("exact", "charge")})
        if len(exact) > 1:
            prices = ", ".join(f"{p:g}" for p in exact)
            yield Fix("price", f"inconsistent prices across offers [{prices}]", prices, "one price across offers", False)
        if any(o.usd == 0 for o in paid):
            yield Fix("price", "asks for $0", "$0", "a price above $0", False)
        declared = _declared_usd(answer.op, answer.pricing)
        quoted = min((o.usd for o in paid if o.usd is not None), default=None)
        if declared is None or quoted is None or not _apart(declared, quoted):
            continue
        listed, asked = f"${declared:g}", f"${quoted:g}"
        rule = f"price listed {listed} vs asked {asked}"
        yield Fix("price", rule, asked, listed, True) if quoted > declared else Fix("price", rule, listed, asked, False)


def _payee(answered: list[_Answered], net: Net) -> Iterator[Fix]:
    asked: set[tuple[str, str]] = set()
    for answer in answered:
        paid = [(o.pay_to, o.asset, o.coin) for o in _usable(answer.offers.offers) if o.pay_to is not None]
        yield from _owed(paid, net, asked)


def _owed(paid: list[tuple[str, str, str]], net: Net, asked: set[tuple[str, str]]) -> Iterator[Fix]:
    recipients = list(dict.fromkeys(pay_to for pay_to, _, _ in paid))
    if len(recipients) > 1:
        yield Fix("payee", f"{len(recipients)} different recipients", ", ".join(recipients), "one payTo across offers", True)
    for field, value in ((f, v) for pay_to, asset, _ in paid for f, v in (("payTo", pay_to), ("asset", asset))):
        if not _key(value):
            yield Fix("payee", f"{field} is not a Solana address", value, "a 32-byte base58 Solana address", True)
    for pay_to, asset, coin in paid:
        if (pay_to, asset) not in asked:
            asked.add((pay_to, asset))
            yield from _held(net, pay_to, asset, coin)


def _held(net: Net, pay_to: str, asset: str, coin: str) -> Iterator[Fix]:
    account = _rpc(net, "getAccountInfo", [pay_to, {"encoding": "jsonParsed"}], _account)
    if account is not None and account["owner"] in PROGRAMS:
        yield Fix("payee", "payTo is a token account, not a wallet", pay_to, "the wallet that owns it", True)
        return
    held = _rpc(net, "getTokenAccountsByOwner", [pay_to, {"mint": asset}, {"encoding": "jsonParsed"}], lambda v: isinstance(v, list))
    if not held:
        yield Fix("payee", f"recipient has no {coin} token account", pay_to, f"a wallet with a {coin} token account", True)


def _rpc(net: Net, method: str, params: list[object], valid: Callable[[object], bool]) -> Any:
    value = net.rpc(method, params)
    if not valid(value):
        raise RuntimeError(f"{method} replied {value!r}")
    return value


def _account(value: object) -> bool:
    return value is None or (isinstance(value, dict) and isinstance(value.get("owner"), str))


def _ops(spec: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    items = ((path, _fields(item)) for path, item in _fields(_fields(spec).get("paths")).items())
    return [(m.upper(), path, _fields(item[m])) for path, item in items for m in METHODS if m in item]


def _outbound(path: str, op: dict[str, Any]) -> bool:
    return any(word.lower() in OUTBOUND for word in WORDS.split(f"{path} {op.get('operationId') or ''}"))


def _usable(offers: list[Offer]) -> list[Offer]:
    return [o for o in offers if o.network == SOLANA and o.coin in STABLES]


def _elsewhere(resource_url: str | None, host: str) -> str | None:
    at = urlsplit(resource_url or "").hostname
    base = ".".join(host.split(".")[-2:])
    return None if at is None or at in (host, base) or at.endswith(f".{base}") else at


def _apart(a: float, b: float) -> bool:
    return abs(a - b) > max(0.0001, 0.01 * max(a, b))


def _key(s: str) -> bool:
    if any(c not in BASE58 for c in s):
        return False
    rest = s.lstrip("1")
    n = 0
    for c in rest:
        n = n * 58 + BASE58.index(c)
    return len(s) - len(rest) + (n.bit_length() + 7) // 8 == 32


def _declared_usd(op: dict[str, Any], pricing: dict[str, Any]) -> float | None:
    info = _fields(op.get("x-payment-info"))
    offer = next((o for o in map(_fields, _list(info.get("offers"))) if o.get("amount", "") != ""), {})
    accepts = map(_fields, _list(info.get("accepts")))
    solana = next((a for a in accepts if isinstance(a.get("network"), str) and a["network"].startswith("solana")), {})
    found = (
        _micro(offer.get("amount")),
        *(_keyed(info, key) for key in KEYS),
        _micro(solana.get("amount")),
        _usd(op.get("x-price-usd")),
        _usd(op.get("x-price")),
        _tier(pricing),
    )
    return next((n for n in found if n is not None), None)


def _tier(pricing: dict[str, Any]) -> float | None:
    dimension = _fields(next(iter(_list(pricing.get("dimensions"))), None))
    tiers = _list(dimension.get("tiers"))
    price = _usd(_fields(tiers[-1]).get("price_usd")) if tiers else None
    scale = dimension.get("scale")
    divisor = 1.0 if scale is None else _usd(scale)
    return None if price is None or not divisor else _usd(price / divisor)


def _keyed(info: dict[str, Any], key: str) -> float | None:
    n = _usd(info.get(key))
    return n / 1e6 if key == "amount" and n is not None and n > 1000 else n


def _micro(value: object) -> float | None:
    n = _usd(value)
    return None if n is None else n / 1e6


def _usd(value: object) -> float | None:
    text = value.replace("$", "").strip() if isinstance(value, str) else ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        n = float(value)
    elif text:
        try:
            n = float(text)
        except ValueError:
            return None
    else:
        return None
    return n if math.isfinite(n) else None


def _fields(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []
