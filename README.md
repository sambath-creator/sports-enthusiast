# Sports Enthusiast Auto-Scraping Playlist

This repository publishes `playlist.m3u` containing auto-discovered, direct HLS streams for live sports (Cricket, Football, Tennis, etc.).

## Features
- **Dynamic Multi-Sport Support**: Intelligently sniffs streams for multiple sports (Cricket, Football, Tennis, Basketball, Motorsport, Rugby/NFL) and automatically assigns them to `group-title` categories in the M3U playlist.
- **Robust Scraper**: Automatically parses pages for "Watch", "Play", "High", or "Low" buttons and clicks them sequentially to intercept raw `.m3u8` video feeds using a headless browser.
- **IPTV Compatible**: Appends `#EXTVLCOPT:http-referrer=` and `|Referer=` tags to ensure streams bypass CDN referer-blocks when playing via VLC, TiviMate, or Web Video Cast.

## One-time GitHub setup (Not recommended for IP-bound streams)

1. Push this repository to GitHub.
2. In repository settings, add these Actions secrets:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
3. Enable GitHub Actions if prompted.

*Note: GitHub Actions run in the cloud. Many pirate streams use IP-binding (where the token only works for the IP that requested it). If you scrape via GitHub, the stream tokens will be bound to GitHub's servers and may return a 404/403 when played on your TV. For best results, run the scraper locally!*

## Local Generation (Recommended)

Running the script on your local network ensures that stream tokens are bound to your home IP address, allowing them to play flawlessly on your TV.

1. Ensure Node 20+ is installed.
2. Create a `.env` file in the root directory:
```env
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
```
3. Run the sync command to scrape, build, commit, and push automatically:
```bash
npm run sync
```

## Automated Linux Mini PC Deployment

You can turn a Linux box into a dedicated scraper that runs autonomously every 30 minutes.

### 1. Install Prerequisites
```bash
sudo apt update
# Install system libraries for Puppeteer's headless Chrome
sudo apt install -y git curl libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2

# Install Node.js (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Clone & Configure
```bash
cd ~
git clone https://github.com/sambath-creator/sports-enthusiast.git
cd sports-enthusiast
npm install
```
Create your `.env` file with your Supabase credentials:
```bash
nano .env
```

### 3. Configure Git Authentication
To push silently without a password prompt, set your remote URL using a Personal Access Token (PAT):
```bash
git remote set-url origin https://<YOUR_GITHUB_USERNAME>:<YOUR_PAT_TOKEN>@github.com/sambath-creator/sports-enthusiast.git
```

### 4. Schedule with Cron
Run the scraper every 30 minutes in the background:
1. `crontab -e`
2. Add this line at the bottom (replace `yourusername`):
```bash
*/30 * * * * cd /home/yourusername/sports-enthusiast && /usr/bin/npm run sync >> /home/yourusername/sports-enthusiast/cron.log 2>&1
```

Now, your Linux box will silently update the playlist every half hour and push it to GitHub for your TV to consume!
