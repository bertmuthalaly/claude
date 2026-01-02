# Pinboard to Are.na Importer

Import all your Pinboard bookmarks to an are.na channel.

## Setup

```bash
pip install -r requirements.txt
```

## Usage

**Dry run** (preview what will be imported):
```bash
python pinboard_to_arena.py --dry-run
```

**Actual import**:
```bash
python pinboard_to_arena.py
```

**Reset progress** (start fresh):
```bash
python pinboard_to_arena.py --reset
```

## Features

- **Rate limiting**: Respects are.na's 250 req/min limit (uses 240/min buffer)
- **Resume capability**: Saves progress to `import_progress.json` - can safely stop and restart
- **Error handling**: Retries failed requests with exponential backoff
- **Dry-run mode**: Preview imports before committing

## Progress Tracking

The script saves progress automatically. If interrupted, just run again to resume.

To completely start over: `python pinboard_to_arena.py --reset`
