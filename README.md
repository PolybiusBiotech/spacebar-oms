# Spacebar OMS

Order Management System display board for EMF kiosk orders. Shows bar staff the
live state of all kiosk orders — from creation through payment to collection.

## Order states

| State | Meaning |
|---|---|
| **Ready for payment** | Unpaid kiosk order — customer is on their way to the till |
| **Processing** | Order paid at till — being prepared |
| **Collect** | Operator has marked it ready — displayed for 2 minutes then cleared |

## Runtime shape

- A dependency-free Node.js server polls tillweb for order state and serves the
  board UI on localhost.
- The browser polls the local server every 3 seconds.
- Operators tap **Ready to collect** on the board to move an order to the collect
  column; it clears automatically after 2 minutes.

## Local development

```sh
cp .env.example .env
$EDITOR .env
npm start
```

For local work without a live till, set `OMS_MOCK_MODE=true` — the server
pre-loads two sample orders (one pending, one processing).

Then open `http://127.0.0.1:8081`.

## Raspberry Pi install

```sh
sudo ./ops/install-pi.sh
sudoedit /etc/spacebar-oms.env
sudo systemctl restart spacebar-oms.service spacebar-oms-browser.service
```

Required settings:

- `TILLWEB_BASE_URL`: tillweb base URL.
- `TILLWEB_OMS_TOKEN`: bearer token from `emftillweb`'s `[kiosk.tokens]` config.
- `OMS_LOCATION`: tillweb location to watch, default `Kiosk`.

## Operations

```sh
systemctl status spacebar-oms.service
journalctl -u spacebar-oms.service -f
curl http://127.0.0.1:8081/healthz
```

## Tillweb dependency

The OMS requires a `GET /api/kiosk/orders.json` endpoint in emftillweb that
does not yet exist. See `OMS_AGENT_NOTES.md` in the repo root for the full
implementation plan.
