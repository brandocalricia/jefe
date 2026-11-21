# Harbor Street stockroom

Small inventory and order system for the Harbor Street hardware shop. It keeps products,
customers and orders in one JSON file and prints plain-text reports.

## Using it

    export WH_TODAY=2025-03-01          # optional; orders are dated today otherwise
    python3 src/stockroom_cli.py --data shop.json import-products data/sample_products.csv
    python3 src/stockroom_cli.py --data shop.json add-customer C1 "Ada Lovelace" gold CA
    python3 src/stockroom_cli.py --data shop.json quote C1 "HAM-16x2,GLV-Lx10" SAVE10
    python3 src/stockroom_cli.py --data shop.json order C1 "HAM-16x2,GLV-Lx10"
    python3 src/stockroom_cli.py --data shop.json report stock

Money is stored as integer cents. Prices, discounts, shipping and tax rules are described
in the comments of `src/stockroom.py`; `SPEC.md` describes the planned clean-up.

## Layout

- `src/stockroom.py`      the whole system (to be split up, see SPEC.md)
- `src/stockroom_cli.py`  command line script
- `data/sample_products.csv`  example catalogue
- `tests/`                unit tests (`python3 -m unittest discover -s tests`)
