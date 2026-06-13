#!/bin/bash
# X4PN server entrypoint — boringtun WireGuard + Algorand x402 payment layer
set -e

IFACE="tun0"
UAPI_SOCK="/var/run/wireguard/${IFACE}.sock"
KEYS_DIR="/app/data/keys"

generate_keys() {
    mkdir -p "$KEYS_DIR"
    if [ ! -f "$KEYS_DIR/server.key" ]; then
        echo "[Keys] Generating WireGuard keypair..."
        openssl genpkey -algorithm x25519 -outform DER 2>/dev/null | tail -c 32 | base64 > "$KEYS_DIR/server.key"
    fi
    SERVER_PRIVKEY=$(cat "$KEYS_DIR/server.key")
    SERVER_PRIVKEY_HEX=$(echo -n "$SERVER_PRIVKEY" | base64 -d | xxd -p -c 64)
    SERVER_PUBKEY=$(echo -n "$SERVER_PRIVKEY" | base64 -d | \
        openssl pkey -inform DER -outform DER -pubout 2>/dev/null | tail -c 32 | base64 || echo "")
    echo "$SERVER_PUBKEY" > "$KEYS_DIR/server.pub"
    echo "[Keys] Server public key: $SERVER_PUBKEY"
}

cleanup() {
    echo "[Stop] Shutting down..."
    kill $X402_PID 2>/dev/null || true
    kill $BT_PID 2>/dev/null || true
    wait $X402_PID 2>/dev/null || true
    wait $BT_PID 2>/dev/null || true
    ip link delete "$IFACE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "=== X4PN Node (WireGuard + x402) ==="
generate_keys

ip tuntap add dev "$IFACE" mode tun 2>/dev/null || true
ip link set "$IFACE" up

# WireGuard server — NO EVM in-tunnel payment (x402 handles billing)
echo "[Start] boringtun (WireGuard)..."
BT_PAYMENT_SERVER=0 \
BT_REGISTRATION_API=1 \
BT_HTTP_BIND="${BT_HTTP_BIND:-0.0.0.0:8080}" \
BT_PUBLIC_IP="${BT_PUBLIC_IP:-${PUBLIC_IP:-127.0.0.1}}" \
BT_WS_BIND="${BT_WS_BIND:-0.0.0.0:8443}" \
BT_WG_PORT="${BT_WG_PORT:-51820}" \
WG_LOG_LEVEL="${WG_LOG_LEVEL:-info}" \
WG_SUDO=1 \
boringtun "$IFACE" --foreground --disable-drop-privileges --disable-connected-udp &

BT_PID=$!
sleep 2
kill -0 $BT_PID 2>/dev/null || { echo "ERROR: boringtun exited"; exit 1; }

for i in $(seq 1 15); do
    [ -S "$UAPI_SOCK" ] && break
    sleep 1
done
[ -S "$UAPI_SOCK" ] || { echo "ERROR: UAPI socket missing"; exit 1; }

printf "set=1\nprivate_key=%s\nlisten_port=51820\n\n" "$SERVER_PRIVKEY_HEX" | \
    socat -t5 - UNIX-CONNECT:"$UAPI_SOCK"

ip addr replace 10.0.0.1/32 dev "$IFACE"
sysctl -w net.ipv4.ip_forward=1 >/dev/null

INET_IF=$(ip route show default | awk '{print $5; exit}')
if [ -n "$INET_IF" ]; then
    iptables -t nat -C POSTROUTING -s 10.0.0.0/24 -o "$INET_IF" -j MASQUERADE 2>/dev/null || \
        iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o "$INET_IF" -j MASQUERADE
    iptables -C FORWARD -i "$IFACE" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$IFACE" -j ACCEPT
    iptables -C FORWARD -o "$IFACE" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
        iptables -A FORWARD -o "$IFACE" -m state --state RELATED,ESTABLISHED -j ACCEPT
fi

curl -sf "http://127.0.0.1:${HTTP_PORT:-8080}/health" && echo "[Verify] boringtun API ok"

# Algorand x402 payment gateway → calls boringtun /v1/register after payment
echo "[Start] x402 vpn-server..."
cd /app/vpn-server
export BORINGTUN_API_URL="${BORINGTUN_API_URL:-http://127.0.0.1:8080}"
npm start &
X402_PID=$!
sleep 2

echo ""
echo "=== X4PN Running ==="
echo "  WireGuard API: :8080  (peer register/unregister)"
echo "  x402 API:      :${PORT:-4021}  (/connect, /renew)"
echo "  WireGuard UDP: :51820"
echo "  Public IP:     ${BT_PUBLIC_IP:-${PUBLIC_IP:-127.0.0.1}}"

wait $BT_PID
