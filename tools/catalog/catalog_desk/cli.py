import argparse
import json
from pathlib import Path

from catalog_desk.brief import render
from catalog_desk.checks import next_fix
from catalog_desk.listing import Invalid, read
from catalog_desk.net import Live, Net
from catalog_desk.reply import Refused, check
from catalog_desk.sort import fetch, sort


def main(argv: list[str] | None = None, net: Net | None = None) -> int:
    parser = argparse.ArgumentParser(prog="catalog-desk")
    commands = parser.add_subparsers(dest="command", required=True)
    next_ = commands.add_parser("next", help="print the next failing check for one PAY.md")
    next_.add_argument("pay", type=Path, metavar="PAY.md")
    next_.add_argument("--before", type=Path, metavar="PAY.md")
    next_.add_argument("--pr", type=int, required=True)
    sort_ = commands.add_parser("sort", help="print one verdict row per PR head fetched into a pay-skills checkout")
    sort_.add_argument("checkout", type=Path)
    sort_.add_argument("--no-fetch", action="store_true")
    reply_ = commands.add_parser("reply", help="check a seller's reply to a brief against a saved sort output")
    reply_.add_argument("checkout", type=Path)
    reply_.add_argument("sorted", type=Path)
    reply_.add_argument("reply", type=Path)
    args = parser.parse_args(argv)
    if args.command == "sort":
        net = net or Live()
        if not args.no_fetch:
            fetch(args.checkout, net)
        rows = sort(args.checkout, net)
        for row in rows:
            print(json.dumps(row))
        print(json.dumps({verdict: sum(row["verdict"] == verdict for row in rows) for verdict in ("pass", "fix", "close")}))
        return 0
    if args.command == "reply":
        rows = [json.loads(line) for line in args.sorted.read_text(encoding="utf-8").splitlines()]
        record = check(args.reply.read_text(encoding="utf-8"), rows, args.checkout, net or Live())
        if isinstance(record, Refused):
            print(f"refused: {record.why}")
            return 1
        print(json.dumps(record))
        return 0
    before = None if args.before is None else read(args.before.parent)
    if isinstance(before, Invalid):
        parser.error(f"--before {args.before}: {before.field}: {before.why}")
    print(render(next_fix(read(args.pay.parent), net or Live(), before), args.pr, str(args.pay.parent)))
    return 0
