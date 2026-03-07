# DevFlow → kancli Migration Plan

상태: ACTIVE

## 배경

기존 DevFlow는 웹 대시보드 중심 UX였다. 운영/실행 중심 워크플로우를 CLI 우선으로 전환해, 빠른 티켓 처리와 자동화 친화성을 확보한다.

## 단계별 계획

### Phase 0 (이번 런) — Bootstrap

- kancli 엔트리포인트/기본 명령 스캐폴딩
- local server API wrapper 도입
- TUI-lite board 제공
- 문서화(MVP, migration)
- backlog에 K001+ 티켓 정의

### Phase 1 — CLI 우선 운영

- README 진입점을 `kancli` 중심으로 재배치
- 운영 플레이북(일상 명령 시퀀스) 추가
- board watch 모드 + 간단 필터링 추가

### Phase 2 — 이름 전환 정리

- 레포/패키지/문서의 `DevFlow` 명칭을 `kancli runtime` 중심으로 재정렬
- 호환 alias 유지(예: DEVFLOW_SERVER_URL fallback)
- 데이터 파일명/환경변수 rename 계획 수립(호환 기간 운영)

### Phase 3 — 웹 보조화

- 웹 UI는 관측/디버깅 보조 채널로 유지
- 새 기능은 CLI-first로 설계 후 웹 반영

## 호환성 정책

- 기존 서버 API endpoint는 유지한다.
- 웹 UI 기능/동작은 깨지지 않아야 한다.
- 명칭 전환은 점진적으로 수행하며, 기존 사용자 플로우를 즉시 파괴하지 않는다.

## 리스크 및 대응

1. **리스크:** CLI 응답 포맷 고정으로 자동화 스크립트 호환 이슈
   - **대응:** 차후 `--json` 제공, 현재는 human-readable 우선
2. **리스크:** pendingAction 타입 다양성 증가(selection/text/form)
   - **대응:** MVP는 selection+text 우선 처리, form은 Phase 1 이후
3. **리스크:** 실시간 운영 니즈(모니터링)
   - **대응:** Phase 1에서 watch 모드 추가

## 성공 지표(MVP)

- 신규 티켓 라이프사이클(생성→질의응답→다음단계/중지)을 CLI만으로 처리
- 운영자가 API endpoint를 직접 기억하지 않아도 된다
- 대시보드에 의존하지 않고도 pending question 처리가 가능
