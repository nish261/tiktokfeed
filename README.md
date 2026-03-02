# TikTok → Discord Feed

Monitors TikTok accounts for new videos and posts them — without watermark — directly into a Discord channel as playable uploads.

## How it works

1. Polls each watched account every N minutes using `yt-dlp`
2. For each new video, fetches the no-watermark download URL via [tikwm.com](https://www.tikwm.com)
3. Uploads the MP4 file directly to Discord via webhook (plays inline)
4. Falls back to posting the link if the file exceeds the size limit
5. Tracks seen video IDs in `~/.tiktok_discord_state.json` — no double posts

## Setup

**1. Install dependencies**
```bash
pip3 install requests yt-dlp
```

**2. Configure**
```bash
cp config/tiktok_discord.json config/tiktok_discord.json
```
Edit `config/tiktok_discord.json`:
```json
{
  "webhook_url": "YOUR_DISCORD_WEBHOOK_URL",
  "accounts": ["@username1", "@username2"],
  "interval": 300
}
```
Get a webhook URL from: Discord Server Settings → Integrations → Webhooks → New Webhook

**3. Run**
```bash
# Background daemon
bash tiktok_discord_start.sh start

# One-shot check
python3 tiktok_discord_feed.py
```

## Daemon commands

```bash
bash tiktok_discord_start.sh start    # start in background
bash tiktok_discord_start.sh stop     # stop
bash tiktok_discord_start.sh restart  # restart
bash tiktok_discord_start.sh status   # check + recent logs
bash tiktok_discord_start.sh logs     # live log stream
```

Logs: `/tmp/tiktok_discord.log`

## Raycast Extension

A single Raycast command (`TikTok Feed`) with a full UI:

- **Daemon** — running status, start/stop/restart
- **Watching** — list accounts, add/remove without restarting
- **Recent Activity** — live log feed, auto-refreshes every 5s

```bash
cd raycast
npm install
npm run dev   # loads into Raycast immediately
```

## Config hot-reload

Edit `config/tiktok_discord.json` at any time — accounts and settings are picked up on the next poll cycle without restarting.
