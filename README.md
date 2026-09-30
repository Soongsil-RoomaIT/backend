# D 백엔드 인프라 구현

자취방 원격 케어 시스템 SAD의 D 역할을 위한 시작 구현입니다. 인증과 인가, API Gateway, 푸시 알림, 전송·저장 암호화, 배포와 관측성 구성을 한 폴더에 모았습니다.

## 포함 범위

- `gateway-service`: Keycloak이 발급한 JWT를 검증하고 내부 서비스로 요청을 전달합니다.
- `notification-service`: 사용자별 FCM 토큰을 AES-256-GCM으로 암호화해 Redis에 저장하고 알림 요청의 중복 전송을 차단합니다.
- `infra/keycloak`: 개발용 OAuth2/OIDC realm, 클라이언트, 역할 정의입니다.
- `infra/prometheus`: 두 서비스의 Actuator 지표 수집 설정입니다.
- `infra/nginx`: TLS 1.3 종료를 위한 선택 실행 프로필입니다.
- `compose.yaml`: Keycloak, PostgreSQL 15, Redis, Gateway, 알림 서비스, Prometheus를 함께 실행합니다.

## 사전 준비

1. `.env.example`을 `.env`로 복사합니다.
2. `DATA_ENCRYPTION_KEY_BASE64`를 32바이트 임의 키의 Base64 값으로 교체합니다.
3. 실제 FCM 전송 시 Firebase 서비스 계정 JSON을 `secrets/firebase-service-account.json`에 둡니다.

PowerShell에서 32바이트 키 생성 예시:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

## 실행

```powershell
docker compose up --build
```

기본 상태 확인 주소:

- Gateway: `http://localhost:8080/actuator/health`
- Notification: `http://localhost:8082/actuator/health`
- Keycloak: `http://localhost:8180` (`admin` / `.env`의 비밀번호)
- Prometheus: `http://localhost:9090`

FCM 자격 증명이 없으면 알림 서비스는 안전한 `dry-run` 모드로 시작하며 전송 요청의 구조와 중복 방지만 검증합니다.

## 개발용 토큰과 호출 흐름

Keycloak realm은 `room-care`, 공개 클라이언트는 `room-care-web`입니다. 사용자 역할은 `USER`, 운영 역할은 `ADMIN`입니다. 초기 사용자는 Keycloak 관리 화면에서 직접 만들고 역할을 부여합니다. 실제 운영에서는 외부 IdP 또는 별도 가입 흐름으로 교체해야 합니다.

알림 API는 Gateway의 `/api/notifications/**` 경로로만 노출합니다.

- `POST /api/notifications/devices`: 본인의 FCM 토큰 등록
- `DELETE /api/notifications/devices/{token}`: 본인의 FCM 토큰 삭제
- `POST /api/notifications/send`: `ADMIN` 또는 내부 서비스용 알림 발송

`send` 요청의 `eventId`는 중복 방지 키입니다. 같은 이벤트는 Redis TTL 동안 한 번만 처리됩니다.

## TLS 1.3

인증서와 개인 키를 각각 `infra/nginx/certs/fullchain.pem`, `infra/nginx/certs/privkey.pem`에 둔 다음 실행합니다.

```powershell
docker compose --profile tls up --build
```

운영 환경에서는 클라우드 Load Balancer 또는 관리형 API Gateway에서 TLS를 종료하고, 내부망도 가능하면 mTLS로 보호합니다. 저장 데이터의 키는 `.env` 대신 KMS 또는 Secret Manager에서 주입해야 합니다.

## 다음 연동 지점

- C 역할의 Cloud Server 주소를 `CLOUD_SERVICE_URL`에 연결
- E 역할의 Web App에 Keycloak Authorization Code + PKCE 로그인 적용
- 내부 서비스가 알림을 호출할 수 있도록 client credentials 클라이언트 분리
- Grafana/Loki 또는 클라우드 모니터링으로 대시보드와 로그 보존 정책 추가

