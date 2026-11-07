import { useState } from 'react';
import { createOrder, getStock, trackEvent, type OrderDraft } from '../api/client';

function saveDraft(draft: OrderDraft) {
  localStorage.setItem('checkout-draft', JSON.stringify(draft));
}

export function CheckoutPage() {
  const [draft, setDraft] = useState<OrderDraft>({ sku: '', quantity: 1 });

  async function submit() {
    saveDraft(draft);
    await getStock(draft.sku);
    await createOrder(draft);
    trackEvent(window.location.origin + '/collect', 'checkout');
  }

  return <button onClick={submit}>Place order</button>;
}
