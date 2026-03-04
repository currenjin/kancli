# DevFlow Backlog

상태: TODO / DOING / DONE / BLOCKED

## T001 (P0) Skill-agnostic runtime 정리
- 상태: DONE
- 결과:
  - skill-specific 하드코딩(augmented-coding compat 분기/전용 endpoint) 제거
  - action resolve 단일 경로(`/api/tickets/:id/actions/resolve`) 중심으로 정리
  - action/artifact 파싱 공통 모델 유지

## T002 (P0) Redline 엔진 스캐폴딩
- 상태: DONE
- 결과:
  - `lib/redline.js` 추가
  - halt 조건 스캐폴딩 구현:
    1) 반복 테스트 실패(3회)
    2) plan-violation signal
    3) invalid-plan signal
  - halt 시 pendingAction으로 retry/halt 제어

## T003 (P0) E2E 검증 시나리오 3종
- 상태: DONE
- 결과:
  - `test/e2e-validation.test.js` 추가
  - 시나리오:
    - generic action/request loop shape
    - artifact accumulation + review transition
    - redline halt transition(3종 조건)

## T004 (P1) Worker pool(최대 3) + queue 스케줄링
- 상태: DONE
- 결과:
  - `MAX_WORKERS=3`, queue/running 스케줄러 도입
  - 티켓 실행 큐 기반 처리

## T005 (P1) 영속 저장소(tasks/events/actions/artifacts)
- 상태: DONE
- 결과:
  - fallback file DB(`data/devflow-db.json`) 도입
  - tickets/queue/nextId 저장 및 재기동 복원

## T006 (P1) SSE 이벤트 스트림 + UI 기본 연결
- 상태: DONE
- 결과:
  - `/api/events` SSE endpoint 추가
  - 클라이언트 EventSource 연결 및 ticket/ticket_deleted 반영

## T007 (P2) Dashboard 개선
- 상태: DONE
- 결과:
  - Queue/Running/Review/Blocked-Halted 컬럼 뷰
  - latest commit/issue/next-action 요약 노출
  - pending action, artifact, log 토글 표시

## T008 (P0) Runtime-dynamic action 모델 강화
- 상태: DONE
- 결과:
  - pendingAction 정규화/스키마 보정(`type/prompt/options/metadata`) 및 TTL(`createdAt/expiresAt`) 부여
  - 액션 resolve payload 검증(`actionId` 필수, unknown action 차단, metadata 타입 검증, JSON parse 에러 처리)
  - stale action 만료 감지 후 `stale_action_expired` 복구 액션으로 전환(retry/halt)
  - `/api/tickets` 조회/resolve 경로에서 만료 액션 자동 정리
  - 회귀 테스트 추가: `test/runtime-actions.test.js`

## T009 (P0) 영속 저장 안정성 강화
- 상태: TODO
- 목표:
  - atomic write + fsync 기반 저장 안정화
  - DB corruption recovery + backup/restore
  - startup integrity check/repair

## T010 (P1) SSE 이벤트 모델 확장
- 상태: TODO
- 목표:
  - task lifecycle + step event + redline event 분리 발행
  - dashboard live-update 고도화(상태/요약/카운터)

## T011 (P1) 동시성 스모크/회귀 테스트(3-worker)
- 상태: TODO
- 목표:
  - 3 worker 병렬 실행 smoke test
  - queue fairness + blocked/halted regression test

## T012 (P2) 운영성 개선
- 상태: TODO
- 목표:
  - `/health` endpoint
  - 기본 metrics counter
  - blocked/halted recovery action 가이드 강화
