# DevFlow

Claude Code skill pipeline runner.

## Docker Compose (권장)

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
