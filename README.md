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
| `/staff` | Staff tablet | Live order board — unpaid, processing, collect columns |
| `/customer` | Customer display | Order collection screen |
| `/summon` | iPhone at bar | Full-screen message display; "Need help?" button |
| `/control` | Staff screen at till | Send messages to summon display; order-loaded + printer alerts |
| `/summon/control` | Staff screen at till | Same as `/control` |

### Summon system

The summon display (`/summon`) shows a message pushed from the staff control page (`/control`) over SSE. Default state is **PAY HERE** (large green). Other messages appear in purple. All connected clients stay in sync — the control page is itself an SSE subscriber and reflects the current state.

**Presets:** PAY HERE · PRESENT ID · REJECTED · APPROVED — PAY BELOW ·
PAYMENT PROCESSED · PLEASE WAIT · NEXT CUSTOMER

**Idle timeout:** non-default messages auto-clear back to PAY HERE after 30 seconds of inactivity.

**Help button:** the customer taps "Need help?" on the iPhone. This sets PLEASE WAIT with no idle timeout and fires a named SSE `help` event to all control-page clients, triggering a repeating red flash + triple beep until staff acknowledge by pressing any button. ⚠️ Unreliable — see [open-questions.md Q17](../docs/open-questions.md).

**Order-loaded alert:** when the barcode scanner at the till reads a QR/slip, the recall plugin fires `POST /summon/order-loaded`. The control page shows a 5-second pop-up with the order ref and an "ID Rejected" shortcut button. Soft-only orders show a green "auto pay" variant.

**Printer alerts:** when a kiosk printer fails it POSTs to `POST /api/printer-alert`. The control page shows a persistent orange banner per kiosk. Staff clear it with the "Clear" button once the printer is fixed. Alerts are pushed over SSE and replayed on reconnect. They do **not** appear on the customer-facing `/summon` display.

### SSE events on `/summon/events`

| Event | Who listens | Payload |
|---|---|---|
| *(unnamed message)* | `/summon` and `/control` | `{ message }` — current display text |
| `order-loaded` | `/control` only | `{ order_ref, soft_only }` |
| `help` | `/control` only | `{}` |
| `printer-alert` | `/control` only | `{ alerts: { location: { message, at } } }` |

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
| `GET /api/orders` | none | All orders in OMS state machine, plus `printer_alerts`. Add `?order=<ref>` for a single order (used by badge). |
| `POST /api/orders/<ref>/collect` | none (VLAN-only) | Move order from `processing` → `collect`. 409 if wrong state. |
| `POST /api/orders/<ref>/id-check` | none (VLAN-only) | Log ID-check result (`approved` / `rejected`). `rejected` auto-pushes "REJECTED" to summon display. |

### Printer alerts

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/printer-alert` | none (VLAN-only) | Body: `{ location, message }`. Stored in memory and broadcast over SSE. |
| `DELETE /api/printer-alert` | none (VLAN-only) | Body: `{ location }` to clear one, or empty to clear all. Broadcast over SSE. |

### Summon

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /summon/events` | none | SSE stream. See SSE events table above. |
| `POST /summon/message` | none (VLAN-only) | Body: `{ message }`. Pushes to display, resets idle timer. |
| `POST /summon/clear` | none (VLAN-only) | Reset display to PAY HERE immediately. |
| `POST /summon/help` | none (VLAN-only) | Customer help request. Sets PLEASE WAIT; fires `help` SSE event. |
| `POST /summon/order-loaded` | none (VLAN-only) | Body: `{ order_ref, soft_only }`. Called by quicktill-kiosk-plugin on scan. |

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
- `OMS_LOCATION`: tillweb location to watch, default `spacebar`. **Production value is `Spacebar` (capital S) — must match the `location` in `emftillweb.toml` token config and the `LOCATION` constant in the badge app.**

## Operations

```sh
systemctl status spacebar-oms.service
journalctl -u spacebar-oms.service -f
curl http://127.0.0.1:8081/healthz
```

## Tillweb dependency

Requires `GET /api/kiosk/orders.json` in emftillweb — implemented and merged.
