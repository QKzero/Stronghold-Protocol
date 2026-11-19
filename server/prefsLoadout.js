// server/prefsLoadout.js — 按昵称保存干员调配（loadout）与自选编队（diy）到本地 SQLite，供换浏览器后恢复。
// 总开关 SP_PREFS=1；目录固定为 <当前工作目录>/dataSQL/personal-prefs.sqlite，不额外读路径参数。
// 独立旁路：只由 server/http/routes.js 挂一个 /prefs/loadout 的 HTTP 路由，不改游戏协议、不改 lobby.js。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkLoadout, checkLoadoutOps, checkDiyPicks, cultivationCharIds, charPotentialChanges, isLoadoutEntries, isLoadoutOps,
} from '../shared/protocol.js';
import { DEFAULT_VERSION, versionById } from '../shared/versions.js';
import { getVersionData } from './data.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';
import { sendJson, splitUrl } from './http/common.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREF_DIR = 'dataSQL';
const PREF_FILE = 'personal-prefs.sqlite';
const MAX_BODY = 256 * 1024;
const PREF_KINDS = new Set(['loadout', 'diy']);
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
function userCode(name) {
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
function cleanLoadoutPayload(payload, version, defaultData, log) {
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

/**
 * 校验并规范化 { picks }：只保留该版本合法的自选编队槽位与干员（checkDiyPicks + KITTED_CHARS），
 * 非法条目丢弃而不是整包拒绝。
 */
function cleanDiyPayload(payload, version, defaultData, log) {
  if (!isPlain(payload) || !isPlain(payload.picks)) return { error: 'BAD_PAYLOAD' };
  let data;
  try {
    data = version === DEFAULT_VERSION && defaultData ? defaultData : getVersionData(version, { log });
  } catch { return { error: 'BAD_VERSION' }; }
  const checked = checkDiyPicks(payload.picks, { data, kitted: KITTED_CHARS });
  if (!checked || !('ok' in checked)) return { error: 'BAD_DIY' };
  return { payload: { picks: checked.picks } };
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
    log.warn('[prefs] node:sqlite unavailable (Node >= 22.5 required) — 干员调配/自选编队云同步已禁用');
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
    // user：一个规范化昵称一条用户档案；user_code 是昵称哈希，作为跨浏览器恢复的稳定标识。
    // preference：按「用户 + 偏好类型 + 官方版本」保存一条偏好；type 为 'loadout'（干员调配）或 'diy'（自选编队）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS "user" (
        user_code TEXT PRIMARY KEY,     -- 昵称哈希：sha256(规范化昵称小写)，不含明文昵称
        name TEXT NOT NULL,             -- 规范化后的显示昵称（NFC、去首尾/压缩空白）
        create_time INTEGER NOT NULL,   -- 首次建档时间（毫秒时间戳）
        modify_time INTEGER NOT NULL    -- 最后一次写入时间（毫秒时间戳）
      );
      CREATE TABLE IF NOT EXISTS preference (
        user_code TEXT NOT NULL,        -- 关联 user.user_code
        type TEXT NOT NULL,             -- 偏好类型：'loadout'（干员调配）或 'diy'（自选编队）
        slug_version TEXT NOT NULL,     -- 官方版本 id（如 act2autochess@V2_1），按版本隔离配置
        "value" TEXT NOT NULL,          -- 偏好内容 JSON：loadout 为 { byChar, ops }；diy 为 { picks }
        row_version INTEGER NOT NULL,   -- 乐观锁修订号：每次成功写入 +1，用于 409 冲突检测
        modify_time INTEGER NOT NULL,   -- 本条偏好的最后修改时间（毫秒时间戳）
        PRIMARY KEY (user_code, type, slug_version)
      );
    `);
  } catch (e) {
    log.error(`[prefs] cannot open ${dbFile}`, e);
    try { db?.close(); } catch { /* ignore */ }
    return null;
  }

  // 读取某用户在某官方版本下的 loadout；row_version 即客户端保存时携带的 baseRev。
  const selectPreference = db.prepare('SELECT "value", row_version, modify_time FROM preference WHERE user_code = ? AND type = ? AND slug_version = ?');
  // 用户档案 upsert：create_time 只在首次插入时写入，后续只更新昵称与 modify_time。
  const upsertUser = db.prepare(`
    INSERT INTO "user" (user_code, name, create_time, modify_time) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_code) DO UPDATE SET name = excluded.name, modify_time = excluded.modify_time
  `);
  // 偏好 upsert：同一 (user_code, type, slug_version) 覆盖 value、row_version 与 modify_time。
  const upsertPreference = db.prepare(`
    INSERT INTO preference (user_code, type, slug_version, "value", row_version, modify_time) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_code, type, slug_version) DO UPDATE SET "value" = excluded."value", row_version = excluded.row_version, modify_time = excluded.modify_time
  `);

  const parseRow = (row) => {
    if (!row) return null;
    try {
      const payload = JSON.parse(row.value);
      return isPlain(payload) ? { payload, rev: Number(row.row_version) || 0, updatedAt: Number(row.modify_time) || 0 } : null;
    } catch {
      log.warn('[prefs] ignoring a malformed stored payload');
      return null;
    }
  };

  function load(name, version, kind) {
    return parseRow(selectPreference.get(userCode(name), kind, version));
  }

  /** 一条偏好的“非空”字段数：loadout 看 byChar/ops，diy 看 picks。 */
  const payloadSize = (kind, payload) => (kind === 'diy'
    ? Object.keys(payload?.picks || {}).length
    : Object.keys(payload?.byChar || {}).length + Object.keys(payload?.ops || {}).length);

  function save(name, version, kind, payload, baseRev) {
    const code = userCode(name);
    const existing = parseRow(selectPreference.get(code, kind, version));
    const currentRev = existing?.rev ?? 0;
    if (baseRev != null && Number(baseRev) !== currentRev) {
      return { conflict: true, rev: currentRev, payload: existing?.payload ?? null };
    }
    // 空配置不落库：新浏览器初始空值既不能覆盖已有配置，也不必创建空档案（清空配置暂不支持）。
    if (payloadSize(kind, payload) === 0) {
      return { skipped: true, rev: currentRev };
    }
    const now = Date.now();
    const nextRev = currentRev + 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertUser.run(code, name, now, now);
      upsertPreference.run(code, kind, version, JSON.stringify(payload), nextRev, now);
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

    let name;
    let version;
    let kind;
    let payload;
    let baseRev;

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
      kind = typeof msg.kind === 'string' && msg.kind ? msg.kind : 'loadout';
      payload = msg.payload;
      baseRev = msg.baseRev == null ? null : Number(msg.baseRev);
    } else {
      const parts = splitUrl(req.url || '/');
      const query = new URLSearchParams(parts?.query || '');
      name = normalizeName(query.get('name') || '');
      version = query.get('version') || DEFAULT_VERSION;
      kind = query.get('kind') || 'loadout';
    }

    if (!name) { sendJson(req, res, 400, { error: 'BAD_NAME' }); return; }
    if (!versionById(version)) { sendJson(req, res, 400, { error: 'BAD_VERSION' }); return; }
    if (!PREF_KINDS.has(kind)) { sendJson(req, res, 400, { error: 'BAD_KIND' }); return; }

    if (req.method === 'POST') {
      const cleaned = kind === 'diy'
        ? cleanDiyPayload(payload, version, defaultData, log)
        : cleanLoadoutPayload(payload, version, defaultData, log);
      if (cleaned.error) { sendJson(req, res, 400, { error: cleaned.error }); return; }
      const result = save(name, version, kind, cleaned.payload, baseRev);
      if (result.conflict) {
        sendJson(req, res, 409, { error: 'CONFLICT', rev: result.rev, payload: result.payload });
        return;
      }
      sendJson(req, res, 200, { ok: true, rev: result.rev, updatedAt: result.updatedAt ?? null, skipped: !!result.skipped });
      return;
    }

    const found = load(name, version, kind);
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
