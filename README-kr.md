# kancli

터미널 중심 스킬 파이프라인 러너.

## 설치 (curl only)

```bash
curl -fsSL https://raw.githubusercontent.com/currenjin/kancli/main/scripts/install.sh | bash
```

설치 후 `~/.local/bin` 이 PATH에 없다면:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

---

## 실제 사용법

### 1) 프로젝트로 이동

```bash
cd <your-project>
```

### 2) 서버 시작

```bash
kancli up
```

- 서버가 이미 실행 중이면 상태만 출력
- 서버가 없으면 자동 기동

### 3) 스킬 스캔 + 파이프라인 설정

```bash
kancli init .
```

`init` 인터랙션 키:
- `↑/↓` : 이동
- `←/→` : 순서 변경
- `Space` : 선택/해제
- `Enter` : 저장
- `q` : 취소

감지된 스킬을 자동 전체 선택하려면:

```bash
kancli init . --auto
```

### 4) 보드 보기

```bash
kancli board
```

### 5) 티켓 추가

```bash
kancli add RP-5336
```

### 6) 질문/대기 액션 응답

```bash
kancli answer <ticketId> go
# 예: kancli answer 12 go
```

텍스트 응답도 가능:

```bash
kancli answer <ticketId> "이 방식으로 진행해"
```

### 7) 단계 이동/중지/삭제

```bash
kancli next <ticketId>
kancli stop <ticketId>
kancli delete <ticketId>
```

### 8) 상태 확인

```bash
kancli status
kancli pending   # 어떤 입력(actionId)이 필요한지 표시
```

### 9) 서버 종료/재시작

```bash
kancli down
kancli restart
```

---

## 삭제 (curl only)

```bash
curl -fsSL https://raw.githubusercontent.com/currenjin/kancli/main/scripts/uninstall.sh | bash
```

---

## 문제 해결

### `fetch failed (localhost:3000 unreachable)`

```bash
kancli up
```

### 스킬이 감지되지 않을 때

```bash
kancli init .
```

- `kancli init .`는 git 루트를 자동 탐색함
- 그래도 비어 있으면 프로젝트 루트에서 다시 실행
