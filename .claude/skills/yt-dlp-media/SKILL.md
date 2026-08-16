---
name: yt-dlp-media
description: Download and extract media with yt-dlp (yt-dlp/yt-dlp) — video/audio downloads, audio extraction, subtitles, playlists, format selection. Use when the user wants to download a video, rip audio, grab subtitles/transcripts, archive media, or batch-process URLs from YouTube or the ~1800 other supported sites. Pairs with whisper-transcribe for speech-to-text of downloaded audio.
---

# yt-dlp

Source: [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp). Install: `uv tool install yt-dlp` (or `pipx install yt-dlp`). Needs `ffmpeg` on PATH for merging/conversion. Only download content the user has the right to download; respect each platform's terms.

## Core recipes (verified with v2026.07.04)

```bash
yt-dlp --version                                  # sanity check
yt-dlp URL                                        # best video+audio → merged file
yt-dlp -x --audio-format mp3 URL                  # audio only, mp3
yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]" URL   # cap at 1080p
yt-dlp --write-auto-subs --sub-langs en --skip-download URL   # subtitles only
yt-dlp -o "%(playlist_index)03d - %(title)s.%(ext)s" PLAYLIST_URL
yt-dlp --simulate --print "%(title)s | %(duration_string)s | %(filesize_approx)s" URL
yt-dlp -a urls.txt --download-archive done.txt    # batch + resume-safe archive
```

## Working notes

- `--simulate`/`-J` inspect without downloading; `-J` gives full JSON for scripting.
- For long videos to feed transcription: `-x --audio-format wav --postprocessor-args "-ar 16000 -ac 1"` produces whisper-ready audio.
- Age/region walls: `--cookies-from-browser chrome` uses the user's own login.
- Sandboxed/proxied environments (e.g. Claude Code cloud sessions) often block media hosts; the binary still works — run downloads on a machine with open egress.
- Update often (`uv tool upgrade yt-dlp`): extractors track site changes.
