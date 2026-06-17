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

export async function fetchOrders(config) {
  const params = new URLSearchParams({ location: config.location });
  const data = await tillwebFetch(config, `/api/kiosk/orders.json?${params}`);
  return data.orders ?? [];
}
