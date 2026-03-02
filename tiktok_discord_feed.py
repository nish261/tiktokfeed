#!/usr/bin/env python3
"""
TikTok → Discord Feed
- Polls TikTok accounts for new videos
- Downloads without watermark using yt-dlp
- Uploads the actual video file to Discord (plays inline)
- Falls back to link-only if file is too large

Config: config/tiktok_discord.json
Logs:   /tmp/tiktok_discord.log
State:  ~/.tiktok_discord_state.json
"""

import json
import os
import sys
import time
import subprocess
import tempfile
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import requests

# ── Config ────────────────────────────────────────────────────────────────────

CONFIG_PATH = Path(__file__).parent / "config" / "tiktok_discord.json"
STATE_FILE  = Path.home() / ".tiktok_discord_state.json"
LOG_FILE    = Path("/tmp/tiktok_discord.log")

MAX_DISCORD_MB   = 25    # Discord file size limit (MB) — safe default
DEFAULT_INTERVAL = 300   # seconds between polls
FETCH_LIMIT      = 10    # how many recent videos to check per account

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("tiktok_discord")

# ── State ─────────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}

def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))

# ── Config ────────────────────────────────────────────────────────────────────

def load_config() -> dict:
    if not CONFIG_PATH.exists():
        log.error(f"Config not found: {CONFIG_PATH}")
        sys.exit(1)
    cfg = json.loads(CONFIG_PATH.read_text())
    assert cfg.get("webhook_url"), "webhook_url missing in config"
    assert cfg.get("accounts"),    "accounts list missing in config"
    return cfg

# ── TikTok Fetch ──────────────────────────────────────────────────────────────

def _cookie_args() -> list[str]:
    for p in ["~/yt_cookies.txt", "~/cookies.txt"]:
        path = Path(p).expanduser()
        if path.exists():
            return ["--cookies", str(path)]
    return []

def fetch_latest_videos(account: str) -> list[dict]:
    """Get latest video metadata from a TikTok profile (flat, no download)."""
    username = account.lstrip("@")
    url = f"https://www.tiktok.com/@{username}"

    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--dump-json",
        "--flat-playlist",
        "--playlist-end", str(FETCH_LIMIT),
        "--no-warnings",
        "--quiet",
        *_cookie_args(),
        url,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        videos = []
        for line in result.stdout.strip().splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    videos.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return videos
    except subprocess.TimeoutExpired:
        log.warning(f"Timeout fetching {account}")
        return []
    except Exception as e:
        log.error(f"fetch_latest_videos({account}): {e}")
        return []


def get_no_watermark_url(video_url: str) -> Optional[str]:
    """
    Use tikwm.com API to get the no-watermark direct video URL.
    Free, no auth required, returns CDN URL.
    """
    try:
        resp = requests.post(
            "https://www.tikwm.com/api/",
            data={"url": video_url, "hd": "1"},
            timeout=20,
        )
        data = resp.json()
        if data.get("code") == 0 and data.get("data"):
            # 'play' = no watermark, 'wmplay' = watermarked
            return data["data"].get("play") or data["data"].get("wmplay")
    except Exception as e:
        log.warning(f"tikwm API error: {e}")
    return None


def download_video_no_watermark(video_url: str, out_dir: str) -> Optional[str]:
    """
    Download a TikTok video without watermark via tikwm.com API.
    Returns local file path or None on failure.
    """
    direct_url = get_no_watermark_url(video_url)
    if not direct_url:
        log.warning(f"Could not get no-watermark URL for {video_url}")
        return None

    # Extract video ID from URL for filename
    video_id = video_url.rstrip("/").split("/")[-1]
    out_path = os.path.join(out_dir, f"{video_id}.mp4")

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Referer": "https://www.tiktok.com/",
        }
        with requests.get(direct_url, headers=headers, stream=True, timeout=90) as r:
            r.raise_for_status()
            with open(out_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 256):
                    f.write(chunk)
        return out_path
    except Exception as e:
        log.error(f"download_video: {e}")
        return None

# ── Discord ───────────────────────────────────────────────────────────────────

def _retry_after(resp: requests.Response) -> float:
    try:
        return float(resp.json().get("retry_after", 5))
    except Exception:
        return 5.0


def post_video_to_discord(webhook_url: str, video: dict, account: str, file_path: Optional[str]):
    """
    Upload the video file to Discord so it plays inline.
    Falls back to embed-only if the file is too large or missing.
    """
    username   = account.lstrip("@")
    video_url  = video.get("webpage_url") or video.get("url", "")
    title      = (video.get("title") or video.get("description") or "").strip()
    if len(title) > 200:
        title = title[:197] + "..."

    view_count = video.get("view_count", 0)
    like_count = video.get("like_count", 0)

    stats = ""
    if view_count: stats += f"👁 {view_count:,}  "
    if like_count: stats += f"❤️ {like_count:,}"

    caption = f"**@{username}**"
    if title:
        caption += f"\n{title}"
    if stats:
        caption += f"\n{stats.strip()}"
    caption += f"\n{video_url}"

    file_too_large = False
    if file_path:
        size_mb = os.path.getsize(file_path) / (1024 * 1024)
        if size_mb > MAX_DISCORD_MB:
            log.warning(f"File too large ({size_mb:.1f}MB > {MAX_DISCORD_MB}MB), skipping upload")
            file_too_large = True

    for attempt in range(3):
        try:
            if file_path and not file_too_large:
                with open(file_path, "rb") as fh:
                    resp = requests.post(
                        webhook_url,
                        data={"content": caption},
                        files={"file": (os.path.basename(file_path), fh, "video/mp4")},
                        timeout=120,
                    )
            else:
                # Fallback: just post the link (Discord will embed TikTok preview)
                resp = requests.post(
                    webhook_url,
                    json={"content": caption},
                    timeout=30,
                )

            if resp.status_code == 204:
                log.info(f"  Posted {video['id']} ({'file' if file_path and not file_too_large else 'link'})")
                return True
            elif resp.status_code == 429:
                wait = _retry_after(resp)
                log.warning(f"  Rate limited, waiting {wait}s")
                time.sleep(wait)
            else:
                log.error(f"  Discord {resp.status_code}: {resp.text[:200]}")
                return False
        except requests.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(5)

    return False

# ── Core Loop ─────────────────────────────────────────────────────────────────

def check_account(account: str, webhook_url: str, state: dict) -> int:
    """Check one account, download + post any new videos. Returns count posted."""
    log.info(f"Checking @{account.lstrip('@')}...")
    videos = fetch_latest_videos(account)

    if not videos:
        log.info("  No videos returned")
        return 0

    key      = account.lstrip("@").lower()
    seen_ids = set(state.get(key, []))
    new_vids = [v for v in videos if v.get("id") and v["id"] not in seen_ids]

    if not new_vids:
        log.info(f"  Up to date (latest: {videos[0].get('id', '?')})")
        return 0

    log.info(f"  {len(new_vids)} new video(s)")

    # Post oldest-first (chronological order in Discord)
    for video in reversed(new_vids):
        video_url = video.get("webpage_url") or video.get("url", "")

        with tempfile.TemporaryDirectory() as tmp_dir:
            file_path = download_video_no_watermark(video_url, tmp_dir)
            if file_path:
                log.info(f"  Downloaded: {os.path.basename(file_path)} ({os.path.getsize(file_path)//1024}KB)")
            else:
                log.warning(f"  Download failed for {video['id']}, will post link only")

            ok = post_video_to_discord(webhook_url, video, account, file_path)

        if ok:
            seen_ids.add(video["id"])

        time.sleep(2)  # avoid Discord rate limits between posts

    state[key] = list(seen_ids)[-200:]
    return len(new_vids)


def run_loop(cfg: dict):
    accounts    = cfg["accounts"]
    webhook_url = cfg["webhook_url"]
    interval    = cfg.get("interval", DEFAULT_INTERVAL)

    log.info("=" * 60)
    log.info("TikTok → Discord Feed started")
    log.info(f"Accounts : {', '.join(accounts)}")
    log.info(f"Interval : {interval}s")
    log.info(f"State    : {STATE_FILE}")
    log.info(f"Log      : {LOG_FILE}")
    log.info("=" * 60)

    while True:
        # Reload config each cycle — add/remove accounts without restarting
        try:
            cfg = load_config()
            accounts    = cfg["accounts"]
            webhook_url = cfg["webhook_url"]
            interval    = cfg.get("interval", DEFAULT_INTERVAL)
        except Exception as e:
            log.error(f"Config reload failed: {e}")

        state = load_state()
        total = 0
        for account in accounts:
            try:
                total += check_account(account, webhook_url, state)
            except Exception as e:
                log.error(f"Error checking {account}: {e}")
        save_state(state)

        if total:
            log.info(f"Cycle done — posted {total} video(s)")
        else:
            log.info(f"Cycle done — nothing new")

        log.info(f"Sleeping {interval}s...\n")
        time.sleep(interval)


if __name__ == "__main__":
    cfg = load_config()
    try:
        run_loop(cfg)
    except KeyboardInterrupt:
        log.info("Stopped.")
