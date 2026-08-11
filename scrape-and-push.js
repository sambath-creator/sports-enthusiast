import scrapeFreeHit from "./scrapers/freehit.js";
import { execSync } from "child_process";
import dotenv from "dotenv";
dotenv.config();



function run(cmd) {
  console.log("Running:", cmd);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    console.error("Command failed:", cmd);
    console.error(err.message);
    process.exit(1);
  }
}

console.log("=== Docker Cricket Scraper ===");

// 1. Run scraper
run("node index.js");

// 2. Stage playlist files
run('git add playlist.m3u playlist-status.json');

// 3. Commit (ignore if no changes)
run('git commit -m \"Auto-update playlist\" || echo \"No changes\"');

// 4. Pull latest changes
const pat = process.env.GITHUB_PAT;
run(`git pull --rebase https://x-access-token:${pat}@github.com/sambath-creator/sports-enthusiast.git main`);

// 5. Push updated playlist
run(`git push https://x-access-token:${pat}@github.com/sambath-creator/sports-enthusiast.git`);

console.log("=== Scraper + Push Completed ===");
