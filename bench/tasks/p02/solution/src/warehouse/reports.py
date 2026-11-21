"""Plain-text reports. Pure functions over the model objects."""

from .money import format_money


def stock_report(products):
    rows = ["%-8s %-20s %-10s %5s %9s" % ("SKU", "NAME", "CATEGORY", "STOCK", "PRICE")]
    units = 0
    value = 0
    for p in sorted(products, key=lambda p: p.sku):
        rows.append("%-8s %-20s %-10s %5d %9s" % (
            p.sku, p.name[:20], p.category[:10], p.stock, format_money(p.price_cents)))
        units += p.stock
        value += p.stock * p.price_cents
    rows.append("Total units: %d, value: %s" % (units, format_money(value)))
    return "\n".join(rows)


def sales_report(orders):
    counts = {"placed": 0, "shipped": 0, "cancelled": 0}
    revenue = 0
    tax = 0
    units = {}
    for order in orders:
        counts[order.status] += 1
        if order.status == "cancelled":
            continue
        revenue += order.total_cents
        tax += order.tax_cents
        for line in order.lines:
            units[line.sku] = units.get(line.sku, 0) + line.qty
    rows = [
        "Orders: %d (placed %d, shipped %d, cancelled %d)" % (
            len(orders), counts["placed"], counts["shipped"], counts["cancelled"]),
        "Revenue: %s" % format_money(revenue),
        "Tax collected: %s" % format_money(tax),
        "Units sold:",
    ]
    if not units:
        rows.append("  (none)")
    for sku, n in sorted(units.items(), key=lambda kv: (-kv[1], kv[0])):
        rows.append("  %-8s %5d" % (sku, n))
    return "\n".join(rows)


def statement(customer, orders):
    rows = ["Statement for %s (%s)" % (customer.id, customer.name)]
    if not orders:
        rows.append("(no orders)")
        return "\n".join(rows)
    due = 0
    for o in orders:
        rows.append("#%-4d%s  %-10s%10s" % (o.id, o.date, o.status, format_money(o.total_cents)))
        if o.status != "cancelled":
            due += o.total_cents
    rows.append("Balance due: %s" % format_money(due))
    return "\n".join(rows)


def pricing_block(pricing):
    def neg(cents):
        return "-" + format_money(cents) if cents else "0.00"

    rows = [
        ("Subtotal", format_money(pricing.gross_cents)),
        ("Bulk discount", neg(pricing.bulk_discount_cents)),
        ("Tier discount", neg(pricing.tier_discount_cents)),
        ("Coupon discount", neg(pricing.coupon_discount_cents)),
        ("Shipping", format_money(pricing.shipping_cents)),
        ("Tax", format_money(pricing.tax_cents)),
        ("Total", format_money(pricing.total_cents)),
    ]
    return "\n".join("%-16s%10s" % row for row in rows)
