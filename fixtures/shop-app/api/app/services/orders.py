import requests

from app.store import orders_repo


def place_order(payload):
    order_id = orders_repo.save_order(payload)
    notify_warehouse(order_id)
    return {"id": order_id}


def notify_warehouse(order_id):
    requests.post("https://hooks.example.com/warehouse", json={"order_id": order_id})
