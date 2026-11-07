from typing import TypedDict


class Ticket(TypedDict):
    text: str
    category: str
    attempts: int
