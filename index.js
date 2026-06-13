// index.js
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
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
const SANITY_MIN = -45;
const POISE_CRIT_BONUS_PER_STACK = 0.05;
const POISE_RESET_THRESHOLD = 1;
const POISE_MAX = 99;
const POISE_CRIT_DIV_DEFAULT = 2;
const SINKING_MAX = 99;
const RUPTURE_MAX = 99;

// ─── REAL-TIME PARRY ──────────────────────────────────────────────────────────
// Map<sessionId, session> — lưu trạng thái từng phiên parry đang chạy
const activeParrySessions = new Map();

// Dọn session cũ (>30 giây) mỗi 30 giây để tránh memory leak
setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [id, s] of activeParrySessions)
    if (s.createdAt < cutoff) activeParrySessions.delete(id);
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
const GRADE_MAX = 1;
const GRADE_MIN = 9;

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
  (process.env.ADMIN_IDS ?? "208187560692940803,1072123095739019346,675899106614575150")
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
  "dmg", "res", "bonus", "critmul", "critdiv",
  "sanity", "sanitybonus", "sinking", "rupture", "dicemul",
  "poise",
  "books", "items", "stat", "scaleskill",
  "dmgnegationboss", "vulnerability", "buffbonus", "dmgbaseweapon",
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

function validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit }) {
  const errors = [];
  if (poiseInit < 0 || poiseInit > POISE_MAX) errors.push(`Poise phải từ 0–${POISE_MAX}`);
  if (critMul < 1) errors.push("CritMul phải ≥ 1");
  if (diceMul < 0) errors.push("DiceMul phải ≥ 0");
  if (sinkingInit < 0 || sinkingInit > SINKING_MAX) errors.push(`Sinking phải từ 0–${SINKING_MAX}`);
  if (ruptureInit < 0 || ruptureInit > RUPTURE_MAX) errors.push(`Rupture phải từ 0–${RUPTURE_MAX}`);
  if (sanityInit < SANITY_MIN) errors.push(`Sanity phải ≥ ${SANITY_MIN}`);
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

function withTimeout(promise, ms = REDIS_TIMEOUT_MS, msg = "Thao tác Redis quá thời gian, thử lại sau.") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(msg)), ms);
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
  innerTtl = 6, retries = 3, retryDelayMs = 200, bufferSeconds = 3,
} = {}) {
  const [firstId, secondId] = [idA, idB].sort();
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
  return err && (err.message === "Thao tác Redis quá thời gian, thử lại sau." || err.message === "Lock timeout");
}

async function getPlayerData(userId) {
  const key = `player:${userId}`;
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

async function savePlayerData(userId, data) {
  const key = `player:${userId}`;
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
  const pipeline = redis.pipeline();
  for (const { userId, data } of entries) {
    pipeline.set(`player:${userId}`, JSON.stringify(data));
  }
  const results = await withTimeout(pipeline.exec());
  if (Array.isArray(results)) {
    const failures = results
      .map((r, i) => {
        const err = r && typeof r === "object" && "error" in r ? r.error : null;
        return err ? { index: i, userId: entries[i]?.userId, err } : null;
      })
      .filter(Boolean);
    if (failures.length > 0) {
      const detail = failures.map(f => `[${f.userId}]: ${f.err}`).join(", ");
      for (const f of failures) {
        log("error", "saveMultiplePlayerData", f.userId ?? "unknown", f.err);
      }
      throw new Error(`Pipeline save thất bại một phần: ${detail}`);
    }
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
function parseOpenCount(raw, max = 20) {
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
    const data = await getPlayerData(userId);
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
    await savePlayerData(userId, data);
    return { success: true, data, results };
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

  const LIMIT = 4096;
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
    const dailyKey = `daily:${userId}`;
    const playerKey = `player:${userId}`;

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
    bonusPct = 0,
    sanityBonusPct = 0,
    critMul = 1,
    poiseInit = 0,
    critDiv = 0,
    sanityInit = 0,
    diceMul = 1,
    sinkingInit = 0,
    ruptureInit = 0,
  } = opts;

  const resValues = { B: 1, P: 1, S: 1 };
  const resRegex = /([\d.]+)(?:x)?([BPS])/gi;
  let match;
  while ((match = resRegex.exec(resStr)) !== null) {
    resValues[match[2].toUpperCase()] = parseFloat(match[1]);
  }

  const dmgValues = [];
  const damageRegex =
    /([\d.]+)(?:x([\d.]+))?(?:\+([\d.]+)%?)?\s*(Dice)?([BPSbps])((?:\+\d*Sinking|\+\d*Rupture|\+\d*Poise|\+Crit\d+)*)/gi;
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
    const sinkingToApply = sinkingMatch ? parseInt(sinkingMatch[1] || "1") : 0;
    const ruptureToApply = ruptureMatch ? parseInt(ruptureMatch[1] || "1") : 0;
    const poiseToApply = poiseMatch ? parseInt(poiseMatch[1] || "0") : 0;
    for (let i = 0; i < multiplier; i++) {
      dmgValues.push({ value: base, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply, effectsStr });
    }
  }
  if (dmgValues.length === 0) {
    dmgValues.push({ value: 0, type: "B", isDice: false, extraPct: 0, sinkingToApply: 0, ruptureToApply: 0, poiseToApply: 0, effectsStr: "" });
  }

  let sanity = sanityInit;
  let totalDmg = 0;
  let totalPoise = poiseInit;
  let enemySinking = Math.min(sinkingInit, SINKING_MAX);
  let enemyRupture = Math.min(ruptureInit, RUPTURE_MAX);
  const instanceResults = [];

  for (const dmgObj of dmgValues) {
    const { value: dmg, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply, effectsStr } = dmgObj;
    const currentRes = resValues[dmgType] ?? 1.0;

    const critFromPoise = totalPoise * POISE_CRIT_BONUS_PER_STACK;
    const critMatch = effectsStr ? effectsStr.match(/\+Crit(\d+)/i) : null;
    const bonusCritRate = critMatch ? parseInt(critMatch[1]) / 100 : 0;
    const rawCritChance = critFromPoise + bonusCritRate;
    const critChance = Math.min(rawCritChance, 1);
    const poiseOverflow = Math.max(0, rawCritChance - 1);

    const didCrit = critChance >= 1 ? true : Math.random() < critChance;

    const multiplier = didCrit ? critMul : 1;
    const bonusFactor = 1 + bonusPct / 100 + (isDice ? sanityBonusPct / 100 : 0) + extraPct / 100;
    let instanceDmg = dmg * bonusFactor * multiplier * currentRes;
    if (isDice) instanceDmg *= diceMul;

    // Sinking: chỉ trừ sanity địch khi địch đang có Sinking stacks (đúng cơ chế).
    // Mỗi hit tiêu thụ 1 stack và trừ 1 sanity; cộng bonus dmg khi sanity địch ở SANITY_MIN.
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

    totalDmg += instanceDmg;

    // Apply stack mới từ đòn này sau khi đã tính dmg xong
    if (poiseToApply > 0) totalPoise = Math.min(totalPoise + poiseToApply, POISE_MAX);
    if (sinkingToApply > 0) enemySinking = Math.min(enemySinking + sinkingToApply, SINKING_MAX);
    if (ruptureToApply > 0) enemyRupture = Math.min(enemyRupture + ruptureToApply, RUPTURE_MAX);

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
        extraInfo += ` | +${r.poiseApplied} <:Poise:1513762945715142736>Poise: ${r.poiseAfterGain} → ÷${critDiv} = ${r.poiseStacksAfter} stacks`;
      } else {
        extraInfo += ` | +${r.poiseApplied} <:Poise:1513762945715142736>Poise → ${r.poiseStacksAfter} stacks`;
      }
    }
    if (r.effectsStr && /\+Crit(\d+)/i.test(r.effectsStr)) {
      const critVal = r.effectsStr.match(/\+Crit(\d+)/i)[1];
      extraInfo += ` | +Crit${critVal}%`;
    }
    if (r.isDice && diceMul !== 1) extraInfo += ` | DiceMul ${diceMul}x`;
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
    poiseDisplay = `${poiseInit} → ${finalPoiseStacks} stacks (${critCount} crit${critCount > 1 ? "s" : ""}, ÷${critDiv})`;
  } else if (poiseInit !== finalPoiseStacks) {
    poiseDisplay = `${poiseInit} → ${finalPoiseStacks} stacks (${(startingCritRate * 100).toFixed(0)}% → ${(finalCritRate * 100).toFixed(0)}% crit)`;
  } else {
    poiseDisplay = `${poiseInit} stacks (${(startingCritRate * 100).toFixed(0)}% crit)`;
  }

  const resDisplay = `B: ${resValues.B}x | P: ${resValues.P}x | S: ${resValues.S}x`;

  const allFields = [
    { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
    { name: "% Dmg Bonus", value: bonusPct.toFixed(1) + "%", inline: true, alwaysShow: true },
    { name: "Sanity % DMG Bonus", value: sanityBonusPct.toFixed(1) + "%", inline: true, showIf: sanityBonusPct !== 0 },
    { name: "CritMul", value: critMul + "x", inline: true, alwaysShow: true },
    { name: "Res Multipliers", value: resDisplay, inline: true, alwaysShow: true },
    { name: "Dice Multiplier", value: diceMul.toFixed(2) + "x", inline: true, showIf: diceMul !== 1 },
    { name: "Poise Stacks", value: poiseDisplay, inline: true, alwaysShow: true },
    { name: "Crit Divide", value: critDiv > 1 ? `÷${critDiv} per crit` : "No", inline: true, showIf: critDiv > 1 },
    { name: "Final DMG", value: totalDmg.toFixed(3), inline: false, alwaysShow: true },
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

function calcHunterMath(opts) {
  const {
    dmgBaseWeapon = 0,
    bonusPct = 0,
    statValue = 0,
    scaleSkillPct = 0,
    dmgNegationPct = 0,
    vulnerabilityPct = 0,
    buffDmgBonus = 0,
  } = opts;

  const partWeapon =
    dmgBaseWeapon * (1 + bonusPct / 100) * (1 - dmgNegationPct / 100) * (1 + vulnerabilityPct / 100) +
    (scaleSkillPct / 100) * buffDmgBonus;

  const partStat =
    statValue * (scaleSkillPct / 100) * (1 - dmgNegationPct / 100) * (1 + vulnerabilityPct / 100) +
    (scaleSkillPct / 100) * buffDmgBonus;

  const finalDmg = partWeapon + partStat;

  const allFields = [
    { name: "DmgBaseWeapon", value: dmgBaseWeapon.toString(), inline: true },
    { name: "Bonus %", value: bonusPct.toFixed(1) + "%", inline: true },
    { name: "Stat Value", value: statValue.toString(), inline: true },
    { name: "ScaleSkill %", value: scaleSkillPct.toFixed(1) + "%", inline: true },
    { name: "Boss Negation %", value: dmgNegationPct.toFixed(1) + "%", inline: true },
    { name: "Vulnerability %", value: vulnerabilityPct.toFixed(1) + "%", inline: true },
    { name: "BuffBonus", value: buffDmgBonus.toString(), inline: true },
    { name: "Final DMG", value: finalDmg.toFixed(3), inline: false },
  ];

  return {
    embeds: [{
      title: "📊 Kết quả tính DMG",
      color: 0xff6600,
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

async function buildInventoryEmbed(targetUser) {
  const data = await getPlayerData(targetUser.id);
  const books = data.books ?? {};
  const items = data.items ?? {};
  const bookEntries = Object.entries(books).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
  const itemEntries = Object.entries(items).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
  if (bookEntries.length === 0 && itemEntries.length === 0) {
    return null;
  }
  const fields = [];
  if (bookEntries.length > 0) {
    const lines = bookEntries.map(([name, count]) => `• **${name}** × ${count}`);
    const totalBooks = bookEntries.reduce((s, [, c]) => s + c, 0);
    const CHUNK = 20;
    for (let i = 0; i < lines.length; i += CHUNK) {
      fields.push({ name: i === 0 ? "📚 Sách" : "​", value: lines.slice(i, i + CHUNK).join("\n"), inline: false });
    }
    fields.push({ name: "📊 Tổng sách", value: `**${totalBooks}** cuốn`, inline: true });
  }
  if (itemEntries.length > 0) {
    const lines = itemEntries.map(([name, count]) => `• **${name}** × ${count}`);
    const totalItems = itemEntries.reduce((s, [, c]) => s + c, 0);
    const CHUNK = 20;
    for (let i = 0; i < lines.length; i += CHUNK) {
      fields.push({ name: i === 0 ? "🔩 Vật phẩm" : "​", value: lines.slice(i, i + CHUNK).join("\n"), inline: false });
    }
    fields.push({ name: "📊 Tổng vật phẩm", value: `**${totalItems}** cái`, inline: true });
  }
  return {
    embeds: [{
      title: `🎒 Inventory của ${targetUser.displayName ?? targetUser.username}`,
      color: 0xf0a500,
      fields,
    }],
  };
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
  const senderData = isAdmin ? null : await getPlayerData(senderId);
  const recipientData = await getPlayerData(targetId);
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

  if (gradeTarget !== null) {
    const expNeeded = calcExpForGrade(gradeTarget);
    recipientData.exp = expNeeded;
    changes.push(`Grade set → **Grade ${gradeTarget}** (EXP set thành **${expNeeded}**)`);
  } else if (expGain !== 0) {
    recipientData.exp = clampExp((recipientData.exp ?? 0) + expGain);
    changes.push(`${expGain > 0 ? "+" : ""}${expGain} EXP → tổng **${recipientData.exp}**/${EXP_MAX}`);
  }
  if (ahnGain !== 0) {
    recipientData.ahn = (recipientData.ahn ?? 0) + ahnGain;
    changes.push(`${ahnGain > 0 ? "+" : ""}${formatNumber(ahnGain)} Ahn`);
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

  const saveEntries = [{ userId: targetId, data: recipientData }];
  if (!isAdmin) saveEntries.push({ userId: senderId, data: senderData });
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
  const data = await getPlayerData(targetId);
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

  await savePlayerData(targetId, data);
  return changes;
}

/**
 * executeCraft — logic craft dùng chung cho prefix -use và slash /use
 * Phải được gọi bên trong withLock của userId.
 * @returns {Promise<{ outputLines: string[], costLines: string[] }>}
 */
async function executeCraft(userId, itemName, craftCount) {
  const recipe = CRAFT_RECIPES[itemName];
  const data = await getPlayerData(userId);
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
  await savePlayerData(userId, data);
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



// ─── SKILL DATA ───────────────────────────────────────────────────────────────
const D1 = "<:Dice1:1508173590078558369>";
const D2 = "<:Dice2:1508173623691710625>";
const D3 = "<:Dice3:1508173643518050395>";
const D4 = "<:Dice4:1508176464367845600>";
const D5 = "<:Dice5:1508176500438990968>";

function r(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const SKILLS = {
  "fare-thee well": {
    name: "Fare-Thee Well",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "0.8x",
    roll() {
      const d1 = r(6,7), d2 = r(7,8), d3 = r(10,15);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Bleed:1513762688226955285>Bleed ở turn kế và nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Bleed:1513762688226955285>Bleed ở turn kế và nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D3} *Nếu bản thân có trên 10 <:Poise:1513762945715142736>Poise, Dice 3 nhận 5 <:DiceUp:1513767795681398894>Dice Up*`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — gây 4 <:Bleed:1513762688226955285>Bleed ở turn kế và nhận 4 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "purify": {
    name: "Purify",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,16), d2 = r(8,12), d3 = r(12,16);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — gây 2 <:Nails:1513768423124111482>Nails`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — gây 2 <:Nails:1513768423124111482>Nails`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — gây 3 <:Nails:1513768423124111482>Nails và 1 <:Paralyze:1513763316479295548>Paralyze`,
        `${D3} Gây 1 <:Gaze:1513768454967001179>Gaze — nếu địch có trên 7 <:Nails:1513768423124111482>Nails sẽ mất toàn bộ stack vượt quá 7`,
      ];
    },
  },
  "kicking": {
    name: "Kicking",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,6), d3 = r(6,7);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế; nếu ở **Middle Syndicate** thêm 2 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },
  "just a vengeance": {
    name: "Just A Vengeance",
    cost: "4 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(4,6), d3 = r(5,7), d4 = r(12,16);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bind:1513768025881317457>Bind`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [AOE 2 người] — gây 3 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },
  "extract fuel": {
    name: "Extract Fuel",
    cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,12);
      let heal = d1 === 7 ? "hồi 10 HP" : d1 === 12 ? "hồi 20 HP" : "hồi 15 HP";
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — hồi lại 2 <:Light:1513786082502770719>Light (${heal})`,
      ];
    },
  },
  "stamp of vengeance": {
    name: "Stamp of Vengeance",
    cost: "4 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(16,24);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] [AOE 3 người] — gây 5 <:Bleed:1513762688226955285>Bleed ở turn kế, 2 <:Bind:1513768025881317457>Bind và nhận 2 **Middle Nursefather Tattoos** với mỗi địch đánh trúng`,
      ];
    },
  },
  "complete and total extermination": {
    name: "Complete and Total Extermination",
    cost: "5 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,25);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Undodgeable] — gây 4 <:Paralyze:1513763316479295548>Paralyze, <:TremorBurst:1513802464632246352>Tremor Burst, 10 <:Fragile:1513763336167100536>Fragile và 2 <:VengeanceMark:1513768136023740436>Vengeance Mark`,
      ];
    },
  },
  "following the flow": {
    name: "Following the Flow",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(7,9), d3 = r(8,10);
      return [
        `${D1} *Nếu địch có ≥4 <:Bind:1513768025881317457>Bind, mọi Dice của skill này add thêm 1 <:Burn:1513762753691652177>Burn*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 2 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Burn:1513762753691652177>Burn và 2 <:Bind:1513768025881317457>Bind`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "silence": {
    name: "Silence",
    cost: "5 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(5,7), d3 = r(7,10), d4 = r(8,12);
      return [
        `${D1} *Khi dùng: +1 <:DiceUp:1513767795681398894>Dice Up turn này và sau ứng với mỗi nhánh Skill Tree Wrath đã kích hoạt [Max: 4]*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — gây 3 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Burn:1513762753691652177>Burn`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Bind:1513768025881317457>Bind và +1 <:Burn:1513762753691652177>Burn ứng với mỗi <:Bind:1513768025881317457>Bind trên địch`,
      ];
    },
  },
  "waltz in black": {
    name: "Waltz In Black",
    cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,14);
      return [
        `${D1} *Nếu turn trước địch dính Waltz In White: skill này thành 3x Dice Multiplier và [Unevadeable]*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break]`,
      ];
    },
  },
  "waltz in white": {
    name: "Waltz In White",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(13,24);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unevadeable] [Unblockable]`,
      ];
    },
  },
  "light attack": {
    name: "Light Attack",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unparriable] [Unblockable] — hồi 2 <:Light:1513786082502770719>Light sau khi trúng`,
      ];
    },
  },
  "slash series": {
    name: "Slash Series",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(3,5), d3 = r(5,7);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — nhận 2 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "execute prescript": {
    name: "Execute Prescript",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(4,8);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Rupture:1513762812722155682>Rupture; nếu trong Index Syndicate & Deck Singleton thì +4 <:DiceUp:1513767795681398894>Dice Up`,
      ];
    },
  },
  "will of the city": {
    name: "Will of The City",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — hồi 1 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "dodge and strike": {
    name: "Dodge and Strike",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,16);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash]`,
      ];
    },
  },
  "soulburn": {
    name: "Soulburn",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "2x",
    roll() {
      const d1 = r(3,6), d2 = r(3,6), d3 = r(5,9);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 4 <:Burn:1513762753691652177>Burn và 1 <:Fragile:1513763336167100536>Fragile ở turn kế`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 6 <:Burn:1513762753691652177>Burn và 2 <:Fragile:1513763336167100536>Fragile ở turn kế`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 10 <:Burn:1513762753691652177>Burn và 2 <:Fragile:1513763336167100536>Fragile ở turn kế`,
      ];
    },
  },
  "inferno burst": {
    name: "Inferno Burst",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(9,12), d2 = r(11,13);
      return [
        `${D1} *Nếu địch có trên 10 Burn: tăng lượng <:Burn:1513762753691652177>Burn mỗi Hit thêm 3 <:Burn:1513762753691652177>Burn*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Burn:1513762753691652177>Burn và kích Burning Sensation`,
      ];
    },
  },
  "take this kid": {
    name: "Take this, Kid",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,16), d2 = r(16,24);
      return [
        `${D1} *Nếu địch có Bleed: gắn 1 <:Hemorrhage:1513762688226955285>Hemorrhage*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Bleed:1513762688226955285>Bleed ở turn kế`,
      ];
    },
  },
  "learn again kid": {
    name: "Learn again, Kid",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(8,12), d2 = r(8,12), d3 = r(10,14), d4 = r(14,20);
      return [
        `${D1} *Nếu địch có <:Bleed:1513762688226955285>Bleed: gắn 1 <:Hemorrhage:1513762688226955285>Hemorrhage*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Bleed:1513762688226955285>Bleed ở turn kế`,
      ];
    },
  },
  "catch breath": {
    name: "Catch Breath",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,15);
      return [
        `${D1} *Khi dưới 50% HP: <:Dice1:1508173590078558369>Dice 1 nhận 4 <:DiceUp:1513767795681398894>Dice Up*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — nhận 6 <:Poise:1513762945715142736>Poise; khi dưới 50% HP thêm 2 <:Poise:1513762945715142736>Poise và 4 <:Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "onrush": {
    name: "Onrush",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,26);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 1 <:Imitation:1513769425063514173>Imitation, giảm 40 Stamina địch`,
        `${D1} *Nếu bản thân có ≥6 <:Light:1513786082502770719>Light: dùng thêm 3 <:Light:1513786082502770719>Light để reuse đòn này*`,
      ];
    },
  },
  "overthrow": {
    name: "Overthrow",
    cost: "5 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,4), d2 = r(2,4), d3 = r(5,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:Poise:1513762945715142736>Poise; nếu có trên 5 <:Poise:1513762945715142736>Poise thêm 2 <:DiceUp:1513767795681398894>Dice Up`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D3} *Nếu có ≥5 <:Poise:1513762945715142736>Poise: chuyển 5 <:Poise:1513762945715142736>Poise → 8 <:DiceUp:1513767795681398894>Dice Up cho Dice 3; nếu kết liễu được địch thêm 3 <:DiceUp:1513767795681398894>Dice Up turn sau*`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unparriable] [Guard Break] — gây 10 <:Bleed:1513762688226955285>Bleed ở turn kế, 5 <:Paralyze:1513763316479295548>Paralyze, nhận 5 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "shadowcloud shattercleaver": {
    name: "Shadowcloud Shattercleaver",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,5), d2 = r(2,5), d3 = r(8,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:DefenseUp:1513767487894716497>Defense Up; nếu địch có trên 6 <:Bleed:1513762688226955285>Bleed thêm 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — gây 5 <:Bleed:1513762688226955285>Bleed ở turn kế`,
      ];
    },
  },
  "punting": {
    name: "Punting",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,6);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:Poise:1513762945715142736>Poise và 1 **Middle Nursefather Tattoos**`,
      ];
    },
  },
  "punching": {
    name: "Punching",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(5,7), d3 = r(6,8);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Paralyze:1513763316479295548>Paralyze nếu ở trong **Middle Syndicate**`,
      ];
    },
  },
  "furioso": {
    name: "Furioso",
    cost: "A Prayer For Loving Sorrow", cd: "—", diceMul: "2.5x",
    roll() {
      const d1=r(12,21), d2=r(11,20), d3=r(16,25), d4=r(15,21),
            d5=r(17,26), d6=r(14,23), d7=r(17,26), d8=r(29,38), d9=r(17,26);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 2 <:Tremor:1513762737388257380>Tremor`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 1 <:Rupture:1513762812722155682>Rupture`,
        `${D5} **${d5}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `Dice 6: **${d6}** [50% <:Slash:1513768633434640517>Slash/50% <:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 4 <:Fragile:1513763336167100536>Fragile, <:TremorBurst:1513802464632246352>Tremor Burst`,
        `Dice 7: **${d7}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 10 <:Tremor:1513762737388257380>Tremor`,
        `Dice 8: **${d8}** [50% <:Slash:1513768633434640517>Slash/50% <:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `Dice 9: **${d9}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 1 <:Rupture:1513762812722155682>Rupture *trước* khi gây Dmg`,
      ];
    },
  },

// NEW SKILLS BLOCK - insert before closing }; of SKILLS

  // ── <:Sinking:1513762793436741652>Sinking skills ──
  "weight of knowledge": {
    name: "Weight of Knowledge", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,4),d2=r(3,5),d3=r(3,5),d4=r(3,6);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice4:1508176464367845600> *Nếu địch có trên 8 <:Sinking:1513762793436741652>Sinking: nhận 15 **Shield HP***`,
      ];
    },
  },
  "illuminate thy vacuity": {
    name: "Illuminate Thy Vacuity", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,4),d2=r(2,4),d3=r(2,4),d4=r(2,4),d5=r(3,6);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice5:1508176500438990968> **${d5}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 2 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice5:1508176500438990968> *Nếu địch có trên 6 <:Sinking:1513762793436741652>Sinking: nhận 25 **Shield HP***`,
      ];
    },
  },
  "studious dedication": {
    name: "Studious Dedication", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(5,8),d2=r(5,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "scorch knowledge": {
    name: "Scorch Knowledge", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,4),d2=r(4,8),d3=r(13,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 5 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "excruciating study": {
    name: "Excruciating Study", cost: "—", cd: "2 Turn", diceMul: "0.5x",
    roll() {
      const d1=r(4,7),d2=r(4,7),d3=r(7,10),d4=r(10,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt]`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },

  // ── <:Bleed:1513762688226955285>Bleed skills ──
  "sanguine painting": {
    name: "Sanguine Painting", cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "0.66x",
    roll() {
      const rolls = [r(4,9), r(4,9)];
      const lines = [
        `*Chém 2 nhát, mỗi nhát gây 2 <:Bleed:1513762688226955285>Bleed*`,
        `<:Dice1:1508173590078558369> Nhát 1: **${rolls[0]}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice2:1508173623691710625> Nhát 2: **${rolls[1]}** [<:Pierce:1513768511179329556>Pierce]`,
      ];
      // Nếu địch trên 6 Bleed: thêm 2 lần với +5 dice
      const bonus1=r(9,14), bonus2=r(9,14);
      lines.push(`*Nếu địch có trên 6 <:Bleed:1513762688226955285>Bleed: thêm 2 nhát với +5 Dice, mỗi nhát gây 2 <:Bleed:1513762688226955285>Bleed*`);
      lines.push(`<:Dice1:1508173590078558369> Nhát bonus 1: **${bonus1}** [<:Pierce:1513768511179329556>Pierce]`);
      lines.push(`<:Dice2:1508173623691710625> Nhát bonus 2: **${bonus2}** [<:Pierce:1513768511179329556>Pierce]`);
      return lines;
    },
  },
  "hematic coloring": {
    name: "Hematic Coloring", cost: "5 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "(1~4): 0.5x / (5): 1x",
    roll() {
      const EFFECTS = [
        `<:Burn:1513762753691652177>Burn`, `<:Tremor:1513762737388257380>Tremor`,
        `<:Rupture:1513762812722155682>Rupture`, `<:Sinking:1513762793436741652>Sinking`, `<:Bleed:1513762688226955285>Bleed`
      ];
      function pickEffects() {
        const pool = [...EFFECTS];
        const picked = [];
        for (let i = 0; i < 3; i++) {
          const idx = Math.floor(Math.random() * pool.length);
          picked.push(pool.splice(idx, 1)[0]);
        }
        return picked.join(" ");
      }
      const ranges = [[3,6],[6,9],[9,12],[12,15],[15,18]];
      const diceEmoji = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,
        `<:Dice3:1508173643518050395>`,`<:Dice4:1508176464367845600>`,`<:Dice5:1508176500438990968>`
      ];
      const lines = [`*Dice 1~4: mỗi lần gây 3 Effects ngẫu nhiên. Dice 5: đòn kết thúc 1x*`];
      for (let i = 0; i < 5; i++) {
        const val = r(ranges[i][0], ranges[i][1]);
        if (i < 4) {
          lines.push(`${diceEmoji[i]} **${val}** [<:Pierce:1513768511179329556>Pierce] — ${pickEffects()}`);
        } else {
          lines.push(`${diceEmoji[i]} **${val}** [<:Pierce:1513768511179329556>Pierce] *(đòn kết thúc)*`);
        }
      }
      return lines;
    },
  },
  "sanguine pointilism": {
    name: "Sanguine Pointilism", cost: "—", cd: "2 Turn", diceMul: "1x",
    needsReuse: true,
    promptArg: {
      label: "% Reuse",
      parse: (s) => parseInt(s, 10),
      validate: (v) => !isNaN(v) && v >= 0 && v <= 100,
      errorMsg:
        "❓ **Sanguine Pointilism** cần nhập % Reuse.\n" +
        "> Cú pháp: `-skill sanguine pointilism <% reuse>`\n" +
        "> VD: `-skill sanguine pointilism 60` (mặc định 40%, +20% mỗi 5 Bleed trên địch)",
      buildHeader: (v, s) => `[Reuse: ${v}%] [CD: ${s.cd}] [Dice Mul: ${s.diceMul}]`,
    },
    roll(reusePct = 40) {
      const D1 = `<:Dice1:1508173590078558369>`;
      const D2 = `<:Dice2:1508173623691710625>`;
      const D3 = `<:Dice3:1508173643518050395>`;
      const REUSE_EMOJIS = [D2, D3, `<:Dice4:1508176464367845600>`];
      const d1 = 14;
      const lines = [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed 2 <:Burn:1513762753691652177>Burn 2 <:Tremor:1513762737388257380>Tremor 2 <:Sinking:1513762793436741652>Sinking 2 <:Rupture:1513762812722155682>Rupture`,
      ];
      for (let i = 1; i <= 2; i++) {
        const triggered = Math.random() * 100 < reusePct;
        const dEmoji = REUSE_EMOJIS[i - 1] ?? REUSE_EMOJIS[REUSE_EMOJIS.length - 1];
        if (triggered) {
          lines.push(`${dEmoji} ↩️ Reuse ${i} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed 2 <:Burn:1513762753691652177>Burn 2 <:Tremor:1513762737388257380>Tremor 2 <:Sinking:1513762793436741652>Sinking 2 <:Rupture:1513762812722155682>Rupture *(${reusePct}% → ✅)*`);
        } else {
          lines.push(`${dEmoji} ↩️ Reuse ${i} dừng tại đây *(${reusePct}% → ❌)*`);
          break;
        }
      }
      return lines;
    },
  },

  // ── <:Burn:1513762753691652177>Burn skills ──
  "perfected death fist": {
    name: "Perfected Death Fist", cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,6),d2=r(6,9),d3=r(9,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> *Nếu địch có trên 8 <:Burn:1513762753691652177>Burn: gắn thêm 3 <:Burn:1513762753691652177>Burn*`,
        `<:Dice3:1508173643518050395> *Nếu địch có trên 6 <:Burn:1513762753691652177>Burn: +5 <:DiceUp:1513767795681398894>Dice Up cho bản thân*`,
      ];
    },
  },
  "raging storm": {
    name: "Raging Storm", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(5,9),d2=r(10,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — gây 4 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — gây 8 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "fiery waltz": {
    name: "Fiery Waltz", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(9,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 5 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "red kick": {
    name: "Red Kick", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,5),d2=r(8,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> *Tấn công cộng thêm (số <:Burn:1513762753691652177>Burn trên địch ÷ 3) dice*`,
      ];
    },
  },
  "flowing flame": {
    name: "Flowing Flame", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(8,14);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gắn 4 <:Burn:1513762753691652177>Burn`,
        `<:Dice1:1508173590078558369> *Trên 30 Sanity: gắn 6 <:Burn:1513762753691652177>Burn | Trên 45 Sanity: gắn 8 <:Burn:1513762753691652177>Burn*`,
      ];
    },
  },
  "fleet edge": {
    name: "Fleet Edge", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,6),d2=r(4,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> *Nếu địch có trên 10 <:Burn:1513762753691652177>Burn: gắn thêm 3 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>*`,
      ];
    },
  },
  "flow of the sword": {
    name: "Flow of the Sword", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,5),d2=r(6,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "violent flame": {
    name: "Violent Flame", cost: "—", cd: "2 Turn", diceMul: "1x",
    weaponOf: "Liu Martial Arts",
    roll() {
      const d1=r(5,8),d2=r(6,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 6 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "forming storm": {
    name: "Forming Storm", cost: "—", cd: "2 Turn", diceMul: "1x",
    weaponOf: "Liu Guan Dao",
    roll() {
      const d1=r(12,20);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Guard Break] [Đánh lan 3 mục tiêu] — gắn 5 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },

  // ── <:Poise:1513762945715142736>Poise / <:Bleed:1513762688226955285>Bleed mixed ──
  "extreme edge": {
    name: "Extreme Edge", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const normal=r(7,8), air=r(4,7), low=r(17,30);
      return [
        `**Mặt đất:** **${normal}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Knockback] — gây 5 <:Bleed:1513762688226955285>Bleed và 2 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
        `**Trên không:** **${air}** [<:Slash:1513768633434640517>Slash] — gây 5 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
        `**Dưới 33% HP:** **${low}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Undodgeable] [AOE] — gây 8 <:Bleed:1513762688226955285>Bleed và 5 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
      ];
    },
  },
  "flying sword": {
    name: "Flying Sword", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(4,8),d2=r(3,9),dAir=r(6,12);
      return [
        `*Nhận 6 <:Poise:1513762945715142736>Poise*`,
        `**Mặt đất:**`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `**Trên không:** *Nhận 6 <:Poise:1513762945715142736>Poise*`,
        `<:Dice1:1508173590078558369> **${dAir}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Uptilt] — gây 5 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
      ];
    },
  },
  "boundary of death": {
    name: "Boundary of Death", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const roll4 = r(1,4);
      if (roll4 === 4) {
        const dmg = r(47,57);
        return [
          `🎯 Roll: **4** → Dice chuyển thành **[47~57]**!`,
          `**${dmg}** True Damage — nhận lại 4 <:Light:1513786082502770719>Light`,
        ];
      } else {
        return [
          `Roll: **${roll4}** → **${roll4}** True Damage`,
          `*(Roll đúng 4 để kích hoạt dạng mạnh)*`,
        ];
      }
    },
  },
  "overbreath": {
    name: "Overbreath", cost: "—", cd: "2 Turn", diceMul: "1x",
    weaponOf: "Shi Association Katana",
    roll() {
      const d1=r(12,28);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 6 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },

  // ── Misc skills ──
  "xuất lực tối đa": {
    name: "Xuất Lực Tối Đa", cost: "1 <:Light:1513786082502770719>Light + 20 Cursed Energy", cd: "0 Turn", diceMul: "1x",
    needsBlackFlash: true,
    promptArg: {
      label: "% Hắc Thiểm",
      parse: (s) => parseFloat(s),
      validate: (v) => !isNaN(v) && v >= 0 && v <= 100,
      errorMsg:
        "❓ **Xuất Lực Tối Đa** có thể nhập % Hắc Thiểm (mặc định 5%).\n" +
        "> Cú pháp: `-skill xuất lực tối đa [%]`\n" +
        "> VD: `-skill xltd` | `-skill xltd 20` | `-skill xltd 0.5`",
      buildHeader: (v, s) => `[${s.cost}] [CD: ${s.cd}] [Hắc Thiểm: ${v}%]`,
    },
    embedColor: 0x1a1a2e,
    roll(blackFlashPct = 5) {
      const d1=r(13,17);
      const isBlackFlash = Math.random() * 100 < blackFlashPct;
      if (isBlackFlash) {
        return [
          `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break]`,
          `⚫ **HẮC THIỂM!** Dice Multiplier → **2.5x** *(tỷ lệ: ${blackFlashPct}%)*`,
        ];
      }
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break]`,
        `*(${blackFlashPct}% HẮC Thiểm → không kích hoạt)*`,
      ];
    },
  },
  "level slash": {
    name: "Level Slash", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(8,10),d2=r(9,11);
      return [
        `*Khi trong E.G.O mà kết liễu địch: nhận 5 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 1 <:Imitation:1513769425063514173>Imitation`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 1 <:Imitation:1513769425063514173>Imitation`,
      ];
    },
  },
  "spear": {
    name: "Spear", cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1=r(4,5),d2=r(5,6),d3=r(6,7);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 1 <:Imitation:1513769425063514173>Imitation`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 1 <:Imitation:1513769425063514173>Imitation`,
      ];
    },
  },
  "focus spirit": {
    name: "Focus Spirit", cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1=r(10,20);
      const turns = d1 === 20 ? 3 : d1 >= 15 ? 2 : 1;
      return [
        `<:Dice1:1508173590078558369> **${d1}** [không bị ảnh hưởng bởi buff dice]`,
        `→ Nhận 2 <:DiceUp:1513767795681398894>Dice Up tồn tại **${turns} Turn**`,
      ];
    },
  },

  // ── Weapon criticals ──
  "upstanding slash": {
    name: "Upstanding Slash", cost: "—", cd: "2 Turn", diceMul: "1x",
    weaponOf: "Mimicry Blade",
    roll() {
      const d1=r(6,10),d2=r(9,15);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế và nhận 1 <:Imitation:1513769425063514173>Imitation`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế và nhận 1 <:Imitation:1513769425063514173>Imitation`,
      ];
    },
  },
  "great split vertical": {
    name: "Great Split: Vertical", cost: "5 <:Imitation:1513769425063514173>Imitation", cd: "—", diceMul: "2x",
    weaponOf: "Mimicry Blade",
    roll() {
      const d1=r(15,26);
      return [
        `*Tiêu thụ 5 <:Imitation:1513769425063514173>Imitation*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable]`,
      ];
    },
  },
  "great split horizontal": {
    name: "Great Split: Horizontal", cost: "5 <:Imitation:1513769425063514173>Imitation + dưới 30% HP", cd: "—", diceMul: "3x",
    weaponOf: "Mimicry Blade",
    roll() {
      const d1=r(32,43);
      return [
        `*Tiêu thụ 5 <:Imitation:1513769425063514173>Imitation | Yêu cầu dưới 30% HP*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Undodgeable]`,
      ];
    },
  },
  "dimensional rift dagger": {
    name: "Dimensional Rift", cost: "—", cd: "2 Turn", diceMul: "1x",
    weaponOf: "WARP Corp. Dagger",
    roll() {
      const hasCharge = Math.random() < 0.5; // placeholder
      const dNormal=r(6,12), dCharged=r(16,24);
      return [
        `*Tiêu thụ 15 <:Charge:1513762867558613033>Charge nếu đủ → đổi Dice 1 thành [16~24] và gây 6 <:Rupture:1513762812722155682>Rupture*`,
        `<:Dice1:1508173590078558369> **${dNormal}** [<:Pierce:1513768511179329556>Pierce] *(thường)* / **${dCharged}** [<:Pierce:1513768511179329556>Pierce] *(có 15 Charge)* — gây 3 <:Rupture:1513762812722155682>Rupture và nhận 4 <:Charge:1513762867558613033>Charge`,
      ];
    },
  },
  "dimensional rift gauntlets": {
    name: "Dimensional Rift", cost: "—", cd: "2 Turn", diceMul: "1x",
    weaponOf: "WARP Corp. Gauntlets",
    roll() {
      const d1=r(12,16);
      return [
        `*Khi ≥15 <:Charge:1513762867558613033>Charge: +5 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture và nhận 3 <:Charge:1513762867558613033>Charge`,
      ];
    },
  },
  "sharp cuts": {
    name: "Sharp Cuts", cost: "—", cd: "2 Turn", diceMul: "1x",
    weaponOf: "Blade Lineage Hwando",
    roll() {
      const d1=r(4,8),d2=r(4,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },

  // ── Charge skills ──
  "charge shield": {
    name: "Charge Shield", cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1=r(5,15);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 2 <:Rupture:1513762812722155682>Rupture, nhận 5 <:ChargeBarrier:1513768302973812887> Charge Barrier`,
        `*Nếu ≥10 <:Charge:1513762867558613033>Charge: tiêu thụ toàn bộ Charge → đổi thành Shield HP tương đương*`,
      ];
    },
  },
  "leap": {
    name: "Leap", cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1=r(4,8),d2=r(8,12),d3=r(12,16);
      return [
        `*Nếu ≥10 <:Charge:1513762867558613033>Charge: +5 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — nhận 3 <:Charge:1513762867558613033>Charge và gây 2 <:Fragile:1513763336167100536>Fragile`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — nhận 3 <:Charge:1513762867558613033>Charge và gây 2 <:Fragile:1513763336167100536>Fragile`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 4 <:Fragile:1513763336167100536>Fragile`,
      ];
    },
  },
  "overcharged ripple": {
    name: "Overcharged Ripple", cost: "4 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(5,7),d2=r(6,8),d3=r(7,9),d4=r(8,10);
      return [
        `*Nếu ≥10 <:Charge:1513762867558613033>Charge: Dice Multiplier → 1.5x*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — nhận 1 <:Charge:1513762867558613033>Charge`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — nhận 1 <:Charge:1513762867558613033>Charge`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — nhận 1 <:Charge:1513762867558613033>Charge`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — nhận 4 <:Charge:1513762867558613033>Charge`,
      ];
    },
  },

  // ── <:Poise:1513762945715142736>Poise (Blade Lineage) ──
  "moon-splitting draw": {
    name: "Moon-Splitting Draw", cost: "4 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1=r(15,25);
      return [
        `*Nếu bản thân có trên 15 <:Poise:1513762945715142736>Poise: +5 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — gây 3 <:Paralyze:1513763316479295548>Paralyze, nhận 5 <:Poise:1513762945715142736>Poise, mất 5 HP và nhận 3 <:Light:1513786082502770719>Light`,
        `*Nếu địch parry thành công hay không dính dmg: không hồi <:Light:1513786082502770719>Light*`,
      ];
    },
  },
  "red plum blossom scatter": {
    name: "Red Plum Blossom Scatter", cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1.6x",
    roll() {
      const d1=r(5,12),d2=r(4,7);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 2 <:Red_Plum_Blossom:1513768345521094668> và nhận <:DiceUp:1513767795681398894>Dice Up bằng (Poise ÷ 3)`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] [Undodgeable] — gây 4 <:Red_Plum_Blossom:1513768345521094668>`,
      ];
    },
  },
  "yield my flesh": {
    name: "Yield My Flesh", cost: "2 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,6),d2=r(6,12);
      return [
        `*Skill đặc biệt của Blade Lineage — yêu cầu Outfit Blade Lineage*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — Né 4 đòn đánh thường hoặc clash`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — Nếu địch không đánh để né/clash: chém và nhận 2 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "to claim their bones": {
    name: "To Claim Their Bones", cost: "0 <:Light:1513786082502770719>Light", cd: "Khi Yield My Flesh kích hoạt", diceMul: "1x",
    roll() {
      const d1=r(3,4),d2=r(4,5),d3=r(5,6),d4=r(6,7);
      return [
        `*[Unblockable] — Chỉ dùng được sau khi Yield My Flesh phản công hoặc clash thua*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed và 5 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },


  // ── <:Rupture:1513762812722155682>Rupture (Seven Association) ──
  "dissect target": {
    name: "Dissect Target",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(4,6), d3 = r(5,7);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 3 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "swash": {
    name: "Swash",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(6,9), d3 = r(9,11);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 5 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 6 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "profiling": {
    name: "Profiling",
    cost: "4 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,10), d2 = r(7,11), d3 = r(13,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },

  // ── Protection (Udjat) ──
  "sand split": {
    name: "Sand Split",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,13), d2 = r(7,9);
      return [
        `<:Dice1:1508173590078558369> *Nếu có ≥4 Protection: nhận 3 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 2 Protection`,
      ];
    },
  },
  "furusiyya": {
    name: "Furūsiyya",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — ngắt 4 đòn đánh thường của địch, nhận 2 Protection`,
      ];
    },
  },
  "jamadhar": {
    name: "Jamadhar",
    cost: "4 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,9), d2 = r(7,8), d3 = r(5,9), d4 = r(8,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 1 Protection`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 1 Protection`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 1 Protection; nếu có ≥5 Protection dùng tiếp Dice 4`,
        `<:Dice4:1508176464367845600> **${d4}** [Guard Break]`,
      ];
    },
  },
  "mirage incision": {
    name: "Mirage Incision",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,4), d2 = r(2,6), d3 = r(2,6), d4 = r(7,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — nhận 1 Protection và gây 1 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice4:1508176464367845600> **${d4}** [Guard Break]`,
      ];
    },
  },
  "khopesh swordplay": {
    name: "Khopesh Swordplay",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,15), d2 = r(4,6);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 2 <:Tremor:1513762737388257380>Tremor (nếu có ≥5 Protection: gây 5 <:Tremor:1513762737388257380>Tremor)`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] — nhận Protection = (Tremor+1)÷6 [Max: 3]`,
      ];
    },
  },

  // ── Defense (Zwei) ──
  "blade whirl": {
    name: "Blade Whirl",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "0.5x",
    roll() {
      const d1 = r(4,7), d2 = r(4,8), d3 = r(4,9), d4 = r(9,14);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — gây 5 <:DefenseDown:1513767463337066576>Defense Down; nếu có trên 10 <:DefenseUp:1513767487894716497>Defense Up: nhận 10 Protection`,
      ];
    },
  },
  "client protection": {
    name: "Client Protection",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,8), d3 = r(5,9);
      return [
        `*Nếu có trên 10 <:DefenseUp:1513767487894716497>Defense Up: +3 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 6 <:DefenseDown:1513767463337066576>Defense Down`,
      ];
    },
  },
  "standoff": {
    name: "Standoff",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,10), d2 = r(4,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — nhận 3 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice2:1508173590078558369> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận 3 <:DefenseUp:1513767487894716497>Defense Up`,
      ];
    },
  },
  "law and order": {
    name: "Law and Order",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,9), d3 = r(8,14);
      return [
        `*Chặn 4 đòn đánh thường của địch — nhận 5 <:DefenseUp:1513767487894716497>Defense Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
      ];
    },
  },

  // ── <:Tremor:1513762737388257380>Tremor (Augury) ──
  "augury crusher": {
    name: "Augury Crusher",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "0.75x",
    roll() {
      const d1 = r(7,16), d2 = r(7,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE 4 người] — dập chân gây rung chấn, đẩy địch về phía sau`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [AOE 4 người] — vô số cột sát, mỗi lần trúng gây 5 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "augury infusion": {
    name: "Augury Infusion",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(13,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "augury kick": {
    name: "Augury Kick",
    cost: "4 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,9), d2 = r(18,26);
      const hasDiceUp = d2 > 20;
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — đá địch lên trời, gây 14 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unparriable] [Undodgeable] — đá xuống, gây <:TremorBurst:1513802464632246352>Tremor Burst`,
        hasDiceUp ? `✨ Trên 20 Tremor: nhận 2 <:DiceUp:1513767795681398894>Dice Up cho 2 Turn kế tiếp` : `*(Cần trên 20 <:Tremor:1513762737388257380>Tremor để nhận <:DiceUp:1513767795681398894>Dice Up)*`,
      ];
    },
  },
  "celestial sight": {
    name: "Celestial Sight",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — né 4 đòn thường của địch, phản công gây 6 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },

  // ── <:Tremor:1513762737388257380>Tremor (L'Heure du Loup) ──
  "lupine onslaught": {
    name: "Lupine Onslaught",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(3,6), d3 = r(4,7), d4 = r(4,8);
      return [
        `*Nếu địch có trên 5 <:Tremor:1513762737388257380>Tremor: **[Uptilt]***`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [On Hit] — gây 1 <:Paralyze:1513763316479295548>Paralyze`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [On Hit] — gây 1 <:Paralyze:1513763316479295548>Paralyze`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [On Hit] — gây 1 <:Paralyze:1513763316479295548>Paralyze`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [On Hit] — gây 1 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },
  "kick and stomps": {
    name: "Kick And Stomps",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,10), d2 = r(6,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Paralyze:1513763316479295548>Paralyze`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 2 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "rapacious assault": {
    name: "Rapacious Assault",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,9), d2 = r(10,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Paralyze:1513763316479295548>Paralyze và 3 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Uptilt] — gây 1 <:Paralyze:1513763316479295548>Paralyze và 3 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "pitch-black pulverizer": {
    name: "Pitch-Black Pulverizer",
    cost: "5 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,27);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] — lao vào địch, gây 4 lần sát thương cùng 5 <:Tremor:1513762737388257380>Tremor mỗi lần (không re-roll)`,
        `→ Đòn cuối gây <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },

  // ── <:Bleed:1513762688226955285>Bleed (Kurokumo) ──
  "cloud cutter": {
    name: "Cloud Cutter",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(1,5), d2 = r(1,5);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
        `*Reuse 1 lần nếu bản thân đang có trên 2 <:Light:1513786082502770719>Light*`,
      ];
    },
  },
  "sky clearing cut": {
    name: "Sky Clearing Cut",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(5,9), d3 = r(6,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed; nếu địch có trên 10 <:Bleed:1513762688226955285>Bleed: dmg ×1.3`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed; nếu địch có trên 10 <:Bleed:1513762688226955285>Bleed: dmg ×1.3`,
      ];
    },
  },
  "dark cloud cleaver": {
    name: "Dark Cloud Cleaver",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(7,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 4 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "sober up": {
    name: "Sober Up",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,7);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 6 <:Bleed:1513762688226955285>Bleed turn kế`,
      ];
    },
  },
  "shadowcloud kick": {
    name: "Shadowcloud Kick",
    cost: "1 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(6,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed; nếu địch có trên 7 <:Bleed:1513762688226955285>Bleed: nhận 3 <:DiceUp:1513767795681398894>Dice Up`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash]; nếu địch có trên 7 <:Bleed:1513762688226955285>Bleed: địch nhận 2 <:DiceDown:1513767826257874964>Dice Down`,
      ];
    },
  },
  "silent mist": {
    name: "Silent Mist",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 4 <:Bleed:1513762688226955285>Bleed và nhận 3 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },

  // ── Rupture/Nails (Smiling Faces) ──
  "somber procuration": {
    name: "Somber Procuration",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(4,6), d3 = r(2,4);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice3:1508173643518050395> **${d3}** — đạp địch ra xa, gây 5 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "trash disposal": {
    name: "Trash Disposal",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const MAX_REUSE = 6;
      const DICE_EMOJIS = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,`<:Dice3:1508173643518050395>`,
        `<:Dice4:1508176464367845600>`,`<:Dice5:1508176500438990968>`,
        `<:Dice5:1508176500438990968>`,`<:Dice5:1508176500438990968>`,
      ];
      const lines = [];
      let stopped = false;
      for (let i = 0; i <= MAX_REUSE; i++) {
        const val = r(4,6);
        const isMin = val === 4;
        const dEmoji = DICE_EMOJIS[i] ?? DICE_EMOJIS[DICE_EMOJIS.length - 1];
        const label = i === 0 ? "" : ` ↩️ Reuse ${i}`;
        if (i === 0) {
          lines.push(`${dEmoji}${label} **${val}** [<:Slash:1513768633434640517>Slash] — đâm vào địch, gắn 5 <:Fragile:1513763336167100536>Fragile${isMin ? " *(Min — dừng)*" : ""}`);
        } else {
          lines.push(`${dEmoji}${label} **${val}** [<:Slash:1513768633434640517>Slash] — đâm, hồi 3 HP${isMin ? " *(Min — dừng)*" : i === MAX_REUSE ? " *(hết Reuse)*" : ""}`);
        }
        if (isMin) { stopped = true; break; }
      }
      return lines;
    },
  },
  "cackle": {
    name: "Cackle",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(8,14);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Nails:1513768423124111482>Nails`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 3 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },

  // ── Index ──
  "unlock": {
    name: "Unlock",
    cost: "0 <:Light:1513786082502770719>Light", cd: "0 Turn", diceMul: "1x",
    roll() {
      const stage = Math.floor(Math.random() * 3) + 1;
      if (stage === 1) {
        const d1 = r(2,4);
        return [
          `**Unlock - 1** *(không có Unlock Blade)*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — trúng: nhận **Unlock Blade - 1**`,
        ];
      } else if (stage === 2) {
        const d1 = r(3,6), d2 = r(3,6);
        return [
          `**Unlock - 2** *(cần Unlock Blade - 1)*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận **Unlock Blade - 2**`,
        ];
      } else {
        const d1 = r(6,11), d2 = r(6,11);
        return [
          `**Unlock - 3** *(cần Unlock Blade - 2)*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận **Unlocked Blade**`,
        ];
      }
    },
  },

  // ── Misc ──
  "blade flourish": {
    name: "Blade Flourish",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(5,8), d3 = r(6,9);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — nhận 3 <:DiceUp:1513767795681398894>Dice Up đến hết turn này`,
      ];
    },
  },

  // ── EGO Pages (TETH) ──
  "beak": {
    name: "Beak",
    tags: "Ego Pages <:TETH:1449759432119419070>",
    cost: "4 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,14), d2 = r(7,10);
      return [
        `*Trừ 2 <:Light:1513786082502770719>Light và 20 Sanity để sử dụng cho pages kế tiếp*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce]`,
      ];
    },
  },
  "punishing beak": {
    name: "Punishing Beak",
    tags: "Corrosion Pages <:TETH:1449759432119419070>",
    cost: "6 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15,20);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 6 <:Bleed:1513762688226955285>Bleed và hồi 10 Stamina`,
      ];
    },
  },

  // ── EGO Pages (HE) ──
  "lamp": {
    name: "Lamp",
    tags: "Ego Pages <:HE:1449759447152070796>",
    cost: "3 <:Light:1513786082502770719>Light & 5 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE] — khiến toàn bộ pages kẻ địch sắp dùng bị trừ 3 Dice và giảm 1 nửa buff địch vào turn sau`,
      ];
    },
  },
  "eyes lamp": {
    name: "Eyes Lamp",
    tags: "Corrosion Pages <:HE:1449759447152070796>",
    cost: "8 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,15);
      return [
        `*[AOE] — Phải là page cuối cùng được dùng cuối turn để kích hoạt*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — giải trừ toàn bộ pages của toàn bộ nhưng không hoàn trả thứ gì`,
      ];
    },
  },

  // ── EGO Pages (WAW) ──
  "justitia": {
    name: "Justitia",
    tags: "Ego Pages <:WAW:1449759461001527518>",
    cost: "3 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15,25);
      return [
        `*[After Use] Sau khi dùng: tăng 1 <:Light:1513786082502770719>Light, lần tiếp theo +5% HP damage*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — chém gây thêm 5% Max HP địch (Giới hạn 100 Dmg hoặc 150 khi dùng cùng Justitia)`,
      ];
    },
  },
  "the justice scale": {
    name: "The Justice Scale",
    tags: "Corrosion Pages <:WAW:1449759461001527518>",
    cost: "6 <:Light:1513786082502770719>Light & 25 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,50);
      return [
        `*[Clash] Nếu địch clash: địch bị trừ 5 Dice*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — chém gây 7% Max HP địch (Giới hạn 150 Dmg hoặc 200 khi dùng cùng Justitia); Heal = 15% dmg gây ra`,
      ];
    },
  },

  // ── EGO Pages (ALEPH) ──
  "twillight": {
    name: "Twillight",
    tags: "Ego Pages <:ALEPH:1449759474268242021>",
    cost: "5 <:Light:1513786082502770719>Light & 25 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      return [
        `<:Dice1:1508173590078558369> Giảm 0.2 Res cho toàn bộ trong 3 turn. Khi chết sẽ kích hoạt Apocalypse với sát thương Blunt`,
        `*[Sau khi dùng] Biến thành Apocalypse ở lần dùng kế tiếp*`,
      ];
    },
  },
"apocalypse": {
    name: "Apocalypse",
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "—", diceMul: "1.5x",
promptArg: {
  label: "Dưới 50% HP?",
  parse: (s) => {
    const v = s.toLowerCase().trim();
    if (v === "yes" || v === "y" || v === "1" || v === "true") return "yes";
    return "no"; // mặc định no khi không nhập hoặc nhập sai
  },
  validate: (v) => true,
  errorMsg: "", // không dùng nữa vì luôn pass
  buildHeader: (v, s) => `[${s.cost}] [CD: ${s.cd}] [Dice Mul: ${s.diceMul}]${v === "yes" ? " *(Dưới 50% HP: Dice x2)*" : ""}`,
},
roll(v = "no") {
  const lowHp = v === "yes";
  const d1 = r(25,35);
  return [
    `*[Before Use] Nếu bản thân dưới 50% HP: nhân đôi Dice*`,
    `*[Before Use] Nếu chết trước khi kích hoạt: kích hoạt lại 1 đòn không có hiệu ứng sát thương chuẩn*`,
    `<:Dice1:1508173590078558369> **${lowHp ? d1*2 : d1}** [<:Blunt:1513768529718022254>Blunt] [True Damage]${lowHp ? " *(Dưới 50% HP: Dice x2)*" : ""} — nếu địch dưới 50% gây thêm 50% damage`,
  ];
},
},

  // ── Sinking (Fused Blade) ──
  "greatsword rend": {
    name: "Greatsword Rend",
    tags: "Sinking",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 5 <:Sinking:1513762793436741652>Sinking. Nếu đang dùng **Fused Blade of Ruined Mirror Worlds**: nhận 1 **Coffin**`,
      ];
    },
  },
  "beheading": {
    name: "Beheading",
    tags: "Sinking",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    needsReuse: false,
    hasDullahanRoll: true,
    roll(forceDullahan) {
      const hasDullahan = forceDullahan !== undefined ? forceDullahan : Math.random() < 0.5;
      if (hasDullahan) {
        const d1 = r(8,13), d2 = r(13,16);
        return [
          `*[Dullahan active]*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Sinking:1513762793436741652>Sinking. Nếu đang dùng Fused Blade: nhận 3 **Coffin**`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Sinking:1513762793436741652>Sinking`,
        ];
      }
      const d1 = r(3,6), d2 = r(4,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Sinking:1513762793436741652>Sinking. Nếu đang dùng Fused Blade: nhận 1 **Coffin**`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "smackdown": {
    name: "Smackdown",
    tags: "Sinking",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,4), d2 = r(4,6), d3 = r(8,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking. Nếu đang dùng Fused Blade: nhận 1 **Coffin**`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây Bleed = (số Sinking trên địch ÷ 2) ở turn kế`,
      ];
    },
  },
  "memorial procession": {
    name: "Memorial Procession",
    tags: "Sinking",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    hasDullahanRoll: true,
    roll(forceDullahan) {
      const hasDullahan = forceDullahan !== undefined ? forceDullahan : Math.random() < 0.5;
      if (hasDullahan) {
        const d1 = r(5,10), d2 = r(10,20), d3 = r(14,20);
        return [
          `*[Dullahan active]*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — Nếu đang dùng Fused Blade: nhận 3 **Coffin**`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash]`,
          `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — gây 8 <:Sinking:1513762793436741652>Sinking`,
        ];
      }
      const d1 = r(4,8), d2 = r(5,9), d3 = r(11,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — Nếu đang dùng Fused Blade: nhận 1 **Coffin**`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — gây 8 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },

  // ── Smoke skills ──
  "inhale": {
    name: "Inhale",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** — nhận ${d1} <:Smoke:1513778039610282015>Smoke (1 mỗi Dice); nhận thêm 1 <:Paralyze:1513763316479295548>Paralyze sau khi dùng`,
      ];
    },
  },
  "exhale smoke": {
    name: "Exhale Smoke",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Smoke:1513778039610282015>Smoke lên địch; với mỗi <:Smoke:1513778039610282015>Smoke trên địch Dice +1`,
      ];
    },
  },
  "loss of senses": {
    name: "Loss of Senses",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,11);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Counter] [Undodgeable] — né 4 đòn đánh thường; phản công gây 2 lần sát thương, mỗi lần gây 2 <:Smoke:1513778039610282015>Smoke; rồi gây 1 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },

  // ── Misc combat skills non status ──
  "y-you only live once": {
    name: "Y-you Only Live Once",
    cost: "1 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(1,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [Fixed Dmg] [Guard Break] [AOE 5 mục tiêu] — đánh văng toàn bộ địch, gây dmg và áp 2 <:Paralyze:1513763316479295548>Paralyze cho turn sau`,
      ];
    },
  },
  "crush": {
    name: "Crush",
    tags: "Tremor",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(3,6);
      return [
        `*Dặm đất, gây dmg 2 lần, mỗi hit áp 2 <:Tremor:1513762737388257380>Tremor*`,
        `<:Dice1:1508173590078558369> Nhát 1: **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice1:1508173590078558369> Nhát 2: **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "you're too slow": {
    name: "You're Too Slow",
    tags: "Bleed",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,23);
      return [
        `*Né 1 đòn thường của địch, đánh dấu trúng, hồi 1 <:Light:1513786082502770719>Light; turn sau kích hoạt lại 1 lần*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — đâm sau lưng địch, gây 3 <:Bleed:1513762688226955285>Bleed cho turn sau`,
      ];
    },
  },

  // ── Coin Trick / Pistol / Summary ──
  "coin trick": {
    name: "Coin Trick",
    tags: "Rupture",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [AOE 5 mục tiêu] — tiêu 1 Ahn, búng đồng xu gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "pistol draw": {
    name: "Pistol Draw",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,8), d2 = r(6,8), d3 = r(6,8);
      return [
        `*Yêu cầu 1 viên đạn (không tiêu). Bắn 3 đường đạn [AOE 2 mục tiêu]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce]`,
      ];
    },
  },
  "summary judgement": {
    name: "Summary Judgement",
    tags: "Tremor/Burn",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,9), d2 = r(10,15);
      return [
        `*Yêu cầu tối thiểu 1 viên đạn (không tiêu)*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — dậm chân, gây 6 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — rút súng bắn rồi giật lùi, áp 4 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },

  // ── Haste (Fencing) ──
  "contre attaque": {
    name: "Contre Attaque",
    tags: "Haste",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(3,5), d3 = r(7,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — nhận 6 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Haste:1513768004222062632>Haste`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — nhận 4 <:Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "engagement": {
    name: "Engagement",
    tags: "Haste",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(5,10), d3 = r(6,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "balestra fente": {
    name: "Balestra Fente",
    tags: "Haste",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "Dice1: 1x / Dice2: 0.5x",
    roll() {
      const d1 = r(5,8), d2 = r(7,11);
      const hasPoise = Math.random() < 0.5;
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — chọt nhiều đòn`,
        `<:Dice2:1508173623691710625> **${d2}${hasPoise ? "+4 DiceUp" : ""}** [<:Pierce:1513768511179329556>Pierce]${hasPoise ? " *(≥8 Poise: nhận 4 <:DiceUp:1513767795681398894>Dice Up)*" : ""}`,
      ];
    },
  },

  // ── Burn/Haste (Viriscent) ──
  "scorching incision": {
    name: "Scorching Incision",
    tags: "Burn",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,6), d3 = r(4,6);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Burn:1513762753691652177>Burn và gắn 1 <:Bind:1513768025881317457>Bind với mỗi 2 <:Burn:1513762753691652177>Burn trên địch [Max: 6]`,
      ];
    },
  },

  // ── Abnormality Pages (TETH) ──
  "fourth match flame": {
    name: "Fourth Match Flame",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "4 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,40);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [AOE] — chém đường lửa gây 5 <:Burn:1513762753691652177>Burn lên kẻ thù ở turn sau`,
      ];
    },
  },
  "today's expression": {
    name: "Today's Expression",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "3 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,30), d2 = r(6,9), d3 = r(5,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** — giảm Stamina địch bằng số dice [chỉ giảm Stamina, không gây dmg]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nếu địch Stagger: dmg = dice + 10`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash]`,
      ];
    },
  },
  "regret": {
    name: "Regret",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "5 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,8), d2 = r(6,8), d3 = r(9,19);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — đập búa, giảm 20 Stamina địch`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — đập búa, giảm 20 Stamina địch`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — đập búa, giảm 60 Stamina địch`,
      ];
    },
  },
  "fragments from somewhere": {
    name: "Fragments from Somewhere",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "3 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(4,7), d3 = r(4,7);
      return [
        `*Khi dùng: toàn bộ skill địch turn này bị giảm 5 Dice*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây nốt nhạc, giảm 10 Stamina địch`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây nốt nhạc, giảm 10 Stamina địch`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây nốt nhạc, giảm 10 Stamina địch`,
      ];
    },
  },
  "wrist cutter": {
    name: "Wrist Cutter",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "5 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(19,27);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [AOE] — tạo vũng máu, khiến địch mất toàn bộ buff trên người`,
      ];
    },
  },
  "aspiration": {
    name: "Aspiration",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "5 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(24,39);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — đấm vào mặt địch. Bản thân mất 1/2 HP; toàn bộ đồng minh (không kể bản thân) nhận 3 <:DiceUp:1513767795681398894>Dice Up trong 1 Turn`,
      ];
    },
  },
  "red eyes": {
    name: "Red Eyes",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "4 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,25), d2 = r(5,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — nhảy lên chém xuống, gây 3 <:Bind:1513768025881317457>Bind và 3 Feeble`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — chém địch`,
      ];
    },
  },
  "marionette": {
    name: "Marionette",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ZAYIN:1449759413966606398>",
    cost: "1 <:Light:1513786082502770719>Light & 10 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(19,27);
      return [
        `*Khi dùng: turn sau mọi skill của bản thân tốn thêm 1 <:Light:1513786082502770719>Light*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — dmg = dice + 5`,
      ];
    },
  },

  // ── Abnormality Pages (ZAYIN) ──
  "wingbeat": {
    name: "Wingbeat",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ZAYIN:1449759413966606398>",
    cost: "3 <:Light:1513786082502770719>Light & 10 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    needsReuse: true,
    roll() {
      const DICE_EMOJIS = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,
        `<:Dice3:1508173643518050395>`,`<:Dice4:1508176464367845600>`,`<:Dice5:1508176500438990968>`,
        `<:Dice5:1508176500438990968>`,`<:Dice5:1508176500438990968>`,
      ];
      const MAX_REUSE = 5;
      const lastD2 = r(6,8);
      const lines = [];
      let reuseStopped = false;
      for (let i = 0; i <= MAX_REUSE; i++) {
        const val = r(3,8);
        const isMin = val === 3;
        const dEmoji = DICE_EMOJIS[i] ?? DICE_EMOJIS[DICE_EMOJIS.length - 1];
        const label = i === 0 ? "" : ` ↩️ Reuse ${i}`;
        lines.push(`${dEmoji}${label} **${val}** [<:Pierce:1513768511179329556>Pierce] — lao đến đâm, hồi 3 HP${isMin ? " *(Min — dừng)*" : ""}`);
        if (isMin) { reuseStopped = true; break; }
      }
      if (!reuseStopped) lines.push(`*(Đã hết 5 lần Reuse)*`);
      lines.push(`<:Dice2:1508173623691710625> **${lastD2}** [<:Pierce:1513768511179329556>Pierce] — lao đến đâm địch`);
      return lines;
    },
  },

  // ── Abnormality Pages (HE) ──
  "the forgotten": {
    name: "The Forgotten",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,25);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — nếu clash thắng: hủy skill tiếp theo của địch`,
      ];
    },
  },
  "grinder mk. 5-2": {
    name: "Grinder Mk. 5-2",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,7), d2 = r(3,8), d3 = r(4,9);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — chọt toàn bộ địch, gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — chọt toàn bộ địch, gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — chọt toàn bộ địch, gây 2 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "harmony": {
    name: "Harmony",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    needsReuse: true,
    roll() {
      const DICE_EMOJIS = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,`<:Dice3:1508173643518050395>`,
      ];
      const MINS = [4, 3, 4];
      const RANGES = [[4,7],[3,6],[4,8]];
      const MAX_REUSE = 2;
      const lines = [
        `*Mỗi lần tấn công thành công: 1 đồng minh ngẫu nhiên mất 3 Stamina*`,
        `*Mỗi 2 lần tấn công thành công: 1 đồng minh nhận 1 <:DiceUp:1513767795681398894>Dice Up*`,
        `*Nếu có thể kết liễu địch: toàn bộ đồng minh nhận 2 <:DiceUp:1513767795681398894>Dice Up*`,
      ];
      for (let di = 0; di < 3; di++) {
        const [mn, mx] = RANGES[di];
        const min = MINS[di];
        const dEmoji = DICE_EMOJIS[di];
        const val = r(mn, mx);
        const isMin = val === min;
        lines.push(`${dEmoji} **${val}** [<:Blunt:1513768529718022254>Blunt] — cưa địch${isMin ? " *(Min — dừng)*" : ""}`);
        if (!isMin) {
          for (let re = 1; re <= MAX_REUSE; re++) {
            const rval = r(mn, mx);
            const rMin = rval === min;
            lines.push(`${dEmoji} ↩️ Reuse ${re} **${rval}** [<:Blunt:1513768529718022254>Blunt] — cưa địch${rMin ? " *(Min — dừng)*" : re === MAX_REUSE ? " *(hết Reuse)*" : ""}`);
            if (rMin) break;
          }
        }
      }
      return lines;
    },
  },
  "solemn lament": {
    name: "Solemn Lament",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
    needsReuse: true,
    roll(deadCount = 0) {
      const MAX_REUSE = deadCount * 8;
      const DICE_EMOJIS = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,`<:Dice3:1508173643518050395>`,
        `<:Dice4:1508176464367845600>`,`<:Dice5:1508176500438990968>`,
      ];
      const getDEmoji = (i) => DICE_EMOJIS[Math.min(i, DICE_EMOJIS.length - 1)];
      const lines = [];
      if (deadCount === 0) {
        const d1 = r(1,6);
        lines.push(`${getDEmoji(0)} **${d1}** [<:Blunt:1513768529718022254>Blunt] — bắn vào mặt địch, giảm Stamina địch = ${d1 + 3}`);
        lines.push(`*(Chưa có ai chết — không có Reuse)*`);
        return lines;
      }

      // Roll tất cả hits trước
      const hits = [];
      for (let i = 0; i <= MAX_REUSE; i++) {
        const val = r(1,6);
        hits.push({ val, staminaDmg: val + 3 });
      }
      const totalStamina = hits.reduce((s, h) => s + h.staminaDmg, 0);
      const totalDmg = hits.reduce((s, h) => s + h.val, 0);
      const minHit = Math.min(...hits.map(h => h.val));
      const maxHit = Math.max(...hits.map(h => h.val));

      lines.push(`*(${deadCount} mạng đã ngã → ${MAX_REUSE} lần Reuse)*`);

      // Hiện 3 hit đầu, gộp phần còn lại
      const SHOW = 3;
      const showCount = Math.min(SHOW, hits.length);
      for (let i = 0; i < showCount; i++) {
        const { val, staminaDmg } = hits[i];
        const label = i === 0 ? "" : ` ↩️ Reuse ${i}`;
        const tail = i === hits.length - 1 ? " *(hết Reuse)*" : "";
        lines.push(`${getDEmoji(i)}${label} **${val}** [<:Blunt:1513768529718022254>Blunt] — giảm Stamina địch = ${staminaDmg}${tail}`);
      }
      if (hits.length > SHOW) {
        const restStamina = hits.slice(SHOW).reduce((s, h) => s + h.staminaDmg, 0);
        const restDmg = hits.slice(SHOW).reduce((s, h) => s + h.val, 0);
        lines.push(`*↩️ Reuse ${SHOW}–${MAX_REUSE}: [${hits.slice(SHOW).map(h => h.val).join("")}] — tổng ${restDmg} DMG, giảm ${restStamina} Stamina *(hết Reuse)**`);
      }

      // Summary
      lines.push(`\n📊 **Tổng kết** (${hits.length} hit)`);
      lines.push(`> <:Blunt:1513768529718022254> Tổng DMG: **${totalDmg}** | Min: ${minHit} / Max: ${maxHit} / TB: ${(totalDmg / hits.length).toFixed(1)}`);
      lines.push(`> <:TremorBurst:1513802464632246352> Tổng Stamina giảm: **${totalStamina}**`);

      return lines;
    },
  },
  "magic bullet": {
    name: "Magic Bullet",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "1 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "???", diceMul: "1x",
    roll() {
      const d1 = r(4,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — bắn viên đạn vào địch`,
        `*Sau khi dùng: mở lãnh địa Der Freischütz, dùng được skill của hắn trong 3 Turn tiếp theo [1 lần/Encounter]*`,
        `*(Dùng: \`-skill flooding bullets\`, \`-skill magic bullet df\`, \`-skill inevitable bullet\`)*`,
      ];
    },
  },
  "flooding bullets": {
    name: "Flooding Bullets",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796> (Der Freischütz)",
    cost: "5 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(4,8), d2 = r(4,8), d3 = r(4,8);
      return [
        `*[AOE] — Lượng dmg = số dice x2*`,
        `<:Dice1:1508173590078558369> **${d1*2}** [<:Pierce:1513768511179329556>Pierce] — 3 vòng tròn ma thuật bắn vào tất cả địch`,
        `<:Dice2:1508173623691710625> **${d2*2}** [<:Pierce:1513768511179329556>Pierce] — 3 vòng tròn ma thuật bắn vào tất cả địch`,
        `<:Dice3:1508173643518050395> **${d3*2}** [<:Pierce:1513768511179329556>Pierce] — 3 vòng tròn ma thuật bắn vào tất cả địch, giảm 6 Stamina`,
      ];
    },
  },
  "magic bullet df": {
    name: "Magic Bullet (Der Freischütz)",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796> (Der Freischütz)",
    cost: "0 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — rút súng bắn địch; hồi 1 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "inevitable bullet": {
    name: "Inevitable Bullet",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796> (Der Freischütz)",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,9), d2 = r(5,9);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — 2 vòng tròn ma thuật bắn xuyên tất cả địch`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — 2 vòng tròn ma thuật bắn xuyên tất cả địch`,
      ];
    },
  },
  "our galaxy": {
    name: "Our Galaxy",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,8), d2 = r(3,8), d3 = r(3,6);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — thả thiên thạch, hồi ${d1} HP`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — thả thiên thạch, hồi ${d2} HP`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — thả thiên thạch, hồi ${d3} HP`,
      ];
    },
  },
  "pleasure": {
    name: "Pleasure",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const turnBonus = r(1,5);
      const d1 = r(5,15);
      const d2 = r(2,5), d3 = r(2,5), d4 = r(2,5);
      return [
        `<:Dice1:1508173590078558369> **${(d1 + turnBonus) * 2}** [<:Blunt:1513768529718022254>Blunt] — (dice + ${turnBonus} turn bonus) x2`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "laetitia": {
    name: "Laetitia",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE] — triệu hồi trái tim khổng lồ phát nổ; địch dính dmg bị hoãn 1 hành động`,
      ];
    },
  },
  "sanguine desire": {
    name: "Sanguine Desire",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,10), d2 = r(3,9), d3 = r(4,6);
      const hasBleed = Math.random() < 0.5;
      return [
        `*Khi dùng: <:Bleed:1513762688226955285>Bleed tồn tại thêm 1 turn*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt]`,
        `<:Dice3:1508173643518050395> **${hasBleed ? d3*2 : d3}** [<:Blunt:1513768529718022254>Blunt]${hasBleed ? " *(địch có Bleed: dmg x2)*" : " *(địch không có Bleed)*"}`,
      ];
    },
  },

  // ── Abnormality Pages (WAW) ──
  "hornet": {
    name: "Hornet",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "2 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,32);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — lao đến đâm xuyên địch, gây 5 <:Fragile:1513763336167100536>Fragile`,
      ];
    },
  },
  "green stem": {
    name: "Green Stem",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "5 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "3 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(3,9), d2 = r(3,9), d3 = r(3,10);
      return [
        `*[AOE] — Lượng dmg = số dice x2*`,
        `<:Dice1:1508173590078558369> **${d1*2}** [<:Blunt:1513768529718022254>Blunt] — gây dmg lên tất cả địch`,
        `<:Dice2:1508173623691710625> **${d2*2}** [<:Blunt:1513768529718022254>Blunt] — gây dmg lên tất cả địch`,
        `<:Dice3:1508173643518050395> **${d3*2}** [<:Blunt:1513768529718022254>Blunt] — gây dmg lên tất cả địch`,
      ];
    },
  },
  "faint aroma": {
    name: "Faint Aroma",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "5 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "4 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(3,7), d2 = r(3,7), d3 = r(3,7);
      const stagger = Math.random() < 0.4;
      return [
        `*[AOE] — Lượng dmg = số dice x2; +10 dmg nếu địch Stagger*`,
        `<:Dice1:1508173590078558369> **${stagger ? d1*2+10 : d1*2}** [<:Slash:1513768633434640517>Slash]${stagger ? " *(Stagger +10)*" : ""}`,
        `<:Dice2:1508173623691710625> **${stagger ? d2*2+10 : d2*2}** [<:Slash:1513768633434640517>Slash]${stagger ? " *(Stagger +10)*" : ""}`,
        `<:Dice3:1508173643518050395> **${stagger ? d3*2+10 : d3*2}** [<:Slash:1513768633434640517>Slash]${stagger ? " *(Stagger +10)*" : ""}`,
      ];
    },
  },
  "black swan": {
    name: "Black Swan",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "5 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(9,18);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gầm lên, gây dmg`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gầm lên, gây dmg; địch dính trừ 2 <:Light:1513786082502770719>Light`,
      ];
    },
  },

  // ── Abnormality Pages (ALEPH) ──
  "da capo": {
    name: "Da Capo",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ALEPH:1449759474268242021>",
    cost: "5 <:Light:1513786082502770719>Light & 40 Sanity 🧠", cd: "4 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(4,8), d2 = r(4,9), d3 = r(5,9);
      return [
        `*[AOE] — Lượng dmg = số dice x2*`,
        `<:Dice1:1508173590078558369> **${d1*2}** [<:Blunt:1513768529718022254>Blunt] — Màn một: khiến tất cả địch mất 3 <:Light:1513786082502770719>Light`,
        `<:Dice2:1508173623691710625> **${d2*2}** [<:Blunt:1513768529718022254>Blunt] — Màn hai: tất cả địch nhận 10 <:Bind:1513768025881317457>Bind`,
        `<:Dice3:1508173643518050395> **${d3*2}** [<:Blunt:1513768529718022254>Blunt] — Màn cuối: tất cả địch nhận 2 Feeble`,
      ];
    },
  },

  // ── Frost Splinter (no tier tag) ──
  "frost splinter": {
    name: "Frost Splinter",
    tags: "Abnormalities <:The_Library:1474374220023857192>",
    cost: "6 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,12), d2 = r(8,13);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Bind:1513768025881317457>Bind và 1 Feeble trong 1 Turn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Bind:1513768025881317457>Bind và 1 Feeble trong 1 Turn`,
      ];
    },
  },

  // ── MY HAIR COUPOOOOOOONS! / Nursefather ──
  "my hair coupooooooons": {
    name: "MY HAIR COUPOOOOOOONS!",
    tags: "Tremor",
    cost: "5 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(18,32);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AoE] [Guard Break] — <:TremorBurst:1513802464632246352>Tremor Burst và 7 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },
  "proof of loyalty": {
    name: "Proof of Loyalty",
    tags: "Bleed",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(8,11);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — lùi rồi đấm xuống mặt đất, gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
      ];
    },
  },
  "just a vengeance": {
    name: "Just A Vengeance",
    tags: "Bleed",
    cost: "4 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(4,6), d3 = r(5,7), d4 = r(12,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đạp địch ra xa, gây 2 <:Bind:1513768025881317457>Bind`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [AoE 2 người] — gây 3 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },

  // ── Fairy (Degraded) skills ──
  "degraded fairy": {
    name: "Degraded Fairy",
    tags: "Fairy <:Fairy:1513782007602216960>",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(4,8);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Triệu hồi gai đâm kẻ thù gây 2 <:Fairy:1513782007602216960>Fairy`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Triệu hồi gai đâm kẻ thù gây 2 <:Fairy:1513782007602216960>Fairy`,
        `${D2} Nhận 1 <:Light:1513786082502770719>Light nếu đánh dính kẻ thù`,
      ];
    },
  },
  "degraded pillar": {
    name: "Degraded Pillar",
    tags: "Fairy <:Fairy:1513782007602216960>",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,11);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Guard Break] — Triệu hồi cây cột đập mặt kẻ thù gây 4 <:Fairy:1513782007602216960>Fairy`,
      ];
    },
  },
  "degraded lock": {
    name: "Degraded Lock",
    tags: "Fairy <:Fairy:1513782007602216960>",
    cost: "4 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,20);
      return [
        `${D1} **${d1}** [Undodgeable] — Xích kẻ thù lại gây 5 <:Fairy:1513782007602216960>Fairy và 1 **Chained** <:chained:1513782041307643984>Chained`,
      ];
    },
  },

  // ══════════════ Weapon Criticals ══════════════
  "patrolling": {
    name: "Patrolling", weaponOf: "Zweihander", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(7,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Chém kẻ địch, nhận 3 <:DefenseUp:1513767487894716497>Defense Up`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đâm kẻ địch, nhận 4 <:DefenseUp:1513767487894716497>Defense Up và gây 5 <:DefenseDown:1513767463337066576>Defense Down`,
      ];
    },
  },
  "bayonet combat": {
    name: "Bayonet Combat", weaponOf: "Soldato Rifle", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(5,7), d3 = r(4,7);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Chém xuống bằng lưỡi súng, gây 2 <:Tremor:1513762737388257380>Tremor`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Chém lên, gây 2 <:Tremor:1513762737388257380>Tremor`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Lùi lại đâm, gây 2 <:Tremor:1513762737388257380>Tremor và nhận 1 viên đạn`,
      ];
    },
  },
  "shock round": {
    name: "Shock Round", weaponOf: "Soldato Rifle", tags: "Weapon",
    cost: "Tiêu 2 viên đạn", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(9,17);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Chém ngang bằng lưỡi súng, gây 4 <:Tremor:1513762737388257380>Tremor`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Đạn nổ thổi bay kẻ địch, gây 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "sharp cuts": {
    name: "Sharp Cuts", weaponOf: "Blade Lineage Hwando", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(4,8);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "thundercleaver": {
    name: "Thundercleaver", weaponOf: "Kurokumo Katana", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "0.5x",
    roll() {
      const d1 = r(5,9), d2 = r(5,13), d3 = r(5,17);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "upstanding slash": {
    name: "Upstanding Slash", weaponOf: "Mimicry Blade", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,10), d2 = r(9,15);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Chém ngang, gây 3 <:Bleed:1513762688226955285>Bleed (turn kế) và nhận 1 Imitation`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Chém dọc theo sau, gây 3 <:Bleed:1513762688226955285>Bleed (turn kế) và nhận 1 Imitation`,
      ];
    },
  },
  "great split vertical": {
    name: "Great Split: Vertical", weaponOf: "Mimicry Blade", tags: "Weapon",
    cost: "Tiêu 5 Imitation", cd: "—", diceMul: "2x",
    roll() {
      const d1 = r(15,26);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Unblockable]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Bổ dọc kẻ địch từ trên xuống, cắt đôi người chúng`,
      ];
    },
  },
  "great split horizontal": {
    name: "Great Split: Horizontal", weaponOf: "Mimicry Blade", tags: "Weapon",
    cost: "Tiêu 5 Imitation, cần bản thân dưới 30% HP", cd: "—", diceMul: "3x",
    roll() {
      const d1 = r(32,43);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Unblockable] [Undodgeable]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Vung Mimicry theo chiều ngang cắt đôi kẻ địch`,
      ];
    },
  },
  "excruciating study": {
    name: "Excruciating Study", weaponOf: "Dieci Association Kata", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "0.5x",
    roll() {
      const d1 = r(4,7), d2 = r(4,7), d3 = r(7,10), d4 = r(10,13);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — đập vào mặt kẻ thù, gây 4 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — đập vào mặt kẻ thù`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — đập vào mặt kẻ thù`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] — đập vào mặt kẻ thù, gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "unveil": {
    name: "Unveil", weaponOf: "Dieci Association Key", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "0.8x",
    roll() {
      const d1 = r(4,4), d2 = r(4,8), d3 = r(4,12), d4 = r(4,16);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đập vào mặt kẻ thù, gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đập vào mặt kẻ thù, gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đập vào mặt kẻ thù, gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đập vào mặt kẻ thù, gây 1 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "scorching desperation": {
    name: "Scorching Desperation", weaponOf: "The Crying Children", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,18);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Tạo một cái cánh hất vào mặt kẻ thù, gây 7 <:Burn:1513762753691652177>Burn; bản thân giảm 15 Sanity`,
      ];
    },
  },
  "resonate": {
    name: "Resonate", weaponOf: "Reverberation Scythe", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(4,8);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Xoay lưỡi hái một vòng; nếu kẻ địch có số <:Tremor:1513762737388257380>Tremor bằng số Dice này thì sẽ Stagger ngay`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Xoay lưỡi hái một vòng nữa`,
      ];
    },
  },
  "magic impact": {
    name: "Magic Impact", weaponOf: "Yesterday's Promise", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,20);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Tạo một cánh tay ma thuật đục vào mặt kẻ thù`,
      ];
    },
  },
  "beatdown": {
    name: "Beatdown", weaponOf: "L'Heure du Loup", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(17,35);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Unclashable] — Đạp vào mặt kẻ thù, gây 4 <:Paralyze:1513763316479295548>Paralyze và 2 lần <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "overbreath": {
    name: "Overbreath", weaponOf: "Shi Association Katana", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,28);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt về phía kẻ thù, gây 2 <:Bleed:1513762688226955285>Bleed và nhận 6 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "forming storm": {
    name: "Forming Storm", weaponOf: "Liu Guan Dao", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,20);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Guard Break] [AOE 3 người] — Đập trường đao xuống tạo vùng lửa lớn, gắn 5 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "violent flame": {
    name: "Violent Flame", weaponOf: "Liu Martial Arts", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,8), d2 = r(6,16);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Đấm vào mặt kẻ thù, gây 3 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Đấm vào mặt kẻ thù, gây 6 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "dimensional rift": {
    name: "Dimensional Rift", weaponOf: "WARP Corp. Dagger", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const hasCharge = Math.random() < 0.5; // placeholder cho ≥15 Charge
      const d1 = hasCharge ? r(16,24) : r(6,12);
      return [
        hasCharge
          ? `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — *(≥15 Charge: tiêu 15 Charge)* Dice 1 đổi thành [16~24], gây 6 <:Rupture:1513762812722155682>Rupture`
          : `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Nhảy vọt không gian rồi cắt đứt kẻ địch, gây 3 <:Rupture:1513762812722155682>Rupture và nhận 4 Charge`,
      ];
    },
  },
  "dimensional rift gauntlets": {
    name: "Dimensional Rift", weaponOf: "WARP Corp. Gauntlets", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const hasCharge = Math.random() < 0.5; // placeholder cho ≥15 Charge
      const d1 = hasCharge ? r(12,16) + 5 : r(12,16);
      return [
        hasCharge
          ? `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — *(≥15 Charge: +5 <:DiceUp:1513767795681398894>Dice Up)* Túm kẻ địch, dao không gian cắt đứt chúng, gây 3 <:Rupture:1513762812722155682>Rupture và nhận 3 Charge`
          : `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Túm kẻ địch, dao không gian cắt đứt chúng, gây 3 <:Rupture:1513762812722155682>Rupture và nhận 3 Charge`,
      ];
    },
  },
  "the udjat": {
    name: "The Udjat", weaponOf: "Udjat Khopesh", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,12), d2 = r(5,7), d3 = r(5,8);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Nhảy lên đâm xuống, nhận 2 Protection`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Vung kiếm ngang, nhận 1 Protection`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Tiếp tục vung ngang`,
      ];
    },
  },
  "moulinet": {
    name: "Moulinet", weaponOf: "Seven Association Longsword", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(7,10), d3 = r(12,14);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Chém ngang, gây 1 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Vung kiếm lên, gây 1 <:Rupture:1513762812722155682>Rupture`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Các động tác tạo hình số 7 rồi nổ tung, gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "unyielding strike": {
    name: "Unyielding Strike", weaponOf: "Augury Spear", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x (2x nếu kích <:TremorBurst:1513802464632246352>Tremor Burst)",
    roll() {
      const d1 = r(6,16);
      return [
        `*[Nếu địch ≥5 <:Tremor:1513762737388257380>Tremor trước khi gây dmg: thêm 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst kẻ địch]*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Lướt lên cường hóa tay rồi đấm kẻ địch, gây 5 <:Tremor:1513762737388257380>Tremor và nhận 1 Trigram`,
      ];
    },
  },
  "true trigram formation": {
    name: "True Trigram Formation", weaponOf: "Augury Spear", tags: "Weapon",
    cost: "Cần đủ 4 Trigram", cd: "—", diceMul: "1x (2x nếu kích <:TremorBurst:1513802464632246352>Tremor Burst)",
    roll() {
      const d1 = r(8,14), d2 = r(9,18);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — Đâm ngọn giáo về phía trước, gây 4 <:Tremor:1513762737388257380>Tremor. Tiêu toàn bộ Trigram; nếu địch ≥5 <:Tremor:1513762737388257380>Tremor sẽ <:TremorBurst:1513802464632246352>Tremor Burst`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Ngọn giáo biến thành vô số lưỡi nhọn đâm kẻ địch, gây 3 <:Paralyze:1513763316479295548>Paralyze. Nếu địch ≥7 <:Tremor:1513762737388257380>Tremor: nhận Shield HP bằng <:Tremor:1513762737388257380>Tremor trên người chúng`,
      ];
    },
  },
  "eliminate": {
    name: "Eliminate", weaponOf: "Index Longsword", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,12);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém ngang kẻ địch, gây 4 <:Rupture:1513762812722155682>Rupture. Nếu có **Unlocked Blade**: dùng tiếp Castigation`,
      ];
    },
  },
  "castigation": {
    name: "Castigation", weaponOf: "Index Longsword", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,10), d2 = r(4,10), d3 = r(4,10), d4 = r(1,4);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Lao lên chém kẻ địch, gây 2 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Lướt quanh chém liên tục`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Kết thúc bằng một đòn chém ngang`,
        `${D4} **${d4}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — Gây thêm bonus dmg = Dice x6, sau đó xóa stack **Unlocked Blade**`,
      ];
    },
  },
  "decapitation": {
    name: "Decapitation", weaponOf: "Index Cleaver", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15,22);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Bắn xích kéo kẻ địch lại gần rồi trảm đầu, gây 4 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "requiem": {
    name: "Requiem", weaponOf: "Fused Blade of Ruined Mirror Worlds", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,12), d2 = r(12,18);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Gây 2 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Gây 5 <:Sinking:1513762793436741652>Sinking, nhận 1 Coffin. +1 <:DiceUp:1513767795681398894>Dice Up cho mỗi Coffin (Max 10) và +1 <:DiceUp:1513767795681398894>Dice Up cho mỗi <:Sinking:1513762793436741652>Sinking trên địch (Max 8)`,
      ];
    },
  },
  "lament mourn and despair": {
    name: "Lament, Mourn and Despair", weaponOf: "Fused Blade of Ruined Mirror Worlds", tags: "Weapon",
    cost: "Chỉ dùng khi có Dullahan", cd: "2 Turn", diceMul: "1x (Dice âm)",
    roll() {
      const d1 = r(12,24), d2 = r(24,27);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Gây 3 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Gây 1 <:Sinking:1513762793436741652>Sinking, nhận 1 Coffin. +1 <:DiceUp:1513767795681398894>Dice Up/Coffin (Max 10), +1 <:DiceUp:1513767795681398894>Dice Up/<:Sinking:1513762793436741652>Sinking trên địch (Max 8), +3 <:DiceUp:1513767795681398894>Dice Up/Dullahan (Max 9)`,
        `*[Turn End sau khi dùng] mất hết stack Dullahan*`,
      ];
    },
  },
  "promised suffering": {
    name: "Promised Suffering", weaponOf: "Chains of Loyalty", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(6,8), d3 = r(7,10);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Túm kẻ địch quật ngã, gây 1 Fragile`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Tiếp tục, gây 1 Fragile`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — Đá thẳng vào mặt kết liễu, gây 2 Fragile và 1 <:VengeanceMark:1513768136023740436>Vengeance Mark. Nếu địch ≥3 <:VengeanceMark:1513768136023740436>Vengeance Mark: +2 Fragile/hit và +5% Dmg/<:VengeanceMark:1513768136023740436>Vengeance Mark`,
      ];
    },
  },
  "murche defensive": {
    name: "Murche Defensive", weaponOf: "Cinq Rapier", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,12), d2 = r(3,14);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Đâm kẻ thù, nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đâm kẻ thù, nhận 4 <:Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "viriscent pyrojade violet": {
    name: "Viriscent Pyrojade Violet", weaponOf: "Viriscent Pyrojade Ring", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,8), d2 = r(2,4), d3 = r(10,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — Đấm vào mặt kẻ thù, nhận 5 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — Đấm vào mặt kẻ thù, gây 4 <:Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — Đấm vào mặt kẻ thù, gây 4 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "durandal": {
    name: "Durandal", weaponOf: "Durandal", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(5,8), d3 = r(6,9);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Chém kẻ địch một nhát`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Theo sau một nhát nữa`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Trảm xuống một đường, nhận 3 <:DiceUp:1513767795681398894>Dice Up đến hết turn`,
      ];
    },
  },
  "mook workshop": {
    name: "Mook Workshop", weaponOf: "Mook Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,19);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Rút kiếm cắt không gian nơi kẻ địch đứng, gây dmg 2 hit và nhận 1 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "slay all": {
    name: "Slay All", weaponOf: "Mook Workshop", tags: "Weapon",
    cost: "Cần kẻ địch Airborne", cd: "2 Turn", diceMul: "2x", 
    roll() {
      const d1 = r(10,19);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [AOE 5 người] — Rút kiếm cắt đứt toàn bộ không gian xung quanh, gây dmg 6 hit`,
      ];
    },
  },
  "crystal atelier": {
    name: "Crystal Atelier", weaponOf: "Crystal Atelier", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,11), d2 = r(7,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [AOE 2 người] — Đâm hai thanh kiếm vào kẻ địch`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] [AOE 2 người] — Trảm ngang người chúng`,
      ];
    },
  },
  "zelkova workshop": {
    name: "Zelkova Workshop", weaponOf: "Zelkova Workshop", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,9), d2 = r(8,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Dùng rìu chặt đứt kẻ địch, gây 4 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Dùng chùy kết liễu, gây 6 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "atelier logic shotgun": {
    name: "Atelier Logic: Shotgun", weaponOf: "Atelier Logic", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,14);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Bóp cò Shotgun bắn kẻ địch, gây 3 <:Rupture:1513762812722155682>Rupture, sau đó đổi qua dạng Pistols`,
      ];
    },
  },
  "atelier logic pistols": {
    name: "Atelier Logic: Pistols", weaponOf: "Atelier Logic", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,9), d2 = r(7,10);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — Dùng Pistol bên trái bắn kẻ địch`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — Kết thúc bằng Pistol bên phải, đổi về dạng Shotgun`,
      ];
    },
  },
  "old boys workshop": {
    name: "Old Boys Workshop", weaponOf: "Old Boys Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,4), d2 = r(5,7), d3 = r(7,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Đập búa xuống, gây 1 <:Tremor:1513762737388257380>Tremor`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Thêm 1 nhát búa, gây 1 <:Tremor:1513762737388257380>Tremor`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Tụ lực giáng đòn cuối, gây 5 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "wheels industry": {
    name: "Wheel's Industry", weaponOf: "Wheel's Industry", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,24);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Guard Break] [AOE 3 người] — Lao lên bổ xuống kẻ địch`,
      ];
    },
  },
  "allas workshop": {
    name: "Allas Workshop", weaponOf: "Allas Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,18);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — Dùng ngọn thương đâm xuyên kẻ địch trong chớp mắt`,
      ];
    },
  },
  "ranga workshop": {
    name: "Ranga Workshop", weaponOf: "Ranga Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,7), d2 = r(3,7), d3 = r(4,10);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Lao lên chém kẻ địch bằng dao, gây 3 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Dùng vuốt nhọn cấu xé, gây 3 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] — Kết liễu bằng một cú vung, gây 2 <:Bleed:1513762688226955285>Bleed (turn sau). Nếu có >5 stack Realization: kích toàn bộ <:Bleed:1513762688226955285>Bleed hiện tại trên địch (không giảm count)`,
      ];
    },
  },
  "open wound": {
    name: "Open Wound", weaponOf: "Sharp Greatsword", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,4), d2 = r(3,6);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 4 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Gây 4 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "fallstar slayer": {
    name: "Fallstar Slayer [落星一殺]", weaponOf: "Moonlit Azure Blade", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,9);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Undodgeable]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém kẻ địch rồi tra kiếm, cắt đứt không gian. +1 <:DiceUp:1513767795681398894>Dice Up cho mỗi <:Poise:1513762945715142736>Poise trên người (Max 19)`,
        `*[Sau đó] tiêu toàn bộ <:Poise:1513762945715142736>Poise, tăng base dmg cho Dice 1 = (tổng <:Poise:1513762945715142736>Poise tiêu thụ) x3*`,
      ];
    },
  },
  "chop up": {
    name: "Chop Up", weaponOf: "Bug Arm", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(6,16);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Vung cánh tay bọ đâm vào tim kẻ địch`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Tiếp tục vung bổ chúng ra`,
      ];
    },
  },
  "sabre slash": {
    name: "Sabre Slash", weaponOf: "Family Heir Sabre", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,11);
      return [
        `${D1} **${d1}** — Gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "remise": {
    name: "Remise", weaponOf: "Family Heir Sabre", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,10);
      return [
        `${D1} **${d1}** — Gây 2 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** — Gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "nightmare hunt": {
    name: "Nightmare Hunt", weaponOf: "Family Heir Sabre", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(10,13), d3 = r(13,16), d4 = r(13,16);
      return [
        `${D1} **${d1}** — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D3} **${d3}** — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D4} **${d4}** — Gây 3 <:Sinking:1513762793436741652>Sinking. Nếu địch ≥10 <:Sinking:1513762793436741652>Sinking: tiêu hết và +3 <:DiceUp:1513767795681398894>Dice Up cho bản thân turn này và sau`,
      ];
    },
  },
  "grappling": {
    name: "Grappling", weaponOf: "Brawler", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,15);
      return [
        `*[Hakuda] Nếu xài Critical sau khi xài skill có tag Airborne: dice đổi thành [14~30]*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Quật ngã kẻ địch, gây 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst, nhận 1 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "stob": {
    name: "Stob", weaponOf: "Dolch", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,9), d2 = r(11,15);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Đâm vào bụng kẻ địch, gây 4 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đâm tiếp, gây 4 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "thrust": {
    name: "Thrust", weaponOf: "Dagger", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,8), d2 = r(6,8);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Đâm vào bụng kẻ địch, gây 2 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đâm tiếp, gây 2 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "slice": {
    name: "Slice", weaponOf: "Scythe of Sorrow", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(10,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên xoay lưỡi hái cắt mọi thứ`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Tiếp tục cắt, gắn 6 <:Sinking:1513762793436741652>Sinking (turn sau)`,
      ];
    },
  },
  "breakam slash": {
    name: "Breakam Slash", weaponOf: "Breakam Zeztzer", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "2x",
    roll() {
      const d1 = r(8,20);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Phủ thanh kiếm năng lượng xanh rồi chém ngang cắt đứt kẻ địch`,
      ];
    },
  },
  "breakam bullet": {
    name: "Breakam Bullet", weaponOf: "Breakam Zeztzer: Gun Mode", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "2x",
    roll() {
      const d1 = r(10,17);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unevadeable] [Guard Break] [AOE 3 người] — Tụ lực bắn một đường đạn cực mạnh vào đối phương`,
      ];
    },
  },
  "backflip & shoot": {
    name: "Backflip & Shoot", weaponOf: "Double Handgun", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,9), d2 = r(7,10);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Nhảy lùi ra sau bắn kẻ địch`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Bắn tiếp lần thứ hai`,
      ];
    },
  },
  "blinkstep": {
    name: "Blinkstep", weaponOf: "Mao Branch Sword", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,13);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém kẻ địch hai lần liên tiếp, gây 3 <:Rupture:1513762812722155682>Rupture. Nếu ≥5 <:Haste:1513768004222062632>Haste: tái sử dụng skill này một lần nữa`,
      ];
    },
  },
  "jack of all trades": {
    name: "Jack of All Trades", weaponOf: "Thiên Cỏ Vạn", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,8), d2 = r(3,5), d3 = r(22,35), d4 = r(10,17);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Cung Void`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Dù-Khiên`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — Đại Kiếm`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] — Trường Thương`,
      ];
    },
  },
  "beam of nihil": {
    name: "Beam Of Nihil", weaponOf: "Manifested E.G.O: Nihil", tags: "Weapon",
    cost: "5 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(24,40);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] [Unparriable] [AOE 2 người] — Tạo tia sáng năng lượng hư vô bắn vào kẻ địch. Nhận 7 <:Haste:1513768004222062632>Haste và gây 14 <:Bleed:1513762688226955285>Bleed, 8 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "abyssial life": {
    name: "Abyssial Life", weaponOf: "Manifested E.G.O: Nihil", tags: "Weapon",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,5);
      return [
        `${D1} **${d1}** — Nhận số stack **Nihil** tương ứng. Mỗi Nihil: +10% Dmg, +2% Hút máu (Max 5, mất khi end turn)`,
      ];
    },
  },
  "meaningless struggle": {
    name: "Meaningless Struggle (Phản Kháng Vô Nghĩa)", weaponOf: "Void-Scythe: Nihilism", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,18), d2 = r(21,30);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Uplift] — Hất tung vũ khí địch, áp 6 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Trúng đích, áp 2 Freeble (giảm 4 Dice mọi kỹ năng turn sau)`,
      ];
    },
  },
  "trailing blade": {
    name: "Trailing Blade", weaponOf: "Ages of Harvest", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10), d2 = r(3,12), d3 = r(8,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Điều khiển kiếm xoay vòng quanh bản thân, cắt mọi thứ`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Tiếp tục xoay`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — Tiếp tục xoay`,
      ];
    },
  },
  "overpower": {
    name: "Overpower", weaponOf: "Fixer's Blade", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,15);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Đâm vào bụng kẻ địch rồi nhanh chóng vung bổ xuống, áp 4 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "life taker": {
    name: "Life Taker", weaponOf: "Havoc Scythe", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(17,26);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Vung lưỡi hái hút sinh lực kẻ địch, gây 5 Havoc Bane và hồi máu = 50% Dmg gây ra`,
      ];
    },
  },
  "instant of annihilation": {
    name: "Instant of Annihilation", weaponOf: "Manifested E.G.O (Havoc)", tags: "Weapon",
    cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,12), d2 = r(10,13);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Sải cánh bay lại gần kẻ địch rồi quật bằng cánh`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Tạo ngọn thương Havoc đâm chúng, gây 10 Havoc Bane`,
      ];
    },
  },
  "deadening abyss": {
    name: "Deadening Abyss", weaponOf: "Manifested E.G.O (Havoc)", tags: "Weapon",
    cost: "5 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(21,30);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] [AOE 3 người] — Nổ năng lượng phía trước. +2 <:DiceUp:1513767795681398894>Dice Up cho mỗi Havoc Bane trên kẻ địch, sau đó tiêu toàn bộ`,
      ];
    },
  },
  "solemn lament for the living": {
    name: "Solemn Lament for the Living", weaponOf: "Solemn Lament Pistols", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,8), d2 = r(10,15);
      return [
        `*[Mỗi Dice có thể tốn 5 viên đạn The Living and The Departed để +1 <:DiceUp:1513767795681398894>Dice Up/Dice và +1 <:Sinking:1513762793436741652>Sinking mỗi viên]*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Bắn liên tục vào kẻ địch`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Lao tới bắn phát cuối, gây 3 <:Sinking:1513762793436741652>Sinking. Tùy theo <:Sinking:1513762793436741652>Sinking trên địch: 0 → -2 <:DiceDown:1513767826257874964>Dice Down | 1-19 → 6 <:Bind:1513768025881317457>Bind | ≥20 → 6 Fragile`,
      ];
    },
  },
  "kaen jujizan": {
    name: "Kaen Jūjizan", weaponOf: "Kaenken Rekka", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x (2x nếu địch >10 <:Burn:1513762753691652177>Burn)",
    roll() {
      const d1 = r(6,20);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém kẻ địch, triệu hồi rồng lửa cuốn vòng rồi tung chuỗi chém, gây 6 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "crash hissatsu giri": {
    name: "Crash Hissatsu Giri", weaponOf: "Kaenken Rekka", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1.75x",
    roll() {
      const d1 = r(24,32);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [True DMG] [Guard Break] [Chỉ dùng khi ở Primitive Dragon] — Triệu hồi Void Talon, kéo kẻ địch lại gần rồi tung một đòn chém`,
      ];
    },
  },
  "shinra banshozan": {
    name: "Shinra Banshozan", weaponOf: "Kaenken Rekka", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1.75x",
    roll() {
      const d1 = r(24,32);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Elemental Dragon] — Tích tụ toàn bộ nguyên tố vào kiếm rồi chém kẻ địch, gây 7 Hex`,
      ];
    },
  },
  "barrage": {
    name: "Barrage", weaponOf: "Star Platinum", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,15);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
      ];
    },
  },
  "punishment": {
    name: "Punishment", weaponOf: "Beak Mace", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,30);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Cây chùy biến thành vô số xúc tu nuốt chửng kẻ địch, gây 6 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "piercing": {
    name: "Piercing", weaponOf: "Sharp Spear", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,12);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt đâm xuyên người kẻ địch, gây 9 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "mighty critical finish": {
    name: "Mighty Critical Finish", weaponOf: "Gashacon Breaker", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,19);
      return [
        `${D1} **${d1}** [Blunt/Slash] — Phủ năng lượng vào vũ khí rồi tấn công. Chắc chắn crit; dmg type đổi theo dạng vũ khí đang dùng`,
      ];
    },
  },
  "mighty critical strike": {
    name: "Mighty Critical Strike", weaponOf: "Gamer Driver", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10), d2 = r(10,18);
      return [
        `**[<:Blunt:1513768529718022254>Blunt] — Chắc chắn crit**`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Nhảy vào đá kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Liên tục đá rồi kết thúc bằng một đòn đá mạnh`,
      ];
    },
  },
  "mighty double critical strike": {
    name: "Mighty Double Critical Strike", weaponOf: "Gamer Driver", tags: "Weapon",
    cost: "Chỉ khi ở Level 20", cd: "2 Turn", diceMul: "2x",
    roll() {
      const d1 = r(5,10), d2 = r(10,18);
      return [
        `**[<:Blunt:1513768529718022254>Blunt] — Chắc chắn crit**`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Cùng bản thể còn lại nhảy vào đá kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Cả hai liên tục đá rồi kết thúc bằng một đòn đá mạnh`,
      ];
    },
  },

  // ── Lævateinn ──
  "stomping": {
    name: "Stomping", weaponOf: "Lævateinn", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,13), d2 = r(10,15);
      return [
        `*+5% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Dặm đất, gây 5 Fragile`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Đá vào kẻ địch, gây 5 Fragile và 1 <:VengeanceMark:1513768136023740436>Vengeance Mark`,
      ];
    },
  },
  "ill gut you like a fish": {
    name: "I'll Gut You Like a Fish", weaponOf: "Lævateinn [Seal 1+]", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(12,13), d3 = r(11,12);
      return [
        `*+5% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Đá kẻ địch lên trời, gây 5 Fragile`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Chém chúng bằng thanh kiếm, gây 5 Fragile`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Cắt ngay lập tức, gây 5 Fragile và 1 <:VengeanceMark:1513768136023740436>Vengeance Mark`,
      ];
    },
  },
  "dont let somethin like this break you": {
    name: "Don't Let Somethin' Like This Break You!", weaponOf: "Lævateinn [Seal 1+]", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,12), d2 = r(12,13), d3 = r(11,15);
      return [
        `*+5% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Bổ cự kiếm vào kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Quẹt ngang ngay lập tức`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Vung lên, gây 1 <:VengeanceMark:1513768136023740436>Vengeance Mark`,
      ];
    },
  },
  "gut stab laevateinn": {
    name: "Gut Stab [Lævateinn]", weaponOf: "Lævateinn [Seal 2+]", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(12,13), d3 = r(7,7), d4 = r(8,8), d5 = r(10,13);
      return [
        `*+5% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch* [Unblockable]`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Đá kẻ địch lên trời`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Quẹt ngang ngay lập tức`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Đâm thanh kiếm vào kẻ địch`,
        `${D4} **${d4}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Tiếp tục đâm liên tục`,
        `${D5} **${d5}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Rút ra rồi kết thúc bằng một đòn đâm, gây 1 <:VengeanceMark:1513768136023740436>Vengeance Mark`,
      ];
    },
  },
  "stamp of vengeance maximum": {
    name: "Stamp of Vengeance [Maximum]", weaponOf: "Lævateinn", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,12), d2 = r(7,8), d3 = r(13,15), d4 = r(16,24);
      return [
        `*+10% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] — Đá kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] — Ngay sau đó là một cú đá lên`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] — Lấy đà thêm một cú nữa`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] — Nhảy lên trời rồi chốt hạ bằng một đòn chẻ bằng chân. Cho bản thân **2 Stack Rising Fever**`,
      ];
    },
  },
  "complete and total extermination laevateinn": {
    name: "Complete and Total Extermination [Lævateinn]", weaponOf: "Lævateinn [Seal 3]", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,12), d2 = r(12,13), d3 = r(13,15), d4 = r(18,24), d5 = r(30,35);
      return [
        `*+10% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `*Skill này luôn dùng Dice cuối để clash; nếu clash thua, kẻ địch nhận 30% Dmg gốc*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unevadeable] [Guard Break] — Bổ kiếm vào kẻ địch`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unevadeable] [Guard Break] — Quẹt ngang ngay lập tức`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Unevadeable] [Guard Break] — Vung lên, gây 1 <:VengeanceMark:1513768136023740436>Vengeance Mark`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] [Unevadeable] [Guard Break] — Vung xuống một cú mạnh`,
        `${D5} **${d5}** [<:Pierce:1513768511179329556>Pierce] [Unevadeable] [Guard Break] — Ném thanh kiếm găm vào lồng ngực rồi nhảy vào đá xuyên qua kẻ địch, kết liễu chúng`,
      ];
    },
  },
  "good girl your sacrifice for the family wont be forgotten": {
    name: "Good Girl. Your Sacrifice for the Family Won't Be Forgotten.", weaponOf: "Lævateinn [Seal 3]", tags: "Weapon",
    cost: "Chỉ dùng khi đồng minh dưới 20% HP (50% nếu từ Middle)", cd: "—", diceMul: "1x",
    roll() {
      const d1 = r(18,24);
      return [
        `*+10% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unclashable] [Undodgeable] [Unparriable] [Unblockable] — Khi đồng đội chuẩn bị chết, cắt cả hai ra, giết chết đồng minh và gây sát thương lên kẻ địch`,
      ];
    },
  },
};

// Alias map để tìm skill linh hoạt hơn
const SKILL_ALIASES = {
  "fare thee well": "fare-thee well",
  "fareewell": "fare-thee well",
  "farewell": "fare-thee well",
  "justagvengeance": "just a vengeance",
  "jav": "just a vengeance",
  "extractfuel": "extract fuel",
  "stampofvengeance": "stamp of vengeance",
  "sov": "stamp of vengeance",
  "cate": "complete and total extermination",
  "c&te": "complete and total extermination",
  "completete": "complete and total extermination",
  "followingtheflow": "following the flow",
  "ftf": "following the flow",
  "wib": "waltz in black",
  "waltzblack": "waltz in black",
  "wiw": "waltz in white",
  "waltzwhite": "waltz in white",
  "lightattack": "light attack",
  "slashseries": "slash series",
  "executeprescript": "execute prescript",
  "ep": "execute prescript",
  "willofthecity": "will of the city",
  "wotc": "will of the city",
  "dodgeandstrike": "dodge and strike",
  "das": "dodge and strike",
  "soulburn": "soulburn",
  "infernoburst": "inferno burst",
  "ib": "inferno burst",
  "takethiskid": "take this kid",
  "ttk": "take this kid",
  "learnagainkid": "learn again kid",
  "learnakaink": "learn again kid",
  "lak": "learn again kid",
  "catchbreath": "catch breath",
  "cb": "catch breath",
  "shadowcloudshattercleaver": "shadowcloud shattercleaver",
  "scs": "shadowcloud shattercleaver",
  "furioso": "furioso",
  "weightofknowledge": "weight of knowledge",
  "wok": "weight of knowledge",
  "illuminatethyvacuity": "illuminate thy vacuity",
  "itv": "illuminate thy vacuity",
  "studiousdedication": "studious dedication",
  "sd": "studious dedication",
  "scorchknowledge": "scorch knowledge",
  "sk": "scorch knowledge",
  "excruiciatingstudy": "excruciating study",
  "excruiatingstudy": "excruciating study",
  "es": "excruciating study",
  "sanguinepainting": "sanguine painting",
  "sp": "sanguine painting",
  "hematiccoloring": "hematic coloring",
  "hc": "hematic coloring",
  "sanguinepointilism": "sanguine pointilism",
  "pointilism": "sanguine pointilism",
  "perfecteddeathfist": "perfected death fist",
  "pdf": "perfected death fist",
  "ragingstorm": "raging storm",
  "rs": "raging storm",
  "fierywaltz": "fiery waltz",
  "fw": "fiery waltz",
  "redkick": "red kick",
  "rk": "red kick",
  "flowingflame": "flowing flame",
  "ff": "flowing flame",
  "fleetedge": "fleet edge",
  "fe": "fleet edge",
  "flowofthesword": "flow of the sword",
  "fots": "flow of the sword",
  "violentflame": "violent flame",
  "vf": "violent flame",
  "formingstorm": "forming storm",
  "fs": "forming storm",
  "extremeedge": "extreme edge",
  "ee": "extreme edge",
  "flyingsword": "flying sword",
  "fsd": "flying sword",
  "boundaryofdeath": "boundary of death",
  "bod": "boundary of death",
  "overbreath": "overbreath",
  "ob": "overbreath",
  "xuatluctoida": "xuất lực tối đa",
  "xltd": "xuất lực tối đa",
  "levelslash": "level slash",
  "ls": "level slash",
  "focusspirit": "focus spirit",
  "fsp": "focus spirit",
  "upstandingslash": "upstanding slash",
  "us": "upstanding slash",
  "greatsplitvertical": "great split vertical",
  "gsv": "great split vertical",
  "greatsplithorizontal": "great split horizontal",
  "gsh": "great split horizontal",
  "dimensionalriftdagger": "dimensional rift dagger",
  "drd": "dimensional rift dagger",
  "dimensionalriftgauntlets": "dimensional rift gauntlets",
  "drg": "dimensional rift gauntlets",
  "sharpcuts": "sharp cuts",
  "sc": "sharp cuts",
  "chargeshield": "charge shield",
  "cs": "charge shield",
  "overchargedripple": "overcharged ripple",
  "ocr": "overcharged ripple",
  "moonspittingdraw": "moon-splitting draw",
  "moonsplittingdraw": "moon-splitting draw",
  "msd": "moon-splitting draw",
  "redplumblossomscatter": "red plum blossom scatter",
  "rpbs": "red plum blossom scatter",
  "yieldmyflesh": "yield my flesh",
  "ymf": "yield my flesh",
  "toclaimtheirbones": "to claim their bones",
  "tctb": "to claim their bones",
  // New skills
  "dissecttarget": "dissect target",
  "dt": "dissect target",
  "sandsplit": "sand split",
  "mirageincision": "mirage incision",
  "mi": "mirage incision",
  "khopeshswordplay": "khopesh swordplay",
  "ks": "khopesh swordplay",
  "bladewhirl": "blade whirl",
  "bw": "blade whirl",
  "clientprotection": "client protection",
  "cp": "client protection",
  "lawandorder": "law and order",
  "lao": "law and order",
  "augurycrusher": "augury crusher",
  "auginfusion": "augury infusion",
  "ai": "augury infusion",
  "augurykick": "augury kick",
  "ak": "augury kick",
  "celestialsight": "celestial sight",
  "lupineonslaught": "lupine onslaught",
  "lo": "lupine onslaught",
  "kickandstomps": "kick and stomps",
  "kas": "kick and stomps",
  "rapaciousassault": "rapacious assault",
  "ra": "rapacious assault",
  "pitchblackpulverizer": "pitch-black pulverizer",
  "pbp": "pitch-black pulverizer",
  "cloudcutter": "cloud cutter",
  "cc": "cloud cutter",
  "skyclearingcut": "sky clearing cut",
  "scc": "sky clearing cut",
  "darkcloudcleaver": "dark cloud cleaver",
  "dcc": "dark cloud cleaver",
  "soberup": "sober up",
  "shadowcloudkick": "shadowcloud kick",
  "sck": "shadowcloud kick",
  "silentmist": "silent mist",
  "somberprocuration": "somber procuration",
  "spro": "somber procuration",
  "trashdisposal": "trash disposal",
  "td": "trash disposal",
  "bladeflourish": "blade flourish",
  "bf": "blade flourish",
  // Degraded Fairy skills
  "degradedfairy": "degraded fairy",
  "dfa": "degraded fairy",          // "df" cũ đổi sang "dfa" để tránh nhầm với magic bullet df
  "degradedpillar": "degraded pillar",
  "dp": "degraded pillar",
  "degradedlock": "degraded lock",
  "dl": "degraded lock",
  "degradedshockwave": "degraded shockwave",
  "ds": "degraded shockwave",
  "apocalypse": "apocalypse",
  "apo": "apocalypse",
  // Magic Bullet Der Freischütz aliases — "df" được dành riêng cho skill này
  "df": "magic bullet df",
  "mdf": "magic bullet df",
  "mbdf": "magic bullet df",
  "magicbulletdf": "magic bullet df",
  // Lævateinn
  "stomping": "stomping",
  "illgutyoulikeafish": "ill gut you like a fish",
  "ilgutfish": "ill gut you like a fish",
  "igylaf": "ill gut you like a fish",
  "dontletthisbreakme": "dont let somethin like this break you",
  "dontletbreakyou": "dont let somethin like this break you",
  "dlbky": "dont let somethin like this break you",
  "gutstablaevateinn": "gut stab laevateinn",
  "gutstabla": "gut stab laevateinn",
  "gsla": "gut stab laevateinn",
  "stampmaximum": "stamp of vengeance maximum",
  "sovm": "stamp of vengeance maximum",
  "stampmaxlaevateinn": "stamp of vengeance maximum",
  "catelaevateinn": "complete and total extermination laevateinn",
  "catela": "complete and total extermination laevateinn",
  "goodgirl": "good girl your sacrifice for the family wont be forgotten",
  "yoursacrifice": "good girl your sacrifice for the family wont be forgotten",
};

function findSkill(raw) {
  const key = raw.toLowerCase().trim();
  if (SKILLS[key]) return SKILLS[key];
  const aliasKey = SKILL_ALIASES[key.replace(/[\s\-,]/g, "").replace(/\s+/g, " ")];
  if (aliasKey && SKILLS[aliasKey]) return SKILLS[aliasKey];
  // Fuzzy: tìm skill nào có tên chứa input
  // Thử strip số hoặc args cuối (VD: "solemn lament 5" → "solemn lament")
  const keyStripped = key.replace(/\s+\S+$/, "").trim();
  for (const [k, v] of Object.entries(SKILLS)) {
    if (k.includes(key) || (keyStripped && k.includes(keyStripped) && keyStripped.length >= 3)) return v;
  }
  return null;
}

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
  // Cú pháp: -Caduceus [số lần] — roll Prescript nhiều lần
  if (message.content.toLowerCase().startsWith("-caduceus")) {
    if (isOnCooldown(message.author.id, "caduceus", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const CADUCEUS_MAX = 20;
    // dùng PRESCRIPT_TABLE global
    const arg = message.content.replace(/-caduceus/i, "").trim();
    const timesRaw = parseInt(arg, 10);
    const times = (!isNaN(timesRaw) && timesRaw > 0) ? timesRaw : 1;
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
    if (rolls > 50) {
      message.reply("❌ Số lần roll tối đa là 50.");
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

  // ── -rtparry  (Parry thời gian thực) ──────────────────────────────────────
  if (message.content.startsWith("-rtparry")) {
    if (isOnCooldown(message.author.id, "parryrt", 5000)) {
      message.reply("⏳ Chờ **5 giây** trước khi thử parry tiếp nhé.");
      return;
    }

    // ID phiên duy nhất — dùng làm customId nút để tra lại session khi click
    const sessionId = `${message.author.id}_${Date.now()}`;
    const customId  = `parryrt_${sessionId}`;

    // Thời gian chờ random 1.5s – 4.5s → mô phỏng "đòn đang đến"
    const waitMs   = 1_500 + Math.floor(Math.random() * 3_000);
    // Cửa sổ parry random 700ms – 1100ms
    const windowMs = 700   + Math.floor(Math.random() * 400);

    // ── Gửi tin nhắn — Pha 1 (Waiting): nút disabled, màu xám ──
    let sentMsg;
    try {
      sentMsg = await message.reply({
        embeds: [{
          title: "⚔️ Thử thách Parry",
          description: "Hãy sẵn sàng… Nhấn nút **đúng khi đòn đánh đến**!\n\n*Bấm sớm hoặc bỏ lỡ đều thất bại.*",
          color: 0xf39c12,
          footer: { text: "Đang chờ đòn đánh..." },
        }],
        components: [buildParryRow(customId, "⚠️  Đòn đánh đang đến…", ButtonStyle.Secondary, true)],
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
      windowTimer: null,
      expireTimer: null,
    };
    activeParrySessions.set(sessionId, session);

    // ── Pha 2: Mở cửa sổ parry sau waitMs ──────────────────────────────────
    session.windowTimer = setTimeout(async () => {
      if (session.responded) return;

      try {
        await sentMsg.edit({
          embeds: [{
            title: "⚔️ Thử thách Parry",
            description: "## ⚡ BÂY GIỜ! PARRY!",
            color: 0x2ecc71,
          }],
          components: [buildParryRow(customId, "⚔️  P A R R Y !", ButtonStyle.Success, false)],
        });
        // windowStart đặt SAU KHI edit thành công → thời gian phản ứng chính xác hơn
        session.phase = "window";
        session.windowStart = Date.now();
      } catch {
        // Tin nhắn bị xóa hoặc mất quyền edit → huỷ phiên
        session.responded = true;
        activeParrySessions.delete(sessionId);
        return;
      }

      // ── Pha 3: Đóng cửa sổ → tự fail nếu chưa ai bấm ──────────────────
      session.expireTimer = setTimeout(async () => {
        if (session.responded) return;
        session.phase = "expired";
        session.responded = true;
        activeParrySessions.delete(sessionId);

        await sentMsg.edit({
          embeds: [{
            title: "Parry Real Time",
            description:
              `${message.author} đã **bỏ lỡ** đòn! ❌\n` +
              `> Cửa sổ parry: **${windowMs}ms** — chậm quá!`,
            color: 0xe74c3c,
            footer: { text: "Dùng -rtparry để thử lại" },
          }],
          components: [buildParryRow(customId, "✗  Bỏ lỡ!", ButtonStyle.Danger, true)],
        }).catch(() => {});
      }, windowMs);

    }, waitMs);

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
      const embed = await buildInventoryEmbed(targetUser);
      if (!embed) {
        message.reply(`📦 ${targetUser} không có gì trong kho.`);
        return;
      }
      message.reply(embed);
    } catch (err) {
      log("error", "inventory", targetUser.id, err.message);
      message.reply("❌ Có lỗi xảy ra khi lấy dữ liệu.");
    }
    return;
  }

  // ── -give ──
  if (message.content.startsWith("-give")) {
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
    const expGain = parseInt(kv["exp"] ?? "0", 10) || 0;
    const ahnGain = parseFloat(kv["ahn"] ?? "0") || 0;
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
    const expRemove = parseInt(kv["exp"] ?? "0", 10) || 0;
    const ahnRemove = parseFloat(kv["ahn"] ?? "0") || 0;
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
    const ahnValue = ahnAddRaw ? parseFloat(ahnAddRaw.replace("+", "")) || 0 : null;
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
          const data = await getPlayerData(targetUser.id);
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
          await savePlayerData(targetUser.id, data);
          return { targetUser, changes };
        })
      )
    );

    const lines = results.map((r, i) => {
      const user = targetUsers[i];
      if (r.status === "fulfilled") {
        const { changes } = r.value;
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
      await withLock(userId, async () => {
        const { outputLines, costLines } = await executeCraft(userId, itemName, craftCount);
        message.reply(
          `⚒️ ${message.author} đã craft thành công!\n` +
          `> 🎁 Nhận được: ${outputLines.join(", ")}\n` +
          `> 📦 Nguyên liệu đã dùng:\n` +
          costLines.map(l => `> ${l}`).join("\n")
        );
      });
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
      { name: "⚔️ -parry [số]", value: "Roll kiểm tra parry (Attacker d16 vs Defender d20, hòa thì roll lại). Tối đa 50 lần.\n> VD: `-parry` hoặc `-parry 10`", inline: false },
      { name: "🎯 -rtparry", value: "Parry thời gian thực! Nhấn nút đúng khi đòn đánh đến.\n> Bấm sớm = ❌ thất bại | Bỏ lỡ cửa sổ = ❌ thất bại | Đúng lúc = ✅ thành công\n> Cửa sổ parry thay đổi mỗi lần", inline: false },
      { name: "🎲 -rolldice <range> [x<lần>], ...", value: ["Roll dice theo range tùy chỉnh. Mỗi dice có thể có số lần riêng.", "> `-rolldice <min>-<max>` — roll 1 lần", "> `-rolldice <min>-<max> x<lần>` — roll nhiều lần (tối đa 20)", "> `-rolldice <range> x<lần>, <range>, <range> x<lần>` — nhiều dice, mỗi dice có số lần riêng (tối đa 10 dice)", "> VD: `-rolldice 3-7` | `-rolldice 3-7 x5` | `-rolldice 3-17 x14, 2-4, 2-7 x3`"].join("\n"), inline: false },
      { name: "📊 -math [...]", value: ["Tính damage theo hệ thống game.", "> `dmg:` `res:` `bonus:` `critmul:` `critdiv: <số|yes|no>`", "> `critdiv: 2` = Overbearing (÷2) | `critdiv: 1.5` = Steady Breathing (÷1.5) | `critdiv: yes` = ÷2", "> `sanity:` `sanitybonus:` `sinking:` `rupture:` `dicemul:`", "> `poise: <stacks>` — Starting <:<:Poise:1513762945715142736>Poise:1513762945715142736><:Poise:1513762945715142736>Poise stacks (1 stack = 5% crit, tối đa 99)", "> VD: `-math dmg: 10B poise: 10 critmul: 1.3`"].join("\n"), inline: false },
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
    const { count, error } = parseOpenCount(args[0], 20);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results } = await handleOpenChipboardCache(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Chipboard Cache** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Chipboard Cache", results, remainingCount: data.items["Chipboard Cache"] ?? 0 });
      message.reply({ embeds: [{ title: `🔩 Mở Chipboard Cache${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0xe67e22, description: desc }] });
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
    const { count, error } = parseOpenCount(args[0], 20);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results } = await handleOpenSealedBook(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Sealed Book Cache** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Sealed Book Cache", results, remainingCount: data.books["Sealed Book Cache"] ?? 0 });
      message.reply({ embeds: [{ title: `🔮 Mở Sealed Book Cache${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0x9b59b6, description: desc }] });
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
    const { count, error } = parseOpenCount(args[0], 20);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results } = await handleOpenRandomBook(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Random Book** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Random Book", results, remainingCount: data.books["Random Book"] ?? 0 });
      message.reply({ embeds: [{ title: `📖 Mở Random Book${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0x2ecc71, description: desc }] });
    } catch (err) {
      log("error", "randombook", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
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
        "> Định dạng dmg: `<số>[x<lần>][+<extra>%] [Dice]<B|P|S>[+<:Sinking:1513762793436741652>Sinking][+<:Rupture:1513762812722155682>Rupture][+<:Poise:1513762945715142736>Poise][+Crit<n>]`"
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
    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit });
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
      bonusPct,
      sanityBonusPct,
      critMul,
      poiseInit,
      critDiv,
      sanityInit,
      diceMul,
      sinkingInit,
      ruptureInit,
    }));
    return;
  }

  // ── -huntermath ──
  if (message.content.startsWith("-huntermath")) {
    if (isOnCooldown(message.author.id, "huntermath", 2000)) { message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé."); return; }
    const input = message.content.replace("-huntermath", "").trim();
    const kv = parseKeyValues(input);
    message.reply(calcHunterMath({
      dmgBaseWeapon: parseFloat(kv["dmgbaseweapon"] ?? "0"),
      bonusPct: parseFloat((kv["bonus"] ?? "0").replace("%", "")),
      statValue: parseFloat(kv["stat"] ?? "0"),
      scaleSkillPct: parseFloat((kv["scaleskill"] ?? "0").replace("%", "")),
      dmgNegationPct: parseFloat((kv["dmgnegationboss"] ?? "0").replace("%", "")),
      vulnerabilityPct: parseFloat((kv["vulnerability"] ?? "0").replace("%", "")),
      buffDmgBonus: parseFloat(kv["buffbonus"] ?? "0"),
    }));
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
        ephemeral: true,
      }).catch(() => {});
    }

    // Race condition guard — session đã xử lý xong
    if (session.responded) {
      return interaction.reply({
        content: "⚠️ Phiên parry đã kết thúc.",
        ephemeral: true,
      }).catch(() => {});
    }

    const now = Date.now();
    session.responded = true;
    clearTimeout(session.windowTimer);
    clearTimeout(session.expireTimer);
    activeParrySessions.delete(sessionId);

    const { customId } = interaction;

    // ── Bấm quá sớm (pha "waiting") ─────────────────────────────────────────
    // Lưu ý: nút bị disabled ở pha này nên bình thường không click được.
    // Đây chỉ là safety net cho edge case (client lạ, race condition cực hiếm).
    if (session.phase === "waiting") {
      return interaction.update({
        embeds: [{
          title: "⚔️ Thử thách Parry",
          description:
            `${interaction.user} bấm **quá sớm**! ❌\n` +
            `> Đòn đánh chưa đến — cần kiên nhẫn hơn.`,
          color: 0xe74c3c,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
        components: [buildParryRow(customId, "✗  Quá sớm!", ButtonStyle.Danger, true)],
      }).catch(() => {});
    }

    // ── Bấm trong cửa sổ → PARRY THÀNH CÔNG ────────────────────────────────
    if (session.phase === "window") {
      const reactionMs = now - session.windowStart;
      const rating =
        reactionMs < 200 ? "🏆 Phản ứng SIÊU NHANH!" :
        reactionMs < 400 ? "⚡ Phản ứng rất nhanh!"   :
        reactionMs < 650 ? "✅ Phản ứng tốt!"          :
                           "😅 Vừa kịp!";

      return interaction.update({
        embeds: [{
          title: "⚔️ Thử thách Parry",
          description:
            `${interaction.user} **PARRY THÀNH CÔNG!** ✅\n` +
            `> ⚡ Phản ứng: **${reactionMs}ms** — ${rating}\n` +
            `> Cửa sổ parry: **${session.windowMs}ms**`,
          color: 0x2ecc71,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
        components: [buildParryRow(customId, "✓  Parry thành công!", ButtonStyle.Success, true)],
      }).catch(() => {});
    }

    // ── Cửa sổ vừa đóng (race condition cực hiếm: expireTimer chạy đúng lúc này) ──
    return interaction.reply({
      content: "⚠️ Cửa sổ parry vừa đóng — chậm mất rồi!",
      ephemeral: true,
    }).catch(() => {});
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
async function replyOnCooldown(interaction, ms) {
  if (!isOnCooldown(interaction.user.id, interaction.commandName, ms)) return false;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `⏳ Bạn dùng lệnh này quá nhanh, chờ ${ms / 1000} giây nhé.` });
    } else {
      await interaction.reply({ content: `⏳ Bạn dùng lệnh này quá nhanh, chờ ${ms / 1000} giây nhé.`, ephemeral: true });
    }
  } catch {
    // Interaction có thể đã expired — bỏ qua
  }
  return true;
}

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
          "> VD: `10B`, `5x3B`, `8S+Crit50`, `DiceB`"
      });
      return;
    }
    const poiseInit = interaction.options.getInteger("poise") ?? 0;
    const critMul = interaction.options.getNumber("critmul") ?? 1;
    const diceMul = interaction.options.getNumber("dicemul") ?? 1;
    const sinkingInit = interaction.options.getNumber("sinking") ?? 0;
    const ruptureInit = interaction.options.getNumber("rupture") ?? 0;
    const sanityInit = interaction.options.getNumber("sanity") ?? 0;
    const bonusPct = interaction.options.getNumber("bonus") ?? 0;
    const sanityBonusPct = interaction.options.getNumber("sanitybonus") ?? 0;
    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit });
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
      bonusPct,
      sanityBonusPct,
      critMul,
      poiseInit,
      critDiv: critDivSlash,
      sanityInit,
      diceMul,
      sinkingInit,
      ruptureInit,
    }));
    return;
  }

  if (interaction.commandName === "huntermath") {
    if (await replyOnCooldown(interaction, 2000)) return;
    await interaction.deferReply();
    await interaction.editReply(calcHunterMath({
      dmgBaseWeapon: interaction.options.getNumber("dmgbaseweapon") ?? 0,
      bonusPct: interaction.options.getNumber("bonus") ?? 0,
      statValue: interaction.options.getNumber("stat") ?? 0,
      scaleSkillPct: interaction.options.getNumber("scaleskill") ?? 0,
      dmgNegationPct: interaction.options.getNumber("dmgnegationboss") ?? 0,
      vulnerabilityPct: interaction.options.getNumber("vulnerability") ?? 0,
      buffDmgBonus: interaction.options.getNumber("buffbonus") ?? 0,
    }));
    return;
  }

  if (interaction.commandName === "parry") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const rolls = Math.min(interaction.options.getInteger("rolls") ?? 1, 50);
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
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), 20);
    try {
      const { success, data, results } = await handleOpenRandomBook(userId, count);
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
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), 20);
    try {
      const { success, data, results } = await handleOpenSealedBook(userId, count);
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
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), 20);
    try {
      const { success, data, results } = await handleOpenChipboardCache(userId, count);
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
      const embed = await buildInventoryEmbed(targetUser);
      if (!embed) {
        await interaction.editReply({ content: `📦 ${targetUser} không có gì trong kho.` });
        return;
      }
      await interaction.editReply(embed);
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
      await withLock(userId, async () => {
        const { outputLines, costLines } = await executeCraft(userId, itemName, craftCount);
        await interaction.editReply({
          content:
            `⚒️ ${interaction.user} đã craft thành công!\n` +
            `> 🎁 Nhận được: ${outputLines.join(", ")}\n` +
            `> 📦 Nguyên liệu đã dùng:\n` +
            costLines.map(l => `> ${l}`).join("\n"),
        });
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

    const ahnGain = interaction.options.getNumber("ahn") ?? 0;
    const bookRaw = interaction.options.getString("book") ?? null;
    const bookCount = Math.max(1, interaction.options.getInteger("bookcount") ?? 1);
    const itemRaw = interaction.options.getString("item") ?? null;
    const itemCount = Math.max(1, interaction.options.getInteger("itemcount") ?? 1);

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
    if (ahnGain === 0 && !bookName && !itemName) {
      await interaction.editReply({ content: "❌ Cần chỉ định ít nhất một trong: `ahn`, `book`, `item`." });
      return;
    }

    try {
      // Dùng withDoubleLock nhất quán cho cả admin lẫn non-admin
      const runGive = () => executeGive({
        senderId: interaction.user.id,
        targetId: targetUser.id,
        isAdmin, ahnGain, bookName, bookCount, itemName, itemCount,
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
    const ahnRemove = interaction.options.getNumber("ahn") ?? 0;
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
  } catch (err) {
    log("error", "interactionCreate", interaction.user?.id ?? "unknown", err.message, { cmd: interaction.commandName });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Có lỗi không mong muốn xảy ra.", ephemeral: true }).catch(() => {});
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
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => log("error", "uncaughtException", "system", err.message, { stack: err.stack }));
process.on("unhandledRejection", (reason) => log("error", "unhandledRejection", "system", String(reason)));
