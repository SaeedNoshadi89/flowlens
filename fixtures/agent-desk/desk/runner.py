from agents import Runner

from desk.graph import app
from desk.sdk_agents import triage_agent


def run_ticket(ticket):
    return app.invoke(ticket)


async def chat(message):
    return await Runner.run(triage_agent, message)
