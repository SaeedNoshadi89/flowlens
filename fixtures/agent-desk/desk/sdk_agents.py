from agents import Agent, function_tool

from desk.specialists import make_specialist


@function_tool
def lookup_account(account_id: str) -> str:
    return "account summary"


billing_agent = Agent(name="Billing", instructions="Handle invoices.")
support_agent = Agent(name="Support", instructions="Handle product questions.")

triage_agent = Agent(
    name="Triage",
    instructions="Route the customer.",
    handoffs=[billing_agent, support_agent, make_specialist()],
    tools=[lookup_account],
)
