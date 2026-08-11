import puppeteer from "puppeteer";

const SITES = [
  "https://touchcric.is",
  "https://smartcric.is",
  "https://freehit.eu"
];

// Mobile device profile
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

// Utility: wait for Cloudflare challenge to finish
async function waitForCloudflare(page) {
  try {
    await page.waitForNavigation({
      timeout: 15000,
      waitUntil: "networkidle0"
    });
  } catch (_) {
    // Cloudflare sometimes doesn't trigger navigation
  }

  // Wait for JS challenge to finish
  await page.waitForTimeout(6000);
}

// Extract match links from rendered DOM
async function extractMatchLinks(page) {
  return await page.evaluate(() => {
    const anchors = [...document.querySelectorAll("a")];
    return anchors
      .map(a => a.href)
      .filter(h =>
        h.includes("/live/") ||
        h.includes("/watch/") ||
        h.includes("/stream/")
      );
  });
}

// Extract iframe URLs from rendered DOM
async function extractIframeLinks(page) {
  return await page.evaluate(() => {
    const iframes = [...document.querySelectorAll("iframe")];
    return iframes.map(f => f.src).filter(Boolean);
  });
}

// Intercept network requests to capture .m3u8 URLs
async function interceptM3U8(page) {
  const m3u8Links = new Set();

  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url.includes(".m3u8")) {
      m3u8Links.add(url);
    }
    req.continue();
  });

  return m3u8Links;
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

              await page.waitForTimeout(5000);

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
