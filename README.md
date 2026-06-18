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
| `/staff` | Staff tablet | Live order board — pending, processing, collect columns |
| `/customer` | Customer display | Order collection screen |
| `/summon` | iPhone at bar | Full-screen message display; "Need help?" button |
| `/summon/control` | iPad at till | Send preset/custom messages to the summon display |

### Summon system

The summon display shows a message sent by staff over SSE. Default state is
**PAY HERE** (large green). Other messages appear in purple. All connected
clients stay in sync — the iPad control page is itself an SSE subscriber and
reflects the current state.

**Presets:** PAY HERE · PRESENT ID · REJECTED · APPROVED — PAY BELOW ·
PAYMENT PROCESSED · PLEASE WAIT · NEXT CUSTOMER

**Idle timeout:** non-default messages auto-clear back to PAY HERE after 30
seconds of inactivity.

**Help button:** the customer taps "Need help?" on the iPhone. This sets
PLEASE WAIT with no idle timeout and fires a named SSE `help` event to all
control-page clients, triggering a repeating red flash + triple beep until
staff acknowledge by pressing any button.

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

### `GET /api/orders`

Returns all orders currently in the OMS state machine.

```json
{ "orders": [{ "order_ref": "...", "state": "unpaid|processing|collect", ... }] }
```

Pass `?order=<ref>` to return a single order (used by the Tildagon badge to poll
its own order status):

```json
{ "order": { "order_ref": "T1001", "state": "processing" } }
```

Returns 404 if the order is not in the OMS state (not yet seen, or pruned after
expiry / collect timeout).

## Local development

```sh
cp .env.example .env
$EDITOR .env   # set TILLWEB_BASE_URL and TILLWEB_TOKEN
npm start
```

For local work without a live till, set `OMS_MOCK_MODE=true` — the server
pre-loads two sample orders (one pending, one processing).

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
- `OMS_LOCATION`: tillweb location to watch, default `Kiosk`.

## Operations

```sh
systemctl status spacebar-oms.service
journalctl -u spacebar-oms.service -f
curl http://127.0.0.1:8081/healthz
```

## Tillweb dependency

Requires `GET /api/kiosk/orders.json` in emftillweb — implemented and merged.
