# D 백엔드 인프라 (SAD v1.2)

클라우드 VM 1대의 Docker Compose로 nginx, Node.js Gateway, Cloud Server(C), MQTT 브로커,
PostgreSQL, Redis, Prometheus를 함께 실행합니다(ADR-013, ADR-016).
**로그인 기능과 Keycloak은 사용하지 않습니다.** 작업 브랜치는 minjae입니다.

## 구성

```
브라우저 ──80──▶ nginx ─┬─ 정적 웹(frontend dist)
                        ├─ /api, /ws ──▶ gateway-service:8080 ──▶ cloud-server:3000
                        └─ /internal, /actuator → 404
라즈베리파이 ──8883 TLS──▶ mosquitto ◀──1883(내부)── cloud-server
cloud-server ──POST /internal/notifications (X-Internal-Key)──▶ gateway-service
```

| 서비스 | 포트 | 공개 |
| --- | --- | --- |
| nginx | 80 | 외부 공개 |
| mosquitto | 8883(TLS), 1883(내부) | 8883만 외부 공개 |
| gateway-service | 8080 | 내부망 |
| cloud-server | 3000 | 내부망 |
| postgres, redis | 5432, 6379 | 내부망 |
| prometheus | 9090 | 127.0.0.1만 |
| alertmanager(선택 `alerting`), grafana·loki(선택 `observability`) | 9093, 3000, 3100 | 127.0.0.1만 |

VM의 보안 그룹·방화벽에서도 80과 8883만 엽니다.

## 실행

backend, cloud-server, frontend 저장소를 같은 폴더에 나란히 클론합니다.
위치가 다르면 `.env`의 `CLOUD_SERVER_DIR`, `WEB_DIST_DIR`로 지정합니다.

```bash
# 1) 비밀값이 채워진 .env 만들기 (기존 .env는 유지하고 빠진 키만 추가)
node node-service/scripts/setup-env.js
# 2) MQTT TLS 인증서 만들기 (VM이면 공인 IP나 호스트 이름을 인자로)
sh infra/mosquitto/gen-certs.sh 203.0.113.10
# 3) 웹 빌드 (frontend 저장소에서, VITE_API_BASE_URL·VITE_WS_URL은 비우거나 같은 주소)
cd ../frontend && npm ci && npm run build && cd ../backend
# 4) 전체 실행
docker compose up -d --build
# 5) 확인
node node-service/scripts/smoke-docker.js
```

웹 빌드가 없으면 http://localhost/ 는 403이지만 /api와 /ws는 동작합니다.
Gateway만 직접 실행하려면 Node.js 22 이상과 Redis를 준비하고 node-service에서 `npm ci`, `npm start`입니다.
이때 `REDIS_URL`, `CLOUD_SERVICE_URL`, `DATA_ENCRYPTION_KEY_BASE64`, `INTERNAL_API_KEY`를 환경 변수로 지정합니다.
검증은 `npm test`입니다. 사용하지 않는 선택 의존성인 Firebase Firestore/Storage는 설치에서 제외합니다.

`smoke-docker.js`는 nginx(80)를 거친 공개 경로와, Gateway 컨테이너 안에서 내부 경로(/internal, /actuator)를 검증합니다.
실제 FCM 전송 없이 dry-run 알림 이력을 남깁니다.

## 인증 정책 (로그인 없음)

1인 자취방 시스템이라 웹 앱에는 로그인 화면이 없습니다. SAD v1.2의 단일 계정 로그인(6.1, ADR-014)도 쓰지 않습니다.

| 요청 | Gateway 처리 |
| --- | --- |
| 웹 앱의 /api, /ws | 인증 없음. 방 사용자 `ROOM_USER_ID`(기본 `room-user`) 한 명으로 처리 |
| POST /internal/notifications | `X-Internal-Key`가 `.env`의 `INTERNAL_API_KEY`와 같아야 함. 다르면 401, 설정이 없으면 503 |

- 로그인이 없으므로 **80번 포트에 접속할 수 있는 사람은 누구나 센서 조회와 기기 제어를 할 수 있습니다.**
  시연은 팀 핫스팟 등 신뢰할 수 있는 망에서 하고, 주소를 공개 게시하지 않습니다.
  요청 수는 nginx(IP당 초당 20회)와 Gateway(IP당 분당 120회)에서 제한합니다.
- 웹 요청의 `Authorization`, `X-User-Id` 같은 신원 헤더는 C 서버로 전달하지 않습니다. C 서버도 사용자 인증을 하지 않습니다
  (C의 `JWT_*`, `ROOM_ALLOWED_SUBJECTS`, `API_BEARER_TOKEN`은 비워 둡니다).
- `/internal`과 `/actuator`는 nginx가 404로 막으므로 외부에서 가짜 알림을 보내거나 지표를 볼 수 없습니다.
- WebSocket은 nginx가 제공하는 같은 출처(Origin의 호스트 = Host)와 `CORS_ORIGINS`에 적은 출처(Vite 개발 서버)만 받습니다.

## C 서버의 계약

Gateway는 `/api`의 나머지 경로를 `http://cloud-server:3000`으로 전달합니다.

- GET /api/sensors/latest, GET /api/sensors/history?range=1h|24h|7d
- GET /api/devices, GET /api/edge/status, POST /api/devices/{id}/commands
- GET /api/outdoor, GET /api/forecast, GET /api/recommendations, POST /api/recommendations/{id}/apply|reject|revert
- GET/PUT /api/automation 등

C 서버 응답 상태 코드는 유지하고 연결 실패는 502입니다. 가짜 센서값은 만들지 않습니다.
기기 명령의 `Idempotency-Key` 헤더(출력 가능한 ASCII 1~200자)는 그대로 C 서버로 전달하며, 형식이 틀리면 400입니다.
C 서버는 실제 장비 모드에서 이 키가 없는 명령을 400으로 거부하고 24시간 중복을 차단합니다.
CORS는 `Content-Type`, `Idempotency-Key` 요청 헤더를 허용하고 `X-Request-Id`를 노출합니다.

Compose의 cloud-server는 `DEMO_MODE=false`로 PostgreSQL(`roomait` DB)과 Mosquitto(`cloud-server` 계정)에 연결하고,
`MQTT_PROTOCOL=roomait-v1`, `MQTT_TOPIC_PREFIX=roomcare/{EDGE_DEVICE_ID}`를 사용합니다.
cloud-server 저장소에 Dockerfile이 없어 compose.yaml의 `dockerfile_inline`으로 빌드합니다.

## WebSocket

브라우저는 nginx를 거쳐 `ws://<주소>/ws`로 접속합니다. 인증 메시지 없이 접속 즉시 C 서버 /api/edge/status를 읽어
edge.status를 보내고 C 서버 /ws에 연결합니다.
Gateway가 15초마다 JSON heartbeat를 보내고 JSON ping에 응답합니다.
C 서버의 sensor.update, device.state, edge.status, edge.recovered, command.ack를 중계하고,
알림이 생기면 Gateway가 직접 `notification.new`를 모든 연결에 보냅니다(FCM 없이도 웹에 표시).
C 서버 소켓이 끊기면 브라우저 소켓을 닫아 재연결·REST 재동기화를 유도합니다.

> SAD 10.3의 forecast.update, recommendation.new는 C 서버가 보내면 중계 목록에 추가해야 합니다(현재 미중계).

## 내부 알림 API (Cloud Server → Gateway)

SAD 10.3의 `POST /internal/notifications`입니다. Compose 내부망에서만 호출할 수 있습니다.

```bash
curl -X POST http://gateway-service:8080/internal/notifications \
  -H "X-Internal-Key: $INTERNAL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"eventId":"automation-123","title":"자동 제어 완료","body":"제습기를 켰습니다","data":{"deviceId":"dehumidifier-1"}}'
```

- 본문은 `eventId`, `title`, `body`(문자열, 각 4096자 이하)와 선택 `data`(값이 모두 문자열인 객체)입니다. 받는 사람은 항상 방 사용자입니다.
- `eventId`가 같으면 24시간 동안 한 번만 처리하고 `{"status":"duplicate"}`를 돌려줍니다. 재시도할 때 같은 eventId를 씁니다.
- 응답 `status`: sent / dry-run / partial-failure / no-targets / duplicate. 서버 오류는 503이며 재시도할 수 있습니다.
- Compose는 cloud-server 컨테이너에 `GATEWAY_INTERNAL_NOTIFICATIONS_URL`과 `INTERNAL_API_KEY`를 넣어 둡니다.
  **현재 C 서버의 알림 연동 코드는 이전 방식(Keycloak 서비스 계정)이므로 C 담당이 이 방식으로 바꿔야 합니다.**
  C의 `NOTIFICATION_SEND_URL` 등 이전 변수는 설정하지 않습니다(설정하면 C 서버가 시작을 거부합니다).

## MQTT 브로커 (Mosquitto)

- 익명 접속 금지. 계정은 엣지(사용자명 = `EDGE_DEVICE_ID`, 기본 room-001)와 `cloud-server` 두 개이며
  비밀번호는 `.env`의 `MQTT_EDGE_PASSWORD`, `MQTT_CLOUD_PASSWORD`입니다. 컨테이너 시작 때마다 비밀번호 파일을 다시 만듭니다.
- ACL([infra/mosquitto/acl](../infra/mosquitto/acl)): 엣지 계정은 `roomcare/{자기 deviceId}/#`만, cloud-server는 `roomcare/#`.
- 8883은 TLS 전용(자체 서명 CA), 1883 평문은 Compose 내부망의 cloud-server만 사용하며 호스트에 공개하지 않습니다.
- `gen-certs.sh`는 `secrets/mosquitto/`에 ca.crt·ca.key·server.crt·server.key를 만듭니다. VM 주소가 바뀌면 `FORCE=1`로 다시 만듭니다.

라즈베리파이(edge_agent) `config.toml` 예:

```toml
[mqtt]
host = "VM 공인 IP"
port = 8883
username = "room-001"          # EDGE_DEVICE_ID
password = "MQTT_EDGE_PASSWORD 값"
tls = true
```

라즈베리파이에는 `secrets/mosquitto/ca.crt`만 복사합니다(ca.key·server.key는 공유하지 않음).
현재 edge_agent는 `tls = true`일 때 시스템 CA만 신뢰하므로, A 담당이 CA 파일 경로 옵션을 추가하거나
`sudo cp ca.crt /usr/local/share/ca-certificates/roomcare-mqtt.crt && sudo update-ca-certificates`로 등록합니다.

## 프론트 연동

nginx가 웹과 API를 같은 주소로 제공하므로 프론트 빌드에는 같은 출처를 씁니다.

```dotenv
VITE_ENABLE_MOCKS=false
VITE_API_BASE_URL=
VITE_WS_URL=
```

`VITE_API_BASE_URL`이 비면 같은 출처를 쓰는지, `VITE_WS_URL`을 `ws://<VM 주소>/ws`로 넣어야 하는지는 E 담당과 확인합니다.
Vite 개발 서버(5173)로 붙일 때는 `VITE_API_BASE_URL=http://localhost`, `VITE_WS_URL=ws://localhost/ws`이고
`CORS_ORIGINS`에 `http://localhost:5173`이 있어야 합니다.

## 알림 API

- POST /api/push/token — 본문 {"token":"FCM token"}, 방 사용자의 토큰 등록, 204
- DELETE /api/push/token — 같은 본문으로 토큰 삭제, 204
- GET /api/notifications — 방 사용자 알림 최대 100개 배열
- POST /internal/notifications — Cloud Server 전용(위 내부 알림 API)

FCM 토큰은 AES-256-GCM으로 Redis에 암호화해 최대 10개를 저장합니다.
eventId 기준 NX/24시간 TTL 중복 방지, 중복 요청은 duplicate를 반환합니다.
오류 시 claim을 해제해 재시도합니다. 전송 직후 종료 또는 Redis 저장 실패 시 중복 전송이
가능하므로 정확히 한 번 전송을 보장하지 않습니다. 부분 실패는 partial-failure로 기록합니다.
실제 전송은 FCM_ENABLED=true와 secrets/firebase-service-account.json이 필요합니다(SAD: Should).
기본 FCM_ENABLED=false는 실제 푸시 없이 dry-run으로 기록합니다.
목록과 notification.new 필드는 id/title/body/data/createdAt/status/targetCount/successCount입니다.

## 배포와 관측성

HTTPS(TLS 1.3)는 도메인을 확보했을 때 적용하는 선택 항목(Could)입니다. 지금 nginx는 80(HTTP)만 엽니다.
운영 키(`.env`)는 저장소·발표 자료에 올리지 않고, 노출되면 즉시 교체합니다.
JSON 로그는 requestId/메서드/경로 라벨/상태/소요 시간만 기록하며 본문은 기록하지 않습니다.

### 헬스 검사

| 경로 | 의미 | 실패 시 |
| --- | --- | --- |
| /actuator/health, /actuator/health/liveness | 프로세스 생존. Docker healthcheck가 사용 | - |
| /actuator/health/readiness | Redis PING과 C 서버 도달 여부 | 503 |

```json
{"status":"DOWN","components":{"redis":{"status":"UP"},"cloud":{"status":"DOWN"}}}
```

- Redis는 연결 준비 상태와 PING, C 서버는 `CLOUD_SERVICE_URL` + `CLOUD_HEALTH_PATH`(기본 `/health`)의 HTTP 응답으로 판단합니다.
  5xx·연결 실패·5초 초과면 DOWN이며 4xx(인증 필요, 경로 없음)는 서버가 살아 있는 것으로 봅니다.
  C 서버의 `/health`는 엣지 단절 등으로 `degraded`여도 200이므로 C 프로세스 도달 여부만 뜻합니다.
- 응답에는 오류 내용이나 주소를 넣지 않습니다. /actuator는 nginx가 막으므로 내부망(Prometheus)에서만 볼 수 있습니다.
- C 서버 장애로 Gateway가 재시작되지 않도록 Docker healthcheck는 liveness만 사용합니다.
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
| gateway_dependency_up | dependency(redis/cloud) | 스크레이프 시점 readiness 결과(1/0) |

Prometheus는 `infra/prometheus/alerts.yml`의 규칙을 평가합니다.

| 경보 | 심각도 | 조건 |
| --- | --- | --- |
| GatewayDown | critical | Gateway 지표 수집 1분 실패 |
| RedisUnavailable | critical | Redis readiness 1분 실패 |
| CloudServerDown | warning | C 서버 readiness 2분 실패 |
| GatewayHighErrorRate | warning | 5xx 5% 초과 5분 |
| CloudServerUnreachable | warning | 5분간 C 서버 연결 실패 10회 초과 |
| NotificationDeliveryFailures | warning | 15분 안에 발송 오류·일부 실패 |
| GatewaySlowResponses | warning | p95 1초 초과 10분 |
| AlertmanagerNotificationsFailing | warning | 15분 안에 팀 채널 통지 실패 |

### Alertmanager

선택 항목입니다. SAD v1.2는 경보를 Prometheus 화면(http://127.0.0.1:9090/alerts)에서 확인하므로 기본 실행에는 없습니다.
팀 채널 통지가 필요할 때 `docker compose --profile alerting up -d`로 켜며 UI는 http://127.0.0.1:9093입니다.
꺼져 있는 동안 Prometheus 로그에 Alertmanager 연결 실패가 남는 것은 정상입니다.
경보는 Slack 호환 Incoming Webhook으로 발생·해소를 모두 통지합니다(critical 1시간, warning 4시간마다 반복).

1. 팀 채널의 Webhook URL을 `secrets/alertmanager/slack-webhook-url` 파일에 한 줄로 저장합니다.
   Discord는 채널 Webhook URL 끝에 `/slack`을 붙입니다. `secrets/`는 git에 올라가지 않습니다.
2. `docker compose --profile alerting up -d alertmanager`로 반영합니다. 설정만 바꿨다면 `curl -X POST http://127.0.0.1:9093/-/reload`.
3. 확인: `curl -X POST http://127.0.0.1:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{"labels":{"alertname":"TestAlert","severity":"warning"},"annotations":{"summary":"테스트","description":"Alertmanager 통지 확인"}}]'`

파일이 없어도 Alertmanager는 기동하며 통지만 실패합니다(AlertmanagerNotificationsFailing 경보와 로그로 확인).
같은 원인의 중복 통지는 억제합니다: GatewayDown 중 warning 전체, RedisUnavailable 중 NotificationDeliveryFailures,
CloudServerDown 중 CloudServerUnreachable. 라우팅은 `infra/alertmanager/alertmanager.yml`에서 바꾸고,
CI가 promtool·amtool로 Prometheus·Alertmanager 설정을 검증합니다.

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
PostgreSQL은 Cloud Server(C)의 `roomait` DB이며 스키마는 C 서버가 시작할 때 만듭니다. 백업은 `docker compose exec postgres pg_dump -U roomait roomait`입니다.
