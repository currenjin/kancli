# kancli MVP Spec

상태: DRAFT v0.1

## 목표

kancli는 DevFlow 런타임의 **터미널 우선 인터페이스**다.
사용자는 웹 대시보드를 열지 않고도 티켓 생성/응답/진행/중지를 수행한다.

## MVP 범위

### 명령

- `kancli up`
  - 서버 연결 확인
  - health + pipeline 요약 출력
- `kancli board`
  - 스킬 컬럼 보드 출력
  - pending-question queue 출력
- `kancli add <ticket>`
  - 새 티켓 생성
- `kancli answer <ticket> <option|text>`
  - pendingAction 해소
  - option id/label 매칭 우선, 미매칭 시 text 응답
- `kancli next <ticket>`
  - 다음 스텝 이동
- `kancli stop <ticket>`
  - 실행 중지 + halted 전환
- `kancli status`
  - 파이프라인/큐/실행중/티켓 요약

### API 의존 정책

- 사용자는 HTTP API를 직접 호출하지 않는다.
- kancli 내부 wrapper가 기존 local server API를 호출한다.
- 사용 API:
  - `GET /health`
  - `GET /api/tickets`
  - `POST /api/tickets`
  - `GET /api/tickets/:id/log`
  - `POST /api/tickets/:id/actions/resolve`
  - `POST /api/tickets/:id/next`
  - `POST /api/tickets/:id/stop`

## 보드 렌더링(MVP)

- TUI-lite 텍스트 보드
- 컬럼: pipeline skill 기준
- 카드: `id, title, status, currentStep, pendingAction 요약`
- 추가 섹션:
  - `Done`
  - `Pending Questions`

## 운영 기준

- 기본 서버 주소: `http://localhost:3000`
- 환경변수: `KANCLI_SERVER_URL`
- 실패 시 API error를 그대로 CLI 에러로 노출

## 비범위(후속)

- 실시간 watch 모드(`kancli board --watch`)
- 키보드 인터랙티브 ncurses UI
- JSON 출력 옵션(`--json`)
- 자동완성/쉘 completion
- 인증/원격 멀티 서버 프로파일

## 수용 기준

1. CLI만으로 티켓 생성/응답/다음/중지 가능
2. board에 skill columns + pending-question queue가 보인다
3. 웹 UI(index.html)는 기존처럼 동작한다
4. 기존 API 계약을 깨지 않는다
