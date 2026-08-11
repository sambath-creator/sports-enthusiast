import puppeteer from "puppeteer";

const SITES = [
  "https://touchcric.is",
  "https://smartcric.is",
  "https://freehit.eu/free"
];

const MOBILE_EMULATION = {
  viewport: {
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true
  },
  userAgent:
    "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForCloudflare(page) {
  try {
    await page.waitForNavigation({ timeout: 15000, waitUntil: "networkidle0" });
  } catch (_) {}
  await sleep(6000);
}

async function extractMatchLinks(page) {
  return await page.evaluate(() => {
    return [...document.querySelectorAll("a")]
      .map(a => a.href)
      .filter(h =>
        h.includes("/live") ||
        h.includes("/watch") ||
        h.includes("/stream")
      );
  });
}

async function extractIframeLinks(page) {
  return await page.evaluate(() => {
    return [...document.querySelectorAll("iframe")]
      .map(f => f.src)
      .filter(Boolean);
  });
}

async function interceptM3U8(page) {
  const m3u8Links = new Set();

  await page.setRequestInterception(true);

  page.on("request", req => {
    const url = req.url();
    if (url.match(/\.m3u8(\?|$)/)) {
      console.log("REQUEST M3U8:", url);
      m3u8Links.add(url);
    }
    // DO NOT call req.continue() — Puppeteer-core auto-handles it
  });
  
  page.on("response", res => {
    const url = res.url();
    if (url.match(/\.m3u8(\?|$)/)) {
      console.log("RESPONSE M3U8:", url);
      m3u8Links.add(url);
    }
  });

  return m3u8Links;
}

async function extractInlineM3U8(page) {
  return await page.evaluate(() => {
    const matches = document.body.innerHTML.match(/https?:\/\/[^"' ]+\.m3u8/gi);
    return matches || [];
  });
}

export async function runPuppeteerScraper() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--disable-gpu",
      "--no-zygote"
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent(MOBILE_EMULATION.userAgent);
  await page.setViewport(MOBILE_EMULATION.viewport);

  const discovered = [];

  for (const site of SITES) {
    console.log(`Puppeteer scraping: ${site}`);

    try {
      await page.goto(site, { waitUntil: "domcontentloaded", timeout: 20000 });
      await waitForCloudflare(page);

      const matchLinks = await extractMatchLinks(page);
      console.log(`Found ${matchLinks.length} match links on ${site}`);

      for (const matchUrl of matchLinks) {
        try {
          await page.goto(matchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          await waitForCloudflare(page);

          const iframeLinks = await extractIframeLinks(page);
          console.log(`  ${matchUrl} → ${iframeLinks.length} iframes`);

          for (const iframeUrl of iframeLinks) {
            try {
              const m3u8Collector = await interceptM3U8(page);

              await page.goto(iframeUrl, {
                waitUntil: "networkidle0",
                timeout: 20000
              });

              await sleep(15000);

              const inline = await extractInlineM3U8(page);
              inline.forEach(u => m3u8Collector.add(u));

              const m3u8Links = [...m3u8Collector];
              console.log(`    ${iframeUrl} → ${m3u8Links.length} streams`);

              for (const m3u8 of m3u8Links) {
                discovered.push({
                  name: "Auto Stream",
                  type: "hls",
                  url: m3u8,
                  discovered_from: site
                });
              }
            } catch (err) {
              console.log(`    iframe failed: ${err.message}`);
            }
          }
        } catch (err) {
          console.log(`  match page failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.log(`Site failed: ${err.message}`);
    }
  }

  await browser.close();
  return discovered;
}
