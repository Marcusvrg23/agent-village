# V1 validation — 2026-09-30

Baseline preserved in `e3c1f4e`; Web V1 checkpoint `95835db`. The final desktop commit is available through `git log -1`.

## Results

| Gate | Result | Evidence |
| --- | --- | --- |
| Original V0 | PASS | Original normalizer, watcher, stylesheet, reference WebP and both original test files have no diff against baseline. |
| Suite | PASS | 27/27 tests: all 14 original tests plus 13 delta tests. |
| Agent registry | PASS | Metadata, paths, operational role fallback, generic unknowns and pseudonymized public IDs. |
| Parent / child | PASS | Nested ancestry and cycle rejection in tests; parent and Reviewer child found in existing real recording. |
| Communication | PASS | Existing real recording produced three Lead → Reviewer message links. Raw message content was suppressed. Missing endpoints produce no guessed arrows. Other directions are covered by delta tests, not claimed as live observations. |
| Live states / details | PASS | Five clickable stations; detail displays real state, tools, timeline and usage. Old activity does not count toward fresh active-agent budget. |
| Usage | PASS | Actual input/cached/output/total counters observed. Missing fields remain N/A. Cumulative events replace snapshots, not sum them. |
| Budget | PASS | Advisory default 3, truthful observed count, over-limit indicator; no agent control. |
| Web | PASS | Official reference rendered; PROJECT codex agents, LIVE, 27 passed visible. |
| SSE reconnect | PASS | Stopped/restarted only the Ops Room backend; UI changed LIVE → RECONNECTING → LIVE. Browser performance.timeOrigin remained 1790750417322.7 (no page reload). |
| Console | PASS | Browser errors empty; packaged application consoleErrors empty. |
| Electron Windows | PASS | Actual packaged executable launched and exited smoke test with code 0. |
| Packaged source | PASS | All 11 runtime source/asset files byte-identical to workspace. Runtime manifest identity/version/type/main agree (dev fields removed by packaging). |
| Read only | PASS | Rollout file handles use only `open(..., 'r')`; registry replay uses read streams. No session writer, model call, agent-control endpoint or external telemetry added. |
| Localhost | PASS | Web listener 127.0.0.1:4173; desktop smoke listener 127.0.0.1:55124. Desktop listener closed on smoke exit. |

## Packaged smoke evidence

Executable: `release/Codex Ops Room-win32-x64/Codex Ops Room.exe`.

Report: `.tmp/electron-final-smoke/electron-smoke.json`.

Screenshot: `.tmp/electron-final-smoke/electron-smoke.png`.

Verified: `packaged=true`, `connection=LIVE`, `imageLoaded=true`, `project=codex agents`, `agentButtons=5`, `hasNode=false`, `watcher=true`, `readOnly=true`, one real agent identified, 29 recognized events at capture, no console errors.

Selected source at capture: `rollout-2026-09-22T19-27-21-01a0cb3b-0f4e-7a60-abb5-ed50b8ecfbf0.jsonl`.

Real-recording delta verification: `rollout-2026-09-22T19-51-54-01a0cb51-8961-7673-891e-d0b03632d2cc.jsonl`, 268 lines replayed read-only. No new Codex agents were created for validation.

Final application archive SHA-256: `93B2065C38E46D51731F092F1D880999B4D0835FE45218AD42B77019920F945B`.

## Limits

This remains a read-only observer of the most recently active rollout, not a controller or a complete simultaneous capture of every child session. Unobserved child tools/usage are N/A; family totals state their coverage. Communication animations require recent timestamped endpoints. The Windows distribution is an unsigned portable folder: retain all files beside the executable. No push or deployment was performed.
