// public/js/prefsLoadout.js — 干员调配 + 自选编队的跨浏览器恢复（按昵称）。
// 旁路在游戏同步之外：welcome 后并行 GET /prefs/loadout（kind=loadout / kind=diy）；
// 本地为空才灌回，随后放行 room.loadout / room.diy；之后订阅两个 store，去抖 POST。
// 服务端未启用（404）时本模块整体停用。

import { savePref, store } from './store.js';
import { loadoutStore, refreshViews, setDiyPicks } from './ui/loadoutSync.js';
import { LOADOUT_PREF, toStored } from './ui/loadoutModel.js';
import { pageVersion } from './content.js';

const ENDPOINT = '/prefs/loadout';
const KINDS = ['loadout', 'diy'];
const SAVE_DELAY_MS = 1200;
const FAST_TIMEOUT_MS = 3000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (v) => isObj(v) && Object.keys(v).length > 0;

let ready = false;
let enabled = true;
let started = false;
let name = null;
let version = null;
let loadedKey = null;
let syncingKey = null;
let syncSeq = 0;
let applying = false;
let timer = null;
let onReadyCb = null;

/** 每类偏好的 row_version，冲突重试时更新。 */
const revs = { loadout: 0, diy: 0 };
/** 每类偏好是否有待上传的修改。 */
const dirty = { loadout: false, diy: false };

/** installLoadoutSync / installDiySync 的 gate：偏好拉取完成前不发送游戏消息。 */
export const prefsGate = () => ready;

function notifyReady() {
  if (onReadyCb) {
    try { onReadyCb(); } catch (e) { console.warn('[prefs] onReady failed', e); }
  }
}

function currentPayload(kind) {
  if (kind === 'diy') return { picks: loadoutStore.get().diy || {} };
  const s = loadoutStore.get();
  return { byChar: s.byChar || {}, ops: s.ops || {} };
}

function hasPayload(kind, payload) {
  if (!isObj(payload)) return false;
  return kind === 'diy' ? hasKeys(payload.picks) : (hasKeys(payload.byChar) || hasKeys(payload.ops));
}

/** 只要本地有任何一种已存形态（byChar / ops / 旧 entries），就认为干员调配本地非空。 */
function localEmpty(kind) {
  if (kind === 'diy') return !hasKeys(loadoutStore.get().diy);
  const s = loadoutStore.get();
  return !hasKeys(s.byChar) && !hasKeys(s.ops) && !hasKeys(s.entries);
}

function applyPayload(kind, payload) {
  if (!isObj(payload)) return;
  applying = true;
  try {
    if (kind === 'diy') {
      setDiyPicks(isObj(payload.picks) ? payload.picks : {});
      return;
    }
    const byChar = isObj(payload.byChar) ? payload.byChar : {};
    const ops = isObj(payload.ops) ? payload.ops : {};
    loadoutStore.set({ byChar, ops });
    try { savePref(LOADOUT_PREF, toStored(byChar, ops)); } catch { /* 隐私模式：本次会话仍可用 */ }
    refreshViews();
  } finally {
    applying = false;
  }
}

async function request(url, options = {}, timeout = FAST_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = globalThis.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    globalThis.clearTimeout(t);
  }
}

function scheduleSave(kind) {
  if (!enabled || !name) return;
  dirty[kind] = true;
  if (timer != null) globalThis.clearTimeout(timer);
  timer = globalThis.setTimeout(() => { timer = null; void saveDirty(); }, SAVE_DELAY_MS);
}

async function saveDirty() {
  const jobs = KINDS.filter((kind) => dirty[kind]);
  await Promise.all(jobs.map((kind) => saveNow(kind)));
}

async function saveNow(kind, allowRetry = true) {
  if (!enabled || !name || !version) return;
  const payload = currentPayload(kind);
  if (!hasPayload(kind, payload)) { dirty[kind] = false; return; }
  try {
    const res = await request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, version, kind, payload, baseRev: revs[kind] }),
    });
    if (res.status === 409 && allowRetry) {
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      revs[kind] = Number(json?.rev) || 0;
      // 熟人场景：本地视为最新，带新 rev 重试一次。
      return await saveNow(kind, false);
    }
    if (res.status === 404 || res.status === 405) {
      enabled = false;
      dirty.loadout = false;
      dirty.diy = false;
      return;
    }
    if (!res.ok) {
      console.warn('[prefs] save refused', kind, res.status);
      dirty[kind] = false;
      return;
    }
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    revs[kind] = Number(json?.rev) || revs[kind];
    dirty[kind] = false;
  } catch (e) {
    console.warn('[prefs] save failed', kind, e);
  }
}

function sendBeacon() {
  if (!enabled || !name || !version) return;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function' || typeof Blob === 'undefined') return;
  for (const kind of KINDS) {
    if (!dirty[kind]) continue;
    const payload = currentPayload(kind);
    if (!hasPayload(kind, payload)) continue;
    const body = JSON.stringify({ name, version, kind, payload });
    try {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      dirty[kind] = false;
    } catch { /* 忽略：下次编辑或进入时再传 */ }
  }
}

const profileUrl = (kind) => `${ENDPOINT}?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}&kind=${kind}`;

async function syncProfile(msg) {
  if (!enabled) { ready = true; return; }
  const nextName = typeof msg?.name === 'string' ? msg.name.trim() : '';
  if (!nextName) { ready = true; return; }
  const nextVersion = pageVersion();
  const key = `${nextName}\u0000${nextVersion}`;
  name = nextName;
  version = nextVersion;
  if (key === loadedKey) { ready = true; return; }
  if (key === syncingKey) return;

  const seq = ++syncSeq;
  syncingKey = key;
  ready = false;
  try {
    const responses = await Promise.all(KINDS.map((kind) => request(profileUrl(kind))));
    if (seq !== syncSeq) return;
    const results = [];
    for (const res of responses) {
      if (res.status === 404 || res.status === 405) { enabled = false; return; }
      const type = res.headers?.get?.('content-type') || '';
      if (!type.includes('application/json')) {
        // 服务端未启用时，静态路由可能回一个 HTML 页面：直接停用，避免后续无意义的上传。
        enabled = false;
        return;
      }
      if (!res.ok) throw new Error(`GET ${res.status}`);
      results.push(await res.json());
    }
    if (seq !== syncSeq) return;
    loadedKey = key;
    // 先把自选编队切到当前版本自己的 localStorage 记录，再判断“本地是否为空”（applying 防止这次读取触发上传）。
    applying = true;
    try { refreshViews(); } finally { applying = false; }
    for (let i = 0; i < KINDS.length; i++) {
      if (seq !== syncSeq) return;
      const kind = KINDS[i];
      const json = results[i];
      revs[kind] = Number(json?.rev) || 0;
      if (json?.found) {
        if (localEmpty(kind)) applyPayload(kind, json.payload);
        else await saveNow(kind);
      } else if (!localEmpty(kind)) {
        await saveNow(kind);
      }
    }
  } catch (e) {
    console.warn('[prefs] load failed', e);
  } finally {
    if (seq === syncSeq) {
      syncingKey = null;
      ready = true;
      notifyReady();
    }
  }
}

/**
 * Wire the preference bridge once, after the loadout / diy syncs are installed.
 * @param {{ net: any, onReady?: () => void }} deps
 */
export function initPrefsLoadout({ net, onReady = null } = {}) {
  if (started) return { gate: prefsGate };
  started = true;
  onReadyCb = onReady;

  net.on('welcome', (msg) => { void syncProfile(msg); });
  // welcome 可能在初始化之前已经到达（快速重连/热重载）：仅在已在线时补一次。
  const knownName = store.get().me?.name;
  if (net.status === 'online' && typeof knownName === 'string' && knownName.trim()) void syncProfile({ name: knownName });
  loadoutStore.subscribe((s, prev) => {
    if (applying || !name) return;
    if (s.byChar !== prev.byChar || s.ops !== prev.ops) scheduleSave('loadout');
    if (s.diy !== prev.diy) scheduleSave('diy');
  });
  if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('pagehide', sendBeacon);
  return { gate: prefsGate };
}
