// index.js
const { Client, GatewayIntentBits } = require("discord.js");
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
const POISE_CRIT_HALVE = 0.5;
const SINKING_MAX = 99;
const RUPTURE_MAX = 99;

// ─── DAILY REWARDS ────────────────────────────────────────────────────────────
const DAILY_EXP_REWARD = 5;
const DAILY_AHN_REWARD = 100_000;
const DAILY_STREAK_EXP_BONUS = 25;
const DAILY_STREAK_AHN_BONUS = 400_000;
const DAILY_KEY_TTL_SECONDS = 86400 * 3;

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

const ADMIN_IDS = new Set([
  "208187560692940803",
  "1072123095739019346",
  "675899106614575150",
]);

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
const VALID_BOOKS_EXTRA = ["Random Book", "Sealed Book Cache", "Book of Choice"];
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
const _KV_KEY_RE = new RegExp(_KV_KEY_RE_SRC, "gi");

function parseKeyValues(input) {
  _KV_KEY_RE.lastIndex = 0;
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
    const v = String(f.value).trim();
    if (v === "0") return false;
    if (v === "0.0%") return false;
    if (v === "0.00%") return false;
    if (v === "0.00x") return false;
    if (v === "1.00x") return false;
    if (v === "No") return false;
    return true;
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
  const parsed = parseInt(raw);
  if (!isNaN(parsed) && parsed <= 0) return { error: `❌ Số lần mở phải lớn hơn 0.` };
  const count = (!isNaN(parsed) && Number.isFinite(parsed) && parsed > 0) ? parsed : 1;
  if (count > max) return { error: `❌ Số lần mở tối đa là ${max}.` };
  return { count };
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
    critDiv = false,
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

    // Sinking & Rupture: dùng stack hiện tại để tính dmg bonus trước,
    // sau đó mới trừ 1 stack — đòn hiện tại không hưởng lợi từ stack nó vừa tự áp.
    let sinkingBonus = 0;
    if (enemySinking > 0) {
      sanity = Math.max(sanity - 1, SANITY_MIN);
      if (sanity <= SANITY_MIN || isNaN(sanity)) {
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

    instanceResults.push({
      dmg, dmgType, didCrit, critChance, poiseOverflow,
      poiseStacksAfter: totalPoise,
      instanceDmg, ruptureBonus, sinkingBonus,
      sinkingApplied: sinkingToApply,
      ruptureApplied: ruptureToApply,
      poiseApplied: poiseToApply,
      effectsStr, isDice,
    });

    if (didCrit && critDiv) {
      totalPoise = Math.floor(totalPoise * POISE_CRIT_HALVE);
      if (totalPoise < POISE_RESET_THRESHOLD) totalPoise = 0;
    }
  }

  const finalPoiseStacks = totalPoise;
  const critCount = instanceResults.filter((r) => r.didCrit).length;

  const breakdownLines = instanceResults.map((r, i) => {
    const rateStr = `${(r.critChance * 100).toFixed(1)}%`;
    const critLabel = r.didCrit ? "✅" : "❌";
    let extraInfo = "";
    if (r.poiseOverflow > 0) {
      const wastedStacks = Math.round(r.poiseOverflow / POISE_CRIT_BONUS_PER_STACK);
      extraInfo += ` | ${wastedStacks} Poise dư`;
    }
    if (r.sinkingBonus > 0) extraInfo += ` | +${r.sinkingBonus} dmg từ Sinking`;
    if (r.sinkingApplied > 0) extraInfo += ` | áp ${r.sinkingApplied} Sinking`;
    if (r.ruptureBonus > 0) extraInfo += ` | +${r.ruptureBonus} dmg từ Rupture`;
    if (r.ruptureApplied > 0) extraInfo += ` | áp ${r.ruptureApplied} Rupture`;
    if (r.poiseApplied > 0) extraInfo += ` | +${r.poiseApplied} Poise → ${r.poiseStacksAfter} stacks`;
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
  const poiseDisplay = critDiv && critCount > 0
    ? `${poiseInit} → ${finalPoiseStacks} stacks (after ${critCount} crit${critCount > 1 ? "s" : ""})`
    : `${poiseInit} stacks (${(startingCritRate * 100).toFixed(0)}% crit)`;

  const resDisplay = `B: ${resValues.B}x | P: ${resValues.P}x | S: ${resValues.S}x`;

  const allFields = [
    { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
    { name: "% Dmg Bonus", value: bonusPct.toFixed(1) + "%", inline: true, alwaysShow: true },
    { name: "Sanity % DMG Bonus", value: sanityBonusPct.toFixed(1) + "%", inline: true },
    { name: "CritMul", value: critMul + "x", inline: true, alwaysShow: true },
    { name: "Res Multipliers", value: resDisplay, inline: true, alwaysShow: true },
    { name: "Dice Multiplier", value: diceMul.toFixed(2) + "x", inline: true },
    { name: "Poise Stacks", value: poiseDisplay, inline: true, alwaysShow: true },
    { name: "Crit Divide", value: critDiv ? "Yes" : "No", inline: true },
    { name: "Final DMG", value: totalDmg.toFixed(3), inline: false, alwaysShow: true },
    { name: "Enemy's Sanity", value: sanity.toString(), inline: true },
    { name: "Remaining Poise", value: finalPoiseStacks.toString(), inline: true },
    { name: "Enemy's Sinking Counts", value: enemySinking.toString(), inline: true },
    { name: "Enemy's Rupture Counts", value: enemyRupture.toString(), inline: true },
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
  const entries = [];
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(.+?)\s+x(\d+)$/i);
    if (!match) {
      return { error: `❌ Định dạng ${entityLabel} sai: \`${part}\`\nĐúng: \`Tên ${entityLabel === "sách" ? "Sách" : "Item"} x<số>\` (VD: \`${entityLabel === "sách" ? "Random Book x2" : "Chipboard MK1 x3"}\`)` };
    }
    // Validate count > 0 trước khi xử lý
    const count = parseInt(match[2], 10);
    if (count <= 0) {
      return { error: `❌ Số lượng ${entityLabel} phải lớn hơn 0: \`${part}\`` };
    }
    const name = findFn(match[1].trim());
    if (!name) return { error: `❌ Tên ${entityLabel} không hợp lệ: \`${match[1].trim()}\`` };
    entries.push({ name, count });
  }
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
    cost: "3 Light", cd: "2 Turn", diceMul: "0.8x",
    roll() {
      const d1 = r(6,7), d2 = r(7,8), d3 = r(10,15);
      return [
        `${D1} **${d1}** [Slash] — gây 1 Bleed ở turn kế và nhận 3 Poise`,
        `${D2} **${d2}** [Slash] — gây 1 Bleed ở turn kế và nhận 3 Poise`,
        `${D3} *Nếu bản thân có trên 10 Poise, Dice 3 nhận 5 Dice Up*`,
        `${D3} **${d3}** [Slash] [Guard Break] — gây 4 Bleed ở turn kế và nhận 4 Poise`,
      ];
    },
  },
  "purify": {
    name: "Purify",
    cost: "3 Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,16), d2 = r(8,12), d3 = r(12,16);
      return [
        `${D1} **${d1}** [Pierce] [Undodgeable] [Unblockable] — gây 2 Nail`,
        `${D2} **${d2}** [Pierce] [Undodgeable] [Unblockable] — gây 2 Nail`,
        `${D3} **${d3}** [Pierce] [Undodgeable] [Unblockable] — gây 3 Nail và 1 Paralyze`,
        `${D3} Gây 1 Gaze — nếu địch có trên 7 Nails sẽ mất toàn bộ stack vượt quá 7`,
      ];
    },
  },
  "kicking": {
    name: "Kicking",
    cost: "2 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,6), d3 = r(6,7);
      return [
        `${D1} **${d1}** [Blunt]`,
        `${D2} **${d2}** [Blunt]`,
        `${D3} **${d3}** [Blunt] — gây 3 Bleed ở turn kế; nếu ở **Middle Syndicate** thêm 2 Paralyze`,
      ];
    },
  },
  "just a vengeance": {
    name: "Just A Vengeance",
    cost: "4 Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(4,6), d3 = r(5,7), d4 = r(12,16);
      return [
        `${D1} **${d1}** [Blunt] — gây 2 Bleed ở turn kế`,
        `${D2} **${d2}** [Blunt] — gây 2 Bleed ở turn kế`,
        `${D3} **${d3}** [Blunt] — gây 2 Bind`,
        `${D4} **${d4}** [Blunt] [Guard Break] [AOE 2 người] — gây 3 Paralyze`,
      ];
    },
  },
  "extract fuel": {
    name: "Extract Fuel",
    cost: "2 Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,12);
      let heal = d1 === 7 ? "hồi 10 HP" : d1 === 12 ? "hồi 20 HP" : "hồi 15 HP";
      return [
        `${D1} **${d1}** [Slash] [Guard Break] — hồi lại 2 Light (${heal})`,
      ];
    },
  },
  "stamp of vengeance": {
    name: "Stamp of Vengeance",
    cost: "4 Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(16,24);
      return [
        `${D1} **${d1}** [Blunt] [Guard Break] [Undodgeable] [AOE 3 người] — gây 5 Bleed ở turn kế, 2 Bind và nhận 2 **Middle Nursefather Tattoos** với mỗi địch đánh trúng`,
      ];
    },
  },
  "complete and total extermination": {
    name: "Complete and Total Extermination",
    cost: "5 Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,25);
      return [
        `${D1} **${d1}** [Blunt] [Unblockable] [Undodgeable] — gây 4 Paralyze, Tremor Burst, 10 Fragile và 2 Vengeance Mark`,
      ];
    },
  },
  "following the flow": {
    name: "Following the Flow",
    cost: "3 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(7,9), d3 = r(8,10);
      return [
        `${D1} *Nếu địch có ≥4 Bind, mọi Dice của skill này add thêm 1 Burn*`,
        `${D1} **${d1}** [Slash] [Undodgeable] — gây 2 Burn`,
        `${D2} **${d2}** [Slash] [Unblockable] — gây 2 Burn và 2 Bind`,
        `${D3} **${d3}** [Slash] [Unblockable] — gây 2 Burn`,
      ];
    },
  },
  "silence": {
    name: "Silence",
    cost: "5 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(5,7), d3 = r(7,10), d4 = r(8,12);
      return [
        `${D1} *Khi dùng: +1 Dice Up turn này và sau ứng với mỗi nhánh Skill Tree Wrath đã kích hoạt [Max: 4]*`,
        `${D1} **${d1}** [Slash] [Guard Break] — gây 3 Burn`,
        `${D2} **${d2}** [Slash] — gây 3 Burn`,
        `${D3} **${d3}** [Slash] — gây 3 Burn`,
        `${D4} **${d4}** [Slash] — gây 4 Bind và +1 Burn ứng với mỗi Bind trên địch`,
      ];
    },
  },
  "waltz in black": {
    name: "Waltz In Black",
    cost: "3 Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,14);
      return [
        `${D1} *Nếu turn trước địch dính Waltz In White: skill này thành 3x Dice Multiplier và [Unevadeable]*`,
        `${D1} **${d1}** [Slash] [Guard Break]`,
      ];
    },
  },
  "waltz in white": {
    name: "Waltz In White",
    cost: "2 Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(13,24);
      return [
        `${D1} **${d1}** [Pierce] [Unevadeable] [Unblockable]`,
      ];
    },
  },
  "light attack": {
    name: "Light Attack",
    cost: "1 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8);
      return [
        `${D1} **${d1}** [Slash] [Unparriable] [Unblockable] — hồi 2 Light sau khi trúng`,
      ];
    },
  },
  "slash series": {
    name: "Slash Series",
    cost: "2 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(3,5), d3 = r(5,7);
      return [
        `${D1} **${d1}** [Slash] [Undodgeable] — nhận 2 Poise`,
        `${D2} **${d2}** [Slash] [Undodgeable] — nhận 2 Poise`,
        `${D3} **${d3}** [Slash] [Guard Break] — nhận 2 Poise`,
      ];
    },
  },
  "execute prescript": {
    name: "Execute Prescript",
    cost: "2 Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(4,8);
      return [
        `${D1} **${d1}** [Slash] — gây 3 Rupture`,
        `${D2} **${d2}** [Slash] — gây 4 Rupture; nếu trong Index Syndicate & Deck Singleton thì +4 Dice Up`,
      ];
    },
  },
  "will of the city": {
    name: "Will of The City",
    cost: "1 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `${D1} **${d1}** [Slash] [Guard Break] — hồi 1 Light`,
      ];
    },
  },
  "dodge and strike": {
    name: "Dodge and Strike",
    cost: "1 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,16);
      return [
        `${D1} **${d1}** [Slash]`,
      ];
    },
  },
  "prescript": {
    name: "Prescript",
    cost: "—", cd: "—", diceMul: "—",
    roll() {
      const PRESCRIPT_TABLE = [
        "Dice 1: **27 Dmg** [Blunt] — nhận 2 Poise [20 Stamina]",
        "Dice 2: **8 Dmg** [Pierce] — gây 2 Sinking [5 Stamina]",
        "Dice 3: **15 Dmg** [Slash] — bản thân +10% Dmg turn sau (2 lần/turn) [10 Stamina]",
        "Dice 4: **6 Dmg** [Pierce] — địch nhận thêm 5% Dmg (2 lần/turn) [5 Stamina]",
        "Dice 5: **25 Dmg** [Blunt] — giảm 50 Stamina địch [20 Stamina]",
        "Dice 6: **24 Dmg** [Slash] — địch nhận thêm 10% Dmg Slash (2 lần/turn) [20 Stamina]",
        "Dice 7: **12 Dmg** [Pierce] — địch nhận thêm 10% Dmg Pierce (2 lần/turn) [10 Stamina]",
        "Dice 8: **12 Dmg** [Blunt] — địch nhận thêm 10% Dmg Blunt (2 lần/turn) [10 Stamina]",
        "Dice 9: **30 Dmg** [Slash] — 100% Crit [20 Stamina]",
      ];
      const picked = PRESCRIPT_TABLE[Math.floor(Math.random() * PRESCRIPT_TABLE.length)];
      return [picked];
    },
  },
  "soulburn": {
    name: "Soulburn",
    cost: "3 Light", cd: "3 Turn", diceMul: "2x",
    roll() {
      const d1 = r(3,6), d2 = r(3,6), d3 = r(5,9);
      return [
        `${D1} **${d1}** [Slash] [AOE tất cả] — gây 4 Burn và 1 Fragile ở turn kế`,
        `${D2} **${d2}** [Slash] [AOE tất cả] — gây 6 Burn và 2 Fragile ở turn kế`,
        `${D3} **${d3}** [Slash] [AOE tất cả] — gây 10 Burn và 2 Fragile ở turn kế`,
      ];
    },
  },
  "inferno burst": {
    name: "Inferno Burst",
    cost: "2 Light", cd: "2 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(9,12), d2 = r(11,13);
      return [
        `${D1} *Nếu địch có trên 10 Burn: tăng lượng Burn mỗi Hit thêm 3 Burn*`,
        `${D1} **${d1}** [Slash] — gây 2 Burn`,
        `${D2} **${d2}** [Blunt] — gây 4 Burn và kích Burning Sensation`,
      ];
    },
  },
  "take this kid": {
    name: "Take this, Kid",
    cost: "3 Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,16), d2 = r(16,24);
      return [
        `${D1} *Nếu địch có Bleed: gắn 1 Hemorrhage*`,
        `${D1} **${d1}** [Blunt]`,
        `${D2} **${d2}** [Blunt] — gây 4 Bleed ở turn kế`,
      ];
    },
  },
  "learn again kid": {
    name: "Learn again, Kid",
    cost: "3 Light", cd: "2 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(8,12), d2 = r(8,12), d3 = r(10,14), d4 = r(14,20);
      return [
        `${D1} *Nếu địch có Bleed: gắn 1 Hemorrhage*`,
        `${D1} **${d1}** [Blunt]`,
        `${D2} **${d2}** [Blunt] — gây 2 Bleed ở turn kế`,
        `${D3} **${d3}** [Blunt] — gây 2 Bleed ở turn kế`,
        `${D4} **${d4}** [Blunt] — gây 4 Bleed ở turn kế`,
      ];
    },
  },
  "catch breath": {
    name: "Catch Breath",
    cost: "2 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,15);
      return [
        `${D1} *Khi dưới 50% HP: Dice 1 nhận 4 Dice Up*`,
        `${D1} **${d1}** [Slash] — nhận 6 Poise; khi dưới 50% HP thêm 2 Poise và 4 Haste`,
      ];
    },
  },
  "onrush": {
    name: "Onrush",
    cost: "3 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,26);
      return [
        `${D1} **${d1}** [Slash] — gây 3 Bleed ở turn kế, nhận 1 Imitation, giảm 40 Stamina địch`,
        `${D1} *Nếu bản thân có ≥6 Light: dùng thêm 3 Light để reuse đòn này*`,
      ];
    },
  },
  "overthrow": {
    name: "Overthrow",
    cost: "5 Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,4), d2 = r(2,4), d3 = r(5,10);
      return [
        `${D1} **${d1}** [Slash] [Undodgeable] — gây 3 Bleed ở turn kế, nhận 2 Poise; nếu có trên 5 Poise thêm 2 Dice Up`,
        `${D2} **${d2}** [Slash] [Undodgeable] — gây 3 Bleed ở turn kế, nhận 2 Poise`,
        `${D3} *Nếu có ≥5 Poise: chuyển 5 Poise → 8 Dice Up cho Dice 3; nếu kết liễu được địch thêm 3 Dice Up turn sau*`,
        `${D3} **${d3}** [Slash] [Undodgeable] [Unparriable] [Guard Break] — gây 10 Bleed ở turn kế, 5 Paralyze, nhận 5 Poise`,
      ];
    },
  },
  "shadowcloud shattercleaver": {
    name: "Shadowcloud Shattercleaver",
    cost: "3 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,5), d2 = r(2,5), d3 = r(8,10);
      return [
        `${D1} **${d1}** [Slash] — gây 2 Bleed ở turn kế, nhận 2 Defense Up`,
        `${D2} **${d2}** [Slash] — gây 2 Bleed ở turn kế, nhận 2 Defense Up; nếu địch có trên 6 Bleed thêm 2 Defense Up`,
        `${D3} **${d3}** [Slash] [Guard Break] — gây 5 Bleed ở turn kế`,
      ];
    },
  },
  "punting": {
    name: "Punting",
    cost: "2 Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,6);
      return [
        `${D1} **${d1}** [Blunt] [Unblockable]`,
        `${D2} **${d2}** [Blunt] [Unblockable] — gây 3 Bleed ở turn kế, nhận 2 Poise và 1 **Middle Nursefather Tattoos**`,
      ];
    },
  },
  "punching": {
    name: "Punching",
    cost: "2 Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(5,7), d3 = r(6,8);
      return [
        `${D1} **${d1}** [Blunt]`,
        `${D2} **${d2}** [Blunt]`,
        `${D3} **${d3}** [Blunt] — gây 2 Paralyze nếu ở trong **Middle Syndicate**`,
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
        `${D1} **${d1}** [Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `${D2} **${d2}** [Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `${D3} **${d3}** [Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 2 Tremor`,
        `${D4} **${d4}** [Slash] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 1 Rupture`,
        `${D5} **${d5}** [Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 3 Bleed ở turn kế`,
        `Dice 6: **${d6}** [50% Slash/50% Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 4 Fragile, Tremor Burst`,
        `Dice 7: **${d7}** [Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 10 Tremor`,
        `Dice 8: **${d8}** [50% Slash/50% Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `Dice 9: **${d9}** [Slash] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 1 Rupture *trước* khi gây Dmg`,
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
  "learnakainkid": "learn again kid",
  "learnakaink": "learn again kid",
  "lak": "learn again kid",
  "catchbreath": "catch breath",
  "cb": "catch breath",
  "shadowcloudshattercleaver": "shadowcloud shattercleaver",
  "scs": "shadowcloud shattercleaver",
  "furioso": "furioso",
};

function findSkill(raw) {
  const key = raw.toLowerCase().trim();
  if (SKILLS[key]) return SKILLS[key];
  const aliasKey = SKILL_ALIASES[key.replace(/[\s\-,]/g, "").replace(/\s+/g, " ")];
  if (aliasKey && SKILLS[aliasKey]) return SKILLS[aliasKey];
  // Fuzzy: tìm skill nào có tên chứa input
  for (const [k, v] of Object.entries(SKILLS)) {
    if (k.includes(key) || key.includes(k)) return v;
  }
  return null;
}

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
      if (min >= max) return { error: `Min phải nhỏ hơn Max: \`${trimmed}\`` };
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
    const PRESCRIPT_TABLE = [
      "Dice 1: **27 Dmg** [Blunt] — nhận 2 Poise [20 Stamina]",
      "Dice 2: **8 Dmg** [Pierce] — gây 2 Sinking [5 Stamina]",
      "Dice 3: **15 Dmg** [Slash] — bản thân +10% Dmg turn sau (2 lần/turn) [10 Stamina]",
      "Dice 4: **6 Dmg** [Pierce] — địch nhận thêm 5% Dmg (2 lần/turn) [5 Stamina]",
      "Dice 5: **25 Dmg** [Blunt] — giảm 50 Stamina địch [20 Stamina]",
      "Dice 6: **24 Dmg** [Slash] — địch nhận thêm 10% Dmg Slash (2 lần/turn) [20 Stamina]",
      "Dice 7: **12 Dmg** [Pierce] — địch nhận thêm 10% Dmg Pierce (2 lần/turn) [10 Stamina]",
      "Dice 8: **12 Dmg** [Blunt] — địch nhận thêm 10% Dmg Blunt (2 lần/turn) [10 Stamina]",
      "Dice 9: **30 Dmg** [Slash] — 100% Crit [20 Stamina]",
    ];
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
  if (message.content.startsWith("-skill")) {
    if (isOnCooldown(message.author.id, "skill", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const input = message.content.replace("-skill", "").trim();

    // -skill list
    if (!input || input.toLowerCase() === "list") {
      const skillNames = Object.values(SKILLS).map((s, i) =>
        `\`${i + 1}.\` **${s.name}** — ${s.cost} | CD: ${s.cd} | Dice Mul: ${s.diceMul}`
      );
      const half = Math.ceil(skillNames.length / 2);
      message.reply({
        embeds: [{
          title: "📖 Danh sách Skill",
          color: 0x9b59b6,
          fields: [
            { name: "\u200b", value: skillNames.slice(0, half).join("\n"), inline: true },
            { name: "\u200b", value: skillNames.slice(half).join("\n"), inline: true },
          ],
          footer: { text: "Dùng -skill <tên> để roll skill" },
        }],
      });
      return;
    }

    const skill = findSkill(input);
    if (!skill) {
      message.reply(`❌ Không tìm thấy skill: \`${input}\`\nDùng \`-skill list\` để xem danh sách.`);
      return;
    }

    const lines = skill.roll();
    const header = skill.cost !== "—"
      ? `[${skill.cost}] [CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`
      : `[${skill.cost}] [Dice Mul: ${skill.diceMul}]`;
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
      message.reply("❌ Cần chỉ định ít nhất một trong: `exp`, `ahn`, `book`, `item`.");
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
      { name: "🎲 -rolldice <range> [x<lần>], ...", value: ["Roll dice theo range tùy chỉnh. Mỗi dice có thể có số lần riêng.", "> `-rolldice <min>-<max>` — roll 1 lần", "> `-rolldice <min>-<max> x<lần>` — roll nhiều lần (tối đa 20)", "> `-rolldice <range> x<lần>, <range>, <range> x<lần>` — nhiều dice, mỗi dice có số lần riêng (tối đa 10 dice)", "> VD: `-rolldice 3-7` | `-rolldice 3-7 x5` | `-rolldice 3-17 x14, 2-4, 2-7 x3`"].join("\n"), inline: false },
      { name: "📊 -math [...]", value: ["Tính damage theo hệ thống game.", "> `dmg:` `res:` `bonus:` `critmul:` `critdiv:`", "> `sanity:` `sanitybonus:` `sinking:` `rupture:` `dicemul:`", "> `poise: <stacks>` — Starting Poise stacks (1 stack = 5% crit, tối đa 99)", "> VD: `-math dmg: 10B poise: 10 critmul: 1.3`"].join("\n"), inline: false },
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
        "> Định dạng dmg: `<số>[x<lần>][+<extra>%] [Dice]<B|P|S>[+Sinking][+Rupture][+Poise][+Crit<n>]`"
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
    const critDivRaw = (kv["critdiv"] ?? "no").toLowerCase().trim();
    const critDiv = critDivRaw === "yes" || critDivRaw === "true" || critDivRaw === "1";

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
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
async function replyOnCooldown(interaction, ms) {
  if (!isOnCooldown(interaction.user.id, interaction.commandName, ms)) return false;
  try {
    await interaction.reply({
      content: `⏳ Bạn dùng lệnh này quá nhanh, chờ ${ms / 1000} giây nhé.`,
      ephemeral: true,
    });
  } catch {
    // Interaction có thể đã expired hoặc đã reply rồi — bỏ qua
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
    await interaction.editReply(calcMath({
      dmgStr,
      resStr: interaction.options.getString("res") ?? "",
      bonusPct,
      sanityBonusPct,
      critMul,
      poiseInit,
      critDiv: interaction.options.getBoolean("critdiv") ?? false,
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
app.listen(PORT, "0.0.0.0", () => log("info", "startup", "system", `Server running on port ${PORT}`));

// Clear timer khi process shutdown để tránh memory leak
process.on("SIGTERM", () => {
  clearInterval(cooldownCleanupTimer);
  log("info", "shutdown", "system", "SIGTERM received, shutting down.");
  process.exit(0);
});
process.on("SIGINT", () => {
  clearInterval(cooldownCleanupTimer);
  log("info", "shutdown", "system", "SIGINT received, shutting down.");
  process.exit(0);
});

process.on("uncaughtException", (err) => log("error", "uncaughtException", "system", err.message, { stack: err.stack }));
process.on("unhandledRejection", (reason) => log("error", "unhandledRejection", "system", String(reason)));
