# Codex Remaining

An unofficial Oh My Pi extension that shows remaining OpenAI Codex quota in the terminal.

## Features

Compact and Bars layouts; 5h and 7d remaining quota; five color levels; reset dates and countdowns; reset credits; Tab completions; automatic refresh.

## Install

Requires OMP 18.8.6+ and a connected Codex account. Download `codex-remaining.ts` to `~/.omp/agent/extensions/` and restart OMP. No separate API key is needed.

Windows CMD:

```cmd
curl.exe -fL https://raw.githubusercontent.com/67070194/omp-codex-remaining/main/codex-remaining.ts -o "%USERPROFILE%\.omp\agent\extensions\codex-remaining.ts"
```

macOS/Linux:

```bash
mkdir -p ~/.omp/agent/extensions
curl -fLsS https://raw.githubusercontent.com/67070194/omp-codex-remaining/main/codex-remaining.ts -o ~/.omp/agent/extensions/codex-remaining.ts
```

## Commands

- `/codex-remaining compact` — single-line display
- `/codex-remaining bars` — bars and reset dates (default)
- `/codex-remaining toggle` — switch layouts
- `/codex-remaining` or `/codex-remaining refresh` — refresh quota

Type `/codex-remaining ` with a space, then Tab, to choose a layout.

## Configuration warning

If your custom native OMP status line includes `usage`, the extension backs up `config.yml`, removes just that segment from the custom status line, and asks for one OMP restart. This can affect native usage display for other providers. Standard presets are unchanged. Layout settings are saved automatically.

## Compatibility

Tested on Windows OMP 18.8.6. macOS/Linux support has not been verified on real devices. Requires OMP on PATH or discoverable as the running executable. The widget appears only for an `openai-codex` model and reads from `omp usage`.

## License

MIT. Copyright 2026 67070194.

Unofficial project, not affiliated with OpenAI or Oh My Pi maintainers.
