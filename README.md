# 🎬 Seedance Studio

A personal video generation studio and AI "director" chatbot for **ByteDance Seedance 2.5** on **Together AI**.

- **Director chat**: describe an idea in plain language (or drop in images). The assistant writes a detailed Seedance prompt covering shots, camera, lighting and sound, then proposes a generation you can edit and confirm. It can also start generating straight away if you turn confirmations off.
- **Studio**: full manual control over every Seedance 2.5 mode:
  - Text → Video
  - Image → Video (first frame, or first + last frame interpolation)
  - Reference-guided (up to 30 images, 10 videos, 10 audio tracks)
  - Resolution 480p / 720p, duration 4–30 s or `auto`, 1–4 variations per click
  - ✨ AI prompt enhancer, 🎬 multi-shot storyboard builder, and style, camera and sound presets
  - A live cost estimate, plus a confirmation when a generation costs more than your threshold
- **Gallery**: every generation is saved locally (Together's video URLs expire). Search, favorite, download, **Remix**, **Extend** (uses the last frame as the first frame of a new shot), and **Use as reference**.
- Generations keep rendering and downloading in the background, even if you close the browser tab.

No dependencies: just Node.js 18 or newer.

## Run it

```bash
cp .env.example .env        # then put your Together API key in .env
npm start                   # or: node server.js
```

Open http://localhost:3000.

The server listens on `127.0.0.1` by default, so only your own machine can reach it. Set `HOST=0.0.0.0` in `.env` to use it from other devices on your network. There is no login, so only do that on a network you trust.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `TOGETHER_API_KEY` | (none) | Required |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | |
| `CHAT_MODEL` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | Default model for the director chat. You can also change it in ⚙️ Settings. |

## Seedance 2.5 notes

- Pricing: 480p is **$0.115/s**; 720p starts at **$0.249/s** and costs more with reference videos. A 5 s 720p clip costs about $1.25. Together doesn't return a per-job cost for this model, so the spend counter uses these rates.
- Audio is always generated, so describe the dialogue, sound effects and music you want.
- There is no aspect-ratio, width/height or 1080p control. Output is capped at 720p.
- First/last frame images can't be combined with reference inputs in the same request.
- Reference videos and audio work best as public `https://` URLs. Uploaded files are sent as base64, which Together may reject.
- Typical render time is 2–5 minutes.

## Data

Everything lives in `./data`, which is gitignored:

- `db.json`: history, chats and settings
- `videos/`: the MP4s
- `uploads/`: images you've attached

Back up that folder to keep your library.

## Optional

If `ffmpeg` is installed, **Extend** can grab the last frame on the server when your browser can't decode the MP4 (some Linux browsers lack H.264).
