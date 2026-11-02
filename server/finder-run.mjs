// Runs the AI deal finder once and saves the finds for the Deals page.
//
//   npm run finder
import { findDeals, saveFinds } from "./finder.mjs";

try {
  const run = await findDeals();
  await saveFinds(run);
  for (const s of run.sources)
    console.log(`${s.name}: ${s.ok ? s.posts + " posts" : "failed, " + s.error}`);
  console.log(
    `${run.finds.length} finds from ${run.screened} posts with ${run.model}` +
      (run.costUsd === null ? "" : `, about $${run.costUsd.toFixed(4)}`),
  );
} catch (e) {
  console.error("Deal finder failed: " + e.message);
  process.exit(1);
}
