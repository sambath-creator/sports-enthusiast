// scrapers/freehit.js
import puppeteer from "puppeteer";


async function scrapeFreeHit() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ]
  });

  const page = await browser.newPage();
  const streams = new Set(); // remove duplicates automatically

  // Capture .m3u8 from network
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (url.includes(".m3u8")) {
        streams.add(url);
      }
    } catch (_) {}
  });

  try {
    // HOP 1 — Load homepage
    await page.goto("https://freehit.eu/free/", {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Extract match buttons
    const matchButtons = await page.$$eval("button", btns =>
      btns.map(b => b.innerText.trim())
    );

    // Loop through all matches
    for (const match of matchButtons) {
      try {
        console.log(`Trying match: ${match}`);

        // Click match
        await page.click(`button:contains("${match}")`).catch(() => {});
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });

        // HOP 2 — Quality selection
        await page.waitForSelector("button", { timeout: 15000 });

        const qualityButtons = await page.$$eval("button", btns =>
          btns.map(b => b.innerText.trim())
        );

        // Prefer High → Medium → Low
        const preferred = ["High", "Medium", "Low"];
        let qualityToClick = preferred.find(q => qualityButtons.includes(q));

        if (!qualityToClick) {
          console.log("No quality buttons found, skipping match.");
          continue;
        }

        console.log(`Selecting quality: ${qualityToClick}`);

        await page.click(`button:contains("${qualityToClick}")`).catch(() => {});
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });

        // HOP 3 — Video page
        await page.waitForTimeout(3000);

        // Drill into nested iframes
        const allFrames = page.frames();

        for (const frame of allFrames) {
          try {
            // Look for video tags
            const videoSrc = await frame.$eval("video", v => v.src).catch(() => null);
            if (videoSrc && videoSrc.includes(".m3u8")) {
              streams.add(videoSrc);
            }

            // Look for script-based players
            const html = await frame.content().catch(() => "");
            const m3u8Matches = html.match(/https?:\/\/[^"']+\.m3u8/gi);
            if (m3u8Matches) {
              m3u8Matches.forEach(url => streams.add(url));
            }
          } catch (_) {}
        }

        // If we found streams, stop early
        if (streams.size > 0) break;

      } catch (err) {
        console.log(`Match failed: ${match}`, err.message);
      }
    }

  } catch (err) {
    console.log("FreeHit scraper failed:", err.message);
  }

  await browser.close();

  return Array.from(streams); // return deduplicated list
}

export default scrapeFreeHit;
