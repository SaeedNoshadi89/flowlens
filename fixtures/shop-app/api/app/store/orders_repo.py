import sqlite3

conn = sqlite3.connect("shop.db")


def save_order(payload):
    cur = conn.cursor()
    cur.execute("INSERT INTO orders (sku, quantity) VALUES (?, ?)", (payload.sku, payload.quantity))
    conn.commit()
    return cur.lastrowid


def find_orders(status):
    return conn.execute("SELECT id, sku FROM orders WHERE status = ?", (status,)).fetchall()


def find_order(order_id):
    return conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
