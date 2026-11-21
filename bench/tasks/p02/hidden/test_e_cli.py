import contextlib
import hashlib
import io
import os
import subprocess
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
sys.path.insert(0, SRC)

from warehouse.cli import main  # noqa: E402

CSV_TEXT = 'sku,name,price,category,stock\nBOLT-M6,Hex bolt M6 (box of 100),8.40,hardware,120\nNUT-M6,Hex nut M6 (box of 100),5.15,hardware,95\nHAM-16,Claw hammer 16oz,18.99,tools,14\nSAW-HS,Hand saw 20in,24.50,tools,6\nTAPE-25,Measuring tape 25ft,9.75,tools,40\nGLV-L,Work gloves large,7.20,safety,60\nGOG-01,Safety goggles,4.10,safety,0\nPAINT-W,White paint 1L,13.30,paint,22\n'

# (WH_TODAY, arguments, exit code, stdout, stderr) captured from the original script
GOLDEN = [('2025-03-01', ['import-products', '@CSV'], 0, 'imported 8 products\n', ''),
 ('2025-03-01', ['add-customer', 'C1', 'Ada Lovelace', 'gold', 'CA'], 0, 'added customer C1\n', ''),
 ('2025-03-01', ['add-customer', 'C2', 'Bob Builder'], 0, 'added customer C2\n', ''),
 ('2025-03-01', ['add-customer', 'C3', 'Cy Young', 'silver', 'ny'], 0, 'added customer C3\n', ''),
 ('2025-03-01',
  ['quote', 'C1', 'HAM-16x2,GLV-Lx10', 'SAVE10'],
  0,
  'Subtotal            109.98\n'
  'Bulk discount        -3.60\n'
  'Tier discount       -10.64\n'
  'Coupon discount      -9.57\n'
  'Shipping              0.00\n'
  'Tax                   7.11\n'
  'Total                93.28\n',
  ''),
 ('2025-03-02',
  ['order', 'C1', 'HAM-16x2,GLV-Lx10', 'save10'],
  0,
  'order 1 placed\n'
  'Subtotal            109.98\n'
  'Bulk discount        -3.60\n'
  'Tier discount       -10.64\n'
  'Coupon discount      -9.57\n'
  'Shipping              0.00\n'
  'Tax                   7.11\n'
  'Total                93.28\n',
  ''),
 ('2025-03-03',
  ['order', 'C2', 'BOLT-M6x60,TAPE-25x1'],
  0,
  'order 2 placed\n'
  'Subtotal            513.75\n'
  'Bulk discount       -50.40\n'
  'Tier discount         0.00\n'
  'Coupon discount       0.00\n'
  'Shipping              0.00\n'
  'Tax                  23.17\n'
  'Total               486.52\n',
  ''),
 ('2025-03-04',
  ['order', 'C3', 'SAW-HSx3, PAINT-Wx4,SAW-HSx1', 'FLAT500'],
  0,
  'order 3 placed\n'
  'Subtotal            151.20\n'
  'Bulk discount         0.00\n'
  'Tier discount        -7.56\n'
  'Coupon discount      -5.00\n'
  'Shipping              0.00\n'
  'Tax                  11.09\n'
  'Total               149.73\n',
  ''),
 ('2025-03-05', ['order', 'C2', 'GOG-01x1'], 1, '', 'error: insufficient stock for GOG-01: have 0, need 1\n'),
 ('2025-03-05',
  ['order', 'C2', 'TAPE-25x2', 'FREESHIP'],
  0,
  'order 4 placed\n'
  'Subtotal             19.50\n'
  'Bulk discount         0.00\n'
  'Tier discount         0.00\n'
  'Coupon discount       0.00\n'
  'Shipping              0.00\n'
  'Tax                   0.98\n'
  'Total                20.48\n',
  ''),
 ('2025-03-06', ['ship', '1'], 0, 'order 1 shipped\n', ''),
 ('2025-03-06', ['cancel', '2'], 0, 'order 2 cancelled\n', ''),
 ('2025-03-06', ['cancel', '1'], 1, '', 'error: order 1 is shipped, cannot cancel\n'),
 ('2025-03-07', ['stock', 'GOG-01', '+5'], 0, 'GOG-01 stock: 5\n', ''),
 ('2025-03-07',
  ['report', 'stock'],
  0,
  'SKU      NAME                 CATEGORY   STOCK     PRICE\n'
  'BOLT-M6  Hex bolt M6 (box of  hardware     120      8.40\n'
  'GLV-L    Work gloves large    safety        50      7.20\n'
  'GOG-01   Safety goggles       safety         5      4.10\n'
  'HAM-16   Claw hammer 16oz     tools         12     18.99\n'
  'NUT-M6   Hex nut M6 (box of 1 hardware      95      5.15\n'
  'PAINT-W  White paint 1L       paint         18     13.30\n'
  'SAW-HS   Hand saw 20in        tools          2     24.50\n'
  'TAPE-25  Measuring tape 25ft  tools         38      9.75\n'
  'Total units: 340, value: 2764.53\n',
  ''),
 ('2025-03-07',
  ['report', 'sales'],
  0,
  'Orders: 4 (placed 2, shipped 1, cancelled 1)\n'
  'Revenue: 263.49\n'
  'Tax collected: 19.18\n'
  'Units sold:\n'
  '  GLV-L       10\n'
  '  PAINT-W      4\n'
  '  SAW-HS       4\n'
  '  HAM-16       2\n'
  '  TAPE-25      2\n',
  ''),
 ('2025-03-07',
  ['statement', 'C1'],
  0,
  'Statement for C1 (Ada Lovelace)\n#1   2025-03-02  shipped        93.28\nBalance due: 93.28\n',
  ''),
 ('2025-03-07',
  ['statement', 'C2'],
  0,
  'Statement for C2 (Bob Builder)\n'
  '#2   2025-03-03  cancelled     486.52\n'
  '#4   2025-03-05  placed         20.48\n'
  'Balance due: 20.48\n',
  ''),
 ('2025-03-07',
  ['statement', 'C3'],
  0,
  'Statement for C3 (Cy Young)\n#3   2025-03-04  placed        149.73\nBalance due: 149.73\n',
  '')]


@contextlib.contextmanager
def env(**values):
    old = {k: os.environ.get(k) for k in values}
    for k, v in values.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class CliCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.data = os.path.join(self.dir, "shop.json")
        self.csv = os.path.join(self.dir, "products.csv")
        with open(self.csv, "w", encoding="utf-8") as fh:
            fh.write(CSV_TEXT)

    def run_cli(self, *args, today="2025-03-01", data=True):
        out, err = io.StringIO(), io.StringIO()
        argv = (["--data", self.data] if data else []) + list(args)
        with env(WH_TODAY=today):
            code = main(argv, out, err)
        return code, out.getvalue(), err.getvalue()

    def file_hash(self):
        if not os.path.exists(self.data):
            return None
        with open(self.data, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()

    def seed(self):
        self.run_cli("import-products", self.csv)
        self.run_cli("add-customer", "C1", "Ada Lovelace", "gold", "CA")
        self.run_cli("add-customer", "C2", "Bob Builder")


class GoldenSessionTest(CliCase):
    def test_session_matches_the_original_script(self):
        for date, args, code, out, err in GOLDEN:
            args = [self.csv if a == "@CSV" else a for a in args]
            got = self.run_cli(*args, today=date)
            self.assertEqual(got, (code, out, err), " ".join(args))

    def test_session_through_real_processes(self):
        env_vars = dict(os.environ, PYTHONPATH=SRC)
        for script in (["-m", "warehouse"], [os.path.join(SRC, "stockroom_cli.py")]):
            data = os.path.join(self.dir, "p%d.json" % len(script[0]))
            for date, args, code, out, err in GOLDEN:
                args = [self.csv if a == "@CSV" else a for a in args]
                r = subprocess.run([sys.executable] + script + ["--data", data] + args, capture_output=True,
                                   text=True, env=dict(env_vars, WH_TODAY=date), cwd=self.dir)
                self.assertEqual((r.returncode, r.stdout, r.stderr), (code, out, err), " ".join(args))


class CommandTest(CliCase):
    def test_add_commands(self):
        self.assertEqual(self.run_cli("add-product", "A1", "Anvil", "$20", "tools"), (0, "added product A1\n", ""))
        self.assertEqual(self.run_cli("add-product", "B2", "Bolt", "1.5", "hw", "7"), (0, "added product B2\n", ""))
        self.assertEqual(self.run_cli("add-customer", "C1", "Ada"), (0, "added customer C1\n", ""))
        self.assertEqual(self.run_cli("add-customer", "C2", "Bob", "silver"), (0, "added customer C2\n", ""))
        self.assertEqual(self.run_cli("add-customer", "C3", "Cy", "gold", "tx"), (0, "added customer C3\n", ""))
        self.assertEqual(self.run_cli("stock", "A1", "+4"), (0, "A1 stock: 4\n", ""))
        self.assertEqual(self.run_cli("stock", "B2", "-2"), (0, "B2 stock: 5\n", ""))
        self.assertEqual(self.run_cli("stock", "B2", "3"), (0, "B2 stock: 8\n", ""))

    def test_quote_shows_the_corrected_tax(self):
        self.run_cli("add-product", "T1", "Tie breaker", "10.10", "tools", "5")
        self.run_cli("add-customer", "C2", "Bob")
        code, out, err = self.run_cli("quote", "C2", "T1x1")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, "\n".join([
            "Subtotal             10.10", "Bulk discount         0.00", "Tier discount         0.00",
            "Coupon discount       0.00", "Shipping              7.99", "Tax                   0.51",
            "Total                18.60"]) + "\n")
        self.assertEqual(self.run_cli("order", "C2", "T1x1")[1].split("\n")[0], "order 1 placed")

    def test_coupons_and_dates(self):
        self.seed()
        self.run_cli("order", "C2", "HAM-16x1", "FREESHIP", today="2031-07-04")
        self.assertIn("2031-07-04", self.run_cli("statement", "C2")[1])
        self.assertEqual(self.run_cli("order", "C2", "HAM-16x1", today="soon")[2:], ("error: bad date: 'soon'\n",))

    def test_low_stock(self):
        self.seed()
        code, out, err = self.run_cli("low-stock", "14")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, "\n".join([
            "low stock (<= 14):",
            "GOG-01       0  Safety goggles",
            "SAW-HS       6  Hand saw 20in",
            "HAM-16      14  Claw hammer 16oz",
        ]) + "\n")
        self.assertEqual(self.run_cli("low-stock", "0")[1], "low stock (<= 0):\nGOG-01       0  Safety goggles\n")
        self.run_cli("stock", "GOG-01", "1")
        self.assertEqual(self.run_cli("low-stock", "0"), (0, "no products at or below 0\n", ""))
        self.assertEqual(self.run_cli("low-stock", "007")[1].split("\n")[0], "low stock (<= 7):")
        self.assertEqual(self.run_cli("low-stock", "x"), (1, "", "error: bad threshold: 'x'\n"))
        self.assertEqual(self.run_cli("low-stock", "-1"), (1, "", "error: bad threshold: '-1'\n"))
        self.assertEqual(self.run_cli("low-stock")[0], 2)

    def test_reports_on_an_empty_shop(self):
        self.assertEqual(self.run_cli("report", "stock")[1],
                         "SKU      NAME                 CATEGORY   STOCK     PRICE\nTotal units: 0, value: 0.00\n")
        self.assertEqual(self.run_cli("report", "sales")[1].split("\n")[0], "Orders: 0 (placed 0, shipped 0, cancelled 0)")


class ErrorTest(CliCase):
    def test_error_messages_and_codes(self):
        self.seed()
        cases = [
            (("stock", "NOPE", "1"), "unknown sku: NOPE"),
            (("stock", "GOG-01", "x"), "bad delta: 'x'"),
            (("stock", "GOG-01", "1.5"), "bad delta: '1.5'"),
            (("stock", "GOG-01", "-1"), "insufficient stock for GOG-01: have 0, need 1"),
            (("add-product", "A1", "n", "1.00", "c", "x"), "bad stock: 'x'"),
            (("add-product", "A1", "n", "1.00", "c", "-1"), "bad stock: '-1'"),
            (("add-product", "A1", "n", "abc", "c"), "bad money: 'abc'"),
            (("add-product", "HAM-16", "n", "1.00", "c"), "duplicate sku: HAM-16"),
            (("add-customer", "C1", "Again"), "duplicate customer: C1"),
            (("add-customer", "C9", "Zed", "platinum"), "bad tier: 'platinum'"),
            (("order", "C9", "HAM-16x1"), "unknown customer: C9"),
            (("order", "C1", "HAM-16"), "bad item: 'HAM-16'"),
            (("order", "C1", "HAM-16x1", "NOPE"), "unknown coupon: NOPE"),
            (("order", "C1", "GOG-01x1"), "insufficient stock for GOG-01: have 0, need 1"),
            (("quote", "C1", "ZZZx1"), "unknown sku: ZZZ"),
            (("ship", "x"), "bad order id: 'x'"),
            (("ship", "9"), "unknown order: 9"),
            (("cancel", "-1"), "bad order id: '-1'"),
            (("cancel", "9"), "unknown order: 9"),
            (("statement", "C9"), "unknown customer: C9"),
            (("import-products", os.path.join("no", "such.csv")), "cannot read " + os.path.join("no", "such.csv")),
        ]
        for args, message in cases:
            before = self.file_hash()
            self.assertEqual(self.run_cli(*args), (1, "", "error: %s\n" % message), args)
            self.assertEqual(self.file_hash(), before, args)

    def test_import_errors_leave_the_file_alone(self):
        self.seed()
        before = self.file_hash()
        with open(self.csv, "w", encoding="utf-8") as fh:
            fh.write("sku,name,price,category,stock\nNEW-1,Thing,1.00,misc,2\nHAM-16,Dup,1.00,misc,2\n")
        self.assertEqual(self.run_cli("import-products", self.csv), (1, "", "error: duplicate sku: HAM-16\n"))
        self.assertEqual(self.file_hash(), before)

    def test_usage_errors(self):
        for args in ([], ["frobnicate"], ["add-product", "A1"], ["add-customer"], ["quote", "C1"],
                     ["order", "C1", "A1x1", "SAVE10", "extra"], ["ship"], ["report"], ["report", "weather"],
                     ["stock", "A1"], ["statement"], ["import-products"]):
            code, out, err = self.run_cli(*args)
            self.assertEqual((code, out), (2, ""), args)
            self.assertTrue(err.startswith("usage error: "), args)
        code, out, err = self.run_cli(data=False)
        self.assertEqual((code, out), (2, ""))
        self.assertTrue(err.startswith("usage error: "))
        self.assertFalse(os.path.exists(self.data))

    def test_invalid_data_file(self):
        with open(self.data, "w") as fh:
            fh.write("{oops")
        self.assertEqual(self.run_cli("report", "stock"), (1, "", "error: invalid data file: %s\n" % self.data))
        self.assertEqual(self.run_cli("add-customer", "C1", "Ada")[0], 1)
        with open(self.data) as fh:
            self.assertEqual(fh.read(), "{oops")


class PersistenceTest(CliCase):
    def test_read_only_commands_never_write(self):
        self.assertEqual(self.run_cli("report", "stock")[0], 0)
        self.assertEqual(self.run_cli("statement", "C1")[0], 1)
        self.assertEqual(self.run_cli("quote", "C1", "A1x1")[0], 1)
        self.assertEqual(self.run_cli("low-stock", "3")[0], 0)
        self.assertFalse(os.path.exists(self.data))
        self.seed()
        import json
        with open(self.data, encoding="utf-8") as fh:
            state = json.load(fh)
        with open(self.data, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(state))  # compact on purpose: any rewrite would change the bytes
        before = self.file_hash()
        self.run_cli("quote", "C1", "HAM-16x1")
        self.run_cli("report", "sales")
        self.run_cli("report", "stock")
        self.run_cli("statement", "C1")
        self.run_cli("low-stock", "5")
        self.assertEqual(self.file_hash(), before)

    def test_changing_commands_write_the_file(self):
        self.run_cli("add-customer", "C1", "Ada")
        first = self.file_hash()
        self.assertIsNotNone(first)
        self.run_cli("add-product", "A1", "Anvil", "20", "tools", "3")
        second = self.file_hash()
        self.assertNotEqual(first, second)
        self.run_cli("order", "C1", "A1x1")
        self.assertNotEqual(second, self.file_hash())

    def test_the_file_is_the_new_format(self):
        import json
        self.seed()
        self.run_cli("order", "C1", "HAM-16x1")
        with open(self.data, encoding="utf-8") as fh:
            raw = fh.read()
        data = json.loads(raw)
        self.assertEqual(raw, json.dumps(data, indent=2, sort_keys=True) + "\n")
        self.assertEqual((data["version"], data["next_order_id"], len(data["products"])), (1, 2, 8))

    def test_default_data_file_is_in_the_current_folder(self):
        env_vars = dict(os.environ, PYTHONPATH=SRC, WH_TODAY="2025-03-01")
        r = subprocess.run([sys.executable, "-m", "warehouse", "add-customer", "C1", "Ada"],
                           capture_output=True, text=True, env=env_vars, cwd=self.dir)
        self.assertEqual((r.returncode, r.stdout), (0, "added customer C1\n"))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "warehouse.json")))
        r = subprocess.run([sys.executable, "-m", "warehouse"], capture_output=True, text=True, env=env_vars, cwd=self.dir)
        self.assertEqual((r.returncode, r.stdout), (2, ""))

    def test_main_uses_the_current_streams_and_never_exits(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(["--data", self.data, "add-customer", "C1", "Ada"])
            bad = main(["--data", self.data, "nonsense"])
        self.assertEqual((code, bad), (0, 2))
        self.assertEqual(out.getvalue(), "added customer C1\n")
        self.assertTrue(err.getvalue().startswith("usage error: "))

    def test_data_option_only_counts_first(self):
        code, out, err = self.run_cli("report", "stock", "--data", "x.json", data=False)
        self.assertEqual((code, out), (2, ""))


class ShimScriptTest(CliCase):
    def test_module_layout(self):
        import importlib
        self.assertIs(importlib.import_module("warehouse.cli").main, main)
        self.assertTrue(os.path.exists(os.path.join(SRC, "warehouse", "__main__.py")))

    def test_script_adds_its_own_folder_to_the_path(self):
        r = subprocess.run([sys.executable, os.path.join(SRC, "stockroom_cli.py"), "--data", self.data,
                            "add-customer", "C1", "Ada"], capture_output=True, text=True,
                           env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"}, cwd=self.dir)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "added customer C1\n", ""))
        with open(os.path.join(SRC, "stockroom_cli.py"), encoding="utf-8") as fh:
            self.assertLess(len(fh.read().splitlines()), 60)


if __name__ == "__main__":
    unittest.main()
