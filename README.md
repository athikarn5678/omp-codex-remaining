# Codex Remaining for Oh My Pi

An unofficial **Oh My Pi (OMP)** extension showing **remaining OpenAI Codex quota** below the editor.

## Features

- **Compact:** 5h/7d remaining percentages, reset countdowns, plan, and reset credits.
- **Bars (default):** two colored progress bars with reset date/time in your local timezone.
- Five colors: 0–20% red, 21–40% orange, 41–60% yellow, 61–80% lime, 81–100% green.
- Automatically refreshes usage every 5 minutes, countdowns every 30 seconds; retries failures after 1 minute and marks cached data as stale.
- Tab completion for every command, with descriptive options; remembers the selected layout.
- **Native Right Arrow chaining (v0.1.6):** choosing `updates`, `alerts`, or `alerts threshold` opens its nested menu automatically in OMP 18.8.8, without pressing Tab again.
- **Update notifications (v0.1.4+):** checks public npm metadata at most once per 24 hours, notifies once per new version, never auto-upgrades. Can be disabled.
- **Low quota alerts (v0.1.5):** alerts when Codex 5h or 7d remaining quota falls to 20% (warning) or 10% (critical). Each alert level is shown only once per reset window; choose a warning threshold or disable alerts.
- Uses local `omp usage` (no separate API key).

## Requirements

**OMP 18.8.7+**, an OpenAI Codex account already connected to OMP, and an active `openai-codex` model. The `omp` command must be available on PATH or discoverable as the running executable. Verified locally on Windows OMP 18.8.8 (including Editor key handling for Tab/Right Arrow); the GitHub Actions matrix is configured for Windows, macOS, and Linux, but passing CI does not replace real TUI testing on each OS.

## Install

**Install from the npm registry:**

```sh
omp plugin install omp-codex-remaining
```

**npm package:** [`omp-codex-remaining`](https://www.npmjs.com/package/omp-codex-remaining). Alternatively, download [codex-remaining.ts](./codex-remaining.ts) into `~/.omp/agent/extensions/` and restart OMP.

Once installed, restart OMP or use `/reload`. No manual `config.yml` registration is needed for a standard npm plugin installation.

### Update

When a new version is published to npm, run:

```sh
omp plugin upgrade omp-codex-remaining
```

Restart OMP (or use `/reload`) after upgrading. You can check the installed version with `omp plugin list`.

**Update notifications (v0.1.4):** The extension checks public npm release metadata on startup and at most once per 24 hours afterward. A checked-at timestamp and last-notified version are saved alongside your display preference, to avoid repeated checks or duplicate notices across restarts. If a newer version exists, OMP shows the version and the manual upgrade command. Nothing installs automatically. No API key, OAuth token, or model usage is sent to npm; the network request only retrieves public package metadata. Automatic checks are on by default and can be turned off at any time using `/codex-remaining updates off`. A network failure will not interrupt quota display; manual checks show a warning.

### Uninstall

```sh
omp plugin uninstall omp-codex-remaining
```

Restart OMP afterward. The saved layout preference is stored separately in `codex-remaining-settings.json` and can be deleted manually if you want to reset it.

**Migrating from the standalone extension:** after confirming the npm install succeeded, move or delete the old copy from `~/.omp/agent/extensions/`. If you previously added that standalone path to `config.yml` under `extensions:`, remove only that entry, then restart OMP. Keeping both copies may register duplicate commands/widgets.

## Commands

| Command | Action |
| --- | --- |
| `/codex-remaining compact` | One-line display without bars |
| `/codex-remaining bars` | Two progress bars (default) |
| `/codex-remaining toggle` | Switch layouts |
| `/codex-remaining` | Open the interactive command help |
| `/codex-remaining help` | Open the same command help |
| `/codex-remaining refresh` | Force-refresh Codex usage now |
| `/codex-remaining updates` | Show update notification settings |
| `/codex-remaining updates on` | Enable daily npm update notifications |
| `/codex-remaining updates off` | Disable automatic npm update checks |
| `/codex-remaining updates check` | Check for a newer npm version now, even when automatic checks are off |
| `/codex-remaining alerts` | Show quota-alert settings |
| `/codex-remaining alerts on` | Enable low quota alerts (default) |
| `/codex-remaining alerts off` | Disable low quota alerts |
| `/codex-remaining alerts threshold 20` | Set warning threshold to 10–90% (critical remains at 10%) |

The Help screen lists the commands, current layout and automatic refresh schedule. Close it with **Enter**, **Esc** or **q**. Opening Help does not fetch new quota data.

**Tab autocomplete:** Type `/codex-remaining` and press **Tab** to open all seven subcommands (`help`, `compact`, `bars`, `toggle`, `refresh`, `updates`, `alerts`) with a description beside each option. Select a command from the list and press Enter to run it. Autocomplete also works after a space, for example `/codex-remaining ` + Tab, and filters as you type (e.g. `/codex-remaining re` + Tab). **v0.1.6 nested menus:** On OMP 18.8.8, selecting `updates` using **Right Arrow or Tab** automatically opens `on`, `off`, `check` without an extra Tab. Selecting `alerts` automatically opens `on`, `off`, `threshold`; selecting `threshold` opens common percentage presets. The right arrow accepts a popup selection only when the caret is at the end of the input; otherwise it moves the caret normally. You can also type a custom integer from 10 to 90.

Layout, npm update checks, and low-quota alerts are saved automatically to `codex-remaining-settings.json` under the directory returned by `omp config path`.

## Low quota notifications

The default warning level is **20% remaining**, with a separate **critical level at 10%** for both Codex 5-hour and 7-day quotas. Alerts use the most recently successfully fetched quota data; failed or stale fetches do not trigger new alerts. A message for a given level and reset window is not repeated across refreshes or restarts. If quota recovers above the warning threshold, or a new quota reset period begins, warnings can be triggered again.

Use `/codex-remaining alerts off` to disable automatic warnings, `alerts on` to re-enable, or `alerts threshold 15` to set a 15% warning threshold. The critical level remains at 10%. These preferences are saved in `codex-remaining-settings.json`. The extension does not request separate API keys or change your OMP configuration.

## Native status-line behavior

**v0.1.3 never modifies OMP `config.yml` or built-in status-line settings.** If a custom OMP status line already contains the native `usage` segment, the extension displays a warning and **pauses its own widget** to avoid duplicate quota displays. Your original status line keeps working.

If you want the Codex Remaining widget instead, explicitly inspect `omp config get statusLine.leftSegments` and `omp config get statusLine.rightSegments`. Remove only the `usage` segment from your own custom status-line configuration, preserving every other segment, then restart OMP. This is optional and **may hide native usage for other model providers**. Standard OMP status-line presets are untouched.

## Troubleshooting

- Select an `openai-codex` model for the widget to appear.
- Check `omp usage --provider openai-codex --json --redact` if no quota appears.
- Check `omp --version` if the extension cannot find the OMP executable.
- A yellow `quota unavailable` status means the last fetch failed; the extension retries automatically in 1 minute. `stale quota` means it is showing the last successful values, **not live quotas**.
- A failed `/codex-remaining refresh` shows a warning rather than reporting false success.
- If the widget is paused due to the custom native `usage` segment, review the read-only instructions above; the extension will not edit your configuration.

## Testing

With Bun installed, run `bun run test` from this repository to check Help/Autocomplete, quota rendering, refresh failures/retries, read-only configuration behavior, update settings migration, version comparison, npm failure handling, nested Tab routing through OMP's forced-completion path, Right Arrow chaining-marker handling, and quota alert thresholds/duplication/recovery. Run `bun run build:check` to validate the bundle, and `npm pack --dry-run` to validate package contents. GitHub Actions runs these checks on Windows, macOS, and Linux. Tests are included in GitHub but excluded from the published npm tarball.

## License

[MIT](./LICENSE), copyright 2026 Athikarn. Maintained by **Athikarn** ([npm profile](https://www.npmjs.com/~athikarn5678)). Unofficial and not affiliated with OpenAI or Oh My Pi.
