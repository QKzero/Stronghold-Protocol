// server/prefsLoadout.js — 按昵称保存干员调配（仅 loadout）到本地 SQLite，供换浏览器后恢复。
// 总开关 SP_PREFS=1；目录固定为 <当前工作目录>/dataSQL/personal-prefs.sqlite，不额外读路径参数。
// 独立旁路：只由 server/http/routes.js 挂一个 /prefs/loadout 的 HTTP 路由，不改游戏协议、不改 lobby.js。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOADOUT_LIMITS, checkLoadout, checkLoadoutOps, cultivationCharIds, charPotentialChanges, isLoadoutEntries, isLoadoutOps,
} from '../shared/protocol.js';
import { DEFAULT_VERSION, versionById } from '../shared/versions.js';
import { getVersionData } from './data.js';
import { sendJson, splitUrl } from './http/common.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREF_DIR = 'dataSQL';
const PREF_FILE = 'personal-prefs.sqlite';
const MAX_BODY = 256 * 1024;
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const SERVED_DIRS = ['public', 'data', 'shared', 'packs', 'plugins'].map((d) => path.join(ROOT, d));

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const enabledByEnv = () => /^(1|true|yes|on)$/i.test(String(process.env.SP_PREFS ?? '').trim());

/** 昵称规范化：NFC、去首尾空白、压缩内部空白、长度上限 64。 */
function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  return name && name.length <= 64 ? name : null;
}

/** 存储键：规范化昵称再小写，避免大小写/全半角差异产生两个档案。 */
function profileKey(name) {
  return crypto.createHash('sha256').update(name.normalize('NFC').toLowerCase(), 'utf8').digest('hex');
}

/** 该路径是否位于某个对外的静态目录中（数据库绝不能落进去）。 */
function insideAny(file, dirs) {
  return dirs.some((dir) => {
    const rel = path.relative(dir, file);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** 把一个棋子是否可作为干员调配槽位（与 ui/loadoutModel.js isLoadoutSlot 同义）。 */
const isLoadoutSlot = (c) => !!c && !c.isGolden && c.visible !== false && !c.isHidden && !c.isDiy
  && (!c.baseId || c.baseId === c.chessId);

/** charId → 该版本的调配槽位棋子（每个干员取第一个可见普通棋子）。 */
function slotByChar(chess) {
  const out = new Map();
  for (const c of Object.values(chess || {})) {
    if (!isLoadoutSlot(c) || typeof c.charId !== 'string' || out.has(c.charId)) continue;
    out.set(c.charId, c);
  }
  return out;
}

/**
 * 校验并规范化 { byChar, ops }：未知/隐藏干员与过期条目被丢弃，默认值被省略；不整包拒绝。
 * 这样切换版本后 byChar 里残留的其它版本干员不会让整次保存失败。
 */
function cleanPayload(payload, version, defaultData, log) {
  if (!isPlain(payload)) return { error: 'BAD_PAYLOAD' };
  const byChar = payload.byChar ?? {};
  const ops = payload.ops ?? {};
  if (!isPlain(byChar) || !isPlain(ops)) return { error: 'BAD_PAYLOAD' };
  if (!isLoadoutEntries(byChar)) return { error: 'BAD_LOADOUT' };
  if (!isLoadoutOps(ops)) return { error: 'BAD_OPS' };

  let data;
  try {
    data = version === DEFAULT_VERSION && defaultData ? defaultData : getVersionData(version, { log });
  } catch { return { error: 'BAD_VERSION' }; }
  const chess = data.chess || {};
  const getChess = (id) => (Object.hasOwn(chess, id) ? chess[id] : null);
  const slots = slotByChar(chess);

  const outByChar = Object.create(null);
  for (const [charId, entry] of Object.entries(byChar)) {
    if (UNSAFE_IDS.has(charId)) continue;
    const c = slots.get(charId);
    if (!c) continue;
    const checked = checkLoadout({ [c.chessId]: entry }, getChess);
    if (!checked.ok || !checked.loadout[c.chessId]) continue;
    outByChar[charId] = checked.loadout[c.chessId];
  }

  const operators = cultivationCharIds(chess, data.backups);
  const outOps = Object.create(null);
  for (const [charId, entry] of Object.entries(ops)) {
    if (UNSAFE_IDS.has(charId) || !operators.has(charId)) continue;
    const checked = checkLoadoutOps({ [charId]: entry }, (id) => operators.has(id), (id) => charPotentialChanges(data, id));
    if (checked.ok && checked.ops[charId]) outOps[charId] = checked.ops[charId];
  }
  return { payload: { byChar: outByChar, ops: outOps } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) { reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' })); return; }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * 创建偏好存储与 HTTP 处理器。
 * SP_PREFS 未开启返回 null；node:sqlite 不可用或数据库打不开时记日志并返回 null（游戏主体继续运行）。
 * @param {{ log?: object, data?: any }} [opts]
 * @returns {Promise<null | { handle: (req: any, res: any) => Promise<void>, close: () => void }>}
 */
export async function createPrefsLoadout({ log = console, data: defaultData = null } = {}) {
  if (!enabledByEnv()) return null;

  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch {
    log.warn('[prefs] node:sqlite unavailable (Node >= 22.5 required) — 干员配置云同步已禁用');
    return null;
  }

  const dir = path.resolve(process.cwd(), PREF_DIR);
  const dbFile = path.join(dir, PREF_FILE);
  if (insideAny(dbFile, SERVED_DIRS)) {
    log.error(`[prefs] refusing to store the database inside a served directory: ${dbFile}`);
    return null;
  }

  let db;
  try {
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA busy_timeout=3000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pref (
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, kind, version)
      );
    `);
  } catch (e) {
    log.error(`[prefs] cannot open ${dbFile}`, e);
    try { db?.close(); } catch { /* ignore */ }
    return null;
  }

  const selectPref = db.prepare('SELECT payload, rev, updated_at FROM pref WHERE key = ? AND kind = ? AND version = ?');
  const upsertProfile = db.prepare(`
    INSERT INTO profile (key, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
  `);
  const upsertPref = db.prepare(`
    INSERT INTO pref (key, kind, version, payload, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key, kind, version) DO UPDATE SET payload = excluded.payload, rev = excluded.rev, updated_at = excluded.updated_at
  `);

  const parseRow = (row) => {
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload);
      return isPlain(payload) ? { payload, rev: Number(row.rev) || 0, updatedAt: Number(row.updated_at) || 0 } : null;
    } catch {
      log.warn('[prefs] ignoring a malformed stored payload');
      return null;
    }
  };

  function load(name, version) {
    return parseRow(selectPref.get(profileKey(name), 'loadout', version));
  }

  function save(name, version, payload, baseRev) {
    const key = profileKey(name);
    const existing = parseRow(selectPref.get(key, 'loadout', version));
    const currentRev = existing?.rev ?? 0;
    if (baseRev != null && Number(baseRev) !== currentRev) {
      return { conflict: true, rev: currentRev, payload: existing?.payload ?? null };
    }
    // 新浏览器初始的空值不能覆盖已有配置；清空配置暂不同步（需要时再加显式 force）。
    const empty = !Object.keys(payload.byChar || {}).length && !Object.keys(payload.ops || {}).length;
    if (empty && existing && (Object.keys(existing.payload.byChar || {}).length || Object.keys(existing.payload.ops || {}).length)) {
      return { skipped: true, rev: currentRev };
    }
    const now = Date.now();
    const nextRev = currentRev + 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertProfile.run(key, name, now, now);
      upsertPref.run(key, 'loadout', version, JSON.stringify(payload), nextRev, now);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    return { rev: nextRev, updatedAt: now };
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }

    let name = null;
    let version = DEFAULT_VERSION;
    let payload = null;
    let baseRev = null;

    if (req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) {
        sendJson(req, res, e?.code === 'TOO_LARGE' ? 413 : 400, { error: e?.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BAD_BODY' });
        return;
      }
      let msg;
      try { msg = JSON.parse(body); } catch { sendJson(req, res, 400, { error: 'BAD_JSON' }); return; }
      if (!isPlain(msg)) { sendJson(req, res, 400, { error: 'BAD_BODY' }); return; }
      name = normalizeName(msg.name);
      version = typeof msg.version === 'string' && msg.version ? msg.version : DEFAULT_VERSION;
      payload = msg.payload;
      baseRev = msg.baseRev == null ? null : Number(msg.baseRev);
    } else {
      const parts = splitUrl(req.url || '/');
      const query = new URLSearchParams(parts?.query || '');
      name = normalizeName(query.get('name') || '');
      version = query.get('version') || DEFAULT_VERSION;
    }

    if (!name) { sendJson(req, res, 400, { error: 'BAD_NAME' }); return; }
    if (!versionById(version)) { sendJson(req, res, 400, { error: 'BAD_VERSION' }); return; }

    if (req.method === 'POST') {
      const cleaned = cleanPayload(payload, version, defaultData, log);
      if (cleaned.error) { sendJson(req, res, 400, { error: cleaned.error }); return; }
      const result = save(name, version, cleaned.payload, baseRev);
      if (result.conflict) {
        sendJson(req, res, 409, { error: 'CONFLICT', rev: result.rev, payload: result.payload });
        return;
      }
      sendJson(req, res, 200, { ok: true, rev: result.rev, updatedAt: result.updatedAt ?? null, skipped: !!result.skipped });
      return;
    }

    const found = load(name, version);
    sendJson(req, res, 200, found
      ? { found: true, rev: found.rev, updatedAt: found.updatedAt, payload: found.payload }
      : { found: false });
  }

  log.info(`[prefs] SQLite: ${dbFile}`);

  return {
    handle,
    close() {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
