#!/usr/bin/env node
// Seedance Studio — a personal Seedance 2.5 video generation studio and chatbot
// powered by Together AI. Zero dependencies: requires Node.js 18+.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = __dirname;
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.TOGETHER_API_KEY || '';
const API_BASE = 'https://api.together.xyz';
const VIDEO_MODEL = 'ByteDance/Seedance-2.5';

const DATA_DIR = path.join(ROOT, 'data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Chat models verified to be serverless on Together. Vision models can "see"
// images attached in chat; all of them support tool calling.
const CHAT_MODELS = [
  { id: 'zai-org/GLM-5.3-Flash', label: 'GLM 5.3 Flash (vision, fast)', vision: true },
  { id: 'MiniMaxAI/MiniMax-M3', label: 'MiniMax M3 (vision)', vision: true },
  { id: 'openai/gpt-oss-120b', label: 'gpt-oss 120B (text only)', vision: false },
];
const DEFAULT_CHAT_MODEL = process.env.CHAT_MODEL || CHAT_MODELS[0].id;

// Seedance 2.5 limits (from Together's Seedance 2.5 docs)
const LIMITS = {
  minSeconds: 4,
  maxSeconds: 30,
  resolutions: ['480p', '720p'],
  maxFrameImages: 2,
  maxReferenceImages: 30,
  maxReferenceVideos: 10,
  maxReferenceAudios: 10,
  promptMin: 2,
  promptMax: 10000,
};
// USD per second of output ($0.249/s is the 720p floor; video references cost more).
const PRICING = { '480p': 0.115, '720p': 0.249 };

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ico': 'image/x-icon',
};
const EXT_FOR_MIME = Object.fromEntries(
  Object.entries(MIME).map(([ext, mime]) => [mime.split(';')[0], ext]).reverse(),
);

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------------------------------------------------------------------------
// Tiny JSON "database"
// ---------------------------------------------------------------------------

fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let db = { videos: [], chats: [], uploads: [], settings: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 150);
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const now = () => Date.now();
const settings = () => ({
  chatModel: DEFAULT_CHAT_MODEL,
  confirmBeforeGenerate: true,
  defaultResolution: '720p',
  defaultSeconds: 5,
  spendWarning: 5,
  ...db.settings,
});

// ---------------------------------------------------------------------------
// Together API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function together(method, pathname, body) {
  if (!API_KEY) throw new ApiError(500, 'TOGETHER_API_KEY is not set. Add it to .env and restart.');
  const res = await fetch(API_BASE + pathname, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || json?.raw || res.statusText;
    throw new ApiError(res.status, `Together API ${res.status}: ${msg}`, json);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Uploads (images / video / audio kept locally; images are sent as base64)
// ---------------------------------------------------------------------------

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new ApiError(400, 'Invalid data URL');
  return { mime: m[1], buffer: Buffer.from(m[3], m[2] ? 'base64' : 'utf8') };
}

async function saveUpload({ dataUrl, name }) {
  const { mime, buffer } = parseDataUrl(dataUrl);
  const kind = mime.split('/')[0];
  if (!['image', 'video', 'audio'].includes(kind)) throw new ApiError(400, `Unsupported file type ${mime}`);
  if (buffer.length > 30 * 1024 * 1024) throw new ApiError(400, 'File too large (max 30 MB)');
  const id = newId('up');
  const ext = EXT_FOR_MIME[mime] || path.extname(name || '') || '.bin';
  const file = id + ext;
  await fsp.writeFile(path.join(UPLOADS_DIR, file), buffer);
  const upload = { id, name: name || file, mime, kind, file, size: buffer.length, url: `/media/uploads/${file}`, createdAt: now() };
  db.uploads.push(upload);
  save();
  return upload;
}

function uploadById(id) {
  return db.uploads.find((u) => u.id === id);
}

async function uploadAsDataUrl(id) {
  const u = uploadById(id);
  if (!u) throw new ApiError(400, `Unknown upload ${id}`);
  const buf = await fsp.readFile(path.join(UPLOADS_DIR, u.file));
  return `data:${u.mime};base64,${buf.toString('base64')}`;
}

// A media "ref" from the client is either { upload: 'up_xxx' } or { url: 'https://…' }.
async function resolveRef(ref) {
  if (typeof ref === 'string') return ref.startsWith('up_') ? uploadAsDataUrl(ref) : ref;
  if (ref?.upload) return uploadAsDataUrl(ref.upload);
  if (ref?.url) return ref.url;
  throw new ApiError(400, 'Invalid media reference');
}

// ---------------------------------------------------------------------------
// Video generation
// ---------------------------------------------------------------------------

function estimateCost(resolution, seconds) {
  const s = seconds === 'auto' ? 10 : Number(seconds);
  return +(PRICING[resolution] * s).toFixed(3);
}

function validateParams(p) {
  const prompt = String(p.prompt || '').trim();
  if (prompt.length < LIMITS.promptMin) throw new ApiError(400, 'Prompt is too short.');
  if (prompt.length > LIMITS.promptMax) throw new ApiError(400, `Prompt exceeds ${LIMITS.promptMax} characters.`);
  const resolution = LIMITS.resolutions.includes(p.resolution) ? p.resolution : '720p';
  let seconds = p.seconds === 'auto' ? 'auto' : Math.round(Number(p.seconds || 5));
  if (seconds !== 'auto' && !(seconds >= LIMITS.minSeconds && seconds <= LIMITS.maxSeconds)) {
    throw new ApiError(400, `Duration must be ${LIMITS.minSeconds}–${LIMITS.maxSeconds} seconds (or auto).`);
  }
  const m = p.media || {};
  const frames = (m.frameImages || []).filter((f) => f && f.ref);
  const refImages = (m.referenceImages || []).filter(Boolean);
  const refVideos = (m.referenceVideos || []).filter(Boolean);
  const refAudios = (m.referenceAudios || []).filter(Boolean);
  if (frames.length > LIMITS.maxFrameImages) throw new ApiError(400, 'At most 2 frame images (first + last).');
  if (refImages.length > LIMITS.maxReferenceImages) throw new ApiError(400, 'At most 30 reference images.');
  if (refVideos.length > LIMITS.maxReferenceVideos) throw new ApiError(400, 'At most 10 reference videos.');
  if (refAudios.length > LIMITS.maxReferenceAudios) throw new ApiError(400, 'At most 10 reference audios.');
  if (frames.length && (refImages.length || refVideos.length || refAudios.length)) {
    throw new ApiError(400, 'Frame images (first/last frame) cannot be combined with reference inputs. Pick one mode.');
  }
  return { prompt, resolution, seconds, frames, refImages, refVideos, refAudios };
}

function modeOf(v) {
  if (v.frames.length) return v.frames.length === 2 ? 'first-last' : 'image-to-video';
  if (v.refAudios.length) return 'audio-guided';
  if (v.refImages.length || v.refVideos.length) return 'reference';
  return 'text-to-video';
}

async function createVideo(params, { chatId, source = 'studio' } = {}) {
  const v = validateParams(params);
  const body = { model: VIDEO_MODEL, prompt: v.prompt, resolution: v.resolution, seconds: String(v.seconds) };
  const media = {};
  if (v.frames.length) {
    media.frame_images = await Promise.all(v.frames.map(async (f, i) => ({
      input_image: await resolveRef(f.ref),
      frame: f.frame === 'last' || (!f.frame && i === 1) ? 'last' : 'first',
    })));
  }
  if (v.refImages.length) media.reference_images = await Promise.all(v.refImages.map(resolveRef));
  if (v.refVideos.length) media.reference_videos = await Promise.all(v.refVideos.map(async (r) => ({ video: await resolveRef(r) })));
  if (v.refAudios.length) media.reference_audios = await Promise.all(v.refAudios.map(resolveRef));
  if (Object.keys(media).length) body.media = media;

  const job = await together('POST', '/v2/videos', body);

  const record = {
    id: job.id,
    status: job.status || 'queued',
    prompt: v.prompt,
    resolution: v.resolution,
    seconds: String(v.seconds),
    mode: modeOf(v),
    // keep refs (upload ids / urls), never the base64 blobs
    media: { frameImages: v.frames, referenceImages: v.refImages, referenceVideos: v.refVideos, referenceAudios: v.refAudios },
    estimatedCost: estimateCost(v.resolution, v.seconds),
    cost: null,
    remoteUrl: null,
    localFile: null,
    error: job.error || null,
    chatId: chatId || null,
    source,
    title: params.title || null,
    favorite: false,
    createdAt: now(),
    completedAt: null,
  };
  if (job.status === 'failed') record.error = job.error || { message: 'Generation failed' };
  db.videos.unshift(record);
  save();
  return record;
}

const refreshing = new Map();
function refreshVideo(record) {
  if (TERMINAL.has(record.status) && (record.status !== 'completed' || record.localFile)) return Promise.resolve(record);
  if (refreshing.has(record.id)) return refreshing.get(record.id);
  const p = (async () => {
    const job = await together('GET', `/v2/videos/${encodeURIComponent(record.id)}`);
    record.status = job.status || record.status;
    if (job.error) record.error = job.error;
    if (job.outputs) {
      record.cost = job.outputs.cost ?? record.cost;
      record.remoteUrl = job.outputs.video_url || record.remoteUrl;
    }
    if (job.completed_at) record.completedAt = job.completed_at * 1000;
    if (record.status === 'completed' && record.remoteUrl && !record.localFile) {
      await downloadVideo(record);
    }
    save();
    return record;
  })().finally(() => refreshing.delete(record.id));
  return p;
}

async function downloadVideo(record) {
  const res = await fetch(record.remoteUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const file = `${record.id}.mp4`;
  const tmp = path.join(VIDEOS_DIR, file + '.part');
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await fsp.rename(tmp, path.join(VIDEOS_DIR, file));
  record.localFile = file;
  console.log(`✔ Saved ${file}`);
}

// Background poller so videos are downloaded even if the browser is closed.
async function pollPending() {
  const pending = db.videos.filter((v) => !TERMINAL.has(v.status) || (v.status === 'completed' && !v.localFile));
  for (const v of pending) {
    try {
      await refreshVideo(v);
    } catch (e) {
      v.pollErrors = (v.pollErrors || 0) + 1;
      if (v.pollErrors > 40 && v.status === 'completed') v.status = 'failed', v.error = { message: `Could not download: ${e.message}` };
      console.warn(`poll ${v.id}: ${e.message}`);
    }
  }
}
setInterval(() => pollPending().catch(() => {}), 10_000);

function publicVideo(v) {
  return { ...v, url: v.localFile ? `/media/videos/${v.localFile}` : null };
}

function spendSummary() {
  let total = 0;
  let seconds = 0;
  let count = 0;
  for (const v of db.videos) {
    if (v.status !== 'completed') continue;
    total += Number(v.cost ?? v.estimatedCost ?? 0);
    seconds += Number(v.seconds) || 0;
    count++;
  }
  return { total: +total.toFixed(3), seconds, count };
}

// ---------------------------------------------------------------------------
// LLM: chat director + prompt enhancer
// ---------------------------------------------------------------------------

const SEEDANCE_GUIDE = `
Seedance 2.5 (ByteDance, via Together AI) capabilities:
- Text-to-video, image-to-video (first frame, or first + last frame), reference-guided (up to 30 reference images, 10 reference videos), and audio-guided (plus up to 10 reference audios).
- Frame images CANNOT be combined with reference inputs in one request.
- Duration: integer 4–30 seconds, or "auto". Resolution: 480p ($0.115/s) or 720p (from $0.249/s). No aspect-ratio/width/height control.
- Native synchronized audio is ALWAYS generated (dialogue, sound effects, ambience, music). Describe the sound you want.
- Supports multi-shot videos in one generation: describe each shot and the transitions ("Shot 1: … Cut to Shot 2: …").
- Prompts can be English or Chinese, up to 10,000 characters.
Prompt-writing best practice: subject + appearance, action/motion, environment, lighting, style/film look, camera (shot size, lens, movement: dolly, pan, orbit, crane, handheld, tracking), pacing, and sound (dialogue in quotes with who says it, SFX, music, ambience). Be concrete and visual; avoid vague adjectives. For reference images, say how each is used ("the woman from reference image 1", "in the style of reference image 2").`;

function chatSystemPrompt(s) {
  return `You are "Director", a friendly expert AI film director and prompt engineer inside Seedance Studio, a personal app for generating videos with Seedance 2.5.
${SEEDANCE_GUIDE}

How to behave:
- Help the user brainstorm, write storyboards, and craft excellent Seedance prompts. Keep replies concise and use markdown.
- When the user wants a video, call the generate_video tool with a rich, detailed prompt (usually 60–250 words) — don't just echo their words. If their request is very vague, you may ask ONE quick clarifying question, but prefer making tasteful creative choices.
- Default to ${s.defaultResolution} and ${s.defaultSeconds} seconds unless the user asks otherwise or the content clearly needs more time (multi-shot stories often need 10–15s).
- Images the user attached have ids like up_xxxx (shown in the conversation). To animate a photo, use image_mode "first_frame"; to interpolate between two images use "first_last"; to keep a character/product/style consistent in a new scene use "reference".
- ${s.confirmBeforeGenerate
    ? 'Generation requires the user to click "Generate" on the proposal card you create, so tell them the proposal is ready and mention the estimated cost.'
    : 'Generation starts immediately when you call the tool, so mention the estimated cost.'}
- You can propose several variations by calling the tool multiple times in one turn (max 4), but only when asked.
- Previous videos in this chat are summarized as [Video …] notes with their status.
- Never invent capabilities Seedance doesn't have (e.g. no aspect ratio control, no 1080p).`;
}

const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'generate_video',
      description: 'Create a Seedance 2.5 video generation (or a proposal the user confirms). Returns the job id and estimated cost.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short 2–5 word title for this video.' },
          prompt: { type: 'string', description: 'The full, detailed Seedance prompt including visuals, camera and sound.' },
          seconds: { type: 'integer', minimum: 4, maximum: 30, description: 'Duration in seconds (4–30).' },
          resolution: { type: 'string', enum: ['480p', '720p'] },
          image_mode: {
            type: 'string',
            enum: ['none', 'first_frame', 'first_last', 'reference'],
            description: 'How to use attached images. none = text-to-video.',
          },
          image_ids: { type: 'array', items: { type: 'string' }, description: 'Upload ids (up_xxx) of attached images to use, in order.' },
          reference_video_urls: { type: 'array', items: { type: 'string' }, description: 'Public https URLs of reference videos (reference mode only).' },
          reference_audio_urls: { type: 'array', items: { type: 'string' }, description: 'Public https URLs of reference audio (reference mode only).' },
        },
        required: ['prompt'],
      },
    },
  },
];

function toolArgsToParams(args, s) {
  const mode = args.image_mode || (args.image_ids?.length ? 'reference' : 'none');
  const ids = (args.image_ids || []).filter((id) => uploadById(id)?.kind === 'image');
  const media = { frameImages: [], referenceImages: [], referenceVideos: [], referenceAudios: [] };
  if (mode === 'first_frame' && ids[0]) media.frameImages = [{ ref: { upload: ids[0] }, frame: 'first' }];
  else if (mode === 'first_last' && ids.length) {
    media.frameImages = ids.slice(0, 2).map((id, i) => ({ ref: { upload: id }, frame: i ? 'last' : 'first' }));
  } else if (mode === 'reference' || args.reference_video_urls?.length || args.reference_audio_urls?.length) {
    media.referenceImages = ids.slice(0, 30).map((id) => ({ upload: id }));
    media.referenceVideos = (args.reference_video_urls || []).slice(0, 10).map((url) => ({ url }));
    media.referenceAudios = (args.reference_audio_urls || []).slice(0, 10).map((url) => ({ url }));
  }
  const seconds = Math.min(30, Math.max(4, Math.round(Number(args.seconds) || s.defaultSeconds)));
  return {
    title: args.title,
    prompt: String(args.prompt || ''),
    seconds,
    resolution: LIMITS.resolutions.includes(args.resolution) ? args.resolution : s.defaultResolution,
    media,
  };
}

async function buildLlmMessages(chat, s) {
  const model = CHAT_MODELS.find((m) => m.id === s.chatModel);
  const vision = model ? model.vision : true;
  const out = [{ role: 'system', content: chatSystemPrompt(s) }];
  // Only send actual pixels for the most recent few images to keep requests small.
  let imageBudget = 6;
  const msgs = chat.messages.slice(-40);
  const imagePixels = new Set();
  for (let i = msgs.length - 1; i >= 0 && imageBudget > 0; i--) {
    for (const id of msgs[i].attachments || []) {
      if (imageBudget > 0 && uploadById(id)?.kind === 'image') { imagePixels.add(id); imageBudget--; }
    }
  }
  for (const m of msgs) {
    if (m.role === 'user') {
      const atts = (m.attachments || []).map(uploadById).filter(Boolean);
      const note = atts.length ? `\n\n[Attached: ${atts.map((a) => `${a.kind} id=${a.id} (${a.name})`).join(', ')}]` : '';
      const text = (m.content || '') + note;
      const imgs = vision ? atts.filter((a) => imagePixels.has(a.id)) : [];
      if (!imgs.length) out.push({ role: 'user', content: text });
      else {
        const parts = [{ type: 'text', text }];
        for (const a of imgs) parts.push({ type: 'image_url', image_url: { url: await uploadAsDataUrl(a.id) } });
        out.push({ role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      const notes = (m.cards || []).map(cardSummary).join('\n');
      out.push({ role: 'assistant', content: [m.content || '', notes].filter(Boolean).join('\n\n') || '(ok)' });
    }
  }
  return out;
}

function cardSummary(card) {
  if (card.type === 'proposal' && !card.videoId) {
    return `[Video proposal "${card.params.title || ''}" (${card.params.seconds}s, ${card.params.resolution}) — ${card.dismissed ? 'dismissed by user' : 'awaiting user confirmation'}]`;
  }
  const v = db.videos.find((x) => x.id === (card.videoId || card.id));
  if (!v) return '';
  return `[Video ${v.id} "${v.title || ''}" (${v.seconds}s, ${v.resolution}, ${v.mode}) — status: ${v.status}${v.error ? `, error: ${v.error.message}` : ''}. Prompt: ${v.prompt.slice(0, 300)}]`;
}

async function chatCompletion(messages, { model, tools, maxTokens = 4000, temperature = 0.7 } = {}) {
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (tools) body.tools = tools;
  const res = await together('POST', '/v1/chat/completions', body);
  return res.choices?.[0]?.message || { content: '' };
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function runChatTurn(chat, userMessage) {
  const s = settings();
  chat.messages.push({ id: newId('m'), role: 'user', content: userMessage.content || '', attachments: userMessage.attachments || [], createdAt: now() });
  if (!chat.title || chat.title === 'New chat') {
    chat.title = (userMessage.content || 'Image chat').replace(/\s+/g, ' ').slice(0, 48);
  }
  const messages = await buildLlmMessages(chat, s);
  const cards = [];
  let finalText = '';

  for (let step = 0; step < 4; step++) {
    const msg = await chatCompletion(messages, { model: s.chatModel, tools: CHAT_TOOLS });
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      finalText = stripThinking(msg.content);
      break;
    }
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls.slice(0, 4)) {
      let result;
      try {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { throw new Error('Invalid JSON arguments'); }
        const params = toolArgsToParams(args, s);
        validateParams(params);
        const est = estimateCost(params.resolution, params.seconds);
        if (s.confirmBeforeGenerate) {
          cards.push({ type: 'proposal', id: newId('card'), params, estimatedCost: est, videoId: null });
          result = { status: 'proposed', note: 'Shown to the user as a proposal card awaiting their confirmation.', estimated_cost_usd: est };
        } else {
          const rec = await createVideo(params, { chatId: chat.id, source: 'chat' });
          cards.push({ type: 'video', id: newId('card'), videoId: rec.id, params });
          result = { status: rec.status, job_id: rec.id, estimated_cost_usd: est };
        }
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    finalText = stripThinking(msg.content);
  }
  if (!finalText && cards.length) finalText = s.confirmBeforeGenerate ? 'Here is my proposal — tweak anything you like, then hit **Generate**.' : 'Generating now!';

  const reply = { id: newId('m'), role: 'assistant', content: finalText, cards, createdAt: now() };
  chat.messages.push(reply);
  chat.updatedAt = now();
  save();
  return reply;
}

async function enhancePrompt({ prompt, mode, seconds, style }) {
  const s = settings();
  const sys = `You are an expert prompt engineer for the Seedance 2.5 video model.
${SEEDANCE_GUIDE}
Rewrite the user's idea into a single production-ready Seedance prompt. ${seconds ? `Target duration: ${seconds}s — pace the action and shots to fit.` : ''} ${mode && mode !== 'text-to-video' ? `Generation mode: ${mode} — refer to the provided images/references appropriately rather than re-describing them in full.` : ''} ${style ? `Desired style: ${style}.` : ''}
Include subject, action, setting, lighting, style, camera work and sound design. If the idea implies a story, structure it as shots ("Shot 1: … Cut to Shot 2: …").
Output ONLY the prompt text, no preamble, no quotes, no markdown headings.`;
  const msg = await chatCompletion(
    [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
    { model: s.chatModel, maxTokens: 3000, temperature: 0.8 },
  );
  return stripThinking(msg.content).replace(/^["']|["']$/g, '').trim();
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req, limit = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new ApiError(413, 'Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'Invalid JSON'); }
}

async function serveFile(req, res, file) {
  let stat;
  try { stat = await fsp.stat(file); } catch { res.writeHead(404); return res.end('Not found'); }
  if (!stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, decodeURIComponent(rel)));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// --- config & settings
route('GET', /^\/api\/config$/, async () => ({
  hasKey: Boolean(API_KEY),
  videoModel: VIDEO_MODEL,
  chatModels: CHAT_MODELS,
  limits: LIMITS,
  pricing: PRICING,
  settings: settings(),
  spend: spendSummary(),
}));
route('PUT', /^\/api\/settings$/, async (req) => {
  const body = await readJson(req);
  const allowed = ['chatModel', 'confirmBeforeGenerate', 'defaultResolution', 'defaultSeconds', 'spendWarning'];
  for (const k of allowed) if (k in body) db.settings[k] = body[k];
  save();
  return settings();
});

// --- uploads
route('POST', /^\/api\/uploads$/, async (req) => saveUpload(await readJson(req)));

// --- videos
route('GET', /^\/api\/videos$/, async () => ({ videos: db.videos.map(publicVideo), spend: spendSummary() }));
route('POST', /^\/api\/videos$/, async (req) => {
  const body = await readJson(req);
  const count = Math.min(4, Math.max(1, Number(body.variations) || 1));
  const created = [];
  for (let i = 0; i < count; i++) {
    created.push(await createVideo(body, { chatId: body.chatId, source: body.chatId ? 'chat' : 'studio' }));
  }
  // Link a confirmed chat proposal to its video
  if (body.chatId && body.cardId) {
    const chat = db.chats.find((c) => c.id === body.chatId);
    for (const m of chat?.messages || []) {
      for (const c of m.cards || []) {
        if (c.id === body.cardId) { c.videoId = created[0].id; c.params = { ...c.params, ...pickParams(body) }; }
      }
    }
    save();
  }
  return { videos: created.map(publicVideo) };
});
// Import an existing Together video job (e.g. one created outside the app) by id.
route('POST', /^\/api\/videos\/import$/, async (req) => {
  const { id } = await readJson(req);
  if (!id) throw new ApiError(400, 'Missing job id');
  if (db.videos.some((v) => v.id === id)) throw new ApiError(409, 'Already in your library');
  const job = await together('GET', `/v2/videos/${encodeURIComponent(id)}`);
  const resolution = LIMITS.resolutions.includes(job.resolution) ? job.resolution : '720p';
  const record = {
    id: job.id, status: job.status, prompt: job.prompt || '(imported job)', resolution, seconds: String(job.seconds || ''),
    mode: 'imported', media: {}, estimatedCost: estimateCost(resolution, job.seconds || 5), cost: null, remoteUrl: null,
    localFile: null, error: job.error || null, chatId: null, source: 'import', title: 'Imported', favorite: false,
    createdAt: (job.created_at || 0) * 1000 || now(), completedAt: null,
  };
  db.videos.unshift(record);
  await refreshVideo(record).catch(() => {});
  save();
  return publicVideo(record);
});
route('GET', /^\/api\/videos\/([\w-]+)$/, async (req, [, id]) => {
  const v = db.videos.find((x) => x.id === id);
  if (!v) throw new ApiError(404, 'Video not found');
  try { await refreshVideo(v); } catch (e) { console.warn(`refresh ${id}: ${e.message}`); }
  return publicVideo(v);
});
// Fallback for browsers that can't decode the MP4: extract the last frame with ffmpeg (if installed).
route('POST', /^\/api\/videos\/([\w-]+)\/lastframe$/, async (req, [, id]) => {
  const v = db.videos.find((x) => x.id === id);
  if (!v?.localFile) throw new ApiError(404, 'Video not downloaded yet');
  const { execFile } = require('node:child_process');
  const out = path.join(UPLOADS_DIR, `${newId('up')}.png`);
  await new Promise((resolve, reject) => execFile('ffmpeg',
    ['-y', '-loglevel', 'error', '-sseof', '-0.1', '-i', path.join(VIDEOS_DIR, v.localFile), '-frames:v', '1', '-update', '1', out],
    (err) => (err ? reject(new ApiError(500, err.code === 'ENOENT' ? 'ffmpeg is not installed' : `ffmpeg failed: ${err.message}`)) : resolve())));
  const buf = await fsp.readFile(out);
  await fsp.rm(out, { force: true });
  return saveUpload({ dataUrl: `data:image/png;base64,${buf.toString('base64')}`, name: `lastframe-${id.slice(0, 8)}.png` });
});
route('PATCH', /^\/api\/videos\/([\w-]+)$/, async (req, [, id]) => {
  const v = db.videos.find((x) => x.id === id);
  if (!v) throw new ApiError(404, 'Video not found');
  const body = await readJson(req);
  if ('favorite' in body) v.favorite = Boolean(body.favorite);
  if ('title' in body) v.title = String(body.title || '').slice(0, 120) || null;
  save();
  return publicVideo(v);
});
route('DELETE', /^\/api\/videos\/([\w-]+)$/, async (req, [, id]) => {
  const i = db.videos.findIndex((x) => x.id === id);
  if (i < 0) throw new ApiError(404, 'Video not found');
  const [v] = db.videos.splice(i, 1);
  if (v.localFile) await fsp.rm(path.join(VIDEOS_DIR, v.localFile), { force: true });
  save();
  return { ok: true };
});

function pickParams(b) {
  return { prompt: b.prompt, seconds: b.seconds, resolution: b.resolution, title: b.title, media: b.media };
}

// --- prompt tools
route('POST', /^\/api\/enhance$/, async (req) => ({ prompt: await enhancePrompt(await readJson(req)) }));

// --- chats
route('GET', /^\/api\/chats$/, async () => ({
  chats: db.chats
    .map(({ id, title, createdAt, updatedAt, messages }) => ({ id, title, createdAt, updatedAt, count: messages.length }))
    .sort((a, b) => b.updatedAt - a.updatedAt),
}));
route('POST', /^\/api\/chats$/, async () => {
  const chat = { id: newId('chat'), title: 'New chat', messages: [], createdAt: now(), updatedAt: now() };
  db.chats.push(chat);
  save();
  return chat;
});
route('GET', /^\/api\/chats\/([\w-]+)$/, async (req, [, id]) => {
  const chat = db.chats.find((c) => c.id === id);
  if (!chat) throw new ApiError(404, 'Chat not found');
  return chat;
});
route('PATCH', /^\/api\/chats\/([\w-]+)$/, async (req, [, id]) => {
  const chat = db.chats.find((c) => c.id === id);
  if (!chat) throw new ApiError(404, 'Chat not found');
  const body = await readJson(req);
  if (body.title) chat.title = String(body.title).slice(0, 80);
  if (body.dismissCard) {
    for (const m of chat.messages) for (const c of m.cards || []) if (c.id === body.dismissCard) c.dismissed = true;
  }
  save();
  return chat;
});
route('DELETE', /^\/api\/chats\/([\w-]+)$/, async (req, [, id]) => {
  db.chats = db.chats.filter((c) => c.id !== id);
  save();
  return { ok: true };
});
route('POST', /^\/api\/chats\/([\w-]+)\/messages$/, async (req, [, id]) => {
  const chat = db.chats.find((c) => c.id === id);
  if (!chat) throw new ApiError(404, 'Chat not found');
  const body = await readJson(req);
  if (!body.content?.trim() && !body.attachments?.length) throw new ApiError(400, 'Empty message');
  const reply = await runChatTurn(chat, body);
  return { reply, chat };
});

// --- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && r.pattern.exec(pathname);
        if (m) return send(res, 200, await r.handler(req, m, url));
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (pathname.startsWith('/media/videos/')) {
      const f = safeJoin(VIDEOS_DIR, pathname.slice('/media/videos/'.length));
      return f ? serveFile(req, res, f) : send(res, 400, { error: 'Bad path' });
    }
    if (pathname.startsWith('/media/uploads/')) {
      const name = pathname.slice('/media/uploads/'.length);
      const f = safeJoin(UPLOADS_DIR, uploadById(name)?.file || name); // allow /media/uploads/<id>

      return f ? serveFile(req, res, f) : send(res, 400, { error: 'Bad path' });
    }
    const f = safeJoin(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
    return f ? serveFile(req, res, f) : send(res, 400, { error: 'Bad path' });
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (status >= 500) console.error(e);
    return send(res, status >= 400 && status < 600 ? status : 500, { error: e.message, details: e.details });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🎬 Seedance Studio running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!API_KEY) console.log('⚠  TOGETHER_API_KEY missing — copy .env.example to .env and add your key.');
  pollPending().catch(() => {});
});
