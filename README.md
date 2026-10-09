# Codex Remaining for Oh My Pi

An unofficial **Oh My Pi (OMP)** extension showing **remaining OpenAI Codex quota** below the editor.

## Features

- **Compact:** 5h/7d remaining percentages, reset countdowns, plan, and reset credits.
- **Bars (default):** two colored progress bars with reset date/time in your local timezone.
- Five colors: 0–20% red, 21–40% orange, 41–60% yellow, 61–80% lime, 81–100% green.
- Automatically refreshes usage every 5 minutes, countdowns every 30 seconds.
- Tab completion for layouts; remembers the selected layout.
- Uses local `omp usage` (no separate API key).

## Requirements

**OMP 18.8.6+**, an OpenAI Codex account already connected to OMP, and an active `openai-codex` model. The `omp` command must be available on PATH or discoverable as the running executable. Tested on Windows OMP 18.8.6; real macOS/Linux testing is pending.

## Install with npm

**Install from the npm registry:**

```sh
omp plugin install omp-codex-remaining
```

**Published on npm:** [`omp-codex-remaining`](https://www.npmjs.com/package/omp-codex-remaining) (current initial release `0.1.0`). As an alternative, manually download [codex-remaining.ts](./codex-remaining.ts) into `~/.omp/agent/extensions/` and restart OMP.

Once installed, restart OMP or use `/reload`. No manual `config.yml` registration is needed for a standard npm plugin installation.

**Migrating from the standalone extension:** after confirming the npm install succeeded, move or delete the old copy from `~/.omp/agent/extensions/`. If you previously added that standalone path to `config.yml` under `extensions:`, remove only that entry, then restart OMP. Keeping both copies may register duplicate commands/widgets.

## Commands

| Command | Action |
| --- | --- |
| `/codex-remaining compact` | One-line display without bars |
| `/codex-remaining bars` | Two progress bars (default) |
| `/codex-remaining toggle` | Switch layouts |
| `/codex-remaining` | Force-refresh |
| `/codex-remaining refresh` | Force-refresh |

Type `/codex-remaining ` (with a trailing space) and press Tab to select `compact` or `bars`.

The layout preference is saved automatically to `codex-remaining-settings.json` under the directory returned by `omp config path`.

## Native status-line behavior

If a **custom** OMP status line contains the built-in `usage` segment, the extension makes a dated `config.yml` backup, removes only that `usage` segment from custom left/right segment lists, then asks you to restart OMP. If backup or verification fails, the widget pauses instead of overwriting configuration.

**Important:** removing native `usage` may also hide usage for other model providers. Restore the segment manually or restore the backup if needed. Standard OMP status-line presets are untouched.

## Troubleshooting

- Select an `openai-codex` model for the widget to appear.
- Check `omp usage --provider openai-codex --json --redact` if no quota appears.
- Check `omp --version` if the extension cannot find the OMP executable.
- Restart OMP once after an automatic custom status-line change.

## Update / uninstall

```sh
omp plugin upgrade omp-codex-remaining
omp plugin uninstall omp-codex-remaining
```

## License

[MIT](./LICENSE), copyright 2026 67070194. Unofficial and not affiliated with OpenAI or Oh My Pi.
