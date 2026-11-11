# D 백엔드 인프라

자취방 원격 케어 시스템(SAD v1.2)의 D 역할 저장소입니다. 클라우드 VM 1대의 Docker Compose로
nginx, Node.js Gateway(`node-service`), Cloud Server(C), MQTT 브로커(Mosquitto), PostgreSQL, Redis, Prometheus를 함께 실행합니다.

> **로그인 기능과 Keycloak은 사용하지 않습니다.** 웹은 인증 없이 Gateway를 사용하고 모든 요청은 방 사용자 한 명(`ROOM_USER_ID`)으로 처리됩니다.
> 그래서 80번 포트에 접속할 수 있는 사람은 누구나 기기를 제어할 수 있으므로, 시연은 신뢰할 수 있는 망에서만 합니다.
> Cloud Server → Gateway 알림은 내부망 전용 `POST /internal/notifications` + `X-Internal-Key`입니다.

실행·연동 방법은 [D 백엔드 인프라 가이드](docs/NODE_BACKEND.md)를 따르세요.

## 포함 범위

| 경로 | 내용 |
| --- | --- |
| `compose.yaml` | 전체 구성. 외부 공개 포트는 nginx 80과 Mosquitto 8883(TLS)뿐 |
| `node-service` | Gateway: REST·WebSocket 중계, 알림 이력·FCM(선택)·중복 차단, 내부 알림 API, Prometheus 지표 |
| `infra/nginx` | 웹 정적 파일 제공, /api·/ws 중계, /internal·/actuator 차단 |
| `infra/mosquitto` | 브로커 설정, ACL, TLS 인증서 생성 스크립트 |
| `infra/prometheus` | 지표 수집과 경보 규칙 |
| `infra/alertmanager` | 팀 채널 경보 통지 (선택 `alerting` 프로필) |
| `infra/grafana`, `infra/loki`, `infra/alloy` | 대시보드·로그 수집 (선택 `observability` 프로필) |
| `gateway-service`, `notification-service` | v1.1 Java 구현 참고 자료(ADR-004, 사용하지 않음) |

## 빠른 실행

backend, cloud-server, frontend 저장소를 같은 폴더에 나란히 둡니다.

```bash
node node-service/scripts/setup-env.js
sh infra/mosquitto/gen-certs.sh
docker compose up -d --build
node node-service/scripts/smoke-docker.js
```

- 웹: http://localhost (frontend에서 `npm run build`한 결과를 제공)
- Prometheus: http://127.0.0.1:9090

## 다음 연동 지점

- [x] C Cloud Server를 같은 Compose에서 실행 (`http://cloud-server:3000`, PostgreSQL·Mosquitto 연결)
- [x] ~~Keycloak 로그인~~ — 로그인 기능 제거, Keycloak 삭제 ([인증 정책](docs/NODE_BACKEND.md#인증-정책-로그인-없음))
- [x] 내부 알림 API `POST /internal/notifications` (X-Internal-Key) 와 WebSocket `notification.new`
- [x] Mosquitto: 계정·ACL·TLS 8883 ([가이드](docs/NODE_BACKEND.md#mqtt-브로커-mosquitto))
- [x] nginx 80에서 웹·API 제공, 내부 경로 차단
- [x] Grafana/Loki 대시보드와 로그 보존 정책 (선택 프로필)
- [x] Alertmanager 경보 통지 (선택 프로필), Redis·C 서버 readiness 검사
- [x] C 서버 연동 요청 반영: 기기 명령 `Idempotency-Key` 전달, `CLOUD_HEALTH_PATH=/health`
- [ ] C 담당: 알림 연동을 `GATEWAY_INTERNAL_NOTIFICATIONS_URL` + `X-Internal-Key` 방식으로 변경, 사용자 JWT 검증 제거
- [ ] A 담당: edge_agent에 MQTT CA 파일 옵션 추가(또는 Pi에 CA 등록), 계정 `room-001`·TLS 8883 사용
- [ ] E 담당: 로그인 화면 없이 같은 출처(nginx)로 빌드, `notification.new` 표시
- [ ] SAD v1.2 문서의 인증 부분(6.1, ADR-014, 10.3 `/api/auth/login`·WS auth) 수정 — 로그인 제거 반영
- [ ] VM 확보와 방화벽(80, 8883만 허용), 과금 알림 설정
- [ ] AI 학습 스크립트 (SAD 4.1, D 담당)
- [ ] 알림 목록·읽음 API 계약을 C·E와 확정 (D: id/title/body/data/status, C: message/read/pushStatus)
