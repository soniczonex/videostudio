# 🎬 Seedance Studio

**A self-hosted video generation studio and AI "director" chatbot for ByteDance Seedance 2.5, powered by [Together AI](https://together.ai).**

Describe a scene in plain language and a director chatbot turns it into a detailed, shot-by-shot Seedance prompt (camera, lighting, sound, dialogue), shows you the estimated cost, and renders it. Or skip the chat and drive every Seedance 2.5 option yourself in the Studio. Every clip lands in a local gallery where you can remix it, extend it into the next shot, or reuse it as a reference.

It's a single Node.js server and a plain HTML/JS front end. **No npm dependencies, no build step, no database.** Clone it, add your API key, run `npm start`.

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Using the app](#using-the-app)
- [Seedance 2.5 notes and limits](#seedance-25-notes-and-limits)
- [Costs](#costs)
- [Where your data lives](#where-your-data-lives)
- [How it works](#how-it-works)
- [HTTP API](#http-api)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Contributing](#contributing)

---

## Features

### 🗣️ Director chat
- Describe an idea in plain language, or drop images into the conversation.
- The assistant writes a rich Seedance prompt (usually 60 to 250 words) covering subject, action, environment, lighting, film look, camera moves, pacing and sound.
- It proposes a generation as an editable card with the estimated cost. You tweak and click **Generate**, or turn confirmations off and let it render straight away.
- It understands the image modes: animate a photo (first frame), interpolate between two images (first + last frame), or keep a character, product or style consistent (reference images).
- It can propose up to four variations in one turn, and remembers the videos it already made in the chat.
- Choose the chat model in ⚙️ Settings. Vision models can "see" the images you attach:

  | Model | Vision |
  |---|---|
  | `deepseek-ai/DeepSeek-V4.1-Flash-1017` (default) | ✅ |
  | `zai-org/GLM-5.3-Flash` | ✅ |
  | `MiniMaxAI/MiniMax-M3` | ✅ |
  | `openai/gpt-oss-120b` | text only |

### 🎛️ Studio (manual mode)
Full control over every Seedance 2.5 mode:
- **Text → Video**
- **Image → Video**: first frame, or first + last frame interpolation
- **Reference-guided**: up to 30 reference images, 10 reference videos and 10 reference audio tracks
- Resolution 480p or 720p, duration 4 to 30 seconds or `auto`, and 1 to 4 variations per click
- ✨ **AI prompt enhancer** that rewrites a rough idea into a detailed prompt
- 🎬 **Multi-shot storyboard builder** ("Shot 1: … Cut to Shot 2: …")
- Style, camera and sound presets
- A live cost estimate, plus a confirmation step whenever a generation costs more than your threshold
- `Ctrl`/`⌘` + `Enter` to generate

### 🖼️ Gallery
- Every generation is downloaded and saved locally, because Together's video URLs expire.
- Search, favorite, download and delete.
- **Remix**: reopen a clip's settings in the Studio.
- **Extend**: grab the last frame and use it as the first frame of a new shot, so you can chain clips into longer sequences.
- **As reference**: feed a clip back in as a reference video.
- A running spend counter.

### ⚙️ Under the hood
- Jobs keep rendering and downloading in the background, even if you close the browser tab. Pending jobs resume when the server restarts.
- Images whose short side is under 300 px are upscaled automatically (with `sips` on macOS or `ffmpeg` elsewhere), so Seedance doesn't reject them minutes into a render.
- Inputs are validated against Seedance's limits before anything is sent, so you don't pay for a request that was going to fail.

---

## Quick start

**Requirements:** [Node.js](https://nodejs.org) 18 or newer and a [Together AI API key](https://api.together.ai/settings/api-keys).

```bash
git clone https://github.com/soniczonex/videostudio.git
cd videostudio
cp .env.example .env      # then paste your key after TOGETHER_API_KEY=
npm start                 # or: node server.js
```

Open **http://localhost:3000** and start chatting.

> **Note:** Seedance 2.5 is a paid model. Every generation is billed to your Together account. See [Costs](#costs).

---

## Configuration

Settings are read from `.env` in the project folder (or from real environment variables, which take precedence).

| Variable | Default | Description |
|---|---|---|
| `TOGETHER_API_KEY` | *(none)* | **Required.** Your Together AI API key. |
| `PORT` | `3000` | Port the server listens on. |
| `HOST` | `127.0.0.1` | Interface to bind. The default only allows your own machine. See [Security](#security) before changing it. |
| `CHAT_MODEL` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | Default model for the director chat. You can also change it per install in ⚙️ Settings. |

These options live in ⚙️ **Settings** inside the app:

| Setting | Default | Description |
|---|---|---|
| Chat model | from `CHAT_MODEL` | Which model the director uses. |
| Confirm before generating | on | When on, the director creates a proposal card you approve. When off, it renders immediately. |
| Default resolution | `720p` | Used when you or the director don't specify one. |
| Default duration | `5` s | Same as above. |
| Spend warning | `$5` | Ask for confirmation when a single generation is estimated above this amount. |

---

## Using the app

**Make a video from an idea.** Open the chat and type something like *"a corgi surfing a huge wave at golden hour, slow motion, epic orchestral music"*. The director writes the full prompt and shows a proposal card with duration, resolution and estimated cost. Edit anything you like, then click **Generate**. Renders typically take 2 to 5 minutes, and the card updates when the clip is ready.

**Animate a photo.** Attach an image and say *"bring this to life, the camera slowly pushes in"*. The director uses it as the first frame. Attach two images and ask for a transition to interpolate from the first to the second.

**Keep a character consistent.** Attach a few photos of the same person, product or art style and ask for a new scene "featuring the woman from reference image 1". The director switches to reference mode.

**Tell a longer story.** Ask for a multi-shot sequence (10 to 15 seconds works well), or render a clip and press **Extend** in the gallery to continue from its last frame.

**Go manual.** Switch to the **Studio** tab to set every parameter yourself, use the prompt enhancer and storyboard builder, and render several variations at once.

---

## Seedance 2.5 notes and limits

- **Audio is always generated.** Describe the dialogue (in quotes, with who says it), sound effects, ambience and music you want.
- **Resolution:** 480p or 720p. There is no 1080p, aspect-ratio or width/height control.
- **Duration:** a whole number from 4 to 30 seconds, or `auto`.
- **Prompts:** English or Chinese, 2 to 10,000 characters.
- **Frame images can't be combined with reference inputs** in the same request.
- **Image size:** each side must be 300 to 6,000 px. Smaller images are upscaled automatically when `sips` or `ffmpeg` is available.
- **Reference videos and audio** work best as public `https://` URLs. Uploaded files are sent as base64, which Together may reject.
- **Render time** is typically 2 to 5 minutes.

---

## Costs

Together bills Seedance 2.5 per second of output video:

| Resolution | Price | 5 s clip | 10 s clip |
|---|---|---|---|
| 480p | $0.115 / s | ≈ $0.58 | ≈ $1.15 |
| 720p | from $0.249 / s | ≈ $1.25 | ≈ $2.49 |

720p costs more when you use reference videos. Together doesn't return a per-job cost for this model, so the in-app spend counter is an **estimate** based on these rates. Your Together dashboard is the source of truth. The chat model calls (director and prompt enhancer) are billed separately at Together's normal token rates and are usually a fraction of a cent each.

---

## Where your data lives

Everything is stored locally in `./data`, which is gitignored:

```
data/
├── db.json     # generation history, chats and settings
├── videos/     # downloaded MP4s
└── uploads/    # images you've attached
```

Back up this folder to keep your library. Delete it to start fresh.

---

## How it works

```
 Browser (public/)                Node server (server.js)                 Together AI
┌──────────────────┐   JSON    ┌───────────────────────────┐   HTTPS   ┌──────────────────┐
│ Chat · Studio ·  │ ────────▶ │ validates params, stores   │ ───────▶ │ /v2/videos        │
│ Gallery          │ ◀──────── │ uploads, polls jobs,       │ ◀─────── │ (Seedance 2.5)    │
└──────────────────┘   polls   │ downloads finished MP4s    │           │ chat completions  │
                               │ into ./data                │           │ (director, tools) │
                               └───────────────────────────┘           └──────────────────┘
```

1. The **director** is a chat model with a system prompt that knows Seedance's capabilities and best practices, plus a `generate_video` tool. When it calls the tool, the server turns the arguments into a validated Seedance request, either as a proposal card or as an immediate job.
2. The server creates the job on Together's `/v2/videos` endpoint, then **polls** it in the background until it completes, fails or is cancelled.
3. Finished videos are **downloaded** into `data/videos/` right away, since Together's URLs expire.
4. The front end polls the server for status, so you can close the tab and come back later.

---

## HTTP API

The front end talks to a small JSON API on the same server. It's handy for scripting.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | Models, limits, pricing and whether a key is set |
| `PUT` | `/api/settings` | Update settings |
| `POST` | `/api/uploads` | Upload an image/video/audio as a data URL |
| `GET` | `/api/videos` | List generations and the spend summary |
| `POST` | `/api/videos` | Create a generation |
| `POST` | `/api/videos/import` | Import an existing Together job by id |
| `GET` | `/api/videos/:id` | Get (and refresh) one generation |
| `PATCH` | `/api/videos/:id` | Rename or favorite |
| `DELETE` | `/api/videos/:id` | Delete a generation and its file |
| `POST` | `/api/videos/:id/lastframe` | Extract the last frame with ffmpeg |
| `POST` | `/api/enhance` | Rewrite a prompt with the AI enhancer |
| `GET` / `POST` | `/api/chats` | List or create chats |
| `GET` / `PATCH` / `DELETE` | `/api/chats/:id` | Read, rename or delete a chat |
| `POST` | `/api/chats/:id/messages` | Send a message to the director |

Media is served from `/media/videos/…` and `/media/uploads/…`.

---

## Project structure

```
.
├── server.js          # HTTP server, Together API client, job polling, director chat, storage
├── public/
│   ├── index.html     # app shell: Chat, Studio and Gallery tabs
│   ├── app.js         # front-end logic (vanilla JS)
│   └── styles.css
├── .env.example       # copy to .env and add your key
└── package.json       # no dependencies, just `npm start`
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "TOGETHER_API_KEY is not set" | Copy `.env.example` to `.env`, paste your key, and restart the server. |
| Image rejected for size | Each side must be 300 to 6,000 px. Install `ffmpeg` (Linux/Windows) for automatic upscaling, or use a larger image. |
| Reference video or audio rejected | Host it at a public `https://` URL instead of uploading it. |
| **Extend** can't grab the last frame | Some Linux browsers can't decode H.264. Install `ffmpeg` so the server can extract the frame instead. |
| A job seems stuck | Renders take 2 to 5 minutes. Pending jobs resume polling after a server restart. |
| Port 3000 is in use | Set `PORT=3001` (or any free port) in `.env`. |

---

## Security

- **Your API key stays on the server.** It's read from `.env` and never sent to the browser. `.env` is gitignored, so never commit it.
- **There is no login.** Anyone who can reach the server can generate videos on your account. That's why it binds to `127.0.0.1` by default. Only set `HOST=0.0.0.0` on a network you trust, and don't expose it to the internet without putting authentication in front of it (for example a reverse proxy with basic auth, or a private network like Tailscale).

---

## Contributing

Issues and pull requests are welcome. The code is intentionally dependency-free, so please keep it that way: plain Node.js built-ins on the server and vanilla JS in the browser.

---

<sub>Seedance is a model by ByteDance, served via Together AI. This project is not affiliated with either.</sub>
