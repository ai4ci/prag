"""Summarise tabular observations held in memory."""

from statistics import fmean, median, pstdev


class Summary:
    """Running summary of a single numeric column."""

    def __init__(self, name: str):
        """Create an empty summary for the column called ``name``."""
        self.name = name
        self.values: list[float] = []

    def add(self, value: float) -> None:
        """Record one observation, ignoring ``None`` and NaN."""
        if value is None or value != value:
            return
        self.values.append(float(value))

    def quantile(self, p: float) -> float:
        """Return the ``p``-quantile using nearest-rank interpolation."""
        if not 0.0 <= p <= 1.0:
            raise ValueError("p must lie in [0, 1]")
        if not self.values:
            return float("nan")
        ordered = sorted(self.values)
        position = p * (len(ordered) - 1)
        lower = int(position)
        upper = min(lower + 1, len(ordered) - 1)
        weight = position - lower
        return ordered[lower] * (1 - weight) + ordered[upper] * weight

    def describe(self) -> dict[str, float]:
        """Return count, mean, median and population standard deviation."""
        if not self.values:
            return {"n": 0, "mean": float("nan"), "median": float("nan"), "sd": float("nan")}
        return {
            "n": len(self.values),
            "mean": fmean(self.values),
            "median": median(self.values),
            "sd": pstdev(self.values) if len(self.values) > 1 else 0.0,
        }


def summarise(rows: list[dict[str, float]], column: str, dropna: bool = True) -> dict[str, float]:
    """Summarise ``column`` across ``rows``.

    Unlike the version on ``main`` this reports a missing-value count and can
    be asked to treat a missing column as an explicit NaN observation.
    """
    summary = Summary(column)
    missing = 0
    for row in rows:
        if column in row:
            summary.add(row[column])
        else:
            missing += 1
            if not dropna:
                summary.add(float("nan"))
    result = summary.describe()
    result["missing"] = missing
    return result
