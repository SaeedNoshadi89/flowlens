import redis
from fastapi import APIRouter

router = APIRouter(prefix="/inventory")
cache = redis.Redis()


@router.get("/{sku}")
def stock_level(sku: str):
    return {"sku": sku, "level": cache.get("stock:" + sku)}
