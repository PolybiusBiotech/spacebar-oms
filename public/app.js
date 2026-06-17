const app = document.querySelector("#app");

const state = {
  orders: [],
  error: null
};

async function fetchOrders() {
  const response = await fetch("/api/orders");
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  const data = await response.json();
  return data.orders ?? [];
}

async function markCollect(orderRef) {
  const response = await fetch(`/api/orders/${encodeURIComponent(orderRef)}/collect`, {
    method: "POST"
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `Failed to mark ${orderRef} as collect`);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderOrder(order) {
  const isProcessing = order.state === "processing";
  return `
    <article class="order order--${order.state}" data-ref="${escapeHtml(order.order_ref)}">
      <h2>${escapeHtml(order.order_name)}</h2>
      <p class="total">GBP ${escapeHtml(order.total)}</p>
      ${isProcessing ? `<button class="collect-btn" data-collect="${escapeHtml(order.order_ref)}">Ready to collect</button>` : ""}
    </article>
  `;
}

function column(title, orders) {
  return `
    <section class="column">
      <h1>${escapeHtml(title)}</h1>
      <div class="orders">
        ${orders.length ? orders.map(renderOrder).join("") : `<p class="empty">None</p>`}
      </div>
    </section>
  `;
}

function render() {
  if (state.error) {
    app.innerHTML = `<p class="error">${escapeHtml(state.error)}</p>`;
    return;
  }

  const pending    = state.orders.filter(o => o.state === "unpaid");
  const processing = state.orders.filter(o => o.state === "processing");
  const collect    = state.orders.filter(o => o.state === "collect");

  app.innerHTML = `
    <div class="board">
      ${column("Ready for payment", pending)}
      ${column("Processing", processing)}
      ${column("Collect", collect)}
    </div>
  `;
}

app.addEventListener("click", async event => {
  const btn = event.target.closest("[data-collect]");
  if (!btn) return;
  const ref = btn.dataset.collect;
  btn.disabled = true;
  try {
    await markCollect(ref);
    await refresh();
  } catch (error) {
    console.error(error);
    btn.disabled = false;
  }
});

async function refresh() {
  try {
    state.orders = await fetchOrders();
    state.error = null;
  } catch (error) {
    state.error = error.message;
  }
  render();
}

refresh();
setInterval(refresh, 3000);
