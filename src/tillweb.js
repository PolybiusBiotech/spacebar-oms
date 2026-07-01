export { TillwebError } from "@spacebar/shared/tillweb-client.js";
import { tillwebRequest } from "@spacebar/shared/tillweb-client.js";

function request(config, pathname, options = {}) {
  return tillwebRequest(config.tillwebBaseUrl, config.tillwebToken, pathname, options);
}

export async function fetchOrders(config) {
  const data = await request(config, "/api/kiosk/orders/");
  return data.orders ?? [];
}

async function updateOrder(config, transactionId, action) {
  await request(config, `/api/kiosk/orders/${encodeURIComponent(transactionId)}/${action}/`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export const markRejected  = (config, transactionId) => updateOrder(config, transactionId, "id-reject");
export const markCollected = (config, transactionId) => updateOrder(config, transactionId, "collect");
