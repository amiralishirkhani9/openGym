<div align="center">

<img src="assets/banner.png" alt="openGym" width="720">

<br>

# openGym — Offline Persian Edition

**A single-user, 100% offline Android workout & body-weight tracker with full Persian (RTL) support, AI-upscaled exercise media, and zero servers or accounts.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL--3.0-30d158?style=flat-square)](LICENSE)
[![Android APK](https://img.shields.io/badge/Android-APK%20v4-0a84ff?style=flat-square&logo=android&logoColor=white)](https://github.com/amiralishirkhani9/openGym/releases/latest)
[![Tests](https://img.shields.io/github/actions/workflow/status/amiralishirkhani9/openGym/test.yml?branch=offline-fa&style=flat-square&label=Tests)](.github/workflows/test.yml)
[![Release Build](https://img.shields.io/github/actions/workflow/status/amiralishirkhani9/openGym/release-apk.yml?style=flat-square&label=APK%20Build)](.github/workflows/release-apk.yml)

**[📘 مستندات کامل فارسی (README.fa.md)](README.fa.md)** · **[⬇ Download Latest APK](https://github.com/amiralishirkhani9/openGym/releases/latest)**

</div>

---

> Forked from [DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym). While upstream is a self-hosted multi-user web app, this `offline-fa` fork strips away the server, accounts, and passkeys to deliver a standalone offline Android APK tailored for Persian users.

## What's Changed in This Fork (v4)

- **100% Offline & Account-Free:** No backend, no passkeys, no network calls required. All workout logs, routines, and weigh-ins stay locally on your device (`localStorage` + Capacitor `Filesystem` mirror) with one-tap JSON backup/restore.
- **AI-Upscaled 720px Exercise Media (`tools/convert_gym_media_v4.py`):** All 1,324 animations (`gif/*.mp4`) and stills (`img/*.webp`) are bundled inside the APK and neural-upscaled from 180×180 to **720×720** using Real-ESRGAN ONNX (`realesrgan_anime6b` for stills, `realesr-general-x4v3` for clips), plus fullscreen tap-to-zoom and dark-mode contrast tuning.
- **Full Persian (RTL) Localization:**
  - Bundled **Vazirmatn** fonts and complete RTL layout fixes (mirrored navigation chevrons, proper LTR isolation for numbers/sets, fixed switch direction).
  - Offline Persian translations for **all 1,324 exercise names** (`src/locales/ex/fa.js`) and **all 1,324 step-by-step instructions** (`src/instr/fa.js`), with bilingual Persian + English search.
  - **Persian Jalali Calendar** display across the Home strip, charts, and monthly calendar (with a Jalali/Gregorian switcher in Settings), while keeping internal storage ISO-Gregorian.
  - 100% locale key parity across all 12 language packs (`node scripts/check-locales.mjs`).
- **Smart Exercise Modes (Sets & Weights by Exercise Type):**
  - **Weighted lifts:** Sets × Reps × Weight with progression policies (Linear, Greyskull LP, Double).
  - **Unloaded gear:** Bodyweight, bands, rollers, ropes, stability/bosu balls hide the weight column automatically (with optional added-weight toggle); `assisted` gear labels assistance weight clearly.
  - **Stretches & Mobility:** Default to **1 timed round (30s)** with no weight clutter.
  - **Isometric Holds:** Planks, wall sits, dead hangs, and L-sits default to **timed mode (seconds)** with built-in work timer.
  - **Cardio:** Distinguishes machine cardio from bodyweight HIIT (burpees, jump rope) and supports switching between Cardio / Time / Reps.
- **Android-First UX & Automated CI:**
  - Hardware back-button support (`@capacitor/app`), `POST_NOTIFICATIONS` permission for Android 13+, quick-jump exercise pills during active workouts, mid-workout exercise config button, and automated 4-shard CI release APK pipeline (`.github/workflows/release-apk.yml`).
- **Optional AI Coach:** Bring your own OpenAI-compatible or Anthropic API key (`Views/AiCoach.jsx`) to generate/edit plans directly from your training profile and recovery status.

## Build & Release

Automated builds run on GitHub Actions via `.github/workflows/release-apk.yml` (4 parallel media shards + Vitest + Capacitor Android release APK).

For local builds, see [README.fa.md](README.fa.md).

## License

**AGPL-3.0** — see [LICENSE](LICENSE). Upstream credit: [DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym) and [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset).
