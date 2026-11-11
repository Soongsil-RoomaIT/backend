#!/usr/bin/env sh
# Mosquitto TLS(8883)용 자체 서명 CA와 서버 인증서를 secrets/mosquitto에 만듭니다.
# 사용법: sh infra/mosquitto/gen-certs.sh [VM 공인 IP 또는 호스트 이름]
#   예) sh infra/mosquitto/gen-certs.sh 203.0.113.10
# 라즈베리파이에는 secrets/mosquitto/ca.crt만 복사합니다. ca.key와 server.key는 절대 공유하지 않습니다.
set -eu
cd "$(dirname "$0")/../.."
out=secrets/mosquitto
host=${1:-}
mkdir -p "$out"
if [ -f "$out/server.crt" ] && [ "${FORCE:-}" != "1" ]; then
  echo "$out/server.crt already exists. Re-run with FORCE=1 to replace it."
  exit 0
fi
san="DNS:localhost,DNS:mosquitto,IP:127.0.0.1"
if [ -n "$host" ]; then
  case "$host" in
    *[!0-9.]*) san="$san,DNS:$host" ;;
    *) san="$san,IP:$host" ;;
  esac
fi
# Git Bash on Windows rewrites "/CN=..." into a path unless this is set.
export MSYS_NO_PATHCONV=1
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=RoomCare MQTT CA" \
  -keyout "$out/ca.key" -out "$out/ca.crt"
openssl req -newkey rsa:2048 -nodes -subj "/CN=${host:-localhost}" \
  -keyout "$out/server.key" -out "$out/server.csr"
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" > "$out/server.ext"
openssl x509 -req -in "$out/server.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" -CAcreateserial \
  -days 825 -extfile "$out/server.ext" -out "$out/server.crt"
rm -f "$out/server.csr" "$out/server.ext" "$out/ca.srl"
# The broker runs as the mosquitto user inside the container and must be able to read the key.
chmod 644 "$out/server.key"
echo "Created $out/ca.crt and $out/server.crt (SAN: $san)"
