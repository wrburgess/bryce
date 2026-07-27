/**
 * The Player Card's Presentation/Export `format` vocabulary.
 *
 * Deliberately its own DEPENDENCY-FREE module. `src/cli/router.ts` derives its
 * `--format` value list from here so the accepted flag values cannot drift from
 * the schemas the REST and MCP surfaces validate against — the same reason the
 * digest's `--window` list derives from `src/domain/window.ts`'s tuples — and
 * the router can only import modules that pull in no config, service, or db,
 * because preflight runs BEFORE a leaf (and `startupDb`) is ever loaded.
 *
 * The DEFAULT is deliberately NOT declared here: per ADR 0055 it follows each
 * surface's audience (CLI `console`, MCP `console`, REST `json`), so each
 * surface applies its own and the shared declaration stays honest about there
 * being no single right answer.
 */
export const PLAYER_CARD_FORMATS = ["console", "json", "html"] as const;

export type PlayerCardFormat = (typeof PLAYER_CARD_FORMATS)[number];
