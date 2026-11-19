// public/js/prefsLoadout.js — 干员调配的跨浏览器恢复（仅 loadout，按昵称）。
// 旁路在游戏同步之外：welcome 后 GET /prefs/loadout；本地为空才灌回，随后放行 room.loadout；
// 之后订阅 loadoutStore 的 byChar / ops，去抖 POST。服务端未启用（404）时本模块整体停用。

import { savePref, store } from './store.js';
import { loadoutStore, refreshViews } from './ui/loadoutSync.js';
import { LOADOUT_PREF, toStored } from './ui/loadoutModel.js';
import { pageVersion } from './content.js';

const ENDPOINT = '/prefs/loadout';
const SAVE_DELAY_MS = 1200;
const FAST_TIMEOUT_MS = 3000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (v) => isObj(v) && Object.keys(v).length > 0;

let ready = false;
let enabled = true;
let started = false;
let name = null;
let version = null;
let rev = 0;
let loadedKey = null;
let syncingKey = null;
let syncSeq = 0;
let applying = false;
let dirty = false;
let timer = null;
let onReadyCb = null;

/** installLoadoutSync 的 gate：偏好拉取完成前不发送 room.loadout。 */
export const prefsGate = () => ready;

function notifyReady() {
  if (onReadyCb) {
    try { onReadyCb(); } catch (e) { console.warn('[prefs] onReady failed', e); }
  }
}

function currentPayload() {
  const s = loadoutStore.get();
  return { byChar: s.byChar || {}, ops: s.ops || {} };
}

/** 只要本地有任何一种已存形态（byChar / ops / 旧 entries），就认为本地非空。 */
function localEmpty() {
  const s = loadoutStore.get();
  return !hasKeys(s.byChar) && !hasKeys(s.ops) && !hasKeys(s.entries);
}

function applyPayload(payload) {
  if (!isObj(payload)) return;
  const byChar = isObj(payload.byChar) ? payload.byChar : {};
  const ops = isObj(payload.ops) ? payload.ops : {};
  applying = true;
  try {
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

function scheduleSave() {
  if (!enabled || !name) return;
  dirty = true;
  if (timer != null) globalThis.clearTimeout(timer);
  timer = globalThis.setTimeout(() => { timer = null; void saveNow(); }, SAVE_DELAY_MS);
}

async function saveNow(allowRetry = true) {
  if (!enabled || !name || !version) return;
  const payload = currentPayload();
  if (!hasKeys(payload.byChar) && !hasKeys(payload.ops)) return;
  try {
    const res = await request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, version, payload, baseRev: rev }),
    });
    if (res.status === 409 && allowRetry) {
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      rev = Number(json?.rev) || 0;
      // 熟人场景：本地视为最新，带新 rev 重试一次。
      return await saveNow(false);
    }
    if (res.status === 404) { enabled = false; dirty = false; return; }
    if (res.status === 405) { enabled = false; dirty = false; return; }
    if (!res.ok) {
      console.warn('[prefs] save refused', res.status);
      dirty = false;
      return;
    }
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    rev = Number(json?.rev) || rev;
    dirty = false;
  } catch (e) {
    console.warn('[prefs] save failed', e);
  }
}

function sendBeacon() {
  if (!enabled || !name || !version || !dirty) return;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function' || typeof Blob === 'undefined') return;
  const payload = currentPayload();
  if (!hasKeys(payload.byChar) && !hasKeys(payload.ops)) return;
  const body = JSON.stringify({ name, version, payload });
  try {
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    dirty = false;
  } catch { /* 忽略：下次编辑或进入时再传 */ }
}

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
    const url = `${ENDPOINT}?name=${encodeURIComponent(nextName)}&version=${encodeURIComponent(nextVersion)}`;
    const res = await request(url);
    if (seq !== syncSeq) return;
    if (res.status === 404) {
      enabled = false;
      ready = true;
      notifyReady();
      return;
    }
    if (!res.ok) throw new Error(`GET ${res.status}`);
    const type = res.headers?.get?.('content-type') || '';
    if (!type.includes('application/json')) {
      // 服务端未启用时，静态路由可能回一个 HTML 页面：直接停用，避免后续无意义的上传。
      enabled = false;
      ready = true;
      notifyReady();
      return;
    }
    const json = await res.json();
    if (seq !== syncSeq) return;
    rev = Number(json?.rev) || 0;
    loadedKey = key;
    if (json?.found) {
      if (localEmpty()) applyPayload(json.payload);
      else await saveNow();
    } else if (!localEmpty()) {
      await saveNow();
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
 * Wire the preference bridge once, after the loadout sync is installed.
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
    if (applying) return;
    if (s.byChar === prev.byChar && s.ops === prev.ops) return;
    if (!name) return;
    scheduleSave();
  });
  if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('pagehide', sendBeacon);
  return { gate: prefsGate };
}
