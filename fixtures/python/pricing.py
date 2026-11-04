"""Prices for the shop."""


def discount(total):
    """10% off orders of 100 or more."""
    if total >= 100:
        return round(total * 0.9, 2)
    return total


def clamp(value, low, high):
    """Keep value between low and high."""
    return max(low, min(value, high))
