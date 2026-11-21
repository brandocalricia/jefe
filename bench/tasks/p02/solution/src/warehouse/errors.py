"""Exception classes. Everything derives from ValueError so old callers keep working."""


class WarehouseError(ValueError):
    """Base class for every error the package raises on purpose."""


class ValidationError(WarehouseError):
    """Input that is malformed or out of range."""


class DuplicateError(WarehouseError):
    """A sku or customer id that already exists."""


class NotFoundError(WarehouseError):
    """A sku, customer or order that does not exist."""


class StockError(WarehouseError):
    """Not enough stock to do what was asked."""


class StateError(WarehouseError):
    """An order is in the wrong status for the requested change."""


class StoreError(WarehouseError):
    """The data file could not be read."""
