from fastapi import APIRouter

from app.models import OrderIn
from app.services import orders as order_service
from app.store.orders_repo import find_order, find_orders

router = APIRouter(prefix="/orders")


@router.post("")
def create_order(payload: OrderIn):
    return order_service.place_order(payload)


@router.get("")
def list_orders(status: str = "open"):
    return find_orders(status)


@router.get("/{order_id}")
def get_order(order_id: str):
    return find_order(order_id)
