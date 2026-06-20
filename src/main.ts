// dbgx entry point. Self-invokes when run directly; safe to import from bin/.

import { run } from "./cli.ts";

export async function main(argv: string[]): Promise<void> {
  const code = await run(argv);
  process.exit(code);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
