# X4PN — Algorand x402 + WireGuard

```
├── vpn-server/     # x402 payment API (/connect, /renew) → calls boringtun
├── protocol/       # boringtun WireGuard server (Rust)
├── client/         # Tauri desktop app (Pera wallet + tunnel)
├── server/         # Docker deploy (optional)
└── docs/           # x402 reference
```

## Local dev (no Docker)

Three terminals. **Docker is optional** — use this for day-to-day development.

### Terminal 1 — boringtun (WireGuard server)

From the repo root:

**macOS:**
```bash
sudo WG_SUDO=1 \
  BT_PAYMENT_SERVER=0 \
  BT_REGISTRATION_API=1 \
  BT_HTTP_BIND=0.0.0.0:8080 \
  BT_PUBLIC_IP=127.0.0.1 \
  BT_WG_PORT=51820 \
  WG_LOG_LEVEL=info \
  cargo run --release --features payment -p boringtun-cli -- utun --foreground
```

`WG_SUDO=1` keeps boringtun running under sudo on macOS (privilege drop fails in dev).

**Linux:**
```bash
sudo WG_SUDO=1 \
  BT_PAYMENT_SERVER=0 \
  BT_REGISTRATION_API=1 \
  BT_HTTP_BIND=0.0.0.0:8080 \
  BT_PUBLIC_IP=127.0.0.1 \
  BT_WG_PORT=51820 \
  WG_LOG_LEVEL=info \
  cargo run --release --features payment -p boringtun-cli -- tun0 --foreground
```

Verify:
```bash
curl http://127.0.0.1:8080/health
```

On first run, boringtun auto-generates a server WireGuard key at `~/.x4pn/boringtun-server.key` and binds UDP `:51820`. **Restart boringtun** after updating the binary if you saw `server not configured yet`.

| Env var | Meaning |
|---------|---------|
| `BT_PAYMENT_SERVER=0` | Disable old EVM in-tunnel payment |
| `BT_REGISTRATION_API=1` | Enable `/v1/register` for x402 |
| `BT_HTTP_BIND` | Peer registration API port (8080) |

### Terminal 2 — x402 payment server

```bash
cd vpn-server
cp .env.example .env   # set AVM_ADDRESS
npm install
npm run dev
```

Verify:
```bash
curl http://127.0.0.1:4021/health
curl "http://127.0.0.1:4021/pricing?durationMinutes=5"
```

### Terminal 3 — desktop client

```bash
cd client
cp .env.example .env.local
# VITE_SERVER_IP=127.0.0.1
npm install
npm run tauri dev
```

Connect Pera wallet → **CONNECT** → pays x402 → tunnel comes up.

---

## Docker (optional, for production)

```bash
cd server
cp .env.example .env
docker compose up --build
```

## Flow

1. Client pays via x402 → `POST /connect` on `:4021`
2. vpn-server calls boringtun → `POST /v1/register` on `:8080`
3. Client `connect_paid` → local boringtun-cli tunnel

## Ports (local)

| Port | Service |
|------|---------|
| 4021 | x402 API |
| 8080 | boringtun peer registration |
| 51820/udp | WireGuard |

## Note on same-machine testing

Running server + client on one Mac works for dev (`127.0.0.1`). For real internet egress through the VPN, run boringtun on a Linux VPS with IP forwarding/NAT enabled.
