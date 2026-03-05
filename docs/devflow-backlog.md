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

## T031 (P0) Pipeline 순서 Drag & Drop 조정
- 상태: DONE
- 결과:
  - 설정 영역 `Pipeline Order`를 드래그앤드롭 재정렬 가능하도록 개선
  - 기존 ↑/↓/삭제 제어는 유지(키보드/명시적 조작 fallback)
  - 드래그 대상 하이라이트(`drop-target`)와 안내문구 추가
  - 저장 전 preview(`Preview before save`)와 즉시 동기화

## T032 (P1) Dashboard visual polish pass 2 (minimal UI cleanup)
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - 헤더/설정/보드 카드의 시각 노이즈 축소(연한 border/그림자, 간격 재정렬, muted 톤 통일)
  - ticket id/skill/status badge 타이포 계층 재정의(크기/letter-spacing/캡슐 배지 정돈)
  - 버튼 스타일 primary/secondary/danger 일관화 및 혼합 인라인 스타일 축소
  - Pipeline editor drag handle 강조 + compact row 스타일 적용
  - 칸반 카드 메타/액션/pending 영역 정리로 가독성 개선
  - 기능 로직 변경 없이 UI/CSS 중심으로 반영

## T033 (P1) Dashboard visual polish pass 3 (theme/density/collapse)
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - Light/Dark 테마 토글 추가 및 `localStorage` 기반 사용자 선호 저장
  - 카드/배지/로그/입력/타임라인 등 핵심 UI의 다크 모드 대비/가독성 개선
  - Comfy/Compact density 토글 추가(칸반 컬럼/카드 간격·패딩 최적화) + 로컬 선호 저장
  - 컬럼별 collapse/expand 토글 추가, 접힘 상태 로컬 저장, 접힘 상태에서도 티켓 수 노출 유지
  - 기존 API/워크플로우 동작 변경 없이 UI 레이어 중심 반영

## T014 (P0) Approval gate policy engine (auto/manual)
- 상태: DONE
- 결과:
  - config에 `approvalPolicy`(`defaultMode`, step별 override) 도입
  - step 완료 후 approval mode 평가: `auto`는 즉시 REVIEW, `manual`은 승인 pendingAction 생성
  - manual 승인(`approve`) 전에는 `next` 전이 불가(enforce transition)
  - manual 반려(`reject`) 시 BLOCKED + 복구 액션으로 전환

## T015 (P0) Failure auto-response policy (retry/fallback/halt)
- 상태: DONE
- 결과:
  - config에 `failurePolicy`(`retryBudget`, `allowFallbackStep`, `fallbackStepIndex`) 도입
  - recovery/redline/process_error 공통 정책화: retry budget, fallback option, escalation metadata 포함
  - retry/fallback/advance/halt action 처리 경로 확장 및 step별 retry 사용량 추적

## T016 (P0) Claude interaction compatibility testpack (3~5 combos)
- 상태: DONE
- 결과:
  - parser/runtime 호환성 검증 테스트팩 추가: `test/p0-p1-policy.test.js`
  - manual approval action payload 처리 검증
  - failure recovery escalation metadata/option 조합 검증
  - stale/blocked sanitize shape 검증(런타임 UI 호환성 보호)

## T017 (P1) Card detail panel summary 확장
- 상태: DONE
- 결과:
  - summary에 `latestDiff`, `testResult`, `rootCause`, `recommendation` 추가
  - index panel에 최신 diff/test/root-cause/next-action/recommendation 표출

## T018 (P1) Skill-column operability 강화
- 상태: DONE
- 결과:
  - config 기반 `wipLimits` 추가 및 컬럼별 WIP 표시/초과 경고
  - stale 카드 시각 강조(`isStale`) 추가
  - blocked/halted 카드 pin/priority 렌더링(`isPinnedBlocked`, `blockedPriority`)

## T019 (P1) Event timeline persistence/search
- 상태: DONE
- 결과:
  - ticket transition 타임라인 이벤트를 DB(`timelineEvents`)에 영속 저장
  - 검색 endpoint 추가: `GET /api/timeline?ticketId=&q=&limit=`
  - SSE `timeline_event` 이벤트 방출 추가

## T020 (P0) Dashboard pipeline ordering UX upgrade
- 상태: DONE
- 결과:
  - 설정 화면에 pipeline 순서 편집기 추가(↑/↓/삭제)
  - 저장 전 최종 파이프라인 순서 preview 표시
  - skill 토글 + 순서 편집을 결합해 저장 전에 변경사항 확인 가능

## T021 (P0) Skill-kanban manual step override
- 상태: DONE
- 결과:
  - `POST /api/tickets/:id/move-step` endpoint 추가
  - 강제 단계 이동 시 `reason` 필수 검증
  - `manual_step_override` timeline 이벤트 기록(from/to step/skill/reason)

## T022 (P0) Approval gate visualization on cards
- 상태: DONE
- 결과:
  - 카드에 `manual approval required` 배지 명시
  - 승인 대기 시 approve/reject 버튼 강조(Primary/Danger)
  - pending approval 상태를 카드 내에서 즉시 식별 가능

## T023 (P1) Ticket timeline panel UX
- 상태: DONE
- 결과:
  - 티켓별 timeline 패널 추가(카드 timeline 버튼)
  - ticketId 기준 timeline 조회 + query/limit 검색 필터 제공
  - 이벤트 목록을 시간순으로 표시해 전환 이력 추적 강화

## T024 (P1) Editable WIP limits + warning/enforcement mode
- 상태: DONE
- 결과:
  - 스킬 컬럼 헤더에서 WIP limit inline 편집 및 즉시 저장
  - WIP policy mode(`warn`/`enforce`) 토글 추가 및 config 반영
  - enforce 모드에서 단계 진입 전 WIP 제한 검증(canEnterStep) 적용

## T025 (P1) Worker pool observability panel
- 상태: DONE
- 결과:
  - worker slot(#1~#3) 점유 상태/티켓 표시
  - queue depth, rough ETA(min) 계산값을 API 및 대시보드에 노출
  - ticket별 worker slot 메타데이터 표시로 실행 주체 추적성 향상

## T026 (P1) 카드 시각 계층/가독성 개선
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - 카드 타이포/간격/강조 라인 재정렬로 핵심 정보 우선 노출
  - ticket id / current skill / pending prompt 가시성 강화
  - 배지/메타/상태 정보 대비 개선

## T027 (P1) 카드 정보 밀도 최적화(secondary collapse)
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - branch/commit/artifact를 details 접이식으로 이동
  - 상단 요약 라인을 concise하게 단순화
  - 기존 기능(로그/액션) 동작 변경 없이 유지

## T028 (P1) 액션 컨트롤 우선순위 스타일링
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - next(primary) / delete(danger) / 일반 컨트롤(secondary) 그룹화
  - pending action 영역에 명시 타이틀/버튼 affordance 추가
  - 수동 승인 시 approve/reject 우선순위 강조 유지

## T029 (P1) 칸반 사용성 개선(sticky/empty)
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - 컬럼 헤더 sticky 처리로 스크롤 중 문맥 유지
  - 컬럼 empty-state를 안내형 UI로 개선
  - 컬럼 높이/스크롤 동작을 보드 사용성 중심으로 조정

## T030 (P1) 좁은 화면 대응 반응형 폴리시
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - 1200px 이하에서 패딩/컬럼 높이/간격 조정
  - 가로 스크롤 + 카드 정보 밀도 재균형 적용

## T034 (P0) Interaction mode policy flag (forbid/interactive)
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - `config.interactionMode` 도입(`forbid | interactive`, default: `interactive`)
  - 런타임 pending action 정책 적용: `forbid`에서는 runtime interactive 액션을 BLOCKED 복구 액션으로 전환
  - 설정 API 및 대시보드 설정 패널에 interaction mode 토글 추가(rollback: `forbid`로 전환)

## T035 (P0) Interactive answer runtime loop + timeline
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - runtime/action prompt 수신 시 `pending_action_shown` timeline 이벤트 기록
  - 사용자 응답 제출 시 `pending_action_submitted` timeline 이벤트 기록(input/actionId/metadata)
  - text/input/confirm 타입 payload 검증 확장(텍스트 응답 제출 지원)
  - 기존 approve/reject/recovery 플로우와 호환 유지

## T036 (P1) Dashboard pending-action input widget 개선
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - pending action 카드에 선택형(select) + 자유입력(input) 응답 위젯 추가
  - 카드 내 `응답 제출`로 action resolve + step resume 경로 연결
  - interaction mode 현재값을 설정 패널에서 즉시 확인/변경 가능
  - 기존 API/기능 로직 변경 없이 UI 폴리시만 반영

## T037 (P0) Schema-first interaction contract normalization
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - runtime interaction 파싱을 `pendingAction/pending_action/action` 스키마 우선 처리로 고정
  - pending action 정규화 계약 강화(`type/prompt/options/metadata/inputMode/validation/createdAt/expiresAt`)
  - 기존 승인/반려/복구 액션 resolve 경로와 동일 정책으로 통합

## T038 (P0) Unknown interaction generic fallback 도입
- 상태: DONE
- 전이: TODO → DOING → DONE
- 결과:
  - 임시 하드코딩(특정 한국어 문구 + 옵션 파싱) 제거
  - 구조화 이벤트 부재 + 사용자 입력 필요 신호 감지 시 generic fallback 생성
  - fallback 스키마: `type=text`, `prompt=응답이 필요합니다.`, `metadata.reason=unknown_interaction`, `inputMode=free_text`
  - 대시보드가 fallback/unknown interaction에 대해 텍스트 입력 제출 UI를 일관 제공
