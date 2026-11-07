import { useEffect, useState } from 'react';
import { getOrder, listOrders, sendFeedback } from '../api/client';

export default function OrdersPage() {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    listOrders('open').then(setOrders);
  }, []);

  function openOrder(id: string) {
    return getOrder(id);
  }

  return <ul onClick={() => sendFeedback('ok')}>{orders.length}</ul>;
}
