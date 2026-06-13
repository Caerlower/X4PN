FROM rust:1.78-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY protocol/boringtun/ boringtun/
COPY protocol/boringtun-cli/ boringtun-cli/

RUN cargo build --release --features payment

# ---------- Runtime ----------
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    iproute2 iptables ca-certificates socat curl openssl xxd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/boringtun-cli /usr/local/bin/boringtun

WORKDIR /app/vpn-server
COPY vpn-server/package.json vpn-server/tsconfig.json ./
COPY vpn-server/ ./
RUN npm install --omit=dev

COPY server/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME /app/data
EXPOSE 4021 8080 8443 51820/udp

ENTRYPOINT ["/entrypoint.sh"]
