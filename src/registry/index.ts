// Loads + exposes the curated debug-adapter registry.
// Schema mirrors Helix's languages.toml, adapted for debug adapters;
// parsed with the mature `smol-toml`.

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { parse } from "smol-toml";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface AdapterDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  install?: string;
  /** Transport: "stdio" (default) speaks DAP over the child's stdin/stdout;
   *  "tcp" spawns the adapter, parses a listening line from its stdout,
   *  then connects a TCP socket (e.g. vscode-js-debug, dlv).
   *  "tcp-allocate" is for adapters that take a --port argument and don't
   *  report the bound port: dbgx allocates a free port, substitutes it into
   *  args via `{port}`, and connects (e.g. probe-rs, perl-debug). */
  transport?: "stdio" | "tcp" | "tcp-allocate" | "tcp-attach";
  /** For tcp-attach adapters: default port to connect to when the caller
   *  doesn't pass --port (e.g. godot-dap's default DAP port 6006). */
  defaultPort?: number;
  /** Adapter-specific launch defaults (e.g. dlv `mode`) merged into the
   *  launch args by the session layer. A loose record on purpose. */
  config?: Record<string, unknown>;
  /** Set breakpoints BEFORE `launch` (not after `initialized`). Needed for
   *  adapters that start the debuggee on `launch` (not `configurationDone`),
   *  e.g. ElixirLS — the program runs to completion before `initialized`
   *  arrives if breakpoints aren't set first. */
  breakpointsBeforeLaunch?: boolean;
}

export interface LanguageDef {
  name: string;
  "file-types"?: (string | { glob: string })[];
  roots?: string[];
  "debug-adapters"?: string[];
}

export interface Registry {
  "debug-adapter": Record<string, AdapterDef>;
  language: LanguageDef[];
}

let _registry: Registry | null = null;

export function registryPath(): string {
  return join(HERE, "debuggers.toml");
}

export function loadRegistry(): Registry {
  if (_registry) return _registry;
  const text = readFileSync(registryPath(), "utf-8");
  const parsed = parse(text) as unknown as Registry;
  _registry = {
    "debug-adapter": parsed["debug-adapter"] ?? {},
    language: parsed.language ?? [],
  };
  return _registry;
}

/** Allow tests/fixtures to inject a registry without touching disk. */
export function setRegistry(r: Registry): void {
  _registry = r;
}

export function adapters(): Record<string, AdapterDef> {
  return loadRegistry()["debug-adapter"];
}

export function languages(): LanguageDef[] {
  return loadRegistry().language;
}

export function getAdapter(id: string): AdapterDef | undefined {
  return adapters()[id];
}

export function getLanguage(name: string): LanguageDef | undefined {
  const langs = languages();
  const direct = langs.find((l) => l.name === name);
  if (direct) return direct;
  // Common aliases: users naturally type `launch node ...` / `attach node`, but
  // the registry names these `javascript`/`typescript`. Map the runtime
  // nicknames so attach (which has no program to fall back on) resolves.
  const alias: Record<string, string> = {
    node: "javascript", js: "javascript", nodejs: "javascript",
    ts: "typescript",
  };
  const target = alias[name];
  return target ? langs.find((l) => l.name === target) : undefined;
}

/** Resolve a language's full adapter definitions (in priority order). */
export function languageAdapters(lang: LanguageDef): AdapterDef[] {
  const ids = lang["debug-adapters"] ?? [];
  return ids
    .map((id) => getAdapter(id))
    .filter((a): a is AdapterDef => Boolean(a));
}

/** Helix-style `which`: is the adapter's binary on PATH?
 *  Resolves symlinks: bun's posix_spawn fails with ENOENT on relative
 *  symlinks (e.g. /usr/bin/node -> node-22), so return the real path. */
export function whichAdapter(a: AdapterDef): string | null {
  const found = Bun.which(a.command);
  if (!found) return null;
  try {
    return realpathSync(found);
  } catch {
    return found;
  }
}

export interface AdapterStatus {
  id: string;
  adapter: AdapterDef;
  path: string | null; // null => not found in $PATH
}

/** Per-adapter installed/not status for a language (Helix `--health <lang>` style). */
export function languageAdapterStatus(lang: LanguageDef): AdapterStatus[] {
  const ids = lang["debug-adapters"] ?? [];
  return ids.map((id) => {
    const adapter = getAdapter(id);
    if (!adapter) return { id, adapter: { command: id }, path: null };
    return { id, adapter, path: whichAdapter(adapter) };
  });
}

/** Flat summary across the whole registry (for the table view). */
export function allLanguageStatus(): { lang: LanguageDef; adapters: AdapterStatus[] }[] {
  return languages()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((lang) => ({ lang, adapters: languageAdapterStatus(lang) }));
}

/** Count of installed vs total adapters (for the summary line). */
export function installedCount(): { installed: number; total: number } {
  const seen = new Map<string, boolean>();
  for (const a of Object.values(adapters())) {
    const key = a.command;
    if (!seen.has(key)) seen.set(key, Boolean(whichAdapter(a)));
  }
  let installed = 0;
  for (const v of seen.values()) if (v) installed++;
  return { installed, total: seen.size };
}

/** Which languages map to a given adapter id (reverse lookup). */
export function languagesForAdapter(adapterId: string): string[] {
  return languages()
    .filter((l) => (l["debug-adapters"] ?? []).includes(adapterId))
    .map((l) => l.name);
}
