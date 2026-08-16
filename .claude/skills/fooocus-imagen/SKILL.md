---
name: fooocus-imagen
description: Run Fooocus (lllyasviel/Fooocus) for local Stable Diffusion XL image generation — setup, GPU requirements, presets, prompt workflow. Use when the user wants to generate images locally with Fooocus, set it up on a machine, troubleshoot its launch, or decide between local Fooocus and cloud image tools.
---

# Fooocus (local SDXL image generation)

Source: [lllyasviel/Fooocus](https://github.com/lllyasviel/Fooocus) (GPLv3). A Midjourney-style local UI over SDXL: you write prompts, it handles model plumbing. Note: upstream is in limited-maintenance mode (v2.5.5) — stable, but not gaining features.

## Requirements — check first

- **GPU strongly recommended**: NVIDIA ≥4 GB VRAM (GTX 1060+), AMD/ROCm or Apple Silicon supported with flags; CPU-only works but takes minutes per image (`--always-cpu`).
- ~25 GB disk: SDXL base model (~6.5 GB) + refiner/LoRAs download automatically on first launch from Hugging Face — needs open egress.

## Setup (Linux/macOS)

```bash
git clone --depth 1 https://github.com/lllyasviel/Fooocus
cd Fooocus
uv venv .venv && VIRTUAL_ENV=$PWD/.venv uv pip install -r requirements_versions.txt
.venv/bin/python launch.py            # UI at http://127.0.0.1:7865
```

Windows: use the official one-click package from the repo README instead.

Useful flags: `--preset realistic|anime` (different model sets), `--always-cpu`, `--disable-preset-download` (skip weights; UI needs them to generate), `--listen 0.0.0.0 --port N` (LAN access), `--share` (temporary public gradio URL — avoid for private work).

## Prompt workflow

- Fooocus applies its own prompt expansion ("GPT-2 style") — write short, concrete prompts; put unwanted elements in the negative prompt box.
- Speed/quality: Performance = Speed (30 steps) for drafts, Quality (60) for finals; Extreme Speed uses LCM for near-realtime drafts.
- Styles panel stacks curated style presets — fewer, deliberate styles beat many stacked ones.

## Sandbox finding (2026-08-16)

In a proxied cloud container the code and dependencies install and `launch.py` boots to the model-download step, but Hugging Face is blocked, so weights can't fetch — run Fooocus on real hardware with open egress. Cloud alternative when no GPU exists: use the session's image-generation tools instead and reserve Fooocus for the workstation.
