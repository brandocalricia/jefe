"""Plain value objects. They are frozen so nothing outside can change the warehouse."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price_cents: int
    category: str
    stock: int

    def to_dict(self):
        return {"sku": self.sku, "name": self.name, "price_cents": self.price_cents,
                "category": self.category, "stock": self.stock}


@dataclass(frozen=True)
class Customer:
    id: str
    name: str
    tier: str
    region: str

    def to_dict(self):
        return {"id": self.id, "name": self.name, "tier": self.tier, "region": self.region}


@dataclass(frozen=True)
class OrderLine:
    sku: str
    qty: int
    unit_cents: int

    def to_dict(self):
        return {"sku": self.sku, "qty": self.qty, "unit_cents": self.unit_cents}


@dataclass(frozen=True)
class Order:
    id: int
    customer_id: str
    date: str
    coupon: object
    status: str
    lines: tuple
    gross_cents: int
    bulk_discount_cents: int
    tier_discount_cents: int
    coupon_discount_cents: int
    shipping_cents: int
    tax_cents: int
    total_cents: int

    def to_dict(self):
        return {
            "id": self.id,
            "customer_id": self.customer_id,
            "date": self.date,
            "coupon": self.coupon,
            "status": self.status,
            "lines": [line.to_dict() for line in self.lines],
            "gross_cents": self.gross_cents,
            "bulk_discount_cents": self.bulk_discount_cents,
            "tier_discount_cents": self.tier_discount_cents,
            "coupon_discount_cents": self.coupon_discount_cents,
            "shipping_cents": self.shipping_cents,
            "tax_cents": self.tax_cents,
            "total_cents": self.total_cents,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            id=data["id"],
            customer_id=data["customer_id"],
            date=data["date"],
            coupon=data.get("coupon"),
            status=data["status"],
            lines=tuple(OrderLine(l["sku"], l["qty"], l["unit_cents"]) for l in data["lines"]),
            gross_cents=data["gross_cents"],
            bulk_discount_cents=data["bulk_discount_cents"],
            tier_discount_cents=data["tier_discount_cents"],
            coupon_discount_cents=data["coupon_discount_cents"],
            shipping_cents=data["shipping_cents"],
            tax_cents=data["tax_cents"],
            total_cents=data["total_cents"],
        )
