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
서비스용 client credentials 클라이언트는 배포 시 별도로 등록해야 합니다.

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
/actuator/health는 프로세스 생존 확인, /actuator/prometheus는 Node.js 프로세스 지표입니다.
Redis와 C 서버 준비 상태를 보장하는 readiness 검사는 아닙니다.
JSON 로그는 requestId/메서드/상태/소요 시간만 기록하며 토큰과 본문은 기록하지 않습니다.
PostgreSQL은 Keycloak 저장소입니다. C 데이터 스키마와 개인정보 컬럼 암호화는 C 담당과 연동합니다.
