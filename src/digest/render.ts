import type { Level } from "../mlb/levels.js";
import { MILB_LEVEL_ORDER } from "../mlb/levels.js";
import {
  formatIp,
  ipToOuts,
  qualityStart,
  singleGameEra,
  singleGameK9,
  singleGameWhip,
} from "./rates.js";

/**
 * Digest rendering: HTML + plain-text parts, single-column simple markup
 * readable in iPhone Mail. Stat Lines are per-game (ADR 0029); the
 * "Game 1"/"Game 2" doubleheader labels here are presentation only. Stat text
 * is the HC-specified fixed format (ADR 0033) — every stat always shown,
 * zeros included, single-game rates.
 */

export interface RenderPlayer {
  fullName: string;
  level: Level;
  milbLevel: string | null;
  teamName: string | null;
  /** NCAA school; shown where teamName is shown for ncaa-level Players (ADR 0032). */
  schoolName: string | null;
}

export interface RenderLine {
  player: RenderPlayer;
  gameId: number;
  /** Never "fielding": fielding rows merge into batting lines at assembly (ADR 0033). */
  statType: "batting" | "pitching";
  gameDate: string;
  gameNumber: number;
  isHome: boolean | null;
  opponentName: string | null;
  stats: Record<string, unknown>;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

const num = (stats: Record<string, unknown>, key: string): number => {
  const v = stats[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

/**
 * Fixed-format batting line (ADR 0033): every stat always shown, zeros
 * included, in the HC-specified order. PA comes from the source when present;
 * the AB + BB + HBP fallback is belt-and-suspenders (NCAA rows derive PA at
 * ingest). E arrives merged from the same game's fielding row (assemble.ts).
 */
export function formatBattingLine(stats: Record<string, unknown>): string {
  const pa =
    typeof stats.plateAppearances === "number" && Number.isFinite(stats.plateAppearances)
      ? stats.plateAppearances
      : num(stats, "atBats") + num(stats, "baseOnBalls") + num(stats, "hitByPitch");
  const parts: Array<[string, number]> = [
    ["PA", pa],
    ["H", num(stats, "hits")],
    ["BB", num(stats, "baseOnBalls")],
    ["K", num(stats, "strikeOuts")],
    ["2B", num(stats, "doubles")],
    ["3B", num(stats, "triples")],
    ["HR", num(stats, "homeRuns")],
    ["RBI", num(stats, "rbi")],
    ["R", num(stats, "runs")],
    ["SB", num(stats, "stolenBases")],
    ["CS", num(stats, "caughtStealing")],
    ["E", num(stats, "errors")],
  ];
  return parts.map(([label, value]) => `${label} ${value}`).join(", ");
}

/**
 * Fixed-format pitching line (ADR 0033): every stat always shown, in the
 * HC-specified order. ERA/WHIP/K-9 are SINGLE-GAME rates (this outing only);
 * zero or unparseable IP renders them "-". HA/HRA are hits/home runs allowed;
 * HLD is absent from NCAA data and renders 0.
 */
export function formatPitchingLine(stats: Record<string, unknown>): string {
  const ip = formatIp(stats.inningsPitched);
  const outs = ipToOuts(ip);
  const er = num(stats, "earnedRuns");
  const k = num(stats, "strikeOuts");
  const bb = num(stats, "baseOnBalls");
  const ha = num(stats, "hits");
  const parts: Array<[string, number | string]> = [
    ["IP", ip],
    ["ER", er],
    ["K", k],
    ["K/9", singleGameK9(k, outs)],
    ["BB", bb],
    ["HA", ha],
    ["HRA", num(stats, "homeRuns")],
    ["ERA", singleGameEra(er, outs)],
    ["WHIP", singleGameWhip(bb, ha, outs)],
    ["S", num(stats, "saves")],
    ["HLD", num(stats, "holds")],
    ["QS", qualityStart(outs, er)],
  ];
  return parts.map(([label, value]) => `${label} ${value}`).join(", ");
}

/** "2026-07-30" → "Thu, July 30, 2026" (HC-specified subject date style). */
export function formatSubjectDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface Section {
  title: string;
  players: Array<{ player: RenderPlayer; lines: RenderLine[] }>;
}

function sectionTitle(level: Level, milbLevel: string | null): string {
  if (level === "mlb") return "MLB";
  if (level === "ncaa") return "NCAA";
  return milbLevel !== null ? `MiLB - ${milbLevel}` : "MiLB";
}

function sectionOrder(): string[] {
  return ["MLB", ...MILB_LEVEL_ORDER.map((l) => `MiLB - ${l}`), "MiLB", "NCAA"];
}

function buildSections(lines: RenderLine[]): Section[] {
  const byTitle = new Map<string, Map<string, { player: RenderPlayer; lines: RenderLine[] }>>();
  for (const line of lines) {
    const title = sectionTitle(line.player.level, line.player.milbLevel);
    const playersOfTitle = byTitle.get(title) ?? new Map();
    byTitle.set(title, playersOfTitle);
    const entry = playersOfTitle.get(line.player.fullName) ?? { player: line.player, lines: [] };
    playersOfTitle.set(line.player.fullName, entry);
    entry.lines.push(line);
  }
  const sections: Section[] = [];
  for (const title of sectionOrder()) {
    const playersOfTitle = byTitle.get(title);
    if (playersOfTitle === undefined) continue;
    const playerEntries = [...playersOfTitle.values()].sort((a, b) =>
      a.player.fullName.localeCompare(b.player.fullName),
    );
    for (const entry of playerEntries) {
      entry.lines.sort(
        (a, b) =>
          a.gameDate.localeCompare(b.gameDate) ||
          a.gameNumber - b.gameNumber ||
          a.statType.localeCompare(b.statType),
      );
    }
    sections.push({ title, players: playerEntries });
  }
  return sections;
}

/** "Game N" label only when the player really played two games that date (doubleheader). */
function gameLabel(line: RenderLine, playerLines: RenderLine[]): string {
  const gameIdsOnDate = new Set(
    playerLines.filter((l) => l.gameDate === line.gameDate).map((l) => l.gameId),
  );
  return gameIdsOnDate.size > 1 ? ` (Game ${line.gameNumber})` : "";
}

function describeLine(line: RenderLine, playerLines: RenderLine[]): string {
  const where =
    line.opponentName === null ? "" : ` ${line.isHome === false ? "at" : "vs"} ${line.opponentName}`;
  const statText =
    line.statType === "batting" ? formatBattingLine(line.stats) : formatPitchingLine(line.stats);
  return `${line.gameDate}${where}${gameLabel(line, playerLines)}: ${statText}`;
}

export function renderDigest(args: {
  date: string;
  lines: RenderLine[];
  noNewStats: RenderPlayer[];
}): RenderedMail {
  const { date, lines, noNewStats } = args;
  const sections = buildSections(lines);
  const subject = `MLB Daily Tracker: ${formatSubjectDate(date)}`;

  const textParts: string[] = [`Bryce digest for ${date}`, ""];
  const htmlParts: string[] = [`<h1>Bryce digest for ${escapeHtml(date)}</h1>`];

  if (sections.length === 0) {
    textParts.push("No new stat lines today.", "");
    htmlParts.push("<p>No new stat lines today.</p>");
  }

  for (const section of sections) {
    textParts.push(section.title);
    htmlParts.push(`<h2>${escapeHtml(section.title)}</h2>`);
    for (const { player, lines: playerLines } of section.players) {
      // NCAA Players carry a school, not a team; everyone else carries a team.
      const affiliation = player.level === "ncaa" ? player.schoolName : player.teamName;
      const team = affiliation !== null ? ` (${affiliation})` : "";
      textParts.push(`  ${player.fullName}${team}`);
      htmlParts.push(`<h3>${escapeHtml(`${player.fullName}${team}`)}</h3>`, "<ul>");
      for (const line of playerLines) {
        const described = describeLine(line, playerLines);
        textParts.push(`    ${described}`);
        htmlParts.push(`<li>${escapeHtml(described)}</li>`);
      }
      htmlParts.push("</ul>");
    }
    textParts.push("");
  }

  if (noNewStats.length > 0) {
    const names = [...noNewStats]
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((p) => p.fullName);
    textParts.push(`No new stats: ${names.join(", ")}`);
    htmlParts.push(`<p>No new stats: ${escapeHtml(names.join(", "))}</p>`);
  }

  return {
    subject,
    text: `${textParts.join("\n").trimEnd()}\n`,
    html: htmlParts.join("\n"),
  };
}

export function renderHeartbeat(args: {
  date: string;
  playerCount: number;
  nextOpeningDay: string | null;
}): RenderedMail {
  const { date, playerCount, nextOpeningDay } = args;
  const resume = nextOpeningDay ?? "TBD";
  const body = `alive; ${playerCount} players watched; games resume ~${resume}`;
  return {
    subject: `Bryce heartbeat - ${date}`,
    text: `${body}\n`,
    html: `<p>${escapeHtml(body)}</p>`,
  };
}
