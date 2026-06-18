// index.js
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");
const express = require("express");
const { Redis } = require("@upstash/redis");

const app = express();

// ─── ENV VALIDATION ───────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set — Discord bot will not start.");
  process.exit(1);
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL hoặc UPSTASH_REDIS_REST_TOKEN chưa được set — bot sẽ không thể kết nối Redis.");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// Các giới hạn dùng chung với deploy-commands.js (slash command options) được
// tách sang constants.js để tránh duplicate/lệch giá trị giữa 2 file.
const {
  SANITY_MIN,
  POISE_MAX,
  SINKING_MAX,
  RUPTURE_MAX,
  PARRY_MAX_ROLLS,
  OPEN_COUNT_MAX,
  MAX_PROFILES,
  PROFILE_NAME_MAX_LENGTH,
  BUTTERFLY_LIVING_MAX,
  BUTTERFLY_DEPARTED_MAX,
  GRADE_MAX,
  GRADE_MIN,
} = require("./constants");
const POISE_CRIT_BONUS_PER_STACK = 0.05;
const POISE_RESET_THRESHOLD = 1;
const POISE_CRIT_DIV_DEFAULT = 2;

// ─── REAL-TIME PARRY ──────────────────────────────────────────────────────────
// Map<sessionId, session> — lưu trạng thái từng phiên parry đang chạy
const activeParrySessions = new Map();

// Dọn session "chết" (không có hoạt động gì trong 5 phút) mỗi 30 giây để tránh
// memory leak. Dùng lastActivityAt (cập nhật mỗi lần tick/đổi round/bấm nút) thay
// vì createdAt — vì 1 session nhiều round (-rtparry 20) có thể chạy lâu hơn 30s
// dù vẫn còn sống; nếu dùng createdAt thì session sẽ bị xóa khỏi map giữa lúc
// đang chạy, khiến người chơi bấm nút parry bị báo "phiên đã kết thúc" sai.
const PARRY_SESSION_STALE_MS = 5 * 60_000;
const parrySessionCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - PARRY_SESSION_STALE_MS;
  for (const [id, s] of activeParrySessions)
    if ((s.lastActivityAt ?? s.createdAt) < cutoff) activeParrySessions.delete(id);
}, 30_000);

/** Tạo ActionRow với 1 nút parry duy nhất */
function buildParryRow(customId, label, style, disabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled)
  );
}

// ─── DAILY REWARDS ────────────────────────────────────────────────────────────
const DAILY_EXP_REWARD = 5;
const DAILY_AHN_REWARD = 100_000;
const DAILY_STREAK_EXP_BONUS = 25;
const DAILY_STREAK_AHN_BONUS = 400_000;
// TTL 2 ngày (thay vì 1 ngày) là có chủ ý:
// - Nếu user điểm danh ngày 1, skip ngày 2, rồi điểm ngày 3: key vẫn còn nhưng
//   lastClaim (ngày 1) ≠ yesterdayStr (ngày 2) → streak reset về 1 đúng logic.
// - TTL 1 ngày sẽ khiến key expire đúng lúc ngày 2 reset, và nếu user điểm danh
//   ngay tại thời điểm ranh giới có thể mất key sớm hơn dự kiến.
// → TTL 2 ngày là safety margin, không ảnh hưởng đến tính đúng của streak logic.
const DAILY_KEY_TTL_SECONDS = 86400 * 2;

// ─── LEVELING ─────────────────────────────────────────────────────────────────
const GRADE_EXP_REQUIRED = {
  9: 5,
  8: 10,
  7: 20,
  6: 40,
  5: 80,
  4: 160,
  3: 320,
  2: 640,
};
// GRADE_MAX / GRADE_MIN được import từ constants.js (dùng chung với deploy-commands.js)

const EXP_MAX = Object.values(GRADE_EXP_REQUIRED).reduce((a, b) => a + b, 0); // 1275

function clampExp(exp) {
  return Math.min(Math.max(0, exp), EXP_MAX);
}

function calcGrade(totalExp) {
  let grade = GRADE_MIN;
  let remaining = totalExp;

  while (grade > GRADE_MAX) {
    const needed = GRADE_EXP_REQUIRED[grade];
    if (needed === undefined) break;
    if (remaining >= needed) {
      remaining -= needed;
      grade--;
    } else {
      break;
    }
  }

  const expNeeded = grade > GRADE_MAX ? (GRADE_EXP_REQUIRED[grade] ?? null) : null;
  return { grade, expInCurrentGrade: remaining, expNeeded };
}

function calcExpForGrade(targetGrade) {
  if (targetGrade < GRADE_MAX || targetGrade > GRADE_MIN) {
    throw new RangeError(`targetGrade phải từ ${GRADE_MAX}–${GRADE_MIN}, nhận được: ${targetGrade}`);
  }
  let total = 0;
  for (let g = GRADE_MIN; g > targetGrade; g--) {
    total += GRADE_EXP_REQUIRED[g] ?? 0;
  }
  return total;
}

// ─── UI CONSTANTS ─────────────────────────────────────────────────────────────
const INVENTORY_HINT_TEXT = "Dùng /inventory hoặc -inventory để xem chi tiết sách và vật phẩm";

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS ?? "208187560692940803,1072123095739019346,675899106614575150,1341034013036511355")
    .split(",").map(s => s.trim()).filter(Boolean)
);

// ─── BOOK POOLS ───────────────────────────────────────────────────────────────
const RANDOM_BOOK_POOL = [
  "Book Thường",
  "Hana Association Book",
  "Zwei Association Book",
  "Shi Association Book",
  "Cinq Association Book",
  "Liu Association Book",
  "Seven Association Book",
  "Dieci Association Book",
  "Thumb Syndicate Book",
  "Index Syndicate Book",
  "Middle Syndicate Book",
  "Ring Syndicate Book",
  "Blade Lineage Syndicate Book",
  "Kurokumo Syndicate Book",
  "Smiling Faces Syndicate Book",
  "N Corp Book",
  "Sweeping Book",
];

const SEALED_BOOK_POOL = [
  "Warp Corp Book",
  "Fragment Book",
  "Udjat Book",
  "Red Gaze Book",
  "Red Mist Book",
  "Black Silence Book",
  "Library Book",
  "Book of The Birds",
  "Arbiter Book",
  "Book of M.A.D.",
  "Reverbation Ensemble Book",
  "The Middle Big Brother Book",
];

const CHIPBOARD_CACHE_POOL = [
  "Chipboard MK1",
  "Chipboard MK2",
  "Chipboard MK3",
];

// ─── VALID BOOKS & ITEMS ──────────────────────────────────────────────────────
const VALID_BOOKS_EXTRA = ["Random Book", "Sealed Book Cache", "Book of Choice", "Book of Sorcerer"];
const VALID_BOOKS = [...new Set([...VALID_BOOKS_EXTRA, ...RANDOM_BOOK_POOL, ...SEALED_BOOK_POOL])];

// Derive từ CHIPBOARD_CACHE_POOL để tránh khai báo trùng MK1–MK3
const VALID_ITEMS = [
  ...CHIPBOARD_CACHE_POOL,
  "Chipboard MK4",
  "Chipboard MK5",
  "Uptie Module",
  "Chipboard Cache",
];

// ─── CRAFT RECIPES ────────────────────────────────────────────────────────────
const CRAFT_RECIPES = {
  "Chipboard MK2": { inputs: { "Chipboard MK1": 4 }, output: { "Chipboard MK2": 1 } },
  "Chipboard MK3": { inputs: { "Chipboard MK2": 4 }, output: { "Chipboard MK3": 1 } },
  "Chipboard MK4": { inputs: { "Chipboard MK3": 4, "Uptie Module": 1 }, output: { "Chipboard MK4": 1 } },
  "Chipboard MK5": { inputs: { "Chipboard MK4": 4, "Uptie Module": 1 }, output: { "Chipboard MK5": 1 } },
};

const VALID_ITEMS_SET = new Set(VALID_ITEMS.map(i => i.toLowerCase()));

const BOOK_LOOKUP_MAP = new Map(VALID_BOOKS.map(b => [b.toLowerCase(), b]));
const ITEM_LOOKUP_MAP = new Map(VALID_ITEMS.map(i => [i.toLowerCase(), i]));

function findBook(input) {
  return BOOK_LOOKUP_MAP.get(input.toLowerCase().trim()) ?? null;
}

function findItem(input) {
  return ITEM_LOOKUP_MAP.get(input.toLowerCase().trim()) ?? null;
}

const ADMIN_ITEM_NAME_MAX_LENGTH = 100;
function findItemAdmin(input) {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > ADMIN_ITEM_NAME_MAX_LENGTH) return null;
  return trimmed;
}

// ─── parseKeyValues ───────────────────────────────────────────────────────────
const KNOWN_KEYS = new Set([
  "book", "count", "item", "itemcount", "ahn", "exp", "grade",
  "dmg", "res", "dr", "bonus", "critmul", "critdiv",
  "sanity", "sanitybonus", "sinking", "rupture", "dicemul",
  "poise",
  "living", "departed",
  "books", "items",
]);

const _KV_KEY_RE_SRC = `(?:^|\\s)(${Array.from(KNOWN_KEYS).join("|")})\\s*:`;

function parseKeyValues(input) {
  const _KV_KEY_RE = new RegExp(_KV_KEY_RE_SRC, "gi");
  const anchors = [];
  let m;
  while ((m = _KV_KEY_RE.exec(input)) !== null) {
    anchors.push({
      key: m[1].toLowerCase(),
      matchStart: m.index,
      valueStart: m.index + m[0].length,
    });
  }
  const result = {};
  for (let i = 0; i < anchors.length; i++) {
    const { key, valueStart } = anchors[i];
    const valueEnd = i + 1 < anchors.length ? anchors[i + 1].matchStart : input.length;
    result[key] = input.slice(valueStart, valueEnd).trim();
  }
  return result;
}

function filterZeroFields(fields) {
  return fields.filter((f) => {
    if (f.alwaysShow) return true;
    if ("showIf" in f) return f.showIf;
    // Fallback cho các field không có showIf
    const v = String(f.value).trim();
    return v !== "0" && v !== "No";
  });
}

/**
 * Bão hòa % Dmg Bonus:
 *  0–100%   → tỷ lệ 1:1   (đầy đủ)
 *  100–200% → tỷ lệ 0.5:1 (mỗi 1% chỉ còn 0.5%)
 *  200%+    → tỷ lệ 0.25:1 (mỗi 1% chỉ còn 0.25%)
 */
function saturateBonusPct(raw) {
  if (raw <= 100) return raw;
  if (raw <= 200) return 100 + (raw - 100) * 0.5;
  if (raw <= 300) return 150 + (raw - 200) * 0.25;
  return 175 + (raw - 300) * 0.125; // 100 + 50 + 25 + (raw-300)*0.125
}

/**
 * Bão hòa % Damage Reduction (dr < 1x):
 *  DR 0–25%  → tỷ lệ 1:1
 *  DR 25–50% → tỷ lệ 0.5:1
 *  DR 50%+   → tỷ lệ 0.05:1
 * DR >= 1x (vulnerability hoặc neutral) không bị ảnh hưởng.
 * CHỈ áp dụng cho Damage Reduction (dr) — Res (B/P/S) không còn bị bão hòa.
 */
function saturateDR(mult) {
  if (mult >= 1) return mult;
  const drRaw = (1 - mult) * 100;
  let drEff;
  if (drRaw <= 25)       drEff = drRaw;
  else if (drRaw <= 50)  drEff = 25 + (drRaw - 25) * 0.5;
  else                   drEff = 37.5 + (drRaw - 50) * 0.05;
  return 1 - drEff / 100;
}

function validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving = 0, theDeparted = 0 }) {
  const errors = [];
  if (isNaN(bonusPct))       errors.push("bonus phải là số");
  if (isNaN(sanityBonusPct)) errors.push("sanitybonus phải là số");
  if (isNaN(critMul))        errors.push("critmul phải là số");
  if (isNaN(diceMul))        errors.push("dicemul phải là số");
  if (isNaN(sinkingInit))    errors.push("sinking phải là số");
  if (isNaN(ruptureInit))    errors.push("rupture phải là số");
  if (isNaN(sanityInit))     errors.push("sanity phải là số");
  if (poiseInit < 0 || poiseInit > POISE_MAX) errors.push(`Poise phải từ 0–${POISE_MAX}`);
  if (!isNaN(critMul) && critMul < 1) errors.push("CritMul phải ≥ 1");
  if (!isNaN(diceMul) && diceMul < 0) errors.push("DiceMul phải ≥ 0");
  if (!isNaN(sinkingInit) && !Number.isInteger(sinkingInit)) errors.push("sinking phải là số nguyên");
  if (!isNaN(ruptureInit) && !Number.isInteger(ruptureInit)) errors.push("rupture phải là số nguyên");
  if (!isNaN(sanityInit) && !Number.isInteger(sanityInit)) errors.push("sanity phải là số nguyên");
  if (!isNaN(sinkingInit) && (sinkingInit < 0 || sinkingInit > SINKING_MAX)) errors.push(`Sinking phải từ 0–${SINKING_MAX}`);
  if (!isNaN(ruptureInit) && (ruptureInit < 0 || ruptureInit > RUPTURE_MAX)) errors.push(`Rupture phải từ 0–${RUPTURE_MAX}`);
  if (!isNaN(sanityInit) && sanityInit < SANITY_MIN) errors.push(`Sanity phải ≥ ${SANITY_MIN}`);
  if (!Number.isInteger(theLiving) || theLiving < 0 || theLiving > BUTTERFLY_LIVING_MAX) errors.push(`The Living phải từ 0–${BUTTERFLY_LIVING_MAX}`);
  if (!Number.isInteger(theDeparted) || theDeparted < 0 || theDeparted > BUTTERFLY_DEPARTED_MAX) errors.push(`The Departed phải từ 0–${BUTTERFLY_DEPARTED_MAX}`);
  return errors;
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const cooldowns = new Map();
const COOLDOWN_CLEANUP_AGE_MS = 60_000;

// Giữ ref timer để có thể clear khi shutdown, tránh memory leak
const cooldownCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_CLEANUP_AGE_MS;
  for (const [k, v] of cooldowns) {
    if (v < cutoff) cooldowns.delete(k);
  }
}, COOLDOWN_CLEANUP_AGE_MS);

function isOnCooldown(userId, command, ms) {
  const key = `${userId}:${command}`;
  const last = cooldowns.get(key) ?? 0;
  const now = Date.now();
  if (now - last < ms) return true;
  cooldowns.set(key, now);
  return false;
}

// Dùng cho slash command — reply ephemeral nếu đang cooldown, trả về true để caller return sớm.
// Đặt gần isOnCooldown để dễ tìm; được dùng ở slash command handler bên dưới.
// Lưu ý: luôn gọi TRƯỚC deferReply vì interaction chưa ở trạng thái deferred/replied.
async function replyOnCooldown(interaction, ms) {
  if (!isOnCooldown(interaction.user.id, interaction.commandName, ms)) return false;
  try {
    await interaction.reply({ content: `⏳ Bạn dùng lệnh này quá nhanh, chờ ${ms / 1000} giây nhé.`, flags: MessageFlags.Ephemeral });
  } catch {
    // Interaction có thể đã expired — bỏ qua
  }
  return true;
}

// ─── VN TIME HELPERS ──────────────────────────────────────────────────────────
const VN_UTC_OFFSET_HOURS = 7;
// UTC giờ tương đương với VN 00:00 (nửa đêm) = 24 - 7 = 17
const VN_MIDNIGHT_UTC_HOUR = 24 - VN_UTC_OFFSET_HOURS;

function getVNNow() {
  const now = new Date();
  return new Date(now.getTime() + VN_UTC_OFFSET_HOURS * 60 * 60 * 1000);
}

function getVNDateString() {
  return getVNNow().toISOString().slice(0, 10);
}

function secondsUntilVNMidnight() {
  const now = new Date();
  const vnNow = getVNNow();
  const vnMidnight = new Date(Date.UTC(
    vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate(),
    VN_MIDNIGHT_UTC_HOUR, 0, 0, 0
  ));
  if (vnMidnight <= now) vnMidnight.setUTCDate(vnMidnight.getUTCDate() + 1);
  return Math.floor((vnMidnight - now) / 1000);
}

// ─── STRUCTURED LOGGING ───────────────────────────────────────────────────────
function log(level, command, userId, msg, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    cmd: command,
    uid: userId,
    msg,
    ...extra,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ─── REDIS TIMEOUT ────────────────────────────────────────────────────────────
const REDIS_TIMEOUT_MS = 8000;

// Custom error class để nhận diện timeout qua instanceof thay vì so sánh chuỗi.
// Tránh bug âm thầm khi message thay đổi mà isTimeoutError không cập nhật theo.
class RedisTimeoutError extends Error {
  constructor(msg = "Thao tác Redis quá thời gian, thử lại sau.") {
    super(msg);
    this.name = "RedisTimeoutError";
  }
}

function withTimeout(promise, ms = REDIS_TIMEOUT_MS, msg = "Thao tác Redis quá thời gian, thử lại sau.") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new RedisTimeoutError(msg)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ─── REDIS LOCK ───────────────────────────────────────────────────────────────
async function acquireLock(userId, ttlSeconds = 5) {
  const lockKey = `lock:${userId}`;
  const token = `${Date.now()}-${Math.random()}`;
  try {
    const result = await withTimeout(
      redis.set(lockKey, token, { nx: true, ex: ttlSeconds }),
      3000,
      "Lock timeout"
    );
    if (result === "OK" || result === true) return { lockKey, token };
    return null;
  } catch {
    return null;
  }
}

async function releaseLock({ lockKey, token }) {
  await withTimeout(
    redis.eval(
      `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`,
      [lockKey],
      [token]
    ),
    3000,
    "Release lock timeout"
  ).catch(() => {});
}

async function withLock(userId, fn, { ttlSeconds = 5, retries = 3, retryDelayMs = 200 } = {}) {
  let lock = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    lock = await acquireLock(userId, ttlSeconds);
    if (lock) break;
    if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs));
  }
  if (!lock) {
    throw new Error("Đang xử lý lệnh khác của bạn, vui lòng thử lại sau giây lát.");
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lock).catch(() => {});
  }
}

async function withDoubleLock(idA, idB, fn, {
  innerTtl = 6, retries = 3, retryDelayMs = 200, bufferSeconds = 15,
} = {}) {
  const [firstId, secondId] = [idA, idB].sort();
  // outerTtl bao gồm: thời gian chờ retry + buffer.
  // Lưu ý: công thức này KHÔNG tính thời gian chạy fn() bên trong.
  // bufferSeconds = 15 để có đủ headroom cho executeGive (2 reads + 1 pipeline save)
  // trong điều kiện Redis latency cao; tăng thêm thủ công nếu fn() nặng hơn.
  const outerTtl = innerTtl + Math.ceil((retries * retryDelayMs) / 1000) + bufferSeconds;
  return withLock(firstId, () =>
    withLock(secondId, fn, { ttlSeconds: innerTtl, retries, retryDelayMs }),
  { ttlSeconds: outerTtl, retries, retryDelayMs });
}

// ─── PLAYER DATA HELPERS ──────────────────────────────────────────────────────
function migratePlayerData(data) {
  if (data.books !== undefined || data.items !== undefined) {
    data.books = data.books ?? {};
    data.items = data.items ?? {};
    return data;
  }
  const inv = data.inventory ?? {};
  const books = {};
  const items = {};
  for (const [name, count] of Object.entries(inv)) {
    if (count <= 0) continue;
    if (VALID_ITEMS_SET.has(name.toLowerCase())) {
      items[name] = count;
    } else {
      books[name] = count;
    }
  }
  data.books = books;
  data.items = items;
  delete data.inventory;
  return data;
}

const REDIS_MAX_RETRIES = 2;
const REDIS_RETRY_BASE_MS = 150;

function isTimeoutError(err) {
  return err instanceof RedisTimeoutError;
}

// ─── PROFILE SYSTEM ───────────────────────────────────────────────────────────
// MAX_PROFILES được import từ constants.js (dùng chung với deploy-commands.js)
// Sinh PROFILE_LABELS/PROFILE_EMOJIS tự động theo MAX_PROFILES — tránh tình trạng
// hard-code chỉ tới slot 3 rồi quên cập nhật khi MAX_PROFILES đổi (gây hiển thị
// "undefined" cho slot mới), đúng với chủ đích "đổi 1 chỗ trong constants.js,
// chỗ khác tự đồng bộ".
function numberEmoji(n) {
  if (n === 10) return "🔟";
  if (n >= 0 && n <= 9) return `${n}\u{FE0F}\u{20E3}`; // keycap digit emoji (0️⃣-9️⃣)
  return `${n}.`; // fallback cho n > 10 (không có keycap emoji chuẩn)
}
const PROFILE_LABELS = {};
const PROFILE_EMOJIS = {};
for (let s = 1; s <= MAX_PROFILES; s++) {
  PROFILE_LABELS[s] = `Profile ${s}`;
  PROFILE_EMOJIS[s] = numberEmoji(s);
}

// ─── PROFILE NAME HELPERS ─────────────────────────────────────────────────────
// Tên tuỳ chỉnh lưu vào 1 key duy nhất per-user để giảm Redis round-trip.
// Cấu trúc: { "1": "Tên A", "2": "Tên B", "3": "Tên C" }
function profileNamesKey(userId) {
  return `profilenames:${userId}`;
}

async function getProfileNames(userId) {
  try {
    const raw = await withTimeout(redis.get(profileNamesKey(userId)));
    if (!raw) return {};
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

async function setProfileName(userId, slot, name) {
  const names = await getProfileNames(userId);
  if (name) {
    names[String(slot)] = name;
  } else {
    delete names[String(slot)];
  }
  if (Object.keys(names).length === 0) {
    await withTimeout(redis.del(profileNamesKey(userId)));
  } else {
    await withTimeout(redis.set(profileNamesKey(userId), JSON.stringify(names)));
  }
}

/** Trả về tên hiển thị của profile: tên tuỳ chỉnh nếu có, mặc định nếu không. */
function resolveProfileLabel(names, slot) {
  return names[String(slot)] ?? PROFILE_LABELS[slot];
}
// ─────────────────────────────────────────────────────────────────────────────

async function getActiveProfileSlot(userId) {
  try {
    const raw = await withTimeout(redis.get(`profile:${userId}`));
    const slot = parseInt(raw, 10);
    return (slot >= 1 && slot <= MAX_PROFILES) ? slot : 1;
  } catch {
    return 1;
  }
}

async function setActiveProfileSlot(userId, slot) {
  await withTimeout(redis.set(`profile:${userId}`, String(slot)));
}

function playerKeyForSlot(userId, slot) {
  return slot === 1 ? `player:${userId}` : `player:${userId}:slot${slot}`;
}

function dailyKeyForSlot(userId, slot) {
  return slot === 1 ? `daily:${userId}` : `daily:${userId}:slot${slot}`;
}

/**
 * buildProfileInfoEmbed — logic chung cho cả prefix `-profile info` và slash `/profile info`.
 * Lấy dữ liệu của tất cả MAX_PROFILES profile (qua 1 pipeline) và build embed tổng quan.
 * @param {string} userId
 * @param {string} displayName — tên hiển thị của user (displayName ?? username)
 * @param {string} footerText  — text gợi ý lệnh đổi profile, khác nhau giữa prefix/slash
 * @returns {Promise<object>} embed object, dùng trực tiếp trong `embeds: [...]`
 */
async function buildProfileInfoEmbed(userId, displayName, footerText) {
  const currentSlot = await getActiveProfileSlot(userId);

  // Lấy tất cả dữ liệu 3 profile trong 1 pipeline (6 keys) thay vì 6 lần gọi tuần tự
  const pipe = redis.pipeline();
  for (let s = 1; s <= MAX_PROFILES; s++) {
    pipe.get(playerKeyForSlot(userId, s));
    pipe.get(dailyKeyForSlot(userId, s));
  }
  const [pipeResults, profileNames] = await Promise.all([
    withTimeout(pipe.exec()).then(unwrapPipelineResults),
    getProfileNames(userId),
  ]);
  // pipeResults layout: [player1, daily1, player2, daily2, player3, daily3]

  const today = getVNDateString();
  const lines = [];
  for (let s = 1; s <= MAX_PROFILES; s++) {
    const label = resolveProfileLabel(profileNames, s);
    try {
      const rawPlayer = pipeResults[(s - 1) * 2];
      const rawDaily  = pipeResults[(s - 1) * 2 + 1];
      const d  = rawPlayer ? (typeof rawPlayer === "string" ? JSON.parse(rawPlayer) : rawPlayer) : null;
      const dd = rawDaily  ? (typeof rawDaily  === "string" ? JSON.parse(rawDaily)  : rawDaily)  : null;
      const claimedToday = dd && dd.lastClaim === today;
      const streak = dd ? (dd.streak ?? 0) : 0;
      if (d) {
        const { grade } = calcGrade(d.exp ?? 0);
        lines.push(
          `${s === currentSlot ? "▶️" : PROFILE_EMOJIS[s]} **${label}**${s === currentSlot ? " *(đang dùng)*" : ""}\n` +
          `> 🏅 Grade **${grade}** | EXP: ${d.exp ?? 0} | Ahn: ${(d.ahn ?? 0).toLocaleString()}\n` +
          `> 📅 Daily: ${claimedToday ? "✅ Đã nhận hôm nay" : "🔲 Chưa nhận"} | Streak: ${streak}/7`
        );
      } else {
        lines.push(
          `${s === currentSlot ? "▶️" : PROFILE_EMOJIS[s]} **${label}**${s === currentSlot ? " *(đang dùng)*" : ""}\n` +
          `> *(chưa có dữ liệu)*`
        );
      }
    } catch (e) {
      lines.push(`${PROFILE_EMOJIS[s]} **${label}**: *(lỗi: ${e.message})*`);
    }
  }
  return {
    title: `👤 Profiles của ${displayName}`,
    description: lines.join("\n\n"),
    color: 0x5865f2,
    footer: { text: footerText },
  };
}
// ─────────────────────────────────────────────────────────────────────────────

async function getPlayerData(userId) {
  const slot = await getActiveProfileSlot(userId);
  const key = playerKeyForSlot(userId, slot);
  let lastErr;
  for (let attempt = 0; attempt <= REDIS_MAX_RETRIES; attempt++) {
    try {
      const raw = await withTimeout(redis.get(key));
      if (!raw) return { exp: 0, ahn: 0, books: {}, items: {} };
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      return migratePlayerData(data);
    } catch (err) {
      lastErr = err;
      if (isTimeoutError(err)) break;
      if (attempt < REDIS_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, REDIS_RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// Giống getPlayerData nhưng trả về cả slot — dùng khi caller cần gọi savePlayerData
// với cùng slot để tránh gọi getActiveProfileSlot 2 lần (2 Redis round-trips).
async function getPlayerDataWithSlot(userId) {
  const slot = await getActiveProfileSlot(userId);
  const key = playerKeyForSlot(userId, slot);
  let lastErr;
  for (let attempt = 0; attempt <= REDIS_MAX_RETRIES; attempt++) {
    try {
      const raw = await withTimeout(redis.get(key));
      const data = raw
        ? migratePlayerData(typeof raw === "string" ? JSON.parse(raw) : raw)
        : { exp: 0, ahn: 0, books: {}, items: {} };
      return { data, slot };
    } catch (err) {
      lastErr = err;
      if (isTimeoutError(err)) break;
      if (attempt < REDIS_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, REDIS_RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function savePlayerData(userId, data, slot = null) {
  // slot có thể được truyền vào từ caller (VD: handleOpenCache) để tránh thêm 1 Redis
  // round-trip khi đã biết slot rồi (từ getPlayerDataWithSlot).
  const resolvedSlot = slot ?? await getActiveProfileSlot(userId);
  const key = playerKeyForSlot(userId, resolvedSlot);
  const payload = JSON.stringify(data);
  let lastErr;
  for (let attempt = 0; attempt <= REDIS_MAX_RETRIES; attempt++) {
    try {
      await withTimeout(redis.set(key, payload));
      return;
    } catch (err) {
      lastErr = err;
      if (isTimeoutError(err)) break;
      if (attempt < REDIS_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, REDIS_RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  log("error", "savePlayerData", userId, lastErr?.message ?? "Unknown save error");
  throw lastErr;
}

async function saveMultiplePlayerData(entries) {
  // Nếu entry đã có slot (được truyền từ getPlayerDataWithSlot), dùng luôn để tránh
  // round-trip Redis thứ 2 và ngăn TOCTOU nếu user switch profile giữa chừng.
  const slots = await Promise.all(entries.map(e =>
    e.slot != null ? Promise.resolve(e.slot) : getActiveProfileSlot(e.userId)
  ));
  const keys = entries.map((e, i) => playerKeyForSlot(e.userId, slots[i]));
  const values = entries.map(e => JSON.stringify(e.data));

  // Dùng 1 lệnh EVAL (Lua script) để SET toàn bộ key cùng lúc — Redis chạy Lua
  // script atomic (đơn luồng), nên đảm bảo TẤT CẢ key cùng thành công hoặc TẤT
  // CẢ cùng thất bại. Trước đây dùng pipeline: mỗi SET trong pipeline thực thi
  // độc lập, nên nếu 1 lệnh lỗi giữa đường (VD: lưu cho recipient lỗi nhưng lưu
  // cho sender vẫn thành công), /give có thể làm mất Ahn/sách của người gửi mà
  // người nhận lại không được cộng — Lua script tránh được rủi ro nửa-nửa này.
  const setAllScript = `
    for i = 1, #KEYS do
      redis.call("set", KEYS[i], ARGV[i])
    end
    return "OK"
  `;
  try {
    await withTimeout(redis.eval(setAllScript, keys, values));
  } catch (err) {
    for (const e of entries) {
      log("error", "saveMultiplePlayerData", e.userId ?? "unknown", err.message);
    }
    throw new Error(`Lưu dữ liệu thất bại, không ai bị trừ/mất dữ liệu (atomic): ${err.message}`);
  }
}

function unwrapPipelineResults(results) {
  return results.map(r => {
    if (r !== null && typeof r === "object" && "result" in r) return r.result;
    return r;
  });
}

function formatNumber(n) {
  return Math.floor(n).toLocaleString("en-US");
}

// ─── SHARED LOGIC: OPEN CACHE ─────────────────────────────────────────────────
function parseOpenCount(raw, max = OPEN_COUNT_MAX) {
  // Không nhập arg → default 1
  if (raw === undefined || raw === null || String(raw).trim() === "") return { count: 1 };
  const parsed = parseInt(raw, 10);
  // Nhập chữ (NaN) → lỗi rõ ràng, không silent-fallback về 1
  if (isNaN(parsed)) return { error: `❌ Số lần mở không hợp lệ: \`${raw}\`. Nhập số nguyên dương.` };
  if (parsed <= 0) return { error: `❌ Số lần mở phải lớn hơn 0.` };
  if (parsed > max) return { error: `❌ Số lần mở tối đa là ${max}.` };
  return { count: parsed };
}

async function handleOpenCache(userId, { cacheKey, pool, dataField, count = 1 }) {
  return withLock(userId, async () => {
    // Dùng getPlayerDataWithSlot để lấy slot 1 lần, truyền thẳng vào savePlayerData
    // — tránh getActiveProfileSlot bị gọi lần 2 bên trong savePlayerData.
    const { data, slot } = await getPlayerDataWithSlot(userId);
    data.books = data.books ?? {};
    data.items = data.items ?? {};
    const store = data[dataField];
    const owned = store[cacheKey] ?? 0;
    const rolls = Math.min(count, owned);
    if (rolls < 1) return { success: false, data, results: [] };
    store[cacheKey] = owned - rolls;
    if (store[cacheKey] <= 0) delete store[cacheKey];
    const results = [];
    for (let i = 0; i < rolls; i++) {
      const result = pool[Math.floor(Math.random() * pool.length)];
      store[result] = (store[result] ?? 0) + 1;
      results.push(result);
    }
    await savePlayerData(userId, data, slot);
    // partial=true khi user yêu cầu nhiều hơn số lượng thực sự có
    return { success: true, data, results, partial: rolls < count };
  });
}

function handleOpenRandomBook(userId, count = 1) {
  return handleOpenCache(userId, { cacheKey: "Random Book", pool: RANDOM_BOOK_POOL, dataField: "books", count });
}
function handleOpenSealedBook(userId, count = 1) {
  return handleOpenCache(userId, { cacheKey: "Sealed Book Cache", pool: SEALED_BOOK_POOL, dataField: "books", count });
}
function handleOpenChipboardCache(userId, count = 1) {
  return handleOpenCache(userId, { cacheKey: "Chipboard Cache", pool: CHIPBOARD_CACHE_POOL, dataField: "items", count });
}

// Discord giới hạn embed description tối đa 4096 ký tự
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;

function safeTruncate(str, maxChars) {
  const chars = Array.from(str);
  if (chars.length <= maxChars) return str;
  return chars.slice(0, maxChars).join("") + "…";
}

function buildRollDescription({ user, cacheType, results, remainingCount }) {
  const lines = results.map((r, i) => `**${i + 1}.** ✨ ${r}`);
  const tally = {};
  for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
  const summaryLines = Object.entries(tally)
    .sort(([, a], [, b]) => b - a)
    .map(([name, cnt]) => `• **${name}** × ${cnt}`);

  const footer = `\n\n> Còn lại: **${remainingCount}** ${cacheType}`;
  const summary = `\n\n**📊 Tổng kết:**\n` + summaryLines.join("\n");
  const header = `${user} đã dùng **${results.length} ${cacheType}** và nhận được:\n\n`;

  const LIMIT = DISCORD_EMBED_DESCRIPTION_LIMIT;
  const fixedLen = header.length + summary.length + footer.length;
  let body = lines.join("\n");
  if (fixedLen + body.length > LIMIT) {
    const budget = LIMIT - fixedLen - 20;
    body = safeTruncate(body, budget) + `\n…(bị cắt bớt)`;
  }

  return header + body + summary + footer;
}

// ─── SHARED LOGIC: DAILY ──────────────────────────────────────────────────────
async function processDailyClaimForUser(userId) {
  return withLock(userId, async () => {
    const slot = await getActiveProfileSlot(userId);
    const dailyKey = dailyKeyForSlot(userId, slot);
    const playerKey = playerKeyForSlot(userId, slot);

    const rawResults = await withTimeout(
      redis.pipeline().get(dailyKey).get(playerKey).exec()
    );
    const [dailyRaw, playerRaw] = unwrapPipelineResults(rawResults);

    const dailyData = dailyRaw ? (typeof dailyRaw === "string" ? JSON.parse(dailyRaw) : dailyRaw) : null;
    let playerData = playerRaw
      ? (typeof playerRaw === "string" ? JSON.parse(playerRaw) : playerRaw)
      : { exp: 0, ahn: 0, books: {}, items: {} };
    playerData = migratePlayerData(playerData);

    const today = getVNDateString();
    if (dailyData && dailyData.lastClaim === today) {
      const remaining = secondsUntilVNMidnight();
      const hours = Math.floor(remaining / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      const seconds = remaining % 60;
      return { alreadyClaimed: true, hours, minutes, seconds };
    }

    const vnNow = getVNNow();
    const vnYesterday = new Date(vnNow);
    vnYesterday.setUTCDate(vnYesterday.getUTCDate() - 1);
    const yesterdayStr = vnYesterday.toISOString().slice(0, 10);

    const prevStreak = dailyData ? (dailyData.streak ?? 0) : 0;
    let streak = (dailyData && dailyData.lastClaim === yesterdayStr) ? prevStreak + 1 : 1;

    const isWeekComplete = streak >= 7;
    const newDailyData = { lastClaim: today, streak: isWeekComplete ? 0 : streak };

    playerData.books = playerData.books ?? {};
    playerData.items = playerData.items ?? {};

    const expBefore = playerData.exp ?? 0;
    const expGain = DAILY_EXP_REWARD + (isWeekComplete ? DAILY_STREAK_EXP_BONUS : 0);
    playerData.exp = clampExp(expBefore + expGain);
    const actualExpGained = playerData.exp - expBefore;

    playerData.ahn = (playerData.ahn ?? 0) + DAILY_AHN_REWARD;
    playerData.books["Random Book"] = (playerData.books["Random Book"] ?? 0) + 1;

    if (isWeekComplete) {
      playerData.ahn += DAILY_STREAK_AHN_BONUS;
      playerData.books["Sealed Book Cache"] = (playerData.books["Sealed Book Cache"] ?? 0) + 1;
    }

    const saveResults = await withTimeout(
      redis.pipeline()
        .set(dailyKey, JSON.stringify(newDailyData), { ex: DAILY_KEY_TTL_SECONDS })
        .set(playerKey, JSON.stringify(playerData))
        .exec()
    );
    if (Array.isArray(saveResults)) {
      const labels = ["daily", "player"];
      const failures = saveResults
        .map((r, i) => {
          const err = r && typeof r === "object" && "error" in r ? r.error : null;
          return err ? `[${labels[i]}]: ${err}` : null;
        })
        .filter(Boolean);
      if (failures.length > 0) {
        throw new Error(`Daily save thất bại một phần: ${failures.join(", ")}`);
      }
    }

    const displayStreak = isWeekComplete ? 7 : streak;
    const bar = Array.from({ length: 7 }, (_, i) => i < displayStreak ? "🟩" : "⬛").join("");

    const atMax = playerData.exp >= EXP_MAX;
    const expLine = atMax
      ? `📦 **${actualExpGained} Exp** (đã đạt MAX ${EXP_MAX}) | **100k Ahn** | **1 Random Book**`
      : `📦 **${actualExpGained} Exp** | **100k Ahn** | **1 Random Book**`;

    let replyMsg =
      `🎉 {USER} đã điểm danh thành công!\n` +
      `> ${expLine}\n` +
      `> 🔥 Streak: **${displayStreak}/7** ngày  ${bar}`;

    if (isWeekComplete) {
      replyMsg +=
        `\n\n🏆 **Hoàn thành streak 7 ngày!** Bạn nhận thêm **${isWeekComplete ? DAILY_STREAK_EXP_BONUS : 0} Exp**, **400k Ahn** và **1 Sealed Book Cache**!\n` +
        `> Streak đã reset, bắt đầu lại từ ngày 1 nhé!`;
    }

    return { alreadyClaimed: false, replyMsg };
  });
}

// ─── SHARED LOGIC: PARRY ──────────────────────────────────────────────────────
function runParryRolls(rolls) {
  let successCount = 0;
  let failCount = 0;
  const lines = [];
  for (let i = 0; i < rolls; i++) {
    let atk, pry, rerolls = 0;
    do {
      atk = Math.floor(Math.random() * 16) + 1;
      pry = Math.floor(Math.random() * 20) + 1;
      if (atk === pry) rerolls++;
    } while (atk === pry);
    const isSuccess = atk <= pry;
    if (isSuccess) successCount++; else failCount++;
    const rerollNote = rerolls > 0 ? ` *(Hòa và roll lại ${rerolls} lần)*` : "";
    const result = isSuccess ? "Parry thành công ✅" : "Parry thất bại ❌";
    lines.push(`Lần ${i + 1}: Attacker: \`${atk}\` vs Defender: \`${pry}\`${rerollNote} → ${result}`);
  }
  return { successCount, failCount, lines };
}


function calcMath(opts) {
  const {
    dmgStr = "",
    resStr = "",
    drStr = "",
    bonusPct = 0,
    sanityBonusPct = 0,
    critMul = 1,
    poiseInit = 0,
    critDiv = 0,
    sanityInit = 0,
    diceMul = 1,
    sinkingInit = 0,
    ruptureInit = 0,
    theLiving = 0,
    theDeparted = 0,
  } = opts;

  const resValues = { B: 1, P: 1, S: 1 };
  const resRegex = /([\d.]+)(?:x)?([BPS])/gi;
  let match;
  while ((match = resRegex.exec(resStr)) !== null) {
    resValues[match[2].toUpperCase()] = parseFloat(match[1]);
  }
  // Res (B/P/S) không bị bão hòa nữa — chỉ DR mới bị bão hòa.
  const resRaw = { ...resValues };

  // DR: flat, áp lên tất cả damage type, độc lập với res
  // Final DMG = (DMG × bonusFactor) × res × dr
  const drRawPct = drStr ? parseFloat(drStr) : 0;
  const hasDR = !isNaN(drRawPct) && drRawPct !== 0;
  const drMult = hasDR ? saturateDR(1 - drRawPct / 100) : 1;

  const dmgValues = [];
  const damageRegex =
    /([\d.]+)(?:x([\d.]+))?(?:\+([\d.]+)%?)?\s*(Dice)?([BPSbps])((?:\+\d*Sinking|\+\d*Rupture|\+\d*Poise|\+\d*Living|\+\d*Departed|\+Crit\d+)*)/gi;
  while ((match = damageRegex.exec(dmgStr)) !== null) {
    const base = parseFloat(match[1]);
    const multiplier = match[2] ? parseInt(match[2]) : 1;
    const extraPct = match[3] ? parseFloat(match[3]) : 0;
    const isDice = !!match[4];
    const dmgType = match[5] ? match[5].toUpperCase() : "B";
    const effectsStr = match[6] || "";
    const sinkingMatch = effectsStr.match(/\+(\d+)?Sinking/i);
    const ruptureMatch = effectsStr.match(/\+(\d+)?Rupture/i);
    const poiseMatch = effectsStr.match(/\+(\d+)?Poise/i);
    const livingMatch = effectsStr.match(/\+(\d+)?Living/i);
    const departedMatch = effectsStr.match(/\+(\d+)?Departed/i);
    const sinkingToApply = sinkingMatch ? parseInt(sinkingMatch[1] || "1") : 0;
    const ruptureToApply = ruptureMatch ? parseInt(ruptureMatch[1] || "1") : 0;
    const poiseToApply = poiseMatch ? parseInt(poiseMatch[1] || "0") : 0;
    const livingToApply = livingMatch ? parseInt(livingMatch[1] || "1") : 0;
    const departedToApply = departedMatch ? parseInt(departedMatch[1] || "1") : 0;
    for (let i = 0; i < multiplier; i++) {
      dmgValues.push({ value: base, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply, livingToApply, departedToApply, effectsStr });
    }
  }
  if (dmgValues.length === 0) {
    dmgValues.push({ value: 0, type: "B", isDice: false, extraPct: 0, sinkingToApply: 0, ruptureToApply: 0, poiseToApply: 0, livingToApply: 0, departedToApply: 0, effectsStr: "" });
  }

  let sanity = sanityInit;
  let totalDmg = 0;
  let totalPoise = poiseInit;
  let enemySinking = Math.min(sinkingInit, SINKING_MAX);
  let enemyRupture = Math.min(ruptureInit, RUPTURE_MAX);
  let livingStacks = Math.min(theLiving, BUTTERFLY_LIVING_MAX);     // Count The Living hiện tại, có thể tăng qua +Living trong dmg
  let departedStacks = Math.min(theDeparted, BUTTERFLY_DEPARTED_MAX); // Count The Departed hiện tại, có thể tăng qua +Departed trong dmg
  let totalSanityHeal = 0;   // tích lũy từ The Living qua các hit
  let totalDepartedDmg = 0;  // tích lũy bonus dmg từ The Departed
  // Sanity Bonus hiệu dụng tích lũy: bắt đầu từ sanityBonusPct (input),
  // cộng thêm livingHeal sau mỗi hit — áp dụng cho Dice hit tiếp theo.
  let effectiveSanityBonus = sanityBonusPct;
  const instanceResults = [];

  for (const dmgObj of dmgValues) {
    const { value: dmg, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply, livingToApply, departedToApply, effectsStr } = dmgObj;
    const currentRes = resValues[dmgType] ?? 1.0;
    const currentDR  = drMult;

    const critFromPoise = totalPoise * POISE_CRIT_BONUS_PER_STACK;
    const critMatch = effectsStr ? effectsStr.match(/\+Crit(\d+)/i) : null;
    const bonusCritRate = critMatch ? parseInt(critMatch[1]) / 100 : 0;
    const rawCritChance = critFromPoise + bonusCritRate;
    const critChance = Math.min(rawCritChance, 1);
    const poiseOverflow = Math.max(0, rawCritChance - 1);

    const didCrit = critChance >= 1 ? true : Math.random() < critChance;

    const multiplier = didCrit ? critMul : 1;
    const rawTotalPct = bonusPct + extraPct;
    const effTotalPct = saturateBonusPct(rawTotalPct) + (isDice ? effectiveSanityBonus : 0);
    const bonusFactor = 1 + effTotalPct / 100;
    let instanceDmg = dmg * bonusFactor * multiplier * currentRes * currentDR;
    if (isDice) instanceDmg *= diceMul;

    // Sinking: chỉ trừ sanity địch khi địch đang có Sinking stacks (đúng cơ chế).
    // Mỗi hit tiêu thụ 1 stack và trừ 1 sanity; cộng bonus dmg khi sanity địch ở SANITY_MIN.
    // sinkingBeforeProc được lưu trước khi drain, để The Departed dùng đúng giá trị hiện tại.
    const sinkingBeforeProc = enemySinking;
    let sinkingBonus = 0;
    if (enemySinking > 0) {
      const sanityBefore = sanity;
      sanity = Math.max(sanity - 1, SANITY_MIN);
      if (sanityBefore <= SANITY_MIN || sanity <= SANITY_MIN) {
        instanceDmg += enemySinking;
        sinkingBonus = enemySinking;
      }
      enemySinking = Math.max(enemySinking - 1, 0);
    }

    let ruptureBonus = 0;
    if (enemyRupture > 0) {
      ruptureBonus = enemyRupture;
      instanceDmg += ruptureBonus;
      enemyRupture = Math.max(enemyRupture - 1, 0);
    }

    // ── Butterfly: The Departed ───────────────────────────────────────────────
    // Bonus dmg = floor(Sinking hiện tại / 2) + The Departed count hiện tại (trước khi cộng stack của đòn này).
    // Cap 30 nếu địch còn Sanity (> SANITY_MIN, chưa chạm đáy), cap 15 nếu địch đã hết Sanity (== SANITY_MIN).
    let departedBonus = 0;
    if (departedStacks > 0) {
      const departedRaw = Math.floor(sinkingBeforeProc / 2) + departedStacks;
      const departedCap = sanity > SANITY_MIN ? 30 : 15;
      departedBonus = Math.min(departedRaw, departedCap);
      instanceDmg += departedBonus;
      totalDepartedDmg += departedBonus;
    }

    // ── Butterfly: The Living ────────────────────────────────────────────────
    // Hồi Sanity người dùng = floor(The Living / 4) mỗi hit, dùng Count hiện tại (trước khi cộng stack của đòn này).
    // Sanity hồi được cộng vào effectiveSanityBonus để Dice hit TIẾP THEO hưởng bonus (không áp dụng cho hit hiện tại).
    const livingHeal = livingStacks > 0 ? Math.floor(livingStacks / 4) : 0;
    const sanityBonusUsed = effectiveSanityBonus; // snapshot dùng cho hit này (trước khi cộng heal)
    totalSanityHeal += livingHeal;
    effectiveSanityBonus += livingHeal;

    totalDmg += instanceDmg;

    // Apply stack mới từ đòn này sau khi đã tính dmg xong
    if (poiseToApply > 0) totalPoise = Math.min(totalPoise + poiseToApply, POISE_MAX);
    if (sinkingToApply > 0) enemySinking = Math.min(enemySinking + sinkingToApply, SINKING_MAX);
    if (ruptureToApply > 0) enemyRupture = Math.min(enemyRupture + ruptureToApply, RUPTURE_MAX);
    if (livingToApply > 0) livingStacks = Math.min(livingStacks + livingToApply, BUTTERFLY_LIVING_MAX);
    if (departedToApply > 0) departedStacks = Math.min(departedStacks + departedToApply, BUTTERFLY_DEPARTED_MAX);

    // Ghi lại poise sau gain nhưng trước critDiv để hiển thị trong breakdown
    const poiseAfterGain = totalPoise;

    if (didCrit && critDiv > 1) {
      totalPoise = Math.floor(totalPoise / critDiv);
      if (totalPoise < POISE_RESET_THRESHOLD) totalPoise = 0;
    }

    instanceResults.push({
      dmg, dmgType, didCrit, critChance, poiseOverflow,
      poiseStacksAfter: totalPoise,  // sau critDiv — giá trị thực dùng cho hit tiếp theo
      poiseAfterGain,                 // sau gain, trước critDiv — để hiển thị gain chính xác
      instanceDmg, ruptureBonus, sinkingBonus,
      sinkingApplied: sinkingToApply,
      ruptureApplied: ruptureToApply,
      poiseApplied: poiseToApply,
      effectsStr, isDice,
      departedBonus, livingHeal,
      livingApplied: livingToApply,
      departedApplied: departedToApply,
      livingStacksAfter: livingStacks,
      departedStacksAfter: departedStacks,
      sanityBonusUsed, // Sanity Bonus hiệu dụng đã dùng cho hit này
    });
  }

  const finalPoiseStacks = totalPoise;
  const critCount = instanceResults.filter((r) => r.didCrit).length;

  const breakdownLines = instanceResults.map((r, i) => {
    const rateStr = `${(r.critChance * 100).toFixed(1)}%`;
    const critLabel = r.didCrit ? "✅" : "❌";
    let extraInfo = "";
    if (r.poiseOverflow > 0) {
      const wastedStacks = Math.round(r.poiseOverflow / POISE_CRIT_BONUS_PER_STACK);
      extraInfo += ` | ${wastedStacks} <:Poise:1513762945715142736>Poise dư`;
    }
    if (r.sinkingBonus > 0) extraInfo += ` | +${r.sinkingBonus} dmg từ <:Sinking:1513762793436741652>Sinking`;
    if (r.sinkingApplied > 0) extraInfo += ` | áp ${r.sinkingApplied} <:Sinking:1513762793436741652>Sinking`;
    if (r.ruptureBonus > 0) extraInfo += ` | +${r.ruptureBonus} dmg từ <:Rupture:1513762812722155682>Rupture`;
    if (r.ruptureApplied > 0) extraInfo += ` | áp ${r.ruptureApplied} <:Rupture:1513762812722155682>Rupture`;
    if (r.poiseApplied > 0) {
      if (critDiv > 1 && r.didCrit && r.poiseAfterGain !== r.poiseStacksAfter) {
        extraInfo += ` | +${r.poiseApplied} <:Poise:1513762945715142736>Poise: ${r.poiseAfterGain} → ÷${critDiv} = ${r.poiseStacksAfter} Counts`;
      } else {
        extraInfo += ` | +${r.poiseApplied} <:Poise:1513762945715142736>Poise → ${r.poiseStacksAfter} Counts`;
      }
    }
    if (r.effectsStr && /\+Crit(\d+)/i.test(r.effectsStr)) {
      const critVal = r.effectsStr.match(/\+Crit(\d+)/i)[1];
      extraInfo += ` | +Crit${critVal}%`;
    }
    if (r.isDice && diceMul !== 1) extraInfo += ` | DiceMul ${diceMul}x`;
    if (r.departedBonus > 0) extraInfo += ` | +${r.departedBonus} dmg <:Butterfly:1516679919399338074>Departed`;
    if (r.departedApplied > 0) extraInfo += ` | áp +${r.departedApplied} <:Butterfly:1516679919399338074>Departed (${r.departedStacksAfter} Count)`;
    if (r.livingHeal > 0) extraInfo += ` | +${r.livingHeal} Sanity hồi <:Butterfly:1516679919399338074>Living`;
    if (r.livingApplied > 0) extraInfo += ` | áp +${r.livingApplied} <:Butterfly:1516679919399338074>Living (${r.livingStacksAfter} Count)`;
    if (r.isDice && r.sanityBonusUsed > 0 && r.sanityBonusUsed !== sanityBonusPct)
      extraInfo += ` | Sanity: ${r.sanityBonusUsed} (+${r.sanityBonusUsed}% Dice)`;
    return `#${i + 1}[${r.dmgType}](${rateStr}) ${critLabel} → ${r.instanceDmg.toFixed(2)}${extraInfo}`;
  });

  let breakdownValue = breakdownLines.join("\n");
  if (breakdownValue.length > 1024) {
    const shown = [];
    for (const line of breakdownLines) {
      if ((shown.join("\n") + "\n" + line).length > 990) {
        shown.push(`…+${breakdownLines.length - shown.length} more hits`);
        break;
      }
      shown.push(line);
    }
    breakdownValue = shown.join("\n");
  }

  const startingCritRate = poiseInit * POISE_CRIT_BONUS_PER_STACK;
  const finalCritRate = finalPoiseStacks * POISE_CRIT_BONUS_PER_STACK;
  let poiseDisplay;
  if (critDiv > 1 && critCount > 0) {
    poiseDisplay = `${poiseInit} → ${finalPoiseStacks} Counts (${critCount} crit${critCount > 1 ? "s" : ""}, ÷${critDiv})`;
  } else if (poiseInit !== finalPoiseStacks) {
    poiseDisplay = `${poiseInit} → ${finalPoiseStacks} Counts (${(startingCritRate * 100).toFixed(0)}% → ${(finalCritRate * 100).toFixed(0)}% crit)`;
  } else {
    poiseDisplay = `${poiseInit} Counts (${(startingCritRate * 100).toFixed(0)}% crit)`;
  }

  const resDisplay = ["B", "P", "S"].map(k => {
    const raw = resRaw[k], eff = resValues[k];
    return raw !== eff
      ? `${k}: ${raw}x → **${eff.toFixed(3)}x** *(bão hòa)*`
      : `${k}: ${raw}x`;
  }).join(" | ");
  const drEffPct = hasDR ? ((1 - drMult) * 100).toFixed(2) : null;
  const drDisplay = hasDR
    ? `${drRawPct}% raw → **${drEffPct}%** effective *(${drMult.toFixed(3)}x)*`
    : null;

  const finalLivingStacks = livingStacks;
  const finalDepartedStacks = departedStacks;
  const livingDisplay = theLiving !== finalLivingStacks
    ? `${theLiving} → ${finalLivingStacks} Count (hồi **${Math.floor(finalLivingStacks / 4)}** Sanity/hit ở cuối)`
    : `${theLiving} Count → hồi **${Math.floor(theLiving / 4)}** Sanity/hit`;
  const departedCapLabel = sanity > SANITY_MIN ? "30 (địch còn Sanity)" : "15 (địch hết Sanity)";
  const departedDisplay = theDeparted !== finalDepartedStacks
    ? `${theDeparted} → ${finalDepartedStacks} Count (cap: ${departedCapLabel})`
    : `${theDeparted} Count (cap: ${departedCapLabel})`;

  // Tính effective bonus để hiển thị (dùng worst-case: có cả sanityBonus nếu > 0)
  const rawBonusDisplay = bonusPct;
  const effBonusDisplay = saturateBonusPct(rawBonusDisplay);
  const isSaturated = rawBonusDisplay > 100;
  const bonusPctDisplay = isSaturated
    ? `${effBonusDisplay.toFixed(1)}% *(raw: ${rawBonusDisplay.toFixed(1)}%)*`
    : bonusPct.toFixed(1) + "%";

  const allFields = [
    { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
    { name: "% Dmg Bonus", value: bonusPctDisplay, inline: true, alwaysShow: true },
    { name: "Player's Sanity", value: totalSanityHeal > 0
        ? `${sanityBonusPct} (+${sanityBonusPct}% Dice bonus) → ${sanityBonusPct + totalSanityHeal} (+${sanityBonusPct + totalSanityHeal}% Dice bonus)`
        : `${sanityBonusPct} (+${sanityBonusPct}% Dice bonus)`,
      inline: true, showIf: effectiveSanityBonus !== 0 || sanityBonusPct !== 0 },
    { name: "CritMul", value: critMul + "x", inline: true, alwaysShow: true },
    { name: "Res Multipliers", value: resDisplay, inline: true, alwaysShow: true },
    { name: "Damage Reduction", value: drDisplay ?? "", inline: true, showIf: hasDR },
    { name: "Dice Multiplier", value: diceMul.toFixed(2) + "x", inline: true, showIf: diceMul !== 1 },
    { name: "<:Poise:1513762945715142736>Poise Counts", value: poiseDisplay, inline: true, alwaysShow: true },
    { name: "Crit Divide", value: critDiv > 1 ? `÷${critDiv} per crit` : "No", inline: true, showIf: critDiv > 1 },
    { name: "<:Butterfly:1516679919399338074>The Living", value: livingDisplay, inline: true, showIf: finalLivingStacks > 0 },
    { name: "<:Butterfly:1516679919399338074>The Departed", value: departedDisplay, inline: true, showIf: finalDepartedStacks > 0 },
    { name: "Final DMG", value: totalDmg.toFixed(3), inline: false, alwaysShow: true },
    { name: "<:Butterfly:1516679919399338074>Tổng Sanity hồi (The Living)", value: `+${totalSanityHeal}`, inline: true, showIf: totalSanityHeal > 0 },
    { name: "<:Butterfly:1516679919399338074>Tổng DMG Bonus (The Departed)", value: totalDepartedDmg.toFixed(2), inline: true, showIf: totalDepartedDmg > 0 },
    { name: "Enemy's Sanity", value: sanity.toString(), inline: true, showIf: sanity !== 0 },
    { name: "Enemy's <:Sinking:1513762793436741652>Sinking Counts", value: enemySinking.toString(), inline: true, showIf: enemySinking !== 0 },
    { name: "Enemy's <:Rupture:1513762812722155682>Rupture Counts", value: enemyRupture.toString(), inline: true, showIf: enemyRupture !== 0 },
  ];

  return {
    embeds: [{
      title: "📊 Kết quả tính DMG",
      color: 0x00ae86,
      fields: filterZeroFields(allFields),
    }],
  };
}


// ─── SHARED: buildBalanceEmbed / buildInventoryEmbed ──────────────────────────
async function buildBalanceEmbed(targetUser) {
  const data = await getPlayerData(targetUser.id);
  const { grade, expInCurrentGrade, expNeeded } = calcGrade(data.exp ?? 0);
  const totalBooks = Object.values(data.books ?? {}).reduce((a, b) => a + b, 0);
  const totalItems = Object.values(data.items ?? {}).reduce((a, b) => a + b, 0);
  const gradeDisplay = grade === GRADE_MAX
    ? `**Grade ${grade}** (MAX)`
    : `**Grade ${grade}** (${expInCurrentGrade}/${expNeeded} EXP → Grade ${grade - 1})`;
  let progressBar = "";
  if (grade > GRADE_MAX && expNeeded) {
    const filled = Math.round((expInCurrentGrade / expNeeded) * 10);
    progressBar = "\n> " + "🟦".repeat(filled) + "⬛".repeat(10 - filled) + ` ${expInCurrentGrade}/${expNeeded}`;
  }
  return {
    embeds: [{
      title: `💼 Thông tin của ${targetUser.displayName ?? targetUser.username}`,
      color: 0x5865f2,
      thumbnail: { url: targetUser.displayAvatarURL({ dynamic: true }) },
      fields: [
        { name: "🏅 Grade", value: gradeDisplay + progressBar, inline: false },
        { name: "✨ Tổng EXP", value: `**${formatNumber(data.exp ?? 0)}** / **${EXP_MAX}** EXP`, inline: true },
        { name: "💰 Ahn", value: `**${formatNumber(data.ahn ?? 0)}** Ahn`, inline: true },
        { name: "📚 Tổng sách", value: `**${totalBooks}** cuốn`, inline: true },
        { name: "🔩 Tổng vật phẩm", value: `**${totalItems}** cái`, inline: true },
      ],
      footer: { text: INVENTORY_HINT_TEXT },
    }],
  };
}

// Số entry tối đa mỗi trang inventory
const INV_PAGE_SIZE = 15;

/**
 * Tách toàn bộ books + items thành mảng pages (mỗi page là mảng fields).
 * Trả về null nếu kho trống.
 */
function buildInventoryPages(targetUser, data) {
  const books = data.books ?? {};
  const items = data.items ?? {};
  const bookEntries = Object.entries(books).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
  const itemEntries = Object.entries(items).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
  if (bookEntries.length === 0 && itemEntries.length === 0) return null;

  const totalBooks = bookEntries.reduce((s, [, c]) => s + c, 0);
  const totalItems = itemEntries.reduce((s, [, c]) => s + c, 0);
  const pages = [];

  // ── Sách ──
  for (let i = 0; i < bookEntries.length; i += INV_PAGE_SIZE) {
    const chunk = bookEntries.slice(i, i + INV_PAGE_SIZE);
    const isLast = i + INV_PAGE_SIZE >= bookEntries.length;
    const from = i + 1, to = Math.min(i + INV_PAGE_SIZE, bookEntries.length);
    const fields = [{
      name: `📚 Sách (${from}–${to} / ${bookEntries.length})`,
      value: chunk.map(([name, count]) => `• **${name}** × ${count}`).join("\n"),
      inline: false,
    }];
    if (isLast) fields.push({ name: "📊 Tổng sách", value: `**${totalBooks}** cuốn`, inline: true });
    pages.push(fields);
  }

  // ── Vật phẩm ──
  for (let i = 0; i < itemEntries.length; i += INV_PAGE_SIZE) {
    const chunk = itemEntries.slice(i, i + INV_PAGE_SIZE);
    const isLast = i + INV_PAGE_SIZE >= itemEntries.length;
    const from = i + 1, to = Math.min(i + INV_PAGE_SIZE, itemEntries.length);
    const fields = [{
      name: `🔩 Vật phẩm (${from}–${to} / ${itemEntries.length})`,
      value: chunk.map(([name, count]) => `• **${name}** × ${count}`).join("\n"),
      inline: false,
    }];
    if (isLast) fields.push({ name: "📊 Tổng vật phẩm", value: `**${totalItems}** cái`, inline: true });
    pages.push(fields);
  }

  return pages;
}

/** Build embed object cho trang `page` (0-indexed).*/
function buildInvEmbed(targetUser, pages, page) {
  return {
    title: `🎒 Inventory của ${targetUser.displayName ?? targetUser.username}`,
    color: 0xf0a500,
    fields: pages[page],
    footer: pages.length > 1 ? { text: `Trang ${page + 1} / ${pages.length}` } : undefined,
  };
}

/** Build ActionRow nút Prev/Next. */
function buildInvRow(targetUserId, page, totalPages) {
  // Dùng Math.max/min để đảm bảo customId không chứa page âm (-1) hoặc vượt bound
  // khi button bị disabled. Không ảnh hưởng đến logic vì button disabled không click được,
  // nhưng tránh trường hợp Discord reject customId không hợp lệ.
  const prevPage = Math.max(0, page - 1);
  const nextPage = Math.min(totalPages - 1, page + 1);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`invpage:${targetUserId}:${prevPage}`)
      .setLabel("◀ Trước")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`invpage:${targetUserId}:${nextPage}`)
      .setLabel("Sau ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages - 1),
  );
}

/** Wrapper async dùng chung cho prefix và slash command. */
async function fetchInventoryReply(targetUser, page = 0) {
  const data = await getPlayerData(targetUser.id);
  const pages = buildInventoryPages(targetUser, data);
  if (!pages) return null;
  const clampedPage = Math.max(0, Math.min(page, pages.length - 1));
  const embed = buildInvEmbed(targetUser, pages, clampedPage);
  const components = pages.length > 1 ? [buildInvRow(targetUser.id, clampedPage, pages.length)] : [];
  return { embeds: [embed], components };
}

// ─── SHARED BUSINESS LOGIC: GIVE / REMOVE ────────────────────────────────────
/**
 * executeGive — logic chung cho cả prefix -give và slash /give
 * @param {object} opts
 * @param {string}  opts.senderId   — userId người gửi (null nếu admin bypass)
 * @param {string}  opts.targetId   — userId người nhận
 * @param {boolean} opts.isAdmin
 * @param {number}  opts.ahnGain    — 0 nếu không chuyển Ahn
 * @param {string|null} opts.bookName
 * @param {number}  opts.bookCount
 * @param {string|null} opts.itemName
 * @param {number}  opts.itemCount
 * @param {number|null} opts.expGain   — admin only
 * @param {number|null} opts.gradeTarget — admin only
 * @returns {Promise<string[]>} mảng change strings
 */
async function executeGive({ senderId, targetId, isAdmin, ahnGain = 0, bookName = null, bookCount = 1, itemName = null, itemCount = 1, expGain = 0, gradeTarget = null }) {
  // Dùng getPlayerDataWithSlot để pin slot tại thời điểm đọc — tránh TOCTOU nếu user
  // switch profile giữa lúc đọc và lưu (saveMultiplePlayerData sẽ dùng slot này luôn).
  let senderData = null, senderSlot = null;
  if (!isAdmin) {
    const r = await getPlayerDataWithSlot(senderId);
    senderData = r.data;
    senderSlot = r.slot;
  }
  const { data: recipientData, slot: recipientSlot } = await getPlayerDataWithSlot(targetId);
  recipientData.books = recipientData.books ?? {};
  recipientData.items = recipientData.items ?? {};
  if (senderData) {
    senderData.books = senderData.books ?? {};
    senderData.items = senderData.items ?? {};
  }

  if (!isAdmin && ahnGain > 0) {
    const senderAhn = senderData.ahn ?? 0;
    if (senderAhn < ahnGain) throw new Error(`Bạn không đủ Ahn. Bạn có **${formatNumber(senderAhn)} Ahn**, cần **${formatNumber(ahnGain)} Ahn**.`);
  }
  if (!isAdmin && bookName) {
    const owned = senderData.books?.[bookName] ?? 0;
    if (owned < bookCount) throw new Error(`Bạn không đủ sách. Bạn có **${owned}** **${bookName}**, cần **${bookCount}**.`);
  }
  if (!isAdmin && itemName) {
    const owned = senderData.items?.[itemName] ?? 0;
    if (owned < itemCount) throw new Error(`Bạn không đủ vật phẩm. Bạn có **${owned}** **${itemName}**, cần **${itemCount}**.`);
  }

  const changes = [];

  // Không cho phép dùng cả grade lẫn exp cùng lúc — grade overwrite exp về giá trị
  // cố định, khiến expGain bị nuốt hoàn toàn mà không báo lỗi (do else-if ẩn đi).
  if (gradeTarget !== null && expGain !== 0) {
    throw new Error("Không thể dùng `grade` và `exp` cùng lúc. Chọn một trong hai.");
  }

  if (gradeTarget !== null) {
    const expNeeded = calcExpForGrade(gradeTarget);
    recipientData.exp = expNeeded;
    changes.push(`Grade set → **Grade ${gradeTarget}** (EXP set thành **${expNeeded}**)`);
  } else if (expGain !== 0) {
    recipientData.exp = clampExp((recipientData.exp ?? 0) + expGain);
    changes.push(`${expGain > 0 ? "+" : ""}${expGain} EXP → tổng **${recipientData.exp}**/${EXP_MAX}`);
  }
  if (ahnGain !== 0) {
    const ahnBefore = recipientData.ahn ?? 0;
    recipientData.ahn = Math.max(0, ahnBefore + ahnGain);
    // Dùng actualAhnChange thay vì ahnGain để log đúng số tiền thực sự thay đổi
    // (VD: admin give ahn: -50000 cho user chỉ có 10000 → actualChange = -10000, không phải -50000)
    const actualAhnChange = recipientData.ahn - ahnBefore;
    changes.push(`${actualAhnChange >= 0 ? "+" : ""}${formatNumber(actualAhnChange)} Ahn`);
    if (!isAdmin && ahnGain > 0) senderData.ahn = (senderData.ahn ?? 0) - ahnGain;
  }
  if (bookName) {
    recipientData.books[bookName] = Math.max(0, (recipientData.books[bookName] ?? 0) + bookCount);
    changes.push(`+${bookCount} 📚 **${bookName}**`);
    if (!isAdmin) {
      senderData.books[bookName] -= bookCount;
      if (senderData.books[bookName] <= 0) delete senderData.books[bookName];
    }
  }
  if (itemName) {
    recipientData.items[itemName] = Math.max(0, (recipientData.items[itemName] ?? 0) + itemCount);
    changes.push(`+${itemCount} 🔩 **${itemName}**`);
    if (!isAdmin) {
      senderData.items[itemName] -= itemCount;
      if (senderData.items[itemName] <= 0) delete senderData.items[itemName];
    }
  }

  const saveEntries = [{ userId: targetId, data: recipientData, slot: recipientSlot }];
  if (!isAdmin) saveEntries.push({ userId: senderId, data: senderData, slot: senderSlot });
  await saveMultiplePlayerData(saveEntries);
  return changes;
}

/**
 * executeRemove — logic chung cho cả prefix -remove và slash /remove
 * @param {object} opts
 * @param {string}  opts.actorId    — userId người thực hiện lệnh
 * @param {string}  opts.targetId   — userId bị xóa
 * @param {boolean} opts.isAdmin
 * @param {number}  opts.expRemove
 * @param {number}  opts.ahnRemove
 * @param {Array<{name:string,count:number}>} opts.bookEntries  — có thể rỗng
 * @param {Array<{name:string,count:number}>} opts.itemEntries  — có thể rỗng
 * @returns {Promise<string[]>} mảng change strings
 */
async function executeRemove({ actorId, targetId, isAdmin, expRemove = 0, ahnRemove = 0, bookEntries = [], itemEntries = [] }) {
  // ahnRemove âm sẽ khiến Math.max(0, before - ahnRemove) bên dưới "cộng" Ahn ngược lại
  // (before - (-x) = before + x) — chặn ngay từ đây để /remove không bị dùng như /give.
  if (ahnRemove < 0) throw new Error("Giá trị `ahn` để xóa không được âm. Dùng `/give` nếu muốn cộng thêm Ahn.");
  const { data, slot } = await getPlayerDataWithSlot(targetId);
  data.books = data.books ?? {};
  data.items = data.items ?? {};
  const changes = [];

  if (expRemove !== 0) {
    const before = data.exp ?? 0;
    data.exp = Math.max(0, before - expRemove);
    changes.push(`-${expRemove} EXP (${before} → ${data.exp})`);
  }
  if (ahnRemove !== 0) {
    const before = data.ahn ?? 0;
    data.ahn = Math.max(0, before - ahnRemove);
    changes.push(`-${formatNumber(ahnRemove)} Ahn (${formatNumber(before)} → ${formatNumber(data.ahn)})`);
  }
  for (const { name, count } of bookEntries) {
    const owned = data.books[name] ?? 0;
    if (owned < count && !isAdmin) throw new Error(`Bạn chỉ có **${owned}** **${name}**, không đủ để xóa **${count}**.`);
    const removed = Math.min(owned, count);
    data.books[name] = owned - removed;
    if (data.books[name] <= 0) delete data.books[name];
    changes.push(`-${removed} 📚 **${name}** (còn lại: ${data.books[name] ?? 0})`);
  }
  for (const { name, count } of itemEntries) {
    const owned = data.items[name] ?? 0;
    if (owned < count && !isAdmin) throw new Error(`Bạn chỉ có **${owned}** **${name}**, không đủ để xóa **${count}**.`);
    const removed = Math.min(owned, count);
    data.items[name] = owned - removed;
    if (data.items[name] <= 0) delete data.items[name];
    changes.push(`-${removed} 🔩 **${name}** (còn lại: ${data.items[name] ?? 0})`);
  }

  await savePlayerData(targetId, data, slot);
  return changes;
}

/**
 * executeCraft — logic craft dùng chung cho prefix -use và slash /use
 * Phải được gọi bên trong withLock của userId.
 * @returns {Promise<{ outputLines: string[], costLines: string[] }>}
 */
async function executeCraft(userId, itemName, craftCount) {
  const recipe = CRAFT_RECIPES[itemName];
  const { data, slot } = await getPlayerDataWithSlot(userId);
  const totalCost = {};
  for (const [mat, qty] of Object.entries(recipe.inputs)) totalCost[mat] = qty * craftCount;
  const shortages = [];
  for (const [mat, needed] of Object.entries(totalCost)) {
    const owned = data.items[mat] ?? 0;
    if (owned < needed) shortages.push(`• **${mat}**: cần **${needed}**, có **${owned}** (thiếu **${needed - owned}**)`);
  }
  if (shortages.length > 0) {
    throw new Error(`Không đủ nguyên liệu để craft **${craftCount}× ${itemName}**:\n` + shortages.join("\n"));
  }
  for (const [mat, needed] of Object.entries(totalCost)) {
    data.items[mat] = (data.items[mat] ?? 0) - needed;
    if (data.items[mat] <= 0) delete data.items[mat];
  }
  const outputLines = [];
  for (const [out, qty] of Object.entries(recipe.output)) {
    const gained = qty * craftCount;
    data.items[out] = (data.items[out] ?? 0) + gained;
    outputLines.push(`**${gained}× ${out}**`);
  }
  await savePlayerData(userId, data, slot);
  const costLines = Object.entries(totalCost)
    .map(([mat, qty]) => `• -${qty} **${mat}** (còn lại: ${data.items[mat] ?? 0})`);
  return { outputLines, costLines };
}

/**
 * parseBatchEntries — parse chuỗi "Tên x<số>, Tên x<số>" thành mảng entries
 * @param {string} raw          — chuỗi input
 * @param {Function} findFn     — hàm lookup tên (findBook / findItem / findItemAdmin)
 * @param {string} entityLabel  — "sách" hoặc "vật phẩm" (dùng trong thông báo lỗi)
 * @returns {{ entries: Array<{name:string,count:number}> } | { error: string }}
 */
function parseBatchEntries(raw, findFn, entityLabel) {
  // Dùng Map để tự động gộp entries cùng tên (VD: "Random Book x2, Random Book x3" → x5)
  const entryMap = new Map();
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(.+?)\s+x(\d+)$/i);
    if (!match) {
      return { error: `❌ Định dạng ${entityLabel} sai: \`${part}\`\nĐúng: \`Tên ${entityLabel === "sách" ? "Sách" : "Item"} x<số>\` (VD: \`${entityLabel === "sách" ? "Random Book x2" : "Chipboard MK1 x3"}\`)` };
    }
    const count = parseInt(match[2], 10);
    if (count <= 0) {
      return { error: `❌ Số lượng ${entityLabel} phải lớn hơn 0: \`${part}\`` };
    }
    const name = findFn(match[1].trim());
    if (!name) return { error: `❌ Tên ${entityLabel} không hợp lệ: \`${match[1].trim()}\`` };
    entryMap.set(name, (entryMap.get(name) ?? 0) + count);
  }
  const entries = Array.from(entryMap.entries()).map(([name, count]) => ({ name, count }));
  return { entries };
}




// ─── SKILL DATA (tách sang skills.js) ───────────────────────────────────────
const { SKILLS, SKILL_ALIASES, findSkill, findByKeyword } = require("./skills");


// ─── PRESCRIPT TABLE ──────────────────────────────────────────────────────────
const PRESCRIPT_TABLE = [
  "Dice 1: **27 Dmg** [<:Blunt:1513768529718022254>Blunt] — nhận 2 <:Poise:1513762945715142736>Poise [20 Stamina]",
  "Dice 2: **8 Dmg** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Sinking:1513762793436741652>Sinking [5 Stamina]",
  "Dice 3: **15 Dmg** [<:Slash:1513768633434640517>Slash] — bản thân +10% Dmg turn sau (2 lần/turn) [10 Stamina]",
  "Dice 4: **6 Dmg** [<:Pierce:1513768511179329556>Pierce] — địch nhận thêm 5% Dmg (2 lần/turn) [5 Stamina]",
  "Dice 5: **25 Dmg** [<:Blunt:1513768529718022254>Blunt] — giảm 50 Stamina địch [20 Stamina]",
  "Dice 6: **24 Dmg** [<:Slash:1513768633434640517>Slash] — địch nhận thêm 10% Dmg Slash (2 lần/turn) [20 Stamina]",
  "Dice 7: **12 Dmg** [<:Pierce:1513768511179329556>Pierce] — địch nhận thêm 10% Dmg Pierce (2 lần/turn) [10 Stamina]",
  "Dice 8: **12 Dmg** [<:Blunt:1513768529718022254>Blunt] — địch nhận thêm 10% Dmg Blunt (2 lần/turn) [10 Stamina]",
  "Dice 9: **30 Dmg** [<:Slash:1513768633434640517>Slash] — 100% Crit [20 Stamina]",
];


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let botReady = false;
client.once("ready", () => {
  botReady = true;
  log("info", "startup", "system", `Bot online: ${client.user.tag}`);
});

// ─── PREFIX COMMANDS ──────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  try {

  // ── -rolldice ──
  // Cú pháp: -rolldice <min>-<max> [x<lần>], <min>-<max> [x<lần>], ...
  // VD: -rolldice 3-7 | -rolldice 3-7 x5 | -rolldice 3-17 x14, 2-4, 2-7 x3
  if (message.content.startsWith("-rolldice")) {
    if (isOnCooldown(message.author.id, "rolldice", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const input = message.content.replace("-rolldice", "").trim();
    if (!input) {
      message.reply(
        "❌ Cú pháp:\n" +
        "> `-rolldice <min>-<max>` — roll 1 lần\n" +
        "> `-rolldice <min>-<max> x<lần>` — roll nhiều lần (tối đa 20)\n" +
        "> `-rolldice <range> x<lần>, <range>, <range> x<lần>` — nhiều dice, mỗi dice có số lần riêng\n" +
        "> VD: `-rolldice 3-7` | `-rolldice 3-7 x5` | `-rolldice 3-17 x14, 2-4, 2-7 x3`"
      );
      return;
    }

    const DICE_MAX_COUNT = 10;
    const ROLL_MAX_TIMES = 20;

    // Parse từng dice entry: "3-7 x5" hoặc "3-7"
    function parseDiceEntry(raw) {
      const trimmed = raw.trim();
      // Match: <min>-<max> x<times> hoặc <min>-<max>
      const match = trimmed.match(/^(\d+)-(\d+)(?:\s+x(\d+))?$/i);
      if (!match) return { error: `Định dạng không hợp lệ: \`${trimmed}\`` };
      const min = parseInt(match[1], 10);
      const max = parseInt(match[2], 10);
      const times = match[3] ? parseInt(match[3], 10) : 1;
      if (min >= max || min < 0) return { error: `Min phải nhỏ hơn Max và không âm: \`${trimmed}\`` };
      if (times <= 0) return { error: `Số lần roll phải lớn hơn 0: \`${trimmed}\`` };
      if (times > ROLL_MAX_TIMES) return { error: `Số lần roll tối đa là ${ROLL_MAX_TIMES}: \`${trimmed}\`` };
      return { min, max, times };
    }

    const rawEntries = input.split(",").map(s => s.trim()).filter(Boolean);
    if (rawEntries.length > DICE_MAX_COUNT) {
      message.reply(`❌ Tối đa ${DICE_MAX_COUNT} dice cùng lúc.`);
      return;
    }

    const diceList = [];
    for (const raw of rawEntries) {
      const parsed = parseDiceEntry(raw);
      if (parsed.error) {
        message.reply(`❌ ${parsed.error}\nĐúng: \`<min>-<max>\` hoặc \`<min>-<max> x<lần>\` (VD: \`3-7 x5\`)`);
        return;
      }
      diceList.push(parsed);
    }

    // Build output
    const outputLines = [];
    for (const { min, max, times } of diceList) {
      const results = Array.from({ length: times }, () =>
        Math.floor(Math.random() * (max - min + 1)) + min
      );
      if (times === 1) {
        outputLines.push(`🎲 \`${min}-${max}\` → **${results[0]}**`);
      } else {
        const total = results.reduce((a, b) => a + b, 0);
        const avg = (total / times).toFixed(2);
        outputLines.push(
          `🎲 \`${min}-${max}\` ×${times}: **${total}** [${results.join(" ")}]` +
          ` *(avg: ${avg} | min: ${Math.min(...results)} | max: ${Math.max(...results)})*`
        );
      }
    }

    const header = diceList.length > 1
      ? `${message.author} đã roll **${diceList.length} dice**:\n`
      : `${message.author} `;
    const body = header + outputLines.join("\n");
    message.reply(body.length > 2000 ? body.substring(0, 1990) + "\n…(bị cắt bớt)" : body);
    return;
  }

  // ── -Caduceus ──
  // Cú pháp:
  //   -Caduceus [số lần]                              — roll ngẫu nhiên hoàn toàn
  //   -Caduceus <Blunt|Pierce|Slash> [số lần] [karmic] — 75% ra đúng type (giảm theo Karmic Consequence)
  // Công thức Karmic: chance = max(0, 75 - karmic / 2) %
  if (message.content.toLowerCase().startsWith("-caduceus")) {
    if (isOnCooldown(message.author.id, "caduceus", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const CADUCEUS_MAX = 20;

    // Tách pool theo type dựa vào nội dung string trong PRESCRIPT_TABLE
    const TYPED_POOLS = {
      blunt:  PRESCRIPT_TABLE.filter(e => e.includes("Blunt")),
      pierce: PRESCRIPT_TABLE.filter(e => e.includes("Pierce")),
      slash:  PRESCRIPT_TABLE.filter(e => e.includes("Slash")),
    };
    const TYPE_LABELS = { blunt: "Blunt", pierce: "Pierce", slash: "Slash" };
    const TYPE_COLORS = { blunt: 0xe67e22, pierce: 0x3498db, slash: 0xe74c3c };
    const TYPE_ICONS  = { blunt: "<:Blunt:1513768529718022254>", pierce: "<:Pierce:1513768511179329556>", slash: "<:Slash:1513768633434640517>"};

    const arg = message.content.replace(/-caduceus/i, "").trim();
    const tokens = arg.split(/\s+/);

    // Kiểm tra token đầu có phải type không
    const firstLower = (tokens[0] ?? "").toLowerCase();
    const isTyped = firstLower in TYPED_POOLS;

    if (isTyped) {
      // -Caduceus <type> [times] [karmic]
      const typeKey  = firstLower;
      const timesRaw = parseInt(tokens[1], 10);
      const times    = (!isNaN(timesRaw) && timesRaw > 0) ? timesRaw : 1;
      if (times > CADUCEUS_MAX) {
        message.reply(`❌ Số lần roll tối đa là ${CADUCEUS_MAX}.`);
        return;
      }
      const karmicRaw = parseFloat(tokens[2]);
      const karmic    = (!isNaN(karmicRaw) && karmicRaw >= 0) ? karmicRaw : 0;
      const chance    = Math.max(0, 75 - karmic / 2); // % ra đúng type

      const typePool = TYPED_POOLS[typeKey];
      if (typePool.length === 0) {
        message.reply(`❌ Không tìm thấy entry nào với type **${TYPE_LABELS[typeKey]}** trong Prescript Table.`);
        return;
      }

      const results = Array.from({ length: times }, () => {
        const useTypePool = Math.random() * 100 < chance;
        const pool        = useTypePool ? typePool : PRESCRIPT_TABLE;
        const entry       = pool[Math.floor(Math.random() * pool.length)];
        // Đánh dấu dựa trên nội dung entry thực tế, không phải pool đã chọn
        const isCorrectType = entry.includes(TYPE_LABELS[typeKey]);
        const hitMark = isCorrectType ? " ✅" : " ❌";
        return entry + hitMark;
      });

      // Đếm số lần ra đúng type
      const hits = results.filter(r => r.endsWith("✅")).length;

      message.reply({
        embeds: [{
          title: `${TYPE_ICONS[typeKey]} Prescript — ${TYPE_LABELS[typeKey]}${times > 1 ? ` × ${times}` : ""}`,
          color: TYPE_COLORS[typeKey],
          description:
            `> **Tỷ lệ ra ${TYPE_LABELS[typeKey]}:** ${chance.toFixed(1)}%` +
            (karmic > 0 ? ` *(Karmic Consequence: ${karmic} → −${(karmic / 2).toFixed(1)}%)*` : "") +
            `\n> **Kết quả đúng type:** ${hits}/${times}\n\n` +
            results.join("\n"),
        }],
      });
      return;
    }

    // Mặc định: -Caduceus [số lần] (không typed)
    const timesRaw = parseInt(tokens[0], 10);
    const times    = (!isNaN(timesRaw) && timesRaw > 0) ? timesRaw : 1;
    if (times > CADUCEUS_MAX) {
      message.reply(`❌ Số lần roll tối đa là ${CADUCEUS_MAX}.`);
      return;
    }
    const results = Array.from({ length: times }, () =>
      PRESCRIPT_TABLE[Math.floor(Math.random() * PRESCRIPT_TABLE.length)]
    );
    message.reply({
      embeds: [{
        title: `🎲 Prescript${times > 1 ? ` × ${times}` : ""}`,
        color: 0xe74c3c,
        description: results.join("\n"),
      }],
    });
    return;
  }

  // ── -skill ──
  // Cú pháp: -skill <tên skill> | -skill list
  if (/^-skill(\s|$)/i.test(message.content)) {
    if (isOnCooldown(message.author.id, "skill", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const rawInput = message.content.replace("-skill", "").trim();

    // Cho phép thêm "dullahan" hoặc "no dullahan" / "nodullahan" ở cuối để buộc kết quả Dullahan on/off
    let forceDullahan = false;
    let input = rawInput;
    const dullahanMatch = input.match(/\s*(dullahan)\s*$/i);
    if (dullahanMatch) {
      forceDullahan = true;
      input = input.slice(0, dullahanMatch.index).trim();
    }

    // -skill list <keyword> [trang] — tìm skill theo keyword, có phân trang
    // VD: -skill list slash | -skill list slash 2
    if (/^list\s+[^\d]/i.test(input)) {
      const KW_PAGE_SIZE = 10;
      // Tách keyword và trang: "slash 2" → keyword="slash", page=2
      const kwPageMatch = input.replace(/^list\s+/i, "").trim().match(/^(.+?)\s+(\d+)$/);
      const keyword = kwPageMatch ? kwPageMatch[1].trim() : input.replace(/^list\s+/i, "").trim();
      const found = findByKeyword(keyword);
      if (!found.length) {
        message.reply(`❌ Không tìm thấy skill nào có keyword **${keyword}**.\nDùng \`-skill list\` để xem toàn bộ.`);
        return;
      }
      const totalPages = Math.ceil(found.length / KW_PAGE_SIZE);
      const page = kwPageMatch ? Math.min(Math.max(parseInt(kwPageMatch[2], 10), 1), totalPages) : 1;
      const start = (page - 1) * KW_PAGE_SIZE;
      const pageSkills = found.slice(start, start + KW_PAGE_SIZE);
      const list = pageSkills.map(s => `• **${s.name}** — ${s.cost} | CD: ${s.cd}`).join("\n");
      message.reply({
        embeds: [{
          title: `🔍 Skill có keyword "${keyword}" (${found.length} kết quả) — Trang ${page}/${totalPages}`,
          color: 0x9b59b6,
          description: list,
          footer: { text: `-skill list ${keyword} <trang> để xem trang khác | -skill <tên> để roll` },
        }],
      });
      return;
    }

    // -skill list [trang]
    // Cú pháp: -skill list | -skill list 2 | -skill list 3
    if (!input || input.toLowerCase() === "list" || /^list\s+\d+$/i.test(input)) {
      const PAGE_SIZE = 15;
      const skillEntries = Object.values(SKILLS);
      const totalPages = Math.ceil(skillEntries.length / PAGE_SIZE);
      const pageMatch = input.match(/list\s+(\d+)/i);
      const page = pageMatch ? Math.min(Math.max(parseInt(pageMatch[1], 10), 1), totalPages) : 1;
      const start = (page - 1) * PAGE_SIZE;
      const pageSkills = skillEntries.slice(start, start + PAGE_SIZE);
      const skillLines = pageSkills.map((s, i) => {
        const num = start + i + 1;
        const tags = [];
        if (s.weaponOf) tags.push(`⚔️ ${s.weaponOf}`);
        if (s.needsBlackFlash) tags.push("nhập %");
        if (s.needsReuse) tags.push("nhập %reuse");
        if (s.hasDullahanRoll) tags.push("mặc định bản thường, nhập dullahan để ra bản Dullahan");
        const tagStr = tags.length ? ` *(${tags.join(", ")})*` : "";
        return `\`${num}.\` **${s.name}**${tagStr} — ${s.cost} | CD: ${s.cd} | ${s.diceMul}`;
      });
      message.reply({
        embeds: [{
          title: `📖 Danh sách Skill (Trang ${page}/${totalPages})`,
          color: 0x9b59b6,
          description: skillLines.join("\n"),
          footer: { text: `Tổng ${skillEntries.length} skill | -skill list <trang> để xem trang khác | -skill <tên> để roll` },
        }],
      });
      return;
    }

    const skill = findSkill(input);
    if (!skill) {
      message.reply(`❌ Không tìm thấy skill: \`${input}\`\nDùng \`-skill list\` để xem danh sách.`);
      return;
    }

    // Skill đặc biệt cần arg — dùng promptArg nếu có
    if (skill.promptArg) {
      const { parse, validate, errorMsg, buildHeader } = skill.promptArg;
      const parts = input.trim().split(/\s+/);
      const lastPart = parts[parts.length - 1];
      const parsed = parse(lastPart);
      if (!validate(parsed)) {
        message.reply(errorMsg);
        return;
      }
      const lines = skill.roll(parsed);
      const header = buildHeader(parsed, skill);
      message.reply({
        embeds: [{
          title: `🎲 ${skill.name}`,
          color: skill.embedColor ?? 0x5865f2,
          description: header + "\n\n" + lines.join("\n"),
        }],
      });
      return;
    }

    const lines = skill.hasDullahanRoll ? skill.roll(forceDullahan) : skill.roll();
    const header = skill.weaponOf
      ? `[🗡️ ${skill.weaponOf}] [CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`
      : skill.cost !== "—"
        ? `[${skill.cost}] [CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`
        : `[CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`;
    message.reply({
      embeds: [{
        title: `🎲 ${skill.name}`,
        color: 0x5865f2,
        description: header + "\n\n" + lines.join("\n"),
      }],
    });
    return;
  }

  // ── -parry ──
  if (message.content.startsWith("-parry")) {
    if (isOnCooldown(message.author.id, "parry", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const args = message.content.replace("-parry", "").trim().split(/\s+/);
    const parsedRolls = parseInt(args[0]);
    if (!isNaN(parsedRolls) && parsedRolls <= 0) {
      message.reply("❌ Số lần roll phải lớn hơn 0.");
      return;
    }
    let rolls = (!isNaN(parsedRolls) && Number.isFinite(parsedRolls) && parsedRolls > 0) ? parsedRolls : 1;
    if (rolls > PARRY_MAX_ROLLS) {
      message.reply(`❌ Số lần roll tối đa là ${PARRY_MAX_ROLLS}.`);
      return;
    }
    const { successCount, failCount, lines } = runParryRolls(rolls);
    const summary = `**Kết quả tổng kết:**\n• Thành công: \`${successCount}\` lần\n• Thất bại: \`${failCount}\` lần`;
    const body = `**Parry ${rolls} lần:**\n${lines.join("\n")}\n${summary}`;
    if (body.length > 2000) {
      message.reply(body.substring(0, 1990) + "\n…(bị cắt bớt)");
    } else {
      message.reply(body);
    }
    return;
  }

  // ── -rtparry  (Parry thời gian thực, hỗ trợ nhiều lần liên tiếp) ───────────
  if (message.content.startsWith("-rtparry")) {
    const argStr = message.content.replace("-rtparry", "").trim();
    let rounds = 1;
    if (argStr) {
      const n = parseInt(argStr, 10);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        message.reply("⚠️ Số lần parry phải là số nguyên từ **1** đến **20**.\n> VD: `-rtparry` hoặc `-rtparry 10`");
        return;
      }
      rounds = n;
    }

    const cooldownMs = 5000 + (rounds - 1) * 1500;
    if (isOnCooldown(message.author.id, "parryrt", cooldownMs)) {
      message.reply(`⏳ Chờ **${Math.ceil(cooldownMs / 1000)} giây** trước khi thử parry tiếp nhé.`);
      return;
    }

    // Kiểm tra session đang chạy của user này (cooldown chưa đủ bảo vệ vì thời gian
    // session dài hơn cooldown khi rounds nhiều). Tránh 2 session cùng edit 1 message.
    const hasRunningSession = [...activeParrySessions.values()].some(s => s.userId === message.author.id);
    if (hasRunningSession) {
      message.reply("⚠️ Bạn đang có phiên **Real Time Parry** đang chạy rồi, hãy hoàn thành hoặc chờ nó kết thúc.");
      return;
    }

    // ID phiên duy nhất — dùng làm customId nút để tra lại session khi click vào button
    const sessionId = `${message.author.id}_${Date.now()}`;
    const customId  = `parryrt_${sessionId}`;
    const windowMs  = 400;

    // ── Gửi tin nhắn ban đầu ──
    let sentMsg;
    try {
      sentMsg = await message.reply({
        embeds: [{
          title: rounds > 1 ? `⚔️ Parry Real Time — Lần 1/${rounds}` : "⚔️ Parry Real Time",
          description: "Hãy sẵn sàng…",
          color: 0xf39c12,
          footer: { text: "Bấm đúng lúc đếm ngược kết thúc!" },
        }],
        components: [buildParryRow(customId, "⚠️  Chuẩn bị…", ButtonStyle.Secondary, true)],
      });
    } catch (err) {
      log("error", "parryrt", message.author.id, err.message);
      return;
    }

    const session = {
      userId:      message.author.id,
      phase:       "waiting",   // "waiting" | "window" | "expired"
      responded:   false,
      windowMs,
      windowStart: null,
      createdAt:   Date.now(),
      lastActivityAt: Date.now(), // cập nhật mỗi tick/round/click — dùng để cleanup không xóa nhầm session còn sống
      windowTimer: null,
      expireTimer: null,
      rounds,
      current:     1,
      results:     [], // { success: bool, reactionMs?: number, early?: bool }
    };
    activeParrySessions.set(sessionId, session);

    const titleFor = (n) => session.rounds > 1
      ? `⚔️ Parry Real Time — Lần ${n}/${session.rounds}`
      : "⚔️ Parry Real Time";

    // ── Tổng kết khi đã chạy hết các round ─────────────────────────────────
    const finishSession = async () => {
      activeParrySessions.delete(sessionId);

      if (session.rounds === 1) return; // round đơn đã tự render kết quả riêng

      const successCount = session.results.filter(r => r.success).length;
      const successReactions = session.results.filter(r => r.success).map(r => r.reactionMs);
      const avgMs = successReactions.length
        ? Math.round(successReactions.reduce((a, b) => a + b, 0) / successReactions.length)
        : null;

      const lines = session.results.map((r, i) => {
        if (r.success) return `> Lần ${i + 1}: ✅ ${r.reactionMs}ms`;
        if (r.early)   return `> Lần ${i + 1}: ❌ Quá sớm`;
        return `> Lần ${i + 1}: ❌ Bỏ lỡ`;
      }).join("\n");

      const summaryColor = successCount === session.rounds ? 0x2ecc71
        : successCount === 0 ? 0xe74c3c
        : 0xf39c12;

      await sentMsg.edit({
        embeds: [{
          title: `⚔️ Parry Real Time — Kết quả`,
          description:
            `${message.author} hoàn thành **${successCount}/${session.rounds}** lần parry!\n` +
            (avgMs !== null ? `> Phản ứng trung bình (lần thành công): **${avgMs}ms**\n` : "") +
            `\n${lines}`,
          color: summaryColor,
          footer: { text: "Dùng -rtparry [số] để thử lại" },
        }],
        components: [buildParryRow(customId, "✓  Hoàn thành", ButtonStyle.Secondary, true)],
      }).catch(() => {});
    };

    // ── Sau khi 1 round kết thúc → chuyển round kế hoặc tổng kết ───────────
    const advanceRound = async () => {
      session.lastActivityAt = Date.now();
      if (session.current >= session.rounds) {
        await finishSession();
        return;
      }
      session.current += 1;
      session.phase = "waiting";
      session.responded = false;
      session.windowStart = null;

      setTimeout(() => startRound(), 900);
    };

    // ── Chạy 1 round: đếm ngược → cửa sổ parry → hết giờ ───────────────────
    const startRound = () => {
      const tickCount = 3 + Math.floor(Math.random() * 5);

      const runTick = async (remaining) => {
        if (session.responded) return;

        if (remaining > 0) {
          try {
            await sentMsg.edit({
              embeds: [{
                title: titleFor(session.current),
                description: `⏳ Đòn đánh đến sau: **${remaining}**...`,
                color: 0xf39c12,
                footer: { text: "Bấm đúng lúc đếm ngược kết thúc!" },
              }],
              components: [buildParryRow(customId, "⚠️  Chưa phải lúc…", ButtonStyle.Secondary, false)],
            });
          } catch {
            session.responded = true;
            activeParrySessions.delete(sessionId);
            return;
          }
          session.lastActivityAt = Date.now();

          const tickDelay = 600 + Math.floor(Math.random() * 400);
          session.windowTimer = setTimeout(() => runTick(remaining - 1), tickDelay);
          return;
        }

        // ── Đếm ngược kết thúc → mở cửa sổ parry ──────────────────────────
        if (session.responded) return;

        try {
          await sentMsg.edit({
            embeds: [{
              title: titleFor(session.current),
              description: "## ⚡ BÂY GIỜ! PARRY!",
              color: 0x2ecc71,
            }],
            components: [buildParryRow(customId, "⚔️  P A R R Y !", ButtonStyle.Success, false)],
          });
          session.phase = "window";
          session.windowStart = Date.now();
          session.lastActivityAt = Date.now();
        } catch {
          session.responded = true;
          activeParrySessions.delete(sessionId);
          return;
        }

        // ── Đóng cửa sổ → tự fail nếu chưa ai bấm ──────────────────────────
        session.expireTimer = setTimeout(async () => {
          if (session.responded) return;
          session.phase = "expired";
          session.responded = true;
          session.lastActivityAt = Date.now();
          session.results.push({ success: false });

          if (session.rounds === 1) {
            activeParrySessions.delete(sessionId);
            await sentMsg.edit({
              embeds: [{
                title: titleFor(session.current),
                description:
                  `${message.author} đã **bỏ lỡ** đòn! ❌\n` +
                  `> Cửa sổ parry: **${windowMs}ms** — chậm quá!`,
                color: 0xe74c3c,
                footer: { text: "Dùng -rtparry để thử lại" },
              }],
              components: [buildParryRow(customId, "✗  Bỏ lỡ!", ButtonStyle.Danger, true)],
            }).catch(() => {});
            return;
          }

          await sentMsg.edit({
            embeds: [{
              title: titleFor(session.current),
              description:
                `${message.author} đã **bỏ lỡ** đòn! ❌\n` +
                `> Cửa sổ parry: **${windowMs}ms** — chậm quá!`,
              color: 0xe74c3c,
            }],
            components: [buildParryRow(customId, "✗  Bỏ lỡ!", ButtonStyle.Danger, true)],
          }).catch(() => {});

          await advanceRound();
        }, windowMs + 1);
      };

      // Tick đầu tiên cũng có delay ngẫu nhiên trước khi edit
      const firstDelay = 600 + Math.floor(Math.random() * 400);
      session.windowTimer = setTimeout(() => runTick(tickCount - 1), firstDelay);
    };

    session.advanceRound = advanceRound;
    session.titleFor = titleFor;

    // Khởi động round đầu sau khoảng nghỉ ngắn
    setTimeout(() => startRound(), 900);

    return;
  }

  // ── -daily ──
  if (message.content.startsWith("-daily")) {
    if (isOnCooldown(message.author.id, "daily", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const userId = message.author.id;
    try {
      const result = await processDailyClaimForUser(userId);
      if (result.alreadyClaimed) {
        message.reply(
          `${message.author}, bạn đã nhận daily hôm nay rồi.\n` +
          `Thời gian còn lại đến reset: **${result.hours}h ${result.minutes}m ${result.seconds}s**.`
        );
      } else {
        message.reply(result.replyMsg.replace("{USER}", message.author.toString()));
      }
    } catch (err) {
      log("error", "daily", userId, err.message, { stack: err.stack });
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
    return;
  }

  // ── -balance ──
  if (message.content.startsWith("-balance")) {
    if (isOnCooldown(message.author.id, "balance", 2000)) { message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé."); return; }
    const targetUser = message.mentions.users.first() ?? message.author;
    try {
      message.reply(await buildBalanceEmbed(targetUser));
    } catch (err) {
      log("error", "balance", targetUser.id, err.message);
      message.reply("❌ Có lỗi xảy ra khi lấy dữ liệu.");
    }
    return;
  }

  // ── -inventory ──
  if (message.content.startsWith("-inventory")) {
    if (isOnCooldown(message.author.id, "inventory", 2000)) { message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé."); return; }
    const targetUser = message.mentions.users.first() ?? message.author;
    try {
      const reply = await fetchInventoryReply(targetUser);
      if (!reply) {
        message.reply(`📦 ${targetUser} không có gì trong kho.`);
        return;
      }
      message.reply(reply);
    } catch (err) {
      log("error", "inventory", targetUser.id, err.message);
      message.reply("❌ Có lỗi xảy ra khi lấy dữ liệu.");
    }
    return;
  }

  // ── -give ──
  if (message.content.startsWith("-give")) {
    if (isOnCooldown(message.author.id, "give", 3000)) {
      message.reply("⏳ Chờ 3 giây trước khi dùng lệnh này tiếp nhé.");
      return;
    }
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const targetUser = message.mentions.users.first();
    if (!targetUser) {
      message.reply("❌ Hãy mention người nhận. Ví dụ: `-give @user book: Random Book count: 1`");
      return;
    }
    if (targetUser.id === message.author.id) {
      message.reply("❌ Không thể tặng cho chính mình.");
      return;
    }
    const rawInput = message.content.replace("-give", "").replace(/<@!?\d+>/, "").trim();
    const kv = parseKeyValues(rawInput);
    // Dùng hàm helper để phân biệt "không nhập" (undefined→0) với "nhập sai" (NaN→error)
    // tránh bug parseInt("abc") || 0 nuốt giá trị không hợp lệ thành 0 không báo lỗi.
    function parseIntOrError(raw, fieldName) {
      if (raw == null) return { value: 0, error: null };
      const n = parseInt(raw, 10);
      if (isNaN(n)) return { value: null, error: `❌ \`${fieldName}\` phải là số nguyên, nhận được: \`${raw}\`` };
      return { value: n, error: null };
    }
    const expParsed  = parseIntOrError(kv["exp"],  "exp");
    const ahnParsed  = parseIntOrError(kv["ahn"],  "ahn");
    if (expParsed.error)  { message.reply(expParsed.error);  return; }
    if (ahnParsed.error)  { message.reply(ahnParsed.error);  return; }
    const expGain = expParsed.value;
    const ahnGain = ahnParsed.value;
    const bookRaw = kv["book"] ?? null;
    const bookCount = Math.max(1, parseInt(kv["count"] ?? "1", 10) || 1);
    const itemRaw = kv["item"] ?? null;
    const hasBook = !!bookRaw;
    // Nếu có cả book lẫn item, dùng itemcount: riêng để tránh nhầm lẫn với count: của book.
    // Nếu chỉ có item, itemcount: ưu tiên trước rồi mới fallback sang count:.
    const itemCountRaw = kv["itemcount"] ?? (hasBook ? "1" : kv["count"] ?? "1");
    const itemCount = Math.max(1, parseInt(itemCountRaw, 10) || 1);
    const gradeTarget = kv["grade"] ? parseInt(kv["grade"], 10) : null;

    if (!isAdmin && (expGain !== 0 || gradeTarget !== null)) {
      message.reply("❌ Bạn không thể tặng EXP cho người khác.");
      return;
    }
    if (!isAdmin && ahnGain < 0) {
      message.reply("❌ Không thể chuyển số Ahn âm.");
      return;
    }
    if (gradeTarget !== null && (isNaN(gradeTarget) || gradeTarget < GRADE_MAX || gradeTarget > GRADE_MIN)) {
      message.reply(`❌ Grade phải từ ${GRADE_MAX}–${GRADE_MIN}.`);
      return;
    }
    let bookName = null;
    if (bookRaw) {
      bookName = findBook(bookRaw);
      if (!bookName) {
        message.reply(`❌ Tên sách không hợp lệ: \`${bookRaw}\`\nDùng \`-books\` để xem danh sách sách hợp lệ.`);
        return;
      }
    }
    let itemName = null;
    if (itemRaw) {
      itemName = isAdmin ? findItemAdmin(itemRaw) : findItem(itemRaw);
      if (!itemName) {
        message.reply(`❌ Tên vật phẩm không hợp lệ: \`${itemRaw}\`\nDùng \`-items\` để xem danh sách vật phẩm hợp lệ.`);
        return;
      }
    }
    if (expGain === 0 && ahnGain === 0 && !bookName && !itemName && gradeTarget === null) {
      message.reply("❌ Cần chỉ định ít nhất một trong: `ahn`, `book`, `item`" + (isAdmin ? ", `exp`, `grade`." : "."));
      return;
    }

    try {
      // Dùng withDoubleLock cho cả admin lẫn non-admin để tránh race condition
      // khi admin vô tình chạy 2 lệnh give cho cùng target cùng lúc.
      const runGive = () => executeGive({
        senderId: message.author.id,
        targetId: targetUser.id,
        isAdmin, ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget,
      });
      const changes = await withDoubleLock(message.author.id, targetUser.id, runGive);
      const verb = isAdmin ? "tặng" : "chuyển";
      message.reply(
        `✅ ${message.author} đã ${verb} cho ${targetUser}:\n` +
        changes.map(c => `> ${c}`).join("\n")
      );
    } catch (err) {
      log("error", "give", message.author.id, err.message, { target: targetUser.id });
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}`);
    }
    return;
  }

  // ── -remove ──
  if (message.content.startsWith("-remove")) {
    if (isOnCooldown(message.author.id, "remove", 3000)) {
      message.reply("⏳ Chờ 3 giây trước khi dùng lệnh này tiếp nhé.");
      return;
    }
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const mentionedUser = message.mentions.users.first();
    let targetUser;
    if (mentionedUser) {
      if (!isAdmin && mentionedUser.id !== message.author.id) {
        message.reply("❌ Bạn chỉ có thể xóa đồ của chính mình.");
        return;
      }
      targetUser = mentionedUser;
    } else {
      targetUser = message.author;
    }
    const rawInput = message.content.replace("-remove", "").replace(/<@!?\d+>/, "").trim();
    const kv = parseKeyValues(rawInput);
    // parseInt || 0 nuốt NaN — validate trước để báo lỗi rõ ràng cho admin
    function parseRemoveInt(raw, fieldName) {
      if (raw == null) return { value: 0, error: null };
      const n = parseInt(raw, 10);
      if (isNaN(n)) return { value: null, error: `❌ \`${fieldName}\` phải là số nguyên, nhận được: \`${raw}\`` };
      return { value: n, error: null };
    }
    const expParsed = parseRemoveInt(kv["exp"], "exp");
    const ahnParsed = parseRemoveInt(kv["ahn"], "ahn");
    if (expParsed.error) { message.reply(expParsed.error); return; }
    if (ahnParsed.error) { message.reply(ahnParsed.error); return; }
    const expRemove = expParsed.value;
    const ahnRemove = ahnParsed.value;
    const bookRaw = kv["book"] ?? null;
    const bookCount = Math.max(1, parseInt(kv["count"] ?? "1", 10) || 1);
    const itemRaw = kv["item"] ?? null;
    const itemCount = Math.max(1, parseInt(kv["itemcount"] ?? kv["count"] ?? "1", 10) || 1);

    if (!isAdmin && (expRemove !== 0 || ahnRemove !== 0)) {
      message.reply("❌ Bạn chỉ có thể tự xóa sách hoặc vật phẩm của mình.");
      return;
    }

    const bookEntries = [];
    if (bookRaw) {
      const bookName = findBook(bookRaw);
      if (!bookName) { message.reply(`❌ Tên sách không hợp lệ: \`${bookRaw}\``); return; }
      bookEntries.push({ name: bookName, count: bookCount });
    }
    const itemEntries = [];
    if (itemRaw) {
      const itemName = isAdmin ? findItemAdmin(itemRaw) : findItem(itemRaw);
      if (!itemName) { message.reply(`❌ Tên vật phẩm không hợp lệ: \`${itemRaw}\``); return; }
      itemEntries.push({ name: itemName, count: itemCount });
    }

    const booksRaw = kv["books"] ?? null;
    if (booksRaw) {
      const result = parseBatchEntries(booksRaw, findBook, "sách");
      if (result.error) { message.reply(result.error); return; }
      bookEntries.push(...result.entries);
    }
    const itemsRaw = kv["items"] ?? null;
    if (itemsRaw) {
      const findFn = isAdmin ? findItemAdmin : findItem;
      const result = parseBatchEntries(itemsRaw, findFn, "vật phẩm");
      if (result.error) { message.reply(result.error); return; }
      itemEntries.push(...result.entries);
    }

    if (expRemove === 0 && ahnRemove === 0 && bookEntries.length === 0 && itemEntries.length === 0) {
      message.reply("❌ Cần chỉ định ít nhất một trong: `exp`, `ahn`, `book`, `item`, `books`, `items`.");
      return;
    }
    try {
      const changes = await withLock(targetUser.id, () => executeRemove({
        actorId: message.author.id, targetId: targetUser.id,
        isAdmin, expRemove, ahnRemove, bookEntries, itemEntries,
      }));
      const isSelf = targetUser.id === message.author.id;
      const header = isSelf
        ? `🗑️ ${message.author} đã xóa khỏi kho của mình:`
        : `🗑️ ${message.author} (admin) đã xóa khỏi kho của ${targetUser}:`;
      message.reply(header + "\n" + changes.map(c => `> ${c}`).join("\n"));
    } catch (err) {
      log("error", "remove", targetUser.id, err.message, { actor: message.author.id });
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}`);
    }
    return;
  }

  // ── -setplayer ──
  if (message.content.startsWith("-setplayer")) {
    if (!ADMIN_IDS.has(message.author.id)) {
      message.reply("❌ Bạn không có quyền dùng lệnh này.");
      return;
    }
    const targetUsers = [...message.mentions.users.values()];
    if (targetUsers.length === 0) {
      message.reply(
        "❌ Hãy mention ít nhất một người cần set. Ví dụ:\n" +
        "`-setplayer @user1 @user2 exp: 100 ahn: 50000 books: Random Book x3, N Corp Book x1 items: Tên Item x2`"
      );
      return;
    }
    const rawInput = message.content.replace("-setplayer", "").replace(/<@!?\d+>/g, "").trim();
    const kv = parseKeyValues(rawInput);
    const booksRaw = kv["books"] ?? null;
    const bookEntries = [];
    if (booksRaw) {
      const parts = booksRaw.split(",").map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const match = part.match(/^(.+?)\s+(\+?)x(\d+)$/i);
        if (!match) {
          message.reply(`❌ Định dạng sách sai: \`${part}\`\nĐúng: \`Tên Sách x<số>\` hoặc \`Tên Sách +x<số>\` (VD: \`Random Book x5\` hoặc \`Random Book +x3\`)`);
          return;
        }
        const bookName = findBook(match[1].trim());
        if (!bookName) {
          message.reply(`❌ Tên sách không hợp lệ: \`${match[1].trim()}\`\nDùng \`-books\` để xem danh sách.`);
          return;
        }
        bookEntries.push({ name: bookName, count: parseInt(match[3], 10), isAdd: match[2] === "+" });
      }
    }
    const itemsRaw = kv["items"] ?? null;
    const itemEntries = [];
    if (itemsRaw) {
      const parts = itemsRaw.split(",").map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const match = part.match(/^(.+?)\s+(\+?)x(\d+)$/i);
        if (!match) {
          message.reply(`❌ Định dạng vật phẩm sai: \`${part}\`\nĐúng: \`Tên Item x<số>\` hoặc \`Tên Item +x<số>\` (VD: \`Tên Item x2\` hoặc \`Tên Item +x2\`)`);
          return;
        }
        const itemName = findItemAdmin(match[1].trim());
        if (!itemName) {
          message.reply(`❌ Tên vật phẩm không hợp lệ hoặc quá dài: \`${match[1].trim()}\``);
          return;
        }
        itemEntries.push({ name: itemName, count: parseInt(match[3], 10), isAdd: match[2] === "+" });
      }
    }
    const expAddRaw = kv["exp"] ?? null;
    const ahnAddRaw = kv["ahn"] ?? null;
    const expIsAdd = expAddRaw && expAddRaw.startsWith("+");
    const ahnIsAdd = ahnAddRaw && ahnAddRaw.startsWith("+");
    const expValue = expAddRaw ? parseInt(expAddRaw.replace("+", ""), 10) || 0 : null;
    const ahnValue = ahnAddRaw ? parseInt(ahnAddRaw.replace("+", ""), 10) || 0 : null;
    const gradeTarget = kv["grade"] ? parseInt(kv["grade"], 10) : null;
    if (gradeTarget !== null && (isNaN(gradeTarget) || gradeTarget < GRADE_MAX || gradeTarget > GRADE_MIN)) {
      message.reply(`❌ Grade phải từ ${GRADE_MAX}–${GRADE_MIN}.`);
      return;
    }
    if (expValue === null && ahnValue === null && gradeTarget === null && bookEntries.length === 0 && itemEntries.length === 0) {
      message.reply("❌ Không có gì để set. Dùng: `exp`, `grade`, `ahn`, `books`, `items`.\n> Thêm `+` trước số để cộng thêm, VD: `exp: +50`");
      return;
    }

    const results = await Promise.allSettled(
      targetUsers.map(targetUser =>
        withLock(targetUser.id, async () => {
          const { data, slot } = await getPlayerDataWithSlot(targetUser.id);
          data.books = data.books ?? {};
          data.items = data.items ?? {};
          const changes = [];
          if (gradeTarget !== null) {
            const expNeeded = calcExpForGrade(gradeTarget);
            data.exp = expNeeded;
            changes.push(`Grade → **Grade ${gradeTarget}** (EXP = **${expNeeded}**)`);
          } else if (expValue !== null) {
            if (expIsAdd) {
              const before = data.exp ?? 0;
              data.exp = clampExp(before + expValue);
              changes.push(`EXP +${expValue} (${before} → **${data.exp}**) [max: ${EXP_MAX}]`);
            } else {
              data.exp = clampExp(expValue);
              changes.push(`EXP set → **${data.exp}** [max: ${EXP_MAX}]`);
            }
          }
          if (ahnValue !== null) {
            if (ahnIsAdd) {
              const before = data.ahn ?? 0;
              data.ahn = Math.max(0, before + ahnValue);
              changes.push(`Ahn +${formatNumber(ahnValue)} (${formatNumber(before)} → **${formatNumber(data.ahn)}**)`);
            } else {
              data.ahn = Math.max(0, ahnValue);
              changes.push(`Ahn set → **${formatNumber(data.ahn)}**`);
            }
          }
          if (bookEntries.length > 0) {
            for (const { name, count, isAdd } of bookEntries) {
              data.books[name] = isAdd ? (data.books[name] ?? 0) + count : count;
            }
            changes.push(`Sách:\n` + bookEntries.map(e => `> • 📚 **${e.name}** ${e.isAdd ? `+${e.count}` : `× ${e.count} (set)`}`).join("\n"));
          }
          if (itemEntries.length > 0) {
            for (const { name, count, isAdd } of itemEntries) {
              data.items[name] = isAdd ? (data.items[name] ?? 0) + count : count;
            }
            changes.push(`Vật phẩm:\n` + itemEntries.map(e => `> • 🔩 **${e.name}** ${e.isAdd ? `+${e.count}` : `× ${e.count} (set)`}`).join("\n"));
          }
          await savePlayerData(targetUser.id, data, slot);
          return changes;
        })
      )
    );

    const lines = results.map((r, i) => {
      const user = targetUsers[i];
      if (r.status === "fulfilled") {
        const changes = r.value;
        return `✅ **${user.username}**:\n` + changes.map(c => `> ${c}`).join("\n");
      } else {
        log("error", "setplayer", user.id, r.reason?.message, { actor: message.author.id });
        return `❌ **${user.username}**: ${r.reason?.message ?? "Lỗi không xác định"}`;
      }
    });

    const body = `📋 Kết quả \`-setplayer\` cho ${targetUsers.length} người:\n\n` + lines.join("\n\n");
    if (body.length > 2000) {
      const chunks = [];
      let current = "";
      for (const line of lines) {
        if ((current + "\n\n" + line).length > 1900) {
          chunks.push(current);
          current = line;
        } else {
          current = current ? current + "\n\n" + line : line;
        }
      }
      if (current) chunks.push(current);
      await message.reply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
    } else {
      message.reply(body);
    }
    return;
  }

  // ── -use ──
  if (message.content.startsWith("-use")) {
    if (isOnCooldown(message.author.id, "use", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const rawInput = message.content.replace("-use", "").trim();
    if (!rawInput) {
      message.reply(
        "❌ Cú pháp: `-use <tên vật phẩm> [count: <số>]`\n" +
        "> VD: `-use Chipboard MK2` — craft 1 cái\n" +
        "> VD: `-use Chipboard MK3 count: 5` — craft 5 cái\n" +
        "> Dùng `-recipes` để xem công thức craft."
      );
      return;
    }
    const countMatch = rawInput.match(/\s+count:\s*(\d+)$/i);
    const craftCount = countMatch ? Math.max(1, parseInt(countMatch[1], 10) || 1) : 1;
    const itemInput = countMatch ? rawInput.slice(0, countMatch.index).trim() : rawInput;
    const itemName = findItem(itemInput);
    if (!itemName) {
      message.reply(
        `❌ Vật phẩm không hợp lệ: \`${itemInput}\`\n` +
        `Dùng \`-items\` để xem danh sách, \`-recipes\` để xem công thức craft.`
      );
      return;
    }
    const recipe = CRAFT_RECIPES[itemName];
    if (!recipe) {
      message.reply(`❌ **${itemName}** không có công thức craft.\nDùng \`-recipes\` để xem các vật phẩm có thể craft.`);
      return;
    }
    try {
      // Tách Discord API call ra ngoài withLock: nếu message.reply chậm (network lag,
      // rate limit), lock TTL có thể hết hạn trong khi vẫn đang giữ lock, cho phép
      // concurrent operation trên cùng userId. executeCraft chỉ cần Redis — giữ trong lock.
      const { outputLines, costLines } = await withLock(userId, () =>
        executeCraft(userId, itemName, craftCount)
      );
      message.reply(
        `⚒️ ${message.author} đã craft thành công!\n` +
        `> 🎁 Nhận được: ${outputLines.join(", ")}\n` +
        `> 📦 Nguyên liệu đã dùng:\n` +
        costLines.map(l => `> ${l}`).join("\n")
      );
    } catch (err) {
      log("error", "use", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}`);
    }
    return;
  }

  // ── -recipes ──
  if (message.content.startsWith("-recipes")) {
    const recipeLines = Object.entries(CRAFT_RECIPES).map(([output, recipe]) => {
      const inputStr = Object.entries(recipe.inputs).map(([mat, qty]) => `${qty}× ${mat}`).join(" + ");
      const outputQty = recipe.output[output];
      return `\`${inputStr}\` → **${outputQty}× ${output}**`;
    });
    message.reply({
      embeds: [{
        title: "⚒️ Công thức Craft",
        color: 0xe74c3c,
        description: recipeLines.join("\n"),
        footer: { text: "Dùng -use <tên vật phẩm> [count: <số>] để craft" },
      }],
    });
    return;
  }

  // ── -books ──
  if (message.content.startsWith("-books")) {
    const cols = 2;
    const half = Math.ceil(VALID_BOOKS.length / cols);
    const col1 = VALID_BOOKS.slice(0, half).map((b, i) => `\`${i + 1}.\` ${b}`);
    const col2 = VALID_BOOKS.slice(half).map((b, i) => `\`${half + i + 1}.\` ${b}`);
    message.reply({
      embeds: [{
        title: "📚 Danh sách sách hợp lệ",
        color: 0x2ecc71,
        fields: [
          { name: "​", value: col1.join("\n"), inline: true },
          { name: "​", value: col2.join("\n"), inline: true },
        ],
        footer: { text: `Tổng cộng ${VALID_BOOKS.length} loại sách` },
      }],
    });
    return;
  }

  // ── -items ──
  if (message.content.startsWith("-items")) {
    const lines = VALID_ITEMS.map((item, i) => `\`${i + 1}.\` ${item}`);
    message.reply({
      embeds: [{
        title: "🔩 Danh sách vật phẩm hợp lệ",
        color: 0xe67e22,
        description: lines.join("\n"),
        footer: { text: `Tổng cộng ${VALID_ITEMS.length} loại vật phẩm` },
      }],
    });
    return;
  }

  // ── -dothihelp ──
  if (message.content.startsWith("-dothihelp")) {
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const generalFields = [
      { name: "📅 -daily", value: "Nhận phần thưởng điểm danh hàng ngày.\n> `5 EXP + 100k Ahn + 1 Random Book`\n> Streak 7 ngày: thêm `25 EXP + 400k Ahn + 1 Sealed Book Cache`", inline: false },
      { name: "💼 -balance [@user]", value: "Xem thông tin Grade, EXP, Ahn và tổng kho của bạn hoặc người khác.\n> VD: `-balance` hoặc `-balance @user`", inline: false },
      { name: "🎒 -inventory [@user]", value: "Xem chi tiết toàn bộ sách và vật phẩm trong kho.\n> VD: `-inventory` hoặc `-inventory @user`", inline: false },
      { name: "🎁 -give @user [...]", value: ["Chuyển Ahn, sách hoặc vật phẩm cho người khác.", "> `ahn: <số>` — số Ahn muốn chuyển", "> `book: <tên> count: <số>` — sách muốn chuyển", "> `item: <tên> itemcount: <số>` — vật phẩm muốn chuyển (dùng `itemcount` khi có cả book lẫn item, **bắt buộc** khi có cả hai)", "> VD: `-give @user ahn: 50000`", "> VD: `-give @user book: Random Book count: 2`", "> VD: `-give @user book: Random Book count: 1 item: Chipboard MK1 itemcount: 2`"].join("\n"), inline: false },
      { name: "🗑️ -remove [...]", value: ["Tự xóa sách hoặc vật phẩm khỏi kho của mình.", "> `book: <tên> count: <số>` — xóa 1 loại sách", "> `item: <tên> itemcount: <số>` — xóa 1 loại vật phẩm", "> `books: <Tên> x<số>, <Tên> x<số>` — xóa nhiều loại sách cùng lúc", "> `items: <Tên> x<số>, <Tên> x<số>` — xóa nhiều loại vật phẩm cùng lúc", "> VD: `-remove books: Random Book x2, N Corp Book x1`"].join("\n"), inline: false },
      { name: "⚒️ -use <tên vật phẩm> [count: <số>]", value: ["Craft vật phẩm bằng nguyên liệu trong kho.", "> VD: `-use Chipboard MK2` — craft 1 cái", "> VD: `-use Chipboard MK3 count: 5` — craft 5 cái cùng lúc"].join("\n"), inline: false },
      { name: "📋 -recipes", value: "Xem toàn bộ công thức craft vật phẩm.", inline: false },
      { name: "📖 -randombook [số]", value: "Mở Random Book để nhận sách ngẫu nhiên (tối đa 20 lần).\n> VD: `-randombook` hoặc `-randombook 5`", inline: false },
      { name: "🔮 -randomsealedbook [số]", value: "Mở Sealed Book Cache để nhận sách hiếm (tối đa 20 lần).\n> VD: `-randomsealedbook` hoặc `-randomsealedbook 3`", inline: false },
      { name: "🔩 -chipboardcache [số]", value: "Mở Chipboard Cache để nhận Chipboard MK1–MK3 ngẫu nhiên (tối đa 20 lần).\n> VD: `-chipboardcache` hoặc `-chipboardcache 5`", inline: false },
      { name: "🎴 -skill <tên>", value: "Roll kết quả skill. Dùng `-skill list` để xem toàn bộ.\n> VD: `-skill Purify` | `-skill furioso` | `-skill list`", inline: false },
      { name: "⚔️ -parry [số]", value: "Roll kiểm tra parry (Attacker d16 vs Defender d20, hòa thì roll lại). Tối đa 30 lần.\n> VD: `-parry` hoặc `-parry 10`", inline: false },
      { name: "🎯 -rtparry [số]", value: "Parry thời gian thực! Đếm ngược kết thúc thì bấm.\n> Bấm sớm = ❌ thất bại | Bỏ lỡ cửa sổ = ❌ thất bại | Đúng lúc = ✅ thành công\n> Cửa sổ parry: 400ms\n> Thêm số để parry liên tiếp nhiều lần (tối đa 20): `-rtparry 10`", inline: false },
      { name: "🎲 -rolldice <range> [x<lần>], ...", value: ["Roll dice theo range tùy chỉnh. Mỗi dice có thể có số lần riêng.", "> `-rolldice <min>-<max>` — roll 1 lần", "> `-rolldice <min>-<max> x<lần>` — roll nhiều lần (tối đa 20)", "> `-rolldice <range> x<lần>, <range>, <range> x<lần>` — nhiều dice, mỗi dice có số lần riêng (tối đa 10 dice)", "> VD: `-rolldice 3-7` | `-rolldice 3-7 x5` | `-rolldice 3-17 x14, 2-4, 2-7 x3`"].join("\n"), inline: false },
      { name: "📊 -math [...]", value: ["Tính damage theo hệ thống game.", "> `dmg:` `res:` `dr: <% DR, VD: 90%>` `bonus:` `critmul:` `critdiv: <số|yes|no>`", "> `critdiv: 2` = Overbearing (÷2) | `critdiv: 1.5` = Steady Breathing (÷1.5) | `critdiv: yes` = ÷2", "> `sanity:` `sanitybonus: <Sanity của bản thân>` `sinking:` `rupture:` `dicemul:`", `> \`poise: <stacks>\` — Starting <:Poise:1513762945715142736>Poise Count (1 Count = 5% crit, tối đa ${POISE_MAX})`, "> VD: `-math dmg: 10B poise: 10 critmul: 1.3`"].join("\n"), inline: false },
      { name: "✨ -dmgbonus <số>", value: "Cho biết % Dmg Bonus thực tế sau khi bị bão hòa.\n> VD: `-dmgbonus 1000`", inline: false },
      { name: "🛡️ -dr <số>", value: "Cho biết % Damage Reduction thực tế sau khi bị bão hòa.\n> VD: `-dr 1000`", inline: false },
      { name: "📚 -books", value: "Xem danh sách toàn bộ sách hợp lệ.", inline: false },
      { name: "🔩 -items", value: "Xem danh sách vật phẩm hợp lệ (dành cho người thường).", inline: false },
    ];
    const adminFields = [
      { name: "─────── 🔐 ADMIN ONLY ───────", value: "Các lệnh dưới đây chỉ dành cho admin.", inline: false },
      { name: "🎁 -give @user (admin)", value: ["Admin có thể tặng EXP, set Grade, và dùng **bất kỳ tên item nào** không cần trong whitelist.", "> `exp: <số>` — tặng EXP (bị cap tại MAX)", "> `grade: <1–9>` — set Grade trực tiếp", "> `item: <tên bất kỳ> itemcount: <số>` — không cần validate tên (tối đa 100 ký tự)", "> VD: `-give @user item: Sword of Dawn itemcount: 1`"].join("\n"), inline: false },
      { name: "🗑️ -remove @user (admin)", value: ["Admin có thể xóa EXP, Ahn, sách, hoặc **item bất kỳ** của người khác.", "> `exp:` `ahn:` `book:` `item: <tên bất kỳ>` (tối đa 100 ký tự)", "> `books: <Tên> x<số>, ...` — xóa nhiều sách cùng lúc", "> `items: <Tên bất kỳ> x<số>, ...` — xóa nhiều item cùng lúc (tối đa 100 ký tự/tên)", "> VD: `-remove @user books: Random Book x2, N Corp Book x1`", "> VD: `-remove @user items: Sword of Dawn x1`"].join("\n"), inline: false },
      { name: "⚙️ -setplayer @user [...]", value: ["Set hoặc cộng thêm dữ liệu của người chơi.", "> `exp: <số>` — set EXP | `exp: +<số>` — cộng thêm EXP (bị cap tại MAX)", "> `grade: <1–9>` — set Grade", "> `ahn: <số>` — set Ahn | `ahn: +<số>` — cộng thêm Ahn", "> `books: <Tên> x<số>` — set | `+x<số>` — cộng thêm (phải hợp lệ)", "> `items: <Tên bất kỳ> x<số>` — set | `+x<số>` — cộng thêm (tối đa 100 ký tự/tên)", "> VD: `-setplayer @user exp: +50 ahn: +100000`", "> VD: `-setplayer @user grade: 5 ahn: 1000000 items: Durandal x2`"].join("\n"), inline: false },
    ];
    const fields = isAdmin ? [...generalFields, ...adminFields] : generalFields;
    message.reply({
      embeds: [{
        title: "📖 Danh sách lệnh của bot",
        color: isAdmin ? 0xe74c3c : 0x5865f2,
        description: isAdmin ? "Hiển thị đầy đủ bao gồm lệnh admin vì bạn là **Admin** 🔐" : "Dùng các lệnh dưới đây để tương tác với bot.",
        fields,
        footer: { text: `EXP tối đa: ${EXP_MAX} (Grade 1 MAX)${isAdmin ? " • Admin mode" : ""}` },
      }],
    });
    return;
  }

  // ── -chipboardcache ──
  if (message.content.startsWith("-chipboardcache")) {
    if (isOnCooldown(message.author.id, "chipboardcache", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const args = message.content.replace("-chipboardcache", "").trim().split(/\s+/);
    const { count, error } = parseOpenCount(args[0], OPEN_COUNT_MAX);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results, partial } = await handleOpenChipboardCache(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Chipboard Cache** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Chipboard Cache", results, remainingCount: data.items["Chipboard Cache"] ?? 0 });
      message.reply({ embeds: [{ title: `🔩 Mở Chipboard Cache${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0xe67e22, description: desc, footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Chipboard Cache nên chỉ mở được ${results.length} lần.` } : undefined }] });
    } catch (err) {
      log("error", "chipboardcache", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
    return;
  }

  // ── -randomsealedbook ── (phải đứng TRƯỚC -randombook)
  if (message.content.startsWith("-randomsealedbook")) {
    if (isOnCooldown(message.author.id, "randomsealedbook", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const args = message.content.replace("-randomsealedbook", "").trim().split(/\s+/);
    const { count, error } = parseOpenCount(args[0], OPEN_COUNT_MAX);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results, partial } = await handleOpenSealedBook(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Sealed Book Cache** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Sealed Book Cache", results, remainingCount: data.books["Sealed Book Cache"] ?? 0 });
      message.reply({ embeds: [{ title: `🔮 Mở Sealed Book Cache${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0x9b59b6, description: desc, footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Sealed Book Cache nên chỉ mở được ${results.length} lần.` } : undefined }] });
    } catch (err) {
      log("error", "randomsealedbook", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
    return;
  }

  // ── -randombook ──
  if (message.content.startsWith("-randombook")) {
    if (isOnCooldown(message.author.id, "randombook", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const args = message.content.replace("-randombook", "").trim().split(/\s+/);
    const { count, error } = parseOpenCount(args[0], OPEN_COUNT_MAX);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results, partial } = await handleOpenRandomBook(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Random Book** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Random Book", results, remainingCount: data.books["Random Book"] ?? 0 });
      message.reply({ embeds: [{ title: `📖 Mở Random Book${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0x2ecc71, description: desc, footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Random Book nên chỉ mở được ${results.length} lần.` } : undefined }] });
    } catch (err) {
      log("error", "randombook", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
    return;
  }

  // ── -profile ──
  if (message.content.startsWith("-profile")) {
    if (isOnCooldown(message.author.id, "profile", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const args = message.content.replace("-profile", "").trim().split(/\s+/);
    const sub = (args[0] ?? "").toLowerCase();

    // -profile switch <1|2|3>
    if (sub === "switch") {
      const slot = parseInt(args[1], 10);
      if (!slot || slot < 1 || slot > MAX_PROFILES) {
        message.reply(`❌ Slot không hợp lệ. Dùng: \`-profile switch 1\`, \`-profile switch 2\` hoặc \`-profile switch 3\``);
        return;
      }
      const currentSlot = await getActiveProfileSlot(userId);
      if (slot === currentSlot) {
        const names = await getProfileNames(userId);
        message.reply(`ℹ️ Bạn đang ở **${resolveProfileLabel(names, slot)}** rồi.`);
        return;
      }
      await setActiveProfileSlot(userId, slot);
      const names = await getProfileNames(userId);
      message.reply(`✅ Đã chuyển sang **${PROFILE_EMOJIS[slot]} ${resolveProfileLabel(names, slot)}**!\n> Tất cả lệnh từ bây giờ sẽ dùng save này.`);
      return;
    }

    // -profile rename <tên>
    if (sub === "rename") {
      const rawName = args.slice(1).join(" ").trim();
      if (rawName.length > PROFILE_NAME_MAX_LENGTH) {
        message.reply(`❌ Tên profile tối đa ${PROFILE_NAME_MAX_LENGTH} ký tự.`);
        return;
      }
      const currentSlot = await getActiveProfileSlot(userId);
      await setProfileName(userId, currentSlot, rawName || null);
      const newLabel = rawName || PROFILE_LABELS[currentSlot];
      message.reply(rawName
        ? `✅ Đã đặt tên **${PROFILE_EMOJIS[currentSlot]} Profile ${currentSlot}** thành **"${newLabel}"**!`
        : `✅ Đã reset tên **${PROFILE_EMOJIS[currentSlot]} Profile ${currentSlot}** về mặc định **"${newLabel}"**.`
      );
      return;
    }

    // -profile info
    if (sub === "info" || sub === "") {
      const embed = await buildProfileInfoEmbed(
        userId,
        message.author.displayName ?? message.author.username,
        "Dùng -profile switch <1/2/3> để đổi profile"
      );
      message.reply({ embeds: [embed] });
      return;
    }

    message.reply("❌ Lệnh không hợp lệ. Dùng:\n> `-profile info` — xem tổng quan tất cả profile\n> `-profile switch <1/2/3>` — chuyển sang profile khác\n> `-profile rename <tên>` — đặt tên cho profile hiện tại");
    return;
  }

  // ── -math ──
  if (message.content.startsWith("-math")) {
    if (isOnCooldown(message.author.id, "math", 2000)) { message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé."); return; }
    const input = message.content.replace("-math", "").trim();
    const kv = parseKeyValues(input);
    const dmgStr = kv["dmg"] ?? "";
    if (!dmgStr.trim()) {
      message.reply(
        "⚠️ Bạn chưa nhập `dmg:`. Vui lòng nhập công thức damage.\n" +
        "> VD: `-math dmg: 10B poise: 10 critmul: 1.3`\n" +
        "> Định dạng dmg: `<số>[x<lần>][+<extra>%] [Dice]<B|P|S>[+<:Sinking:1513762793436741652>Sinking][+<:Rupture:1513762812722155682>Rupture][+<:Poise:1513762945715142736>Poise][+<:Butterfly:1516679919399338074>Living][+<:Butterfly:1516679919399338074>Departed][+Crit<n>]`\n" +
        "> VD: `10x12P+1Living` — mỗi hit cộng 1 Count The Living, áp dụng từ hit kế tiếp"
      );
      return;
    }
    const bonusPct = parseFloat((kv["bonus"] ?? "0").replace("%", ""));
    const sanityBonusPct = parseFloat((kv["sanitybonus"] ?? "0").replace("%", ""));
    const critMul = parseFloat((kv["critmul"] ?? "1").replace("x", ""));
    const poiseInit = parseInt(kv["poise"] ?? "0", 10) || 0;
    const diceMul = parseFloat((kv["dicemul"] ?? "1").replace("x", ""));
    const sinkingInit = parseInt(kv["sinking"] ?? "0", 10);
    const ruptureInit = parseInt(kv["rupture"] ?? "0", 10);
    const sanityInit = parseInt(kv["sanity"] ?? "0", 10);
    const theLiving = parseInt(kv["living"] ?? "0", 10) || 0;
    const theDeparted = parseInt(kv["departed"] ?? "0", 10) || 0;
    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving, theDeparted });
    if (errors.length > 0) { message.reply(`❌ Input không hợp lệ:\n${errors.map(e => `• ${e}`).join("\n")}`); return; }
    const critDivStr = (kv["critdiv"] ?? "").trim().toLowerCase();
    let critDiv = 0;
    if (critDivStr === "yes" || critDivStr === "true" || critDivStr === "1") {
      critDiv = 2;
    } else {
      const parsed = parseFloat(critDivStr);
      if (!isNaN(parsed) && parsed > 1) critDiv = parsed;
    }

    message.reply(calcMath({
      dmgStr,
      resStr: kv["res"] ?? "",
      drStr: kv["dr"] ?? "",
      bonusPct,
      sanityBonusPct,
      critMul,
      poiseInit,
      critDiv,
      sanityInit,
      diceMul,
      sinkingInit,
      ruptureInit,
      theLiving,
      theDeparted,
    }));
    return;
  }

  // ── -dmgbonus ──
  // Cú pháp: -dmgbonus <số>  (hoặc -dmgbonus: <số>)
  // Cho biết % Dmg Bonus thực tế (sau bão hòa) ứng với 1 số % raw.
  if (message.content.startsWith("-dmgbonus")) {
    if (isOnCooldown(message.author.id, "dmgbonus", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const raw = message.content.replace("-dmgbonus", "").trim().replace(/^:/, "").trim();
    const value = parseFloat(raw.replace("%", ""));
    if (!raw || isNaN(value)) {
      message.reply(
        "❌ Cú pháp: `-dmgbonus <số>`\n" +
        "> VD: `-dmgbonus 1000` → cho biết % Dmg Bonus thực tế sau khi bị bão hòa."
      );
      return;
    }
    const eff = saturateBonusPct(value);
    const isSaturated = value > 100;
    const display = isSaturated
      ? `**${eff.toFixed(2)}%** effective *(raw: ${value.toFixed(2)}%)*`
      : `${value.toFixed(2)}% *(chưa bị bão hòa)*`;
    message.reply(`✨ **% Dmg Bonus:** ${display}`);
    return;
  }

  // ── -dr ──
  // Cú pháp: -dr <số>  (hoặc -dr: <số>)
  // Cho biết % Damage Reduction thực tế (sau bão hòa) ứng với 1 số % raw.
  if (message.content.startsWith("-dr")) {
    if (isOnCooldown(message.author.id, "dr", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const raw = message.content.replace("-dr", "").trim().replace(/^:/, "").trim();
    const value = parseFloat(raw.replace("%", ""));
    if (!raw || isNaN(value)) {
      message.reply(
        "❌ Cú pháp: `-dr <% DR>`\n" +
        "> VD: `-dr 1000` → cho biết % Damage Reduction thực tế sau khi bị bão hòa."
      );
      return;
    }
    const drMult = saturateDR(1 - value / 100);
    const effPct = (1 - drMult) * 100;
    const isSaturated = effPct.toFixed(2) !== value.toFixed(2);
    const display = isSaturated
      ? `${value.toFixed(2)}% raw → **${effPct.toFixed(2)}%** effective *(${drMult.toFixed(3)}x)*`
      : `${value.toFixed(2)}% *(chưa bị bão hòa)*`;
    message.reply(`🛡️ **Damage Reduction:** ${display}`);
    return;
  }

  } catch (err) {
    console.error("[messageCreate error]", err);
    try { message.reply("❌ Có lỗi không mong muốn xảy ra.").catch(() => {}); } catch {}
  }
});

// ─── BUTTON INTERACTIONS ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  try {

  // ── Nút phân trang inventory ──
  if (interaction.customId.startsWith("invpage:")) {
    const [, targetUserId, pageStr] = interaction.customId.split(":");
    const page = parseInt(pageStr, 10);
    // Chỉ chủ nhân của inventory được bấm Prev/Next — tránh người khác thao túng
    // trang hiển thị trong embed (dù /inventory là public).
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({
        content: "⚠️ Chỉ chủ nhân của inventory này mới có thể chuyển trang.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    try {
      const targetUser = await client.users.fetch(targetUserId).catch(() => null);
      if (!targetUser) {
        return interaction.reply({ content: "❌ Không tìm thấy người dùng.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const reply = await fetchInventoryReply(targetUser, page);
      if (!reply) {
        return interaction.reply({ content: "📦 Kho hiện đã trống.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      await interaction.update(reply);
    } catch (err) {
      log("error", "invpage button", interaction.user?.id ?? "unknown", err.message);
      interaction.reply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // ── Nút parry thời gian thực ──
  if (interaction.customId.startsWith("parryrt_")) {
    const sessionId = interaction.customId.replace("parryrt_", "");
    const session   = activeParrySessions.get(sessionId);

    // Người khác cố bấm → ephemeral warning
    if (!session || interaction.user.id !== session.userId) {
      return interaction.reply({
        content: session
          ? "⚠️ Chỉ người dùng lệnh mới có thể tương tác với phiên parry này!"
          : "⚠️ Phiên parry này đã kết thúc.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    // Race condition guard — session đã xử lý xong
    if (session.responded) {
      return interaction.reply({
        content: "⚠️ Phiên parry đã kết thúc.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    const now = Date.now();
    session.responded = true;
    session.lastActivityAt = now;
    clearTimeout(session.windowTimer);
    clearTimeout(session.expireTimer);

    const { customId } = interaction;
    const title = session.titleFor(session.current);

    // ── Bấm quá sớm (trong lúc đếm ngược, trước khi "BÂY GIỜ!") ──────────────
    if (session.phase === "waiting") {
      session.results.push({ success: false, early: true });

      await interaction.update({
        embeds: [{
          title,
          description:
            `${interaction.user} bấm **quá sớm**! ❌\n` +
            `> Đếm ngược chưa kết thúc — cần kiên nhẫn hơn.`,
          color: 0xe74c3c,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
        components: [buildParryRow(customId, "✗  Quá sớm!", ButtonStyle.Danger, true)],
      }).catch(() => {});

      if (session.rounds === 1) {
        activeParrySessions.delete(sessionId);
      } else {
        await session.advanceRound();
      }
      return;
    }

    // ── Bấm trong cửa sổ → PARRY THÀNH CÔNG ────────────────────────────────
    if (session.phase === "window") {
      const reactionMs = now - session.windowStart;
      const rating =
        reactionMs < 100 ? "🏆 **AMAZING!** Phản ứng SIÊU NHANH!" :
        reactionMs < 200 ? "⚡ **GREAT!** Phản ứng rất nhanh!"   :
        reactionMs < 300 ? "✅ **GOOD!** Phản ứng tốt!"          :
                           "😅 **NOT BAD!** Vừa kịp!";

      session.results.push({ success: true, reactionMs });

      await interaction.update({
        embeds: [{
          title,
          description:
            `${interaction.user} **PARRY THÀNH CÔNG!** ✅\n` +
            `> ⚡ Phản ứng: **${reactionMs}ms** — ${rating}\n` +
            `> Cửa sổ parry: **${session.windowMs}ms**`,
          color: 0x2ecc71,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
        components: [buildParryRow(customId, "✓  Parry thành công!", ButtonStyle.Success, true)],
      }).catch(() => {});

      if (session.rounds === 1) {
        activeParrySessions.delete(sessionId);
      } else {
        await session.advanceRound();
      }
      return;
    }

    // ── Cửa sổ vừa đóng (race condition cực hiếm: expireTimer chạy đúng lúc này) ──
    return interaction.reply({
      content: "⚠️ Cửa sổ parry vừa đóng — chậm mất rồi!",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
  } catch (err) {
    log("error", "buttonInteraction", interaction.user?.id ?? "unknown", err.message);
    interaction.reply({ content: "❌ Có lỗi không mong muốn xảy ra.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {

  if (interaction.commandName === "math") {
    if (await replyOnCooldown(interaction, 2000)) return;
    await interaction.deferReply();
    const dmgStr = interaction.options.getString("dmg") ?? "";
    if (!dmgStr.trim()) {
      await interaction.editReply({
        content:
          "⚠️ Bạn chưa nhập `dmg`. Vui lòng nhập công thức damage.\n" +
          "> VD: `10B`, `5x3B`, `8S+Crit50`, `1DiceB`"
      });
      return;
    }
    const poiseInit = interaction.options.getInteger("poise") ?? 0;
    const critMul = interaction.options.getNumber("critmul") ?? 1;
    const diceMul = interaction.options.getNumber("dicemul") ?? 1;
    const sinkingInit = interaction.options.getInteger("sinking") ?? 0;
    const ruptureInit = interaction.options.getInteger("rupture") ?? 0;
    const sanityInit = interaction.options.getInteger("sanity") ?? 0;
    const theLiving = interaction.options.getInteger("living") ?? 0;
    const theDeparted = interaction.options.getInteger("departed") ?? 0;
    const bonusPct = interaction.options.getNumber("bonus") ?? 0;
    const sanityBonusPct = interaction.options.getNumber("sanitybonus") ?? 0;
    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving, theDeparted });
    if (errors.length > 0) { await interaction.editReply({ content: `❌ Input không hợp lệ:\n${errors.map(e => `• ${e}`).join("\n")}` }); return; }
    const critDivOption = (interaction.options.getString("critdiv") ?? "").trim().toLowerCase() || null;
    let critDivSlash = 0;
    if (critDivOption === "yes" || critDivOption === "true" || critDivOption === "1") {
      critDivSlash = 2;
    } else if (typeof critDivOption === "string") {
      const p = parseFloat(critDivOption);
      if (!isNaN(p) && p > 1) critDivSlash = p;
    }

    await interaction.editReply(calcMath({
      dmgStr,
      resStr: interaction.options.getString("res") ?? "",
      drStr: interaction.options.getString("dr") ?? "",
      bonusPct,
      sanityBonusPct,
      critMul,
      poiseInit,
      critDiv: critDivSlash,
      sanityInit,
      diceMul,
      sinkingInit,
      ruptureInit,
      theLiving,
      theDeparted,
    }));
    return;
  }

  if (interaction.commandName === "parry") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const rolls = Math.min(interaction.options.getInteger("rolls") ?? 1, PARRY_MAX_ROLLS);
    const { successCount, failCount, lines } = runParryRolls(rolls);
    let body = `**Parry ${rolls} lần:**\n${lines.join("\n")}\n**Kết quả tổng kết:**\n• Thành công: \`${successCount}\` lần\n• Thất bại: \`${failCount}\` lần`;
    if (body.length > 2000) body = body.substring(0, 1990) + "\n…(bị cắt bớt)";
    await interaction.editReply({ content: body });
    return;
  }

  if (interaction.commandName === "daily") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    try {
      const result = await processDailyClaimForUser(interaction.user.id);
      if (result.alreadyClaimed) {
        await interaction.editReply({ content: `${interaction.user}, bạn đã nhận daily hôm nay rồi.\nThời gian còn lại đến reset: **${result.hours}h ${result.minutes}m ${result.seconds}s**.` });
      } else {
        await interaction.editReply({ content: result.replyMsg.replace("{USER}", interaction.user.toString()) });
      }
    } catch (err) {
      log("error", "/daily", interaction.user.id, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}` });
    }
    return;
  }

  if (interaction.commandName === "randombook") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const userId = interaction.user.id;
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), OPEN_COUNT_MAX);
    try {
      const { success, data, results, partial } = await handleOpenRandomBook(userId, count);
      if (!success) {
        await interaction.editReply({ content: "❌ Bạn không có **Random Book** nào trong kho hoặc không đủ số lượng." });
        return;
      }
      await interaction.editReply({
        embeds: [{
          title: `📖 Mở Random Book${results.length > 1 ? ` × ${results.length}` : ""}`,
          color: 0x2ecc71,
          description: buildRollDescription({
            user: interaction.user,
            cacheType: "Random Book",
            results,
            remainingCount: data.books["Random Book"] ?? 0,
          }),
          footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Random Book nên chỉ mở được ${results.length} lần.` } : undefined,
        }],
      });
    } catch (err) {
      log("error", "/randombook", userId, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}` });
    }
    return;
  }

  if (interaction.commandName === "randomsealedbook") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const userId = interaction.user.id;
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), OPEN_COUNT_MAX);
    try {
      const { success, data, results, partial } = await handleOpenSealedBook(userId, count);
      if (!success) {
        await interaction.editReply({ content: "❌ Bạn không có **Sealed Book Cache** nào trong kho hoặc không đủ số lượng." });
        return;
      }
      await interaction.editReply({
        embeds: [{
          title: `🔮 Mở Sealed Book Cache${results.length > 1 ? ` × ${results.length}` : ""}`,
          color: 0x9b59b6,
          description: buildRollDescription({
            user: interaction.user,
            cacheType: "Sealed Book Cache",
            results,
            remainingCount: data.books["Sealed Book Cache"] ?? 0,
          }),
          footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Sealed Book Cache nên chỉ mở được ${results.length} lần.` } : undefined,
        }],
      });
    } catch (err) {
      log("error", "/randomsealedbook", userId, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}` });
    }
    return;
  }

  if (interaction.commandName === "chipboardcache") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const userId = interaction.user.id;
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), OPEN_COUNT_MAX);
    try {
      const { success, data, results, partial } = await handleOpenChipboardCache(userId, count);
      if (!success) {
        await interaction.editReply({ content: "❌ Bạn không có **Chipboard Cache** nào trong kho hoặc không đủ số lượng." });
        return;
      }
      await interaction.editReply({
        embeds: [{
          title: `🔩 Mở Chipboard Cache${results.length > 1 ? ` × ${results.length}` : ""}`,
          color: 0xe67e22,
          description: buildRollDescription({
            user: interaction.user,
            cacheType: "Chipboard Cache",
            results,
            remainingCount: data.items["Chipboard Cache"] ?? 0,
          }),
          footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Chipboard Cache nên chỉ mở được ${results.length} lần.` } : undefined,
        }],
      });
    } catch (err) {
      log("error", "/chipboardcache", userId, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}` });
    }
    return;
  }

  if (interaction.commandName === "balance") {
    if (await replyOnCooldown(interaction, 2000)) return;
    await interaction.deferReply();
    const targetUser = interaction.options.getUser("user") ?? interaction.user;
    try {
      await interaction.editReply(await buildBalanceEmbed(targetUser));
    } catch (err) {
      log("error", "/balance", targetUser.id, err.message);
      await interaction.editReply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu." });
    }
    return;
  }

  if (interaction.commandName === "inventory") {
    if (await replyOnCooldown(interaction, 2000)) return;
    await interaction.deferReply();
    const targetUser = interaction.options.getUser("user") ?? interaction.user;
    try {
      const reply = await fetchInventoryReply(targetUser);
      if (!reply) {
        await interaction.editReply({ content: `📦 ${targetUser} không có gì trong kho.` });
        return;
      }
      await interaction.editReply(reply);
    } catch (err) {
      log("error", "/inventory", targetUser.id, err.message);
      await interaction.editReply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu." });
    }
    return;
  }

  if (interaction.commandName === "use") {
    if (await replyOnCooldown(interaction, 2000)) return; 
    const userId = interaction.user.id;
    await interaction.deferReply();
    const itemInput = interaction.options.getString("item") ?? "";
    const craftCount = Math.max(1, interaction.options.getInteger("count") ?? 1);
    const itemName = findItem(itemInput);
    if (!itemName) {
      await interaction.editReply({ content: `❌ Vật phẩm không hợp lệ: \`${itemInput}\`\nDùng \`/items\` để xem danh sách, \`/recipes\` để xem công thức craft.` });
      return;
    }
    const recipe = CRAFT_RECIPES[itemName];
    if (!recipe) {
      await interaction.editReply({ content: `❌ **${itemName}** không có công thức craft.\nDùng \`/recipes\` để xem các vật phẩm có thể craft.` });
      return;
    }
    try {
      // Tách interaction.editReply ra ngoài withLock: nếu Discord API chậm (network lag,
      // rate limit), lock TTL có thể hết hạn trong khi vẫn đang giữ lock, cho phép
      // concurrent operation trên cùng userId. executeCraft chỉ cần Redis — giữ trong lock.
      const { outputLines, costLines } = await withLock(userId, () =>
        executeCraft(userId, itemName, craftCount)
      );
      await interaction.editReply({
        content:
          `⚒️ ${interaction.user} đã craft thành công!\n` +
          `> 🎁 Nhận được: ${outputLines.join(", ")}\n` +
          `> 📦 Nguyên liệu đã dùng:\n` +
          costLines.map(l => `> ${l}`).join("\n"),
      });
    } catch (err) {
      log("error", "/use", userId, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}` });
    }
    return;
  }

  if (interaction.commandName === "give") {
    if (await replyOnCooldown(interaction, 3000)) return;
    const isAdmin = ADMIN_IDS.has(interaction.user.id);
    await interaction.deferReply();
    const targetUser = interaction.options.getUser("user");
    if (!targetUser) { await interaction.editReply({ content: "❌ Không tìm thấy người nhận." }); return; }
    if (targetUser.id === interaction.user.id) { await interaction.editReply({ content: "❌ Không thể tặng cho chính mình." }); return; }

    const ahnGain = interaction.options.getInteger("ahn") ?? 0;
    const bookRaw = interaction.options.getString("book") ?? null;
    const bookCount = Math.max(1, interaction.options.getInteger("bookcount") ?? 1);
    const itemRaw = interaction.options.getString("item") ?? null;
    const itemCount = Math.max(1, interaction.options.getInteger("itemcount") ?? 1);
    const expGain = interaction.options.getInteger("exp") ?? 0;
    const gradeTarget = interaction.options.getInteger("grade") ?? null;

    if (!isAdmin && (expGain !== 0 || gradeTarget !== null)) {
      await interaction.editReply({ content: "❌ Bạn không thể tặng EXP cho người khác." });
      return;
    }
    if (!isAdmin && ahnGain < 0) { await interaction.editReply({ content: "❌ Không thể chuyển số Ahn âm." }); return; }

    let bookName = null;
    if (bookRaw) {
      bookName = findBook(bookRaw);
      if (!bookName) { await interaction.editReply({ content: `❌ Tên sách không hợp lệ: \`${bookRaw}\`` }); return; }
    }
    let itemName = null;
    if (itemRaw) {
      itemName = isAdmin ? findItemAdmin(itemRaw) : findItem(itemRaw);
      if (!itemName) { await interaction.editReply({ content: `❌ Tên vật phẩm không hợp lệ: \`${itemRaw}\`` }); return; }
    }
    if (ahnGain === 0 && !bookName && !itemName && expGain === 0 && gradeTarget === null) {
      await interaction.editReply({ content: "❌ Cần chỉ định ít nhất một trong: `ahn`, `book`, `item`" + (isAdmin ? ", `exp`, `grade`." : ".") });
      return;
    }

    try {
      // Dùng withDoubleLock nhất quán cho cả admin lẫn non-admin
      const runGive = () => executeGive({
        senderId: interaction.user.id,
        targetId: targetUser.id,
        isAdmin, ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget,
      });
      const changes = await withDoubleLock(interaction.user.id, targetUser.id, runGive);
      await interaction.editReply({
        content: `✅ ${interaction.user} đã ${isAdmin ? "tặng" : "chuyển"} cho ${targetUser}:\n` +
          changes.map(c => `> ${c}`).join("\n"),
      });
    } catch (err) {
      log("error", "/give", interaction.user.id, err.message, { target: targetUser.id });
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}` });
    }
    return;
  }

  if (interaction.commandName === "remove") {
    if (await replyOnCooldown(interaction, 3000)) return;
    const isAdmin = ADMIN_IDS.has(interaction.user.id);
    await interaction.deferReply();
    const mentionedUser = interaction.options.getUser("user");
    let targetUser;
    if (mentionedUser) {
      if (!isAdmin && mentionedUser.id !== interaction.user.id) {
        await interaction.editReply({ content: "❌ Bạn chỉ có thể xóa đồ của chính mình." });
        return;
      }
      targetUser = mentionedUser;
    } else {
      targetUser = interaction.user;
    }

    const expRemove = interaction.options.getInteger("exp") ?? 0;
    const ahnRemove = interaction.options.getInteger("ahn") ?? 0;
    const bookRaw = interaction.options.getString("book") ?? null;
    const bookCount = Math.max(1, interaction.options.getInteger("bookcount") ?? 1);
    const itemRaw = interaction.options.getString("item") ?? null;
    const itemCount = Math.max(1, interaction.options.getInteger("itemcount") ?? 1);

    if (!isAdmin && (expRemove !== 0 || ahnRemove !== 0)) {
      await interaction.editReply({ content: "❌ Bạn chỉ có thể tự xóa sách hoặc vật phẩm của mình." });
      return;
    }

    const bookEntries = [];
    if (bookRaw) {
      const bookName = findBook(bookRaw);
      if (!bookName) { await interaction.editReply({ content: `❌ Tên sách không hợp lệ: \`${bookRaw}\`` }); return; }
      bookEntries.push({ name: bookName, count: bookCount });
    }
    const booksRaw = interaction.options.getString("books") ?? null;
    if (booksRaw) {
      const result = parseBatchEntries(booksRaw, findBook, "sách");
      if (result.error) { await interaction.editReply({ content: result.error }); return; }
      bookEntries.push(...result.entries);
    }
    const itemEntries = [];
    if (itemRaw) {
      const itemName = isAdmin ? findItemAdmin(itemRaw) : findItem(itemRaw);
      if (!itemName) { await interaction.editReply({ content: `❌ Tên vật phẩm không hợp lệ: \`${itemRaw}\`` }); return; }
      itemEntries.push({ name: itemName, count: itemCount });
    }
    const itemsRaw = interaction.options.getString("items") ?? null;
    if (itemsRaw) {
      const findFn = isAdmin ? findItemAdmin : findItem;
      const result = parseBatchEntries(itemsRaw, findFn, "vật phẩm");
      if (result.error) { await interaction.editReply({ content: result.error }); return; }
      itemEntries.push(...result.entries);
    }

    if (expRemove === 0 && ahnRemove === 0 && bookEntries.length === 0 && itemEntries.length === 0) {
      await interaction.editReply({ content: "❌ Cần chỉ định ít nhất một trong: `exp`, `ahn`, `book`, `item`, `books`, `items`." });
      return;
    }

    try {
      const changes = await withLock(targetUser.id, () => executeRemove({
        actorId: interaction.user.id, targetId: targetUser.id,
        isAdmin, expRemove, ahnRemove, bookEntries, itemEntries,
      }));
      const isSelf = targetUser.id === interaction.user.id;
      await interaction.editReply({
        content: (isSelf ? `🗑️ ${interaction.user} đã xóa khỏi kho của mình:` : `🗑️ ${interaction.user} (admin) đã xóa khỏi kho của ${targetUser}:`) +
          "\n" + changes.map(c => `> ${c}`).join("\n"),
      });
    } catch (err) {
      log("error", "/remove", targetUser.id, err.message, { actor: interaction.user.id });
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}` });
    }
    return;
  }

  // ── /profile ──
  if (interaction.commandName === "profile") {
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();

    if (sub === "switch") {
      if (await replyOnCooldown(interaction, 2000)) return;
      const slot = interaction.options.getInteger("slot");
      const currentSlot = await getActiveProfileSlot(userId);
      if (slot === currentSlot) {
        const names = await getProfileNames(userId);
        await interaction.reply({
          content: `ℹ️ Bạn đang ở **${resolveProfileLabel(names, slot)}** rồi.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await setActiveProfileSlot(userId, slot);
      const names = await getProfileNames(userId);
      const label = resolveProfileLabel(names, slot);
      await interaction.reply({
        content: `✅ Đã chuyển sang **${PROFILE_EMOJIS[slot]} ${label}**!\n> Tất cả lệnh từ bây giờ sẽ dùng save này.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "info") {
      if (await replyOnCooldown(interaction, 2000)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const embed = await buildProfileInfoEmbed(
        userId,
        interaction.user.displayName ?? interaction.user.username,
        "Dùng /profile switch để đổi profile"
      );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "rename") {
      if (await replyOnCooldown(interaction, 2000)) return;
      const currentSlot = await getActiveProfileSlot(userId);
      const rawName = (interaction.options.getString("name") ?? "").trim();

      // Validate
      if (rawName.length > PROFILE_NAME_MAX_LENGTH) {
        await interaction.reply({
          content: `❌ Tên profile tối đa ${PROFILE_NAME_MAX_LENGTH} ký tự.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await setProfileName(userId, currentSlot, rawName || null);
      const newLabel = rawName || PROFILE_LABELS[currentSlot];
      await interaction.reply({
        content: rawName
          ? `✅ Đã đặt tên **${PROFILE_EMOJIS[currentSlot]} Profile ${currentSlot}** thành **"${newLabel}"**!`
          : `✅ Đã reset tên **${PROFILE_EMOJIS[currentSlot]} Profile ${currentSlot}** về mặc định **"${newLabel}"**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    return;
  }
  } catch (err) {
    log("error", "interactionCreate", interaction.user?.id ?? "unknown", err.message, { cmd: interaction.commandName });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Có lỗi không mong muốn xảy ra.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(TOKEN);

// ─── EXPRESS SERVER ────────────────────────────────────────────────────────────
app.get("/", (req, res) => botReady ? res.send("Bot is alive and kicking!") : res.status(503).send("Bot is starting up..."));
app.use((req, res) => res.status(404).send("Not found."));
app.use((err, req, res, next) => { console.error("[Express error]", err); res.status(500).send("Internal server error."); });

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () => log("info", "startup", "system", `Server running on port ${PORT}`));

// Clear timer khi process shutdown để tránh memory leak
function gracefulShutdown(signal) {
  log("info", "shutdown", "system", `${signal} received, shutting down.`);
  clearInterval(cooldownCleanupTimer);
  clearInterval(parrySessionCleanupTimer);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => log("error", "uncaughtException", "system", err.message, { stack: err.stack }));
process.on("unhandledRejection", (reason) => log("error", "unhandledRejection", "system", String(reason)));
