import type { Level } from "../mlb/levels.js";
import { MILB_LEVEL_ORDER } from "../mlb/levels.js";

/**
 * Digest rendering: HTML + plain-text parts, single-column simple markup
 * readable in iPhone Mail. Stat Lines are per-game (ADR 0029); the
 * "Game 1"/"Game 2" doubleheader labels here are presentation only.
 */

export interface RenderPlayer {
  fullName: string;
  level: Level;
  milbLevel: string | null;
  teamName: string | null;
}

export interface RenderLine {
  player: RenderPlayer;
  gameId: number;
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

const countLabel = (n: number, label: string): string => (n === 1 ? label : `${n} ${label}`);

export function formatBattingLine(stats: Record<string, unknown>): string {
  const parts: string[] = [`${num(stats, "hits")}-${num(stats, "atBats")}`];
  const extras: Array<[string, string]> = [
    ["homeRuns", "HR"],
    ["triples", "3B"],
    ["doubles", "2B"],
    ["runs", "R"],
    ["rbi", "RBI"],
    ["stolenBases", "SB"],
    ["baseOnBalls", "BB"],
    ["strikeOuts", "K"],
  ];
  for (const [key, label] of extras) {
    const n = num(stats, key);
    if (n > 0) parts.push(countLabel(n, label));
  }
  return parts.join(", ");
}

export function formatPitchingLine(stats: Record<string, unknown>): string {
  const ip = typeof stats.inningsPitched === "string" ? stats.inningsPitched : "0.0";
  const parts = [
    `${ip} IP`,
    `${num(stats, "hits")} H`,
    `${num(stats, "earnedRuns")} ER`,
    `${num(stats, "baseOnBalls")} BB`,
    `${num(stats, "strikeOuts")} K`,
  ];
  const line = parts.join(", ");
  if (num(stats, "wins") > 0) return `${line} (W)`;
  if (num(stats, "losses") > 0) return `${line} (L)`;
  if (num(stats, "saves") > 0) return `${line} (SV)`;
  return line;
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
  const subject = `Bryce digest - ${date}`;

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
      const team = player.teamName !== null ? ` (${player.teamName})` : "";
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
