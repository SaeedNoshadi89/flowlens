from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase

engine = create_engine("sqlite://")


class Base(DeclarativeBase):
    pass


class Refund(Base):
    __tablename__ = "refunds"
