# Codex throughput in the bottom status bar

The default `pi-live-throughput` display is compact footer status:

```text
📁 harness-space ● GPT-6.1 Sol 272k medium 18k ● momentum ~47.6 TPS ● cumulative 48.2 TPS ● cache hit 98.6% ● session input 120.2k
```

Only four extra fields are shown. `pi-statusline` appends them to its existing
footer through `FooterDataProvider.getExtensionStatuses()`. Fields and separators
use the same terminal gray (palette 8) as the existing status command. Output updates do
not re-run the external status command. Narrow panes wrap between fields so the
last metric is not silently lost. The widget above the editor is disabled by
default; `/throughput off|on|status|widget` remains available.

- `momentum`: the latest measured output rate over approximately three seconds.
  It holds while no new output is received. `~` means estimated: Codex normally
  reports native usage only at completion. Live deltas use four characters per
  token; on completion the last window is rescaled to the final native count.
  Individual chunk token counts remain unavailable, so momentum retains `~`.
- `cumulative`: total native non-reasoning output tokens / total measured stream
  seconds, for successful validated responses of the selected model since the
  extension loaded. Models are kept separate. It is not the arithmetic mean
  of request TPS. Session switch, `/reload` and `/throughput reset` clear this
  measurement pool because historical sessions lack the required timestamps.
- `cache hit`: cached input / complete input for the latest response with known
  usage, as a percentage. `0.0%` is a valid confirmed miss; `-` is unavailable.
- `session input`: sum of complete request inputs in the entire session,
  including cache reads and writes, all stored branches and pre-compaction
  entries. It is restored from usage metadata on `/reload` and session resume.
  It includes all models, counts repeated prompt processing on each request,
  and is independent of current context occupancy. New sessions start at zero.

Codex final samples use `output_tokens - reasoning_tokens`. The measured span
runs from the first to last nonempty text/tool-argument delta of the same
response. TTFT, hidden reasoning before output, tool execution after the
response, and the terminal tail are excluded. Pauses between deltas are included
when the stream resumes. No render timer invents a zero-rate observation.
Reasoning summaries are not counted as visible output. Native counts can include
framing; the complete first chunk is in the numerator although timing begins
at its receipt. A coalesced stream with only one timestamp has no usable rate.

The plugin timestamps `provider_stream_event` with monotonic `performance.now()`
before Pi normalization. This observes client delivery after SSE/WebSocket
parsing and any earlier extension handlers. The standalone benchmark timestamps
earlier, at HTTP body reads. Neither reveals server per-token decode timing.
IDs, sequence numbers, streamed/native/SDK text and native usage are checked.
Failed/incomplete/unverifiable responses and unsupported hosted output types
are excluded from the cumulative TPS; their known input usage still contributes
to session input. No content, authentication or request settings are changed.

Source payloads live in `patches/pi-live-throughput/`. Installation and
`update.sh` preserve them with the idempotent, hash-guarded patches
`fix-pi-live-throughput-codex.mjs` and `fix-pi-statusline-throughput.mjs`.
The reviewed compact-display variant on the second host is also supported.
Unrecognized local/upstream changes are not overwritten.

```bash
node tests/codex-throughput.mjs
node tests/codex-throughput-extension.mjs
# Optional replay of existing synthetic benchmark artifacts:
node tests/codex-throughput.mjs /path/to/mac/result /path/to/brother/result
```

Offline verification uses the installed Pi loader and native Codex SSE parser,
a local mock response, generated dummy JWT and fake UI. Tests cover reasoning
subtraction, held rates, weighted/model means, IDs/text/sequence, WebSocket
ordering, tool arguments, history/cache input totals, compact footer updates,
wrapping, reset and both patch guards. New model calls are never made.

The four validated synthetic API streams from 6 October 2026 replayed as
57.112842 / 50.366843 and 52.869227 / 54.063208 TPS. At their saved timestamps,
the calculations match the standalone benchmark within 1e-9 TPS.

After installation, run `/reload` in already-open Pi sessions.
