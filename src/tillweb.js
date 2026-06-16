// TODO: this module needs a new tillweb endpoint to be implemented in emftillweb.
// Proposed: GET /api/kiosk/orders.json?location=<location>
// Auth: same Bearer token pattern as the kiosk order creation endpoint.
// Response should include all active kiosk transactions for the location,
// with a `paid` boolean (true when trans.payments is non-empty in quicktill).

export class TillwebError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function tillwebFetch(config, path, options = {}) {
  const url = `${config.tillwebBaseUrl}${path}`;
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.omsToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
  } catch (error) {
    throw new TillwebError(`Network error contacting tillweb: ${error.message}`, 502, {
      error: "network-error",
      message: error.message
    });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new TillwebError(
      payload.message || `Tillweb returned ${response.status}`,
      response.status,
      payload
    );
  }
  return payload;
}

// TODO: implement once GET /api/kiosk/orders.json exists in emftillweb.
// Should return an array of order objects, each with at minimum:
//   { order_ref, order_name, transaction_id, created_at, expires_at, total, lines, paid }
export async function fetchOrders(config) {
  const params = new URLSearchParams({ location: config.location });
  const data = await tillwebFetch(config, `/api/kiosk/orders.json?${params}`);
  return data.orders ?? [];
}
