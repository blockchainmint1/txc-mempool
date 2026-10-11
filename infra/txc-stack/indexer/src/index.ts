import { runIndexerLoop } from "./indexer.js";
import { startHttp } from "./esplora.js";
import { runOmniLoop } from "./omni.js";

async function main(): Promise<void> {
  console.log("[indexer] starting txc address indexer");
  await startHttp();
  await runIndexerLoop();
  runOmniLoop();
}

main().catch((err) => {
  console.error("[indexer] fatal:", err);
  process.exit(1);
});
