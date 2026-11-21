My CSV helper in `src/csvline.py` splits a line like `name,"Smith, Jane",42` into four fields instead of three, so `read_rows` in `src/table.py` gives wrong rows for any quoted value with a comma in it. Please fix it. It is plain Python 3 with only the standard library, and the tests run with `python3 -m unittest discover -s tests`.

ANSWERS:
- Language and runtime: Python 3, standard library only
- Where: the fix belongs in src/csvline.py; keep the function names and signatures
- Scope: do not add dependencies or new files except tests; do not switch to the csv module
