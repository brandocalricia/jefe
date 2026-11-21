#!/usr/bin/env python3
"""Old entry point, kept so existing scripts keep working. Use `python3 -m warehouse`."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from warehouse.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
