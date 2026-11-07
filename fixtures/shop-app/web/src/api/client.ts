import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE;
const http = axios.create({ baseURL: API_BASE });

export interface OrderDraft {
  sku: string;
  quantity: number;
}

export async function createOrder(order: OrderDraft) {
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  });
  return res.json();
}

export async function listOrders(status: string) {
  const res = await fetch(`/api/orders?status=${status}`);
  return res.json();
}

export async function getOrder(id: string) {
  return (await fetch(`/api/orders/${id}`)).json();
}

export function getStock(sku: string) {
  return http.get(`${API_BASE}/inventory/${sku}`);
}

export function trackEvent(url: string, name: string) {
  return fetch(url, { method: 'POST', body: JSON.stringify({ name }) });
}

export function sendFeedback(text: string) {
  return fetch('/api/feedback', { method: 'POST', body: JSON.stringify({ text }) });
}
