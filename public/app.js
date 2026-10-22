'use strict';

// ===========================================================================
// Helpers
// ===========================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'err' ? 8000 : 4000);
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function elapsed(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Minimal, safe markdown renderer (escapes everything first).
function md(src) {
  const blocks = [];
  let text = esc(src || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _l, code) => {
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^\s*[-*•]\s+(.*)/.exec(line))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^(#{1,4})\s+(.*)/.exec(line))) {
      closeList();
      out.push(`<h4>${inline(m[2])}</h4>`);
    } else if (!line.trim()) {
      closeList();
      out.push('');
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n').replace(/<p>\u0000(\d+)\u0000<\/p>|\u0000(\d+)\u0000/g, (_, a, b) => blocks[a ?? b]);
}

// ===========================================================================
// Uploads
// ===========================================================================

const uploadCache = new Map(); // id -> upload record

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Downscale very large images so requests stay small (Seedance output is ≤720p anyway),
// and upscale tiny ones: Seedance rejects images with a side under 300 px.
async function normalizeImage(dataUrl, maxSide = 2048, minSide = 300) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const short = Math.min(img.width, img.height);
  const long = Math.max(img.width, img.height);
  if (long / short > maxSide / minSide) {
    throw new Error(`Image is ${img.width}×${img.height}; it's too long and thin to use. Each side must end up between ${minSide} and ${maxSide} px.`);
  }
  const scale = short < minSide ? minSide / short : Math.min(1, maxSide / long);
  if (scale === 1 && dataUrl.length < 4_000_000) return dataUrl;
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

async function uploadFile(file) {
  let dataUrl = await readAsDataUrl(file);
  if (file.type.startsWith('image/') && file.type !== 'image/gif') dataUrl = await normalizeImage(dataUrl);
  return uploadDataUrl(dataUrl, file.name);
}

async function uploadDataUrl(dataUrl, name) {
  const up = await api('POST', '/api/uploads', { dataUrl, name });
  uploadCache.set(up.id, up);
  return up;
}

function imageFilesFrom(dt) {
  return [...(dt?.files || [])].filter((f) => f.type.startsWith('image/'));
}

// ===========================================================================
// App state
// ===========================================================================

const state = {
  config: null,
  videos: new Map(), // id -> video
  chats: [],
  chatId: null,
  chat: null,
  pendingAttachments: [], // uploads for the next chat message
  sending: false,
  view: 'chat',
  galleryFilter: 'all',
};

const STARTERS = [
  { t: '🌊 Cinematic nature', p: 'Make a breathtaking 8 second drone shot over Icelandic black sand beaches at sunrise.' },
  { t: '🎭 Short story', p: 'Write and generate a 15 second multi-shot mini story about a robot who discovers a flower in a ruined city.' },
  { t: '🛍️ Product ad', p: 'I want a sleek 10 second commercial for a luxury perfume bottle. Ask me what you need.' },
  { t: '🖼️ Animate a photo', p: 'I will attach a photo — bring it to life with subtle natural motion and ambient sound.' },
];

// ===========================================================================
// Video store + polling
// ===========================================================================

const isActive = (v) => !['completed', 'failed', 'cancelled'].includes(v.status) || (v.status === 'completed' && !v.url);

function upsertVideo(v) {
  const prev = state.videos.get(v.id);
  state.videos.set(v.id, v);
  if (prev && isActive(prev) && !isActive(v)) {
    if (v.status === 'completed') toast(`✅ Video ready: ${v.title || v.prompt.slice(0, 40)}…`, 'ok');
    else toast(`❌ Generation failed: ${v.error?.message || v.status}`, 'err');
    refreshSpend();
  }
  // Re-render every visible card for this video
  for (const el of $$(`[data-video="${v.id}"]`)) el.replaceWith(videoCard(v, el.dataset.variant));
  updateJobsBadge();
  if (state.view === 'gallery' && (!prev || isActive(prev) !== isActive(v))) renderGallery();
}

async function pollLoop() {
  const active = [...state.videos.values()].filter(isActive);
  await Promise.all(active.map(async (v) => {
    try { upsertVideo(await api('GET', `/api/videos/${v.id}`)); } catch { /* retry next tick */ }
  }));
  // tick timers
  for (const el of $$('[data-since]')) el.textContent = elapsed(Number(el.dataset.since));
  setTimeout(pollLoop, active.length ? 6000 : 15000);
}
setInterval(() => { for (const el of $$('[data-since]')) el.textContent = elapsed(Number(el.dataset.since)); }, 1000);

function updateJobsBadge() {
  const n = [...state.videos.values()].filter(isActive).length;
  const b = $('#jobsBadge');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

async function refreshSpend() {
  try {
    const cfg = await api('GET', '/api/config');
    state.config.spend = cfg.spend;
    $('#spendPill').textContent = `${money(cfg.spend.total)} spent`;
  } catch { /* ignore */ }
}

// ===========================================================================
// Video card (shared by chat, studio, gallery)
// ===========================================================================

function statusTag(v) {
  if (v.status === 'completed' && v.url) return h('span', { class: 'tag ok' }, '✓ ready');
  if (v.status === 'failed' || v.status === 'cancelled') return h('span', { class: 'tag err' }, v.status);
  return h('span', { class: 'tag run' }, v.status === 'completed' ? 'downloading…' : v.status.replace('_', ' '));
}

function refThumbs(media) {
  if (!media) return null;
  const items = [];
  for (const f of media.frameImages || []) items.push({ ref: f.ref, label: f.frame === 'last' ? 'last' : 'first' });
  (media.referenceImages || []).forEach((r, i) => items.push({ ref: r, label: `img ${i + 1}` }));
  const vids = (media.referenceVideos || []).length;
  const auds = (media.referenceAudios || []).length;
  if (!items.length && !vids && !auds) return null;
  return h('div', { class: 'ref-strip' },
    items.map(({ ref, label }) => {
      const id = ref?.upload || (typeof ref === 'string' && ref.startsWith('up_') ? ref : null);
      const src = id ? uploadCache.get(id)?.url || `/media/uploads/${id}` : ref?.url || ref;
      return h('div', {}, h('img', { src: id && uploadCache.get(id) ? uploadCache.get(id).url : src, onerror: (e) => { e.target.style.opacity = 0.3; } }), h('div', { class: 'lbl' }, label));
    }),
    vids ? h('span', { class: 'tag' }, `🎞️ ${vids} ref video${vids > 1 ? 's' : ''}`) : null,
    auds ? h('span', { class: 'tag' }, `🔊 ${auds} ref audio`) : null,
  );
}

function videoCard(v, variant = 'full') {
  const card = h('div', { class: 'card', 'data-video': v.id, 'data-variant': variant });
  const head = h('h4', {},
    h('span', {}, v.title || (v.mode === 'text-to-video' ? 'Text → Video' : v.mode.replace(/-/g, ' '))),
    h('span', { class: 'row gap' },
      h('button', { class: 'btn ghost small', title: 'Favorite', onclick: () => toggleFav(v) }, v.favorite ? '★' : '☆'),
      statusTag(v)),
  );
  card.append(head);

  if (v.status === 'completed' && v.url) {
    card.append(h('video', { src: v.url, controls: true, playsInline: true, preload: 'metadata', loop: variant !== 'full' }));
  } else if (v.status === 'failed' || v.status === 'cancelled') {
    card.append(h('div', { class: 'error-box' }, v.error?.message || 'Generation failed.'));
  } else {
    card.append(h('div', { class: 'progress' },
      h('div', {}, h('div', { style: 'font-size:26px' }, '🎬'),
        h('div', {}, 'Rendering with Seedance 2.5…'),
        h('div', { class: 'small' }, 'Elapsed ', h('b', { 'data-since': v.createdAt }, elapsed(v.createdAt)), ' · usually 1–6 min'))));
  }

  card.append(h('div', { class: 'meta' },
    h('span', { class: 'tag' }, v.mode),
    h('span', { class: 'tag' }, `${v.seconds}${v.seconds === 'auto' ? '' : 's'}`),
    h('span', { class: 'tag' }, v.resolution),
    h('span', { class: 'tag' }, v.cost != null ? money(v.cost) : `≈ ${money(v.estimatedCost)}`),
    variant !== 'compact' ? h('span', { class: 'tag' }, timeAgo(v.createdAt)) : null,
  ));
  if (variant !== 'compact') {
    card.append(refThumbs(v.media) || '');
    card.append(h('div', { class: 'prompt-text' }, v.prompt));
  }

  const actions = h('div', { class: 'actions' });
  if (v.url) {
    actions.append(
      h('a', { class: 'btn small', href: v.url, download: `${(v.title || 'seedance').replace(/\W+/g, '-')}-${v.id.slice(0, 8)}.mp4` }, '⬇ Download'),
      h('button', { class: 'btn small', title: 'Use the final frame as the first frame of a new video', onclick: () => extendVideo(v) }, '⏭ Extend'),
    );
    if (v.remoteUrl) actions.append(h('button', { class: 'btn small', title: 'Use as reference video (Together URL)', onclick: () => useAsReference(v) }, '🎞️ As reference'));
  }
  actions.append(
    h('button', { class: 'btn small', onclick: () => remix(v) }, '🔁 Remix'),
    h('button', { class: 'btn small', onclick: () => { navigator.clipboard.writeText(v.prompt); toast('Prompt copied'); } }, '📋 Copy'),
  );
  if (variant === 'gallery') actions.append(h('button', { class: 'btn small', onclick: () => openViewer(v) }, '🔍 Details'));
  if (variant !== 'chat') actions.append(h('button', { class: 'btn small danger', onclick: () => deleteVideo(v) }, '🗑'));
  card.append(actions);
  return card;
}

async function toggleFav(v) {
  upsertVideo(await api('PATCH', `/api/videos/${v.id}`, { favorite: !v.favorite }));
  if (state.view === 'gallery') renderGallery();
}

async function deleteVideo(v) {
  if (!confirm('Delete this video from your library? The local file will be removed.')) return;
  await api('DELETE', `/api/videos/${v.id}`);
  state.videos.delete(v.id);
  for (const el of $$(`[data-video="${v.id}"]`)) el.remove();
  renderGallery();
  renderRecent();
  updateJobsBadge();
}

function openViewer(v) {
  const body = $('#viewerBody');
  body.replaceChildren(
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h2', {}, v.title || 'Video'),
      h('button', { class: 'btn ghost', onclick: () => $('#viewerDialog').close() }, '✕')),
    videoCard(v, 'full'),
    h('p', { class: 'muted small' }, `Job id: ${v.id} · created ${new Date(v.createdAt).toLocaleString()}`),
  );
  $('#viewerDialog').showModal();
}

// ===========================================================================
// Actions: remix / extend / use as reference
// ===========================================================================

async function loadIntoStudio(params) {
  const st = studio;
  st.prompt.value = params.prompt || '';
  setRes(params.resolution || '720p');
  if (params.seconds === 'auto') { $('#autoSec').checked = true; } else { $('#autoSec').checked = false; $('#seconds').value = params.seconds || 5; }
  const m = params.media || {};
  st.first = null; st.last = null; st.refImages = []; st.refVideos = []; st.refAudios = [];
  const toUp = (ref) => {
    const id = ref?.upload || (typeof ref === 'string' && ref.startsWith('up_') ? ref : null);
    return id ? (uploadCache.get(id) || { id, url: `/media/uploads/${id}`, kind: 'image' }) : null;
  };
  if (m.frameImages?.length) {
    setMode('i2v');
    for (const f of m.frameImages) st[f.frame === 'last' ? 'last' : 'first'] = toUp(f.ref);
  } else if (m.referenceImages?.length || m.referenceVideos?.length || m.referenceAudios?.length) {
    setMode('ref');
    st.refImages = (m.referenceImages || []).map(toUp).filter(Boolean);
    st.refVideos = (m.referenceVideos || []).map((r) => (r.upload ? { upload: r.upload, name: r.name || 'uploaded video' } : { url: r.url || r }));
    st.refAudios = (m.referenceAudios || []).map((r) => (r.upload ? { upload: r.upload, name: r.name || 'uploaded audio' } : { url: r.url || r }));
  } else setMode('t2v');
  renderStudioMedia();
  updateCost();
  updatePromptCount();
  switchView('studio');
}

function remix(v) {
  loadIntoStudio(v);
  toast('Loaded into Studio — tweak and generate.');
}

async function captureLastFrame(url) {
  const video = h('video', { src: url, muted: true, preload: 'auto', playsInline: true });
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out reading video')), 10000))]);
  await withTimeout(new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('Could not load video')); }));
  video.currentTime = Math.max(0, video.duration - 0.05);
  await withTimeout(new Promise((res) => { video.onseeked = res; }));
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c.toDataURL('image/png');
}

async function extendVideo(v) {
  try {
    toast('Capturing last frame…');
    let up;
    try {
      up = await uploadDataUrl(await captureLastFrame(v.url), `lastframe-${v.id.slice(0, 8)}.png`);
    } catch {
      up = await api('POST', `/api/videos/${v.id}/lastframe`); // server-side ffmpeg fallback
      uploadCache.set(up.id, up);
    }
    await loadIntoStudio({ prompt: `Continue seamlessly from the previous shot. ${v.prompt}`, resolution: v.resolution, seconds: v.seconds, media: { frameImages: [{ ref: { upload: up.id }, frame: 'first' }] } });
    studio.first = up;
    renderStudioMedia();
    toast('Last frame set as the first frame — describe what happens next.', 'ok');
  } catch (e) {
    toast(`Extend failed: ${e.message}`, 'err');
  }
}

function useAsReference(v) {
  setMode('ref');
  if (studio.refVideos.length >= 10) return toast('Max 10 reference videos', 'err');
  studio.refVideos.push({ url: v.remoteUrl, name: v.title || v.id });
  if (!studio.prompt.value.trim()) studio.prompt.value = 'Using the motion and style of reference video 1, ';
  renderStudioMedia();
  updateCost();
  switchView('studio');
  toast('Added as reference video (Together URLs expire after a while).');
}

// ===========================================================================
// Chat
// ===========================================================================

async function loadChats() {
  state.chats = (await api('GET', '/api/chats')).chats;
  renderChatList();
}

function renderChatList() {
  const list = $('#chatList');
  list.replaceChildren(...state.chats.map((c) => h('div', {
    class: `chat-item ${c.id === state.chatId ? 'active' : ''}`,
    onclick: () => openChat(c.id),
  },
  h('span', { class: 't', title: c.title }, c.title || 'New chat'),
  h('button', { class: 'x', title: 'Delete chat', onclick: (e) => { e.stopPropagation(); deleteChat(c.id); } }, '✕'))));
}

async function openChat(id) {
  state.chatId = id;
  state.chat = id ? await api('GET', `/api/chats/${id}`) : null;
  try { localStorage.setItem('chatId', id || ''); } catch { /* ignore */ }
  renderChatList();
  renderMessages();
}

async function newChat() {
  const chat = await api('POST', '/api/chats');
  state.chats.unshift({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt });
  await openChat(chat.id);
  $('#chatInput').focus();
}

async function deleteChat(id) {
  if (!confirm('Delete this chat? Videos stay in your gallery.')) return;
  await api('DELETE', `/api/chats/${id}`);
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.chatId === id) await openChat(state.chats[0]?.id || null);
  else renderChatList();
}

function renderMessages() {
  const box = $('#messages');
  const msgs = state.chat?.messages || [];
  if (!msgs.length) {
    box.replaceChildren(h('div', { class: 'empty-chat' },
      h('div', { style: 'font-size:46px' }, '🎬'),
      h('h2', {}, 'Your AI film director'),
      h('p', { class: 'muted' }, 'Describe an idea and I\'ll write a pro Seedance 2.5 prompt and generate it — with native audio, multi-shot storytelling, up to 30s. Attach images to animate them or keep characters consistent.'),
      h('div', { class: 'starters' }, STARTERS.map((s) => h('button', { class: 'starter', onclick: () => { $('#chatInput').value = s.p; autoGrow(); $('#chatInput').focus(); } }, h('b', {}, s.t), h('div', { class: 'muted small' }, s.p)))),
    ));
    return;
  }
  box.replaceChildren(...msgs.map(renderMessage));
  if (state.sending) box.append(typingIndicator());
  box.scrollTop = box.scrollHeight;
}

function typingIndicator() {
  return h('div', { class: 'msg', id: 'typing' }, h('div', { class: 'avatar' }, '🎬'), h('div', { class: 'body' }, h('div', { class: 'typing' }, h('span'), h('span'), h('span'))));
}

function renderMessage(m) {
  if (m.role === 'user') {
    return h('div', { class: 'msg user' },
      h('div', { class: 'avatar' }, '🧑'),
      h('div', { class: 'body' },
        m.content ? h('div', { class: 'bubble' }, m.content) : null,
        m.attachments?.length ? h('div', { class: 'msg-atts' }, m.attachments.map((id) => h('img', { src: uploadCache.get(id)?.url || `/media/uploads/${id}`, title: id }))) : null));
  }
  return h('div', { class: 'msg' },
    h('div', { class: 'avatar' }, '🎬'),
    h('div', { class: 'body' },
      h('div', { class: 'bubble', html: md(m.content) }),
      (m.cards || []).map((c) => renderChatCard(c))));
}

function renderChatCard(card) {
  const vid = card.videoId && state.videos.get(card.videoId);
  if (vid) return videoCard(vid, 'chat');
  if (card.videoId) return h('div', { class: 'card muted' }, 'Video was deleted from the library.');
  return proposalCard(card);
}

function proposalCard(card) {
  const p = card.params;
  const promptEl = h('textarea', { rows: 6 }, p.prompt);
  const secEl = h('input', { type: 'number', min: 4, max: 30, value: p.seconds, style: 'width:80px' });
  const resEl = h('select', { style: 'width:100px' }, ['480p', '720p'].map((r) => h('option', { selected: r === p.resolution }, r)));
  const costEl = h('b', {}, money(card.estimatedCost));
  const recalc = () => { costEl.textContent = money(estimate(resEl.value, secEl.value)); };
  secEl.oninput = recalc;
  resEl.onchange = recalc;
  const paramsNow = () => ({ ...p, prompt: promptEl.value, seconds: Math.min(30, Math.max(4, Number(secEl.value) || 5)), resolution: resEl.value });

  if (card.dismissed) {
    return h('div', { class: 'card' }, h('h4', {}, h('span', { class: 'muted' }, `Proposal dismissed: ${p.title || ''}`),
      h('button', { class: 'btn small', onclick: () => loadIntoStudio(p) }, 'Open in Studio')));
  }

  const genBtn = h('button', { class: 'btn primary', onclick: async () => {
    const params = paramsNow();
    const est = estimate(params.resolution, params.seconds);
    if (est > state.config.settings.spendWarning && !confirm(`This generation will cost about ${money(est)}. Continue?`)) return;
    genBtn.disabled = true;
    genBtn.textContent = 'Starting…';
    try {
      const { videos } = await api('POST', '/api/videos', { ...params, chatId: state.chatId, cardId: card.id });
      videos.forEach((v) => state.videos.set(v.id, v));
      card.videoId = videos[0].id;
      card.params = params;
      el.replaceWith(renderChatCard(card));
      updateJobsBadge();
    } catch (e) {
      toast(e.message, 'err');
      genBtn.disabled = false;
      genBtn.textContent = '🎬 Generate';
    }
  } }, '🎬 Generate');

  const el = h('div', { class: 'card' },
    h('h4', {}, h('span', {}, `🎬 ${p.title || 'Video proposal'}`), h('span', { class: 'tag' }, 'proposal')),
    refThumbs(p.media) || '',
    promptEl,
    h('div', { class: 'row gap wrap', style: 'margin-top:8px' },
      h('label', { class: 'row gap small' }, 'Seconds', secEl),
      h('label', { class: 'row gap small' }, 'Resolution', resEl),
      h('span', { class: 'small muted' }, 'Est. ', costEl)),
    h('div', { class: 'actions' },
      genBtn,
      h('button', { class: 'btn', onclick: () => loadIntoStudio(paramsNow()) }, '🎛️ Open in Studio'),
      h('button', { class: 'btn ghost', onclick: async () => {
        await api('PATCH', `/api/chats/${state.chatId}`, { dismissCard: card.id });
        card.dismissed = true;
        el.replaceWith(renderChatCard(card));
      } }, 'Dismiss')));
  return el;
}

function renderAttachRow() {
  $('#attachRow').replaceChildren(...state.pendingAttachments.map((u) => h('div', { class: 'attach' },
    h('img', { src: u.url, title: u.name }),
    h('button', { type: 'button', onclick: () => { state.pendingAttachments = state.pendingAttachments.filter((x) => x !== u); renderAttachRow(); } }, '✕'))));
}

async function addChatAttachments(files) {
  for (const f of files) {
    try {
      state.pendingAttachments.push(await uploadFile(f));
      renderAttachRow();
    } catch (e) { toast(`Upload failed: ${e.message}`, 'err'); }
  }
}

async function sendMessage() {
  const input = $('#chatInput');
  const content = input.value.trim();
  if (state.sending || (!content && !state.pendingAttachments.length)) return;
  if (!state.chatId) await newChat();
  const attachments = state.pendingAttachments.map((u) => u.id);
  state.chat.messages.push({ role: 'user', content, attachments });
  state.pendingAttachments = [];
  renderAttachRow();
  input.value = '';
  autoGrow();
  state.sending = true;
  $('#sendBtn').disabled = true;
  renderMessages();
  try {
    const { chat, reply } = await api('POST', `/api/chats/${state.chatId}/messages`, { content, attachments });
    for (const c of reply.cards || []) {
      if (c.videoId && !state.videos.has(c.videoId)) {
        try { state.videos.set(c.videoId, await api('GET', `/api/videos/${c.videoId}`)); } catch { /* ignore */ }
      }
    }
    if (chat.id === state.chatId) state.chat = chat;
    const item = state.chats.find((c) => c.id === chat.id);
    if (item) item.title = chat.title;
    renderChatList();
    updateJobsBadge();
  } catch (e) {
    state.chat.messages.push({ role: 'assistant', content: `⚠️ ${e.message}` });
    toast(e.message, 'err');
  } finally {
    state.sending = false;
    $('#sendBtn').disabled = false;
    renderMessages();
  }
}

function autoGrow() {
  const t = $('#chatInput');
  t.style.height = 'auto';
  t.style.height = Math.min(220, t.scrollHeight) + 'px';
}

// ===========================================================================
// Studio
// ===========================================================================

const STYLE_PRESETS = {
  Cinematic: 'Cinematic film look, anamorphic lens, shallow depth of field, rich color grading, subtle film grain.',
  Documentary: 'Naturalistic documentary style, handheld camera, available light, authentic textures.',
  Anime: 'Japanese anime style, cel shading, vibrant colors, expressive motion, detailed painted backgrounds.',
  '3D Pixar-like': 'Stylized 3D animation, soft global illumination, appealing character design, warm palette.',
  Noir: 'Black-and-white film noir, high-contrast chiaroscuro lighting, venetian blind shadows, smoke.',
  Cyberpunk: 'Neon-drenched cyberpunk city, rain-slick reflections, magenta and teal lighting, volumetric haze.',
  'Product ad': 'Premium commercial product shot, studio lighting, clean seamless background, glossy reflections, macro detail.',
  Vintage: '1970s 16mm film aesthetic, warm faded colors, light leaks, gentle gate weave.',
  Claymation: 'Stop-motion claymation style, handcrafted textures, slightly stepped motion.',
  'Music video': 'Stylish music video energy, rhythmic cuts on the beat, dynamic lighting changes.',
  Nature: 'Nature documentary, 8K detail, telephoto lens, golden hour light.',
  Horror: 'Atmospheric horror, dim cold lighting, creeping slow camera, unsettling silence punctuated by sounds.',
};
const CAMERA_PRESETS = ['Slow dolly-in', 'Dolly-out reveal', 'Orbit around the subject', 'Tracking shot following the subject', 'Crane up to a bird\'s-eye view', 'Handheld close-up', 'Whip pan', 'FPV drone dive', 'Static locked-off shot', 'Low-angle hero shot', 'Rack focus', 'Slow-motion'];
const SOUND_PRESETS = ['Ambient natural soundscape', 'Epic orchestral score', 'Lo-fi chill beat', 'Synthwave soundtrack', 'Dialogue: "…" (spoken by …)', 'Crisp foley sound effects', 'Silence except footsteps', 'Upbeat pop music', 'Heavy rain and thunder'];
const SHOT_SIZES = ['Wide shot', 'Medium shot', 'Close-up', 'Extreme close-up', 'Over-the-shoulder', 'Aerial shot', 'POV shot'];

const studio = {
  prompt: null,
  mode: 't2v',
  res: '720p',
  variations: 1,
  first: null,
  last: null,
  refImages: [],
  refVideos: [], // {url} | {upload, name}
  refAudios: [],
  shots: [],
};

function estimate(res, seconds) {
  const p = state.config?.pricing?.[res] ?? 0.249;
  return p * (seconds === 'auto' ? 10 : Number(seconds) || 5);
}

function currentSeconds() {
  return $('#autoSec').checked ? 'auto' : Number($('#seconds').value);
}

function updateCost() {
  const sec = currentSeconds();
  $('#secLabel').textContent = sec === 'auto' ? 'auto' : `${sec}s`;
  $('#seconds').disabled = sec === 'auto';
  const total = estimate(studio.res, sec) * studio.variations;
  $('#costEst').textContent = `≈ ${money(total)}`;
  const rate = state.config?.pricing?.[studio.res] ?? 0.249;
  const parts = [`${sec === 'auto' ? '~10s (auto)' : `${sec}s`} × $${rate}/s`];
  if (studio.variations > 1) parts.push(`× ${studio.variations} variations`);
  if (studio.mode === 'ref' && studio.refVideos.length) parts.push('reference videos may cost more');
  parts.push('audio included');
  $('#costNote').textContent = parts.join(' · ');
}

function updatePromptCount() {
  $('#promptCount').textContent = `${studio.prompt.value.length} / 10000`;
}

function setMode(mode) {
  studio.mode = mode;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#panel-i2v').classList.toggle('hidden', mode !== 'i2v');
  $('#panel-ref').classList.toggle('hidden', mode !== 'ref');
  updateCost();
}

function setRes(res) {
  studio.res = res;
  $$('#resSeg button').forEach((b) => b.classList.toggle('active', b.dataset.res === res));
  updateCost();
}

function renderStudioMedia() {
  // frame slots
  for (const slot of ['first', 'last']) {
    const el = $(`.drop[data-slot="${slot}"]`);
    $$('img, .clear', el).forEach((x) => x.remove());
    const up = studio[slot];
    if (up) {
      el.append(h('img', { src: up.url }), h('button', { class: 'btn small clear', type: 'button', onclick: (e) => { e.stopPropagation(); studio[slot] = null; renderStudioMedia(); } }, '✕'));
    }
  }
  // reference images
  const box = $('#refImages');
  $$('.thumb:not(.add)', box).forEach((x) => x.remove());
  studio.refImages.forEach((up, i) => {
    box.insertBefore(h('div', { class: 'thumb' },
      h('img', { src: up.url }),
      h('span', { class: 'n' }, `image ${i + 1}`),
      h('button', { type: 'button', onclick: () => { studio.refImages.splice(i, 1); renderStudioMedia(); } }, '✕')), box.lastElementChild);
  });
  $('#refImgCount').textContent = `${studio.refImages.length} / 30`;
  renderUrlList('#refVideos', studio.refVideos, 'video');
  renderUrlList('#refAudios', studio.refAudios, 'audio');
  saveDraft();
}

function renderUrlList(sel, list, kind) {
  $(sel).replaceChildren(...list.map((item, i) => h('div', { class: 'url-row' },
    h('span', { class: 'tag' }, `${kind} ${i + 1}`),
    item.upload
      ? h('span', { class: 'badge-file' }, `📁 ${item.name || item.upload}`)
      : h('input', { type: 'url', placeholder: `https://…/${kind === 'video' ? 'clip.mp4' : 'track.mp3'}`, value: item.url || '', oninput: (e) => { item.url = e.target.value.trim(); saveDraft(); } }),
    h('button', { class: 'btn small ghost', type: 'button', onclick: () => { list.splice(i, 1); renderStudioMedia(); updateCost(); } }, '✕'))));
}

function collectStudioParams() {
  const media = { frameImages: [], referenceImages: [], referenceVideos: [], referenceAudios: [] };
  if (studio.mode === 'i2v') {
    if (!studio.first && !studio.last) throw new Error('Add a first frame image (or switch to Text → Video).');
    if (studio.first) media.frameImages.push({ ref: { upload: studio.first.id }, frame: 'first' });
    if (studio.last) media.frameImages.push({ ref: { upload: studio.last.id }, frame: 'last' });
  } else if (studio.mode === 'ref') {
    media.referenceImages = studio.refImages.map((u) => ({ upload: u.id }));
    const norm = (x) => (x.upload ? { upload: x.upload, name: x.name } : x.url ? { url: x.url } : null);
    media.referenceVideos = studio.refVideos.map(norm).filter(Boolean);
    media.referenceAudios = studio.refAudios.map(norm).filter(Boolean);
    for (const r of [...media.referenceVideos, ...media.referenceAudios]) {
      if (r.url && !/^https?:\/\//.test(r.url)) throw new Error(`Not a valid URL: ${r.url}`);
    }
    if (!media.referenceImages.length && !media.referenceVideos.length && !media.referenceAudios.length) {
      throw new Error('Add at least one reference (or switch to Text → Video).');
    }
  }
  const prompt = studio.prompt.value.trim();
  if (prompt.length < 2) throw new Error('Write a prompt first.');
  return { prompt, resolution: studio.res, seconds: currentSeconds(), media, variations: studio.variations };
}

async function generateFromStudio() {
  let params;
  try { params = collectStudioParams(); } catch (e) { return toast(e.message, 'err'); }
  const est = estimate(params.resolution, params.seconds) * params.variations;
  if (est > state.config.settings.spendWarning && !confirm(`This will cost about ${money(est)}. Continue?`)) return;
  const btn = $('#generateBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    const { videos } = await api('POST', '/api/videos', params);
    videos.forEach((v) => state.videos.set(v.id, v));
    const failed = videos.filter((v) => v.status === 'failed');
    if (failed.length) toast(`Rejected: ${failed[0].error?.message}`, 'err');
    else toast(`🎬 ${videos.length > 1 ? `${videos.length} generations` : 'Generation'} started`, 'ok');
    renderRecent();
    updateJobsBadge();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🎬 Generate <kbd>Ctrl ↵</kbd>';
  }
}

function renderRecent() {
  const vids = [...state.videos.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  $('#studioRecent').replaceChildren(...(vids.length ? vids.map((v) => videoCard(v, 'compact')) : [h('p', { class: 'muted' }, 'Your generations will appear here.')]));
}

async function enhance() {
  const btn = $('#enhanceBtn');
  const text = studio.prompt.value.trim();
  if (!text) return toast('Write a rough idea first, then enhance it.', 'err');
  btn.disabled = true;
  btn.textContent = '✨ Enhancing…';
  try {
    const modeName = { t2v: 'text-to-video', i2v: 'image-to-video (animate the provided first frame)', ref: `reference-guided (${studio.refImages.length} reference images, ${studio.refVideos.length} videos, ${studio.refAudios.length} audios)` }[studio.mode];
    const { prompt } = await api('POST', '/api/enhance', { prompt: text, mode: modeName, seconds: currentSeconds() === 'auto' ? null : currentSeconds() });
    studio.undo = text;
    studio.prompt.value = prompt;
    updatePromptCount();
    saveDraft();
    toast(h('span', {}, 'Prompt enhanced. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); studio.prompt.value = studio.undo; updatePromptCount(); } }, 'Undo')), 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Enhance with AI';
  }
}

function appendToPrompt(text) {
  const p = studio.prompt;
  p.value = (p.value.trim() ? p.value.trim().replace(/[.,;]?$/, '.') + ' ' : '') + text;
  updatePromptCount();
  saveDraft();
  p.focus();
}

function renderShots() {
  $('#shotList').replaceChildren(...studio.shots.map((s, i) => h('div', { class: 'shot' },
    h('span', { class: 'num' }, `Shot ${i + 1}`),
    h('textarea', { rows: 2, placeholder: 'What happens in this shot (subject, action, sound)…', oninput: (e) => { s.text = e.target.value; } }, s.text),
    h('select', { onchange: (e) => { s.size = e.target.value; } }, SHOT_SIZES.map((x) => h('option', { selected: x === s.size }, x))),
    h('button', { class: 'btn small ghost', type: 'button', onclick: () => { studio.shots.splice(i, 1); renderShots(); } }, '✕'))));
}

function compileShots() {
  const shots = studio.shots.filter((s) => s.text?.trim());
  if (!shots.length) return toast('Add at least one shot description.', 'err');
  const body = shots.map((s, i) => `${i === 0 ? '' : 'Cut to '}Shot ${i + 1} (${s.size.toLowerCase()}): ${s.text.trim().replace(/\.?$/, '.')}`).join(' ');
  const pre = studio.prompt.value.trim();
  studio.prompt.value = pre ? `${pre}\n\n${body}` : body;
  if (!$('#autoSec').checked && Number($('#seconds').value) < shots.length * 3) {
    $('#seconds').value = Math.min(30, Math.max(5, shots.length * 4));
    updateCost();
  }
  updatePromptCount();
  saveDraft();
  toast('Shots written to prompt.', 'ok');
}

function saveDraft() {
  try {
    localStorage.setItem('studioDraft', JSON.stringify({
      prompt: studio.prompt.value, mode: studio.mode, res: studio.res, seconds: $('#seconds').value, auto: $('#autoSec').checked,
      first: studio.first, last: studio.last, refImages: studio.refImages, refVideos: studio.refVideos, refAudios: studio.refAudios,
    }));
  } catch { /* ignore */ }
}

function loadDraft() {
  let d;
  try { d = JSON.parse(localStorage.getItem('studioDraft') || 'null'); } catch { d = null; }
  if (!d) return;
  studio.prompt.value = d.prompt || '';
  studio.first = d.first; studio.last = d.last;
  studio.refImages = d.refImages || []; studio.refVideos = d.refVideos || []; studio.refAudios = d.refAudios || [];
  for (const u of [studio.first, studio.last, ...studio.refImages]) if (u?.id) uploadCache.set(u.id, u);
  $('#seconds').value = d.seconds || 5;
  $('#autoSec').checked = Boolean(d.auto);
  setMode(d.mode || 't2v');
  setRes(d.res || '720p');
}

function setupDrop(el, onFiles) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('dragover'); const f = imageFilesFrom(e.dataTransfer); if (f.length) onFiles(f); });
}

function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, multiple });
    inp.onchange = () => resolve([...inp.files]);
    inp.click();
  });
}

async function setFrame(slot, file) {
  try {
    studio[slot] = await uploadFile(file);
    renderStudioMedia();
  } catch (e) { toast(e.message, 'err'); }
}

async function addRefImages(files) {
  for (const f of files) {
    if (studio.refImages.length >= 30) { toast('Max 30 reference images', 'err'); break; }
    try { studio.refImages.push(await uploadFile(f)); renderStudioMedia(); } catch (e) { toast(e.message, 'err'); }
  }
}

async function addRefFile(kind, file) {
  const list = kind === 'video' ? studio.refVideos : studio.refAudios;
  if (list.length >= 10) return toast(`Max 10 reference ${kind}s`, 'err');
  try {
    toast(`Uploading ${file.name}…`);
    const up = await uploadFile(file);
    list.push({ upload: up.id, name: file.name });
    renderStudioMedia();
    updateCost();
  } catch (e) { toast(e.message, 'err'); }
}

function openGalleryPicker() {
  const vids = [...state.videos.values()].filter((v) => v.url && v.remoteUrl);
  $('#pickerGrid').replaceChildren(...(vids.length ? vids.map((v) => h('div', {},
    h('video', { src: v.url, muted: true, preload: 'metadata', onmouseenter: (e) => e.target.play(), onmouseleave: (e) => e.target.pause(), onclick: () => { useAsReference(v); $('#pickerDialog').close(); } }),
    h('div', { class: 'small muted' }, `${v.title || v.prompt.slice(0, 50)} · ${timeAgo(v.createdAt)}`))) : [h('p', { class: 'muted' }, 'No completed videos yet.')]));
  $('#pickerDialog').showModal();
}

function setupStudio() {
  studio.prompt = $('#prompt');
  studio.prompt.addEventListener('input', () => { updatePromptCount(); saveDraft(); });
  studio.prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generateFromStudio(); });
  studio.prompt.addEventListener('paste', (e) => {
    const files = imageFilesFrom(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    if (studio.mode === 'ref') addRefImages(files);
    else { setMode('i2v'); setFrame(studio.first ? 'last' : 'first', files[0]); }
  });

  $('#styleChips').replaceChildren(...Object.entries(STYLE_PRESETS).map(([k, v]) => h('button', { class: 'chip', type: 'button', title: v, onclick: () => appendToPrompt(v) }, k)));
  $('#cameraChips').replaceChildren(...CAMERA_PRESETS.map((c) => h('button', { class: 'chip', type: 'button', onclick: () => appendToPrompt(`Camera: ${c.toLowerCase()}.`) }, c)));
  $('#soundChips').replaceChildren(...SOUND_PRESETS.map((c) => h('button', { class: 'chip', type: 'button', onclick: () => appendToPrompt(`Sound: ${c}.`) }, c)));

  $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); saveDraft(); }));
  $$('#resSeg button').forEach((b) => b.addEventListener('click', () => { setRes(b.dataset.res); saveDraft(); }));
  $$('#varSeg button').forEach((b) => b.addEventListener('click', () => {
    studio.variations = Number(b.dataset.var);
    $$('#varSeg button').forEach((x) => x.classList.toggle('active', x === b));
    updateCost();
  }));
  $('#seconds').addEventListener('input', () => { updateCost(); saveDraft(); });
  $('#autoSec').addEventListener('change', () => { updateCost(); saveDraft(); });

  for (const slot of ['first', 'last']) {
    const el = $(`.drop[data-slot="${slot}"]`);
    el.addEventListener('click', async () => { const [f] = await pickFile('image/*'); if (f) setFrame(slot, f); });
    setupDrop(el, (files) => setFrame(slot, files[0]));
  }
  $('#refImgFile').addEventListener('change', (e) => { addRefImages([...e.target.files]); e.target.value = ''; });
  setupDrop($('#refImages'), addRefImages);
  $('#refVidFile').addEventListener('change', (e) => { if (e.target.files[0]) addRefFile('video', e.target.files[0]); e.target.value = ''; });
  $('#refAudFile').addEventListener('change', (e) => { if (e.target.files[0]) addRefFile('audio', e.target.files[0]); e.target.value = ''; });
  $$('[data-add-url]').forEach((b) => b.addEventListener('click', () => {
    const list = b.dataset.addUrl === 'video' ? studio.refVideos : studio.refAudios;
    if (list.length >= 10) return toast('Max 10', 'err');
    list.push({ url: '' });
    renderStudioMedia();
    updateCost();
  }));
  $('#pickGalleryVideo').addEventListener('click', openGalleryPicker);

  $('#enhanceBtn').addEventListener('click', enhance);
  $('#clearPromptBtn').addEventListener('click', () => { studio.prompt.value = ''; updatePromptCount(); saveDraft(); });
  $('#shotsToggle').addEventListener('click', () => {
    $('#shotsPanel').classList.toggle('hidden');
    if (!studio.shots.length) { studio.shots.push({ text: '', size: 'Wide shot' }, { text: '', size: 'Close-up' }); renderShots(); }
  });
  $('#addShotBtn').addEventListener('click', () => { studio.shots.push({ text: '', size: 'Medium shot' }); renderShots(); });
  $('#compileShotsBtn').addEventListener('click', compileShots);
  $('#generateBtn').addEventListener('click', generateFromStudio);

  loadDraft();
  renderStudioMedia();
  updatePromptCount();
  updateCost();
}

// ===========================================================================
// Gallery
// ===========================================================================

function renderGallery() {
  const q = $('#gallerySearch').value.trim().toLowerCase();
  const f = state.galleryFilter;
  const all = [...state.videos.values()].sort((a, b) => b.createdAt - a.createdAt);
  const vids = all.filter((v) => {
    if (q && !`${v.prompt} ${v.title || ''}`.toLowerCase().includes(q)) return false;
    if (f === 'active') return isActive(v);
    if (f === 'completed') return v.status === 'completed';
    if (f === 'failed') return v.status === 'failed' || v.status === 'cancelled';
    if (f === 'favorite') return v.favorite;
    return true;
  });
  const done = all.filter((v) => v.status === 'completed');
  $('#galleryStats').textContent = `${done.length} videos · ${done.reduce((s, v) => s + (Number(v.seconds) || 0), 0)}s of footage · ${money(state.config?.spend?.total)}`;
  $('#gallery').replaceChildren(...(vids.length ? vids.map((v) => videoCard(v, 'gallery')) : [h('div', { class: 'empty' }, all.length ? 'Nothing matches.' : 'No videos yet — head to Chat or Studio to make your first one.')]));
}

// ===========================================================================
// Settings
// ===========================================================================

function openSettings() {
  const s = state.config.settings;
  $('#setChatModel').replaceChildren(...state.config.chatModels.map((m) => h('option', { value: m.id, selected: m.id === s.chatModel }, m.label)));
  $('#setConfirm').checked = s.confirmBeforeGenerate;
  $('#setRes').value = s.defaultResolution;
  $('#setSec').value = s.defaultSeconds;
  $('#setWarn').value = s.spendWarning;
  const sp = state.config.spend;
  $('#usageText').textContent = `${sp.count} completed videos, ${sp.seconds}s generated, ${money(sp.total)} spent (per Together's reported cost).`;
  $('#settingsDialog').showModal();
}

async function saveSettings() {
  try {
    state.config.settings = await api('PUT', '/api/settings', {
      chatModel: $('#setChatModel').value,
      confirmBeforeGenerate: $('#setConfirm').checked,
      defaultResolution: $('#setRes').value,
      defaultSeconds: Math.min(30, Math.max(4, Number($('#setSec').value) || 5)),
      spendWarning: Math.max(0, Number($('#setWarn').value) || 0),
    });
    toast('Settings saved', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ===========================================================================
// Navigation + boot
// ===========================================================================

const TITLES = { chat: 'Director chat', studio: 'Studio', gallery: 'Gallery' };

function switchView(view) {
  state.view = view;
  $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $('#viewTitle').textContent = TITLES[view];
  if (view === 'gallery') renderGallery();
  if (view === 'studio') renderRecent();
  if (view === 'chat') renderMessages();
  try { localStorage.setItem('view', view); } catch { /* ignore */ }
}

async function boot() {
  state.config = await api('GET', '/api/config');
  if (!state.config.hasKey) toast('TOGETHER_API_KEY is not set on the server — add it to .env and restart.', 'err');
  $('#spendPill').textContent = `${money(state.config.spend.total)} spent`;
  $('#modelPill').textContent = state.config.videoModel;
  setRes(state.config.settings.defaultResolution);
  $('#seconds').value = state.config.settings.defaultSeconds;

  const { videos } = await api('GET', '/api/videos');
  videos.forEach((v) => state.videos.set(v.id, v));
  updateJobsBadge();

  $$('.rail-btn[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('[data-action="settings"]').addEventListener('click', openSettings);
  $('#settingsForm').addEventListener('submit', (e) => { if (e.submitter?.value === 'save') saveSettings(); });

  // chat
  $('#newChatBtn').addEventListener('click', newChat);
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
  $('#chatInput').addEventListener('input', autoGrow);
  $('#chatInput').addEventListener('paste', (e) => { const f = imageFilesFrom(e.clipboardData); if (f.length) { e.preventDefault(); addChatAttachments(f); } });
  $('#chatFile').addEventListener('change', (e) => { addChatAttachments([...e.target.files]); e.target.value = ''; });
  setupDrop($('#view-chat'), addChatAttachments);

  // gallery
  $('#gallerySearch').addEventListener('input', renderGallery);
  $$('#galleryFilter button').forEach((b) => b.addEventListener('click', () => {
    state.galleryFilter = b.dataset.filter;
    $$('#galleryFilter button').forEach((x) => x.classList.toggle('active', x === b));
    renderGallery();
  }));

  setupStudio();
  if (!localStorage.getItem('studioDraft')) setRes(state.config.settings.defaultResolution);

  await loadChats();
  let lastChat = null;
  try { lastChat = localStorage.getItem('chatId'); } catch { /* ignore */ }
  await openChat(state.chats.find((c) => c.id === lastChat)?.id || state.chats[0]?.id || null);

  let view = 'chat';
  try { view = localStorage.getItem('view') || 'chat'; } catch { /* ignore */ }
  switchView(TITLES[view] ? view : 'chat');
  pollLoop();
}

boot().catch((e) => toast(`Failed to start: ${e.message}`, 'err'));
