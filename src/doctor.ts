// `dbgx doctor` — Helix `--health`-style page showing known vs installed
// debug adapters. Mirrors Helix's rendering: a padded table with one row
// per language, each adapter rendered as "✓ <name>" (green) or "✘ <name>"
// (red); subsequent adapters for the same language wrap onto indented lines.
//
// Faithful to helix-term/src/health.rs::health_all(). Colors respect NO_COLOR
// and non-TTY via src/color.ts; the table layout is always rendered.

import { c, colorEnabled } from "./color.ts";
import {
  allLanguageStatus,
  getLanguage,
  installedCount,
  languageAdapterStatus,
  registryPath,
} from "./registry/index.ts";
import { DBGX_DIR } from "./paths.ts";

const VERSION = "0.1.0";

function termWidth(): number {
  const w = process.stdout.columns;
  return typeof w === "number" && w >= 40 ? w : 80;
}

/** Fit a string into a fixed column width, truncating with "…" like Helix. */
function fit(s: string, width: number): string {
  if (s.length <= width) return s.padEnd(width);
  return s.slice(0, Math.max(0, width - 1)) + "…";
}

function statusGlyph(found: boolean): string {
  return found ? "✓" : "✘";
}

function renderAdapterCell(
  adapters: { id: string; path: string | null }[],
  width: number,
): string {
  if (adapters.length === 0) {
    return c.yellow(fit("None", width));
  }
  const lines = adapters.map(({ id, path }) => {
    const glyph = statusGlyph(Boolean(path));
    const label = `${glyph} ${id}`;
    return Boolean(path) ? c.green(fit(label, width)) : c.red(fit(label, width));
  });
  return lines.join("\n");
}

/** Full table: every language in the registry. */
export function renderDoctorTable(): string {
  const width = termWidth();
  const langCol = Math.min(16, Math.max(8, Math.floor(width * 0.22)));
  const adapterCol = width - langCol - 1;

  const rows = allLanguageStatus().map(({ lang, adapters }) => ({
    lang: lang.name,
    adapters: adapters.map((a) => ({ id: a.id, path: a.path })),
  }));

  const header =
    c.bold(fit("Language", langCol)) + " " + c.bold(fit("Debug adapters", adapterCol));
  const sep = "─".repeat(langCol) + " " + "─".repeat(adapterCol);

  const out: string[] = [header, sep];
  for (const r of rows) {
    const langCell = fit(r.lang, langCol);
    const cell = renderAdapterCell(r.adapters, adapterCol);
    const cellLines = cell.split("\n");
    out.push(`${langCell} ${cellLines[0]}`);
    const indent = " ".repeat(langCol + 1);
    for (const line of cellLines.slice(1)) out.push(`${indent}${line}`);
  }
  return out.join("\n");
}

/** Per-language detail: Helix `--health <lang>` style. */
export function renderLanguageDetail(name: string): string {
  const lang = getLanguage(name);
  if (!lang) {
    return c.red(`Language '${name}' not found in registry.`);
  }
  const statuses = languageAdapterStatus(lang);
  const out: string[] = [];
  out.push(c.bold(`Configured debug adapters for '${c.cyan(name)}':`));
  if (statuses.length === 0) {
    out.push(c.yellow("  None configured."));
    return out.join("\n");
  }
  for (const s of statuses) {
    const glyph = statusGlyph(Boolean(s.path));
    const head = `  ${glyph} ${c.bold(s.id)}`;
    const cmd = s.adapter.args?.length
      ? [s.adapter.command, ...s.adapter.args].join(" ")
      : s.adapter.command;
    const tail = s.path
      ? c.dim(` -> ${s.path}`)
      : c.dim(` (${cmd})`) + (s.adapter.install ? c.dim(`  install: ${s.adapter.install}`) : "");
    out.push(Boolean(s.path) ? c.green(head) + tail : c.red(head) + tail);
  }
  return out.join("\n");
}

/** Top-of-page banner: Helix prints config/log/runtime paths. */
export function renderHeader(): string {
  const { installed, total } = installedCount();
  const colorOn = colorEnabled();
  const title = colorOn ? c.bold(c.magenta(`dbgx ${VERSION}`)) : `dbgx ${VERSION}`;
  const sub = c.dim("| debug-adapter health");
  return [
    `${title} ${sub}`,
    c.dim(`Registry: ${registryPath()}`),
    c.dim(`Runtime:  ${DBGX_DIR}`),
    c.dim(`Adapters installed: ${installed}/${total}   (PATH lookup via Bun.which)`),
    "",
  ].join("\n");
}

export function renderDoctor(arg?: string): string {
  if (arg && arg !== "all" && arg !== "all-languages") {
    return renderHeader() + "\n" + renderLanguageDetail(arg);
  }
  return renderHeader() + renderDoctorTable();
}
