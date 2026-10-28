import argparse
from pathlib import Path

from catalog_desk.brief import render
from catalog_desk.checks import next_fix
from catalog_desk.listing import Invalid, read
from catalog_desk.net import Live, Net


def main(argv: list[str] | None = None, net: Net | None = None) -> int:
    parser = argparse.ArgumentParser(prog="catalog-desk")
    commands = parser.add_subparsers(dest="command", required=True)
    next_ = commands.add_parser("next", help="print the next failing check for one PAY.md")
    next_.add_argument("pay", type=Path, metavar="PAY.md")
    next_.add_argument("--before", type=Path, metavar="PAY.md")
    args = parser.parse_args(argv)
    before = None if args.before is None else read(args.before.parent)
    if isinstance(before, Invalid):
        parser.error(f"--before {args.before}: {before.field}: {before.why}")
    print(render(next_fix(read(args.pay.parent), net or Live(), before)))
    return 0
