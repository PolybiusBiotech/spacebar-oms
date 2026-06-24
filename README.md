# Spacebar OMS

Order Management System display board for EMF kiosk orders. Shows bar staff the
live state of all kiosk orders — from creation through payment to collection.

## Order states

| State | Meaning |
|---|---|
| **Ready for payment** | Unpaid kiosk order — customer is on their way to the till |
| **Processing** | Order paid at till — being prepared |
| **Collect** | Operator has marked it ready — displayed for 2 minutes then cleared |

## Screens

| Path | Device | Purpose |
|---|---|---|
| `/staff` | Staff tablet | Live order board — unpaid, processing, collect columns. Staff assign a collection point when moving an order to collect. |
| `/status` or `/customer` | Customer display | Status board — order numbers only; no collection point shown (revealed at scan). |
| `/scan` | Display at collection scanner | Reads receipt barcode from USB scanner; shows ORDER / HATCH\|TUBE\|HATCH & TUBE / collection point number. Resets after 12 s. |
| `/collection/:n` | Phone at each collection point (1–6) | Shows which order is assigned to that collection point and whether it's ready. |
| `/pay` | iPhone at bar | Full-screen message display |
| `/control` | Staff screen at till | Send messages to payment instruction screen; order-loaded + printer alerts |
| `/pay/control` | Staff screen at till | Same as `/control` |

### Collection point flow

1. Staff prepares order and moves it to **Collect**, picking a collection point (1–6).
2. Customer sees their order number appear in the **Ready to collect** column on `/status` — no collection point shown yet.
3. Customer scans their receipt QR at the collection scanner (`/scan`).
4. Scanner display shows: order number · **HATCH**, **TUBE**, or **HATCH & TUBE** · collection point number.
   - *Tube* — all items are Buzzballs (line description starts with "buzzball", case-insensitive).
   - *Hatch* — no Buzzballs.
   - *Hatch & Tube* — mixed order.
5. Each collection point phone (`/collection/:n`) shows which order is assigned there for staff at the chute end.

### Payment instruction system

The payment instruction screen (`/pay`) shows a message pushed from the staff control page (`/control`) over SSE. Default state is **PAY HERE** (large green). Other messages appear in purple. All connected clients stay in sync — the control page is itself an SSE subscriber and reflects the current state.

**Presets:** PAY HERE · PRESENT ID · REJECTED · APPROVED — PAY BELOW ·
PAYMENT PROCESSED · PLEASE WAIT · NEXT CUSTOMER

**Idle timeout:** non-default messages auto-clear back to PAY HERE after 30 seconds of inactivity.

**Order-loaded alert:** when the barcode scanner at the till reads a QR/slip, the recall plugin fires `POST /pay/order-loaded`. The control page shows a 5-second pop-up with the order ref and an "ID Rejected" shortcut button. Soft-only orders show a green "auto pay" variant.

**Printer alerts:** when a kiosk printer fails it POSTs to `POST /api/printer-alert`. The control page shows a persistent orange banner per kiosk. Staff clear it with the "Clear" button once the printer is fixed. Alerts are pushed over SSE and replayed on reconnect. They do **not** appear on the customer-facing `/pay` display.

### SSE events on `/pay/events`

| Event | Who listens | Payload |
|---|---|---|
| *(unnamed message)* | `/pay` and `/control` | `{ message }` — current display text |
| `order-loaded` | `/control` only | `{ order_ref, soft_only }` |
| `printer-alert` | `/control` only | `{ alerts: { location: { message, at } } }` |
| `maintenance` | `/pay`, `/customer`, `/control`, kiosk | `{ active, reopeningAt }` — maintenance mode state; replayed on SSE reconnect |
| `kiosk-maintenance` | kiosk, badge | `{ active, reopeningAt }` — kiosk-only maintenance; OMS screens unaffected; replayed on reconnect |

### SSE events on `/api/events` (kiosk proxy)

The kiosk server subscribes to `/pay/events` on startup and re-broadcasts `maintenance` events to its own connected frontend over `/api/events`. The kiosk never needs a direct connection to OMS.

## Runtime shape

- A dependency-free Node.js server polls tillweb for order state and serves the
  board UI on localhost.
- The browser polls the local server every 3 seconds.
- Operators tap **Ready to collect** on the board to move an order to the collect
  column; it clears automatically after 2 minutes.
- The server binds to `0.0.0.0` by default so all screens are reachable over the
  local network. Override with `OMS_LISTEN_HOST=127.0.0.1` to restrict to
  localhost.

## API

### Order state

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/orders` | none | All orders in OMS state machine, plus `printer_alerts`. Add `?order=<ref>` for a single order (used by badge). Each order includes `collection_point: number\|null`. |
| `POST /api/orders/<ref>/collect` | none (VLAN-only) | Move order from `processing` → `collect`. Body: `{ collection_point: 1–6 }`. 400 if `collection_point` out of range; 409 if wrong state. |
| `POST /api/orders/<ref>/id-check` | none (VLAN-only) | Log ID-check result (`approved` / `rejected`). `rejected` auto-pushes "REJECTED" to payment instruction screen. |

### Printer alerts

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/printer-alert` | none (VLAN-only) | Body: `{ location, message }`. Stored in memory and broadcast over SSE. |
| `DELETE /api/printer-alert` | none (VLAN-only) | Body: `{ location }` to clear one, or empty to clear all. Broadcast over SSE. |

### Payment instruction

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /pay/events` | none | SSE stream. See SSE events table above. |
| `POST /pay/message` | none (VLAN-only) | Body: `{ message }`. Pushes to display, resets idle timer. |
| `POST /pay/clear` | none (VLAN-only) | Reset display to PAY HERE immediately. |
| `POST /pay/order-loaded` | none (VLAN-only) | Body: `{ order_ref, soft_only }`. Called by quicktill-kiosk-plugin on scan. |

### Maintenance mode

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /maintenance` | none (VLAN-only) | Body: `{ active, reopeningAt? }`. Sets/clears maintenance mode; persisted to `maintenance.json`; broadcast as `maintenance` SSE event to all subscribers. `reopeningAt` is an `"HH:MM"` time string; the kiosk overlay shows a live countdown to that time. |
| `POST /kiosk-maintenance` | none (VLAN-only) | Body: `{ active, reopeningAt? }`. Sets/clears kiosk-only maintenance mode; persisted to `kiosk-maintenance.json`; broadcast as `kiosk-maintenance` SSE event. Kiosks and badges see the "TERMINAL OFFLINE" overlay with countdown; OMS screens (`/staff`, `/customer`, `/pay`) stay live. |

When active, a full-screen "TERMINAL OFFLINE" overlay appears on `/pay`, `/customer`, and the kiosk. The overlay shows the reopening time if set. The state survives server restarts.

Control is via the maintenance card at the bottom of `/pay/control`: select a reopening time then click **Enable maintenance mode**. Disable in the same place.

### Health

`GET /healthz` — returns `{ ok, location, printer_alerts }`. Use for monitoring.

## Local development

```sh
cp .env.example .env
$EDITOR .env   # set TILLWEB_BASE_URL and TILLWEB_TOKEN
npm start
```

For local work without a live till, set `OMS_MOCK_MODE=true` — the server
pre-loads two sample orders (one unpaid, one processing).

To run against the local mock till (badge sim included), see
[`dev/README.md`](../dev/README.md) in the top-level repo.

Then open `http://127.0.0.1:8081`.

## Raspberry Pi install

```sh
sudo ./ops/install-pi.sh
sudoedit /etc/spacebar-oms.env
sudo systemctl restart spacebar-oms.service spacebar-oms-browser.service
```

Required settings:

- `TILLWEB_BASE_URL`: tillweb base URL.
- `TILLWEB_TOKEN`: bearer token from `emftillweb`'s `[kiosk.tokens]` config.
- `OMS_LOCATION`: tillweb location to watch, default `spacebar`. **Production value is `Spacebar` (capital S) — must match an entry in the `locations = [...]` list in `emftillweb.toml` token config and the `LOCATION` constant in the badge app.**

## Operations

```sh
systemctl status spacebar-oms.service
journalctl -u spacebar-oms.service -f
curl http://127.0.0.1:8081/healthz
```

## Tillweb dependency

Requires `GET /api/kiosk/orders.json` in emftillweb — implemented and merged.
