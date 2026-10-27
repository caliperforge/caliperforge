import argparse


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="catalog-desk")
    parser.add_subparsers(dest="command", required=True)
    parser.parse_args(argv)
    return 0
