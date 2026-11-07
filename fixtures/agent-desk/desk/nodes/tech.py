from langgraph.types import Command


def handle(ticket):
    ticket["attempts"] = ticket.get("attempts", 0) + 1
    return ticket


def decide_next(ticket):
    if ticket["attempts"] > 2:
        return "escalate"
    return "__end__"


def escalate(ticket):
    next_step = pick_queue(ticket)
    return Command(goto=next_step)


def pick_queue(ticket):
    return ticket.get("queue")
