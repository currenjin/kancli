# DevFlow Agnostic v1

## 목표

DevFlow를 `jira-to-plan → augmented-coding` 전용 흐름에서 분리하고, **런타임에서 동적으로 상호작용을 처리하는 skill-agnostic 파이프라인 실행기**로 전환한다.

핵심 사용자 가치:
- 스킬 이름 하드코딩 없이 다양한 파이프라인 실행
- 단계별 사용자 입력(Action) 요청을 UI에서 동적으로 처리
- 스킬 출력물(artifact)을 공통 형태로 누적/검토
- 기존 단순 흐름(augmented-coding go/commit/refactor, plan 검토)과 최대한 호환

## 아키텍처 변경

## 1) 상태 모델 통일

기존 상태(`awaiting-action`, `review-plan`)를 일반화하여 아래 상태를 사용한다.

- `queued`: 실행 대기
- `running`: 실행 중
- `awaiting_input`: 사용자 입력 필요
- `review`: 결과 확인 필요
- `blocked`: 오류/중단 등으로 진행 불가
- `done`: 파이프라인 완료
- `halted`: 사용자 의도 중지

호환성 확보를 위해 프론트는 구 상태 문자열도 렌더링 가능하게 유지한다.

## 2) pendingAction 공통 모델

티켓 상태에 `pendingAction` 필드를 도입한다.

```json
{
  "type": "selection",
  "prompt": "다음 실행 액션을 선택하세요.",
  "options": [
    { "id": "go", "label": "go", "payload": { "action": "go" } }
  ],
  "metadata": { "source": "compat.augmented-coding" }
}
```

- `type`: 입력 형태(선택, 텍스트 입력 등)
- `prompt`: 사용자에게 보여줄 메시지
- `options`: 선택 가능한 액션
- `metadata`: 실행 맥락/디버깅 정보

## 3) API 일반화

신규 일반화 액션 처리 API:
- `POST /api/tickets/:id/actions/resolve`

요청 예시:
```json
{ "actionId": "go" }
```

동작:
- 현재 `pendingAction` 기준으로 option 매칭
- payload 기반 분기(`advance`, `rerunCurrentStep`, `halt` 등)
- 일반적으로는 선택 정보를 런타임 프롬프트로 주입해 현재 스텝 재실행

하위 호환:
- `POST /api/tickets/:id/action` 유지 (내부에서 resolve 로직으로 위임)
- `/skip-plan`, `/rerun-plan`도 wrapper로 유지

## 4) 스트림 파싱 일반화

`stream-json` 이벤트에서 다음을 공통 처리한다.

- 텍스트/툴 로그 (`assistant`, `user`, `tool_use`, `tool_result`)
- action 관련 블록/이벤트 (`pending_action`, `action_request`, `action`)
- 산출물 블록/이벤트 (`artifact`, `output_file`, `file`)

이벤트 형태가 달라도 `resolveEventPendingAction`, `resolveEventArtifact`에서 유사 키를 흡수해 저장한다.

## 5) 아티팩트 저장 모델

티켓에 `artifacts[]` 누적:

```json
{
  "type": "plan",
  "name": "RP-5316-plan.md",
  "path": "...",
  "contentType": "text/markdown",
  "metadata": { "generatedBy": "jira-to-plan" },
  "createdAt": 0
}
```

## 6) UI 동적 액션 렌더링

기존 `augmented-coding` 전용 버튼 하드코딩을 제거하고,
`ticket.pendingAction.options`를 기반으로 동적 버튼 렌더링:
- 버튼 클릭 시 `/actions/resolve` 호출
- 상태가 `awaiting_input`/`blocked`일 때 pending action 박스 표시

동시에 `artifacts` 패널을 추가해 최근 산출물을 모든 스텝에서 공통 노출한다.

## 하위 호환 전략

- augmented-coding에서 runtime action 이벤트가 오지 않더라도, 서버에서 compat `pendingAction(go/commit/refactor/advance)`를 생성
- 기존 엔드포인트(`/action`, `/skip-plan`, `/rerun-plan`) 유지
- 프론트에서 legacy 상태 문자열도 배지/프로그레스로 해석

## 수용 기준 (Acceptance Criteria)

1. **Skill-agnostic 상태 전환**
   - 특정 스킬 이름에 의존하지 않고 `queued/running/awaiting_input/review/blocked/done/halted`로 동작한다.

2. **Runtime-dynamic interaction**
   - `pendingAction`이 존재하면 UI가 동적으로 옵션을 렌더링하고 resolve API로 처리한다.

3. **Generic parsing/storage**
   - 스트림 이벤트에서 generic action/artifact/log를 파싱해 티켓 상태에 누적한다.

4. **Artifact visibility**
   - 모든 스텝 출력물을 Artifact 패널에서 확인할 수 있다.

5. **Backward compatibility**
   - 기존 augmented-coding 단순 사용(go/commit/refactor)과 plan skip/rerun 흐름이 깨지지 않는다.

6. **API compatibility + extensibility**
   - 신규 일반 API(`/actions/resolve`)와 기존 호환 API가 공존한다.

## Known Limitations / 다음 단계

- `allowedTools`는 현재 env(`DEVFLOW_ALLOWED_TOOLS`)로 전달되며 실행 옵션에 직접 반영되지는 않음(향후 CLAUDE CLI 옵션 연동 필요)
- pendingAction의 입력 타입(`text`, `form`) UI는 현재 기본 selection 중심. 다음 버전에서 form renderer 확장 예정
- artifact 상세 미리보기(파일 열람/다운로드)는 v2 범위
