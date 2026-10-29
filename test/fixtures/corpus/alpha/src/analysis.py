"""Summarise tabular observations held in memory."""

from statistics import fmean, pstdev


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

    def describe(self) -> dict[str, float]:
        """Return count, mean and population standard deviation."""
        if not self.values:
            return {"n": 0, "mean": float("nan"), "sd": float("nan")}
        return {
            "n": len(self.values),
            "mean": fmean(self.values),
            "sd": pstdev(self.values) if len(self.values) > 1 else 0.0,
        }


def summarise(rows: list[dict[str, float]], column: str) -> dict[str, float]:
    """Summarise ``column`` across ``rows``.

    Rows that do not contain the column are skipped.
    """
    summary = Summary(column)
    for row in rows:
        if column in row:
            summary.add(row[column])
    return summary.describe()
