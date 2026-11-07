from langgraph.graph import END, StateGraph

from desk.nodes import billing, intake, tech
from desk.state import Ticket

workflow = StateGraph(Ticket)
workflow.add_node("intake", intake.classify)
workflow.add_node("billing", billing.handle)
workflow.add_node("tech", tech.handle)
workflow.add_node("escalate", tech.escalate)
workflow.set_entry_point("intake")
workflow.add_conditional_edges("intake", intake.route_ticket, {"billing": "billing", "technical": "tech"})
workflow.add_conditional_edges("tech", tech.decide_next)
workflow.add_edge("billing", END)

app = workflow.compile()
