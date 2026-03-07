# kancli

Terminal-first skill pipeline runner.

## Curl Install (npm 없이)

```bash
curl -fsSL https://raw.githubusercontent.com/currenjin/kancli/main/scripts/install.sh | bash
```

설치 후(프로젝트 폴더에서):

```bash
cd <your-project>
kancli up   # 서버 없으면 자동 기동
kancli init .   # 상대경로 가능, 하위 디렉토리에서 실행해도 git 루트 자동 탐색
kancli board
# 서버 제어
kancli down
kancli restart
# 필요 시 티켓 삭제
kancli delete <ticketId>
```

## Uninstall

```bash
kancli uninstall --yes
# 또는
curl -fsSL https://raw.githubusercontent.com/currenjin/kancli/main/scripts/uninstall.sh | bash
```

## Local Dev (repo에서 직접)

```bash
npm install
npm run dev
npm run kancli -- up
npm run kancli -- status
npm run kancli -- board
```

직접 실행:

```bash
node cli/kancli.js --help
```

## Docker Compose

```bash
docker compose up -d --build
```

접속: <http://localhost:3000>

중지:

```bash
docker compose down
```

## 컨테이너 실행 시 참고

- `./data`에 설정 파일이 저장됩니다 (`devflow-config.json`).
- `../:/workspace`를 마운트해서 DevFlow가 실제 프로젝트를 접근할 수 있게 했습니다.
  - 예: `/workspace/roouty-backend`
- Claude 인증/설정을 사용하려면 `~/.claude:/root/.claude` 마운트를 유지하세요.
- `CLAUDE_BIN` 기본값은 `claude`이며 필요시 compose 환경변수로 변경 가능합니다.

## 수동 실행(로컬)

```bash
npm install
npm run dev
```
