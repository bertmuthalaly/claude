#!/usr/bin/env python3
"""Import Pinboard bookmarks to are.na"""

import argparse
import json
import time
import sys
from pathlib import Path
from typing import Dict, List
import requests
from arena import Arena


# Configuration
PINBOARD_TOKEN = "bgmuthalaly:5FD9220B64ABDA7D78C5"
ARENA_TOKEN = "y17gZmcXRuxc86GUTpo9d5rhO7OBYA6YkU37psX3ehI"
PROGRESS_FILE = "import_progress.json"
RATE_LIMIT = 240  # Requests per minute (buffer below 250)


class PinboardToArena:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.arena = Arena(ARENA_TOKEN)
        self.pinboard_session = requests.Session()
        self.progress = self._load_progress()

    def _load_progress(self) -> Dict:
        """Load previous progress if exists"""
        if Path(PROGRESS_FILE).exists():
            with open(PROGRESS_FILE) as f:
                return json.load(f)
        return {"channel_slug": None, "imported_urls": []}

    def _save_progress(self):
        """Save current progress"""
        with open(PROGRESS_FILE, "w") as f:
            json.dump(self.progress, f, indent=2)

    def fetch_pinboard_bookmarks(self) -> List[Dict]:
        """Fetch all bookmarks from Pinboard"""
        print("Fetching Pinboard bookmarks...")
        url = "https://api.pinboard.in/v1/posts/all"
        params = {"auth_token": PINBOARD_TOKEN, "format": "json"}

        try:
            resp = self.pinboard_session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            bookmarks = resp.json()
            print(f"Found {len(bookmarks)} bookmarks")
            return bookmarks
        except Exception as e:
            print(f"Error fetching bookmarks: {e}")
            sys.exit(1)

    def create_arena_channel(self, title: str = "pinboard"):
        """Create new are.na channel"""
        if self.progress["channel_slug"]:
            print(f"Using existing channel: {self.progress['channel_slug']}")
            return self.arena.channels.channel(self.progress["channel_slug"])

        if self.dry_run:
            print("[DRY RUN] Would create channel: pinboard")
            return None

        print("Creating are.na channel...")
        try:
            channel = self.arena.channels.create(title=title, status="private")
            self.progress["channel_slug"] = channel.slug
            self._save_progress()
            print(f"Created channel: {channel.slug}")
            return channel
        except Exception as e:
            print(f"Error creating channel: {e}")
            sys.exit(1)

    def add_block_to_channel(self, channel, url: str, description: str) -> bool:
        """Add a bookmark as a block to are.na channel"""
        if self.dry_run:
            print(f"[DRY RUN] Would import: {url}")
            return True

        max_retries = 3
        for attempt in range(max_retries):
            try:
                channel.add_block(source=url, description=description)
                return True
            except Exception as e:
                if attempt == max_retries - 1:
                    print(f"Failed to import {url}: {e}")
                    return False
                time.sleep(2 ** attempt)  # Exponential backoff
        return False

    def import_bookmarks(self):
        """Main import logic"""
        bookmarks = self.fetch_pinboard_bookmarks()
        channel = self.create_arena_channel()

        # Filter out already imported
        to_import = [
            b for b in bookmarks
            if b["href"] not in self.progress["imported_urls"]
        ]

        if not to_import:
            print("All bookmarks already imported!")
            return

        # Sort oldest to newest to preserve chronological order in are.na
        to_import.sort(key=lambda b: b.get("time", ""))
        print(f"Importing {len(to_import)} bookmarks (oldest to newest)...")
        if self.dry_run:
            print("[DRY RUN] No actual imports will be made\n")

        successful = 0
        failed = 0
        batch_delay = 60.0 / RATE_LIMIT  # Delay between requests

        for i, bookmark in enumerate(to_import, 1):
            url = bookmark["href"]
            desc = bookmark.get("extended", "")
            title = bookmark.get("description", "")

            # Combine title and description
            full_desc = f"{title}\n\n{desc}".strip() if title and desc else (title or desc)

            print(f"[{i}/{len(to_import)}] {url[:60]}...")

            if self.add_block_to_channel(channel, url, full_desc):
                successful += 1
                if not self.dry_run:
                    self.progress["imported_urls"].append(url)
                    if i % 10 == 0:  # Save progress every 10 bookmarks
                        self._save_progress()
            else:
                failed += 1

            # Rate limiting
            if i < len(to_import):
                time.sleep(batch_delay)

        if not self.dry_run:
            self._save_progress()

        print(f"\n✓ Successfully imported: {successful}")
        if failed > 0:
            print(f"✗ Failed: {failed}")

        if not self.dry_run:
            print(f"\nChannel: https://www.are.na/{self.progress['channel_slug']}")


def main():
    parser = argparse.ArgumentParser(description="Import Pinboard bookmarks to are.na")
    parser.add_argument("--dry-run", action="store_true", help="Preview imports without making changes")
    parser.add_argument("--reset", action="store_true", help="Reset progress and start fresh")
    args = parser.parse_args()

    if args.reset and Path(PROGRESS_FILE).exists():
        Path(PROGRESS_FILE).unlink()
        print("Progress reset")

    importer = PinboardToArena(dry_run=args.dry_run)
    importer.import_bookmarks()


if __name__ == "__main__":
    main()
