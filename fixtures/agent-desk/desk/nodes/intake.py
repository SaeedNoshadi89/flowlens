def classify(ticket):
    ticket["category"] = "billing" if "invoice" in ticket["text"] else "technical"
    return ticket


def route_ticket(ticket):
    return ticket["category"]
