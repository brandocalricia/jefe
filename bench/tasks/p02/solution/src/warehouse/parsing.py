"""Turning text into items and products."""

import re

from .errors import ValidationError
from .models import Product
from .money import parse_money

ITEM_RE = re.compile(r"([A-Z0-9][A-Z0-9-]*)x([0-9]+)")
CSV_HEADER = "sku,name,price,category,stock"


def merge_items(pairs):
    """Add up repeated skus, keeping the position of the first appearance."""
    merged = {}
    for sku, qty in pairs:
        merged[sku] = merged.get(sku, 0) + qty
    return list(merged.items())


def parse_items(text):
    """'A1x2, B2x10' -> [('A1', 2), ('B2', 10)]."""
    if text is None or text.strip() == "":
        raise ValidationError("no items")
    pairs = []
    for chunk in text.split(","):
        piece = chunk.strip()
        match = ITEM_RE.fullmatch(piece)
        if match is None:
            raise ValidationError("bad item: %r" % (piece,))
        qty = int(match.group(2))
        if qty < 1:
            raise ValidationError("bad quantity in %r" % (piece,))
        pairs.append((match.group(1), qty))
    return merge_items(pairs)


def parse_products_csv(text):
    lines = text.splitlines()
    if not lines or lines[0].strip() != CSV_HEADER:
        raise ValidationError("bad header")
    products = []
    for number, raw in enumerate(lines, 1):
        if number == 1 or raw.strip() == "":
            continue
        parts = [p.strip() for p in raw.split(",")]
        if len(parts) != 5:
            raise ValidationError("bad row %d: expected 5 fields" % number)
        try:
            price = parse_money(parts[2])
        except ValidationError:
            raise ValidationError("bad row %d: bad price" % number) from None
        if re.fullmatch(r"[0-9]+", parts[4]) is None:
            raise ValidationError("bad row %d: bad stock" % number)
        products.append(Product(parts[0], parts[1], price, parts[3], int(parts[4])))
    return products
