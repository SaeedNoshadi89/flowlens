from pydantic import BaseModel


class OrderIn(BaseModel):
    sku: str
    quantity: int
