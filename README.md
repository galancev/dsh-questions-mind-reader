# dsh-mind-questions

Bubbles for the questions a model leaves unasked inside its reasoning.

The Host half reads `agent/assistant-stream` reasoning deltas, keeps the questions that look blocking, and exposes them on two loopback routes. The Client half registers into the root slot `shell.overlay` and draws bubbles above the composer. An answer goes back through `sessionController.prompt({ mode: 'steer' })`, so it reaches the model at the next step boundary without interrupting the current one.

No whale widget, no injected script, no settings panel, no disk state.

## Install

```powershell
dsh plugin --profile desktop add link:C:\Users\galan\Projects\dsh-questions-mind-reader
```

Restart DeepSeek Harness afterwards: the Host half is read at startup, the Client module reloads with the page.

## Config

`cordis.patch.yml` of the bundle:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Draw bubbles |
| `markers` | `true` | Ask the model to mark its own questions with `[[ask]]…[[/ask]]` |
| `heuristics` | `true` | Also detect questions from prose |
| `maxBubbles` | `3` | Bubbles at once, 1–9 |
| `ttlSec` | `60` | Auto-hide delay; `0` disables it |
| `gutterPx` | `160` | Empty strip reserved on the right of the chat area, px; `0` disables it |
| `translateQuestions` | `true` | Translate a foreign question through `ctx.translator` |
| `targetLang` | `ru` | Target language of that translation |

## Test

```powershell
node --test test/
```

## Layout

- `index.js` — Host plugin: stream subscription, marker/heuristic detection state, `/dsh-mq/state`, `/dsh-mq/answer`, and the loopback-only `/dsh-mq/debug` dump used while tuning detection.
- `lib/detect.js` — pure detection: markers, sentence stream, language heuristics, dedupe.
- `client.js` — Client module: `shell.overlay` bubbles, one answer editor, route polling.
