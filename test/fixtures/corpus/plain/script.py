"""A throwaway script living outside any repository."""

import sys


def wordcount(path: str) -> int:
    """Return the number of whitespace-separated words in ``path``."""
    with open(path, encoding="utf-8") as handle:
        return sum(len(line.split()) for line in handle)


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        print(argument, wordcount(argument))
