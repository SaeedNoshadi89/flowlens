from sqlalchemy.orm import Session

from desk.db import engine, Refund


def handle(ticket):
    with Session(engine) as session:
        session.add(Refund(reason=ticket["text"]))
        session.commit()
    return ticket
