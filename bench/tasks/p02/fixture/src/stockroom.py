"""stockroom - inventory and order processing for the Harbor Street shop.

Everything lives in this one module: parsing, pricing, stock, reports and the
JSON data file.  State is kept in the module level dictionaries below, so a
process works with exactly one shop at a time.  Call reset() to start over.

Money is always an integer number of cents.
"""

import json
import os
import re
import datetime

# ---------------------------------------------------------------------------
# global state
# ---------------------------------------------------------------------------

PRODUCTS = {}      # sku -> {"sku", "name", "price_cents", "category", "stock"}
CUSTOMERS = {}     # id -> {"id", "name", "tier", "region"}
ORDERS = []        # list of order dicts, in id order
NEXT_ORDER_ID = 1
LAST_DATA_FILE = None

TIERS = ["standard", "silver", "gold"]
TIER_PCT = {"standard": 0, "silver": 5, "gold": 10}

TAX_BPS = {"CA": 825, "NY": 800, "TX": 625, "OR": 0}
DEFAULT_TAX_BPS = 500

SHIPPING_FLAT = 799
FREE_SHIPPING_AT = 5000

COUPON_NAMES = ["SAVE10", "FLAT500", "FREESHIP"]

SKU_RE = re.compile(r"[A-Z0-9][A-Z0-9-]*")
CUSTOMER_RE = re.compile(r"[A-Za-z0-9_-]+")
ITEM_RE = re.compile(r"([A-Z0-9][A-Z0-9-]*)x([0-9]+)")
DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
MONEY_RE = re.compile(r"\$?([0-9]+)(?:\.([0-9]{1,2}))?")


def reset():
    global NEXT_ORDER_ID, LAST_DATA_FILE
    PRODUCTS.clear()
    CUSTOMERS.clear()
    del ORDERS[:]
    NEXT_ORDER_ID = 1
    LAST_DATA_FILE = None


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _rnd(n, d):
    """n / d rounded half up, for non-negative integers."""
    return (2 * n + d) // (2 * d)


def _today():
    t = os.environ.get("WH_TODAY")
    if t:
        return t
    return datetime.date.today().isoformat()


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def parse_money(text):
    """'12.50' -> 1250, '$3' -> 300, '7.5' -> 750."""
    m = MONEY_RE.fullmatch(text.strip())
    if not m:
        raise ValueError("bad money: %r" % (text,))
    whole = int(m.group(1))
    frac = m.group(2)
    if frac is None:
        cents = 0
    elif len(frac) == 1:
        cents = int(frac) * 10
    else:
        cents = int(frac)
    return whole * 100 + cents


def fmt_money(cents):
    sign = ""
    if cents < 0:
        sign = "-"
        cents = -cents
    return "%s%d.%02d" % (sign, cents // 100, cents % 100)


def parse_line_items(text):
    """'A1x2, B2x10' -> [('A1', 2), ('B2', 10)].  Repeated skus are added up."""
    if text is None or text.strip() == "":
        raise ValueError("no items")
    result = []
    index = {}
    for chunk in text.split(","):
        piece = chunk.strip()
        m = ITEM_RE.fullmatch(piece)
        if not m:
            raise ValueError("bad item: %r" % (piece,))
        sku = m.group(1)
        qty = int(m.group(2))
        if qty < 1:
            raise ValueError("bad quantity in %r" % (piece,))
        if sku in index:
            pos = index[sku]
            result[pos] = (sku, result[pos][1] + qty)
        else:
            index[sku] = len(result)
            result.append((sku, qty))
    return result


def parse_products_csv(text):
    """Parse a product list.  Header: sku,name,price,category,stock."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "sku,name,price,category,stock":
        raise ValueError("bad header")
    rows = []
    for number, raw in enumerate(lines, 1):
        if number == 1:
            continue
        if raw.strip() == "":
            continue
        parts = [p.strip() for p in raw.split(",")]
        if len(parts) != 5:
            raise ValueError("bad row %d: expected 5 fields" % number)
        try:
            price = parse_money(parts[2])
        except ValueError:
            raise ValueError("bad row %d: bad price" % number)
        if not re.fullmatch(r"[0-9]+", parts[4]):
            raise ValueError("bad row %d: bad stock" % number)
        rows.append({"sku": parts[0], "name": parts[1], "price_cents": price,
                     "category": parts[3], "stock": int(parts[4])})
    return rows


# ---------------------------------------------------------------------------
# catalog: products, customers, stock
# ---------------------------------------------------------------------------

def add_product(sku, name, price_cents, category, stock=0):
    if not isinstance(sku, str) or not SKU_RE.fullmatch(sku):
        raise ValueError("bad sku: %r" % (sku,))
    if not isinstance(name, str) or name.strip() == "":
        raise ValueError("bad name")
    if not _is_int(price_cents) or price_cents < 0:
        raise ValueError("bad price: %s" % (price_cents,))
    if not isinstance(category, str) or category.strip() == "":
        raise ValueError("bad category")
    if not _is_int(stock) or stock < 0:
        raise ValueError("bad stock: %s" % (stock,))
    if sku in PRODUCTS:
        raise ValueError("duplicate sku: %s" % sku)
    PRODUCTS[sku] = {
        "sku": sku,
        "name": name.strip(),
        "price_cents": price_cents,
        "category": category.strip(),
        "stock": stock,
    }
    return dict(PRODUCTS[sku])


def import_products(text):
    """Add every product of a CSV text.  Nothing is added if anything is wrong."""
    rows = parse_products_csv(text)
    seen = set()
    for r in rows:
        if not SKU_RE.fullmatch(r["sku"]):
            raise ValueError("bad sku: %r" % (r["sku"],))
        if r["sku"] in PRODUCTS or r["sku"] in seen:
            raise ValueError("duplicate sku: %s" % r["sku"])
        if r["name"] == "":
            raise ValueError("bad name")
        if r["category"] == "":
            raise ValueError("bad category")
        seen.add(r["sku"])
    for r in rows:
        add_product(r["sku"], r["name"], r["price_cents"], r["category"], r["stock"])
    return len(rows)


def add_customer(customer_id, name, tier="standard", region="OTHER"):
    if not isinstance(customer_id, str) or not CUSTOMER_RE.fullmatch(customer_id):
        raise ValueError("bad customer id: %r" % (customer_id,))
    if not isinstance(name, str) or name.strip() == "":
        raise ValueError("bad name")
    if tier not in TIERS:
        raise ValueError("bad tier: %r" % (tier,))
    if not isinstance(region, str) or region.strip() == "":
        raise ValueError("bad region: %r" % (region,))
    if customer_id in CUSTOMERS:
        raise ValueError("duplicate customer: %s" % customer_id)
    CUSTOMERS[customer_id] = {
        "id": customer_id,
        "name": name.strip(),
        "tier": tier,
        "region": region.strip().upper(),
    }
    return dict(CUSTOMERS[customer_id])


def adjust_stock(sku, delta):
    if sku not in PRODUCTS:
        raise ValueError("unknown sku: %s" % sku)
    if not _is_int(delta):
        raise ValueError("bad delta: %r" % (delta,))
    new_stock = PRODUCTS[sku]["stock"] + delta
    if new_stock < 0:
        raise ValueError("insufficient stock for %s: have %d, need %d"
                         % (sku, PRODUCTS[sku]["stock"], -delta))
    PRODUCTS[sku]["stock"] = new_stock
    return new_stock


def low_stock_skus(threshold):
    out = []
    for sku in sorted(PRODUCTS):
        if PRODUCTS[sku]["stock"] <= threshold:
            out.append(sku)
    return out


# ---------------------------------------------------------------------------
# pricing, copy 1: place_order (the one that is actually charged)
# ---------------------------------------------------------------------------

def _normalise_coupon(coupon):
    if coupon is None:
        return None
    c = coupon.strip().upper()
    if c == "":
        return None
    if c not in COUPON_NAMES:
        raise ValueError("unknown coupon: %s" % c)
    return c


def place_order(customer_id, items_text, coupon=None, date=None):
    global NEXT_ORDER_ID
    if date is None:
        date = _today()
    if not isinstance(date, str) or not DATE_RE.fullmatch(date):
        raise ValueError("bad date: %r" % (date,))
    if customer_id not in CUSTOMERS:
        raise ValueError("unknown customer: %s" % customer_id)
    customer = CUSTOMERS[customer_id]
    items = parse_line_items(items_text)
    for sku, qty in items:
        if sku not in PRODUCTS:
            raise ValueError("unknown sku: %s" % sku)
    coupon = _normalise_coupon(coupon)
    for sku, qty in items:
        have = PRODUCTS[sku]["stock"]
        if have < qty:
            raise ValueError("insufficient stock for %s: have %d, need %d" % (sku, have, qty))

    # price the lines
    gross = 0
    bulk = 0
    lines = []
    for sku, qty in items:
        unit = PRODUCTS[sku]["price_cents"]
        line_gross = unit * qty
        if qty >= 50:
            pct = 10
        elif qty >= 10:
            pct = 5
        else:
            pct = 0
        line_bulk = _rnd(line_gross * pct, 100)
        gross += line_gross
        bulk += line_bulk
        lines.append({"sku": sku, "qty": qty, "unit_cents": unit})
    subtotal = gross - bulk

    tier_pct = TIER_PCT[customer["tier"]]
    tier_discount = _rnd(subtotal * tier_pct, 100)
    after_tier = subtotal - tier_discount

    coupon_discount = 0
    free_ship = False
    if coupon == "SAVE10":
        coupon_discount = _rnd(after_tier * 10, 100)
    elif coupon == "FLAT500":
        coupon_discount = min(500, after_tier)
    elif coupon == "FREESHIP":
        free_ship = True
    discounted = after_tier - coupon_discount

    if free_ship:
        shipping = 0
    elif discounted >= FREE_SHIPPING_AT:
        shipping = 0
    else:
        shipping = SHIPPING_FLAT

    bps = TAX_BPS.get(customer["region"], DEFAULT_TAX_BPS)
    tax = _rnd(discounted * bps, 10000)
    total = discounted + shipping + tax

    # take the stock
    for sku, qty in items:
        PRODUCTS[sku]["stock"] -= qty

    order = {
        "id": NEXT_ORDER_ID,
        "customer_id": customer_id,
        "date": date,
        "coupon": coupon,
        "status": "placed",
        "lines": lines,
        "gross_cents": gross,
        "bulk_discount_cents": bulk,
        "tier_discount_cents": tier_discount,
        "coupon_discount_cents": coupon_discount,
        "shipping_cents": shipping,
        "tax_cents": tax,
        "total_cents": total,
    }
    NEXT_ORDER_ID += 1
    ORDERS.append(order)
    return json.loads(json.dumps(order))


# ---------------------------------------------------------------------------
# pricing, copy 2: quote_order (preview, nothing is changed)
# ---------------------------------------------------------------------------

def quote_order(customer_id, items_text, coupon=None):
    if customer_id not in CUSTOMERS:
        raise ValueError("unknown customer: %s" % customer_id)
    cust = CUSTOMERS[customer_id]
    parsed = parse_line_items(items_text)
    for sku, qty in parsed:
        if sku not in PRODUCTS:
            raise ValueError("unknown sku: %s" % sku)
    coupon = _normalise_coupon(coupon)

    g = 0
    b = 0
    for sku, qty in parsed:
        unit = PRODUCTS[sku]["price_cents"]
        lg = unit * qty
        pct = 0
        if qty >= 10:
            pct = 5
        if qty >= 50:
            pct = 10
        g += lg
        b += _rnd(lg * pct, 100)
    sub = g - b

    td = _rnd(sub * TIER_PCT[cust["tier"]], 100)
    at = sub - td

    cd = 0
    fs = False
    if coupon == "SAVE10":
        cd = _rnd(at * 10, 100)
    if coupon == "FLAT500":
        cd = 500 if at > 500 else at
    if coupon == "FREESHIP":
        fs = True
    disc = at - cd

    ship = SHIPPING_FLAT
    if fs or disc >= FREE_SHIPPING_AT:
        ship = 0

    rate = TAX_BPS.get(cust["region"], DEFAULT_TAX_BPS)
    # NOTE: round() here is the builtin
    tax = int(round(disc * rate / 10000.0))

    return {
        "gross_cents": g,
        "bulk_discount_cents": b,
        "tier_discount_cents": td,
        "coupon_discount_cents": cd,
        "shipping_cents": ship,
        "tax_cents": tax,
        "total_cents": disc + ship + tax,
    }


# ---------------------------------------------------------------------------
# pricing, copy 3: reprice_order (used by the customer statement)
# ---------------------------------------------------------------------------

def reprice_order(order):
    """Work out an order's total again from its stored lines."""
    cust = CUSTOMERS[order["customer_id"]]
    gross_total = 0
    bulk_total = 0
    for line in order["lines"]:
        lg = line["unit_cents"] * line["qty"]
        if line["qty"] >= 50:
            p = 10
        elif line["qty"] >= 10:
            p = 5
        else:
            p = 0
        gross_total += lg
        bulk_total += _rnd(lg * p, 100)
    subtotal = gross_total - bulk_total

    tier_d = _rnd(subtotal * TIER_PCT[cust["tier"]], 100)
    after = subtotal - tier_d

    coupon_d = 0
    free = False
    if order["coupon"] == "SAVE10":
        coupon_d = _rnd(after * 10, 100)
    elif order["coupon"] == "FLAT500":
        coupon_d = min(after, 500)
    elif order["coupon"] == "FREESHIP":
        free = True
    net = after - coupon_d

    if free:
        ship = 0
    elif subtotal >= FREE_SHIPPING_AT:
        ship = 0
    else:
        ship = SHIPPING_FLAT

    tax = _rnd(net * TAX_BPS.get(cust["region"], DEFAULT_TAX_BPS), 10000)
    return {
        "gross_cents": gross_total,
        "bulk_discount_cents": bulk_total,
        "tier_discount_cents": tier_d,
        "coupon_discount_cents": coupon_d,
        "shipping_cents": ship,
        "tax_cents": tax,
        "total_cents": net + ship + tax,
    }


# ---------------------------------------------------------------------------
# order life cycle
# ---------------------------------------------------------------------------

def _find_order(order_id):
    for o in ORDERS:
        if o["id"] == order_id:
            return o
    raise ValueError("unknown order: %s" % (order_id,))


def ship_order(order_id):
    o = _find_order(order_id)
    if o["status"] != "placed":
        raise ValueError("order %s is %s, cannot ship" % (order_id, o["status"]))
    o["status"] = "shipped"
    return json.loads(json.dumps(o))


def cancel_order(order_id):
    o = _find_order(order_id)
    if o["status"] != "placed":
        raise ValueError("order %s is %s, cannot cancel" % (order_id, o["status"]))
    for line in o["lines"]:
        PRODUCTS[line["sku"]]["stock"] += line["qty"]
    o["status"] = "cancelled"
    return json.loads(json.dumps(o))


def get_order(order_id):
    return json.loads(json.dumps(_find_order(order_id)))


# ---------------------------------------------------------------------------
# reports (plain text, no trailing newline)
# ---------------------------------------------------------------------------

def stock_report():
    out = []
    out.append("%-8s %-20s %-10s %5s %9s" % ("SKU", "NAME", "CATEGORY", "STOCK", "PRICE"))
    units = 0
    value = 0
    for sku in sorted(PRODUCTS):
        p = PRODUCTS[sku]
        out.append("%-8s %-20s %-10s %5d %9s" % (
            p["sku"], p["name"][:20], p["category"][:10], p["stock"], fmt_money(p["price_cents"])))
        units += p["stock"]
        value += p["stock"] * p["price_cents"]
    out.append("Total units: %d, value: %s" % (units, fmt_money(value)))
    return "\n".join(out)


def sales_report():
    placed = 0
    shipped = 0
    cancelled = 0
    revenue = 0
    tax = 0
    units = {}
    for o in ORDERS:
        if o["status"] == "cancelled":
            cancelled += 1
            continue
        if o["status"] == "placed":
            placed += 1
        else:
            shipped += 1
        revenue += o["total_cents"]
        tax += o["tax_cents"]
        for line in o["lines"]:
            units[line["sku"]] = units.get(line["sku"], 0) + line["qty"]
    out = []
    out.append("Orders: %d (placed %d, shipped %d, cancelled %d)" % (
        len(ORDERS), placed, shipped, cancelled))
    out.append("Revenue: %s" % fmt_money(revenue))
    out.append("Tax collected: %s" % fmt_money(tax))
    out.append("Units sold:")
    if not units:
        out.append("  (none)")
    else:
        ranked = sorted(units.items(), key=lambda kv: (-kv[1], kv[0]))
        for sku, n in ranked:
            out.append("  %-8s %5d" % (sku, n))
    return "\n".join(out)


def customer_statement(customer_id):
    if customer_id not in CUSTOMERS:
        raise ValueError("unknown customer: %s" % customer_id)
    c = CUSTOMERS[customer_id]
    out = ["Statement for %s (%s)" % (c["id"], c["name"])]
    mine = [o for o in ORDERS if o["customer_id"] == customer_id]
    if not mine:
        out.append("(no orders)")
        return "\n".join(out)
    due = 0
    for o in mine:
        total = reprice_order(o)["total_cents"]
        out.append("#%-4d%s  %-10s%10s" % (o["id"], o["date"], o["status"], fmt_money(total)))
        if o["status"] != "cancelled":
            due += total
    out.append("Balance due: %s" % fmt_money(due))
    return "\n".join(out)


def pricing_block(p):
    """Seven aligned lines for a quote or a freshly placed order."""
    rows = [
        ("Subtotal", fmt_money(p["gross_cents"])),
        ("Bulk discount", _neg(p["bulk_discount_cents"])),
        ("Tier discount", _neg(p["tier_discount_cents"])),
        ("Coupon discount", _neg(p["coupon_discount_cents"])),
        ("Shipping", fmt_money(p["shipping_cents"])),
        ("Tax", fmt_money(p["tax_cents"])),
        ("Total", fmt_money(p["total_cents"])),
    ]
    return "\n".join("%-16s%10s" % (label, value) for label, value in rows)


def _neg(cents):
    if cents == 0:
        return "0.00"
    return "-" + fmt_money(cents)


# ---------------------------------------------------------------------------
# persistence: one JSON file
# ---------------------------------------------------------------------------

def save(path):
    global LAST_DATA_FILE
    data = {
        "version": 1,
        "next_order_id": NEXT_ORDER_ID,
        "products": [PRODUCTS[k] for k in sorted(PRODUCTS)],
        "customers": [CUSTOMERS[k] for k in sorted(CUSTOMERS)],
        "orders": sorted(ORDERS, key=lambda o: o["id"]),
    }
    folder = os.path.dirname(path)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)
    LAST_DATA_FILE = path


def load(path):
    """Replace the current state with the file's.  A missing file means an empty shop."""
    global NEXT_ORDER_ID, LAST_DATA_FILE
    reset()
    LAST_DATA_FILE = path
    if not os.path.exists(path):
        return
    try:
        with open(path) as fh:
            data = json.load(fh)
    except ValueError:
        raise ValueError("invalid data file: %s" % path)
    if not isinstance(data, dict):
        raise ValueError("invalid data file: %s" % path)
    for p in data.get("products", []):
        PRODUCTS[p["sku"]] = {
            "sku": p["sku"], "name": p["name"], "price_cents": p["price_cents"],
            "category": p["category"], "stock": p["stock"],
        }
    for c in data.get("customers", []):
        CUSTOMERS[c["id"]] = {
            "id": c["id"], "name": c["name"], "tier": c["tier"], "region": c["region"],
        }
    for o in data.get("orders", []):
        ORDERS.append(json.loads(json.dumps(o)))
    ORDERS.sort(key=lambda o: o["id"])
    nxt = data.get("next_order_id")
    if nxt is None:
        nxt = max([o["id"] for o in ORDERS] or [0]) + 1
    NEXT_ORDER_ID = nxt
