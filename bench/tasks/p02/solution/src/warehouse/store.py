"""Where the shop's state is kept: behind one small interface."""

import abc
import copy
import json
import os
import tempfile

from .errors import StoreError


class Store(abc.ABC):
    @abc.abstractmethod
    def load(self):
        """The saved state dict, or None if nothing was saved yet."""

    @abc.abstractmethod
    def save(self, state):
        """Replace the saved state."""


class MemoryStore(Store):
    def __init__(self, state=None):
        self._state = copy.deepcopy(state)

    def load(self):
        return copy.deepcopy(self._state)

    def save(self, state):
        self._state = copy.deepcopy(state)


class JsonFileStore(Store):
    def __init__(self, path):
        self.path = os.fspath(path)

    def load(self):
        if not os.path.exists(self.path):
            return None
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
        except ValueError:
            raise StoreError("invalid data file: %s" % self.path) from None
        if not isinstance(data, dict):
            raise StoreError("invalid data file: %s" % self.path)
        return data

    def save(self, state):
        folder = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(folder, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(state, indent=2, sort_keys=True) + "\n")
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
