"""Every pricing rule lives here. Quotes, orders and statements all use price_order."""

from dataclasses import dataclass

from .errors import ValidationError

TIER_PERCENT = {"standard": 0, "silver": 5, "gold": 10}
BULK_STEPS = ((50, 10), (10, 5))       # (minimum quantity, percent), best first
TAX_BPS = {"CA": 825, "NY": 800, "TX": 625, "OR": 0}
DEFAULT_TAX_BPS = 500
SHIPPING_FLAT = 799
FREE_SHIPPING_AT = 5000
COUPONS = ("SAVE10", "FLAT500", "FREESHIP")


def half_up(numerator, denominator):
    """numerator / denominator rounded half up (non-negative integers)."""
    return (2 * numerator + denominator) // (2 * denominator)


@dataclass(frozen=True)
class Pricing:
    gross_cents: int
    bulk_discount_cents: int
    tier_discount_cents: int
    coupon_discount_cents: int
    shipping_cents: int
    tax_cents: int
    total_cents: int

    def to_dict(self):
        return {
            "gross_cents": self.gross_cents,
            "bulk_discount_cents": self.bulk_discount_cents,
            "tier_discount_cents": self.tier_discount_cents,
            "coupon_discount_cents": self.coupon_discount_cents,
            "shipping_cents": self.shipping_cents,
            "tax_cents": self.tax_cents,
            "total_cents": self.total_cents,
        }


def normalise_coupon(coupon):
    """Canonical coupon name, or None for no coupon. Unknown names are an error."""
    if coupon is None:
        return None
    name = coupon.strip().upper()
    if name == "":
        return None
    if name not in COUPONS:
        raise ValidationError("unknown coupon: %s" % name)
    return name


def bulk_percent(qty):
    for minimum, percent in BULK_STEPS:
        if qty >= minimum:
            return percent
    return 0


def price_order(lines, tier="standard", region="OTHER", coupon=None):
    lines = list(lines)
    if not lines:
        raise ValidationError("no items")
    if tier not in TIER_PERCENT:
        raise ValidationError("bad tier: %r" % (tier,))
    coupon = normalise_coupon(coupon)

    gross = 0
    bulk = 0
    for unit, qty in lines:
        line_gross = unit * qty
        gross += line_gross
        bulk += half_up(line_gross * bulk_percent(qty), 100)
    subtotal = gross - bulk

    tier_discount = half_up(subtotal * TIER_PERCENT[tier], 100)
    after_tier = subtotal - tier_discount

    coupon_discount = 0
    if coupon == "SAVE10":
        coupon_discount = half_up(after_tier * 10, 100)
    elif coupon == "FLAT500":
        coupon_discount = min(500, after_tier)
    discounted = after_tier - coupon_discount

    if coupon == "FREESHIP" or discounted >= FREE_SHIPPING_AT:
        shipping = 0
    else:
        shipping = SHIPPING_FLAT

    bps = TAX_BPS.get(str(region).strip().upper(), DEFAULT_TAX_BPS)
    tax = half_up(discounted * bps, 10000)
    return Pricing(gross, bulk, tier_discount, coupon_discount, shipping, tax,
                   discounted + shipping + tax)
