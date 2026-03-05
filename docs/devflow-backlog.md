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
- 상태: DONE
- 결과:
  - `writeJsonAtomic` 도입(tmp write → fsync → rename)으로 atomic 저장 보장
  - overwrite 시 `.bak` 자동 백업 생성
  - `loadJsonWithRecovery` 도입: JSON corruption 시 `.corrupt-*` 격리 + `.bak` 복구
  - `repairDbState` 무결성 체크: invalid ticket/queue 참조 정리, nextId 보정
  - 관련 테스트 추가: `test/persistence-reliability.test.js`

## T010 (P1) SSE 이벤트 모델 확장
- 상태: DONE
- 결과:
  - `task_lifecycle`, `step_event`, `redline_event`, `artifact_added` SSE 이벤트 추가
  - step 시작/완료/에러/pending-action 시점 이벤트 발행
  - redline halt 및 artifact 적재 시 전용 이벤트 발행
  - 대시보드 Live Events 카운터 추가(이벤트 타입별 실시간 누적)

## T011 (P1) 동시성 스모크/회귀 테스트(3-worker)
- 상태: DONE
- 결과:
  - scheduler dispatch 모델(`planDispatch`) 분리로 동시성 로직 테스트 가능화
  - 3 worker 제한 스모크 테스트 추가
  - FIFO fairness/slot-full 회귀 테스트 추가
  - 테스트 파일: `test/concurrency-smoke.test.js`

## T012 (P2) 운영성 개선
- 상태: DONE
- 결과:
  - `/health` endpoint 추가(uptime, queue/running depth, statusCounts, metrics 노출)
  - 기본 metrics counter 추가(tickets/steps/errors/redline/stale-action/sse)
  - `createRecoveryPendingAction` 도입으로 blocked/halted 복구 액션 통일(retry/advance/halt)
  - 관련 테스트 추가: `test/operability.test.js`

## T013 (P1) Skill 기반 Kanban 컬럼 전환
- 상태: DONE
- 결과:
  - 대시보드 기본 보드를 상태 기반 고정 컬럼에서 pipeline skill 기반 동적 컬럼으로 전환
  - 티켓을 `currentStep/currentSkill` 기준으로 해당 skill 컬럼에 매핑
  - blocked/halted/review/pending-action은 컬럼 분리 없이 카드 내 배지로 유지
  - done 티켓 전용 `Done` 컬럼 및 카드 시각 강조 추가
  - 상태 기반 보드는 `Board view` 토글(status/skill)로 옵션 유지
  - 백엔드 응답에 `pipelineColumns`, `ticket.currentSkill`, `ticket.isDone` 메타데이터 추가
  - 테스트 추가: `test/kanban-skill-columns.test.js`
