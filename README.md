# Cricket M3U playlist

This repository publishes `playlist.m3u` at a constant GitHub URL. The playlist is regenerated once per day by GitHub Actions.

The source catalog is deliberately limited to official cricket organisations and free-to-air broadcasters. It does not scrape or republish touchcric, smartcric, freehit, or user-uploaded “live cricket” channels. YouTube sources are included only when the official channel page reports an active live broadcast; ordinary videos, gaming streams, and fake live channels are excluded.

## What is included

- ICC and Asian Cricket Council official channels
- Official league channels such as MLC, ILT20, and Abu Dhabi T10
- Official national and regional cricket-board channels
- Prasar Bharati / DD Sports and PTV Sports official sources
- ICC.tv as an official destination for region-limited free live coverage

A source being official does not mean it is live every day. The playlist can be empty or contain only the ICC.tv reference when no verified live broadcast is available.

## One-time GitHub setup

1. Push this repository to GitHub.
2. In repository settings, add these Actions secrets:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
3. Enable GitHub Actions if prompted.
4. Run **Update cricket playlist** once from the Actions tab to test it.

The workflow then runs daily. The stable playlist URL for this repo is:

```text
https://raw.githubusercontent.com/sambath-creator/sports-enthusiast/main/playlist.m3u
```

## Local generation

With the same two environment variables available locally:

```text
npm ci
npm run update
```

The generator writes `playlist.m3u` and `playlist-status.json`. It checks each active source, records the result in the database, and includes only sources that pass the live check.

## Important limitations

YouTube does not expose a universal direct HLS URL for every public live broadcast. The generated entries use the official YouTube watch URL, which works in players that support YouTube URLs but not in every IPTV application. For a direct `.m3u8` entry, add a source only when you have permission to use its stable HLS endpoint and set its type to `hls` in the database.

The health check verifies availability and the official channel’s live status; it cannot guarantee that every frame contains cricket. The curated source list and official-channel restriction are the controls that prevent game footage and fake streams from being added.
