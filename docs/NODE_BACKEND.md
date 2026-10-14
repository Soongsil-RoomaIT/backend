# Node.js D 백엔드 연동

Node.js Gateway에서 C 담당 Cloud Server의 REST·표준 WebSocket을 중계하고
OAuth2/JWT, FCM 토큰, 알림 이력, Redis, TLS와 모니터링을 처리합니다.
SAD는 v1.1을 유지하고 작업 브랜치는 minjae입니다.

## 실행

`.env.example`을 `.env`로 복사하고 비밀번호와 암호화 키를 설정한 뒤 실행합니다.
암호화 키는 32바이트 무작위 값의 Base64입니다.
`node node-service/scripts/setup-env.js`로 기존 .env를 유지하면서 무작위 로컬 키와 비밀번호를 생성할 수도 있습니다.

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
docker compose up --build
```

Gateway 8080, Keycloak 8180, Prometheus 9090을 사용합니다.
기본 Gateway는 node-service이며 기존 Java notification-service는 legacy-java 프로필로 보관합니다.
직접 실행은 Node.js 22 이상과 Redis를 준비하고 node-service에서 `npm ci`, `npm start`입니다.
이때 `REDIS_URL=redis://localhost:6379`, `CLOUD_SERVICE_URL=http://localhost:8081`과
`DATA_ENCRYPTION_KEY_BASE64`를 환경 변수로 지정합니다. 검증은 `npm test`입니다.
사용하지 않는 선택 의존성인 Firebase Firestore/Storage는 설치에서 제외합니다.
Docker 실행 후 `node node-service/scripts/smoke-docker.js`는 실제 Keycloak/Redis/Gateway를 검증합니다.
임시 서비스 계정을 만들고 종료 시 제거하며, 실제 FCM 전송 없이 개발용 알림 이력을 남깁니다.

## C 서버의 계약

Docker의 기본 `CLOUD_SERVICE_URL`은 http://host.docker.internal:8081입니다.
아래 API와 기타 /api 경로는 C 담당 서버로 요청과 Bearer 토큰을 전달합니다.

- GET /api/sensors/latest
- GET /api/sensors/history?range=1h|24h|7d
- GET /api/devices
- GET /api/edge/status
- POST /api/devices/{id}/commands 및 forecast/decisions/settings API

MQTT 수집, 이력 집계, 자동화 판단과 edge.recovered 생성은 C 담당입니다.
C 서버는 JWT와 사용자별 장치·공간 권한을 검증해야 합니다.
Gateway는 X-User-Id 같은 호출자 지정 신원을 전달하지 않습니다.
C 서버 응답 상태 코드는 유지하고 연결 실패는 502입니다. 가짜 센서값은 만들지 않습니다.
프론트 명세의 필수 co2/pm25/pm10과 현재 온습도·터치·초음파 센서는 불일치하므로
C/E 담당자가 타입과 표시를 함께 맞춰야 합니다.

기준: [프론트 BACKEND.md](https://github.com/Soongsil-RoomaIT/frontend/blob/feat/monitoring/docs/BACKEND.md).

## WebSocket

브라우저는 ws://localhost:8080/ws로 접속합니다. ws 라이브러리를 사용하며 허용 Origin만 받습니다.
인증 모드에서는 접속 후 5초 이내에 첫 메시지를 보냅니다. 쿼리 토큰은 허용하지 않습니다.

```json
{"type":"auth","payload":{"token":"JWT access token"}}
```

검증 후 C 서버 /api/edge/status를 읽어 edge.status를 즉시 보냅니다.
C 서버 /ws의 핸드셰이크에는 Bearer 토큰을 전달합니다. C 서버도 이 헤더를 검증해야 합니다.
Gateway가 15초마다 JSON heartbeat를 보내고 JSON ping에 응답합니다.
sensor.update, device.state, edge.status, edge.recovered, command.ack를 중계합니다.
JWT 만료 또는 C 서버 소켓 단절 시 브라우저 소켓을 닫아 재연결·REST 재동기화를 유도합니다.

## OAuth와 개발 연동

Keycloak room-care realm의 room-care-web은 PKCE(S256), localhost:5173 redirect,
room-care-api audience를 사용합니다. 사용자와 역할은 Keycloak에서 등록합니다.
기존 realm이 있는 볼륨은 import가 덮어쓰지 않으므로 5173 주소와 audience mapper를 관리 화면에서 반영합니다.
REST는 Authorization: Bearer JWT이며 RS256 서명, issuer, audience, exp, sub를 검증합니다.

## 내부 서비스 알림 호출 (client credentials)

C 서버 같은 내부 서비스는 사용자 토큰이나 ADMIN 계정 대신 realm에 포함된
`room-care-automation` 기밀 클라이언트로 토큰을 받아 알림을 보냅니다.

- 서비스 계정 역할은 `NOTIFICATION_SENDER` 하나이며 `fullScopeAllowed=false`라 토큰에도 이 역할만 담깁니다.
- 토큰 audience는 room-care-api, 수명은 5분입니다. 브라우저 로그인·비밀번호 grant는 꺼져 있습니다.
- Gateway의 POST /api/notifications/send는 `ADMIN` 또는 `NOTIFICATION_SENDER`를 허용합니다.
- 비밀값은 `.env`의 `AUTOMATION_CLIENT_SECRET`이며 Keycloak이 import 시 `${AUTOMATION_CLIENT_SECRET}`을 치환합니다.
  C 담당자에게는 Secret Manager 등으로만 전달하고 저장소·로그에 남기지 않습니다.

```bash
# 1) 토큰 발급 (C 서버에서 만료 전 재발급·캐시)
curl -s -d grant_type=client_credentials -d client_id=room-care-automation \
  -d client_secret="$AUTOMATION_CLIENT_SECRET" \
  http://keycloak:8080/realms/room-care/protocol/openid-connect/token
# 2) 알림 발송: eventId는 자동화 판단 ID처럼 재시도해도 같은 값을 사용
curl -X POST http://gateway-service:8080/api/notifications/send \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"eventId":"automation-123","userId":"Keycloak subject","title":"자동 제어 완료","body":"제습기를 켰습니다"}'
```

토큰 발급 주소의 호스트는 issuer 검증과 무관하게 Keycloak에 닿기만 하면 되지만,
발급된 토큰의 iss는 `KC_HOSTNAME`(http://localhost:8180) 기준이므로 Gateway 설정과 맞아야 합니다.

기존 `.env`에는 `node node-service/scripts/setup-env.js`를 다시 실행하면 새 키만 추가됩니다.
이미 생성된 Keycloak 볼륨은 realm import를 다시 적용하지 않으므로 둘 중 하나를 합니다.

- 개발 데이터 초기화: `docker compose down` 후 `docker volume rm <프로젝트>_postgres-data`, 다시 `up`
  (Keycloak에 수동으로 만든 사용자도 삭제됩니다.)
- 볼륨 유지: 관리 화면 room-care realm에 `NOTIFICATION_SENDER` 역할과 `room-care-automation` 클라이언트
  (Client authentication ON, Service accounts roles만 ON, Full scope allowed OFF, Scope에 NOTIFICATION_SENDER,
  room-care-api audience·roles 매퍼)를 만들고 Service account roles에 NOTIFICATION_SENDER를 부여한 뒤
  Credentials 탭의 비밀값을 `.env`의 AUTOMATION_CLIENT_SECRET에 넣습니다.

`smoke-docker.js`는 이 클라이언트로 실제 발송까지 검증하며, 클라이언트가 없으면 SKIP을 출력합니다.

현재 인증 없는 프론트 모니터링을 붙이려면 개발 환경에만 아래를 설정합니다.

```dotenv
NODE_ENV=development
DEV_AUTH_BYPASS=true
CORS_ORIGINS=http://localhost:5173
```

개발 신원은 local-dev-user이며 ADMIN 권한은 없습니다. production에서 bypass를 켜면 시작을 거부합니다.
프론트 설정은 다음과 같습니다.

```dotenv
VITE_ENABLE_MOCKS=false
VITE_API_BASE_URL=http://localhost:8080
VITE_WS_URL=ws://localhost:8080/ws
```

인증을 켜는 단계에서는 프론트 WS에 첫 auth 메시지를 추가해야 합니다.

## 알림 API

- POST /api/push/token — 본문 {"token":"FCM token"}, 본인 토큰 등록, 204
- DELETE /api/push/token — 같은 본문으로 본인 토큰 삭제, 204
- GET /api/notifications — 본인 알림 최대 100개 배열
- POST /api/notifications/send — ADMIN만 발송 가능

```json
{"eventId":"automation-123","userId":"Keycloak subject","title":"자동 제어 완료","body":"제습기를 켰습니다","data":{"deviceId":"dehumidifier-1"}}
```

FCM 토큰은 AES-256-GCM으로 Redis에 암호화해 사용자당 최대 10개를 저장합니다.
userId + eventId 기준 NX/24시간 TTL 중복 방지, 중복 요청은 duplicate를 반환합니다.
오류 시 claim을 해제해 재시도합니다. 전송 직후 종료 또는 Redis 저장 실패 시 중복 전송이
가능하므로 정확히 한 번 전송을 보장하지 않습니다. 부분 실패는 partial-failure로 기록합니다.
실제 전송은 FCM_ENABLED=true와 secrets/firebase-service-account.json이 필요합니다.
기본 FCM_ENABLED=false는 실제 푸시 없이 dry-run으로 기록합니다.
목록 필드는 id/title/body/data/createdAt/status/targetCount/successCount입니다.
푸시·목록 API 상세 타입은 프론트 초안에 없으므로 E 담당과 확정해야 합니다.

## 배포와 관측성

인증서를 infra/nginx/certs/fullchain.pem과 privkey.pem에 두고
`docker compose --profile tls up --build`로 TLS 1.3 및 WS upgrade 프록시를 실행합니다.
운영 Origin은 CORS_ORIGINS에 명시하고 내부 서비스는 직접 외부에 노출하지 않습니다.
운영 키는 Secret Manager로 관리합니다.
/actuator/health는 프로세스 생존 확인이며 Redis와 C 서버 준비 상태를 보장하는 readiness 검사는 아닙니다.
JSON 로그는 requestId/메서드/경로 라벨/상태/소요 시간만 기록하며 토큰과 본문은 기록하지 않습니다.

### 지표

/actuator/prometheus는 Node.js 기본 지표와 아래 Gateway 지표를 제공합니다.
경로 라벨은 알려진 경로(/api/sensors, /api/devices, /api/edge, /api/notifications/send 등)와 /api/other로 제한해
임의 URL이 시계열을 늘리지 못하게 합니다.

| 지표 | 라벨 | 의미 |
| --- | --- | --- |
| http_server_request_duration_seconds | method, route, status_code | HTTP 응답 시간 히스토그램 |
| gateway_websocket_clients | - | 현재 브라우저 WebSocket 연결 수 |
| gateway_cloud_upstream_failures_total | transport(rest/ws) | C 서버 연결 실패 |
| gateway_notifications_total | status | sent/dry-run/duplicate/partial-failure/no-targets/error |

Prometheus는 `infra/prometheus/alerts.yml`의 GatewayDown, GatewayHighErrorRate(5xx 5% 초과),
CloudServerUnreachable, NotificationDeliveryFailures, GatewaySlowResponses(p95 1초 초과) 규칙을 평가합니다.
외부 통지(메일·Slack)는 Alertmanager를 붙일 때 추가합니다.

### Grafana/Loki

```powershell
docker compose --profile observability up --build
```

- Grafana: http://localhost:3000 (admin / `.env`의 GRAFANA_ADMIN_PASSWORD), Room Care 폴더의 Room Care Gateway 대시보드
- Prometheus·Loki 데이터소스와 대시보드는 `infra/grafana`에서 자동 프로비저닝되며 UI 수정은 저장되지 않습니다.
- Grafana Alloy가 Docker 소켓으로 Compose 컨테이너 로그를 수집해 Loki로 보냅니다.
  라벨은 service/project/stream과 Gateway 로그의 level뿐입니다. Explore에서 `{service="gateway-service"}`로 조회합니다.
- Grafana(3000)와 Loki(3100)는 127.0.0.1에만 바인딩합니다.

보존 정책

| 대상 | 보존 | 설정 위치 |
| --- | --- | --- |
| 컨테이너 원본 로그 | 서비스당 10MB x 3파일 | compose.yaml `x-logging` |
| Loki 로그 | 7일(168h), compactor가 삭제 | infra/loki/loki.yml |
| Prometheus 지표 | 15일 또는 2GB 중 먼저 도달 | compose.yaml prometheus command |

Alloy의 Docker 소켓 마운트는 개발용입니다. 운영에서는 클라우드 로깅 에이전트 또는 노드 단위 수집기로 대체하고
보존 기간은 개인정보 처리 방침에 맞춰 조정합니다.
PostgreSQL은 Keycloak 저장소입니다. C 데이터 스키마와 개인정보 컬럼 암호화는 C 담당과 연동합니다.
