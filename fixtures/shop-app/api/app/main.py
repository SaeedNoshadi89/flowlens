from fastapi import FastAPI

from app.routes import inventory, orders

app = FastAPI(title="shop")
app.include_router(orders.router, prefix="/api")
app.include_router(inventory.router, prefix="/api")


@app.get("/health")
def health():
    return {"ok": True}
