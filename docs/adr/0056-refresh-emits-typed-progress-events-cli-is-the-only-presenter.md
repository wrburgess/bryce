# Refresh emits typed progress events; a presenter is the only thing that renders them

**Status:** accepted — decided in `/distill` for #146; implementation pending.

`src/cli/refresh.ts` is documented as *"a thin presenter over `runRefresh`"*, and until now that was
literally true: the job returned a `RefreshSummary` and the CLI printed one line at the end. Issue
#146 requires **live** console output during the sweep — the operator must be able to tell a stuck
run from a slow one — which means `runRefresh` has to emit *while it runs*. It emits **typed
progress events**; turning an event into text, and deciding whether to render it at all, belongs
solely to the caller.

The distinction this ADR fixes is between **liveness** and **accounting** (see
[`docs/domain/CONTEXT.md`](../domain/CONTEXT.md)). ADR 0043 built accounting — the durable
`refresh_runs` counters behind `GET /health` and the MCP `status` tool — and it works exactly as
designed. It was never liveness, and #146's report that "the progress path does not work" is that gap,
not a defect in ADR 0043: the counters were correct and simply had no observer at the terminal.

## Considered Options

- **A typed event stream with the caller as sole presenter (chosen).** `RefreshDeps` gains an
  optional sink that receives discriminated-union events (player started, external call completed
  with its elapsed time, player settled with its outcome, phase boundaries). The job never formats a
  string, never consults `process.stdout`, and never knows whether anyone is listening.
- **An injected line writer**, mirroring `src/jobs/digest.ts:150`'s `warn ?? (m) => process.stderr.write(…)`.
  Rejected on three counts: (1) the TTY-only elapsed-time indicator cannot be rendered in place by a
  job that does not know stdout is a terminal, and must not learn; (2) quiet mode would become a
  *job* parameter, so the job decides how loud to be and today's single-line output becomes a second
  code path that can drift from the rich one; (3) the printed counter and `updateRefreshRunProgress`
  would be two independently maintained counters — exactly the "two progress mechanisms that can
  disagree" #146 names as worse than one.
- **An `EventEmitter` or async-generator `runRefresh`.** Rejected: `runRefresh` has three production
  callers — `src/cli/refresh.ts:34`, the MCP `refresh` tool (`src/mcp/server.ts:408`), and
  `src/api/routes.ts:457`. An optional sink leaves the latter two byte-identical; restructuring the
  return type would force all three plus the whole of `test/refresh.test.ts` to change for no gain
  over a callback that takes a typed value.

## Consequences

1. **One emitter, many presenters.** The console formatter is one consumer of the event stream, not
   a privileged one. The MCP tool and the REST route pass no sink and behave exactly as they do
   today; nothing about their output changes as a side effect of this work.

2. **Agreement between the console and `/health` is structural, not clerical.** The printed counter
   and the `updateRefreshRunProgress` write derive from the same events, so #146's "console counts
   and `/health` counts agree for the same run" is satisfied by construction rather than by two
   counters kept in step by hand.

3. **Verbosity is a presenter concern.** The job always emits; quiet mode is the presenter dropping
   everything except the terminal summary. That is why quiet mode can reproduce today's output
   exactly — it is the *same* summary path, not a reimplementation of it.

4. **TTY behavior lives entirely in the presenter.** Cursor control, in-place redraws, and elapsed-time
   indicators are chosen by the thing holding the file descriptor. The non-TTY path is the same event
   stream rendered as append-only lines, which is why "piping to a file yields clean, greppable lines
   with no control characters" needs no separate code path. The two paths differ in how they make a
   **hang** visible, and that difference is also purely presentational: on a TTY the elapsed-time
   indicator ticks in place, while the piped path — where an outstanding call would otherwise write
   nothing at all and a stall would be indistinguishable from truncation — emits a periodic
   `still waiting` line past a threshold. Neither is a new event kind.

5. **Three hardcoded `process.stderr.write` calls inside the job become events.**
   `src/jobs/refresh.ts:535` (no bundled NCAA season lookup), `:857`, and `:1048` currently bypass
   every seam: they are untestable without capturing global stderr, and no quiet mode could ever
   silence them. Folding them into the event stream is the point of the seam, not incidental cleanup.

6. **Identity in the stream is folded to ASCII, and [ADR 0047](0047-app-clis-emit-utf8-ascii-scopes-to-machine-output.md)
   is amended to say so.** That ADR classified `refresh` as having "no identity field"; a per-Player
   stream makes that false. The row moves into `players:batch-add`'s class — folded and
   forgery-proofed via `asciiField()` — because the presenter drives cursor control, and an ANSI
   escape surviving in an upstream name (`canonicalizeName` collapses `\s+`, which does not cover
   `\x1b`) could otherwise overwrite lines the presenter already printed.

7. **The job gains a dependency it must not abuse.** An optional sink inside `runRefresh` is an
   invitation to reach for it as a logging channel. It carries *events about the sweep*, never
   diagnostics of convenience, and it is never awaited — a slow or throwing presenter must not be able
   to stall or fail a sweep that is otherwise healthy.
