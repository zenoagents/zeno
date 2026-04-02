---
name: dropbox
description: Sync local session data to Dropbox for backup and recovery. Use when asked to upload files from the workspace sessions directory to Dropbox, create timestamped backup snapshots, or verify session backup status.
---

# Dropbox Session Sync

## Required configuration

- Set `DROPBOX_ACCESS_TOKEN`, or configure `dropbox.access_token` in `credentials.toml`.
- Optionally set `DROPBOX_SESSION_REMOTE_PATH`, or configure `dropbox.session_remote_path` in `credentials.toml`.
- Default Dropbox destination is `/zeno/session-data/session-data-latest.tar.gz`.

## Primary command

Run the sync script:

```bash
npm run sessions:sync:dropbox
```

## Common variants

- Write to a specific Dropbox path:

```bash
npm run sessions:sync:dropbox -- --remote-path /zeno/session-data/custom-name.tar.gz
```

- Keep a dated history snapshot instead of overwriting the latest archive:

```bash
npm run sessions:sync:dropbox -- --keep-history
```

- Dry-run to validate archive size and destination without uploading:

```bash
npm run sessions:sync:dropbox -- --dry-run
```

## Behavior

- Compresses the local `sessions` directory into a temporary `.tar.gz` archive.
- Uploads that archive to Dropbox via the Dropbox files upload API.
- Verifies the uploaded file with a metadata check and reports remote path and size.

## Safety defaults

- Never print the Dropbox access token.
- Prefer `--dry-run` before the first live sync in a new environment.
- Use `--keep-history` when data retention matters.
