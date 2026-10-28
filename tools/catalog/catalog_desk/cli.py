import argparse
import json
from pathlib import Path

from catalog_desk.brief import render
from catalog_desk.checks import next_fix
from catalog_desk.listing import Invalid, read
from catalog_desk.net import Live, Net
from catalog_desk.sort import sort


def main(argv: list[str] | None = None, net: Net | None = None) -> int:
    parser = argparse.ArgumentParser(prog="catalog-desk")
    commands = parser.add_subparsers(dest="command", required=True)
    next_ = commands.add_parser("next", help="print the next failing check for one PAY.md")
    next_.add_argument("pay", type=Path, metavar="PAY.md")
    next_.add_argument("--before", type=Path, metavar="PAY.md")
    sort_ = commands.add_parser("sort", help="print one verdict row per PR head fetched into a pay-skills checkout")
    sort_.add_argument("checkout", type=Path)
    args = parser.parse_args(argv)
    if args.command == "sort":
        rows = sort(args.checkout, net or Live())
        for row in rows:
            print(json.dumps(row))
        print(json.dumps({verdict: sum(row["verdict"] == verdict for row in rows) for verdict in ("pass", "fix", "close")}))
        return 0
    before = None if args.before is None else read(args.before.parent)
    if isinstance(before, Invalid):
        parser.error(f"--before {args.before}: {before.field}: {before.why}")
    print(render(next_fix(read(args.pay.parent), net or Live(), before)))
    return 0
