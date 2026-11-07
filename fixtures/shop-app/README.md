# shop-app (synthetic fixture)

A tiny monorepo used to test FlowLens: a React-style web client calls a FastAPI
backend, which writes to SQLite and Redis and calls an external webhook. It is
never run. `.env` and `config/credentials.json` hold fake values that must never
appear in a report.
