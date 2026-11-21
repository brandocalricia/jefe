# SPEC: turn `stockroom` into the `warehouse` package

`src/stockroom.py` is the shop's inventory and order system. It works, but it is one
600-line module with global state, three copies of the pricing code and parsing,
reporting and file handling all mixed together. This spec describes the refactor.
**Behaviour must not change** except where a part below says so. Where this spec is silent,
the current behaviour of `src/stockroom.py` and `src/stockroom_cli.py` is the reference
(read them; `git log` has the originals). Python 3.11, standard library only.

Tests run with `python3 -m unittest discover -s tests` from the repository root. Test files
add `src/` to `sys.path` themselves, as `tests/test_characterisation.py` does. The CLI is
also run as `python3 -m warehouse` with `PYTHONPATH=src`.

Work in five parts. Later parts use earlier ones.

---------------------------------------------------------------------------------------------

## A. The package, the models and the `Warehouse` object

### A.1 Layout

Create the package `src/warehouse/` with at least these modules (more are allowed):

| module | contents |
| --- | --- |
| `warehouse/errors.py` | the exception classes (A.2) |
| `warehouse/money.py` | `parse_money`, `format_money` |
| `warehouse/parsing.py` | `parse_items`, `parse_products_csv` |
| `warehouse/models.py` | `Product`, `Customer`, `OrderLine`, `Order` |
| `warehouse/pricing.py` | `Pricing`, `price_order`, `half_up` (part B) |
| `warehouse/store.py` | `Store`, `MemoryStore`, `JsonFileStore` (part C) |
| `warehouse/service.py` | `Warehouse` |
| `warehouse/cli.py` | `main` (part E) |
| `warehouse/__main__.py` | runs `main` (part E) |

`warehouse/__init__.py` re-exports: every exception class, `parse_money`, `format_money`,
`parse_items`, `parse_products_csv`, `Product`, `Customer`, `OrderLine`, `Order`, `Pricing`,
`price_order`, `Store`, `MemoryStore`, `JsonFileStore`, `Warehouse`. Importing the package
must not print anything or emit warnings.

**No global mutable state.** All shop data (products, customers, orders, the next order id)
lives in a `Warehouse` object. Two `Warehouse()` objects never see each other's data, and a
new `Warehouse()` is always empty (its first order gets id 1).

### A.2 Errors (`warehouse/errors.py`)

`WarehouseError(ValueError)` is the base class. Its subclasses, all directly under it:
`ValidationError`, `DuplicateError`, `NotFoundError`, `StockError`, `StateError`,
`StoreError`. Because the base class is a `ValueError`, old callers that catch `ValueError`
keep working. `str(exc)` is exactly the message given below.

| class | messages |
| --- | --- |
| `ValidationError` | `bad money: 'x'` (the repr of the text given), `no items`, `bad item: 'x'` (repr of the stripped piece), `bad quantity in 'A1x0'`, `bad header`, `bad row N: expected 5 fields`, `bad row N: bad price`, `bad row N: bad stock`, `bad sku: 'x'`, `bad name`, `bad price: -5`, `bad category`, `bad stock: -1`, `bad customer id: 'x'`, `bad tier: 'x'`, `bad region: 'x'`, `bad delta: 'x'`, `bad date: 'x'`, `bad threshold: -1`, `unknown coupon: NAME` |
| `DuplicateError` | `duplicate sku: A1`, `duplicate customer: C1` |
| `NotFoundError` | `unknown sku: A1`, `unknown customer: C1`, `unknown order: 7` |
| `StockError` | `insufficient stock for A1: have 3, need 5` |
| `StateError` | `order 3 is shipped, cannot cancel`, `order 3 is cancelled, cannot ship` (status word and verb vary) |
| `StoreError` | `invalid data file: <path>` |

In `bad price: -5`, `bad stock: -1`, `bad threshold: -1` the value is formatted with `%s`
(so `-5`); in the others written with quotes the value is formatted with `%r`.

### A.3 Money and parsing

- `parse_money(text: str) -> int` returns cents. After stripping whitespace the text must be an
  optional `$`, one or more digits, and optionally `.` plus one or two digits. `"12.50"` is
  `1250`, `"$3"` is `300`, `"7.5"` is `750`. Anything else (negative, comma, `.5`, empty,
  `12.345`) raises `ValidationError("bad money: <repr of the original text>")`.
- `format_money(cents: int) -> str`: `1250` is `"12.50"`, `5` is `"0.05"`, `-50` is `"-0.50"`,
  `123456789` is `"1234567.89"` (no thousands separators).
- `parse_items(text: str) -> list[tuple[str, int]]` parses `"A1x2, B2x10"`. Items are separated
  by commas; each item, after stripping, is a SKU, a lowercase `x`, and a quantity
  (`[A-Z0-9][A-Z0-9-]*` then `x` then digits, with no spaces inside the item). The quantity
  must be at least 1. Repeated SKUs are added up and keep the position of their first
  appearance: `"A1x2,B2x1,A1x3"` gives `[("A1", 5), ("B2", 1)]`. Blank or `None` input raises
  `ValidationError("no items")`; a malformed piece (including an empty piece such as the one
  in `"A1x1,,B2x1"`) raises `bad item: ''`-style errors; quantity 0 raises
  `bad quantity in 'A1x0'`.
- `parse_products_csv(text: str) -> list[Product]`. The first line must be exactly
  `sku,name,price,category,stock` (after stripping) else `ValidationError("bad header")`; an
  empty text is also a bad header. Blank lines are skipped. Other lines are split on `,` (no
  quoting) and each field is stripped; there must be 5 fields, `price` goes through
  `parse_money`, `stock` must be digits. Errors are `bad row N: ...` where N is the 1-based
  line number in the text (the header is line 1) and the rest is `expected 5 fields`,
  `bad price` or `bad stock`. The function does not check SKU format or duplicates.

### A.4 Models (`warehouse/models.py`)

Frozen dataclasses (so a returned object can never alter the warehouse):

- `Product(sku: str, name: str, price_cents: int, category: str, stock: int)`
- `Customer(id: str, name: str, tier: str, region: str)`
- `OrderLine(sku: str, qty: int, unit_cents: int)`
- `Order(id: int, customer_id: str, date: str, coupon: str | None, status: str,
  lines: tuple[OrderLine, ...], gross_cents: int, bulk_discount_cents: int,
  tier_discount_cents: int, coupon_discount_cents: int, shipping_cents: int,
  tax_cents: int, total_cents: int)`

`Product.to_dict()`, `Customer.to_dict()`, `OrderLine.to_dict()` and `Order.to_dict()` return
plain dicts keyed by the field names (for `Order`, `lines` is a list of the `OrderLine.to_dict()`
dicts, `{"sku", "qty", "unit_cents"}`).
`Pricing.to_dict()` (part B) returns the seven money fields.

### A.5 `Warehouse` (`warehouse/service.py`)

```python
class Warehouse:
    def __init__(self, store: Store | None = None) -> None
    def save(self) -> None
    def snapshot(self) -> dict                          # part C
    # catalog
    def add_product(self, sku: str, name: str, price_cents: int, category: str, stock: int = 0) -> Product
    def get_product(self, sku: str) -> Product
    def products(self) -> list[Product]                 # sorted by sku
    def import_products_csv(self, text: str) -> int     # returns how many were added
    def add_customer(self, customer_id: str, name: str, tier: str = "standard", region: str = "OTHER") -> Customer
    def get_customer(self, customer_id: str) -> Customer
    def adjust_stock(self, sku: str, delta: int) -> int  # returns the new stock
    def low_stock(self, threshold: int) -> list[Product]
    # orders (part B)
    def quote(self, customer_id: str, items, coupon: str | None = None) -> Pricing
    def place_order(self, customer_id: str, items, date: str, coupon: str | None = None) -> Order
    def ship_order(self, order_id: int) -> Order
    def cancel_order(self, order_id: int) -> Order
    def get_order(self, order_id: int) -> Order
    def orders(self) -> list[Order]                     # sorted by id
    # reports (part B)
    def stock_report(self) -> str
    def sales_report(self) -> str
    def statement(self, customer_id: str) -> str
```

`items` is a sequence of `(sku, qty)` tuples, as `parse_items` returns.

Validation (same rules and messages as today; checks run in the order shown, the first
failure is raised):

- `add_product`: `sku` must be a string matching `[A-Z0-9][A-Z0-9-]*` (whole string) else
  `bad sku`; `name` a non-blank string else `bad name`; `price_cents` an int (not a bool)
  `>= 0` else `bad price`; `category` a non-blank string else `bad category`; `stock` an int
  (not a bool) `>= 0` else `bad stock`; then `duplicate sku`. Name and category are stored
  stripped. Returns the new `Product`.
- `import_products_csv(text)`: `parse_products_csv`, then for each row in file order:
  `bad sku`, `duplicate sku` (against the warehouse and earlier rows), `bad name`,
  `bad category`. If anything fails nothing is added. Otherwise all rows are added.
- `add_customer`: `customer_id` must match `[A-Za-z0-9_-]+` (whole string) else
  `bad customer id`; `name` non-blank else `bad name`; `tier` one of `standard`, `silver`,
  `gold` else `bad tier`; `region` a non-blank string else `bad region`; then
  `duplicate customer`. Name is stored stripped and region stripped and upper-cased.
- `get_product`, `get_customer`, `get_order`: `NotFoundError` when missing.
- `adjust_stock(sku, delta)`: `unknown sku`; `delta` must be an int (not a bool) else
  `bad delta`; if the new stock would be negative, `StockError` with `have` the current stock
  and `need` the absolute value of the delta, and nothing changes. Returns the new stock.
- `low_stock(threshold)`: `threshold` must be an int `>= 0` else `bad threshold`. Returns the
  products whose stock is `<= threshold`, sorted by stock ascending, then SKU.

---------------------------------------------------------------------------------------------

## B. Pricing in one place, orders and reports

### B.1 The pricing rules (`warehouse/pricing.py`)

```python
half_up(numerator: int, denominator: int) -> int      # (2n + d) // (2d) for n >= 0
price_order(lines, tier="standard", region="OTHER", coupon=None) -> Pricing
```

`lines` is a sequence of `(unit_cents, qty)` pairs. `Pricing` is a frozen dataclass with the
integer fields `gross_cents`, `bulk_discount_cents`, `tier_discount_cents`,
`coupon_discount_cents`, `shipping_cents`, `tax_cents`, `total_cents`, and `to_dict()`
returning those seven keys. Rules, in this order. Every percentage is taken with `half_up`
(round half up to a whole cent), never with floats or `round()`:

1. **Gross**: sum of `unit * qty`.
2. **Bulk discount**, per line: quantity `>= 50` gives 10 %, quantity `>= 10` gives 5 %,
   otherwise 0 %, of that line's `unit * qty`, rounded per line. `bulk_discount_cents` is the
   sum. `subtotal = gross - bulk`.
3. **Tier discount** on the subtotal: `standard` 0 %, `silver` 5 %, `gold` 10 %.
   `after_tier = subtotal - tier_discount`.
4. **Coupon** (case-insensitive and stripped; `None`, empty and blank mean no coupon; the
   canonical name is upper case): `SAVE10` takes 10 % of `after_tier`; `FLAT500` takes 500
   cents, but never more than `after_tier`; `FREESHIP` has no discount and makes shipping
   free. Any other name raises `ValidationError("unknown coupon: NAME")` with the stripped,
   upper-cased name. `discounted = after_tier - coupon_discount`.
5. **Shipping**: 0 with the `FREESHIP` coupon; otherwise 0 when `discounted >= 5000`, else 799.
6. **Tax**: `half_up(discounted * bps, 10000)` where `bps` is by region (upper-cased):
   `CA` 825, `NY` 800, `TX` 625, `OR` 0, any other region 500. Shipping is not taxed.
7. `total = discounted + shipping + tax`.

An empty `lines` raises `ValidationError("no items")`; an unknown tier raises
`bad tier: 'x'`.

### B.2 Two places where the old code disagrees with itself

`place_order`, `quote_order` and `reprice_order` (used by the customer statement) each had
their own copy of the rules. The copies agree except in two cases. **The rules in B.1 are the
correct behaviour; `place_order` already did it right.** These two fixes are the only places
where the prices, totals, stock levels, order records and report texts produced by the new code
may differ from what the legacy code produced for the same input; everywhere else they must be
identical.

1. *Tax rounding.* `quote_order` computed tax with floats and the builtin `round()`, which
   rounds exact halves to the even cent. Example: a 10.10 item for a standard customer in
   region `OTHER`: the tax is 50.5 cents. `place_order` charged 51 and the quote said 50.
   Correct: 51 (half up). After the refactor a quote always equals what the order is charged.
2. *Free-shipping threshold.* `reprice_order` tested the threshold against the subtotal
   before tier and coupon discounts instead of `discounted`, so the statement could show free
   shipping for an order that had been charged 7.99. Correct: test `discounted`. After the
   refactor the statement shows each order's own stored total.

### B.3 Orders

- `quote(customer_id, items, coupon=None) -> Pricing`: prices the basket with the customer's
  tier and region and the products' current prices. Checks, in order: customer exists
  (`NotFoundError`), `items` valid (below), every SKU exists, coupon valid. It does not check
  stock and changes nothing.
- `place_order(customer_id, items, date, coupon=None) -> Order`. Checks, in this order:
  `date` is a string of the form `NNNN-NN-NN` (digits only, `bad date` otherwise; the
  calendar is not checked), customer exists, items valid, every SKU exists (in item order),
  coupon valid, stock sufficient for every line (first failing line in item order raises
  `StockError`). Only if everything passes: the stock of every line is reduced, the order is
  priced with B.1 using the unit prices as they are now, and stored with status `"placed"`
  and the next id (ids start at 1 and are never reused). The coupon is stored in its canonical
  form or `None`. A failed call changes nothing, not even the id counter.
- "Items valid": a non-empty sequence of `(sku, qty)` where `qty` is an int `>= 1`
  (`bad quantity in 'SKUxQTY'` otherwise, using the sku and qty as given; `no items` for an
  empty sequence). Repeated SKUs are added up as in `parse_items`; the order's lines keep the
  first-appearance order of the SKUs.
- `ship_order(id)`: only a `placed` order can ship (`StateError`, `order 3 is cancelled,
  cannot ship`); status becomes `shipped`.
- `cancel_order(id)`: only a `placed` order can be cancelled (`order 3 is shipped, cannot
  cancel`, `order 3 is cancelled, cannot cancel`). Status becomes `cancelled` and every
  line's quantity goes back into stock.
- All three return the updated `Order`; unknown ids raise `NotFoundError("unknown order: 7")`.

### B.4 Reports

All reports are strings joined with `"\n"` and have no trailing newline. `format_money` is used
for every amount.

`stock_report()`: a header, one row per product sorted by SKU, a footer:

```
SKU      NAME                 CATEGORY   STOCK     PRICE
A1       Anvil                tools         10     20.00
Total units: 110, value: 350.00
```

Header: `"%-8s %-20s %-10s %5s %9s" % ("SKU", "NAME", "CATEGORY", "STOCK", "PRICE")`. Row: the
same layout with the name cut to 20 characters and the category to 10, stock as an integer
and the price as money. Footer: `Total units: <sum of stock>, value: <sum of stock * price>`.
With no products there is the header and a footer with zeros (`Total units: 0, value: 0.00`).

`sales_report()`:

```
Orders: 3 (placed 1, shipped 1, cancelled 1)
Revenue: 111.82
Tax collected: 6.53
Units sold:
  B2          11
  A1           2
```

`Orders` counts all orders; revenue and tax are the sums of `total_cents` and `tax_cents`
of the orders that are not cancelled. Units sold adds up line quantities of non-cancelled
orders per SKU, sorted by units descending then SKU, each row `"  %-8s %5d"`; with none, the
single row `  (none)`.

`statement(customer_id)`: `NotFoundError` for an unknown customer, else

```
Statement for C1 (Ada Lovelace)
#1   2025-03-01  shipped        55.53
#2   2025-03-04  cancelled      27.48
Balance due: 55.53
```

One row per order of that customer in id order: `"#%-4d%s  %-10s%10s" % (id, date, status,
money(total_cents))`. `Balance due` is the sum of the totals of non-cancelled orders. A
customer without orders gets `(no orders)` instead of rows and no balance line.

---------------------------------------------------------------------------------------------

## C. Persistence behind an interface

In `warehouse/store.py`:

```python
class Store(abc.ABC):
    def load(self) -> dict | None      # None means nothing has been saved yet
    def save(self, state: dict) -> None
class MemoryStore(Store):
    def __init__(self, state: dict | None = None)
class JsonFileStore(Store):
    def __init__(self, path: str | os.PathLike)
```

`Store` is abstract (it cannot be instantiated; both methods are abstract).

- `MemoryStore` keeps a deep copy of what it is given and returns a deep copy on `load`, so
  later changes to either side never leak. `MemoryStore()` loads `None`.
- `JsonFileStore.load()` returns `None` if the file does not exist. If the file is not valid
  JSON, or its top level is not an object, it raises `StoreError("invalid data file: <path>")`
  where `<path>` is `str(path)`.
- `JsonFileStore.save(state)` writes `json.dumps(state, indent=2, sort_keys=True) + "\n"`
  (UTF-8), creating missing parent folders. The write is atomic (write a temporary file next
  to the target and rename it over the target); after a save the folder holds the target file
  and nothing else.

`Warehouse(store=None)` uses a fresh `MemoryStore()` if no store is given, reads the state
from `store.load()` once, in `__init__` (`None` means an empty warehouse), and keeps
`store` as the attribute `.store`. Mutating methods do **not** save; `Warehouse.save()` calls
`store.save(self.snapshot())`.

`snapshot()` returns a new dict (no shared references):

```python
{"version": 1,
 "next_order_id": <int>,
 "products": [<Product.to_dict()> sorted by sku],
 "customers": [<Customer.to_dict()> sorted by id],
 "orders": [<Order.to_dict()> sorted by id]}
```

Loading accepts the same shape. A state without `"version"` (the format `stockroom.save`
has always written, which is otherwise identical) loads fine, and a missing `next_order_id`
means one more than the highest order id, or 1 with no orders. An order's `lines` and
all other values are restored exactly. Saving and loading is lossless: a `Warehouse` built
from a saved state has equal `products()`, `orders()`, customers and next order id, and the
same reports. A `Warehouse` on a `MemoryStore` and one on a `JsonFileStore` behave identically.

---------------------------------------------------------------------------------------------

## D. `stockroom.py` becomes a compatibility shim

Keep `src/stockroom.py` importable, but as a thin module (fewer than 150 lines, counted as `len(text.splitlines())` of the file) that holds one
private default `Warehouse` and re-exports the documented legacy functions on top of the new
package. It keeps none of the old module's data structures.

Functions, with their legacy signatures and return values:

| function | returns |
| --- | --- |
| `reset()` | `None`; replaces the private warehouse with a fresh empty one |
| `parse_money(text)` | int |
| `parse_line_items(text)` | list of `(sku, qty)` tuples |
| `add_product(sku, name, price_cents, category, stock=0)` | `Product.to_dict()` |
| `add_customer(customer_id, name, tier="standard", region="OTHER")` | `Customer.to_dict()` |
| `adjust_stock(sku, delta)` | int (new stock) |
| `place_order(customer_id, items_text, coupon=None, date=None)` | `Order.to_dict()`; `items_text` is a string for `parse_line_items`; if `date` is `None` the date is the environment variable `WH_TODAY` when set and non-empty, else today's date as `YYYY-MM-DD` |
| `quote_order(customer_id, items_text, coupon=None)` | `Pricing.to_dict()` |
| `ship_order(order_id)`, `cancel_order(order_id)` | `Order.to_dict()` |
| `stock_report()`, `sales_report()`, `customer_statement(customer_id)` | str |
| `save(path)` | `None`; writes the private warehouse to `path` with `JsonFileStore` |
| `load(path)` | `None`; replaces the private warehouse with one built on `JsonFileStore(path)`; a missing file gives an empty warehouse |

Because the shim uses the new code, it has the corrected pricing of B. Errors are the new
exception classes (still `ValueError`s with the same messages).

**Deprecation warning.** Every call of one of these functions, including `reset`, emits
exactly one warning, with category `DeprecationWarning` and the message
`stockroom.<name>() is deprecated; use the warehouse package instead` where `<name>` is the
function name (for example `stockroom.place_order() is deprecated; use the warehouse package
instead`). The warning is attributed to the file and line of the code that called the shim function (choose the stacklevel so that is true, whatever helpers you use), it is issued even when the call then raises an error (once, before the error propagates), and helper calls inside the
shim must not add warnings of their own. Importing `stockroom` emits no warning. The helper
functions the old module had beyond this list (`import_products`, `get_order`,
`low_stock_skus`, `pricing_block`, `fmt_money`, `reprice_order`, `parse_products_csv`) and its
module level data (`PRODUCTS`, `CUSTOMERS`, `ORDERS` and so on) are removed.

---------------------------------------------------------------------------------------------

## E. The command line

`src/stockroom_cli.py` becomes a few lines (under 60, counted the same way) that call `warehouse.cli.main(sys.argv[1:])` and
exit with its result (it must still add its own folder to `sys.path` so it runs from any
folder). The real implementation is `warehouse.cli.main`:

```python
def main(argv: list[str], stdout=None, stderr=None) -> int
```

`stdout` and `stderr` default to `sys.stdout` and `sys.stderr` (looked up when `main` is
called). `main` never raises for bad input and never calls `sys.exit`. The program runs with
`python3 -m warehouse ...` or `python3 src/stockroom_cli.py ...` and exits with `main`'s value.

Usage: `[--data FILE] COMMAND [ARGS...]`. `--data FILE` (only as the first two arguments)
names the data file, default `warehouse.json` in the current folder. The file is read
through `JsonFileStore`; commands that change something (marked * below) call `save()` when
they succeed and the others never write, not even to create the file. A command that fails
writes nothing.

Order dates come from the environment variable `WH_TODAY` (read when `main` runs) when it is
set and non-empty, else today's date; a bad value is an ordinary `bad date` error.

Commands and their exact standard output (each line ends with `\n`):

| command | output |
| --- | --- |
| `add-product* SKU NAME PRICE CATEGORY [STOCK]` | `added product SKU` |
| `add-customer* ID NAME [TIER] [REGION]` | `added customer ID` |
| `import-products* FILE` | `imported N products` |
| `stock* SKU DELTA` | `SKU stock: N` |
| `quote CUSTOMER ITEMS [COUPON]` | the pricing block |
| `order* CUSTOMER ITEMS [COUPON]` | `order N placed`, then the pricing block |
| `ship* ORDER_ID` | `order N shipped` |
| `cancel* ORDER_ID` | `order N cancelled` |
| `report stock` / `report sales` | `stock_report()` / `sales_report()` text |
| `statement CUSTOMER` | `statement(customer)` text |
| `low-stock THRESHOLD` (new) | see below |

`PRICE` goes through `parse_money`. `STOCK` must be digits only else `bad stock: '<text>'`.
`DELTA` must match an optional sign and digits else `bad delta: '<text>'`. `ORDER_ID` must be
digits else `bad order id: '<text>'`; `THRESHOLD` digits else `bad threshold: '<text>'`.
`import-products` reads the file as UTF-8 text; if it cannot be read the error is
`cannot read FILE`. `ITEMS` is parsed with `parse_items`.

**Pricing block**, seven lines, each `"%-16s%10s" % (label, value)`:

```
Subtotal             60.00
Bulk discount        -3.00
Tier discount        -5.70
Coupon discount       0.00
Shipping              0.00
Tax                   4.23
Total                55.53
```

The labels are `Subtotal` (gross), `Bulk discount`, `Tier discount`, `Coupon discount`,
`Shipping`, `Tax`, `Total`. The three discounts are shown as `-` followed by the amount when
not zero and as `0.00` when zero; the other values are plain money.

**New command `low-stock THRESHOLD`**: with no product at or below the threshold it prints
`no products at or below 5` (the threshold as typed, as an integer); otherwise the line
`low stock (<= 5):` and then one line per product of `Warehouse.low_stock`, in its order,
`"%-8s %5d  %s" % (sku, stock, name)`.

**Errors.** A `WarehouseError` or one of the argument errors above: nothing on stdout, the
line `error: <message>` on stderr, return 1. A usage problem (no command, unknown command,
wrong number of arguments, `report` with anything but `stock` or `sales`): nothing on stdout,
something starting with `usage error: ` on stderr, return 2. An unreadable data file
(`StoreError`) is an ordinary error (return 1).

---------------------------------------------------------------------------------------------

## Acceptance

- Every part above holds. Public names, signatures, messages and formats are exactly as written.
- `tests/test_characterisation.py` still passes unchanged (it may print deprecation warnings).
- Add your own tests under `tests/` for the new package; keep `python3 -m unittest discover -s tests` green.
- No new dependencies. No changes to `data/` or this file.
