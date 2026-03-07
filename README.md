# kancli

Terminal-first skill pipeline runner (`kancli`, alias `kc`).

## Install (curl only)

```bash
curl -fsSL https://raw.githubusercontent.com/currenjin/kancli/main/scripts/install.sh | bash
```

Installer creates two commands:
- `kancli` (primary)
- `kc` (short alias, same behavior)

If `kc` already exists and is not kancli-managed, installer keeps it untouched and prints a conflict note.

If `~/.local/bin` is not in your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

---

## Practical Usage

### 1) Move into your project

```bash
cd <your-project>
```

### 2) Start the server

```bash
kc up
# or: kancli up
```

- If a server is already running, it prints status.
- If no server is running, it starts one automatically.

### 3) Scan skills + configure pipeline

```bash
kc init .
# or: kancli init .
```

`init` interactive keys:
- `↑/↓`: move cursor
- `←/→`: reorder
- `Space`: select/unselect
- `Enter`: save
- `q`: cancel

To auto-select all detected skills:

```bash
kancli init . --auto
```

### 4) Open live board view

```bash
kc board
# or: kancli board
```

`board` stays open and updates in real-time (SSE + periodic refresh fallback).

Live board keys:
- `↑/↓`: move pending question cursor
- `1..9`: jump to pending question
- `Enter`: open/submit answer panel
- Selection prompt: `↑/↓` or number + `Enter`
- Text prompt: type + `Enter`
- `Esc`: cancel current answer panel
- `r`: manual refresh
- `q` / `Ctrl+C`: clean exit

### 5) Add a ticket

```bash
kancli add RP-5336
```

### 6) Answer pending questions/actions

```bash
kancli answer <ticketId> go
# example: kancli answer 12 go
```

You can also send text input:

```bash
kancli answer <ticketId> "continue with this approach"
```

### 7) Move/stop/delete a ticket

```bash
kancli next <ticketId>
kancli stop <ticketId>
kancli delete <ticketId>
```

### 8) Check runtime status

```bash
kancli status
kancli pending   # show pending prompts/options for fallback answering
```

### 9) Stop/restart server

```bash
kancli down
kancli restart
```

---

## Uninstall (curl only)

```bash
curl -fsSL https://raw.githubusercontent.com/currenjin/kancli/main/scripts/uninstall.sh | bash
```

---

## Troubleshooting

### `fetch failed (localhost:3000 unreachable)`

```bash
kancli up
```

### No skills detected

```bash
kancli init .
```

- `kancli init .` resolves to your git root automatically.
- If still empty, run from your project root and try again.
