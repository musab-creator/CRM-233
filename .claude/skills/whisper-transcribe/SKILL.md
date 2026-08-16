---
name: whisper-transcribe
description: Transcribe or translate speech with OpenAI Whisper (openai/whisper) — audio/video to text, SRT/VTT subtitles, language detection, model-size tradeoffs. Use when the user wants to transcribe a recording, meeting, voicemail, video, or podcast, generate subtitles, or translate foreign speech to English text. Pairs with yt-dlp-media for pulling the audio first.
---

# Whisper (speech-to-text)

Source: [openai/whisper](https://github.com/openai/whisper). Install: `uv tool install openai-whisper` (or `pipx install openai-whisper`). Needs `ffmpeg` on PATH. Models auto-download to `~/.cache/whisper` on first use from `openaipublic.azureedge.net` — needs open egress (proxied sandboxes may block it; run on a normal machine).

## Core recipes (package v20250625)

```bash
whisper recording.mp3 --model turbo                       # best speed/quality tradeoff
whisper call.wav --model small --language en --output_format srt
whisper interview.m4a --model medium --task translate     # any language → English text
whisper long.mp3 --model tiny --output_format txt --output_dir out/   # fast draft pass
```

## Model choice

| Model | VRAM/RAM | Speed | Use for |
|---|---|---|---|
| tiny/base | <1–2 GB | fastest | drafts, voicemail, English-only quick passes |
| small | ~2 GB | fast | general English transcription |
| medium | ~5 GB | slower | accented/noisy audio, non-English |
| turbo | ~6 GB | fast | best default when hardware allows |
| large-v3 | ~10 GB | slowest | maximum accuracy, translation |

CPU works (slower); GPU auto-used when available. `.en` variants are slightly better for English-only.

## Working notes

- Feed 16 kHz mono WAV for fastest processing: `ffmpeg -i in.mp4 -ar 16000 -ac 1 out.wav`.
- From a URL: `yt-dlp -x --audio-format wav URL` then transcribe the file.
- Python API: `import whisper; model = whisper.load_model("turbo"); print(model.transcribe("f.mp3")["text"])`.
- Batch: loop files into `--output_dir`; whisper skips nothing, so dedupe yourself.
- For roofing-business use: job-site voice memos → `--model small --output_format txt`, then feed the text to notes-to-one-pager.
