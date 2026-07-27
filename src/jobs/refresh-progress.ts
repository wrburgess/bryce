import type { StatGroup } from "../mlb/client.js";
import type { RefreshTerminalStatus } from "./refresh-run.js";

/**
 * The Refresh **Liveness** stream (ADR 0056, issue #146).
 *
 * `runRefresh` emits typed progress events while it sweeps; turning one into
 * text — and deciding whether to render it at all — belongs solely to the
 * caller. The job never formats a string, never consults `process.stdout`, and
 * never knows whether anyone is listening.
 *
 * Liveness is NOT Accounting (docs/domain/CONTEXT.md): these events are
 * continuous evidence that a Sweep is alive and where it is right now, and are
 * discarded the instant they are read. The durable record of what a Sweep did
 * lives in `refresh_runs` and is read after the fact through `/health` and the
 * MCP `status` tool.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE:
 *
 *  1. A presenter fault is never a sweep fault (ADR 0056 s7). {@link safeEmit}
 *     swallows a throwing sink and defuses a rejected thenable, so a formatting
 *     bug can neither be recorded as a player failure by `runRefresh`'s
 *     per-player catch nor tear the process down as an unhandled rejection.
 *  2. A sink-less caller sees EXACTLY today's behavior. `safeEmit` is a pure
 *     no-op with no sink — never a stderr fallback — so the MCP tool, the REST
 *     route, and the watchlist seed path stay byte-identical. The three
 *     diagnostics that wrote to stderr before #146 go through
 *     {@link emitNotice}, which is the ONLY thing here that can touch a stream,
 *     and only when no sink is attached.
 */

/** A sweep phase that is not per-player work; each brackets its own calls. */
export type RefreshPhase = "calendars" | "ncaa-calendar" | "players";

/**
 * One job-owned external call, with its OWN typed payload keys. A single
 * untyped `detail` string would force a presenter to parse prose to render a
 * stable line; these six variants are the complete job-owned set. The provider
 * clients are deliberately NOT instrumented — they are adapters that know
 * nothing about sweeps, and a sink threaded into them would give the stream a
 * second, provider-shaped source (ADR 0056).
 *
 * Key order in a rendered line follows the DECLARATION order of each variant's
 * payload fields, so the output is stably greppable.
 */
export type RefreshCall =
  | { call: "getSeason"; sportId: number }
  | { call: "getFinalTeamMatches"; teamId: number; season: number }
  | { call: "getBoxScore"; matchId: number }
  | { call: "getPerson"; personId: number }
  | { call: "getTeam"; teamId: number }
  | { call: "getGameLog"; personId: number; sportId: number; statGroup: StatGroup };

/**
 * The declared payload keys of each call, in declaration order (see above).
 *
 * Each entry is typed against ITS OWN variant's payload — not `string[]` — so a
 * renamed field is a COMPILE error rather than a silent `matchId=undefined` in
 * the greppable line. The presenter renders `String(record[key])`, which cannot
 * fail loudly on its own, so the guarantee has to live here in the type
 * (`rules/scripting.md`: a mis-invocation must fail loudly, never pass).
 * `call` itself is excluded — it is rendered by the `call=` key, not a payload field.
 */
type PayloadKeys<C extends RefreshCall["call"]> = Exclude<keyof Extract<RefreshCall, { call: C }>, "call">;

export const REFRESH_CALL_KEYS: { readonly [C in RefreshCall["call"]]: readonly PayloadKeys<C>[] } = {
  getSeason: ["sportId"],
  getFinalTeamMatches: ["teamId", "season"],
  getBoxScore: ["matchId"],
  getPerson: ["personId"],
  getTeam: ["teamId"],
  getGameLog: ["personId", "sportId", "statGroup"],
};

/**
 * Where a Player sits in the sweep, carried EXPLICITLY on every event about him
 * (including his calls) so a presenter never infers association from ordering.
 * `index` is 1-based, so `index/total` reads as an operator expects.
 */
export interface PlayerRef {
  playerId: number;
  /** The stored identity name; a presenter is responsible for folding it to ASCII. */
  name: string;
  index: number;
  total: number;
}

/** The running three-way tally at the moment a Player settled. */
export interface RefreshRunningCounts {
  refreshed: number;
  /** Passed-Over Players — never "skipped" unqualified (docs/domain/CONTEXT.md). */
  passedOver: number;
  failed: number;
}

/**
 * The five early returns of `runRefresh` that abandon a sweep without settling
 * it, named so a presenter can say WHERE liveness stopped. A presenter that only
 * handled "sweep finished" would print nothing on exactly the paths an operator
 * most needs to understand.
 */
export type RefreshSupersededAt = "renew" | "player-fence" | "progress" | "calendar-fence" | "settle";

/**
 * A diagnostic that wrote directly to `process.stderr` before #146. These three
 * bypassed every seam: untestable without capturing global stderr, and no quiet
 * mode could silence them (ADR 0056 s5).
 */
export type RefreshNotice =
  | { code: "ncaa-season-missing"; season: string }
  | { code: "tag-sync-failed"; playerId: number; reason: string }
  | {
      code: "targeted-calendar-failures";
      playerId: number;
      failures: readonly { sportId: number; reason: string }[];
    };

export type RefreshNoticeCode = RefreshNotice["code"];

export type RefreshProgressEvent =
  | { kind: "sweep-started"; runId: number; playersTotal: number; season: string }
  | { kind: "phase-started"; phase: RefreshPhase }
  | { kind: "phase-finished"; phase: RefreshPhase; failures: number }
  | ({ kind: "call-started"; player: PlayerRef | null } & RefreshCall)
  | ({
      kind: "call-finished";
      player: PlayerRef | null;
      elapsedMs: number;
      outcome: "ok" | "error";
      reason?: string;
    } & RefreshCall)
  | { kind: "player-started"; player: PlayerRef }
  | {
      kind: "player-settled";
      player: PlayerRef;
      /**
       * Exactly one classification per completed loop iteration. A `failed`
       * player carries NEITHER `inserted` nor `updated`: `refreshOnePlayer`
       * buffers all HTTP before its single atomic write, so a throw leaves no
       * partial write, and reporting `0` would misread as "wrote nothing"
       * rather than "wrote nothing because it never got there".
       */
      outcome: "refreshed" | "passed-over" | "failed";
      reason?: string;
      inserted?: number;
      updated?: number;
      elapsedMs: number;
      counts: RefreshRunningCounts;
    }
  | { kind: "sweep-superseded"; at: RefreshSupersededAt }
  | { kind: "sweep-skipped"; reason: "offseason-sleep" | "already-running" }
  | ({ kind: "notice" } & RefreshNotice)
  | {
      /**
       * The SAME field set the terminal `refresh done` line already prints, so
       * there is no second terminal-summary contract to keep in step.
       */
      kind: "sweep-finished";
      status: RefreshTerminalStatus;
      playersRefreshed: number;
      playersSkipped: number;
      playersFailed: number;
      playersTotal: number;
      statLinesInserted: number;
      statLinesUpdated: number;
    };

/**
 * Synchronous, `void`, never awaited (ADR 0056 s7). The type forbids returning
 * a promise; {@link safeEmit} additionally defends against one at RUNTIME,
 * because this is JavaScript and a caller outside TypeScript can return
 * anything.
 */
export type RefreshProgressSink = (event: RefreshProgressEvent) => void;

/**
 * Deliver one event to the sink, if any, without ever letting the presenter
 * affect the sweep.
 *
 * A NO-OP when no sink is attached — deliberately not a stderr fallback. Every
 * event flows through here, so a fallback would make the MCP tool, the REST
 * route, and the watchlist seed path start printing full per-player progress to
 * stderr, breaking ADR 0056's byte-identical promise outright.
 */
export function safeEmit(sink: RefreshProgressSink | undefined, event: RefreshProgressEvent): void {
  if (sink === undefined) return;
  try {
    const returned: unknown = sink(event);
    // A `=> void` sink CAN return a thenable at runtime (JS, not TS). Attach a
    // no-op rejection handler WITHOUT awaiting: not awaiting keeps the sweep's
    // timing unchanged, while handling keeps a rejected presenter promise from
    // becoming an unhandled rejection and — under Node's default
    // `--unhandled-rejections=throw` — tearing down a healthy sweep.
    if (typeof (returned as PromiseLike<unknown> | null)?.then === "function") {
      void (returned as PromiseLike<unknown>).then(undefined, () => {
        /* a presenter fault is never a sweep fault */
      });
    }
  } catch {
    /* a presenter fault is never a sweep fault (ADR 0056 s7) */
  }
}

/**
 * The EXACT stderr lines the three notice sites wrote before #146, keyed by
 * code. Two consumers share this one definition so they cannot drift:
 *   - {@link emitNotice}, for a caller with NO sink (MCP, REST, the watchlist
 *     seed path) — those callers must see today's stderr and nothing more;
 *   - the CLI presenter under `--quiet`, because "quiet mode reproduces exactly
 *     today's output" is otherwise false — today these three lines are
 *     unconditional.
 * Newline-free: each consumer owns its own line terminator.
 */
export const LEGACY_NOTICE_TEXT: {
  readonly [C in RefreshNoticeCode]: (notice: Extract<RefreshNotice, { code: C }>) => string;
} = {
  "ncaa-season-missing": (n) =>
    `refresh: no bundled NCAA season lookup for year=${n.season}; ` +
    `NCAA treated as not In Season (update src/ncaa/seasons.ts)`,
  "tag-sync-failed": (n) =>
    `refresh: tag sync failed for player id=${n.playerId} ` +
    `(identity/stats already committed; will heal next refresh): ${n.reason}`,
  "targeted-calendar-failures": (n) =>
    `refresh: ${n.failures.length} calendar fetch(es) failed during single-player ` +
    `refresh of player id=${n.playerId}: ` +
    n.failures.map((f) => `${f.sportId} (${f.reason})`).join("; "),
};

/** Render a notice as the legacy stderr line, without its terminator. */
export function legacyNoticeText(notice: RefreshNotice): string {
  // The map is keyed by code and each entry accepts only its own variant; the
  // cast re-associates them after the discriminant is erased by the lookup.
  const render = LEGACY_NOTICE_TEXT[notice.code] as (n: RefreshNotice) => string;
  return render(notice);
}

/**
 * The ONE place in the job that may touch a stream, and only when no sink is
 * attached. With a sink: a `notice` event, like everything else. Without one:
 * the legacy line, byte-identical to what these sites wrote before #146, so a
 * sink-less caller's stderr is unchanged in both directions — no diagnostic
 * lost, no per-player progress gained.
 */
export function emitNotice(
  deps: { onProgress?: RefreshProgressSink; writeLegacyNotice?: (line: string) => void },
  notice: RefreshNotice,
): void {
  if (deps.onProgress !== undefined) {
    safeEmit(deps.onProgress, { kind: "notice", ...notice });
    return;
  }
  const write = deps.writeLegacyNotice ?? ((line: string) => process.stderr.write(line));
  write(`${legacyNoticeText(notice)}\n`);
}
