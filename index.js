// index.js
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const express = require("express");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.json()); // cần cho POST /rtparry/:token/result nhận JSON body

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
  BURN_MAX,
  TREMOR_MAX,
  BLEED_MAX,
  CHARGE_MAX,
  TREMOR_VARIANT_MAX,
  SPECTRO_FRAZZLE_MAX,
  GAZE_AWE_MAX,
  CONTEMPT_MAX,
  HAOU_MAX,
  HEMORRHAGE_MAX,
  AMMO_MAX,
  PARRY_MAX_ROLLS,
  OPEN_COUNT_MAX,
  MAX_PROFILES,
  PROFILE_NAME_MAX_LENGTH,
  BUTTERFLY_LIVING_MAX,
  BUTTERFLY_DEPARTED_MAX,
  GRADE_MAX,
  GRADE_MIN,
  SKILL_MAX_ROLLS,
} = require("./constants");
const POISE_CRIT_BONUS_PER_STACK = 0.05;
const POISE_RESET_THRESHOLD = 1;
const POISE_CRIT_DIV_DEFAULT = 2;

const { webParrySessions, WEB_PARRY_TTL_MS, RTPARRY_WINDOW_MS, RTPARRY_MIN_HUMAN_MS, getPublicBaseUrl, inferPageSpeed, PAGE_SPEED_YELLOW_MS, PAGE_SPEED_WINDOW_MS, randomYellowMs, createRtparryToken, buildRtparryLinkButton } = require("./rtparry"); // ĐÃ TÁCH sang file riêng (rtparry.js)

// ─── DAILY REWARDS ────────────────────────────────────────────────────────────
const DAILY_EXP_REWARD = 5;
const DAILY_AHN_REWARD = 100_000;
const DAILY_STREAK_EXP_BONUS = 25;
const DAILY_STREAK_AHN_BONUS = 400_000;
const DAILY_STREAK_LUNACY_BONUS = 750; // xác nhận trực tiếp: "cứ đủ streak 7 ngày thì sẽ cho 750 lunacy nữa"
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

/** clampExpWithLunacy — Lunacy (xác nhận trực tiếp): "lượng exp thừa sẽ được
 *  chuyển qua Lunacy với tỷ lệ 1 exp thừa sẽ = 10 Lunacy" — khi EXP vượt quá
 *  EXP_MAX (đã đạt Grade 1, grade cao nhất, không còn chỗ dùng thêm EXP), phần
 *  VƯỢT chuyển thẳng thành Lunacy (mutate profileData.lunacy trực tiếp) thay vì
 *  bị clamp/mất trắng như clampExp cũ. Trả về giá trị exp đã clamp để gán lại.
 */
function clampExpWithLunacy(profileData, rawExp) {
  const clamped = Math.max(0, rawExp);
  if (clamped > EXP_MAX) {
    const excess = clamped - EXP_MAX;
    profileData.lunacy = (profileData.lunacy ?? 0) + excess * 10;
    return EXP_MAX;
  }
  return clamped;
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

// ─── HP PERSISTENCE GIỮA CÁC ENCOUNTER (luật: "HP vẫn giữ nguyên" sau khi
// encounter kết thúc, CHỈ hồi qua item hồi phục hoặc mốc 0h00 AM/PM — giờ Việt
// Nam UTC+7, xác nhận trực tiếp từ GM) ────────────────────────────────────────
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** mostRecentHpResetBoundaryUtc — trả về timestamp UTC (ms) của mốc reset HP GẦN
 *  NHẤT đã/sắp qua tính tới thời điểm nowUtcMs — 2 mốc/ngày theo giờ VN: 00:00 và
 *  12:00. VD nowUtcMs tương ứng 15:00 giờ VN → mốc gần nhất là 12:00 giờ VN HÔM
 *  NAY. Nếu là 05:00 giờ VN → mốc gần nhất là 00:00 giờ VN HÔM NAY. */
function mostRecentHpResetBoundaryUtc(nowUtcMs) {
  const nowVn = new Date(nowUtcMs + VN_OFFSET_MS);
  const vnHour = nowVn.getUTCHours();
  const boundaryVnHour = vnHour < 12 ? 0 : 12;
  const boundaryVnMs = Date.UTC(nowVn.getUTCFullYear(), nowVn.getUTCMonth(), nowVn.getUTCDate(), boundaryVnHour, 0, 0, 0);
  return boundaryVnMs - VN_OFFSET_MS; // chuyển ngược về UTC thật để so sánh trực tiếp với Date.now()
}

/** getEffectiveCurrentHp — HP hiện tại của player TÍNH ĐẾN GIỜ, áp dụng auto-reset
 *  nếu đã qua mốc 0h/12h VN kể từ lần check gần nhất. KHÔNG mutate profileData
 *  trực tiếp — trả về { hp, didReset } để caller tự quyết định lưu lại hay không
 *  (tránh side-effect ẩn trong 1 hàm "get"). Nếu profileData.currentHp chưa từng
 *  được set (player hoàn toàn mới, chưa join encounter nào) → trả về maxHp (coi
 *  như "đầy máu" mặc định, hợp lý cho lần đầu). */
/**
 * calcInjuryMaxHpPenalty — tổng Max HP bị trừ vĩnh viễn từ các chấn thương ĐANG
 * MANG (Gãy Xương -30, Vết thương lớn -100) — dùng để tính Max HP THẬT của player
 * lúc join (luật xác nhận trực tiếp: "injuries vẫn persist qua các encounter").
 */
function calcInjuryMaxHpPenalty(injuries) {
  return (injuries ?? []).reduce((sum, inj) => {
    if (inj.startsWith("Gãy Xương")) return sum + 30;
    if (inj.startsWith("Vết thương lớn")) return sum + 100;
    return sum;
  }, 0);
}

function getEffectiveCurrentHp(profileData, maxHp) {
  if (profileData.currentHp === undefined || profileData.currentHp === null) {
    return { hp: maxHp, didReset: false };
  }
  const lastCheck = profileData.hpLastResetCheck ?? 0;
  const boundary = mostRecentHpResetBoundaryUtc(Date.now());
  if (lastCheck < boundary) {
    return { hp: maxHp, didReset: true };
  }
  // Clamp vào maxHp hiện tại (trường hợp grade tăng làm maxHp tăng theo, hoặc
  // giảm — không nên giữ currentHp > maxHp mới).
  return { hp: Math.min(profileData.currentHp, maxHp), didReset: false };
}

// ─── UI CONSTANTS ─────────────────────────────────────────────────────────────
const INVENTORY_HINT_TEXT = "Dùng /inventory hoặc -inventory để xem chi tiết sách và vật phẩm";

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS ?? "208187560692940803,1072123095739019346,675899106614575150,1341034013036511355,1405147450498486332")
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
  // -gacha (xác nhận trực tiếp): 5 item "rate rất thấp" — voucher tuỳ chỉnh, GM
  // tự xử lý thiết kế thật (không phải item auto-generate cụ thể).
  "Custom Accessory", "Custom Weapon", "Custom Outfit", "Custom Page", "Custom E.G.O",
];

// ─── GACHA (-gacha, xác nhận trực tiếp) ───────────────────────────────────────
// 3 tier tái dùng NGUYÊN các pool đã có sẵn (RANDOM_BOOK_POOL/SEALED_BOOK_POOL/
// CHIPBOARD_CACHE_POOL) — không khai báo trùng dữ liệu. Rate % KHÔNG được cho số
// cụ thể trong yêu cầu gốc — dùng mốc gacha tiêu chuẩn (cao/trung/rất thấp), DỄ
// CHỈNH nếu không đúng ý (chỉ 3 số trong GACHA_RATES).
const GACHA_POOL_HIGH = RANDOM_BOOK_POOL; // 17 item — "Rate cao, filler items"
const GACHA_POOL_MID = [...SEALED_BOOK_POOL, ...CHIPBOARD_CACHE_POOL, "Uptie Module"]; // 16 item — "Rate trung bình" (MK4/MK5 đã chuyển sang tier 3, xác nhận trực tiếp)
const GACHA_POOL_RARE = ["Custom Accessory", "Custom Weapon", "Custom Outfit", "Custom Page", "Custom E.G.O", "Chipboard MK4", "Chipboard MK5"]; // 7 item — "Rate rất thấp"
const GACHA_RATES = { high: 75, mid: 23, rare: 2 }; // % — giả định, tổng = 100
const GACHA_COST_PER_PULL = 130; // Lunacy/lần — xác nhận trực tiếp (1300 Lunacy code đầu = đúng 10 lần)

/** rollGachaOnce — roll 1 lần theo 3 tier GACHA_RATES, trả về tên item. */
function rollGachaOnce() {
  const roll = Math.random() * 100;
  if (roll < GACHA_RATES.high) {
    return GACHA_POOL_HIGH[Math.floor(Math.random() * GACHA_POOL_HIGH.length)];
  } else if (roll < GACHA_RATES.high + GACHA_RATES.mid) {
    return GACHA_POOL_MID[Math.floor(Math.random() * GACHA_POOL_MID.length)];
  } else {
    return GACHA_POOL_RARE[Math.floor(Math.random() * GACHA_POOL_RARE.length)];
  }
}

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
  "book", "count", "item", "itemcount", "ahn", "exp", "grade", "bonusskillpoints", "lunacy", "code", // lunacy = -setprofile, code = -redeem
  "wrath", "desire", "sloth", "gluttony", "gloom", "pride", "envy", "shin", "light", // 9 nhánh Skill Tree (branchPoints)
  "shinunlock", "lightskilltreeunlock", "50statunlock", "manifestedegounlock", // 4 cờ điều kiện đặc biệt
  "fragile", "attackpowerup", "attackpowerdown", "defenseup", "defensedown", "clashattackboost", "unopposedattackboost", "protection", "regen", "chargeshield", // 50-Status Nhóm 1
  "paralyze", "diceup", "dicedown", "smoke", "vengeancemark", "nails", "redplumblossom", "freeble", "borrowedtime", "fairy", "airborne", "chains", "sizzlingwound", "perceptionblockingmask", "blacksilence", // 50-Status Nhóm 2
  "tremoreverlasting", "tremorfracture", "tremorreverb", "tremordecay", "tremorchain", "spectrofrazzle", "tremorscorch", "tremorhemorrhage", "burningsensation", // Tremor variants + Burning Sensation
  "busyastribbie", // Busy as Tribbie
  "timemoratorium", // Time Moratorium
  "gazeawe", "contempt", "gazeofcontempt", "contemptofthegaze", "source", // Gaze/Contempt
  "haouflame", "haoubleed", "haoutremor", "haourupture", "haousinking", // Haou tier
  "hemorrhage", // Hemorrhage
  "choose", // -readbook <sách> choose: <tên> — chốt lựa chọn qua text thay vì dropdown
  "dmg", "res", "dr", "bonus", "critmul", "critdiv",
  "sanity", "sanitybonus", "sinking", "rupture", "dicemul",
  "poise",
  "living", "departed",
  "burn", "bleed", "bleedactions", "tremor", "charge",
  "books", "items",
  "name", "hp", "weapon", "stamina", "light", "key", "target", "skill", "ref", "text", "index", "coin", "perks", "speedrange", "amount", "oppskill", "for", "tags", "permadeath", "turn", "volleys", "attacker", "hits", "type", "ammotype", "channel", // -encounter
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

const { calcMathCore, calcMath, saturateBonusPct, saturateDR, validateMathInputs } = require("./damage-calc"); // ĐÃ TÁCH sang file riêng (damage-calc.js) — hàm thuần, không đụng Redis/Discord

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

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────
// Ghi log riêng cho hành động ADMIN-ONLY thành công (set grade, cộng/trừ exp/ahn của
// người khác, setplayer, v.v.) — khác với log("error", ...) chỉ ghi khi có lỗi.
// Mục đích: có trail truy vết nếu sau này có tranh chấp ("admin X có thật sự set grade
// cho user Y hay không, lúc nào, giá trị gì"). Luôn console.log (không phải console.error)
// vì đây không phải lỗi — chỉ là việc cần ghi nhận lại.
function auditLog(action, actorId, targetId, details = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: "audit",
    action,
    actorId,
    targetId,
    ...details,
  }));
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

// ─── GIVE CONFIRM FLOW ────────────────────────────────────────────────────────
// Map<giveId, { senderId, targetId, isAdmin, params, expiresAt }> — lưu giao dịch
// /give đang chờ xác nhận qua nút bấm. Không lưu Redis vì chỉ cần sống tối đa 60s
// và không cần persist qua restart.
const pendingGives = new Map();
const GIVE_PENDING_TTL_MS = 60_000;
const givePendingCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, g] of pendingGives)
    if (g.expiresAt < now) pendingGives.delete(id);
}, 30_000);

/** buildGivePreviewLines — tạo dòng preview hiển thị TRƯỚC khi confirm /give, mô tả
 *  những gì SẮP được chuyển. Khác `changes` (trả về từ executeGive ở player-actions.js)
 *  1 chút về cách diễn đạt — đây là dự kiến lúc CHƯA biết tổng số sau khi cộng vào
 *  kho người nhận, executeGive mới biết số CUỐI vì nó đọc dữ liệu thật lúc confirm.
 *
 *  BUG ĐÃ SỬA: hàm này được gọi ở 2 nơi (-give prefix dòng ~2790 và /give slash dòng
 *  ~4530) nhưng CHƯA TỪNG được định nghĩa — khiến MỌI lần `-give`/`/give` với input
 *  hợp lệ đều throw ReferenceError ngay tại bước build preview, rơi vào catch-all
 *  chung của messageCreate/interactionCreate, hiện "❌ Có lỗi không mong muốn xảy ra."
 *  — tức KHÔNG AI chuyển được gì cả, dù input đúng 100% (VD: `ahn: 1`). */
function buildGivePreviewLines({ ahnGain = 0, bookName = null, bookCount = 1, itemName = null, itemCount = 1, expGain = 0, gradeTarget = null }) {
  const lines = [];
  if (gradeTarget !== null) lines.push(`Grade → **Grade ${gradeTarget}**`);
  else if (expGain !== 0) lines.push(`${expGain > 0 ? "+" : ""}${expGain} EXP`);
  if (ahnGain !== 0) lines.push(`${ahnGain > 0 ? "+" : ""}${formatNumber(ahnGain)} Ahn`);
  if (bookName) lines.push(`${bookCount}x **${bookName}**`);
  if (itemName) lines.push(`${itemCount}x **${itemName}**`);
  return lines;
}

/** registerPendingGive — lưu 1 giao dịch /give đang chờ xác nhận vào pendingGives,
 *  trả về giveId để gắn vào customId của nút Xác nhận/Hủy (xem comment đầy đủ ở khai
 *  báo pendingGives phía trên về shape lưu trữ — cũng là phần bị thiếu cùng lỗi với
 *  buildGivePreviewLines ở trên). */
function registerPendingGive(senderId, targetId, isAdmin, params) {
  const giveId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingGives.set(giveId, { senderId, targetId, isAdmin, params, expiresAt: Date.now() + GIVE_PENDING_TTL_MS });
  return giveId;
}

/** buildGiveConfirmRow — ActionRow chứa nút Xác nhận/Hủy cho preview /give, gắn
 *  giveId vào customId để 2 handler "giveconfirm:"/"givecancel:" tra lại đúng giao
 *  dịch trong pendingGives. Cũng bị thiếu cùng lúc với 2 hàm phía trên — gọi /give
 *  vẫn crash ở bước build components dù đã vá xong buildGivePreviewLines/registerPendingGive. */
function buildGiveConfirmRow(giveId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`giveconfirm:${giveId}`).setLabel("✅ Xác nhận").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`givecancel:${giveId}`).setLabel("❌ Hủy").setStyle(ButtonStyle.Danger),
  );
}


// ─── PLAYER DATA HELPERS ──────────────────────────────────────────────────────
function migratePlayerData(data) {
  if (data.books !== undefined || data.items !== undefined) {
    data.books = data.books ?? {};
    data.items = data.items ?? {};
    data.pages = data.pages ?? {};
    data.unlockedSkillTree = data.unlockedSkillTree ?? [];
    data.equippedPages = data.equippedPages ?? [null, null, null, null, null];
    data.equippedEgoPages = data.equippedEgoPages ?? [null, null, null, null, null];
    data.equippedWeapon = data.equippedWeapon ?? null;
    data.equippedOutfit = data.equippedOutfit ?? null;
    data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
    // BUG ĐÃ SỬA (phát hiện qua GM trực tiếp xem JSON thật trong Upstash và không
    // thấy field này đâu cả) — 4 cờ điều kiện đặc biệt + "pages" KHÔNG được backfill
    // cho player ĐÃ TỒN TẠI TỪ TRƯỚC khi các field này được thêm vào hệ thống —
    // profile CŨ hoàn toàn THIẾU field, KHÔNG PHẢI = false, gây khó hiểu khi GM tự
    // xem/sửa JSON trực tiếp trong Upstash.
    data.ShinUnlock = data.ShinUnlock ?? false;
    data.LightSkillTreeUnlock = data.LightSkillTreeUnlock ?? false;
    data["50StatUnlock"] = data["50StatUnlock"] ?? false;
    data.ManifestedEGOUnlock = data.ManifestedEGOUnlock ?? false;
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
  data.pages = data.pages ?? {};
  data.unlockedSkillTree = data.unlockedSkillTree ?? [];
  data.equippedPages = data.equippedPages ?? [null, null, null, null, null];
  data.equippedEgoPages = data.equippedEgoPages ?? [null, null, null, null, null];
  data.equippedWeapon = data.equippedWeapon ?? null;
  data.equippedOutfit = data.equippedOutfit ?? null;
  data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
  data.ShinUnlock = data.ShinUnlock ?? false;
  data.LightSkillTreeUnlock = data.LightSkillTreeUnlock ?? false;
  data["50StatUnlock"] = data["50StatUnlock"] ?? false;
  data.ManifestedEGOUnlock = data.ManifestedEGOUnlock ?? false;
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

// buildProfileInfoEmbed đã chuyển sang player-actions.js (xem phần require + wiring bên dưới)
// ─────────────────────────────────────────────────────────────────────────────

async function getPlayerData(userId) {
  const slot = await getActiveProfileSlot(userId);
  const key = playerKeyForSlot(userId, slot);
  let lastErr;
  for (let attempt = 0; attempt <= REDIS_MAX_RETRIES; attempt++) {
    try {
      const raw = await withTimeout(redis.get(key));
      if (!raw) return { exp: 0, ahn: 0, lunacy: 0, redeemedCodes: [], books: {}, items: {}, pages: {}, unlockedSkillTree: [], equippedPages: [null,null,null,null,null], equippedEgoPages: [null,null,null,null,null], equippedWeapon: null, equippedOutfit: null, equippedAccessories: [null,null,null], ShinUnlock: false, LightSkillTreeUnlock: false, "50StatUnlock": false, ManifestedEGOUnlock: false };
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
        : { exp: 0, ahn: 0, lunacy: 0, redeemedCodes: [], books: {}, items: {}, pages: {}, unlockedSkillTree: [], equippedPages: [null,null,null,null,null], equippedEgoPages: [null,null,null,null,null], equippedWeapon: null, equippedOutfit: null, equippedAccessories: [null,null,null], ShinUnlock: false, LightSkillTreeUnlock: false, "50StatUnlock": false, ManifestedEGOUnlock: false };
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
      : { exp: 0, ahn: 0, lunacy: 0, redeemedCodes: [], books: {}, items: {}, pages: {}, unlockedSkillTree: [], equippedPages: [null,null,null,null,null], equippedEgoPages: [null,null,null,null,null], equippedWeapon: null, equippedOutfit: null, equippedAccessories: [null,null,null], ShinUnlock: false, LightSkillTreeUnlock: false, "50StatUnlock": false, ManifestedEGOUnlock: false };
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
    const lunacyBeforeExpConvert = playerData.lunacy ?? 0;
    playerData.exp = clampExpWithLunacy(playerData, expBefore + expGain);
    const actualExpGained = playerData.exp - expBefore;
    const lunacyFromExpConvert = (playerData.lunacy ?? 0) - lunacyBeforeExpConvert;

    playerData.ahn = (playerData.ahn ?? 0) + DAILY_AHN_REWARD;
    playerData.books["Random Book"] = (playerData.books["Random Book"] ?? 0) + 1;

    if (isWeekComplete) {
      playerData.ahn += DAILY_STREAK_AHN_BONUS;
      playerData.books["Sealed Book Cache"] = (playerData.books["Sealed Book Cache"] ?? 0) + 1;
      // Streak 7 ngày (xác nhận trực tiếp): "cứ đủ streak 7 ngày thì sẽ cho 750
      // lunacy nữa" — cộng thêm vào phần thưởng hoàn thành streak sẵn có.
      playerData.lunacy = (playerData.lunacy ?? 0) + DAILY_STREAK_LUNACY_BONUS;
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
      `> 🔥 Streak: **${displayStreak}/7** ngày  ${bar}` +
      (lunacyFromExpConvert > 0 ? `\n> 🌙 EXP dư chuyển thành +${formatNumber(lunacyFromExpConvert)} <:Lunacy:1524989409529823342>Lunacy` : "");

    if (isWeekComplete) {
      replyMsg +=
        `\n\n🏆 **Hoàn thành streak 7 ngày!** Bạn nhận thêm **${isWeekComplete ? DAILY_STREAK_EXP_BONUS : 0} Exp**, **400k Ahn**, **${formatNumber(DAILY_STREAK_LUNACY_BONUS)} <:Lunacy:1524989409529823342>Lunacy** và **1 Sealed Book Cache**!\n` +
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




// ─── ENCOUNTER SYSTEM ───────────────────────────────────────────────────────
// Giải quyết đúng vấn đề Fragaria/Sora bàn: Profile bị bind cứng với 1 player cụ
// thể (key Redis luôn có userId), không thể tái dùng làm "entity có stat" cho boss.
// Encounter là model HOÀN TOÀN TÁCH BIỆT khỏi Profile — key theo channelId, không
// theo userId nào cả. Chỉ 1 encounter active / channel (đơn giản, theo yêu cầu).
//
// THIẾT KẾ V2 (viết lại sau khi xem transcript trận đấu thật của nhóm) — khác V1
// (1 boss duy nhất, Guard/Evade/Parry tự động qua nút, confirm từng hit riêng) ở
// 3 điểm cốt lõi, đúng với cách nhóm thực tế chơi:
//   1. NHIỀU quái cùng lúc (encounter.enemies — Map theo key ngắn do GM đặt, VD
//      "mo"/"arnold"), không phải 1 "boss" duy nhất — vì 1 trận có thể có 3+ quái
//      riêng biệt (mỗi con HP/Resistance/status effect khác nhau).
//   2. Target CHỈ ĐỊNH theo từng lệnh (target: mo / target: mo,arnold / target: all)
//      — vì 1 turn của player có thể đánh NHIỀU mục tiêu khác nhau (Roland: "Critical
//      vào tên thứ hai + Thrust x5 vào tên thứ ba"), và AOE đánh nhiều quái cùng lúc.
//   3. NHIỀU pending action xếp hàng (encounter.pendingActions — Array), KHÔNG còn
//      giới hạn "chỉ 1 action chờ confirm" — vì 1 turn có thể gồm 5 skill khác nhau
//      (Roland: "Light Dash + Charge and Cover + Opportunistic Slash + Sky Kick +
//      m1x6") declare liên tiếp, rồi GM bấm "Confirm tất cả" 1 lần duy nhất.
//   4. ĐÃ BỎ Guard/Evade/Parry tự động (nút + Stamina cố định) — transcript thật
//      cho thấy né/phản đòn đến từ flavor effect của TỪNG SKILL CỤ THỂ (VD "Charge
//      and Cover" tự ghi "né 1 đòn tấn công" trong hiệu ứng) hoặc qua -rtparry cho
//      skill cần phản xạ thật — không có luật "Guard/Evade chung tốn X Stamina,
//      chặn N hit theo vũ khí" nào cả, đó là cơ chế V1 tự đặt ra không khớp game.
const ENCOUNTER_NAME_MAX_LENGTH = 100;
const ENCOUNTER_KEY_MAX_LENGTH = 20;
const ENCOUNTER_DEFAULT_MAX_STAMINA = 100;
const ENCOUNTER_DEFAULT_MAX_LIGHT = 4;
const ENCOUNTER_SANITY_MAX = 45; // luôn bắt đầu 0/45 mỗi trận theo luật
const ENCOUNTER_STAMINA_REGEN_PER_TURN = 30;
const ENCOUNTER_PENDING_MAX = 20; // chặn spam — 1 turn thật khó vượt quá số này
// ── EMOTION LEVEL — buff TẠM THỜI, KHÔNG cộng dồn vĩnh viễn ─────────────────
// Mỗi mốc Level có Duration 3 turn — hết hạn thì rớt về Level 0 và vào CD 6 turn
// (không lên lại được dù coin đủ). Đạt Level CAO HƠN khi mốc cũ còn active → THAY
// THẾ ngay (reset duration theo mốc mới, KHÔNG vào CD vì vẫn đang active liên tục).
// Coin KHÔNG reset về 0 khi lên level — bị TRỪ ĐÚNG NGƯỜI bằng mốc đã đạt, phần dư
// tiếp tục tích lũy hướng tới mốc kế (khớp đúng "Coin: 1/5" sau khi vừa lên Lv1 từ
// mốc 3, dư 1, hướng tới mốc 5 của Lv2 — xem transcript).
const EMOTION_LEVEL_TABLE = [
  null, // index 0 = không có level nào active, không dùng tới
  { coinNeeded: 3, healPct: 5, diceUp: 1, maxLightBonus: 1 },
  { coinNeeded: 5, healPct: 10, diceUp: 2, maxLightBonus: 2 },
  { coinNeeded: 7, healPct: 15, diceUp: 3, maxLightBonus: 3 },
  { coinNeeded: 9, healPct: 20, diceUp: 4, maxLightBonus: 4 },
  { coinNeeded: 11, healPct: 25, diceUp: 5, maxLightBonus: 5 },
];
const EMOTION_LEVEL_DURATION_TURNS = 3;
const EMOTION_LEVEL_COOLDOWN_TURNS = 6;

/** getMaxEmotionLevel — mặc định CHỈ lên được tới Level 2. Level 3 cần Ein Sof,
 *  Level 4&5 cần Ohr Ein Sof (mở khóa CẢ 2 cùng lúc — không có unlock riêng cho 4). */
function getMaxEmotionLevel(combatant) {
  const perks = combatant.unlockedPerks ?? [];
  if (perks.includes("Ohr Ein Sof")) return 5;
  if (perks.includes("Ein Sof")) return 3;
  return 2;
}
// Các cặp perk LOẠI TRỪ NHAU theo skill tree (không ai có cả 2 cùng lúc) — check
// lúc -unlockskilltree, KHÔNG cho mở cái thứ 2 nếu đã có cái đầu trong cặp.
const { hasPerk, findExclusiveConflict, calcSkillTreePointsEarned, calcBranchPointsAllocated, applyStatusMultiplierToDmgStr, PERK_POINT_COSTS, PERK_BRANCH, BRANCH_KEYS, UNIVERSALLY_KNOWN_WEAPONS, MIDDLE_SYNDICATE_SKILLS, MUTUALLY_EXCLUSIVE_PERKS } = require("./skill-tree")({ calcGrade, GRADE_MIN }); // ĐÃ TÁCH sang file riêng (skill-tree.js)

const { BOOK_GRANTS, getBookTopLevelChoices, getBookGroupChoices, isValidBookChoice, buildBookChoiceComponents, executeReadBookChoose } = require("./book-system")({ findBook, getPlayerDataWithSlot, savePlayerData }); // ĐÃ TÁCH sang file riêng (book-system.js)


/**
 * computeAttackerPerkContext — tính TẤT CẢ hiệu ứng từ perk của BÊN TẤN CÔNG ảnh
 * hưởng tới 1 đòn đánh lên 1 target cụ thể. Gọi TRƯỚC khi build calcOpts (để lấy
 * bonusPct/critMul/critDiv đưa vào), và sau khi build dmgStr-đã-rewrite-multiplier
 * (để đưa vào calcMathCore). isM1 phân biệt Kinetic Energy (chỉ áp cho M1, không
 * áp cho Page/skill).
 * @returns { bonusPct, critMul, critDivOverride, dmgStrRewritten, instantKill }
 */
const { computeAttackerPerkContext } = require("./attacker-perk-context")({ hasPerk, applyStatusMultiplierToDmgStr }); // ĐÃ TÁCH sang file riêng (attacker-perk-context.js)
/** computeDefenderDmgReduction — % giảm dmg NHẬN VÀO của bên BỊ tấn công, dựa trên
 *  perk tự thân (Smoldering Resolve) + trạng thái Manifested E.G.O (No Will To Break). */
const { computeDefenderDmgReduction, resolveEquipTarget, buildPendingListText, parseBatchEntries } = require("./misc-helpers")({ hasPerk, ADMIN_IDS }); // Gộp 4 hàm nhỏ vào 1 file chung (misc-helpers.js) — theo phản hồi trực tiếp: file 24-30 dòng không đáng tách riêng

/**
 * applyEmotionDelta — cộng/trừ Emotion Coin, xử lý TOÀN BỘ logic lên level (heal%
 * HP, set Duration hoặc permanent nếu có Light Body, tính lại maxLight, Emotion
 * Surge refill Light). Coin KHÔNG reset khi lên level — bị trừ ĐÚNG mốc đã đạt,
 * phần dư tiếp tục tích lũy hướng tới mốc kế (xem comment đầy đủ ở EMOTION_LEVEL_TABLE).
 *
 * Điều kiện được lên level mới:
 *   - ĐANG có level active (emotionLevel > 0): luôn được lên CAO HƠN ngay khi đủ
 *     coin (thay thế mốc cũ, reset Duration theo mốc mới — KHÔNG vào CD vì vẫn
 *     đang active liên tục, không có khoảng "tắt" giữa 2 mốc).
 *   - KHÔNG có level active (emotionLevel === 0): chỉ được lên nếu đã hết CD
 *     (emotionLevelCooldownLeft <= 0) — dù coin đủ, vẫn bị khoá trong lúc CD.
 * KHÔNG tự xuống level khi coin giảm — level chỉ rớt qua hết Duration (xem
 * advanceCombatantTurn), không liên quan gì tới coin hiện có lúc đó.
 * @returns {string[]} note để hiển thị (VD "🆙 Emotion Level 2! (+10.00 HP...)")
 */
/**
 * applySanityGain — dùng cho MỌI nguồn vốn dĩ "TĂNG" Sanity (Clash thắng +10,
 * Regain Mind +10...) — luật Negative Thoughts (Gloom, [30 Points]): "các nguồn
 * tăng sanity sẽ trở thành giảm" — nếu combatant có perk này, amount (luôn dương)
 * sẽ TRỪ thay vì CỘNG. KHÔNG dùng hàm này cho các nguồn vốn dĩ "GIẢM" Sanity (Shin/
 * Mang -25, Manifest E.G.O -30, No Mind To Cure -25 lúc start, Sinking -1/hit) —
 * luật CHỈ nói đảo chiều TĂNG→GIẢM, không nói ngược lại (GIẢM vẫn giữ nguyên GIẢM
 * dù có Negative Thoughts), những chỗ đó tiếp tục dùng phép trừ trực tiếp như cũ.
 * @param amount số dương (lượng Sanity ĐÁNG LẼ được CỘNG nếu không có perk này)
 */
/**
 * getEffectiveSanityForDiceBonus — luật gốc: "+1 Sanity → +1% dice value, -1 Sanity
 * → -1% dice value". Negative Thoughts (Gloom, [30 Points]) ĐẢO chiều hoàn toàn:
 * "âm Sanity sẽ tăng Dice Value Bonus thay vì giảm và ngược lại" — tương đương lấy
 * NGƯỢC DẤU của currentSanity trước khi đưa vào công thức %dice gốc.
 */
const { getEffectiveSanityForDiceBonus, applySanityGain, applyClashLossSanity, applyEmotionDelta } = require("./sanity-emotion")({ hasPerk, getMaxEmotionLevel, EMOTION_LEVEL_TABLE, EMOTION_LEVEL_DURATION_TURNS, ENCOUNTER_SANITY_MAX }); // ĐÃ TÁCH sang file riêng (sanity-emotion.js)

// Stamina cost cho 1 lần M1 (đánh thường), theo độ nặng vũ khí — vẫn giữ (khác với
// Guard/Evade/Parry đã bỏ, đây là luật riêng đã xác nhận từ trước, không mâu thuẫn
// với transcript — Rover's sheet vẫn cho thấy Stamina bị trừ + hồi 30/turn đúng).
const WEAPON_STAMINA_COST = { light: 5, medium: 10, heavy: 20 };
// 1 lần Guard/Evade/Parry chặn được BAO NHIÊU HIT của 1 đòn ĐÁNH THƯỜNG (M1), tính
// theo vũ khí của BÊN TẤN CÔNG (không phải bên thủ) — luật xác nhận trực tiếp:
// "Guard/evade/parry các đòn đánh thường của Light weapon thì 1 lần sẽ guard/evade/
// parry được 4 hit còn đối với Medium là 2, Heavy là 1". CHỈ áp dụng cho M1 — Page/
// Skill (kind "hit"/enemy dùng skill) vẫn coi 1 charge = chặn cả action, vì luật chỉ
// nói rõ về "đòn đánh thường", không nói gì về skill có hit-count khác biệt.
const WEAPON_DEFENSE_HITS = { light: 4, medium: 2, heavy: 1 };

/** computeDefenseOptions — tính cost/khả dụng của Guard/Evade/Parry cho 1 đòn tấn
 *  công CỤ THỂ sắp tới (dùng cho reactive defense prompt — xác nhận trực tiếp:
 *  "khi bị tấn công thì mới hiện ra hành động phòng thủ, cũng như check coi đủ
 *  sta để làm hành động đó không"). KHÔNG áp dụng gì lên target — chỉ TÍNH TOÁN
 *  để hiển thị, giống hệt công thức cost đã có trong performGuardEvade nhưng
 *  KHÔNG cần "attacker:"/"hits:" tự gõ tay (đã biết sẵn từ pendingAction). */
function computeDefenseOptions(target, attackerWeaponWeight, hitCount, isM1Type, bypass) {
  const hitsPerCharge = isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeaponWeight] ?? 1) : null;
  const chargesNeeded = target.hasIronHorus ? 1 : (hitsPerCharge === null ? 1 : Math.ceil(hitCount / hitsPerCharge));

  const guardCostPerCharge = target.hasIronHorus ? 40 : 10;
  const guardCost = chargesNeeded * guardCostPerCharge;
  const guardAvailable = !bypass.blockGuard && target.currentStamina >= guardCost;

  const evadeBlocked = (target.injuries ?? []).includes("Mất Chân");
  const evadeCostPerCharge = 20 * ((target.injuries ?? []).includes("Gãy chân") ? 2 : 1);
  const evadeCost = chargesNeeded * evadeCostPerCharge;
  const evadeAvailable = !bypass.blockEvade && !evadeBlocked && target.currentStamina >= evadeCost;

  // Parry: 0 Stamina lúc "kích hoạt" — nhưng CÓ THỂ tốn Sta SAU NẾU roll thua
  // (40/30 tùy perk, x2 nếu Gãy tay) — không chặn hiển thị option theo Sta hiện
  // tại vì bản chất Parry "miễn phí lúc quyết định", rủi ro nằm ở kết quả roll.
  const parryAvailable = !bypass.blockParry;

  return {
    chargesNeeded, hitsPerCharge,
    guard: { available: guardAvailable, cost: guardCost },
    evade: { available: evadeAvailable, cost: evadeCost, blockedReason: evadeBlocked ? "Mất Chân" : null },
    parry: { available: parryAvailable },
  };
}


function normalizeWeaponWeight(w) {
  const x = (w ?? "").trim().toLowerCase();
  if (x === "light" || x === "l") return "light";
  if (x === "heavy" || x === "h") return "heavy";
  return "medium"; // default — bao gồm cả khi gõ "medium"/"m"/để trống
}

/** Chuẩn hoá key ngắn cho enemy (VD "Mo" → "mo") — dùng làm định danh trong lệnh,
 *  KHÔNG dùng tên hiển thị đầy đủ (VD "Mo (Brother of Iron)") để gõ lệnh cho nhanh. */
/**
 * resolveEquipTarget — cho phép admin/GM chạy CÁC LỆNH EQUIP (weapon/outfit/
 * accessory/page/egopage) HỘ cho player khác — dùng khi GM cần nhập dữ liệu cũ có
 * sẵn hàng loạt cho nhiều player, thay vì bắt từng người tự gõ lệnh. MẶC ĐỊNH vẫn
 * tự áp dụng cho chính người gõ (giữ nguyên nguyên tắc "trang bị là lựa chọn cá
 * nhân") — CHỈ chuyển sang người khác nếu (a) message có @mention Ở ĐẦU input VÀ
 * (b) người gõ LÀ admin. Non-admin gõ @mention vẫn bị bỏ qua (áp dụng cho chính họ,
 * không throw lỗi — tránh phá vỡ trường hợp @mention xuất hiện tình cờ trong tên
 * item).
 * @returns { targetUserId, targetLabel, remainingInput }
 */

function normalizeEnemyKey(k) {
  return (k ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/** Combatant — dùng CHUNG cho mọi enemy và mọi player trong encounter. */
const { createCombatant } = require("./combatant-factory")({ ENCOUNTER_DEFAULT_MAX_STAMINA, ENCOUNTER_DEFAULT_MAX_LIGHT, ENCOUNTER_SANITY_MAX, normalizeWeaponWeight }); // ĐÃ TÁCH sang file riêng (combatant-factory.js)

const { rollSpeedValue, determineTurnOrder, isCurrentTurnHolder, insertIntoTurnOrderMidRound, advanceToNextTurnHolder, buildTurnOrderText, combatantResStr, trueDmgResStr, haouRuptureResStr, applyParrySuccessPerks, applyEvadeSuccessPerks, restoreInjuryMaxHp, applyDeathPenalty, appendActionLog, getActionLogIcon, checkStaggerPanic } = require("./combat-utils")({ hasPerk, getPlayerDataWithSlot, savePlayerData, calcGrade, CHARGE_MAX, ENCOUNTER_SANITY_MAX });

/** Tiến 1 turn cho 1 combatant — hồi Stamina (hoặc đếm ngược Stagger), đếm ngược
 *  Panic, tính Light gain. Gọi cho TỪNG combatant (mọi enemy + mọi player) khi
 *  -encounter endturn được gọi. */
// "Choáng" KHÔNG nằm trong danh sách này nữa — xem comment đầy đủ ở
// checkStaggerPanic (xác nhận trực tiếp từ GM: không phải injury random, mà là
// counter tự động mỗi lần Stagger).
const MINOR_INJURIES = ["Gãy tay", "Gãy chân", "Gãy Xương"];
const SEVERE_INJURIES = ["Mất tay", "Mất Chân", "Vết thương lớn"];

/**
 * rollInjury — gọi MỖI LẦN 1 combatant nhận dmg trong 1 đòn DUY NHẤT vượt quá 30%
 * Max HP của họ. Roll: 10% chấn thương NẶNG, 40% NHẸ, 50% không gì. Áp dụng hiệu
 * ứng NGAY (maxHp giảm, dazedStacks tăng) — các hiệu ứng còn lại (dice penalty
 * parry/clash, chặn evade, -50% dmg gây ra) được CHECK riêng ở những nơi liên quan
 * (xem comment ở computeAttackerPerkContext/-encounter evade/parry/clash).
 * @returns tên chấn thương vừa nhận, hoặc null nếu không bị gì.
 */
/** getParryClashPenalty — tổng penalty dice Parry/Clash từ TẤT CẢ chấn thương đang
 *  có (Gãy tay -5, Gãy chân -3, Mất Chân -10 — cộng dồn nếu có nhiều). */
const { getParryClashPenalty, rollInjury } = require("./injury-system")({ SEVERE_INJURIES, MINOR_INJURIES }); // ĐÃ TÁCH sang file riêng (injury-system.js)
const { advanceCombatantTurn } = require("./turn-advance")({ hasPerk, ENCOUNTER_STAMINA_REGEN_PER_TURN, EMOTION_LEVEL_COOLDOWN_TURNS }); // ĐÃ TÁCH sang file riêng (turn-advance.js)

const { encounterKey, getEncounter, saveEncounter, deleteEncounter } = require("./encounter-persistence")({ redis, withTimeout }); // ĐÃ TÁCH sang file riêng (encounter-persistence.js)

/** resolveGmLinkedChannel — GM Control Panel (xác nhận trực tiếp): cho phép GM
 *  gõ TOÀN BỘ lệnh `-encounter ...` từ 1 kênh RIÊNG (không phải kênh encounter
 *  chính, tránh trôi chat) sau khi đã `-encounter linkgm channel: <encounter
 *  channel>` — Redis key `gmlink:${channelId GM}` → channelId encounter thật.
 *  Trả về CHÍNH rawChannelId nếu chưa từng link (hành vi mặc định, không đổi gì
 *  với setup thông thường không dùng GM panel). */
async function resolveGmLinkedChannel(rawChannelId) {
  const mapped = await redis.get(`gmlink:${rawChannelId}`);
  return mapped || rawChannelId;
}

const { resolveCombatant, resolveTargets, formatCombatantBlock } = require("./encounter-display")({ normalizeEnemyKey, getMaxEmotionLevel, EMOTION_LEVEL_TABLE }); // ĐÃ TÁCH sang file riêng (encounter-display.js)

/** Action panel — 2 nút cho player bấm thay vì gõ lệnh text (Attack/Hit cần nhập
 *  công thức dmg + target nên mở Modal). Đã bỏ Guard/Evade/Parry (xem comment đầu
 *  file ENCOUNTER SYSTEM — không khớp luật thật). */
/**
 * buildEncounterActionPanel — dropdown ĐỘNG (StringSelectMenu, không còn 2 nút cố
 * định) thay cho action panel cũ — chỉ hiện hành động THỰC SỰ dùng được với
 * combatant CỤ THỂ này (5 Page/E.G.O Page đã equip trên profile, Shin/Mang nếu sở
 * hữu Shin, Manifest E.G.O nếu Emotion Level≥1, Overcharge nếu đủ Charge+perk,
 * Follow-Up/Pounce nếu đủ điều kiện turn này) — Attack/Guard/Evade/Parry luôn hiện
 * vì không cần điều kiện gì. Trả về [] nếu combatant null (người gọi không phải
 * player trong encounter này — VD GM xem status, không có gì để họ "hành động").
 */
/**
 * performGuardEvade — logic CHUNG cho -encounter guard/evade VÀ dropdown hành động
 * (xem encmenu handler). Trả về message kết quả, throw Error nếu thất bại.
 */


/** parseSkillCooldownTurns — đọc field cd của skill ("2 Turn", "1 Turn sau khi...",
 *  "—", "???", text mô tả riêng) → số turn cooldown. Chỉ parse được dạng "<N> Turn"
 *  ở đầu chuỗi — các dạng đặc biệt (text, "—", "???") trả về 0 (không track tự động
 *  được, không chặn gì cả — GM tự nhớ luật riêng cho skill đó nếu cần).
 */

/**
 * doPlayerAttack — logic CHUNG cho `-encounter attack` (text) và nút "Đánh thường"
 * (qua Modal). target có thể là 1 hoặc nhiều enemy (AOE) — mỗi enemy được tính
 * RIÊNG (gọi calcMathCore riêng cho từng enemy, vì mỗi enemy có resistance/Sinking/
 * Rupture/Burn/Bleed/Tremor RIÊNG, crit cũng roll ĐỘC LẬP cho từng enemy dù cùng 1
 * đòn AOE). KHÔNG trừ Stamina ở đây — chỉ TÍNH TRƯỚC và lưu vào pendingActions, trừ
 * THẬT lúc GM xác nhận (xem encconfirmall handler) — để reject không làm mất Stamina
 * oan. staminaCost chỉ tính 1 LẦN cho cả action dù đánh nhiều target (1 đòn M1 chỉ
 * tốn Stamina 1 lần, không phải nhân theo số target).
 * @returns {{ embed }}
 * @throws Error nếu input/điều kiện không hợp lệ
 */
async function doPlayerAttack(channelId, playerId, playerMention, dmgStr, targetStr, verifyOpts = {}) {
  const { skill: skillNameRaw, ref: refRaw, coin: manualCoinRaw, tags: manualTagsRaw, volleys: volleysRaw, ammotype: ammoTypeRaw } = verifyOpts;
  const manualCoin = parseInt(manualCoinRaw ?? "0", 10) || 0;
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
    const player = encounter.players[playerId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này — dùng `-encounter join` trước (không cần gõ tham số gì, tự động lấy hết).");
    if (player.staggered) throw new Error("Bạn đang bị Stagger — không thể hành động turn này.");
    // Turn Order Enforcement (xác nhận trực tiếp): "CHỈ đúng lượt mới được M1/
    // skill — sai lượt thì bị chặn, chỉ phòng thủ phản ứng được thôi" — CHỈ gate
    // M1/skill (hành động CHỦ ĐỘNG), KHÔNG áp dụng cho Guard/Evade/Parry (luôn
    // là phản ứng, có thể xảy ra bất cứ lúc nào theo đúng bản chất "phòng thủ").
    if (!isCurrentTurnHolder(encounter, playerId)) {
      const order = encounter.turnOrder ?? [];
      const holderLabel = order[encounter.currentTurnIndex ?? 0]
        ? (order[encounter.currentTurnIndex].type === "enemy" ? encounter.enemies[order[encounter.currentTurnIndex].id]?.name ?? "?" : `<@${order[encounter.currentTurnIndex].id}>`)
        : "?";
      throw new Error(`Chưa tới lượt bạn — đang là lượt của ${holderLabel}. Bạn vẫn có thể phòng thủ (Guard/Evade/Parry) nếu bị tấn công.`);
    }
    if ((encounter.pendingActions ?? []).length >= ENCOUNTER_PENDING_MAX) throw new Error(`Đã có quá nhiều action chờ xác nhận (tối đa ${ENCOUNTER_PENDING_MAX}) — chờ GM xử lý trước.`);

    const isEyeOfHorus = (player.weaponName ?? "").toLowerCase() === "eye of horus";
    // MÔ HÌNH MỚI (xác nhận trực tiếp, 8 ví dụ cụ thể N=1..8) — "N lần" = số volley
    // TỰ CHỌN bắn NGAY trong hành động NÀY (không phải đếm cộng dồn qua nhiều lần
    // bấm M1 riêng biệt như bản trước) — với Eye Of Horus, dmgStr được TỰ ĐỘNG XÂY
    // DỰNG từ N (không cần/không dùng dmgStr người chơi tự gõ nữa).
    let eyeOfHorusVolleys = null;
    if (isEyeOfHorus && volleysRaw !== undefined && volleysRaw !== null && `${volleysRaw}`.trim() !== "") {
      const N = parseInt(volleysRaw, 10);
      if (!Number.isFinite(N) || N < 1) throw new Error(`"volleys" (số lần bắn) phải là số nguyên ≥1 (nhận được: "${volleysRaw}").`);
      eyeOfHorusVolleys = N;
      const totalVolleys = N + (N === 1 ? 1 : 0);
      const base = N <= 6 ? 4 : 3;
      const typeLetter = { Blunt: "B", Pierce: "P", Slash: "S" }[player.weaponType] ?? "P";
      dmgStr = Array(totalVolleys).fill(`${base}x9${typeLetter}`).join(" + ");
    }
    if (!dmgStr || !dmgStr.trim()) throw new Error("Cần nhập công thức dmg (VD: `50x2B+2Sinking`), hoặc `volleys: <N>` nếu đang dùng Eye Of Horus.");

    // Ammo system (xác nhận trực tiếp): "Frost Ammo: gây 1 Paralyze. Incendiary
    // Ammo: gây 2 Burn." + "Repeat Ammo: Lặp lại viên đạn trước mà không tốn Stack
    // Ammo." — ammotype: frost/incendiary tiêu 1 stack tương ứng (throw nếu không
    // đủ), ammotype: repeat dùng lại lastAmmoTypeUsed KHÔNG tốn gì cả. Hiệu ứng
    // thật (+1 Paralyze/+2 Burn) áp SAU KHI commit thành công (không phải lúc
    // declare) — effectiveAmmoType lưu lại để commit handler biết áp gì.
    let effectiveAmmoType = null;
    const ammoTypeNormalized = (ammoTypeRaw ?? "").trim().toLowerCase();
    if (ammoTypeNormalized === "frost" || ammoTypeNormalized === "incendiary") {
      const field = ammoTypeNormalized === "frost" ? "frostAmmo" : "incendiaryAmmo";
      if ((player[field] ?? 0) < 1) throw new Error(`Không đủ ${ammoTypeNormalized === "frost" ? "Frost Ammo" : "Incendiary Ammo"} (0) trong Encounter — dùng \`-encounter reload type: ${ammoTypeNormalized}\` trước.`);
      player[field] -= 1;
      player.lastAmmoTypeUsed = ammoTypeNormalized;
      effectiveAmmoType = ammoTypeNormalized;
    } else if (ammoTypeNormalized === "repeat") {
      if (!player.lastAmmoTypeUsed) throw new Error(`Chưa có viên đạn đặc biệt nào bắn trước đó để "Repeat Ammo" lặp lại.`);
      effectiveAmmoType = player.lastAmmoTypeUsed; // KHÔNG trừ stack — đúng bản chất Repeat Ammo
    }

    // skill:/ref: — xem comment đầy đủ ở resolveSkillVerification. Gọi TRƯỚC khi
    // build preview vì có thể throw (skill không tồn tại/đang cooldown) — fail sớm,
    // tránh tính toán dư.
    const verify = await resolveSkillVerification(channelId, player, skillNameRaw, refRaw);
    // Mặt nạ chống nhận thức / PerceptionBlockingMask (xác nhận trực tiếp): "đòn
    // tấn công CUỐI CÙNG ở mỗi turn thành [Undodgeable][Unparriable][Unblockable]
    // [Unclashable]" — người chơi tự đánh dấu "đây là đòn cuối turn của tôi" qua
    // `tags: lastaction` (hệ thống không tự biết trước thứ tự hành động trong
    // turn) — nếu CÓ status này VÀ đánh dấu, tự mở rộng thành cả 4 tag.
    const effectiveTagsRaw = player.perceptionBlockingMask && (manualTagsRaw ?? "").toLowerCase().includes("lastaction")
      ? `${manualTagsRaw},undodgeable,unparriable,unblockable,unclashable`
      : manualTagsRaw;
    const defenseBypass = mergeDefenseBypassTags(extractDefenseBypassTags(verify.skillRollEmbed?.description), effectiveTagsRaw);

    const targets = resolveTargets(encounter, targetStr, "enemy_or_player");
    // QUAN TRỌNG: Poise/Charge là "trên bản thân" → lấy từ PLAYER (người tấn công),
    // dùng CHUNG cho mọi target trong AOE (vẫn là 1 người tấn công, 1 lượng Poise).
    // Sinking/Rupture/Burn/Bleed/Tremor là "trên người địch HOẶC player khác (PvP)"
    // → lấy RIÊNG cho từng target — tính calcMathCore riêng từng target.
    const previews = targets.map(t => {
      const perkCtx = computeAttackerPerkContext(player, t.combatant, dmgStr, { isM1: true, targetId: t.id, eyeOfHorusVolleys, attackerId: playerId });
      const defReductionPct = computeDefenderDmgReduction(t.combatant, { isM1: true, attackerId: playerId });
      // Mang (Shin/Mang, đang active): True Dmg — Res target dưới 1x bị ép về 1x;
      // +10%/vòng Dmg M1+skill turn này.
      const mangBonusPct = player.shinMangActive ? player.shinMangRounds * 10 : 0;
      // Eye Of Horus — "sát thương chuẩn" (xác nhận trực tiếp: "tức là sẽ luôn
      // được tính là 1x res khi tấn công kẻ địch, nếu res của chúng dưới 1x") —
      // CÙNG cơ chế "True Dmg" đã có sẵn cho Shin/Mang (trueDmgResStr — ép Res
      // dưới 1x về đúng 1x, không khuếch đại nếu Res đã ≥1x). Tái dùng nguyên hàm
      // đó thay vì viết lại — áp dụng cho MỌI lần bắn Eye Of Horus (không chỉ
      // riêng volley Repeat Ammo), theo đúng yêu cầu "áp dụng tag này luôn".
      const useTrueDmg = player.shinMangActive || isEyeOfHorus;
      // Haou Rupture (xác nhận trực tiếp) — ưu tiên CAO NHẤT (floor 1.5x mạnh hơn
      // True Dmg 1x thường) — chỉ dùng khi THỰC SỰ có tác dụng (ít nhất 1 loại Res
      // đang <1.5x), lưu `applied` để commit handler biết có tiêu 1 stack không.
      const haouRuptureCheck = (t.combatant.haouRupture ?? 0) > 0 ? haouRuptureResStr(t.combatant) : null;
      const finalResStr = haouRuptureCheck?.applied ? haouRuptureCheck.resStr : (useTrueDmg ? trueDmgResStr(t.combatant) : combatantResStr(t.combatant));
      const calcOpts = {
        dmgStr: perkCtx.dmgStrRewritten,
        resStr: finalResStr,
        bonusPct: perkCtx.bonusPct + mangBonusPct, critMul: perkCtx.critMul,
        // Sanity dice bonus ("+1 Sanity = +1% dice value, -1 Sanity = -1%") LUÔN tự
        // áp dụng từ Sanity HIỆN TẠI của người tấn công — KHÔNG phải tham số tự gõ
        // tay (trước đây M1 hoàn toàn THIẾU dòng này, /hit thì có nhưng phải tự gõ
        // — cả 2 đều sai, vì luật nói đây là cơ chế MẶC ĐỊNH không cần khai báo).
        sanityBonusPct: getEffectiveSanityForDiceBonus(player),
        critDiv: perkCtx.critDivOverride ?? undefined,
        poiseInit: player.poise + (perkCtx.redPlumBlossomPoiseBonus ?? 0), chargeInit: player.charge,
        // Attack Power Up/Down (50-Status Nhóm 1) — CHỈ áp dụng cho player ĐANG TẤN
        // CÔNG (attacker), KHÔNG áp cho target.
        flatDmgPerHit: (player.attackPowerUp ?? 0) - (player.attackPowerDown ?? 0),
        sinkingInit: t.combatant.sinking, ruptureInit: t.combatant.rupture,
        // 5 biến thể Tremor (Everlasting/Fracture/Reverb/Decay/Chain) — TRÊN
        // TARGET đang bị Tremor Burst kích hoạt lên (xem comment đầy đủ ở
        // damage-calc.js's calcMathCore).
        tremorEverlastingStacks: t.combatant.tremorEverlasting ?? 0,
        tremorEverlastingBoosted: (t.combatant.borrowedTime ?? 0) > 0,
        tremorFractureStacks: t.combatant.tremorFracture ?? 0,
        tremorReverbStacks: t.combatant.tremorReverb ?? 0,
        tremorDecayStacks: t.combatant.tremorDecay ?? 0,
        tremorChainStacks: t.combatant.tremorChain ?? 0,
        tremorScorchActive: !!player.tremorScorch,
        tremorHemorrhageActive: !!player.tremorHemorrhage,
        burnInit: t.combatant.burn, bleedInit: t.combatant.bleed, tremorInit: t.combatant.tremor,
        sanityInit: t.combatant.currentSanity,
      };
      const preview = calcMathCore(calcOpts);
      // Defender reduction (Smoldering Resolve) áp NGAY ở preview để hiển thị đúng
      // số dự kiến — KHÔNG sửa preview.totalDmg gốc (giữ nguyên cho breakdown), chỉ
      // tính finalDmgAfterReduction riêng để show + dùng lại lúc confirm.
      const finalDmgAfterReduction = preview.totalDmg * (1 - defReductionPct / 100);
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill, eyeOfHorusTremorChargeAmount: perkCtx.eyeOfHorusTremorChargeAmount, haouRuptureApplied: haouRuptureCheck?.applied ?? false };
    });
    const hitCount = previews[0].preview.dmgValues.length;
    // Eye Of Horus — Stamina cost ĐẶC BIỆT: 20 Sta cho MỖI "lần bắn" (volley 9-hit)
    // — tính TRỰC TIẾP từ N (eyeOfHorusVolleys), KHÔNG parse từ dmgStr/hitCount nữa
    // (mô hình mới N đã rõ ràng ngay từ đầu, không cần suy luận ngược).
    const totalVolleysForStamina = eyeOfHorusVolleys ? eyeOfHorusVolleys + (eyeOfHorusVolleys === 1 ? 1 : 0) : 0;
    const staminaCost = isEyeOfHorus ? totalVolleysForStamina * 20 : WEAPON_STAMINA_COST[player.weaponWeight] * hitCount;
    if (player.currentStamina < staminaCost) {
      throw new Error(isEyeOfHorus
        ? `Không đủ Stamina — Eye Of Horus tốn 20 Sta/volley — ${eyeOfHorusVolleys} lần bắn ≈ ${totalVolleysForStamina} volley = ${staminaCost} Sta, còn ${player.currentStamina}.`
        : `Không đủ Stamina — cần ${staminaCost} (${hitCount} hit × ${WEAPON_STAMINA_COST[player.weaponWeight]}/hit vũ khí ${player.weaponWeight}), còn ${player.currentStamina}.`);
    }

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "attack",
      attackerId: playerId, attackerType: "player",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: p.target.type, calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill, eyeOfHorusTremorChargeAmount: p.eyeOfHorusTremorChargeAmount })),
      dmgStr, staminaCost, isM1: true, defenseBypass,
      // Lưu lại kết quả verify — encconfirmall áp dụng emotionDelta + set cooldown
      // THẬT lúc confirm (không phải lúc declare — khớp nguyên tắc "chưa gì là thật
      // cho tới khi GM xác nhận"). refLink/refSnippet/skillRollEmbed chỉ để HIỂN THỊ.
      // emotionDelta = TỔNG của delta tự roll skill (Max/Min dice) + manualCoin (GM/
      // player tự khai từ Clash/giết địch/đồng đội chết — bot không tự detect được).
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
      lightCost: verify.lightCost, sanityCost: verify.sanityCost, effectiveAmmoType,
    });
    // Turn Order Enforcement: hành động THÀNH CÔNG (đã push pendingAction) →
    // tự động chuyển sang người TIẾP THEO trong turnOrder (bỏ qua chết/Stagger).
    advanceToNextTurnHolder(encounter);
    announceCurrentTurn(channelId, encounter).catch(() => {});
    await saveEncounter(channelId, encounter);
    sendReactiveDefensePrompt(channelId, pendingId).catch(() => {});

    const targetLines = previews.map(p => {
      let line = `> → ${p.target.label}: dự kiến **${p.finalDmgAfterReduction.toFixed(3)}** dmg`;
      if (p.defReductionPct > 0) line += ` *(đã giảm ${p.defReductionPct}% từ perk Smoldering Resolve, gốc ${p.preview.totalDmg.toFixed(3)})*`;
      if (p.instantKill) line += ` ☠️ **KẾT LIỄU NGAY** (${p.instantKill})`;
      return line;
    }).join("\n");
    let verifyNote = "";
    if (verify.skillKey) verifyNote += `\n> 🎲 Đã tự roll skill **${verify.skillKey}** kèm theo (xem embed dưới) — Emotion Coin ${verify.emotionDelta >= 0 ? "+" : ""}${verify.emotionDelta} (tự động), CD ${verify.cooldownTurns} turn nếu confirm.`;
    if (manualCoin) verifyNote += `\n> 🪙 Coin tự khai (Clash/kill/...): ${manualCoin >= 0 ? "+" : ""}${manualCoin}`;
    if (verify.refLink) verifyNote += `\n> 🔗 Tham chiếu: ${verify.refLink}\n> > ${verify.refSnippet}`;
    if (verify.busyAsTribbieNote) verifyNote += `\n>${verify.busyAsTribbieNote}`;
    result = {
      embed: {
        title: "🎯 M1 đã thêm vào hàng chờ",
        description:
          `${playerMention} đánh thường (${hitCount} hit) lên ${targets.length > 1 ? `${targets.length} mục tiêu` : targets[0].label}: \`${dmgStr}\`\n` +
          `${targetLines}\n` +
          `> Sẽ trừ **${staminaCost} Stamina** NẾU được GM xác nhận.${verifyNote}\n` +
          `> Dùng \`-encounter pending\` để xem hàng chờ, GM bấm "Confirm tất cả" khi xong turn.`,
        color: 0xf39c12,
      },
      skillRollEmbed: verify.skillRollEmbed,
    };
  });
  return result;
}

/** doPlayerHit — logic CHUNG cho `-encounter hit` (text) và nút "Dùng Page". Page
 *  tốn Light (player tự khai báo/quản lý riêng), KHÔNG đụng tới Stamina. Hỗ trợ
 *  multi-target AOE giống doPlayerAttack. */
async function doPlayerHit(channelId, playerId, playerMention, dmgStr, targetStr, extra = {}) {
  if (!dmgStr || !dmgStr.trim()) throw new Error("Cần nhập công thức dmg (VD: `50x2B+2Sinking`).");
  const { resStr = "", drStr = "", bonusPct = 0, sanityBonusPct = 0, critMul: manualCritMul, diceMul = 1, critDiv = 0, skill: skillNameRaw, ref: refRaw, coin: manualCoinRaw, tags: manualTagsRaw, prefilledVerify } = extra;
  const manualCoin = parseInt(manualCoinRaw ?? "0", 10) || 0;
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
    const player = encounter.players[playerId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này — dùng `-encounter join` trước (không cần gõ tham số gì, tự động lấy hết).");
    if (!isCurrentTurnHolder(encounter, playerId)) {
      const order = encounter.turnOrder ?? [];
      const holderLabel = order[encounter.currentTurnIndex ?? 0]
        ? (order[encounter.currentTurnIndex].type === "enemy" ? encounter.enemies[order[encounter.currentTurnIndex].id]?.name ?? "?" : `<@${order[encounter.currentTurnIndex].id}>`)
        : "?";
      throw new Error(`Chưa tới lượt bạn — đang là lượt của ${holderLabel}. Bạn vẫn có thể phòng thủ (Guard/Evade/Parry) nếu bị tấn công.`);
    }
    if ((encounter.pendingActions ?? []).length >= ENCOUNTER_PENDING_MAX) throw new Error(`Đã có quá nhiều action chờ xác nhận (tối đa ${ENCOUNTER_PENDING_MAX}) — chờ GM xử lý trước.`);

    // GAP ĐÃ SỬA (xác nhận trực tiếp: "Bot tự roll Durandal, tự cho vào phần
    // modal Dmg ra dmg đầu cuối lên kẻ địch") — nếu ĐÃ có verify roll SẴN từ
    // trước (chọn "Critical" từ dropdown, roll lúc đó rồi pre-fill dmgStr vào
    // Modal), TÁI DÙNG NGUYÊN kết quả đó, KHÔNG gọi resolveSkillVerification lại
    // (sẽ roll dice MỚI KHÁC, làm dmgStr pre-fill không khớp embed thật hiển thị
    // lúc confirm).
    const verify = prefilledVerify ?? await resolveSkillVerification(channelId, player, skillNameRaw, refRaw);
    const effectiveTagsRaw = player.perceptionBlockingMask && (manualTagsRaw ?? "").toLowerCase().includes("lastaction")
      ? `${manualTagsRaw},undodgeable,unparriable,unblockable,unclashable`
      : manualTagsRaw;
    const defenseBypass = mergeDefenseBypassTags(extractDefenseBypassTags(verify.skillRollEmbed?.description), effectiveTagsRaw);

    const targets = resolveTargets(encounter, targetStr, "enemy_or_player");
    const previews = targets.map(t => {
      const perkCtx = computeAttackerPerkContext(player, t.combatant, dmgStr, { isM1: false, attackerId: playerId, targetId: t.id });
      const isMiddleSkill = skillNameRaw ? MIDDLE_SYNDICATE_SKILLS.has(skillNameRaw.trim().toLowerCase()) : false;
      const defReductionPct = computeDefenderDmgReduction(t.combatant, { isM1: false, isMiddleSkill, attackerId: playerId });
      const mangBonusPct = player.shinMangActive ? player.shinMangRounds * 10 : 0;
      const haouRuptureCheck = !resStr && (t.combatant.haouRupture ?? 0) > 0 ? haouRuptureResStr(t.combatant) : null;
      const finalResStr = resStr || (haouRuptureCheck?.applied ? haouRuptureCheck.resStr : (player.shinMangActive ? trueDmgResStr(t.combatant) : combatantResStr(t.combatant)));
      const calcOpts = {
        dmgStr: perkCtx.dmgStrRewritten,
        resStr: finalResStr, drStr,
        bonusPct: bonusPct + perkCtx.bonusPct + mangBonusPct,
        // Tự động cộng Sanity HIỆN TẠI của người dùng Page vào dice bonus (xem
        // comment đầy đủ ở doPlayerAttack) — sanityBonusPct (tham số tự gõ tay nếu
        // có) CỘNG THÊM vào, không thay thế, để vẫn linh hoạt cho trường hợp đặc biệt.
        sanityBonusPct: getEffectiveSanityForDiceBonus(player) + sanityBonusPct,
        // critMul: ưu tiên giá trị NGƯỜI DÙNG GÕ TAY (critmul: ...) nếu có — còn
        // không thì lấy từ perk context (giờ ĐÃ đúng default 1.3x, xem comment đầy
        // đủ ở computeAttackerPerkContext — trước đây so sánh "!== 1" để biết "có
        // perk đổi không", giờ default đã là 1.3 nên cách so sánh đó SAI, phải check
        // trực tiếp xem người dùng có gõ critmul: hay không).
        critMul: manualCritMul ?? perkCtx.critMul, diceMul,
        critDiv: perkCtx.critDivOverride ?? critDiv,
        poiseInit: player.poise + (perkCtx.redPlumBlossomPoiseBonus ?? 0), chargeInit: player.charge,
        // Attack Power Up/Down (50-Status Nhóm 1) — CHỈ áp dụng cho player ĐANG TẤN
        // CÔNG (attacker), KHÔNG áp cho target.
        flatDmgPerHit: (player.attackPowerUp ?? 0) - (player.attackPowerDown ?? 0),
        sinkingInit: t.combatant.sinking, ruptureInit: t.combatant.rupture,
        // 5 biến thể Tremor (Everlasting/Fracture/Reverb/Decay/Chain) — TRÊN
        // TARGET đang bị Tremor Burst kích hoạt lên (xem comment đầy đủ ở
        // damage-calc.js's calcMathCore).
        tremorEverlastingStacks: t.combatant.tremorEverlasting ?? 0,
        tremorEverlastingBoosted: (t.combatant.borrowedTime ?? 0) > 0,
        tremorFractureStacks: t.combatant.tremorFracture ?? 0,
        tremorReverbStacks: t.combatant.tremorReverb ?? 0,
        tremorDecayStacks: t.combatant.tremorDecay ?? 0,
        tremorChainStacks: t.combatant.tremorChain ?? 0,
        tremorScorchActive: !!player.tremorScorch,
        tremorHemorrhageActive: !!player.tremorHemorrhage,
        burnInit: t.combatant.burn, bleedInit: t.combatant.bleed, tremorInit: t.combatant.tremor,
        sanityInit: t.combatant.currentSanity,
      };
      const preview = calcMathCore(calcOpts);
      const finalDmgAfterReduction = preview.totalDmg * (1 - defReductionPct / 100);
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill, haouRuptureApplied: haouRuptureCheck?.applied ?? false };
    });

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "hit",
      attackerId: playerId, attackerType: "player",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: p.target.type, calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill })),
      dmgStr, defenseBypass,
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
      lightCost: verify.lightCost, sanityCost: verify.sanityCost,
    });
    // Turn Order Enforcement: hành động THÀNH CÔNG (đã push pendingAction) →
    // tự động chuyển sang người TIẾP THEO trong turnOrder (bỏ qua chết/Stagger).
    advanceToNextTurnHolder(encounter);
    announceCurrentTurn(channelId, encounter).catch(() => {});
    await saveEncounter(channelId, encounter);
    sendReactiveDefensePrompt(channelId, pendingId).catch(() => {});

    const targetLines = previews.map(p => {
      let line = `> → ${p.target.label}: dự kiến **${p.finalDmgAfterReduction.toFixed(3)}** dmg`;
      if (p.defReductionPct > 0) line += ` *(đã giảm ${p.defReductionPct}% từ perk Smoldering Resolve, gốc ${p.preview.totalDmg.toFixed(3)})*`;
      if (p.instantKill) line += ` ☠️ **KẾT LIỄU NGAY** (${p.instantKill})`;
      return line;
    }).join("\n");
    let verifyNote = "";
    if (verify.skillKey) verifyNote += `\n> 🎲 Đã tự roll skill **${verify.skillKey}** kèm theo (xem embed dưới) — Emotion Coin ${verify.emotionDelta >= 0 ? "+" : ""}${verify.emotionDelta} (tự động), CD ${verify.cooldownTurns} turn nếu confirm.`;
    if (manualCoin) verifyNote += `\n> 🪙 Coin tự khai (Clash/kill/...): ${manualCoin >= 0 ? "+" : ""}${manualCoin}`;
    if (verify.refLink) verifyNote += `\n> 🔗 Tham chiếu: ${verify.refLink}\n> > ${verify.refSnippet}`;
    if (verify.busyAsTribbieNote) verifyNote += `\n>${verify.busyAsTribbieNote}`;
    result = {
      embed: {
        title: "🎯 Action đã thêm vào hàng chờ",
        description:
          `${playerMention} dùng Page lên ${targets.length > 1 ? `${targets.length} mục tiêu` : targets[0].label}: \`${dmgStr}\`\n` +
          `${targetLines}${verifyNote}\n` +
          `> Dùng \`-encounter pending\` để xem hàng chờ, GM bấm "Confirm tất cả" khi xong turn.`,
        color: 0xf39c12,
      },
      skillRollEmbed: verify.skillRollEmbed,
    };
  });
  return result;
}

/** doEnemyAttack — GM cho 1 enemy đánh 1 hoặc nhiều player (AOE) — logic gương với
 *  doPlayerAttack/doPlayerHit nhưng đảo chiều self/enemy (enemy là người tấn công →
 *  Poise/Charge từ enemy; player(s) là target → 5 status kia từ TỪNG player riêng). */
async function doEnemyAttack(channelId, gmUserId, enemyKey, dmgStr, targetStr, verifyOpts = {}) {
  if (!dmgStr || !dmgStr.trim()) throw new Error("Cần nhập công thức dmg (VD: `50x2B+2Sinking`).");
  const { skill: skillNameRaw, ref: refRaw, coin: manualCoinRaw, tags: manualTagsRaw } = verifyOpts;
  const manualCoin = parseInt(manualCoinRaw ?? "0", 10) || 0;
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    const isAdmin = ADMIN_IDS.has(gmUserId);
    if (!isAdmin && gmUserId !== encounter.gmId) throw new Error("Chỉ GM/admin mới điều khiển được enemy.");
    const ekey = normalizeEnemyKey(enemyKey);
    const enemy = encounter.enemies[ekey];
    if (!enemy) throw new Error(`Không tìm thấy enemy "${enemyKey}" — dùng \`-encounter status\` để xem danh sách.`);
    if (!isCurrentTurnHolder(encounter, ekey)) {
      const order = encounter.turnOrder ?? [];
      const holderLabel = order[encounter.currentTurnIndex ?? 0]
        ? (order[encounter.currentTurnIndex].type === "enemy" ? encounter.enemies[order[encounter.currentTurnIndex].id]?.name ?? "?" : `<@${order[encounter.currentTurnIndex].id}>`)
        : "?";
      throw new Error(`Chưa tới lượt của "${enemyKey}" — đang là lượt của ${holderLabel}. Enemy này vẫn có thể phòng thủ (Guard/Evade/Parry) nếu bị tấn công.`);
    }
    if ((encounter.pendingActions ?? []).length >= ENCOUNTER_PENDING_MAX) throw new Error(`Đã có quá nhiều action chờ xác nhận (tối đa ${ENCOUNTER_PENDING_MAX}) — xử lý trước.`);

    const verify = await resolveSkillVerification(channelId, enemy, skillNameRaw, refRaw);
    const effectiveTagsRaw = enemy.perceptionBlockingMask && (manualTagsRaw ?? "").toLowerCase().includes("lastaction")
      ? `${manualTagsRaw},undodgeable,unparriable,unblockable,unclashable`
      : manualTagsRaw;
    const defenseBypass = mergeDefenseBypassTags(extractDefenseBypassTags(verify.skillRollEmbed?.description), effectiveTagsRaw);

    const targets = resolveTargets(encounter, targetStr, "player");
    // QUAN TRỌNG: chiều này ENEMY là người tấn công → Poise/Charge lấy từ ENEMY.
    // TARGET (player) là người bị tấn công → 5 status kia lấy từ TỪNG TARGET riêng.
    const previews = targets.map(t => {
      const perkCtx = computeAttackerPerkContext(enemy, t.combatant, dmgStr, { isM1: false, attackerId: enemyKey, targetId: t.id });
      const isMiddleSkill = skillNameRaw ? MIDDLE_SYNDICATE_SKILLS.has(skillNameRaw.trim().toLowerCase()) : false;
      const defReductionPct = computeDefenderDmgReduction(t.combatant, { isM1: false, isMiddleSkill, attackerId: enemyKey });
      const haouRuptureCheck = (t.combatant.haouRupture ?? 0) > 0 ? haouRuptureResStr(t.combatant) : null;
      const calcOpts = {
        dmgStr: perkCtx.dmgStrRewritten, resStr: haouRuptureCheck?.applied ? haouRuptureCheck.resStr : combatantResStr(t.combatant),
        bonusPct: perkCtx.bonusPct, critMul: perkCtx.critMul, critDiv: perkCtx.critDivOverride ?? undefined,
        sanityBonusPct: getEffectiveSanityForDiceBonus(enemy),
        poiseInit: enemy.poise + (perkCtx.redPlumBlossomPoiseBonus ?? 0), chargeInit: enemy.charge,
        // Attack Power Up/Down (50-Status Nhóm 1) — enemy ĐANG TẤN CÔNG.
        flatDmgPerHit: (enemy.attackPowerUp ?? 0) - (enemy.attackPowerDown ?? 0),
        sinkingInit: t.combatant.sinking, ruptureInit: t.combatant.rupture,
        // 5 biến thể Tremor (Everlasting/Fracture/Reverb/Decay/Chain) — TRÊN
        // TARGET đang bị Tremor Burst kích hoạt lên (xem comment đầy đủ ở
        // damage-calc.js's calcMathCore).
        tremorEverlastingStacks: t.combatant.tremorEverlasting ?? 0,
        tremorEverlastingBoosted: (t.combatant.borrowedTime ?? 0) > 0,
        tremorFractureStacks: t.combatant.tremorFracture ?? 0,
        tremorReverbStacks: t.combatant.tremorReverb ?? 0,
        tremorDecayStacks: t.combatant.tremorDecay ?? 0,
        tremorChainStacks: t.combatant.tremorChain ?? 0,
        tremorScorchActive: !!enemy.tremorScorch,
        tremorHemorrhageActive: !!enemy.tremorHemorrhage,
        burnInit: t.combatant.burn, bleedInit: t.combatant.bleed, tremorInit: t.combatant.tremor,
        sanityInit: t.combatant.currentSanity,
      };
      const preview = calcMathCore(calcOpts);
      const finalDmgAfterReduction = preview.totalDmg * (1 - defReductionPct / 100);
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill, haouRuptureApplied: haouRuptureCheck?.applied ?? false };
    });

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "enemyattack",
      attackerId: ekey, attackerType: "enemy",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: "player", calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill })),
      dmgStr, defenseBypass,
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
      lightCost: verify.lightCost, sanityCost: verify.sanityCost,
    });
    // Turn Order Enforcement: hành động THÀNH CÔNG (đã push pendingAction) →
    // tự động chuyển sang người TIẾP THEO trong turnOrder (bỏ qua chết/Stagger).
    advanceToNextTurnHolder(encounter);
    announceCurrentTurn(channelId, encounter).catch(() => {});
    await saveEncounter(channelId, encounter);
    // Reactive Defense Prompt (xác nhận trực tiếp, mô hình Yugioh Master Duel
    // Chain): gửi NGAY prompt phòng thủ cho target — KHÔNG chờ GM "Confirm tất
    // cả" nữa. Fire-and-forget (không await, không throw nếu gửi lỗi) — action
    // vẫn tồn tại an toàn trong pendingActions làm fallback (GM vẫn có thể
    // confirm thủ công qua `-encounter pending`/"Confirm tất cả" như cũ nếu
    // prompt gặp trục trặc).
    sendReactiveDefensePrompt(channelId, pendingId).catch(() => {});

    const targetLines = previews.map(p => {
      let line = `> → ${p.target.label}: dự kiến **${p.finalDmgAfterReduction.toFixed(3)}** dmg`;
      if (p.defReductionPct > 0) line += ` *(đã giảm ${p.defReductionPct}% từ perk Smoldering Resolve, gốc ${p.preview.totalDmg.toFixed(3)})*`;
      if (p.instantKill) line += ` ☠️ **KẾT LIỄU NGAY** (${p.instantKill})`;
      return line;
    }).join("\n");
    let verifyNote = "";
    if (verify.skillKey) verifyNote += `\n> 🎲 Đã tự roll skill **${verify.skillKey}** kèm theo (xem embed dưới) — Emotion Coin ${verify.emotionDelta >= 0 ? "+" : ""}${verify.emotionDelta} (tự động), CD ${verify.cooldownTurns} turn nếu confirm.`;
    if (manualCoin) verifyNote += `\n> 🪙 Coin tự khai (Clash/kill/...): ${manualCoin >= 0 ? "+" : ""}${manualCoin}`;
    if (verify.refLink) verifyNote += `\n> 🔗 Tham chiếu: ${verify.refLink}\n> > ${verify.refSnippet}`;
    if (verify.busyAsTribbieNote) verifyNote += `\n>${verify.busyAsTribbieNote}`;
    result = {
      embed: {
        title: "🎯 Enemy attack đã thêm vào hàng chờ",
        description:
          `**${enemy.name}** đánh ${targets.length > 1 ? `${targets.length} player` : targets[0].label}: \`${dmgStr}\`\n` +
          `${targetLines}${verifyNote}\n` +
          `> Dùng \`-encounter pending\` để xem hàng chờ, "Confirm tất cả" khi xong.`,
        color: 0xf39c12,
      },
      skillRollEmbed: verify.skillRollEmbed,
    };
  });
  return result;
}

/** buildEncounterBoardEmbed — hiện TẤT CẢ enemy + TẤT CẢ player + danh sách pending
 *  action đang chờ (rút gọn, không hiện hết chi tiết — xem `-encounter pending` cho
 *  đầy đủ). */
const { buildEncounterBoardEmbed } = require("./encounter-board")({ buildTurnOrderText, formatCombatantBlock }); // ĐÃ TÁCH sang file riêng (encounter-board.js)

/** buildPendingListText — danh sách đầy đủ pending action cho `-encounter pending`. */
/** buildDothihelpEmbed — nội dung help ĐẦY ĐỦ, dùng CHUNG cho cả `-dothihelp`
 *  (gửi qua DM) và `/dothihelp` (ephemeral) — tách riêng để không lặp code 2 nơi. */
const { buildDothihelpEmbed } = require("./dothihelp")({ RTPARRY_WINDOW_MS, POISE_MAX, EXP_MAX }); // ĐÃ TÁCH sang file riêng (dothihelp.js)




// Số entry tối đa mỗi trang inventory
const INV_PAGE_SIZE = 15;

/**
 * Tách toàn bộ books + items thành mảng pages (mỗi page là mảng fields).
 * Trả về null nếu kho trống.
 */
const { buildInventoryPages, buildInvEmbed, buildInvRow, buildInvSelectMenu, fetchInventoryReply } = require("./inventory-display")({ getPlayerData, INV_PAGE_SIZE }); // ĐÃ TÁCH sang file riêng (inventory-display.js)

// ─── SHARED BUSINESS LOGIC: GIVE / REMOVE ────────────────────────────────────
/**
 * executeGive / executeRemove / buildProfileInfoEmbed đã tách sang player-actions.js
 * (file riêng, dùng dependency-injection để không phải tạo redis client thứ 2 — xem
 * comment đầu file đó để biết lý do chọn pattern này). Inject toàn bộ helper cần thiết
 * vào đây 1 lần duy nhất; vị trí đặt require này PHẢI sau khi các const (redis, EXP_MAX,
 * MAX_PROFILES, PROFILE_EMOJIS) đã được khai báo phía trên — các hàm helper khác là
 * function declaration nên được hoisted, không bị ảnh hưởng bởi vị trí.
 */
const { executeGive, executeRemove, buildProfileInfoEmbed } = require("./player-actions")({
  redis,
  getPlayerDataWithSlot,
  saveMultiplePlayerData,
  savePlayerData,
  calcExpForGrade,
  clampExp,
  calcGrade,
  getActiveProfileSlot,
  getProfileNames,
  resolveProfileLabel,
  getVNDateString,
  playerKeyForSlot,
  dailyKeyForSlot,
  withTimeout,
  unwrapPipelineResults,
  formatNumber,
  auditLog,
  EXP_MAX,
  MAX_PROFILES,
  PROFILE_EMOJIS,
});

/**
 * executeCraft — logic craft dùng chung cho prefix -use và slash /use
 * Phải được gọi bên trong withLock của userId.
 * @returns {Promise<{ outputLines: string[], costLines: string[] }>}
 */
const { executeCraft } = require("./craft-system")({ CRAFT_RECIPES, getPlayerDataWithSlot, savePlayerData }); // ĐÃ TÁCH sang file riêng (craft-system.js)

/**
 * parseBatchEntries — parse chuỗi "Tên x<số>, Tên x<số>" thành mảng entries
 * @param {string} raw          — chuỗi input
 * @param {Function} findFn     — hàm lookup tên (findBook / findItem / findItemAdmin)
 * @param {string} entityLabel  — "sách" hoặc "vật phẩm" (dùng trong thông báo lỗi)
 * @returns {{ entries: Array<{name:string,count:number}> } | { error: string }}
 */




// ─── SKILL DATA (tách sang skills.js) ───────────────────────────────────────
const { SKILLS, SKILL_ALIASES, findSkill, findByKeyword, r, computeEmotionDelta, startEmotionTracking, stopEmotionTracking, startForceMinDice, stopForceMinDice, setDiceModifier, clearDiceModifier, autoBuildDmgStrFromSkillRoll } = require("./skills");
const { buildEncounterActionPanel, buildBossActionPanel } = require("./encounter-panels")({ findSkill, hasPerk }); // ĐÃ TÁCH sang file riêng (encounter-panels.js) — đặt SAU import skills.js để tránh TDZ (findSkill là const)
const { performGuardEvade, performParry, performShinMang, performManifestEgo, performOvercharge, performFollowUp } = require("./encounter-actions")({ withLock, encounterKey, getEncounter, saveEncounter, normalizeEnemyKey, hasPerk, getParryClashPenalty, checkStaggerPanic, appendActionLog, ENCOUNTER_SANITY_MAX, r, doPlayerHit, resolveCombatant, WEAPON_DEFENSE_HITS }); // ĐÃ TÁCH sang file riêng (encounter-actions.js) — doPlayerHit hoisted an toàn dù định nghĩa NẰM SAU (function declaration)
const { findWeapon } = require("./weapon");

/**
 * findWeaponAnywhere — tìm vũ khí ở weapon.js TRƯỚC, không có thì fallback qua
 * skills.js (entry có tags:"Weapon" VÀ có weaponType/weaponDmg — phân biệt với
 * entry chỉ là weaponOf:"X" của 1 Critical, không phải định nghĩa vũ khí gốc).
 * Chuẩn hoá về CÙNG shape với weapon.js để code equip/join dùng chung được. Đặt
 * TOP-LEVEL (không nest trong handler) để dùng được ở cả -equipweapon VÀ -encounter
 * join (đọc lại weapon đã equip từ profile).
 */
function findWeaponAnywhere(raw) {
  const fromFile = findWeapon(raw);
  if (fromFile) return fromFile;
  const skillEntry = findSkill(raw);
  if (skillEntry && skillEntry.tags === "Weapon" && (skillEntry.weaponType || skillEntry.weaponDmg)) {
    const dmgStr = skillEntry.weaponDmg ?? "";
    const baseDamageMatch = dmgStr.match(/^([\d.]+)/);
    const typeMatch = dmgStr.match(/Slash|Pierce|Blunt/i);
    return {
      name: skillEntry.name,
      weight: (skillEntry.weaponType ?? "medium").toLowerCase(),
      type: typeMatch ? typeMatch[0][0].toUpperCase() + typeMatch[0].slice(1).toLowerCase() : "Blunt",
      baseDamage: baseDamageMatch ? parseFloat(baseDamageMatch[1]) : 0,
      passives: skillEntry.passive ? [{ name: "(passive)", desc: skillEntry.passive }] : [],
      // bản thân entry này CHÍNH LÀ weapon — Critical riêng (nếu có) là các entry
      // weaponOf:"<tên>" KHÁC, tự -skill roll riêng, không qua criticalSkillKey này.
      criticalSkillKey: null,
    };
  }
  return null;
}
const { findOutfit } = require("./outfit");
const { findAccessory } = require("./accessory");
const { buildBalanceEmbed } = require("./balance-display")({ getPlayerData, calcGrade, GRADE_MAX, calcSkillTreePointsEarned, calcBranchPointsAllocated, PERK_BRANCH, PERK_POINT_COSTS, BRANCH_KEYS, formatNumber, EXP_MAX, INVENTORY_HINT_TEXT, findWeaponAnywhere, findOutfit, findAccessory, findSkill, isEgoSkill, getEgoTier, UNIVERSALLY_KNOWN_WEAPONS }); // ĐÃ TÁCH sang file riêng (balance-display.js) — đặt SAU findOutfit/findAccessory (const, TDZ)

/** isEgoSkill — check skill.tags có chứa "EGO"/"E.G.O" không (case-insensitive,
 *  bỏ qua dấu chấm/khoảng trắng) — dùng để phân biệt Page thường vs E.G.O Page lúc
 *  equip (5 slot riêng, không chung với 5 Page thường — đúng luật "E.G.O Page sẽ
 *  không tính slot chung với 5 Page thường"). */
function isEgoSkill(skill) {
  return /e\.?g\.?o/i.test((skill.tags ?? "").replace(/<:[^>]+>/g, ""));
}

// 5 E.G.O Slot riêng theo Tier (luật: "5 E.G.O Slot Page riêng với các tier như
// ZAYIN/TETH/HE/WAW/ALEPH" — mỗi loại tier CHỈ lắp được 1 slot, KHÔNG phải 5 slot
// chung cho EGO bất kỳ). Thứ tự slot 1→5 theo đúng thứ tự liệt kê trong luật, từ
// thấp tới cao (đúng convention Library of Ruina/Limbus): ZAYIN, TETH, HE, WAW, ALEPH.
const EGO_TIER_SLOT_ORDER = ["ZAYIN", "TETH", "HE", "WAW", "ALEPH"];
/** getEgoTier — tìm tier (ZAYIN/TETH/HE/WAW/ALEPH) từ tags của skill, dựa vào tên
 *  emoji nhúng trong đó (VD tags: "Ego Pages <:TETH:...>" → "TETH"). Trả null nếu
 *  không tìm thấy tier nào (skill không phải EGO Page có tier rõ ràng). */
function getEgoTier(skill) {
  const tagsStr = skill.tags ?? "";
  for (const tier of EGO_TIER_SLOT_ORDER) {
    if (new RegExp(`<:${tier}:\\d+>`, "i").test(tagsStr)) return tier;
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
const { parseSkillCooldownTurns, parseSkillCost, extractDefenseBypassTags, mergeDefenseBypassTags, forceStagger, resolveSkillVerification } = require("./skill-verification")({ findSkill, hasPerk, isEgoSkill, buildSkillRollResult, client, ENCOUNTER_SANITY_MAX, annotateLinesWithEmotion, autoBuildDmgStrFromSkillRoll, r, combatantResStr });
// Tăng giới hạn listener — kiến trúc CÓ CHỦ Ý dùng NHIỀU client.on("interactionCreate",
// ...) riêng biệt (mỗi cái tự check customId prefix, return sớm nếu không khớp) thay
// vì 1 handler khổng lồ — KHÔNG PHẢI memory leak thật, chỉ là số lượng listener hợp lệ
// vượt ngưỡng CẢNH BÁO mặc định (10) của Node EventEmitter — verify bằng test thật
// xác nhận mọi listener hoạt động đúng, không có rò rỉ nào.
client.setMaxListeners(30);

let botReady = false;
client.once("ready", () => {
  botReady = true;
  log("info", "startup", "system", `Bot online: ${client.user.tag}`);
});

// ─── PREFIX COMMANDS ──────────────────────────────────────────────────────────
// ─── SHARED CORE: SKILL LIST / ROLL ─────────────────────────────────────────
// Tách riêng phần "tính toán + build embed" ra khỏi phần "parse input theo từng
// loại lệnh" — để /skill (slash, structured options) và -skill (prefix, tự parse
// chuỗi) dùng CHUNG logic này, tránh lệch hành vi giữa 2 dạng lệnh (như đã từng xảy
// ra với /profile info trước đây).

/**
 * buildSkillListResult — build embed danh sách skill, có/không kèm keyword filter.
 * @returns {{ error: string } | { embed: object }}
 */
function buildSkillListResult({ keyword = null, page = 1 } = {}) {
  if (keyword) {
    const KW_PAGE_SIZE = 10;
    const found = findByKeyword(keyword);
    if (!found.length) {
      return { error: `❌ Không tìm thấy skill nào có keyword **${keyword}**.\nDùng \`-skill list\` để xem toàn bộ.` };
    }
    const totalPages = Math.ceil(found.length / KW_PAGE_SIZE);
    const clampedPage = Math.min(Math.max(page, 1), totalPages);
    const start = (clampedPage - 1) * KW_PAGE_SIZE;
    const pageSkills = found.slice(start, start + KW_PAGE_SIZE);
    const list = pageSkills.map(s => `• **${s.name}** — ${s.cost} | CD: ${s.cd}`).join("\n");
    return {
      embed: {
        title: `🔍 Skill có keyword "${keyword}" (${found.length} kết quả) — Trang ${clampedPage}/${totalPages}`,
        color: 0x9b59b6,
        description: list,
        footer: { text: `-skill list ${keyword} <trang> để xem trang khác | -skill <tên> để roll` },
      },
    };
  }

  const PAGE_SIZE = 15;
  const skillEntries = Object.values(SKILLS);
  const totalPages = Math.ceil(skillEntries.length / PAGE_SIZE);
  const clampedPage = Math.min(Math.max(page, 1), totalPages);
  const start = (clampedPage - 1) * PAGE_SIZE;
  const pageSkills = skillEntries.slice(start, start + PAGE_SIZE);
  const skillLines = pageSkills.map((s, i) => {
    const num = start + i + 1;
    const tags = [];
    if (s.weaponOf) tags.push(`⚔️ ${s.weaponOf}`);
    if (s.needsBlackFlash) tags.push("nhập %");
    if (s.needsReuse) tags.push("nhập %reuse");
    if (s.hasDullahanRoll) tags.push("mặc định bản thường, nhập dullahan để ra bản Dullahan");
    if (s.maxUses) tags.push(`reuse tối đa ${s.maxUses}x`);
    const tagStr = tags.length ? ` *(${tags.join(", ")})*` : "";
    return `\`${num}.\` **${s.name}**${tagStr} — ${s.cost} | CD: ${s.cd} | ${s.diceMul}`;
  });
  return {
    embed: {
      title: `📖 Danh sách Skill (Trang ${clampedPage}/${totalPages})`,
      color: 0x9b59b6,
      description: skillLines.join("\n"),
      footer: { text: `Tổng ${skillEntries.length} skill | -skill list <trang> | -skill <tên> [số lần] để roll (VD: -skill durandal 2)` },
    },
  };
}

/**
 * formatEmotionSummary — build dòng tổng kết Emotion Coin từ mảng tracked rolls.
 * CHỈ hiển thị cho người chơi tự cộng/trừ tay — không lưu lại ở đâu cả.
 */
function formatEmotionSummary(tracked) {
  const total = tracked.reduce((sum, t) => sum + t.delta, 0);
  const maxHits = tracked.filter(t => t.delta > 0).length;
  const minHits = tracked.filter(t => t.delta < 0).length;
  if (maxHits === 0 && minHits === 0) {
    return `<:EmotionCoin:1517705929989033994> Emotion Coin: 0 *(không có Max/Min Dice)*`;
  }
  const parts = [];
  if (maxHits > 0) parts.push(`${maxHits}× Max`);
  if (minHits > 0) parts.push(`${minHits}× Min`);
  const sign = total > 0 ? "+" : "";
  return `<:EmotionCoin:1517705929989033994> Emotion Coin: **${sign}${total}** *(${parts.join(", ")})*`;
}

// Khớp dòng dice bằng emoji <:Dice1:...> đến <:Dice5:...> ở ĐẦU dòng — không phụ thuộc
// việc skill dùng biến D1..D5 hay hardcode literal, vì cả 2 đều match cùng pattern.
const DICE_LINE_RE = /^<:Dice(10|[1-9]):\d+>/;

/**
 * annotateLinesWithEmotion — gắn "<:EmotionCoin:...> +1/-1" NGAY CUỐI từng dòng dice
 * tương ứng, AN TOÀN chỉ khi số dòng có emoji Dice khớp CHÍNH XÁC với số lần roll thật
 * VÀ không có dice-number nào bị lặp lại (xem giải thích case lặp bên dưới).
 *
 * TẠI SAO CẦN CHECK SỐ LƯỢNG: đã quét thực tế cả 290 skill — nếu chỉ zip theo index thô
 * (dòng thứ N ↔ roll thứ N) thì 111/285 skill (39%) bị lệch, vì nhiều skill có dòng
 * "flavor text" không gắn với dice nào (VD: "*+5% Dmg cho skill này...*"). Lọc theo dòng
 * CÓ emoji Dice giảm lệch xuống còn ~32/285 (11%).
 *
 * TẠI SAO CẦN CHECK KHÔNG LẶP DICE-NUMBER: một số skill (VD: "Tiantui Savage Tigerslayer
 * Flurry") có dòng flavor DÙNG LẠI emoji Dice1 (để chỉ rõ "đây là hiệu ứng phụ của Dice 1")
 * NGAY TRƯỚC dòng Dice1 thật — y hệt style "Fare-Thee Well"/"Gut Stab Laevateinn". Nếu
 * skill đó CÓ ĐỦ SỐ DICE để tổng count vẫn khớp tình cờ (VD: 6 dice thật + 1 dòng flavor
 * dùng lại D1 - 1 dòng "Dice 6" không có emoji = vẫn ra 6 = 6), check số lượng đơn thuần
 * SẼ PASS NHẦM — gắn lệch delta sang dòng kế bên, dòng dice thật cuối cùng (có thể là Max
 * roll) bị mất tag hoàn toàn. Đã tự bắt được case này khi test "Tiantui Savage Tigerslayer
 * Flurry" — số lượng khớp (6=6) nhưng vị trí lệch hết 1 dòng. Check thêm: nếu có dice-number
 * nào xuất hiện ≥2 lần trong các dòng matched, coi như không an toàn, fallback luôn.
 */
function annotateLinesWithEmotion(lines, tracked) {
  const diceLineIndices = [];
  const diceNumbersSeen = [];
  lines.forEach((l, i) => {
    const m = l.match(DICE_LINE_RE);
    if (m) { diceLineIndices.push(i); diceNumbersSeen.push(m[1]); }
  });
  const hasDuplicateDiceNumber = new Set(diceNumbersSeen).size !== diceNumbersSeen.length;

  if (!hasDuplicateDiceNumber && diceLineIndices.length === tracked.length) {
    const result = [...lines];
    diceLineIndices.forEach((lineIdx, i) => {
      const { delta } = tracked[i];
      if (delta !== 0) result[lineIdx] += ` <:EmotionCoin:1517705929989033994> ${delta > 0 ? "+1" : "-1"}`;
    });
    return result.join("\n");
  }

  // Không khớp 1:1 (hoặc có dice-number lặp, nghi vấn flavor line) — fallback an toàn:
  // giữ nguyên dòng gốc, thêm 1 dòng tổng kết riêng thay vì liều gắn nhầm.
  return lines.join("\n") + "\n" + formatEmotionSummary(tracked);
}

/**
 * buildSkillRollResult — roll 1 skill (1 hoặc nhiều lần) và build embed kết quả.
 * Input đã được resolve sẵn (skill object, rollCount số, promptArgRaw chuỗi thô) —
 * hàm này KHÔNG tự parse chuỗi lệnh, để prefix/slash tự lo phần đó theo cách riêng.
 * @returns {{ error: string } | { embed: object }}
 */
function buildSkillRollResult({ skill, rollCount = 1, promptArgRaw = null, forceDullahan = false, forceMinDice = false, diceModifier = 0 }) {
  // Skill đặc biệt cần arg — dùng promptArg nếu có (VD: Thrust cần nhập Light hiện tại)
  if (skill.promptArg) {
    const { parse, validate, errorMsg, buildHeader } = skill.promptArg;
    const parsed = parse(promptArgRaw ?? "");
    if (!validate(parsed)) return { error: errorMsg };
    startEmotionTracking();
    if (forceMinDice) startForceMinDice();
    if (diceModifier !== 0) setDiceModifier(diceModifier);
    const lines = skill.roll(parsed);
    if (forceMinDice) stopForceMinDice();
    if (diceModifier !== 0) clearDiceModifier();
    const tracked = stopEmotionTracking();
    const header = buildHeader(parsed, skill);
    return {
      embed: {
        title: `🎲 ${skill.name}`,
        color: skill.embedColor ?? 0x5865f2,
        description: header + "\n\n" + annotateLinesWithEmotion(lines, tracked),
      },
      totalEmotionDelta: tracked.reduce((sum, t) => sum + t.delta, 0),
      // firstDiceValue — dùng cho Clash ("luôn luôn lấy dice ĐẦU TIÊN để clash") —
      // tái dùng side-channel tracking CÓ SẴN (không regex parse text, không sửa
      // 303 skill roll() — tracked[0] LÀ giá trị r() đầu tiên gọi trong roll(),
      // đúng thứ tự Dice1 luôn được tính trước theo cách roll() của mọi skill viết).
      firstDiceValue: tracked[0]?.result ?? null,
    };
  }

  // Clamp rollCount: ưu tiên skill.maxUses riêng (VD: Mook Workshop = 3, do reuse
  // chỉ cho phép tối đa 2 lần) nếu có, không thì dùng SKILL_MAX_ROLLS chung.
  const maxAllowed = skill.maxUses ?? SKILL_MAX_ROLLS;
  if (rollCount < 1) return { error: "❌ Số lần roll phải lớn hơn 0." };
  if (rollCount > maxAllowed) return { error: `❌ **${skill.name}** chỉ cho roll tối đa **${maxAllowed}** lần mỗi lệnh.` };

  const header = skill.weaponOf
    ? `[🗡️ ${skill.weaponOf}] [CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`
    : skill.cost !== "—"
      ? `[${skill.cost}] [CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`
      : `[CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`;

  // Roll rollCount lần độc lập — mỗi lần dice riêng. Truyền reuseIndex (0 = lần
  // gốc, 1 = reuse lần 1, 2 = reuse lần 2, ...) thay vì boolean đơn thuần, để skill
  // nào cần tính hiệu ứng cộng dồn theo số lần reuse (VD: Thrust +5 Dice Up/lần)
  // có đủ thông tin. Vẫn tương thích ngược với skill cũ dùng `isReuse ? x : y`
  // (VD: Mook Workshop) vì reuseIndex=0 falsy, ≥1 truthy — hành vi y nguyên.
  // Bọc start/stopEmotionTracking quanh MỖI lần roll() để biết dice nào trong lần đó
  // ra Max/Min — xem comment ở r() trong skills.js để hiểu cơ chế side-channel này.
  const blocks = [];
  const allTracked = [];
  for (let i = 0; i < rollCount; i++) {
    const reuseIndex = i;
    startEmotionTracking();
    if (forceMinDice) startForceMinDice();
    if (diceModifier !== 0) setDiceModifier(diceModifier);
    const lines = skill.hasDullahanRoll ? skill.roll(forceDullahan, reuseIndex) : skill.roll(reuseIndex);
    if (forceMinDice) stopForceMinDice();
    if (diceModifier !== 0) clearDiceModifier();
    const tracked = stopEmotionTracking();
    allTracked.push(...tracked);
    const block = annotateLinesWithEmotion(lines, tracked);
    blocks.push(rollCount > 1 ? `**Lần ${i + 1}:**\n${block}` : block);
  }
  let description = header + "\n\n" + blocks.join("\n\n");
  if (rollCount > 1) {
    description += `\n\n**Tổng cộng cả ${rollCount} lần:** ${formatEmotionSummary(allTracked)}`;
  }
  // Embed description giới hạn 4096 ký tự — cắt an toàn nếu roll nhiều lần dồn quá dài.
  if (description.length > 4090) {
    description = description.slice(0, 4080) + "\n…(bị cắt bớt, giảm số lần roll để xem đầy đủ)";
  }

  return {
    embed: {
      title: rollCount > 1 ? `🎲 ${skill.name} ×${rollCount}` : `🎲 ${skill.name}`,
      color: 0x5865f2,
      description,
    },
    totalEmotionDelta: allTracked.reduce((sum, t) => sum + t.delta, 0),
    firstDiceValue: allTracked[0]?.result ?? null,
  };
}


/**
 * getBookTopLevelChoices — TẦNG 1 lựa chọn khi đọc 1 cuốn sách — với sách THƯỜNG
 * (không có `groups`), đây là DANH SÁCH CUỐI (mỗi option = 1 page/weapon/outfit cụ
 * thể, chọn xong là XONG). Với "Library Book" (CÓ `groups`), tầng 1 chỉ gồm
 * "Light Dash" (nếu có trong pages) + TÊN 7 NHÓM (không phải page cụ thể) — chọn 1
 * nhóm thì cần gọi getBookGroupChoices để lấy TẦNG 2.
 * @returns {Array<{ type: "page"|"weapon"|"outfit"|"group", name: string }>}
 */

  /** performGachaPull — logic pull THẬT (trừ Lunacy, roll, cộng item vào inventory,
 *  lưu) — TÁCH ra để dùng chung CẢ cho lệnh text (`-gacha <count>`) LẪN nút bấm
 *  UI mới (xem buildGachaPanel/handler "gachapull:"). Throw Error nếu không đủ
 *  Lunacy — CALLER tự bắt và hiển thị theo cách phù hợp. */
async function performGachaPull(userId, count) {
  let resultInfo;
  await withLock(userId, async () => {
    const { data: profileData, slot } = await getPlayerDataWithSlot(userId);
    const totalCost = GACHA_COST_PER_PULL * count;
    const currentLunacy = profileData.lunacy ?? 0;
    if (currentLunacy < totalCost) {
      throw new Error(`Không đủ <:Lunacy:1524989409529823342>Lunacy — cần **${formatNumber(totalCost)}** (${count} lần × ${GACHA_COST_PER_PULL}), hiện có **${formatNumber(currentLunacy)}**.`);
    }
    profileData.lunacy = currentLunacy - totalCost;
    profileData.items = profileData.items ?? {};
    profileData.books = profileData.books ?? {};
    const results = [];
    const rareHits = [];
    for (let i = 0; i < count; i++) {
      const item = rollGachaOnce();
      // BUG ĐÃ SỬA (xác nhận trực tiếp): trước đây MỌI thứ rớt ra (kể cả sách)
      // đều bị cộng thẳng vào profileData.items — sách phải nằm ở profileData.books
      // (đúng chỗ -inventory/-give hiện có đã phân biệt từ trước, VALID_BOOKS là
      // danh sách sách hợp lệ CHUẨN — dùng lại để định tuyến đúng, không đoán).
      if (VALID_BOOKS.includes(item)) {
        profileData.books[item] = (profileData.books[item] ?? 0) + 1;
      } else {
        profileData.items[item] = (profileData.items[item] ?? 0) + 1;
      }
      results.push(item);
      if (GACHA_POOL_RARE.includes(item)) rareHits.push(item);
    }
    await savePlayerData(userId, profileData, slot);
    const counted = {};
    for (const item of results) counted[item] = (counted[item] ?? 0) + 1;
    const resultLines = Object.entries(counted).map(([item, n]) => `${GACHA_POOL_RARE.includes(item) ? "🌟" : GACHA_POOL_MID.includes(item) ? "✨" : "▫️"} ${item}${n > 1 ? ` x${n}` : ""}`);
    resultInfo = { totalCost, resultLines, rareHits, remainingLunacy: profileData.lunacy };
  });
  return resultInfo;
}

/** buildGachaPanelEmbed — bảng UI gacha đẹp (xác nhận trực tiếp: "nên làm ra một
 *  cái UI gacha cùng với hiển thị rate, danh sách để cho nó đẹp") — hiện đủ 3
 *  tier + % TỪNG item (tính từ GACHA_RATES/pool.length, không phải chỉ % tổng
 *  tier) + Lunacy hiện có + nút Pull x1/x10. */
function buildGachaPanelEmbed(lunacy) {
  const rateHigh = (GACHA_RATES.high / GACHA_POOL_HIGH.length).toFixed(2);
  const rateMid = (GACHA_RATES.mid / GACHA_POOL_MID.length).toFixed(2);
  const rateRare = (GACHA_RATES.rare / GACHA_POOL_RARE.length).toFixed(2);
  return {
    title: "🎰 Gacha",
    color: 0x9b59b6,
    description: `Bạn có **${formatNumber(lunacy)}** <:Lunacy:1524989409529823342>Lunacy | Chi phí: **${GACHA_COST_PER_PULL}**/lần`,
    fields: [
      {
        name: `▫️ Rate cao — ${GACHA_RATES.high}% tổng (mỗi item ${rateHigh}%)`,
        value: GACHA_POOL_HIGH.map(i => `• ${i}`).join("\n"),
        inline: false,
      },
      {
        name: `✨ Rate trung bình — ${GACHA_RATES.mid}% tổng (mỗi item ${rateMid}%)`,
        value: GACHA_POOL_MID.map(i => `• ${i}`).join("\n"),
        inline: false,
      },
      {
        name: `🌟 Rate rất thấp — ${GACHA_RATES.rare}% tổng (mỗi item ${rateRare}%)`,
        value: GACHA_POOL_RARE.map(i => `• ${i}`).join("\n"),
        inline: false,
      },
    ],
    footer: { text: "Trúng item rất thấp (🌟) → liên hệ GM để thiết kế cụ thể." },
  };
}

function buildGachaPanelButtons(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gachapull:${userId}:1`).setLabel(`🎰 Pull x1 (${GACHA_COST_PER_PULL} Lunacy)`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gachapull:${userId}:10`).setLabel(`🎰 Pull x10 (${GACHA_COST_PER_PULL * 10} Lunacy)`).setStyle(ButtonStyle.Success),
  )];
}

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
    const allTracked = [];
    for (const { min, max, times } of diceList) {
      startEmotionTracking();
      const results = Array.from({ length: times }, () => r(min, max));
      const tracked = stopEmotionTracking();
      allTracked.push(...tracked);
      if (times === 1) {
        outputLines.push(`🎲 \`${min}-${max}\` → **${results[0]}** — ${formatEmotionSummary(tracked)}`);
      } else {
        const total = results.reduce((a, b) => a + b, 0);
        const avg = (total / times).toFixed(2);
        outputLines.push(
          `🎲 \`${min}-${max}\` ×${times}: **${total}** [${results.join(" ")}]` +
          ` *(avg: ${avg} | min: ${Math.min(...results)} | max: ${Math.max(...results)})*\n` +
          `> ${formatEmotionSummary(tracked)}`
        );
      }
    }

    const header = diceList.length > 1
      ? `${message.author} đã roll **${diceList.length} dice**:\n`
      : `${message.author} `;
    const footer = diceList.length > 1 ? `\n**Tổng cộng:** ${formatEmotionSummary(allTracked)}` : "";
    const body = header + outputLines.join("\n") + footer;
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
      const kwPageMatch = input.replace(/^list\s+/i, "").trim().match(/^(.+?)\s+(\d+)$/);
      const keyword = kwPageMatch ? kwPageMatch[1].trim() : input.replace(/^list\s+/i, "").trim();
      const page = kwPageMatch ? parseInt(kwPageMatch[2], 10) : 1;
      const result = buildSkillListResult({ keyword, page });
      if (result.error) { message.reply(result.error); return; }
      message.reply({ embeds: [result.embed] });
      return;
    }

    // -skill list [trang]
    // Cú pháp: -skill list | -skill list 2 | -skill list 3
    if (!input || input.toLowerCase() === "list" || /^list\s+\d+$/i.test(input)) {
      const pageMatch = input.match(/list\s+(\d+)/i);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      const result = buildSkillListResult({ page });
      message.reply({ embeds: [result.embed] });
      return;
    }

    // -skill <tên> <số lần> — roll skill đó nhiều lần liên tiếp trong 1 lệnh
    // (VD: -skill durandal 2). CHỈ áp dụng cho skill KHÔNG có promptArg — vì những
    // skill này (VD: sanguine pointilism) đã dùng số cuối cùng làm % reuse riêng,
    // không được hiểu lầm thành count. Thử tách trước; nếu tên không khớp hoặc
    // skill khớp lại có promptArg, fallback dùng input gốc (giữ hành vi cũ).
    let rollCount = 1;
    let skill = null;
    const countMatch = input.match(/^(.+?)\s+(\d+)$/);
    if (countMatch) {
      const candidate = findSkill(countMatch[1].trim());
      if (candidate && !candidate.promptArg) {
        skill = candidate;
        rollCount = parseInt(countMatch[2], 10);
      }
    }
    if (!skill) {
      skill = findSkill(input);
    }
    if (!skill) {
      message.reply(`❌ Không tìm thấy skill: \`${input}\`\nDùng \`-skill list\` để xem danh sách.`);
      return;
    }

    // promptArg skill dùng từ cuối cùng trong input làm arg (VD: "-skill thrust 4" → "4")
    const parts = input.trim().split(/\s+/);
    const promptArgRaw = parts[parts.length - 1];

    const result = buildSkillRollResult({ skill, rollCount, promptArgRaw, forceDullahan });
    if (result.error) { message.reply(result.error); return; }
    message.reply({ embeds: [result.embed] });
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

  // ── -rtparry (Parry phản xạ thời gian thực — DM link, đo chính xác trên web) ──
  if (message.content.startsWith("-rtparry")) {
    const argStr = message.content.replace(/^-rtparry/i, "").trim();
    let targetSkill = null;
    if (argStr) {
      targetSkill = findSkill(argStr);
      if (!targetSkill) {
        message.reply(`⚠️ Không tìm thấy skill **"${argStr}"**. Dùng \`-rtparry\` không kèm tên cho bản mặc định.`);
        return;
      }
    }
    // targetSkill = null nếu không kèm tên — KHÔNG tự chọn random skill (trước đây có
    // làm vậy nhưng sai ý: "-rtparry" trần là bản mặc định đơn giản, không liên quan
    // page cụ thể nào, chỉ "-rtparry <tên>" mới cần tra tốc độ Page thật).

    if (isOnCooldown(message.author.id, "parryrt_web", 5000)) {
      message.reply("⏳ Chờ vài giây trước khi thử lại nhé.");
      return;
    }
    // Discord KHÔNG cho ephemeral với message thường (prefix) — chỉ interaction/slash
    // mới ephemeral được. Nên prefix vẫn phải DM để giữ link riêng tư (không công khai
    // trong channel, ai cầm link cũng chơi được thay được).
    let sentMsg;
    try {
      sentMsg = await message.reply({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description: "📬 Đã gửi link qua **DM** cho bạn — mở DM để bắt đầu." +
            (targetSkill ? `\n> Page: **${targetSkill.name}**` : ""),
          color: 0xf39c12,
          footer: { text: "Kết quả sẽ tự hiện lại ở đây sau khi bạn chơi xong" },
        }],
      });
    } catch (err) {
      log("error", "parryrt", message.author.id, err.message);
      return;
    }

    const linkInfo = createRtparryToken({ userId: message.author.id, channelId: message.channel.id, messageId: sentMsg.id, skill: targetSkill });
    if (!linkInfo) {
      await sentMsg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description:
            "⚠️ Bot chưa biết URL public của mình (thiếu env var `RENDER_EXTERNAL_URL` hoặc `PUBLIC_URL`).\n" +
            "> Báo admin set 1 trong 2 biến này thì lệnh này mới hoạt động được.",
          color: 0xe74c3c,
        }],
      }).catch(() => {});
      return;
    }

    try {
      await message.author.send({
        embeds: [{ title: "⚔️ Parry Real Time", description: "Bấm nút dưới để mở Parry Real Time.", color: 0xf39c12 }],
        components: [buildRtparryLinkButton(linkInfo.url)],
      });
    } catch (err) {
      // DM thất bại (user tắt DM từ thành viên server) — báo lại trong channel, không
      // để họ chờ vô vọng không biết vì sao không thấy gì. Dọn session vì link sẽ
      // không ai dùng được nữa (không gửi đi được).
      log("error", "parryrt_dm", message.author.id, err.message);
      webParrySessions.delete(linkInfo.token);
      await sentMsg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description:
            "❌ Không gửi được DM cho bạn — có thể bạn đã tắt **\"Allow direct messages from server members\"**.\n" +
            "> Bật lại trong Privacy Settings của server này rồi dùng lại lệnh này.",
          color: 0xe74c3c,
        }],
      }).catch(() => {});
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
      message.reply(await buildBalanceEmbed(targetUser, targetUser.id === message.author.id));
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

    // Thay vì thực hiện ngay, hiển thị preview + nút Xác nhận/Hủy để tránh
    // chuyển nhầm người/nhầm số lượng (đặc biệt nguy hiểm với admin give exp/grade/ahn).
    const previewLines = buildGivePreviewLines({ ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget });
    const giveId = registerPendingGive(message.author.id, targetUser.id, isAdmin, {
      ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget,
    });
    message.reply({
      embeds: [{
        title: "📦 Xác nhận chuyển đồ",
        description:
          `${message.author} muốn ${isAdmin ? "tặng" : "chuyển"} cho ${targetUser}:\n` +
          previewLines.map(l => `> ${l}`).join("\n"),
        color: 0xf0a500,
        footer: { text: "Hết hạn sau 60 giây" },
      }],
      components: [buildGiveConfirmRow(giveId)],
    });
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
  // ── -rewoundtime — hồi sinh nhân vật đang Permanent Death (luật: "có thể hồi
  // sinh lại bằng cách sử dụng rewound time; mỗi 1 profile sẽ có lần đầu hồi sinh
  // miễn phí"). Admin/GM dùng giúp player (vì player đã chết không tự gõ lệnh
  // được theo tinh thần luật, nhưng không hại gì nếu cho self-use — vẫn enforce
  // đúng giới hạn 1 lần miễn phí + cần item "Rewound Time" cho các lần sau).
  // ── -healitem — hồi HP NGOÀI encounter (luật: "HP persist nhưng vẫn có thể hồi
  // lại bằng cách dùng consumable item ở ngoài" — KHÁC -encounter useitem, lệnh đó
  // chỉ dùng được TRONG 1 encounter đang chạy, KHÔNG đụng tới currentHp đã persist
  // trên profile). Không có số liệu hồi cụ thể nào được luật cho — coi "dùng item
  // hồi phục" nghĩa là HỒI ĐẦY (full heal), hợp lý nhất cho 1 item hồi phục dùng
  // ngoài combat.
  // ── -readbook — "đọc" 1 cuốn sách, tiêu 1 cuốn khỏi inventory, hiện ĐẦY ĐỦ
  // Page/Weapon/Outfit sách đó dạy được (tra từ BOOK_GRANTS) — xác nhận trực tiếp
  // từ GM: KHÔNG chặn equip nếu chưa đọc (equip vẫn tự do như trước, sách chỉ mang
  // tính ghi nhận/tham khảo).
  // ── -readbook — theo yêu cầu trực tiếp: đọc = CHỌN ĐÚNG 1 Page/Weapon/Outfit
  // (KHÔNG PHẢI mở khoá tất cả — thiết kế CŨ bị coi là "lấy hết chỉ bằng 1 quyển
  // sách rẻ tiền", ĐÃ THAY THẾ HOÀN TOÀN). Không gõ `choose:` → hiện dropdown chọn.
  // Có `choose:` → chốt luôn (tiện cho GM cấp nhanh/player đã biết muốn gì).
  if (message.content.startsWith("-readbook")) {
    const rawInput = message.content.replace("-readbook", "").trim();
    const kv = parseKeyValues(rawInput);
    const chooseRaw = kv["choose"] ?? null;
    const bookNameRaw = chooseRaw ? rawInput.slice(0, rawInput.toLowerCase().indexOf("choose:")).trim() : rawInput;
    if (!bookNameRaw) { message.reply("⚠️ Cú pháp: `-readbook <tên sách>` (hiện dropdown chọn) hoặc `-readbook <tên sách> choose: <tên Page/Vũ khí/Outfit>` (chốt luôn).\n> Mẹo: dùng `-inventory` rồi bấm nút 📚 Đọc cho tiện hơn."); return; }
    try {
      const bookName = findBook(bookNameRaw);
      if (!bookName) throw new Error(`Không nhận diện được sách "${bookNameRaw}".`);
      const { data: profileData } = await getPlayerDataWithSlot(message.author.id);
      const owned = profileData.books?.[bookName] ?? 0;
      if (owned < 1) throw new Error(`Bạn không có (hoặc đã hết) **${bookName}** trong inventory.`);
      if (!chooseRaw) {
        message.reply(buildBookChoiceComponents(message.author.id, bookName, owned));
        return;
      }
      // choose: <tên> — cần biết đây là page/weapon/outfit — thử LẦN LƯỢT cả 3 loại.
      let matchedType = null;
      for (const t of ["page", "weapon", "outfit"]) {
        if (isValidBookChoice(bookName, t, chooseRaw.trim())) { matchedType = t; break; }
      }
      if (!matchedType) throw new Error(`"${chooseRaw.trim()}" không thuộc **${bookName}** (hoặc là TÊN NHÓM của Library Book — dùng dropdown thay vì gõ tay cho trường hợp này).`);
      await withLock(message.author.id, async () => {
        const result = await executeReadBookChoose(message.author.id, bookName, matchedType, chooseRaw.trim());
        message.reply({
          embeds: [{
            title: `📖 Đã đọc: ${result.bookName}`,
            description: `Nhận được: **${result.chosenName}** (${matchedType === "page" ? "Page" : matchedType === "weapon" ? "Vũ khí" : "Outfit"})\n\n*Còn lại: ${result.remaining} cuốn.*`,
            color: 0x5865f2,
          }],
        });
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-healitem")) {
    const itemNameRaw = message.content.replace("-healitem", "").trim();
    if (!itemNameRaw) { message.reply("⚠️ Cú pháp: `-healitem <tên item>` (hồi ĐẦY HP — dùng item hồi phục trong inventory, KHÔNG cần đang ở trong encounter)."); return; }
    try {
      await withLock(message.author.id, async () => {
        const { data: profileData, slot } = await getPlayerDataWithSlot(message.author.id);
        const itemName = findItem(itemNameRaw) ?? (profileData.items?.[itemNameRaw] > 0 ? itemNameRaw : null);
        if (!itemName) throw new Error(`Không tìm thấy item "${itemNameRaw}" trong inventory của bạn.`);
        const owned = profileData.items?.[itemName] ?? 0;
        if (owned < 1) throw new Error(`Không còn **${itemName}** trong inventory.`);
        profileData.items[itemName] = owned - 1;
        if (profileData.items[itemName] <= 0) delete profileData.items[itemName];
        const { grade } = calcGrade(profileData.exp ?? 0);
        // BUG ĐÃ SỬA: trước đây dùng maxHp THÔ theo Grade, KHÔNG trừ injury penalty
        // (Gãy Xương/Vết thương lớn) — "hồi đầy HP" có thể vượt quá Max HP THẬT của
        // player đang mang chấn thương, gây currentHp > maxHp cho tới lần join kế
        // tiếp mới tự sửa lại (vì join luôn tự clamp).
        const rawMaxHp = 140 + 20 * (GRADE_MIN - grade);
        const injuryPenalty = calcInjuryMaxHpPenalty(profileData.injuries);
        const maxHp = Math.max(1, rawMaxHp - injuryPenalty);
        profileData.currentHp = maxHp;
        profileData.hpLastResetCheck = Date.now();
        await savePlayerData(message.author.id, profileData, slot);
        message.reply(`🧪 ${message.author} đã dùng **${itemName}** — hồi đầy HP (${maxHp}/${maxHp})!${injuryPenalty > 0 ? ` (Max HP đang bị giảm ${injuryPenalty} do chấn thương chưa chữa — item này KHÔNG chữa injury, chỉ hồi HP.)` : ""}`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -healinjuryahn — chữa 1 chấn thương NGOÀI encounter bằng Ahn (luật xác nhận
  // trực tiếp: "chỉ có dùng Ahn để chữa trị hoặc dùng item đặc biệt [K-Corp Ampule]
  // mới chữa khỏi TRONG encounter"). GM TỰ ĐỊNH GIÁ mỗi lần (không có mức cố định)
  // — GM gõ số Ahn cụ thể lúc dùng lệnh này. CHỈ admin/GM được dùng (vì GM là người
  // quyết định giá, không phải player tự trả tuỳ ý).
  if (message.content.startsWith("-healinjuryahn")) {
    const isAdminHealAhn = ADMIN_IDS.has(message.author.id);
    if (!isAdminHealAhn) { message.reply("⚠️ Chỉ admin/GM mới được dùng lệnh này (GM là người quyết định giá Ahn mỗi lần)."); return; }
    const targetUser = message.mentions.users.first();
    const kv = parseKeyValues(message.content.replace("-healinjuryahn", "").trim());
    const ahnCost = parseInt(kv["ahn"] ?? "", 10);
    const index = parseInt(kv["index"] ?? "", 10);
    if (!targetUser || !Number.isFinite(ahnCost) || ahnCost < 0 || !Number.isFinite(index) || index < 1) {
      message.reply("⚠️ Cú pháp: `-healinjuryahn @user ahn: <số Ahn GM tự định giá> index: <số thứ tự chấn thương, xem qua -profile hoặc -encounter status>`");
      return;
    }
    try {
      await withLock(targetUser.id, async () => {
        const { data: profileData, slot } = await getPlayerDataWithSlot(targetUser.id);
        const list = profileData.injuries ?? [];
        if (index > list.length) throw new Error(`${targetUser.username} chỉ có ${list.length} chấn thương đang mang — không có #${index}.`);
        if ((profileData.ahn ?? 0) < ahnCost) throw new Error(`${targetUser.username} không đủ Ahn — cần ${ahnCost}, hiện có ${profileData.ahn ?? 0}.`);
        const removed = list.splice(index - 1, 1)[0];
        profileData.ahn = (profileData.ahn ?? 0) - ahnCost;
        await savePlayerData(targetUser.id, profileData, slot);
        message.reply(`🩹💰 Đã chữa khỏi chấn thương của **${targetUser.username}**: "${removed}" (tốn ${ahnCost} Ahn, còn lại ${profileData.ahn} Ahn).\n> Lưu ý: nếu ${targetUser.username} đang ở TRONG 1 encounter khác, cần \`-encounter join\` lại để cập nhật Max HP/injury mới nhất.`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-rewoundtime")) {
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const targetUser = message.mentions.users.first();
    if (!targetUser) { message.reply("⚠️ Cú pháp: `-rewoundtime @user`"); return; }
    if (!isAdmin && message.author.id !== targetUser.id) {
      message.reply("⚠️ Chỉ admin/GM hoặc chính người đó mới được tự hồi sinh.");
      return;
    }
    try {
      await withLock(targetUser.id, async () => {
        const { data: profileData, slot } = await getPlayerDataWithSlot(targetUser.id);
        if (!profileData.permanentlyDead) throw new Error(`${targetUser.username} không ở trạng thái Permanent Death — không cần hồi sinh.`);
        if (!profileData.hasUsedFreeRevive) {
          profileData.permanentlyDead = false;
          profileData.hasUsedFreeRevive = true;
          await savePlayerData(targetUser.id, profileData, slot);
          message.reply(`✨ Đã hồi sinh **${targetUser.username}** bằng **lần Rewound Time MIỄN PHÍ ĐẦU TIÊN** của profile này (đã dùng — lần permadeath sau sẽ cần item "Rewound Time").`);
          return;
        }
        const owned = profileData.items?.["Rewound Time"] ?? 0;
        if (owned < 1) throw new Error(`${targetUser.username} đã dùng hết lần hồi sinh miễn phí và không có item "Rewound Time" trong inventory để hồi sinh tiếp.`);
        profileData.items["Rewound Time"] = owned - 1;
        if (profileData.items["Rewound Time"] <= 0) delete profileData.items["Rewound Time"];
        profileData.permanentlyDead = false;
        await savePlayerData(targetUser.id, profileData, slot);
        message.reply(`✨ Đã hồi sinh **${targetUser.username}** bằng 1× item **Rewound Time** (còn lại: ${profileData.items["Rewound Time"] ?? 0}).`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

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
    // pages: — GM cấp THẲNG 1 hoặc nhiều Page vào category "pages" (giống books:/
    // items:) — theo yêu cầu trực tiếp "hoặc GM cấp thẳng" (không cần qua đọc
    // sách). Dùng findSkill để validate tên Page/skill hợp lệ (không giới hạn chỉ
    // Page có trong BOOK_GRANTS — GM có thể cấp BẤT KỲ Page/skill hợp lệ nào tồn
    // tại trong skills.js, kể cả loại chưa gắn với sách nào).
    const pagesRaw = kv["pages"] ?? null;
    const pageEntries = [];
    if (pagesRaw) {
      const parts = pagesRaw.split(",").map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const match = part.match(/^(.+?)\s+(\+?)x(\d+)$/i);
        if (!match) {
          message.reply(`❌ Định dạng Page sai: \`${part}\`\nĐúng: \`Tên Page x<số>\` hoặc \`Tên Page +x<số>\` (VD: \`Pounce x1\` hoặc \`Pounce +x1\`)`);
          return;
        }
        const skill = findSkill(match[1].trim());
        if (!skill) {
          message.reply(`❌ Tên Page không hợp lệ: \`${match[1].trim()}\``);
          return;
        }
        pageEntries.push({ name: skill.name, count: parseInt(match[3], 10), isAdd: match[2] === "+" });
      }
    }
    const expAddRaw = kv["exp"] ?? null;
    const ahnAddRaw = kv["ahn"] ?? null;
    const lunacyAddRaw = kv["lunacy"] ?? null;
    const expIsAdd = expAddRaw && expAddRaw.startsWith("+");
    const ahnIsAdd = ahnAddRaw && ahnAddRaw.startsWith("+");
    const lunacyIsAdd = lunacyAddRaw && lunacyAddRaw.startsWith("+");
    const expValue = expAddRaw ? parseInt(expAddRaw.replace("+", ""), 10) || 0 : null;
    const ahnValue = ahnAddRaw ? parseInt(ahnAddRaw.replace("+", ""), 10) || 0 : null;
    const lunacyValue = lunacyAddRaw ? parseInt(lunacyAddRaw.replace("+", ""), 10) || 0 : null;
    const gradeTarget = kv["grade"] ? parseInt(kv["grade"], 10) : null;
    if (gradeTarget !== null && (isNaN(gradeTarget) || gradeTarget < GRADE_MAX || gradeTarget > GRADE_MIN)) {
      message.reply(`❌ Grade phải từ ${GRADE_MAX}–${GRADE_MIN}.`);
      return;
    }
    // bonusskillpoints: — "điều kiện đặc biệt" để lên 50 điểm Skill Tree (luật:
    // "Để đạt 50 sẽ cần điều kiện đặc biệt" — KHÔNG được luật định nghĩa rõ điều
    // kiện cụ thể là gì, nên GM tự quyết định khi nào player đạt được, rồi cấp tay
    // qua tham số này — set tuyệt đối hoặc +N để cộng thêm, giống exp:/ahn:).
    const bonusSkillRaw = kv["bonusskillpoints"] ?? null;
    const bonusSkillIsAdd = bonusSkillRaw && bonusSkillRaw.startsWith("+");
    const bonusSkillValue = bonusSkillRaw ? parseInt(bonusSkillRaw.replace("+", ""), 10) : null;
    if (bonusSkillRaw && (bonusSkillValue === null || isNaN(bonusSkillValue))) {
      message.reply("❌ `bonusskillpoints:` phải là số.");
      return;
    }
    // hp: — set TRỰC TIẾP currentHp đã persist trên profile (KHÁC hp: của
    // -encounter join, vốn chỉ set cho 1 TRẬN cụ thể) — dùng cho trường hợp cần
    // khôi phục/nhập dữ liệu HP chính xác (VD import từ hệ thống cũ). Set kèm
    // hpLastResetCheck = NGAY BÂY GIỜ để tránh bị auto-reset về full ngay lần
    // join kế tiếp (xem getEffectiveCurrentHp).
    const hpSetRaw = kv["hp"] ?? null;
    const hpSetValue = hpSetRaw ? parseFloat(hpSetRaw) : null;
    if (hpSetRaw && (hpSetValue === null || isNaN(hpSetValue) || hpSetValue < 0)) {
      message.reply("❌ `hp:` phải là số ≥0.");
      return;
    }
    // 4 cờ điều kiện đặc biệt — theo yêu cầu trực tiếp: lưu vào Upstash để TRACK
    // xem player đã đủ điều kiện mở khoá Shin/Light/50 điểm/Manifested E.G.O tuỳ
    // chỉnh hay chưa (KHÁC branchPoints.shin/light — 2 field NÀY là CỜ ĐIỀU KIỆN
    // ĐỦ TƯ CÁCH, còn branchPoints là ĐIỂM ĐÃ PHÂN BỔ — 1 người có thể ĐỦ ĐIỀU KIỆN
    // [Unlock=true] nhưng CHƯA phân bổ điểm nào [branchPoints=0], hoặc ngược lại
    // không thể phân bổ nếu Unlock=false, xem gating ở -allocatepoints).
    const UNLOCK_FLAG_KEYS = { shinunlock: "ShinUnlock", lightskilltreeunlock: "LightSkillTreeUnlock", "50statunlock": "50StatUnlock", manifestedegounlock: "ManifestedEGOUnlock" };
    const unlockFlagUpdates = {};
    for (const [paramKey, fieldName] of Object.entries(UNLOCK_FLAG_KEYS)) {
      const raw = (kv[paramKey] ?? "").trim().toLowerCase();
      if (!raw) continue;
      if (["yes", "true", "1", "có"].includes(raw)) unlockFlagUpdates[fieldName] = true;
      else if (["no", "false", "0", "không"].includes(raw)) unlockFlagUpdates[fieldName] = false;
      else { message.reply(`❌ \`${paramKey}:\` phải là yes/no (hoặc true/false, có/không).`); return; }
    }
    // Branch Points — PHÂN BỔ điểm Skill Tree vào 1 trong 9 nhánh (wrath/desire/
    // sloth/gluttony/gloom/pride/envy/shin/light) — KIẾN TRÚC ĐÃ SỬA (xác nhận trực
    // tiếp từ GM): mỗi nhánh có ngưỡng RIÊNG, KHÔNG dùng chung 1 pool toàn cục cho
    // mọi perk. Set TUYỆT ĐỐI (VD `sloth: 20`) hoặc CỘNG THÊM (VD `sloth: +10`),
    // giống exp:/ahn:. Validate TỔNG các nhánh KHÔNG vượt tổng pool
    // (calcSkillTreePointsEarned theo Grade) — nếu vượt, BÁO LỖI RÕ chứ không tự ý
    // cắt bớt (để GM tự quyết định phân bổ lại).
    const branchUpdates = {};
    let hasBranchUpdate = false;
    for (const bKey of BRANCH_KEYS) {
      const raw = kv[bKey] ?? null;
      if (raw === null) continue;
      const isAdd = raw.startsWith("+");
      const value = parseInt(raw.replace("+", ""), 10);
      if (isNaN(value) || value < 0) { message.reply(`❌ \`${bKey}:\` phải là số ≥0 (hoặc +N để cộng thêm).`); return; }
      branchUpdates[bKey] = { isAdd, value };
      hasBranchUpdate = true;
    }
    if (expValue === null && ahnValue === null && lunacyValue === null && gradeTarget === null && bookEntries.length === 0 && itemEntries.length === 0 && pageEntries.length === 0 && bonusSkillValue === null && !hasBranchUpdate && hpSetValue === null && Object.keys(unlockFlagUpdates).length === 0) {
      message.reply(`❌ Không có gì để set. Dùng: \`exp\`, \`grade\`, \`ahn\`, \`lunacy\`, \`hp\`, \`books\`, \`items\`, \`bonusskillpoints\`, 9 nhánh Skill Tree (${BRANCH_KEYS.join("/")}), hoặc 4 cờ điều kiện (\`shinunlock\`/\`lightskilltreeunlock\`/\`50statunlock\`/\`manifestedegounlock\`: yes/no).\n> Thêm \`+\` trước số để cộng thêm, VD: \`exp: +50\` hoặc \`sloth: +10\``);
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
              const lunacyBefore = data.lunacy ?? 0;
              data.exp = clampExpWithLunacy(data, before + expValue);
              const lunacyGained = (data.lunacy ?? 0) - lunacyBefore;
              changes.push(`EXP +${expValue} (${before} → **${data.exp}**) [max: ${EXP_MAX}]${lunacyGained > 0 ? ` (dư chuyển thành +${lunacyGained} <:Lunacy:1524989409529823342>Lunacy)` : ""}`);
            } else {
              const lunacyBefore = data.lunacy ?? 0;
              data.exp = clampExpWithLunacy(data, expValue);
              const lunacyGained = (data.lunacy ?? 0) - lunacyBefore;
              changes.push(`EXP set → **${data.exp}** [max: ${EXP_MAX}]${lunacyGained > 0 ? ` (dư chuyển thành +${lunacyGained} <:Lunacy:1524989409529823342>Lunacy)` : ""}`);
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
          if (lunacyValue !== null) {
            if (lunacyIsAdd) {
              const before = data.lunacy ?? 0;
              data.lunacy = Math.max(0, before + lunacyValue);
              changes.push(`<:Lunacy:1524989409529823342>Lunacy +${formatNumber(lunacyValue)} (${formatNumber(before)} → **${formatNumber(data.lunacy)}**)`);
            } else {
              data.lunacy = Math.max(0, lunacyValue);
              changes.push(`<:Lunacy:1524989409529823342>Lunacy set → **${formatNumber(data.lunacy)}**`);
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
          if (pageEntries.length > 0) {
            data.pages = data.pages ?? {};
            for (const { name, count, isAdd } of pageEntries) {
              data.pages[name] = isAdd ? (data.pages[name] ?? 0) + count : count;
            }
            changes.push(`Page:\n` + pageEntries.map(e => `> • 📖 **${e.name}** ${e.isAdd ? `+${e.count}` : `× ${e.count} (set)`}`).join("\n"));
          }
          if (bonusSkillValue !== null) {
            if (bonusSkillIsAdd) {
              const before = data.bonusSkillPoints ?? 0;
              data.bonusSkillPoints = Math.max(0, before + bonusSkillValue);
              changes.push(`Bonus Skill Points +${bonusSkillValue} (${before} → **${data.bonusSkillPoints}**) [điều kiện đặc biệt lên 50 điểm]`);
            } else {
              data.bonusSkillPoints = Math.max(0, bonusSkillValue);
              changes.push(`Bonus Skill Points set → **${data.bonusSkillPoints}**`);
            }
          }
          if (hpSetValue !== null) {
            const before = data.currentHp;
            data.currentHp = hpSetValue;
            data.hpLastResetCheck = Date.now();
            changes.push(`HP set → **${hpSetValue}**${before !== undefined ? ` (trước: ${before})` : ""}`);
          }
          for (const [fieldName, value] of Object.entries(unlockFlagUpdates)) {
            data[fieldName] = value;
            changes.push(`${fieldName}: ${value ? "✅ TRUE" : "❌ FALSE"}`);
          }
          if (Object.keys(branchUpdates).length > 0) {
            data.branchPoints = data.branchPoints ?? {};
            // Tính TRƯỚC giá trị CUỐI CÙNG (chưa gán thật) để validate tổng trước.
            const proposedBranchPoints = { ...data.branchPoints };
            for (const [bKey, { isAdd, value }] of Object.entries(branchUpdates)) {
              const before = data.branchPoints[bKey] ?? 0;
              proposedBranchPoints[bKey] = isAdd ? before + value : value;
            }
            const proposedTotal = BRANCH_KEYS.reduce((sum, k) => sum + (proposedBranchPoints[k] ?? 0), 0);
            const pool = calcSkillTreePointsEarned(data);
            if (proposedTotal > pool) {
              changes.push(`❌ KHÔNG áp dụng phân bổ nhánh — tổng sẽ thành ${proposedTotal} điểm, vượt quá pool ${pool} điểm (theo Grade${data.bonusSkillPoints ? " + bonusSkillPoints" : ""}). Giữ nguyên phân bổ cũ.`);
            } else {
              for (const [bKey, { isAdd, value }] of Object.entries(branchUpdates)) {
                const before = data.branchPoints[bKey] ?? 0;
                data.branchPoints[bKey] = proposedBranchPoints[bKey];
                changes.push(`${bKey[0].toUpperCase() + bKey.slice(1)}: ${isAdd ? `+${value} (${before} → ` : "set → "}**${data.branchPoints[bKey]}**${isAdd ? ")" : ""} [tổng nhánh: ${proposedTotal}/${pool}]`);
              }
            }
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

  // ── -unlockskilltree / -ununlockskilltree ──────────────────────────────────
  // Lưu trên PROFILE (vĩnh viễn, theo slot đang active), KHÔNG còn lưu tạm trong
  // encounter (mất khi encounter kết thúc) như bản unlockperk cũ — vì đây là Point
  // thật đã tốn trong game, phải tồn tại qua mọi trận đấu, giống Grade/EXP. Admin
  // only — giống -setplayer, vì đây là tài nguyên cần GM duyệt, không phải thứ
  // player tự cấp cho mình.
  // ── -allocatepoints — TỰ PHÂN BỔ điểm Skill Tree vào 1 nhánh (theo yêu cầu trực
  // tiếp: "để player tự phân bổ stats... không nhất thiết cần GM"). CHỈ CHO TĂNG
  // (KHÔNG cho giảm qua lệnh này) — tránh làm "mồ côi" perk ĐÃ unlock dựa trên điểm
  // nhánh cũ (VD đã unlock Fortified Resolve cần Sloth≥20, nếu tự ý giảm Sloth
  // xuống 10 thì perk đó về mặt logic không còn đủ điều kiện nữa nhưng vẫn active
  // — để tránh case này, GIẢM/ĐIỀU CHỈNH LẠI vẫn cần GM qua `-setplayer` (admin,
  // có thể set tuyệt đối kể cả giảm, dùng cho các trường hợp đặc biệt/sửa lỗi).
  if (message.content.startsWith("-allocatepoints")) {
    const rawInputFull = message.content.replace("-allocatepoints", "").trim();
    const { targetUserId, targetLabel, remainingInput } = resolveEquipTarget(message, rawInputFull);
    const kv = parseKeyValues(remainingInput);
    const branchEntries = BRANCH_KEYS.filter(k => kv[k] !== undefined).map(k => ({ key: k, raw: kv[k] }));
    if (branchEntries.length === 0) {
      message.reply(`⚠️ Cú pháp: \`-allocatepoints [@user] <nhánh>: <số điểm muốn CỘNG THÊM>\` (CHỈ cộng, không trừ được qua lệnh này; thêm @user nếu admin muốn phân bổ hộ)\n> Nhánh hợp lệ: ${BRANCH_KEYS.join("/")}\n> VD: \`-allocatepoints sloth: 10\``);
      return;
    }
    try {
      await withLock(targetUserId, async () => {
        const { data, slot } = await getPlayerDataWithSlot(targetUserId);
        data.branchPoints = data.branchPoints ?? {};
        const proposedBranchPoints = { ...data.branchPoints };
        const changes = [];
        for (const { key, raw } of branchEntries) {
          const addAmount = parseInt(raw.replace(/^\+/, ""), 10);
          if (!Number.isFinite(addAmount) || addAmount <= 0) throw new Error(`\`${key}:\` phải là số dương (chỉ cộng thêm, không trừ được qua lệnh này — dùng số ≥1).`);
          proposedBranchPoints[key] = (data.branchPoints[key] ?? 0) + addAmount;
        }
        const proposedTotal = BRANCH_KEYS.reduce((sum, k) => sum + (proposedBranchPoints[k] ?? 0), 0);
        const pool = calcSkillTreePointsEarned(data);
        if (proposedTotal > pool) {
          const currentAllocated = calcBranchPointsAllocated(data);
          throw new Error(`Không đủ điểm — tổng sẽ thành ${proposedTotal}, vượt quá pool ${pool} (hiện đã phân bổ ${currentAllocated}, còn dư ${pool - currentAllocated} điểm để cộng).`);
        }
        // Gate CỨNG cho Shin/Light — theo yêu cầu trực tiếp (đã có field ShinUnlock/
        // LightSkillTreeUnlock để verify điều kiện, KHÔNG CÒN "cảnh báo mềm" như
        // trước — trước đây không chặn được vì "không có luật số để verify điều
        // kiện", giờ ĐÃ CÓ). Admin phân bổ HỘ người khác (targetLabel !== null) BỎ
        // QUA check này — admin có toàn quyền, giống pattern equip gating.
        const isAdminAction = targetLabel !== null;
        if (!isAdminAction) {
          const shinAttempt = branchEntries.find(e => e.key === "shin");
          const lightAttempt = branchEntries.find(e => e.key === "light");
          if (shinAttempt && !data.ShinUnlock) {
            throw new Error(`Bạn CHƯA đủ điều kiện phân bổ điểm vào nhánh Shin (ShinUnlock chưa được GM xác nhận) — liên hệ GM.`);
          }
          if (lightAttempt && !data.LightSkillTreeUnlock) {
            throw new Error(`Bạn CHƯA đủ điều kiện phân bổ điểm vào nhánh Light (LightSkillTreeUnlock chưa được GM xác nhận) — liên hệ GM.`);
          }
        }
        for (const { key, raw } of branchEntries) {
          const before = data.branchPoints[key] ?? 0;
          data.branchPoints[key] = proposedBranchPoints[key];
          changes.push(`${key[0].toUpperCase() + key.slice(1)}: ${before} → **${data.branchPoints[key]}**`);
        }
        await savePlayerData(targetUserId, data, slot);
        message.reply(`✅ ${targetLabel ? `**${targetLabel}**` : message.author}: ${changes.join(", ")} [tổng đã phân bổ: ${proposedTotal}/${pool}]`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unlockskilltree") || message.content.startsWith("-ununlockskilltree")) {
    const isUnlock = message.content.startsWith("-unlockskilltree");
    const isAdminUnlock = ADMIN_IDS.has(message.author.id);
    // TỰ PHỤC VỤ (theo yêu cầu trực tiếp: "để player tự phân bổ stats... không nhất
    // thiết cần GM") — KHÔNG có @mention → áp dụng cho CHÍNH NGƯỜI GÕ. CÓ @mention
    // VÀ là admin → admin làm hộ người khác (giữ khả năng override/hỗ trợ cũ). CÓ
    // @mention nhưng KHÔNG PHẢI admin → bỏ qua mention (an toàn, giống
    // resolveEquipTarget — tránh non-admin thao túng người khác).
    const mentionedUsers = [...message.mentions.users.values()];
    const targetUsers = (isAdminUnlock && mentionedUsers.length > 0) ? mentionedUsers : [message.author];
    const rawInput = message.content.replace(/^-(un)?unlockskilltree/, "").replace(/<@!?\d+>/g, "").trim();
    const perkName = rawInput.replace(/^text:\s*/i, "").trim();
    if (!perkName) {
      message.reply(
        `❌ Cú pháp: \`-${isUnlock ? "" : "un"}unlockskilltree [@user] <tên perk>\`\n` +
        `> VD: \`-unlockskilltree Ein Sof\` (tự mở cho chính mình) — thêm @user nếu admin muốn mở hộ.`
      );
      return;
    }
    try {
      const results = [];
      for (const user of targetUsers) {
        const { data, slot } = await getPlayerDataWithSlot(user.id);
        data.unlockedSkillTree = data.unlockedSkillTree ?? [];
        if (isUnlock) {
          if (data.unlockedSkillTree.includes(perkName)) { results.push(`⚠️ ${user.username}: đã có "${perkName}" rồi.`); continue; }
          const conflict = findExclusiveConflict(data.unlockedSkillTree, perkName);
          if (conflict) { results.push(`❌ ${user.username}: "${perkName}" loại trừ với "${conflict}" đã có sẵn — không thể có cả 2 (dùng \`-ununlockskilltree\` xoá "${conflict}" trước nếu muốn đổi).`); continue; }
          // Ngưỡng mở khoá THEO NHÁNH — CHỈ chặn nếu perk này có cost RÕ trong
          // PERK_POINT_COSTS (perk chưa rõ cost/nhánh thì cho qua tự do, không chặn
          // nhầm unlock cũ). KIẾN TRÚC ĐÃ SỬA (xác nhận trực tiếp từ GM): trong 1
          // NHÁNH, có N điểm branchPoints[nhánh] = mở được TẤT CẢ perk nhánh đó có
          // tag ≤N — KHÔNG trừ dần theo từng perk, KHÔNG dùng chung 1 pool toàn
          // cục cho mọi nhánh (mỗi nhánh độc lập hoàn toàn).
          const cost = PERK_POINT_COSTS[perkName];
          const branch = PERK_BRANCH[perkName];
          if (cost !== undefined && branch !== undefined) {
            const branchHave = (data.branchPoints ?? {})[branch] ?? 0;
            if (branchHave < cost) {
              results.push(`❌ ${user.username}: "${perkName}" (nhánh ${branch}) cần ${cost} điểm nhánh — hiện chỉ có ${branchHave} điểm ${branch} (dùng \`-allocatepoints ${branch}: <số>\` để phân bổ thêm).`);
              continue;
            }
          }
          data.unlockedSkillTree.push(perkName);
          await savePlayerData(user.id, data, slot);
          results.push(`✅ ${user.username}: mở khóa "${perkName}"${cost !== undefined ? ` (nhánh ${branch}, cần ${cost}/${(data.branchPoints ?? {})[branch] ?? 0} điểm ${branch})` : ""}.`);
        } else {
          const idx = data.unlockedSkillTree.indexOf(perkName);
          if (idx === -1) { results.push(`⚠️ ${user.username}: chưa có "${perkName}".`); continue; }
          data.unlockedSkillTree.splice(idx, 1);
          await savePlayerData(user.id, data, slot);
          results.push(`✅ ${user.username}: đã xoá "${perkName}".`);
        }
      }
      // Bọc embed (4096 ký tự) thay vì reply string thẳng (giới hạn 2000) — phòng
      // trường hợp admin mention NHIỀU user cùng lúc khiến kết quả gộp vượt giới
      // hạn text thường (bài học từ bug helpBody y hệt).
      const resultText = results.join("\n");
      if (resultText.length > 1900) {
        message.reply({ embeds: [{ description: resultText.slice(0, 4000), color: 0x5865f2 }] });
      } else {
        message.reply(resultText);
      }
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── equippage/unequippage/equipegopage/unequipegopage ──────────────────────
  // Tự phục vụ (player tự quản lý loadout của mình, KHÔNG admin-gated — khác
  // unlockskilltree vì đây là lựa chọn cá nhân, không phải tài nguyên GM cấp). 5
  // slot Page thường + 5 slot E.G.O Page RIÊNG (đúng luật "E.G.O Page không tính
  // slot chung với 5 Page thường"). Lưu trên PROFILE (vĩnh viễn, theo slot profile
  // đang active) — -encounter join sẽ tự lấy danh sách này để hiện trong dropdown
  // hành động (xem phần dropdown động).
  if (message.content.startsWith("-equippage") || message.content.startsWith("-equipegopage")) {
    const isEgo = message.content.startsWith("-equipegopage");
    const rawInputFull = message.content.replace(isEgo ? "-equipegopage" : "-equippage", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    const m = rawInput.match(/^([1-5])\s+(.+)$/);
    if (!m) {
      message.reply(`⚠️ Cú pháp: \`-${isEgo ? "equipegopage" : "equippage"} [@user] <slot 1-5> <tên skill>\`\n> VD: \`-${isEgo ? "equipegopage" : "equippage"} 1 sky kick\` (thêm @user nếu admin muốn equip hộ)` +
        (isEgo ? `\n> 5 slot E.G.O là 5 **Tier riêng** (không hoán đổi được): ${EGO_TIER_SLOT_ORDER.map((t, i) => `slot ${i + 1}=${t}`).join(", ")}.` : ""));
      return;
    }
    const slotNum = parseInt(m[1], 10);
    const skillNameRaw = m[2].trim();
    try {
      const skill = findSkill(skillNameRaw);
      if (!skill) throw new Error(`Không tìm thấy skill "${skillNameRaw}".`);
      const skillIsEgo = isEgoSkill(skill);
      if (isEgo && !skillIsEgo) throw new Error(`"${skill.name}" không phải E.G.O Page — dùng \`-equippage\` thay vào đó.`);
      if (!isEgo && skillIsEgo) throw new Error(`"${skill.name}" là E.G.O Page — dùng \`-equipegopage\` thay vào đó (5 slot riêng).`);
      // 5 E.G.O Slot là 5 Tier RIÊNG (ZAYIN/TETH/HE/WAW/ALEPH), KHÔNG phải 5 slot
      // chung — slot N CHỈ nhận đúng tier tương ứng, mỗi tier chỉ 1 page tại 1 thời
      // điểm (xác nhận trực tiếp từ GM).
      if (isEgo) {
        const expectedTier = EGO_TIER_SLOT_ORDER[slotNum - 1];
        const skillTier = getEgoTier(skill);
        if (!skillTier) {
          throw new Error(`Không xác định được Tier của "${skill.name}" (thiếu tag ZAYIN/TETH/HE/WAW/ALEPH) — không thể equip vào slot Tier.`);
        }
        if (skillTier !== expectedTier) {
          throw new Error(`"${skill.name}" là Tier **${skillTier}** — phải equip vào slot **${EGO_TIER_SLOT_ORDER.indexOf(skillTier) + 1}** (Tier ${skillTier}), không phải slot ${slotNum} (Tier ${expectedTier}).`);
        }
      }
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      // Ownership gate — Page giờ có category RIÊNG "pages" (giống books/items,
      // trước đây Page hoàn toàn tự do không cần sở hữu — theo yêu cầu trực tiếp:
      // "equip weapon/outfit/page đều phải SỞ HỮU trước").
      const isAdminAction = targetLabel !== null;
      if (!isAdminAction && (data.pages?.[skill.name] ?? 0) < 1) {
        throw new Error(`Bạn chưa sở hữu Page **${skill.name}** — cần đọc sách tương ứng để nhận (xem \`-readbook\`), hoặc nhờ GM cấp.`);
      }
      const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
      data[listKey] = data[listKey] ?? [null, null, null, null, null];
      data[listKey][slotNum - 1] = skill.name;
      await savePlayerData(targetUserId, data, slot);
      message.reply(`✅ Đã equip **${skill.name}** vào ${isEgo ? "E.G.O " : ""}slot #${slotNum}${targetLabel ? ` cho **${targetLabel}**` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequippage") || message.content.startsWith("-unequipegopage")) {
    const isEgo = message.content.startsWith("-unequipegopage");
    const rawInputFull = message.content.replace(isEgo ? "-unequipegopage" : "-unequippage", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    const slotNum = parseInt(rawInput, 10);
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 5) {
      message.reply(`⚠️ Cú pháp: \`-${isEgo ? "unequipegopage" : "unequippage"} [@user] <slot 1-5>\``);
      return;
    }
    try {
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
      data[listKey] = data[listKey] ?? [null, null, null, null, null];
      const removed = data[listKey][slotNum - 1];
      data[listKey][slotNum - 1] = null;
      await savePlayerData(targetUserId, data, slot);
      message.reply(removed ? `✅ Đã gỡ **${removed}** khỏi ${isEgo ? "E.G.O " : ""}slot #${slotNum}${targetLabel ? ` của **${targetLabel}**` : ""}.` : `⚠️ ${isEgo ? "E.G.O " : ""}Slot #${slotNum} đang trống${targetLabel ? ` (${targetLabel})` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -pages: xem loadout hiện tại (5 Page + 5 E.G.O Page) ───────────────────
  if (message.content.startsWith("-pages")) {
    try {
      const targetUser = message.mentions.users.first() ?? message.author;
      const { data } = await getPlayerDataWithSlot(targetUser.id);
      const pages = data.equippedPages ?? [null, null, null, null, null];
      const egoPages = data.equippedEgoPages ?? [null, null, null, null, null];
      const fmt = (list) => list.map((p, i) => `**#${i + 1}** ${p ?? "*(trống)*"}`).join("\n");
      message.reply({
        embeds: [{
          title: `📖 Loadout Page — ${targetUser.username}`,
          description: `**5 Page thường:**\n${fmt(pages)}\n\n**5 E.G.O Page:**\n${fmt(egoPages)}`,
          color: 0x5865f2,
          footer: { text: "-equippage <slot> <skill> · -equipegopage <slot> <skill> · -unequippage/-unequipegopage <slot>" },
        }],
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── equipweapon/unequipweapon — lưu TÊN vũ khí (tra lại qua findWeapon() mỗi lần
  // cần dùng, KHÔNG lưu cả object — tránh dữ liệu cũ kẹt lại nếu weapon.js sau này
  // sửa số liệu). Tự phục vụ, không admin-gated (chọn trang bị là lựa chọn cá nhân).
  if (message.content.startsWith("-equipweapon")) {
    const rawInputFull = message.content.replace("-equipweapon", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    if (!rawInput) { message.reply("⚠️ Cú pháp: `-equipweapon [@user] <tên vũ khí>` (VD: `-equipweapon durandal`; thêm @user nếu admin muốn equip hộ)"); return; }
    try {
      const weapon = findWeaponAnywhere(rawInput);
      if (!weapon) throw new Error(`Không tìm thấy vũ khí "${rawInput}" trong weapon.js hoặc skills.js.`);
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      // Ownership gate — theo yêu cầu trực tiếp: "equip weapon/outfit/page đều
      // phải SỞ HỮU trước (qua chọn từ sách, hoặc GM cấp thẳng)". Admin equip HỘ
      // người khác (targetLabel !== null) BỎ QUA check này — admin có toàn quyền
      // cấp phát trực tiếp không cần qua sách (đúng "hoặc GM cấp thẳng").
      const isAdminAction = targetLabel !== null;
      const isUniversallyKnown = UNIVERSALLY_KNOWN_WEAPONS.has(weapon.name.toLowerCase());
      if (!isAdminAction && !isUniversallyKnown && (data.items?.[weapon.name] ?? 0) < 1) {
        throw new Error(`Bạn chưa sở hữu **${weapon.name}** — cần đọc sách tương ứng để nhận (xem \`-readbook\`), hoặc nhờ GM cấp.`);
      }
      data.equippedWeapon = weapon.name;
      await savePlayerData(targetUserId, data, slot);
      message.reply(`✅ Đã equip vũ khí **${weapon.name}** (${weapon.weight}/${weapon.type}, Base Dmg ${weapon.baseDamage})${targetLabel ? ` cho **${targetLabel}**` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipweapon")) {
    const { targetUserId, targetLabel } = resolveEquipTarget(message, message.content.replace("-unequipweapon", "").trim());
    try {
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      const removed = data.equippedWeapon;
      data.equippedWeapon = null;
      await savePlayerData(targetUserId, data, slot);
      message.reply(removed ? `✅ Đã gỡ vũ khí **${removed}**${targetLabel ? ` của **${targetLabel}**` : ""}.` : `⚠️ ${targetLabel ? `**${targetLabel}** chưa` : "Chưa"} equip vũ khí nào.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-equipoutfit")) {
    const rawInputFull = message.content.replace("-equipoutfit", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    if (!rawInput) { message.reply("⚠️ Cú pháp: `-equipoutfit [@user] <tên outfit>` (VD: `-equipoutfit black suit`; thêm @user nếu admin muốn equip hộ)"); return; }
    try {
      const outfit = findOutfit(rawInput);
      if (!outfit) throw new Error(`Không tìm thấy outfit "${rawInput}" trong outfit.js.`);
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      const isAdminAction = targetLabel !== null;
      if (!isAdminAction && (data.items?.[outfit.name] ?? 0) < 1) {
        throw new Error(`Bạn chưa sở hữu **${outfit.name}** — cần đọc sách tương ứng để nhận (xem \`-readbook\`), hoặc nhờ GM cấp.`);
      }
      data.equippedOutfit = outfit.name;
      await savePlayerData(targetUserId, data, slot);
      const r = outfit.resistance;
      message.reply(`✅ Đã equip outfit **${outfit.name}** (Res: ${r.B}xB ${r.P}xP ${r.S}xS${outfit.speedRange ? `, Speed ${outfit.speedRange.min}~${outfit.speedRange.max}` : ""})${targetLabel ? ` cho **${targetLabel}**` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipoutfit")) {
    const { targetUserId, targetLabel } = resolveEquipTarget(message, message.content.replace("-unequipoutfit", "").trim());
    try {
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      const removed = data.equippedOutfit;
      data.equippedOutfit = null;
      await savePlayerData(targetUserId, data, slot);
      message.reply(removed ? `✅ Đã gỡ outfit **${removed}**${targetLabel ? ` của **${targetLabel}**` : ""}.` : `⚠️ ${targetLabel ? `**${targetLabel}** chưa` : "Chưa"} equip outfit nào.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-equipaccessory")) {
    const rawInputFull = message.content.replace("-equipaccessory", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    const m = rawInput.match(/^([1-3])\s+(.+)$/);
    if (!m) { message.reply("⚠️ Cú pháp: `-equipaccessory [@user] <slot 1-3> <tên accessory>` (VD: `-equipaccessory 1 perfect cube`; thêm @user nếu admin muốn equip hộ)"); return; }
    const slotNum = parseInt(m[1], 10);
    try {
      const accessory = findAccessory(m[2].trim());
      if (!accessory) throw new Error(`Không tìm thấy accessory "${m[2].trim()}" trong accessory.js.`);
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      // Ownership gate — ÁP DỤNG NHẤT QUÁN với weapon/outfit/page (accessory vốn
      // ĐÃ nằm trong items từ trước, cùng pattern) — GM chỉ nhắc rõ weapon/outfit/
      // page trong yêu cầu gốc, đây là suy luận nhất quán, ĐIỀU CHỈNH nếu không
      // đúng ý.
      const isAdminAction = targetLabel !== null;
      const ownedCount = data.items?.[accessory.name] ?? 0;
      if (!isAdminAction && ownedCount < 1) {
        throw new Error(`Bạn chưa sở hữu **${accessory.name}** — nhờ GM cấp (hiện chưa có cơ chế sách nào dạy accessory).`);
      }
      data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
      // BUG ĐÃ SỬA (xác nhận trực tiếp: "1 player chỉ có 1 item accessory duy nhất
      // nhưng lại equip được cả ở 3 slot accessory") — trước đây CHỈ check "sở hữu
      // ≥1", KHÔNG check đã dùng accessory NÀY ở CÁC SLOT KHÁC bao nhiêu lần rồi —
      // với 3 slot nhưng chỉ 1 lần kiểm tra "sở hữu tối thiểu", 1 cái duy nhất có
      // thể nhét vào cả 3 slot cùng lúc. Đếm số slot KHÁC (không tính slot đang ghi
      // đè) đã dùng CÙNG accessory này, cộng 1 (cho slot sắp ghi) rồi so với số sở
      // hữu — admin bypass giống các gate khác.
      if (!isAdminAction) {
        const usedInOtherSlots = data.equippedAccessories.filter((name, idx) => idx !== slotNum - 1 && name === accessory.name).length;
        if (usedInOtherSlots + 1 > ownedCount) {
          throw new Error(`Bạn chỉ sở hữu **${ownedCount}** **${accessory.name}** nhưng đã dùng **${usedInOtherSlots}** ở slot khác rồi — không đủ để equip thêm slot này.`);
        }
      }
      data.equippedAccessories[slotNum - 1] = accessory.name;
      await savePlayerData(targetUserId, data, slot);
      message.reply(`✅ Đã equip accessory **${accessory.name}** vào slot #${slotNum}${targetLabel ? ` cho **${targetLabel}**` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipaccessory")) {
    const rawInputFull = message.content.replace("-unequipaccessory", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    const slotNum = parseInt(rawInput, 10);
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) { message.reply("⚠️ Cú pháp: `-unequipaccessory [@user] <slot 1-3>`"); return; }
    try {
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
      const removed = data.equippedAccessories[slotNum - 1];
      data.equippedAccessories[slotNum - 1] = null;
      await savePlayerData(targetUserId, data, slot);
      message.reply(removed ? `✅ Đã gỡ accessory **${removed}** khỏi slot #${slotNum}${targetLabel ? ` của **${targetLabel}**` : ""}.` : `⚠️ Slot #${slotNum} đang trống${targetLabel ? ` (${targetLabel})` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -equipment: xem Weapon/Outfit/3 Accessory hiện tại ─────────────────────
  if (message.content.startsWith("-equipment")) {
    try {
      const targetUser = message.mentions.users.first() ?? message.author;
      const { data } = await getPlayerDataWithSlot(targetUser.id);
      const weapon = data.equippedWeapon ? findWeaponAnywhere(data.equippedWeapon) : null;
      const outfit = data.equippedOutfit ? findOutfit(data.equippedOutfit) : null;
      const accessories = (data.equippedAccessories ?? [null, null, null]).map(n => n ? findAccessory(n) : null);
      const lines = [];
      lines.push(`**⚔️ Vũ khí:** ${weapon ? `${weapon.name} (${weapon.weight}/${weapon.type}, Base Dmg ${weapon.baseDamage})` : "*(trống)*"}`);
      if (weapon?.passives?.length) lines.push(...weapon.passives.map(p => `> *${p.name}*: ${p.desc}`));
      lines.push("");
      lines.push(`**🧥 Outfit:** ${outfit ? `${outfit.name} (Res: ${outfit.resistance.B}xB ${outfit.resistance.P}xP ${outfit.resistance.S}xS)` : "*(trống)*"}`);
      if (outfit?.keypage?.length) lines.push(...outfit.keypage.map(k => `> ${k}`));
      lines.push("");
      lines.push("**💍 Accessory:**");
      accessories.forEach((a, i) => {
        lines.push(`**#${i + 1}** ${a ? a.name : "*(trống)*"}`);
        if (a?.passives?.length) lines.push(...a.passives.map(p => `> *${p.name}*: ${p.desc}`));
      });
      message.reply({
        embeds: [{
          title: `🎒 Trang bị hiện tại — ${targetUser.username}`,
          description: lines.join("\n"),
          color: 0x5865f2,
          footer: { text: "-equipweapon/-equipoutfit/-equipaccessory <slot> <tên> · -unequip... để gỡ" },
        }],
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
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
    // BUG ĐÃ SỬA (theo yêu cầu trực tiếp): trước đây gửi CÔNG KHAI trong channel —
    // giờ gửi qua DM (giống cách -rtparry đã làm) để không làm loãng channel chung,
    // kèm 1 xác nhận NGẮN trong channel để người dùng biết đã gửi (hoặc lỗi nếu DM
    // đóng). `/dothihelp` (slash command) thay vào đó dùng ephemeral — xem phần
    // slash command handler riêng.
    try {
      await message.author.send({ embeds: [buildDothihelpEmbed(isAdmin)] });
      message.reply("📬 Đã gửi danh sách lệnh qua DM cho bạn!");
    } catch {
      message.reply("⚠️ Không gửi được DM — kiểm tra lại cài đặt quyền riêng tư (Privacy Settings → Allow DMs from server members) rồi thử lại.");
    }
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
  // ─── REDEEM CODE ────────────────────────────────────────────────────────────
  // Danh sách code hợp lệ — dễ mở rộng thêm sau này (chỉ cần thêm entry mới).
  // GLORYTOPROJECTMOON (xác nhận trực tiếp): "cho 1k3 Lunacy lần đầu" — 1300.
  const REDEEM_CODES = {
    GLORYTOPROJECTMOON: { lunacy: 1300 },
  };
  // ─── GACHA ──────────────────────────────────────────────────────────────────
if (message.content.startsWith("-gacha")) {
    if (isOnCooldown(message.author.id, "gacha", 3000)) {
      message.reply("⏳ Chờ 3 giây trước khi dùng lệnh này tiếp nhé.");
      return;
    }
    const countRaw = message.content.replace(/^-gacha/i, "").trim();
    // Không nhập số → hiện BẢNG UI (embed rate/danh sách + nút Pull x1/x10) thay
    // vì pull ngay — xác nhận trực tiếp: "nên làm ra một cái UI gacha... cho nó
    // đẹp". Có nhập số (VD `-gacha 5`) → GIỮ hành vi cũ (pull trực tiếp qua text,
    // cho power user không cần bấm nút).
    if (!countRaw) {
      try {
        const { data: profileData } = await getPlayerDataWithSlot(message.author.id);
        message.reply({
          embeds: [buildGachaPanelEmbed(profileData.lunacy ?? 0)],
          components: buildGachaPanelButtons(message.author.id),
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }
    const count = parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count < 1 || count > 10) {
      message.reply(`⚠️ Cú pháp: \`-gacha [số lần, 1-10]\` (bỏ trống để mở bảng UI).\n> Chi phí: **${GACHA_COST_PER_PULL} <:Lunacy:1524989409529823342>Lunacy/lần**.\n> Rate: ${GACHA_RATES.high}% thường / ${GACHA_RATES.mid}% trung bình / ${GACHA_RATES.rare}% cực hiếm.`);
      return;
    }
    try {
      const { totalCost, resultLines, rareHits, remainingLunacy } = await performGachaPull(message.author.id, count);
      message.reply(
        `🎰 **Gacha x${count}** (-${formatNumber(totalCost)} <:Lunacy:1524989409529823342>Lunacy, còn **${formatNumber(remainingLunacy)}**):\n` +
        resultLines.map(l => `> ${l}`).join("\n") +
        (rareHits.length > 0 ? `\n\n🎉 **CỰC HIẾM!** Trúng: ${rareHits.join(", ")} — liên hệ GM để thiết kế cụ thể.` : "")
      );
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-redeem")) {
    if (isOnCooldown(message.author.id, "redeem", 3000)) {
      message.reply("⏳ Chờ 3 giây trước khi dùng lệnh này tiếp nhé.");
      return;
    }
    const codeRaw = message.content.replace(/^-redeem/i, "").trim().toUpperCase();
    if (!codeRaw) {
      message.reply("⚠️ Cú pháp: `-redeem <code>` (VD: `-redeem GLORYTOPROJECTMOON`).");
      return;
    }
    const codeReward = REDEEM_CODES[codeRaw];
    if (!codeReward) {
      message.reply(`❌ Code "${codeRaw}" không hợp lệ hoặc đã hết hạn.`);
      return;
    }
    try {
      await withLock(message.author.id, async () => {
        const { data: profileData, slot } = await getPlayerDataWithSlot(message.author.id);
        profileData.redeemedCodes = profileData.redeemedCodes ?? [];
        if (profileData.redeemedCodes.includes(codeRaw)) {
          throw new Error(`Bạn đã dùng code "${codeRaw}" ở profile này rồi — mỗi code chỉ dùng được 1 lần.`);
        }
        profileData.redeemedCodes.push(codeRaw);
        const rewardNotes = [];
        if (codeReward.lunacy) {
          profileData.lunacy = (profileData.lunacy ?? 0) + codeReward.lunacy;
          rewardNotes.push(`+${formatNumber(codeReward.lunacy)} <:Lunacy:1524989409529823342>Lunacy`);
        }
        await savePlayerData(message.author.id, profileData, slot);
        message.reply(`✅ Đã dùng code **${codeRaw}**: ${rewardNotes.join(", ")} (hiện có **${formatNumber(profileData.lunacy)} <:Lunacy:1524989409529823342>Lunacy**).`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

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
        message.reply(`❌ Slot không hợp lệ. Dùng \`-profile switch <1-${MAX_PROFILES}>\` (VD: \`-profile switch 1\`).`);
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
      const { embed, components } = await buildProfileInfoEmbed(
        userId,
        message.author.displayName ?? message.author.username,
        `Dùng -profile switch <1-${MAX_PROFILES}> hoặc bấm nút bên dưới để đổi profile`
      );
      message.reply({ embeds: [embed], components });
      return;
    }

    message.reply(`❌ Lệnh không hợp lệ. Dùng:\n> \`-profile info\` — xem tổng quan tất cả profile\n> \`-profile switch <1-${MAX_PROFILES}>\` — chuyển sang profile khác\n> \`-profile rename <tên>\` — đặt tên cho profile hiện tại`);
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
    // Default 1.3x (mặc định crit dmg theo luật) — KHÔNG phải 1 (bug cũ đã sửa, xem
    // comment đầy đủ ở computeAttackerPerkContext).
    const critMul = parseFloat((kv["critmul"] ?? "1.3").replace("x", ""));
    const poiseInit = parseInt(kv["poise"] ?? "0", 10) || 0;
    const diceMul = parseFloat((kv["dicemul"] ?? "1").replace("x", ""));
    const sinkingInit = parseInt(kv["sinking"] ?? "0", 10);
    const ruptureInit = parseInt(kv["rupture"] ?? "0", 10);
    const sanityInit = parseInt(kv["sanity"] ?? "0", 10);
    const theLiving = parseInt(kv["living"] ?? "0", 10) || 0;
    const theDeparted = parseInt(kv["departed"] ?? "0", 10) || 0;
    const burnInit = parseInt(kv["burn"] ?? "0", 10) || 0;
    const bleedInit = parseInt(kv["bleed"] ?? "0", 10) || 0;
    const bleedActions = parseInt(kv["bleedactions"] ?? "1", 10) || 1;
    const tremorInit = parseInt(kv["tremor"] ?? "0", 10) || 0;
    const chargeInit = parseInt(kv["charge"] ?? "0", 10) || 0;
    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving, theDeparted, burnInit, bleedInit, bleedActions, tremorInit, chargeInit });
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
      burnInit,
      bleedInit,
      bleedActions,
      chargeInit,
      tremorInit,
    }));
    return;
  }

  // ── -encounter ── (start / hit / status / end) — xem comment đầy đủ ở
  // buildEncounterBoardEmbed phía trên về lý do tách biệt hoàn toàn khỏi Profile.
  if (message.content.startsWith("-encounter")) {
    const isAdmin = ADMIN_IDS.has(message.author.id);
    // GM Control Panel (xác nhận trực tiếp): "1 bảng UI control enemy cho GM ở 1
    // kênh khác, vì nếu nhập lệnh liên tục ở kênh đang encounter thì sẽ trôi
    // chat" — resolveGmLinkedChannel cho phép GÕ LỆNH TỪ KÊNH GM RIÊNG (đã link
    // qua `-encounter linkgm`) mà vẫn điều khiển ĐÚNG encounter đang chạy ở kênh
    // khác — trả về CHÍNH encChannelId nếu không có mapping nào (hành vi
    // cũ, encounter ở đúng kênh gõ lệnh, không đổi gì với setup thông thường).
    const encChannelId = await resolveGmLinkedChannel(message.channel.id);
    const argStr = message.content.replace(/^-encounter/i, "").trim();
    const subMatch = argStr.match(/^(\S+)\s*/);
    const sub = (subMatch?.[1] ?? "").toLowerCase();
    const rest = subMatch ? argStr.slice(subMatch[0].length).trim() : "";

    if (sub === "linkgm") {
      // GM Control Panel (xác nhận trực tiếp): "1 bảng UI control enemy cho GM ở
      // 1 kênh khác" — chạy lệnh này TRONG kênh muốn dùng làm GM channel, chỉ
      // định encounter channel muốn điều khiển. Dùng message.channel.id THẬT
      // (không phải encChannelId đã resolve) vì đây CHÍNH LÀ bước tạo mapping.
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được liên kết kênh điều khiển."); return; }
      const kv = parseKeyValues(rest);
      const targetChannelRaw = (kv["channel"] ?? "").trim();
      const targetChannelId = targetChannelRaw.replace(/[<#>]/g, "");
      if (!targetChannelId) {
        message.reply("⚠️ Cú pháp: `-encounter linkgm channel: <#kênh-encounter>` (chạy lệnh này TRONG kênh bạn muốn dùng làm bảng điều khiển GM).");
        return;
      }
      const targetEncounter = await getEncounter(targetChannelId);
      if (!targetEncounter) {
        message.reply(`⚠️ Không tìm thấy encounter nào đang chạy ở <#${targetChannelId}>.`);
        return;
      }
      if (!isAdmin && message.author.id !== targetEncounter.gmId) {
        message.reply("⚠️ Chỉ GM tạo encounter đó (hoặc admin) mới được liên kết.");
        return;
      }
      await redis.set(`gmlink:${message.channel.id}`, targetChannelId);
      targetEncounter.gmChannelId = message.channel.id;
      await saveEncounter(targetChannelId, targetEncounter);
      message.reply(`✅ Đã liên kết kênh này làm **bảng điều khiển GM** cho encounter **${targetEncounter.name}** (<#${targetChannelId}>).\n> Từ giờ mọi lệnh \`-encounter ...\` gõ TẠI ĐÂY sẽ tự động áp dụng cho encounter đó — dùng \`-encounter gmpanel\` để mở bảng điều khiển nhanh.`);
      return;
    }

    if (sub === "start") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được tạo encounter."); return; }
      const kv = parseKeyValues(rest);
      const name = (kv["name"] ?? "").trim();
      if (!name || name.length > ENCOUNTER_NAME_MAX_LENGTH) {
        message.reply(`⚠️ Cú pháp: \`-encounter start name: <tên trận>\` (tối đa ${ENCOUNTER_NAME_MAX_LENGTH} ký tự). Thêm \`permadeath: yes\` nếu là Night in the Backstreet/dungeon đặc biệt (chết = permanent death thay vì Death Penalty thường). Thêm enemy sau bằng \`-encounter addenemy\`.`);
        return;
      }
      const permadeath = /^(yes|true|1|có)$/i.test((kv["permadeath"] ?? "").trim());
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const existing = await getEncounter(encChannelId);
          if (existing) throw new Error(`Channel này đang có encounter **${existing.name}** chạy — dùng \`-encounter end\` trước.`);
          const encounter = {
            name, enemies: {}, players: {},
            gmId: message.author.id, createdAt: Date.now(),
            pendingActions: [], permadeath,
            // turnNumber — bắt đầu 1 (Turn 1), tăng mỗi -encounter endturn.
            // actionLog — lịch sử ĐẦY ĐỦ các action đã CONFIRM (KHÔNG phải pending
            // — pendingActions là hàng chờ TRƯỚC khi confirm, actionLog là log SAU
            // khi đã confirm/reject) — xem -encounter log để xem lại.
            turnNumber: 1, actionLog: [],
          };
          await saveEncounter(encChannelId, encounter);
          await message.reply({
            content: `✅ Đã tạo encounter **${name}**${permadeath ? " ⚠️**PERMADEATH** (chết = permanent death, không phải Death Penalty thường)" : ""}. Dùng \`-encounter addenemy key: <key> name: <tên> hp: <số>\` để thêm enemy.`,
            embeds: [buildEncounterBoardEmbed(encounter)],
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "addenemy") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được thêm enemy."); return; }
      const kv = parseKeyValues(rest);
      const key = normalizeEnemyKey(kv["key"] ?? "");
      const name = (kv["name"] ?? "").trim();
      const hp = parseInt(kv["hp"] ?? "", 10);
      if (!key || key.length > ENCOUNTER_KEY_MAX_LENGTH || !/^[a-z0-9]+$/.test(key) || !name || !Number.isFinite(hp) || hp <= 0) {
        message.reply(
          "⚠️ Cú pháp: `-encounter addenemy key: <key ngắn a-z0-9> name: <tên đầy đủ> hp: <số>` (tùy chọn `stamina:`/`weapon: light|medium|heavy`/`res: 1.3xB 1.3xP 1.3xS`/`perks: <tên1>,<tên2>`)\n" +
          "> VD: `-encounter addenemy key: mo name: Mo (Brother of Iron) hp: 240`\n" +
          "> Enemy không có profile nên perk phải gán trực tiếp qua `perks:` ở đây (player thì dùng `-unlockskilltree` riêng, lưu trên profile)."
        );
        return;
      }
      const stamina = parseInt(kv["stamina"] ?? "", 10);
      const weapon = normalizeWeaponWeight(kv["weapon"] ?? "medium");
      const resRaw = kv["res"] ?? "";
      const res = { B: 1, P: 1, S: 1 };
      for (const m of resRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi)) res[m[2].toUpperCase()] = parseFloat(m[1]);
      const perksRaw = (kv["perks"] ?? "").trim();
      const perksList = perksRaw ? perksRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
      const speedRangeMatch = (kv["speedrange"] ?? "").match(/(\d+)\s*[~\-]\s*(\d+)/);
      const speedRangeMin = speedRangeMatch ? parseInt(speedRangeMatch[1], 10) : 3;
      const speedRangeMax = speedRangeMatch ? parseInt(speedRangeMatch[2], 10) : 6;
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
          if (encounter.players[key]) throw new Error(`Key "${key}" đang trùng với 1 player đã join — đổi key khác.`);
          const wasExisting = !!encounter.enemies[key];
          encounter.enemies[key] = createCombatant({
            name, maxHp: hp,
            maxStamina: Number.isFinite(stamina) && stamina > 0 ? stamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
            weaponWeight: weapon, resistance: res, speedRangeMin, speedRangeMax,
          });
          encounter.enemies[key].unlockedPerks = perksList;
          // GAP ĐÃ SỬA (phát hiện qua rà soát): thêm enemy GIỮA 1 round (đã
          // rollspeed) trước đây khiến enemy này KHÔNG BAO GIỜ được hành động
          // cho tới hết round — giờ tự động chèn vào turnOrder hiện tại.
          if (!wasExisting) insertIntoTurnOrderMidRound(encounter, key, "enemy", encounter.enemies[key]);
          await saveEncounter(encChannelId, encounter);
          await message.reply({
            content: `✅ ${wasExisting ? "Đã cập nhật lại" : "Đã thêm"} enemy **${name}** (key: \`${key}\`) với ${hp} HP.` +
              (perksList.length > 0 ? ` (Perk: ${perksList.join(", ")})` : ""),
            embeds: [buildEncounterBoardEmbed(encounter)],
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── removeenemy: gỡ 1 enemy KHỎI BOARD hoàn toàn (KHÁC với hạ HP về 0 — dùng
    // cho trường hợp enemy bỏ chạy/bị bắt sống/rút lui giữa trận, không phải chết).
    // Enemy đã gỡ KHÔNG còn trong actionLog tương lai, không tính vào "tất cả đã hạ"
    // (allDead) — nếu muốn loại enemy ra khỏi điều kiện thắng mà KHÔNG coi là enemy
    // đã chết, đây là lệnh đúng (thay vì set HP=0 sẽ kích hoạt Death Penalty/loot
    // logic dành cho "đã hạ").
    if (sub === "removeenemy") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được gỡ enemy."); return; }
      const kv = parseKeyValues(rest);
      const keyRaw = (kv["key"] ?? "").trim();
      if (!keyRaw) { message.reply("⚠️ Cú pháp: `-encounter removeenemy key: <key>` (gỡ khỏi board — dùng cho bỏ chạy/bắt sống, KHÔNG phải chết)."); return; }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const key = normalizeEnemyKey(keyRaw);
          const enemy = encounter.enemies[key];
          if (!enemy) throw new Error(`Không tìm thấy enemy với key "${keyRaw}".`);
          const name = enemy.name;
          delete encounter.enemies[key];
          // Dọn pendingActions còn nhắm vào enemy vừa gỡ (tránh confirm sau đó bị lỗi
          // "không tìm thấy target").
          encounter.pendingActions = (encounter.pendingActions ?? []).filter(p =>
            p.attackerId !== key && !(p.targets ?? []).some(t => t.targetId === key)
          );
          appendActionLog(encounter, `🏃 Gỡ enemy **${name}** (key: \`${key}\`) khỏi board — bỏ chạy/bắt sống.`);
          await saveEncounter(encChannelId, encounter);
          await message.reply({
            content: `🏃 Đã gỡ enemy **${name}** (key: \`${key}\`) khỏi board — KHÔNG tính là đã hạ (bỏ chạy/bắt sống).`,
            embeds: [buildEncounterBoardEmbed(encounter)],
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "join") {
      const kv = parseKeyValues(rest);
      const hp = parseInt(kv["hp"] ?? "", 10);
      const stamina = parseInt(kv["stamina"] ?? "", 10);
      const light = parseInt(kv["light"] ?? "", 10);
      // Lấy profile TRƯỚC để biết Weapon/Outfit đã equip (nếu có) — làm GIÁ TRỊ MẶC
      // ĐỊNH cho weapon:/res:/speedrange: khi KHÔNG gõ tay tham số đó. Gõ tay vẫn
      // ĐÈ LÊN trang bị (linh hoạt cho trường hợp đặc biệt, không bắt buộc equip).
      const profileDataForDefaults = await getPlayerData(message.author.id);
      if (profileDataForDefaults.permanentlyDead) {
        message.reply("☠️ Nhân vật của bạn đang **Permanent Death** (chết vĩnh viễn từ 1 encounter permadeath trước đó) — không thể tham gia encounter nào cho tới khi được hồi sinh qua Rewound Time (`-rewoundtime` — GM/admin dùng giúp bạn).");
        return;
      }
      const equippedWeaponObj = profileDataForDefaults.equippedWeapon ? findWeaponAnywhere(profileDataForDefaults.equippedWeapon) : null;
      const equippedOutfitObj = profileDataForDefaults.equippedOutfit ? findOutfit(profileDataForDefaults.equippedOutfit) : null;
      const weapon = normalizeWeaponWeight(kv["weapon"] ?? equippedWeaponObj?.weight ?? "medium");
      const resRaw = kv["res"] ?? "";
      // BUG ĐÃ SỬA (xác nhận trực tiếp: "khi player không có outfit trên người thì
      // sẽ mặc định 3 loại kháng là 2x và speed range là 3~6, không có passive") —
      // trước đây mặc định 1x khi KHÔNG có outfit — SAI, đúng phải là 2x (không mặc
      // outfit = dễ bị tổn thương hơn, gấp đôi dmg nhận). Speed range 3~6 ĐÃ ĐÚNG
      // sẵn (xem speedRangeMin/Max bên dưới, fallback 6/3 khi không có outfit).
      // "Không có passive" tự động đúng — passive outfit (VD Iron Horus) check
      // equippedOutfit KHỚP TÊN CỤ THỂ, tự nhiên false khi null, không cần sửa gì.
      const res = equippedOutfitObj ? { ...equippedOutfitObj.resistance } : { B: 2, P: 2, S: 2 };
      for (const m of resRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi)) res[m[2].toUpperCase()] = parseFloat(m[1]);
      const speedRangeMatch = (kv["speedrange"] ?? "").match(/(\d+)\s*[~\-]\s*(\d+)/);
      const speedRangeMin = speedRangeMatch ? parseInt(speedRangeMatch[1], 10) : (equippedOutfitObj?.speedRange?.min ?? 3);
      const speedRangeMax = speedRangeMatch ? parseInt(speedRangeMatch[2], 10) : (equippedOutfitObj?.speedRange?.max ?? 6);
      // Max Light MẶC ĐỊNH tính theo Grade hiện tại (luật: "4 Max Light ở grade
      // 7/8/9, cứ cách 3 grade nhận thêm 1 (Max 6)") — GRADE_MIN=9 (thấp nhất),
      // GRADE_MAX=1 (cao nhất), grade GIẢM khi lên cấp. Công thức:
      // 4 + floor((GRADE_MIN - grade)/3), cap 6. Gõ tay light: vẫn ĐÈ lên được.
      const { grade: playerGrade } = calcGrade(profileDataForDefaults.exp ?? 0);
      const gradeBasedMaxLight = Math.min(6, 4 + Math.floor((GRADE_MIN - playerGrade) / 3));
      // Max HP MẶC ĐỊNH tính theo Grade (luật: "mỗi 1 grade... +20 Max HP", GM xác
      // nhận trực tiếp HP ở grade 9 (thấp nhất) = 140) — công thức: 140 + 20×(số
      // grade đã lên TỪ grade 9). Gõ tay hp: vẫn ĐÈ lên được (linh hoạt — đặc biệt
      // cần cho enemy/stat-block tuỳ ý không theo Grade).
      const gradeBasedMaxHp = 140 + 20 * (GRADE_MIN - playerGrade);
      // Chấn thương PERSIST qua encounter (luật xác nhận trực tiếp) — Gãy Xương/Vết
      // thương lớn trừ Max HP VĨNH VIỄN cho tới khi được chữa (bằng Ahn ngoài
      // encounter qua -healinjuryahn, HOẶC bằng K-Corp Ampule trong encounter — xem
      // -encounter useitem). Max HP THẬT = Grade-based TRỪ tổng penalty từ injuries
      // đang mang, floor tại 1 (không bao giờ về 0/âm).
      const persistedInjuries = profileDataForDefaults.injuries ?? [];
      const injuryMaxHpPenalty = calcInjuryMaxHpPenalty(persistedInjuries);
      const effectiveGradeMaxHp = Math.max(1, gradeBasedMaxHp - injuryMaxHpPenalty);
      // HP mặc định khi KHÔNG gõ tay hp: — dùng HP THẬT còn lại từ encounter trước
      // (persist qua profile.currentHp), áp auto-reset nếu đã qua mốc 0h/12h giờ
      // VN kể từ lần cập nhật gần nhất (xem getEffectiveCurrentHp). Nếu auto-reset
      // xảy ra ngay lúc này, lưu lại NGAY để lần check sau không reset lại lần nữa
      // trước mốc kế tiếp.
      const effectiveHp = getEffectiveCurrentHp(profileDataForDefaults, effectiveGradeMaxHp);
      if (effectiveHp.didReset) {
        profileDataForDefaults.currentHp = effectiveHp.hp;
        profileDataForDefaults.hpLastResetCheck = Date.now();
        const { slot: hpSlot } = await getPlayerDataWithSlot(message.author.id);
        await savePlayerData(message.author.id, profileDataForDefaults, hpSlot);
      }
      const finalHp = Number.isFinite(hp) && hp > 0 ? hp : effectiveHp.hp;
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
          const wasJoined = !!encounter.players[message.author.id];
          encounter.players[message.author.id] = createCombatant({
            name: message.author.username, maxHp: finalHp,
            maxStamina: Number.isFinite(stamina) && stamina > 0 ? stamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
            maxLight: Number.isFinite(light) && light > 0 ? light : gradeBasedMaxLight,
            weaponWeight: weapon,
            weaponBaseDamage: equippedWeaponObj?.baseDamage ?? null,
            weaponType: equippedWeaponObj?.type ?? null,
            weaponName: equippedWeaponObj?.name ?? null,
            weaponCriticalKey: equippedWeaponObj ? (equippedWeaponObj.criticalSkillKey ?? equippedWeaponObj.name) : null,
            resistance: res, speedRangeMin, speedRangeMax,
          });
          // Copy Skill Tree đã mở khóa TỪ PROFILE (vĩnh viễn) vào combatant của
          // encounter này — snapshot lúc join, giống cách HP/Stamina/vũ khí cũng
          // được "chốt" lúc join (không tự đồng bộ real-time nếu admin unlock thêm
          // GIỮA lúc encounter đang chạy — phải join lại để cập nhật, y hệt nguyên
          // tắc đang áp dụng cho mọi field khác). Dùng LẠI profileDataForDefaults
          // đã fetch ở trên (tránh gọi Redis 2 lần + tránh race condition).
          const profileData = profileDataForDefaults;
          const joined = encounter.players[message.author.id];
          // GAP ĐÃ SỬA (phát hiện qua rà soát): join GIỮA 1 round (đã rollspeed)
          // trước đây khiến player này KHÔNG BAO GIỜ được hành động cho tới hết
          // round — giờ tự động chèn vào turnOrder hiện tại (chỉ lần join ĐẦU,
          // không phải update lại profile giữa chừng).
          if (!wasJoined) insertIntoTurnOrderMidRound(encounter, message.author.id, "player", joined);
          joined.unlockedPerks = [...(profileData.unlockedSkillTree ?? [])];
          // Injuries PERSIST qua encounter (xác nhận trực tiếp từ GM) — snapshot
          // TRỰC TIẾP từ profile (KHÔNG reset về rỗng như trước đây). maxHp đã tính
          // TRỪ injuryMaxHpPenalty ở effectiveGradeMaxHp phía trên rồi, nên ở đây chỉ
          // cần copy danh sách injuries (không cần trừ maxHp lần 2).
          joined.injuries = [...persistedInjuries];
          // Snapshot 5 Page + 5 E.G.O Page đã equip trên profile — dùng để build
          // dropdown hành động (xem buildEncounterActionPanel) — CHỐT lúc join, y
          // hệt nguyên tắc đang áp dụng cho unlockedPerks/HP/Stamina/... (đổi loadout
          // giữa trận thì phải join lại để cập nhật).
          joined.unlockedPagesSnapshot = (profileData.equippedPages ?? []).filter(Boolean);
          joined.unlockedEgoPagesSnapshot = (profileData.equippedEgoPages ?? []).filter(Boolean);
          // Snapshot 3 Accessory đã equip — dùng để check perk ĐẶC BIỆT gắn liền 1
          // accessory cụ thể (VD Dimension Pocket của Găng Tay Câm Lặng cho phép đổi
          // vũ khí giữa trận — xem -encounter swapweapon) — CHỐT lúc join, cùng
          // nguyên tắc snapshot như Page ở trên.
          joined.equippedAccessoriesSnapshot = (profileData.equippedAccessories ?? []).filter(Boolean);
          // Cờ passive GẮN LIỀN 1 outfit/weapon CỤ THỂ (tự động hoá theo yêu cầu trực
          // tiếp) — snapshot lúc join, cùng nguyên tắc như trên (đổi trang bị giữa
          // trận cần join lại để cập nhật).
          // Iron Horus (Abydos's Uniform - Lazy Style): Block tốn 40 Sta (thay vì 10)
          // nhưng giảm sát thương TOÀN BỘ đòn (100%, thay vì 90%/99% mặc định) — xem
          // performGuardEvade.
          joined.hasIronHorus = (profileData.equippedOutfit ?? "").toLowerCase().replace(/^["']+|["']+$/g, "") === "abydos's uniform - lazy style";
          // Perk "đầu encounter" — áp dụng 1 LẦN ngay lúc join (KHÔNG áp lại nếu join
          // lại để cập nhật stat — chỉ áp khi THỰC SỰ là lần tham gia đầu, tránh free
          // refill Light/Poise/Sanity mỗi lần gõ lại join).
          const startNotes = [];
          if (!wasJoined) {
            if (hasPerk(joined, "Here We Go Again")) { joined.currentLight = Math.min(joined.maxLight, 3); startNotes.push("+3 Light (Here We Go Again)"); }
            if (hasPerk(joined, "Adrenaline Rush")) { joined.poise = Math.min(POISE_MAX, 10); startNotes.push("+10 Poise (Adrenaline Rush)"); }
            if (hasPerk(joined, "No Mind To Cure")) { joined.currentSanity = -25; startNotes.push("-25 Sanity (No Mind To Cure)"); }
          }
          await saveEncounter(encChannelId, encounter);
          const equipNotes = [];
          if (equippedWeaponObj && !kv["weapon"]) equipNotes.push(`Vũ khí: ${equippedWeaponObj.name} (${equippedWeaponObj.weight})`);
          if (equippedOutfitObj && !kv["res"]) equipNotes.push(`Outfit: ${equippedOutfitObj.name} (Res ${res.B}xB ${res.P}xP ${res.S}xS)`);
          if (!Number.isFinite(light) || light <= 0) equipNotes.push(`Max Light: ${gradeBasedMaxLight} (theo Grade ${playerGrade})`);
          if (!Number.isFinite(hp) || hp <= 0) {
            equipNotes.push(
              effectiveHp.hp < gradeBasedMaxHp
                ? `HP: ${effectiveHp.hp}/${gradeBasedMaxHp} (còn lại từ trước — chưa qua mốc reset 0h/12h giờ VN)`
                : `Max HP: ${gradeBasedMaxHp} (theo Grade ${playerGrade})`
            );
          }
          await message.reply({
            content: `✅ ${wasJoined ? "Đã cập nhật lại" : "Đã tham gia"} encounter **${encounter.name}** với ${finalHp} HP.` +
              (equipNotes.length > 0 ? `\n> 🎒 Tự lấy từ trang bị: ${equipNotes.join(", ")}` : "") +
              (joined.unlockedPerks.length > 0 ? ` (Perk từ profile: ${joined.unlockedPerks.join(", ")})` : "") +
              (startNotes.length > 0 ? `\n> 🆙 ${startNotes.join(", ")}` : ""),
            components: buildEncounterActionPanel(encChannelId, joined, message.author.id),
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── rollspeed: roll Speed cho TẤT CẢ combatant, quyết định thứ tự turn (xem
    // determineTurnOrder — xử lý tie cùng phe/khác phe khác nhau theo update mới).
    if (sub === "pass") {
      // Turn Order Enforcement: bỏ qua lượt CHỦ ĐỘNG (không hành động gì cả) —
      // cần thiết vì gate mới chặn M1/skill ngoài lượt, người/enemy có thể muốn
      // "nhường lượt" (VD hết Stamina, hoặc chủ động không làm gì turn này).
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const order = encounter.turnOrder ?? [];
          if (order.length === 0) throw new Error("Chưa roll Speed — dùng `-encounter rollspeed` trước.");
          const curEntry = order[encounter.currentTurnIndex ?? 0];
          if (!curEntry) throw new Error("Đã hết lượt cho turn này — dùng `-encounter endturn`.");
          const isAdmin2 = ADMIN_IDS.has(message.author.id);
          if (curEntry.type === "player" && message.author.id !== curEntry.id) throw new Error("Chỉ đúng người đang tới lượt mới pass được.");
          if (curEntry.type === "enemy" && !isAdmin2 && message.author.id !== encounter.gmId) throw new Error("Chỉ GM/admin mới pass lượt enemy được.");
          const label = curEntry.type === "enemy" ? `**${encounter.enemies[curEntry.id]?.name ?? curEntry.id}**` : `<@${curEntry.id}>`;
          const wrapped = advanceToNextTurnHolder(encounter);
          appendActionLog(encounter, `⏭️ ${label} bỏ qua lượt (pass).`);
          await saveEncounter(encChannelId, encounter);
          announceCurrentTurn(encChannelId, encounter).catch(() => {});
          message.reply(`⏭️ ${label} đã bỏ qua lượt.${wrapped ? "\n> 🔄 Đã hết 1 vòng turn order — dùng `-encounter endturn` để bắt đầu turn mới." : `\n> Tiếp theo: ${buildTurnOrderText(encounter)}`}`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "rollspeed") {
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM (hoặc admin) mới roll thứ tự turn.");
          if (Object.keys(encounter.enemies).length + Object.keys(encounter.players).length < 1) throw new Error("Chưa có combatant nào để roll.");
          determineTurnOrder(encounter);
          appendActionLog(encounter, `🎲 Roll Speed — Thứ tự Turn mới:\n${buildTurnOrderText(encounter)}`);
          await saveEncounter(encChannelId, encounter);
          announceCurrentTurn(encChannelId, encounter).catch(() => {});
          message.reply({ embeds: [{ title: "🎲 Thứ tự Turn", description: buildTurnOrderText(encounter), color: 0x3498db }] });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── haste/bind: chỉnh tay (GM/player) — 1 Haste +1 Speed, 1 Bind -1 Speed (xem
    // comment ở createCombatant — chưa tích hợp qua dmgStr tag như 7 status cũ).
    if (sub === "haste" || sub === "bind") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const amount = parseInt(kv["amount"] ?? "", 10);
      if (!targetRaw || !Number.isFinite(amount)) {
        message.reply(`⚠️ Cú pháp: \`-encounter ${sub} target: <key/userId/me> amount: <số, có thể âm để trừ>\``);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          resolved.combatant[sub] = Math.max(0, (resolved.combatant[sub] ?? 0) + amount);
          appendActionLog(encounter, `${resolved.label}: ${sub === "haste" ? "Haste" : "Bind"} ${amount >= 0 ? "+" : ""}${amount} → còn ${resolved.combatant[sub]}.`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ ${resolved.label}: ${sub === "haste" ? "Haste" : "Bind"} ${amount >= 0 ? "+" : ""}${amount} → còn ${resolved.combatant[sub]}.`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── swapweapon: đổi vũ khí GIỮA TRẬN — luật xác nhận trực tiếp: "mỗi người chỉ
    // được trang bị 1 vũ khí + 1 outfit + 3 accessory, KHÔNG được đem vào/đổi giữa
    // trận TRỪ 1 số vũ khí/accessory ĐẶC BIỆT cho phép điều đó" — MẶC ĐỊNH CHẶN
    // HOÀN TOÀN, chỉ mở khi player sở hữu 1 trong số ít accessory/vũ khí được biết
    // là CÓ khả năng này (hiện tại: Dimension Pocket — passive của Găng Tay Câm
    // Lặng, "Có thể thay đổi vũ khí giữa trận bằng cách tiêu hao 1 Light"). DANH
    // SÁCH NÀY CỐ Ý NGẮN — chỉ thêm khi có xác nhận RÕ RÀNG 1 item khác cũng cho
    // phép, KHÔNG tự suy đoán/mở rộng.
    const MID_COMBAT_WEAPON_SWAP_SOURCES = {
      "găng tay câm lặng": { lightCost: 1, abilityName: "Dimension Pocket" },
    };
    if (sub === "swapweapon") {
      const weaponNameRaw = rest.trim();
      if (!weaponNameRaw) { message.reply("⚠️ Cú pháp: `-encounter swapweapon <tên vũ khí>` (CHỈ dùng được nếu sở hữu accessory/vũ khí có khả năng đổi giữa trận, VD Dimension Pocket của Găng Tay Câm Lặng)."); return; }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const player = encounter.players[message.author.id];
          if (!player) throw new Error("Bạn chưa tham gia encounter này.");
          const ownedAccessories = (player.equippedAccessoriesSnapshot ?? []).map(a => a.toLowerCase());
          const grantingSource = Object.keys(MID_COMBAT_WEAPON_SWAP_SOURCES).find(key => ownedAccessories.includes(key));
          if (!grantingSource) {
            throw new Error(`Trang bị bị KHOÁ trong suốt trận (luật: 1 vũ khí cố định/trận) — bạn không sở hữu accessory/vũ khí nào cho phép đổi giữa trận (VD Dimension Pocket của Găng Tay Câm Lặng).`);
          }
          const { lightCost, abilityName } = MID_COMBAT_WEAPON_SWAP_SOURCES[grantingSource];
          const newWeapon = findWeaponAnywhere(weaponNameRaw);
          if (!newWeapon) throw new Error(`Không tìm thấy vũ khí "${weaponNameRaw}" trong weapon.js hoặc skills.js.`);
          if (player.currentLight < lightCost) throw new Error(`Không đủ Light để đổi vũ khí qua ${abilityName} — cần ${lightCost}, hiện có ${player.currentLight}.`);
          const oldWeaponWeight = player.weaponWeight;
          player.currentLight -= lightCost;
          player.weaponWeight = newWeapon.weight;
          player.weaponBaseDamage = newWeapon.baseDamage ?? null;
          player.weaponType = newWeapon.type ?? null;
          player.weaponName = newWeapon.name ?? null;
          player.weaponCriticalKey = newWeapon.criticalSkillKey ?? newWeapon.name ?? null;
          appendActionLog(encounter, `🔄 <@${message.author.id}> đổi vũ khí qua ${abilityName} (-${lightCost} Light): ${newWeapon.name} (${oldWeaponWeight} → ${newWeapon.weight}).`);
          await saveEncounter(encChannelId, encounter);
          message.reply(
            `🔄 ${message.author} đổi vũ khí qua **${abilityName}** (-${lightCost} Light): **${newWeapon.name}** (${newWeapon.weight}/${newWeapon.type}, Base Dmg ${newWeapon.baseDamage}).\n` +
            `> Độ nặng vũ khí đổi từ \`${oldWeaponWeight}\` → \`${newWeapon.weight}\` (ảnh hưởng Stamina cost M1 + số hit Guard/Evade/Parry chặn được). GM tự xác nhận đây có đúng là vũ khí hợp lệ theo phạm vi ${abilityName} hay không (hệ thống không có danh sách phân loại để tự kiểm tra).`
          );
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "status") {
      const encounter = await getEncounter(encChannelId);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào. Dùng `-encounter start` để tạo."); return; }
      message.reply({ embeds: [buildEncounterBoardEmbed(encounter)], components: buildEncounterActionPanel(encChannelId, encounter.players[message.author.id], message.author.id) });
      return;
    }

    if (sub === "pending") {
      const encounter = await getEncounter(encChannelId);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      const pending = encounter.pendingActions ?? [];
      message.reply({
        embeds: [{
          title: `⏳ Pending Actions (${pending.length})`,
          description: buildPendingListText(encounter),
          color: 0xf39c12,
        }],
        components: pending.length > 0 ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`encconfirmall:${encChannelId}`).setLabel("✅ Confirm tất cả").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`encrejectall:${encChannelId}`).setLabel("❌ Reject tất cả").setStyle(ButtonStyle.Danger),
        )] : [],
      });
      return;
    }

    // ── log: xem lại LỊCH SỬ các action ĐÃ CONFIRM/REJECT (full detail — nguyên
    // văn text đã hiện lúc confirm, xem actionLog ghi ở đâu trong confirm handler).
    // KHÁC "pending" — pending là hàng chờ TRƯỚC khi confirm, log là lịch sử SAU
    // khi đã xử lý xong. Mặc định hiện 5 turn GẦN NHẤT (tránh tràn message dài) —
    // `turn: N` để xem ĐÚNG 1 turn cụ thể, `turn: all` để xem TOÀN BỘ (tự cắt
    // thành nhiều embed nếu vượt 4096 ký tự/embed của Discord).
    if (sub === "log") {
      const encounter = await getEncounter(encChannelId);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      const fullLog = encounter.actionLog ?? [];
      if (fullLog.length === 0) { message.reply("📜 Chưa có action nào được confirm/reject trong encounter này."); return; }
      const kv = parseKeyValues(rest);
      const turnFilter = (kv["turn"] ?? "").trim().toLowerCase();
      let entriesToShow;
      let headerNote;
      if (turnFilter === "all") {
        entriesToShow = fullLog;
        headerNote = `toàn bộ ${fullLog.length} entry`;
      } else if (turnFilter && /^\d+$/.test(turnFilter)) {
        const turnNum = parseInt(turnFilter, 10);
        entriesToShow = fullLog.filter(e => e.turn === turnNum);
        headerNote = `Turn ${turnNum} (${entriesToShow.length} entry)`;
        if (entriesToShow.length === 0) { message.reply(`📜 Không có log nào cho Turn ${turnNum} (hiện đang ở Turn ${encounter.turnNumber ?? 1}).`); return; }
      } else {
        const distinctTurns = [...new Set(fullLog.map(e => e.turn))]; // đã theo thứ tự thời gian (push tuần tự)
        const last5TurnNumbers = new Set(distinctTurns.slice(-5));
        entriesToShow = fullLog.filter(e => last5TurnNumbers.has(e.turn));
        headerNote = `5 turn gần nhất — dùng \`turn: N\` để xem turn cụ thể, \`turn: all\` để xem hết`;
      }
      // Build text, gộp theo Turn cho dễ đọc.
      const lines = [];
      let lastTurn = null;
      for (const entry of entriesToShow) {
        if (entry.turn !== lastTurn) { lines.push(`\n**── Turn ${entry.turn} ──**`); lastTurn = entry.turn; }
        const icon = getActionLogIcon(entry.type);
        for (const l of entry.lines) lines.push(`${icon} ${l}`);
      }
      const fullText = lines.join("\n").trim();
      // Cắt thành nhiều embed nếu vượt 4096 ký tự (giới hạn Discord) — cắt theo
      // DÒNG (không cắt giữa 1 dòng), mỗi embed tối đa ~3900 ký tự để có khoảng
      // đệm an toàn.
      const chunks = [];
      let current = "";
      for (const line of lines) {
        if ((current + "\n" + line).length > 3900) { chunks.push(current); current = line; }
        else current = current ? current + "\n" + line : line;
      }
      if (current) chunks.push(current);
      const embeds = chunks.map((c, i) => ({
        title: i === 0 ? `📜 Action Log — ${headerNote}` : `📜 Action Log (tiếp ${i + 1})`,
        description: c || "*(trống)*",
        color: 0x95a5a6,
      }));
      // Discord giới hạn 10 embed/message — nếu vượt, chỉ gửi 10 đầu kèm cảnh báo.
      if (embeds.length > 10) {
        message.reply({ content: `⚠️ Log quá dài (${embeds.length} phần) — chỉ hiện 10 phần đầu. Dùng \`turn: N\` để xem từng turn cụ thể thay vì \`all\`.`, embeds: embeds.slice(0, 10) });
      } else {
        message.reply({ embeds });
      }
      return;
    }

    // ── buff/debuff: thêm 1 dòng TỰ DO vào danh sách buff/debuff của 1 combatant
    // (enemy hoặc player) — KHÔNG tự tính/tự hết hạn (xem comment ở createCombatant).
    // target: có thể là key enemy, userId, hoặc "me" (chính người gõ lệnh).
    if (sub === "buff" || sub === "debuff") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const text = (kv["text"] ?? "").trim();
      if (!targetRaw || !text) {
        message.reply(`⚠️ Cú pháp: \`-encounter ${sub} target: <key/userId/me> text: <mô tả>\`\n> VD: \`-encounter buff target: me text: 3 Haste + 10% dmg slash\``);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const listKey = sub === "buff" ? "buffs" : "debuffs";
          resolved.combatant[listKey] = resolved.combatant[listKey] ?? [];
          resolved.combatant[listKey].push({ text, addedAt: Date.now() });
          appendActionLog(encounter, `${sub === "buff" ? "🟢" : "🔴"} ${resolved.label}: ${sub === "buff" ? "+buff" : "+debuff"} "${text}"`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ Đã thêm ${sub === "buff" ? "🟢 buff" : "🔴 debuff"} cho ${resolved.label}: "${text}"`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // -encounter setstatus — GM SET SỐ CỤ THỂ cho 10 status Nhóm 1 (khác buff/
    // debuff vốn chỉ TEXT tự do, KHÔNG ảnh hưởng số liệu thật) — CỘNG THÊM (không
    // set tuyệt đối) vào giá trị hiện có, cap đúng theo luật từng status. Theo
    // yêu cầu trực tiếp: "50 status đó cũng phải tự động tracking để cho giống 1
    // game đấy" — đây là lệnh GM dùng để ÁP các status này lên combatant trong
    // trận thật (trước đó CHỈ có field+decay+công thức tính, HOÀN TOÀN chưa có
    // cách nào set chúng vào combat).
    if (sub === "setstatus") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const STATUS_CAPS = {
        fragile: 25, attackpowerup: 10, attackpowerdown: 10, defenseup: 20, defensedown: 20,
        clashattackboost: 8, unopposedattackboost: 5, protection: 20, regen: 99, chargeshield: 20,
        paralyze: 99,
        diceup: 99, dicedown: 99, smoke: 15, vengeancemark: 10, nails: 99, redplumblossom: 99, freeble: 5,
        borrowedtime: 2, fairy: 30,
        tremoreverlasting: TREMOR_VARIANT_MAX, tremorfracture: TREMOR_VARIANT_MAX, tremorreverb: TREMOR_VARIANT_MAX, tremordecay: TREMOR_VARIANT_MAX, tremorchain: TREMOR_VARIANT_MAX,
        spectrofrazzle: SPECTRO_FRAZZLE_MAX,
        gazeawe: GAZE_AWE_MAX, contempt: CONTEMPT_MAX, gazeofcontempt: GAZE_AWE_MAX,
        haouflame: HAOU_MAX, haoubleed: HAOU_MAX, haoutremor: HAOU_MAX, haourupture: HAOU_MAX, haousinking: HAOU_MAX,
        hemorrhage: HEMORRHAGE_MAX,
      };
      const STATUS_FIELD_MAP = {
        fragile: "fragile", attackpowerup: "attackPowerUp", attackpowerdown: "attackPowerDown",
        defenseup: "defenseUp", defensedown: "defenseDown", clashattackboost: "clashAttackBoost",
        unopposedattackboost: "unopposedAttackBoost", protection: "protection", regen: "regen",
        chargeshield: "chargeShieldStack",
        paralyze: "paralyze",
        diceup: "diceUp", dicedown: "diceDown", smoke: "smoke", vengeancemark: "vengeanceMark",
        nails: "nails", redplumblossom: "redPlumBlossom", freeble: "freeble",
        borrowedtime: "borrowedTime", fairy: "fairy",
        tremoreverlasting: "tremorEverlasting", tremorfracture: "tremorFracture", tremorreverb: "tremorReverb",
        tremordecay: "tremorDecay", tremorchain: "tremorChain",
        spectrofrazzle: "spectroFrazzle",
        gazeawe: "gazeAwe", contempt: "contempt", gazeofcontempt: "gazeOfContempt",
        haouflame: "haouFlame", haoubleed: "haouBleed", haoutremor: "haouTremor", haourupture: "haouRupture", haousinking: "haouSinking",
        hemorrhage: "hemorrhage",
      };
      const entries = Object.keys(STATUS_CAPS).filter(k => kv[k] !== undefined).map(k => ({ key: k, raw: kv[k] }));
      if (!targetRaw || entries.length === 0) {
        message.reply(`⚠️ Cú pháp: \`-encounter setstatus target: <key/userId/me> <status>: <số>\` (CỘNG THÊM vào giá trị hiện có)\n> Status hợp lệ: ${Object.keys(STATUS_CAPS).join("/")}\n> VD: \`-encounter setstatus target: mo fragile: 5\``);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          // Gaze[Awe]/Contempt (xác nhận trực tiếp): cần biết "kẻ đã gắn nó" — dùng
          // param riêng `source:` (key enemy hoặc mention player), KHÔNG nằm trong
          // STATUS_CAPS (không phải 1 giá trị số cộng dồn như status khác).
          const sourceRaw = (kv["source"] ?? "").trim();
          let sourceId = null;
          if (sourceRaw) {
            const sourceEnemyKey = normalizeEnemyKey(sourceRaw);
            sourceId = encounter.enemies[sourceEnemyKey] ? sourceEnemyKey : sourceRaw.replace(/[<@!>]/g, "");
          }
          const changes = [];
          for (const { key, raw } of entries) {
            const amount = parseInt(raw, 10);
            if (!Number.isFinite(amount)) throw new Error(`\`${key}:\` phải là số.`);
            // Gaze of Contempt (xác nhận trực tiếp): "Không thể nhận Gaze of
            // Contempt khi đang có Contempt of the Gaze."
            if (key === "gazeofcontempt" && amount > 0 && resolved.combatant.contemptOfTheGaze) {
              throw new Error(`${resolved.label} đang có Contempt of the Gaze — không thể nhận thêm Gaze of Contempt lúc này.`);
            }
            const field = STATUS_FIELD_MAP[key];
            const cap = STATUS_CAPS[key];
            const before = resolved.combatant[field] ?? 0;
            resolved.combatant[field] = Math.max(0, Math.min(cap, before + amount));
            // Gaze[Awe]/Contempt: gán sourceId ("kẻ đã gắn") mỗi lần CỘNG THÊM stack
            // mới — bắt buộc phải có `source:` nếu đang thêm mới (amount > 0).
            if ((key === "gazeawe" || key === "contempt") && amount > 0) {
              if (!sourceId) throw new Error(`Dùng "${key}:" cần kèm "source: <key enemy hoặc mention player>" để biết ai là "kẻ đã gắn".`);
              resolved.combatant[key === "gazeawe" ? "gazeAweSourceId" : "contemptSourceId"] = sourceId;
            }
            // Protection có Duration 2-turn RIÊNG (protectionTurnsLeft) — set/refresh
            // về 2 mỗi lần CỘNG THÊM stack mới (không cộng dồn duration, chỉ refresh).
            if (key === "protection" && amount > 0) resolved.combatant.protectionTurnsLeft = 2;
            // Borrowed Time: "tồn tại 3 turn" — set/refresh Duration mỗi lần cộng stack mới.
            if (key === "borrowedtime" && amount > 0) resolved.combatant.borrowedTimeTurnsLeft = 3;
            // Fairy: "biến mất khi hiệu lực đủ 2 Turn" — set/refresh Duration.
            if (key === "fairy" && amount > 0) resolved.combatant.fairyTurnsLeft = 2;
            // Hemorrhage: GM tự gán tay qua setstatus cũng tính là "đã áp trong
            // turn này" — nhất quán với đường tự động (commit handler khi Bleed
            // mới thực sự được áp), tránh bị reset ngay endturn kế tiếp.
            if (key === "hemorrhage" && amount > 0) resolved.combatant.hemorrhageAppliedThisTurn = true;
            // Spectro Frazzle (xác nhận trực tiếp): "Mỗi 1 stack giảm 10 Stamina và
            // gây 1 Bind... Nếu địch đang Stagger hoặc 0 Stamina thì lưu phần thừa,
            // nhân đôi, giảm khi hồi lại Stamina" — áp dụng NGAY lúc gán stack MỚI
            // (không đợi Tremor Burst nào — "không cần Tremor Burst" theo đúng mô
            // tả gốc), không phải lúc combat hit nào.
            if (key === "spectrofrazzle" && amount > 0) {
              resolved.combatant.bind = Math.min(20, (resolved.combatant.bind ?? 0) + amount);
              const staLoss = amount * 10;
              if (resolved.combatant.staggered || resolved.combatant.currentStamina <= 0) {
                resolved.combatant.spectroFrazzlePendingLoss = (resolved.combatant.spectroFrazzlePendingLoss ?? 0) + staLoss * 2;
              } else if (resolved.combatant.currentStamina < staLoss) {
                const shortfall = staLoss - resolved.combatant.currentStamina;
                resolved.combatant.currentStamina = 0;
                resolved.combatant.spectroFrazzlePendingLoss = (resolved.combatant.spectroFrazzlePendingLoss ?? 0) + shortfall * 2;
                checkStaggerPanic(resolved.combatant);
              } else {
                resolved.combatant.currentStamina -= staLoss;
                checkStaggerPanic(resolved.combatant);
              }
            }
            changes.push(`${key}: ${before} → **${resolved.combatant[field]}**`);
          }
          appendActionLog(encounter, `📊 ${resolved.label}: setstatus ${changes.join(", ")}`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ ${resolved.label}: ${changes.join(", ")}`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "setflag") {
      // Status DẠNG FLAG (có/không, KHÔNG stack số) — khác setstatus (số nguyên,
      // cộng dồn có cap). Airborne/Chains/Sizzling Wound/PerceptionBlockingMask/
      // BlackSilence (Struggling) đều là boolean theo mô tả gốc (không nêu số
      // stack/max nào).
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const FLAG_FIELD_MAP = {
        airborne: "airborne", chains: "chains", sizzlingwound: "sizzlingWound",
        perceptionblockingmask: "perceptionBlockingMask", blacksilence: "blackSilence",
        tremorscorch: "tremorScorch", tremorhemorrhage: "tremorHemorrhage",
        burningsensation: "burningSensation",
        contemptofthegaze: "contemptOfTheGaze",
        busyastribbie: "busyAsTribbie",
        timemoratorium: "timeMoratorium",
      };
      const entries = Object.keys(FLAG_FIELD_MAP).filter(k => kv[k] !== undefined).map(k => ({ key: k, raw: (kv[k] ?? "").trim().toLowerCase() }));
      if (!targetRaw || entries.length === 0) {
        message.reply(`⚠️ Cú pháp: \`-encounter setflag target: <key/userId/me> <flag>: on/off\`\n> Flag hợp lệ: ${Object.keys(FLAG_FIELD_MAP).join("/")}\n> VD: \`-encounter setflag target: mo airborne: on\`\n> Busy as Tribbie cần thêm \`source: <key enemy hoặc mention player>\` để biết "người buff nó".`);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const sourceRaw = (kv["source"] ?? "").trim();
          const changes = [];
          for (const { key, raw } of entries) {
            if (raw !== "on" && raw !== "off") throw new Error(`\`${key}:\` phải là "on" hoặc "off".`);
            const field = FLAG_FIELD_MAP[key];
            resolved.combatant[field] = raw === "on";
            // Chains: "(1 Turn)" — set Duration khi bật.
            if (key === "chains" && raw === "on") resolved.combatant.chainsTurnsLeft = 1;
            // Time Moratorium: "sau 3 turn" — set Duration khi bật.
            if (key === "timemoratorium" && raw === "on") resolved.combatant.timeMoratoriumTurnsLeft = 3;
            // Busy as Tribbie: cần source: để biết "người buff nó" (ai bị FUA phản
            // công) — GIẢ ĐỊNH FUA nhắm vào chính target (xem combatant-factory.js).
            if (key === "busyastribbie" && raw === "on") {
              if (!sourceRaw) throw new Error(`Dùng "busyastribbie: on" cần kèm "source: <key enemy hoặc mention player>".`);
              const sourceEnemyKey = normalizeEnemyKey(sourceRaw);
              resolved.combatant.busyAsTribbieSourceId = encounter.enemies[sourceEnemyKey] ? sourceEnemyKey : sourceRaw.replace(/[<@!>]/g, "");
            }
            changes.push(`${key}: **${raw}**`);
          }
          appendActionLog(encounter, `📊 ${resolved.label}: setflag ${changes.join(", ")}`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ ${resolved.label}: ${changes.join(", ")}`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "reload") {
      // Ammo system (xác nhận trực tiếp): "Nhận được thông qua hành động Reload, 1
      // turn có thể Reload bao nhiêu tùy ý, nhưng sẽ tiêu hao số đạn trong
      // Inventory của bạn mỗi khi Reload." — chuyển đạn từ Inventory (persistent,
      // profileData.items) sang stack Encounter (combatant field), KHÔNG giới hạn
      // số lần gọi/turn (mỗi lần tự trừ đúng Inventory hiện có).
      const kv = parseKeyValues(rest);
      const amount = parseInt(kv["amount"] ?? "1", 10);
      const typeRaw = (kv["type"] ?? "ammo").trim().toLowerCase();
      const AMMO_ITEM_MAP = { ammo: { item: "Ammo", field: "ammo" }, frost: { item: "Frost Ammo", field: "frostAmmo" }, incendiary: { item: "Incendiary Ammo", field: "incendiaryAmmo" } };
      const ammoType = AMMO_ITEM_MAP[typeRaw];
      if (!Number.isFinite(amount) || amount < 1 || !ammoType) {
        message.reply(`⚠️ Cú pháp: \`-encounter reload amount: <số> type: ammo/frost/incendiary\` (mặc định type: ammo nếu bỏ trống)\n> VD: \`-encounter reload amount: 5\` hoặc \`-encounter reload amount: 2 type: frost\``);
        return;
      }
      try {
        // Bước 1: trừ Inventory (persistent, lock RIÊNG theo user — KHÔNG lồng
        // trong lock encounter để tránh deadlock nếu 2 lock khác thứ tự ở nơi khác).
        let actualAmount = 0;
        await withLock(message.author.id, async () => {
          const { data: profileData, slot } = await getPlayerDataWithSlot(message.author.id);
          const owned = profileData.items?.[ammoType.item] ?? 0;
          actualAmount = Math.min(amount, owned);
          if (actualAmount <= 0) throw new Error(`Không còn **${ammoType.item}** nào trong Inventory để Reload.`);
          profileData.items[ammoType.item] = owned - actualAmount;
          if (profileData.items[ammoType.item] <= 0) delete profileData.items[ammoType.item];
          await savePlayerData(message.author.id, profileData, slot);
        });
        // Bước 2: cộng vào stack Encounter (lock riêng của encounter).
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const player = encounter.players[message.author.id];
          if (!player) throw new Error("Bạn chưa tham gia encounter này.");
          const before = player[ammoType.field] ?? 0;
          player[ammoType.field] = Math.min(AMMO_MAX, before + actualAmount);
          appendActionLog(encounter, `🔫 <@${message.author.id}>: reload ${ammoType.item} +${actualAmount} (${before} → ${player[ammoType.field]})`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`🔫 Reload **${ammoType.item}**: +${actualAmount} (từ Inventory) → đang có **${player[ammoType.field]}** trong Encounter.`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "unbuff" || sub === "undebuff") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const index = parseInt(kv["index"] ?? "", 10);
      if (!targetRaw || !Number.isFinite(index) || index < 1) {
        message.reply(`⚠️ Cú pháp: \`-encounter ${sub} target: <key/userId/me> index: <số thứ tự trong -encounter status, bắt đầu từ 1>\``);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const listKey = sub === "unbuff" ? "buffs" : "debuffs";
          const list = resolved.combatant[listKey] ?? [];
          if (index > list.length) throw new Error(`${resolved.label} chỉ có ${list.length} ${listKey === "buffs" ? "buff" : "debuff"} — không có #${index}.`);
          const removed = list.splice(index - 1, 1)[0];
          appendActionLog(encounter, `${listKey === "buffs" ? "🟢" : "🔴"} Đã xoá ${listKey === "buffs" ? "buff" : "debuff"} của ${resolved.label}: "${removed.text}"`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ Đã xoá ${listKey === "buffs" ? "🟢 buff" : "🔴 debuff"} #${index} của ${resolved.label}: "${removed.text}"`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── healinjury: GM xoá 1 chấn thương đã chữa khỏi (admin only — chấn thương là
    // hậu quả thật trong game, chỉ GM mới xác nhận đã chữa lành).
    if (sub === "healinjury") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới xoá được chấn thương."); return; }
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const index = parseInt(kv["index"] ?? "", 10);
      if (!targetRaw || !Number.isFinite(index) || index < 1) {
        message.reply("⚠️ Cú pháp: `-encounter healinjury target: <key/userId> index: <số thứ tự trong -encounter status, bắt đầu từ 1>`");
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, "");
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const list = resolved.combatant.injuries ?? [];
          if (index > list.length) throw new Error(`${resolved.label} chỉ có ${list.length} chấn thương — không có #${index}.`);
          const removed = list.splice(index - 1, 1)[0];
          restoreInjuryMaxHp(resolved.combatant, removed);
          if (resolved.type === "player") {
            try {
              const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(targetId);
              injSyncData.injuries = [...(resolved.combatant.injuries ?? [])];
              await savePlayerData(targetId, injSyncData, injSyncSlot);
            } catch { /* không chặn lệnh chính nếu sync lỗi */ }
          }
          appendActionLog(encounter, `🩹 Đã chữa khỏi chấn thương của ${resolved.label}: "${removed}"`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ Đã chữa khỏi chấn thương #${index} của ${resolved.label}: "${removed}"`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }


    if (sub === "end") {
      const encounter = await getEncounter(encChannelId);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      if (!isAdmin && message.author.id !== encounter.gmId) { message.reply("⚠️ Chỉ GM tạo encounter này (hoặc admin khác) mới được kết thúc."); return; }
      // BUG ĐÃ SỬA: trước đây xoá actionLog VĨNH VIỄN ngay khi end, không có cách
      // nào lấy lại lịch sử trận đấu sau đó — giờ tự động gửi TOÀN BỘ actionLog
      // (giống `-encounter log turn: all`) NGAY TRƯỚC KHI xoá, để GM còn cơ hội lưu
      // lại nếu cần (copy/paste, hoặc Discord tự lưu lịch sử chat).
      const fullLog = encounter.actionLog ?? [];
      if (fullLog.length > 0) {
        const lines = [];
        let lastTurn = null;
        for (const entry of fullLog) {
          if (entry.turn !== lastTurn) { lines.push(`\n**── Turn ${entry.turn} ──**`); lastTurn = entry.turn; }
          const icon = getActionLogIcon(entry.type);
          for (const l of entry.lines) lines.push(`${icon} ${l}`);
        }
        const chunks = [];
        let current = "";
        for (const line of lines) {
          if ((current + "\n" + line).length > 3900) { chunks.push(current); current = line; }
          else current = current ? current + "\n" + line : line;
        }
        if (current) chunks.push(current);
        const logEmbeds = chunks.slice(0, 10).map((c, i) => ({
          title: i === 0 ? `📜 Toàn bộ Action Log — ${encounter.name} (trước khi kết thúc)` : `📜 Action Log (tiếp ${i + 1})`,
          description: c || "*(trống)*",
          color: 0x95a5a6,
        }));
        await message.channel.send({ embeds: logEmbeds }).catch(() => {});
      }
      await deleteEncounter(encChannelId);
      message.reply(`✅ Đã kết thúc encounter **${encounter.name}**.${fullLog.length > 0 ? ` (Đã gửi lại toàn bộ ${fullLog.length} entry log ở trên trước khi xoá.)` : ""}`);
      return;
    }

    if (sub === "endturn") {
      try {
        const { encounter, shroudedNotes } = await performEndTurn(encChannelId, message.author.id, isAdmin);
        await message.reply({
          content: `🔄 **Hết turn** — hồi ${ENCOUNTER_STAMINA_REGEN_PER_TURN} Stamina (trừ ai đang Stagger), đếm ngược Stagger/Panic.` +
            (shroudedNotes.length > 0 ? `\n> ${shroudedNotes.join(", ")}` : "") +
            `\n> 🎲 Thứ tự Turn mới:\n${buildTurnOrderText(encounter)}`,
          embeds: [buildEncounterBoardEmbed(encounter)],
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── hit: dùng Page/Skill (Light cost) lên 1 hoặc nhiều enemy (AOE qua target:
    // mo,arnold hoặc target: all) — KHÔNG tự trừ Stamina (Page tốn Light, tự khai
    // báo riêng). Thêm vào hàng chờ pendingActions, KHÔNG còn confirm ngay từng cái.
    if (sub === "hit") {
      const kv = parseKeyValues(rest);
      const dmgStr = kv["dmg"] ?? "";
      const targetStr = kv["target"] ?? "";
      if (!dmgStr.trim() || !targetStr.trim()) {
        message.reply(
          "⚠️ Cú pháp: `-encounter hit target: <key hoặc key1,key2 hoặc all> dmg: <công thức>`\n" +
          "> VD: `-encounter hit target: mo dmg: 50x2B+2Sinking res: 1.5xB bonus: 20`\n" +
          "> VD AOE: `-encounter hit target: mo,arnold dmg: 30Bx2`\n" +
          "> Tùy chọn `skill: <tên skill>` (tự roll thật + check cooldown + tự tính Emotion Coin) hoặc `ref: <link message>` (tham chiếu roll đã có) để GM dễ verify."
        );
        return;
      }
      const bonusPct = parseFloat((kv["bonus"] ?? "0").replace("%", ""));
      const sanityBonusPct = parseFloat((kv["sanitybonus"] ?? "0").replace("%", ""));
      // KHÔNG default "1" — để undefined nếu người dùng không gõ critmul:, vậy
      // doPlayerHit mới biết đây là "không gõ tay" và rơi về perkCtx.critMul (mặc
      // định 1.3x đúng luật) thay vì ép cứng về 1 (bug cũ, xem comment ở doPlayerHit).
      const critMul = kv["critmul"] ? parseFloat(kv["critmul"].replace("x", "")) : undefined;
      const diceMul = parseFloat((kv["dicemul"] ?? "1").replace("x", ""));
      if (isNaN(bonusPct) || isNaN(sanityBonusPct) || (critMul !== undefined && isNaN(critMul)) || isNaN(diceMul)) {
        message.reply("❌ bonus/sanitybonus/critmul/dicemul phải là số.");
        return;
      }
      const critDivStr = (kv["critdiv"] ?? "").trim().toLowerCase();
      let critDiv = 0;
      if (critDivStr === "yes" || critDivStr === "true" || critDivStr === "1") critDiv = 2;
      else { const p = parseFloat(critDivStr); if (!isNaN(p) && p > 1) critDiv = p; }

      try {
        const { embed, skillRollEmbed } = await doPlayerHit(encChannelId, message.author.id, message.author.toString(), dmgStr, targetStr, {
          resStr: kv["res"] ?? "", drStr: kv["dr"] ?? "", bonusPct, sanityBonusPct, critMul, diceMul, critDiv,
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"], tags: kv["tags"],
        });
        await message.reply({ embeds: skillRollEmbed ? [skillRollEmbed, embed] : [embed] });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── attack: M1 (đánh thường) lên 1 hoặc nhiều enemy — tự TÍNH Stamina cần, trừ
    // thật lúc GM confirmall (không trừ lúc declare — reject không mất Stamina oan).
    if (sub === "attack") {
      const kv = parseKeyValues(rest);
      const dmgStr = kv["dmg"] ?? "";
      const targetStr = kv["target"] ?? "";
      // "volleys:" — dành riêng cho Eye Of Horus (mô hình mới: N = số volley TỰ
      // CHỌN bắn ngay trong hành động này, xem doPlayerAttack) — cho phép bỏ trống
      // dmg: nếu có volleys: (dmgStr sẽ được TỰ ĐỘNG xây dựng từ N).
      if ((!dmgStr.trim() && !kv["volleys"]) || !targetStr.trim()) {
        message.reply(
          "⚠️ Cú pháp: `-encounter attack target: <key hoặc key1,key2 hoặc all> dmg: <công thức>` (M1 — tự trừ Stamina theo vũ khí của bạn).\n" +
          "> VD: `-encounter attack target: mo dmg: 20B`\n" +
          "> Đang dùng Eye Of Horus? Dùng `volleys: <N>` thay cho `dmg:` (VD: `-encounter attack target: mo volleys: 4`).\n" +
          "> Tùy chọn `skill: <tên skill>` hoặc `ref: <link message>` để GM dễ verify."
        );
        return;
      }
      try {
        const { embed, skillRollEmbed } = await doPlayerAttack(encChannelId, message.author.id, message.author.toString(), dmgStr, targetStr, {
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"], tags: kv["tags"], volleys: kv["volleys"], ammotype: kv["ammotype"],
        });
        await message.reply({ embeds: skillRollEmbed ? [skillRollEmbed, embed] : [embed] });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── enemyattack: GM cho 1 enemy đánh 1 hoặc nhiều player (AOE qua target:
    // <id1>,<id2> hoặc target: all).
    if (sub === "enemyattack") {
      const kv = parseKeyValues(rest);
      const enemyKey = kv["key"] ?? "";
      const dmgStr = kv["dmg"] ?? "";
      const targetStr = kv["target"] ?? (message.mentions.users.first()?.id ?? "");
      if (!enemyKey.trim() || !dmgStr.trim() || !targetStr.trim()) {
        message.reply(
          "⚠️ Cú pháp: `-encounter enemyattack key: <enemy key> target: <@player hoặc all> dmg: <công thức>`\n" +
          "> VD: `-encounter enemyattack key: mo target: all dmg: 20x3P` (AOE cả party)\n" +
          "> Tùy chọn `skill: <tên skill>` hoặc `ref: <link message>`."
        );
        return;
      }
      try {
        const { embed, skillRollEmbed } = await doEnemyAttack(encChannelId, message.author.id, enemyKey, dmgStr, targetStr, {
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"], tags: kv["tags"],
        });
        await message.reply({ embeds: skillRollEmbed ? [skillRollEmbed, embed] : [embed] });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── followup: Follow-Up (Wrath, [10~14] Blunt + Airborne) HOẶC Pounce (Sloth,
    // [8~30] Blunt) — 2 perk LOẠI TRỪ NHAU (không ai có cả 2), điều kiện kích hoạt
    // GIỐNG NHAU: turn này đã tiêu ≥20 Stamina qua đánh thường, CHỈ 1 LẦN/turn.
    if (sub === "followup") {
      const kv = parseKeyValues(rest);
      const targetStr = kv["target"] ?? "";
      if (!targetStr.trim()) { message.reply("⚠️ Cú pháp: `-encounter followup target: <key/all>`"); return; }
      try {
        const { followupEmbed, hitEmbed } = await performFollowUp(encChannelId, message.author.id, message.author.toString(), targetStr);
        await message.reply({ embeds: [followupEmbed] });
        await message.channel.send({ embeds: [hitEmbed] });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── overcharge: Overcharged Vessel (Envy) — tiêu TOÀN BỘ Charge hiện tại (cần
    // ≥10), mỗi 10 Charge tiêu = +1 Dice Up và +5% Dmg trong 3 turn.
    if (sub === "overcharge") {
      try {
        const resultMsg = await performOvercharge(encChannelId, message.author.id);
        message.reply(resultMsg);
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── guard/evade: hành động phòng thủ CHUNG, dùng TỰ DO bao nhiêu lần cũng được
    // (chỉ giới hạn bởi Stamina còn lại) — KHÔNG giống V1 cũ (không "chặn N hit theo
    // vũ khí địch", không Parry roll d20). Mỗi lần dùng tốn Stamina NGAY (khác với
    // attack/hit — Stamina ở đây không cần GM duyệt vì không có số liệu dmg nào để
    // sai, chỉ là tự trừ tài nguyên bản thân), cộng 1 charge — charge bị TIÊU THỤ
    // lúc CONFIRM 1 đòn tấn công nhằm vào mình (xem comment ở encconfirmall handler).
    // Có key: thì GM dùng hộ cho 1 enemy (hiếm khi cần nhưng để đối xứng). Logic THẬT
    // nằm ở performGuardEvade (dùng chung với dropdown hành động — xem encmenu handler).
    if (sub === "guard" || sub === "evade") {
      const kv = parseKeyValues(rest);
      const enemyKeyRaw = (kv["key"] ?? "").trim();
      // GAP ĐÃ SỬA (xác nhận trực tiếp): cho phép chọn CỤ THỂ hit muốn che thay vì
      // chỉ tuần tự — VD `-encounter guard attacker: mo hits: 3,5`. Xem comment đầy
      // đủ ở performGuardEvade (encounter-actions.js).
      const attackerKeyRaw = (kv["attacker"] ?? "").trim();
      const hitsRaw = (kv["hits"] ?? "").trim();
      try {
        const resultMsg = await performGuardEvade(encChannelId, message.author.id, isAdmin, sub, enemyKeyRaw, attackerKeyRaw, hitsRaw);
        message.reply(resultMsg);
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── parry: 0 Sta, roll d20 NGAY — lưu vào parryRolls, so với roll của bên tấn
    // công lúc CONFIRM (không phải lúc declare, vì roll của bên tấn công chưa biết
    // được). Ngang điểm = parry THẮNG (luật: "cao hơn HOẶC NGANG"). Thua: -40 Sta +
    // ăn full dmg. Cũng áp WEAPON_DEFENSE_HITS như Guard/Evade cho M1. Logic THẬT
    // nằm ở performParry (dùng chung với dropdown — xem encmenu handler).
    if (sub === "parry") {
      const kv = parseKeyValues(rest);
      const enemyKeyRaw = (kv["key"] ?? "").trim();
      try {
        const resultMsg = await performParry(encChannelId, message.author.id, isAdmin, enemyKeyRaw);
        message.reply(resultMsg);
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── clash: so dice ĐẦU TIÊN của 2 skill (luôn lấy Dice đầu, theo luật) — ai cao
    // hơn thắng. Thắng: +10 Sanity +2 Emotion Coin. Thua: -10 Sanity -1 Coin. Huề:
    // +1 Coin mỗi bên, Sanity không đổi. Quyền clash theo thứ tự turn ("người đi
    // trước clash được người đi sau, không ngược lại — và có thể clash HỘ cho người
    // khác") — check qua encounter.turnOrder nếu ĐÃ roll (xem -encounter rollspeed);
    // nếu chưa roll thì bỏ qua check này (không ép phải roll Speed trước mới clash
    // được — Speed là tính năng riêng, không phải điều kiện bắt buộc của Clash).
    // ── shinmang: hi sinh 25 Sanity/turn (chặn nếu Sanity hiện tại ≤ -10) để nhận
    // Shin (-0.2x Res bản thân) + Mang (+10%/+10% mỗi vòng Dmg M1+skill trong turn,
    // True Dmg). CHỈ player có sở hữu Shin mới dùng được — kiểm qua unlockedPerks
    // có "Shin" (đặt tên khác Skill Tree thường để rõ đây là quyền sở hữu, không
    // phải perk tốn point — GM tự thêm qua -unlockskilltree nếu player sở hữu Shin).
    if (sub === "shinmang" || sub === "shin") {
      try {
        const resultMsg = await performShinMang(encChannelId, message.author.id);
        message.reply(resultMsg);
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── additem: mang 1 Consumable Item vào trận (tối đa 4 — luật "1 trận chỉ
    // được mang 4 item hồi phục") — CHỈ kiểm tra player ĐANG sở hữu đủ trong
    // inventory (chưa trừ thật, chỉ "đăng ký" sẽ mang) — trừ THẬT lúc -encounter
    // useitem. Có thể mang nhiều cái CÙNG TÊN (VD 2 Potion) miễn ≤4 slot tổng.
    if (sub === "additem") {
      const itemNameRaw = rest.trim();
      if (!itemNameRaw) { message.reply("⚠️ Cú pháp: `-encounter additem <tên item>` (tối đa 4 item/trận)."); return; }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const player = encounter.players[message.author.id];
          if (!player) throw new Error("Bạn chưa tham gia encounter này.");
          player.consumablesLoadout = player.consumablesLoadout ?? [];
          if (player.consumablesLoadout.length >= 4) throw new Error("Đã mang đủ 4 item — không thể mang thêm (luật: tối đa 4 item/trận).");
          const profileData = await getPlayerData(message.author.id);
          const itemName = findItem(itemNameRaw) ?? (profileData.items?.[itemNameRaw] > 0 ? itemNameRaw : null);
          if (!itemName) throw new Error(`Không tìm thấy item "${itemNameRaw}" trong inventory của bạn.`);
          const ownedCount = profileData.items?.[itemName] ?? 0;
          const alreadyBrought = player.consumablesLoadout.filter(n => n === itemName).length;
          if (alreadyBrought >= ownedCount) throw new Error(`Bạn chỉ có ${ownedCount}× **${itemName}** trong inventory — đã mang đủ số đó vào trận rồi.`);
          player.consumablesLoadout.push(itemName);
          appendActionLog(encounter, `🎒 <@${message.author.id}> mang **${itemName}** vào trận (${player.consumablesLoadout.length}/4).`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`🎒 Đã mang **${itemName}** vào trận (${player.consumablesLoadout.length}/4 slot item).`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "useitem") {
      const itemNameRaw = rest.trim();
      if (!itemNameRaw) { message.reply("⚠️ Cú pháp: `-encounter useitem <tên item>` (chỉ item đã mang vào trận qua `-encounter additem`, tối đa 1 lần/turn)."); return; }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const player = encounter.players[message.author.id];
          if (!player) throw new Error("Bạn chưa tham gia encounter này.");
          if (player.usedItemThisTurn) throw new Error("Đã dùng 1 item trong turn này rồi — chỉ được dùng 1 lần/turn.");
          const itemName = findItem(itemNameRaw) ?? itemNameRaw;
          const idx = (player.consumablesLoadout ?? []).findIndex(n => n.toLowerCase() === itemName.toLowerCase());
          if (idx === -1) throw new Error(`"${itemNameRaw}" không có trong số item đã mang vào trận — dùng \`-encounter additem\` trước (xem hiện tại bằng \`-encounter status\`).`);
          const actualName = player.consumablesLoadout[idx];
          // K-Corp Ampule — item ĐẶC BIỆT DUY NHẤT chữa được injury TRONG encounter
          // (xác nhận trực tiếp từ GM): "Lập tức hồi 100% Máu. Chữa toàn bộ Injuries
          // ngay lập tức. Dùng 2 cái liên tục trong 1 Encounter sẽ gây chết ngay lập
          // tức (cd 2 turn). Giá: 1 triệu Ahn." — CD 2 turn RIÊNG của item này (khác
          // "usedItemThisTurn" chung 1/turn cho MỌI item), và dùng LẦN THỨ 2 trong
          // CÙNG 1 encounter (dù đã hết CD hay chưa) → CHẾT NGAY (Death Penalty/
          // Permadeath như chết bình thường), KHÔNG hồi máu/chữa gì nữa.
          const isKCorpAmpule = actualName.toLowerCase() === "k-corp ampule";
          // 4 item consumable đơn giản khác (xác nhận trực tiếp từ GM, giá Ahn chỉ
          // mang tính THAM KHẢO — hệ thống hiện chưa có cơ chế "mua" item bằng Ahn,
          // items chỉ được GM cấp qua -setplayer items:, nên KHÔNG trừ Ahn ở đây).
          const isChuoi = actualName.toLowerCase() === "chuối";
          const isTao = actualName.toLowerCase() === "táo";
          const isDuaHau = actualName.toLowerCase() === "dưa hấu";
          const isMedkit = actualName.toLowerCase() === "medkit";
          if (isKCorpAmpule && (player.kCorpAmpuleCooldownLeft ?? 0) > 0) {
            throw new Error(`K-Corp Ampule đang trong CD — còn ${player.kCorpAmpuleCooldownLeft} turn nữa mới dùng lại được.`);
          }
          const { data: profileData, slot } = await getPlayerDataWithSlot(message.author.id);
          const owned = profileData.items?.[actualName] ?? 0;
          if (owned < 1) throw new Error(`Inventory không còn **${actualName}** để dùng (đã bị tiêu/mất từ trước).`);
          profileData.items[actualName] = owned - 1;
          if (profileData.items[actualName] <= 0) delete profileData.items[actualName];
          await savePlayerData(message.author.id, profileData, slot);
          player.consumablesLoadout.splice(idx, 1);
          player.usedItemThisTurn = true;
          let effectNote = "";
          if (isKCorpAmpule) {
            player.kCorpAmpuleUsesThisEncounter = (player.kCorpAmpuleUsesThisEncounter ?? 0) + 1;
            player.kCorpAmpuleCooldownLeft = 2;
            if (player.kCorpAmpuleUsesThisEncounter >= 2) {
              // Dùng lần 2 trong CÙNG encounter → CHẾT NGAY, bất kể HP/injury hiện
              // tại — dùng CHUNG applyDeathPenalty với cái chết combat bình thường.
              const wasAliveBeforeKCorp = player.currentHp > 0;
              player.currentHp = 0;
              if (wasAliveBeforeKCorp) {
                for (const otherPid of Object.keys(encounter.players)) {
                  if (otherPid === message.author.id) continue;
                  applyEmotionDelta(encounter.players[otherPid], 5);
                }
                const deathNote = await applyDeathPenalty(encounter, message.author.id);
                effectNote = ` ☠️ **DÙNG LẦN 2 TRONG CÙNG ENCOUNTER — CHẾT NGAY LẬP TỨC!**${deathNote}`;
              }
            } else {
              // Lần dùng ĐẦU TIÊN — hồi đầy HP + chữa TOÀN BỘ injury (kể cả maxHp
              // penalty từ Gãy Xương/Vết thương lớn được khôi phục đầy đủ).
              for (const inj of player.injuries ?? []) restoreInjuryMaxHp(player, inj);
              player.injuries = [];
              player.currentHp = player.maxHp;
              // Sync injury đã chữa sạch về profile NGAY (giống mọi lần chữa injury
              // khác trong trận).
              try {
                const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(message.author.id);
                injSyncData.injuries = [];
                await savePlayerData(message.author.id, injSyncData, injSyncSlot);
              } catch { /* không chặn action chính nếu sync lỗi */ }
              effectNote = ` 💊 Hồi ĐẦY HP (${player.currentHp}/${player.maxHp}) + Chữa TOÀN BỘ injury! (CD 2 turn — dùng lần 2 trong trận này sẽ CHẾT NGAY.)`;
            }
          } else if (isChuoi) {
            // Chuối: hồi phục 10 HP, cap tại maxHp.
            const before = player.currentHp;
            player.currentHp = Math.min(player.maxHp, player.currentHp + 10);
            effectNote = ` 🍌 +${(player.currentHp - before).toFixed(0)} HP (${player.currentHp}/${player.maxHp}).`;
          } else if (isTao) {
            // Táo: giảm 1 Dmg/hit phải nhận tới hết turn hiện tại — set cờ, logic
            // trừ dmg THẬT nằm ở nhánh xử lý damage (xem comment "Táo (item)" gần
            // target.currentHp -= finalDmg).
            player.appleDmgReductionActive = true;
            effectNote = ` 🍎 Giảm 1 Dmg/hit phải nhận tới hết turn này.`;
          } else if (isDuaHau) {
            // Dưa hấu: hồi phục 20 Stamina, cap tại maxStamina.
            const before = player.currentStamina;
            player.currentStamina = Math.min(player.maxStamina, player.currentStamina + 20);
            effectNote = ` 🍉 +${(player.currentStamina - before).toFixed(0)} Stamina (${player.currentStamina}/${player.maxStamina}).`;
          } else if (isMedkit) {
            // Medkit: CHỈ chữa chấn thương NHẸ (Gãy tay/Gãy chân/Gãy Xương) —
            // KHÔNG chữa chấn thương NẶNG (Mất tay/Mất Chân/Vết thương lớn), khác
            // hẳn K-Corp Ampule (chữa TẤT CẢ). Chữa TOÀN BỘ chấn thương nhẹ đang
            // mang cùng lúc (không chỉ 1 cái).
            const before = [...(player.injuries ?? [])];
            const healedMinor = before.filter(inj => MINOR_INJURIES.some(m => inj.startsWith(m)));
            if (healedMinor.length === 0) {
              effectNote = ` 🩹 Không có chấn thương nhẹ nào để chữa (Medkit KHÔNG chữa được chấn thương nặng).`;
            } else {
              player.injuries = before.filter(inj => !MINOR_INJURIES.some(m => inj.startsWith(m)));
              for (const inj of healedMinor) restoreInjuryMaxHp(player, inj);
              try {
                const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(message.author.id);
                injSyncData.injuries = [...player.injuries];
                await savePlayerData(message.author.id, injSyncData, injSyncSlot);
              } catch { /* không chặn action chính nếu sync lỗi */ }
              effectNote = ` 🩹 Đã chữa ${healedMinor.length} chấn thương nhẹ: ${healedMinor.join(", ")}. (Chấn thương nặng KHÔNG được chữa bởi Medkit.)`;
            }
          }
          appendActionLog(encounter, `🧪 <@${message.author.id}> dùng **${actualName}**.${effectNote}`);
          await saveEncounter(encChannelId, encounter);
          const isKnownItemWithEffect = isKCorpAmpule || isChuoi || isTao || isDuaHau || isMedkit;
          message.reply(`🧪 ${message.author} đã dùng **${actualName}**!${effectNote}${!isKnownItemWithEffect ? " (Trừ khỏi inventory — hiệu ứng hồi phục cụ thể do GM tự xác định/narrate, hệ thống chỉ enforce giới hạn mang/dùng.)" : ""}`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── manifestego: kích hoạt Manifest E.G.O — cần Emotion Level ≥1 đang active
    // (Duration = Level×3 turn — Lv1=3/Lv2=6 xác nhận trực tiếp, Lv3+ suy theo cùng
    // quy luật). -30 Sanity lúc kích hoạt. CD 5 turn SAU KHI hết hiệu lực (không
    // phải sau khi DÙNG — nếu vẫn đang active thì dùng lại = reset Duration, không
    // vào CD). Comeback Time (perk): lần ĐẦU TIÊN trong trận → +25% Max HP. Logic
    // THẬT nằm ở performManifestEgo (dùng chung với dropdown).
    if (sub === "manifestego") {
      try {
        const resultMsg = await performManifestEgo(encChannelId, message.author.id);
        message.reply(resultMsg);
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // -encounter bossmenu key: <enemy> — hiện dropdown điều khiển boss (theo yêu
    // cầu trực tiếp: "phần encounter của boss cần 1 lệnh UI"). Chỉ GM/admin dùng
    // được (điều khiển enemy vốn đã giới hạn GM-only trong mọi lệnh liên quan).
    if (sub === "gmpanel") {
      // GM Control Panel (xác nhận trực tiếp): bảng điều khiển TỔNG QUÁT cho GM —
      // chọn enemy từ dropdown, sau đó hiện panel Attack/Guard/Evade/Parry (tái
      // dùng NGUYÊN buildBossActionPanel đã có sẵn cho bossmenu). Có thể gọi từ
      // kênh GM riêng (sau khi đã `-encounter linkgm`) hoặc ngay tại kênh encounter.
      try {
        const encounter = await getEncounter(encChannelId);
        if (!encounter) throw new Error("Channel này chưa có encounter nào — dùng `-encounter start` trước (hoặc `-encounter linkgm` nếu đang ở kênh điều khiển riêng).");
        const isAdmin = ADMIN_IDS.has(message.author.id);
        if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM/admin mới mở được bảng điều khiển.");
        const aliveEnemies = Object.entries(encounter.enemies).filter(([, e]) => e.currentHp > 0);
        if (aliveEnemies.length === 0) throw new Error("Không có enemy nào còn sống — dùng `-encounter addenemy` trước.");
        const options = aliveEnemies.map(([ekey, e]) =>
          new StringSelectMenuOptionBuilder().setLabel(`👹 ${e.name} (${ekey}) — ${e.currentHp}/${e.maxHp} HP`).setValue(ekey)
        );
        message.reply({
          embeds: [{
            title: `🎛️ Bảng điều khiển GM — ${encounter.name}`,
            description: `Turn **${encounter.turnNumber ?? 1}** | ${aliveEnemies.length} enemy còn sống.\nChọn enemy muốn điều khiển:`,
            color: 0x9b59b6,
          }],
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`gmpanelselect:${encChannelId}:${message.author.id}`)
                .setPlaceholder("Chọn enemy để điều khiển...")
                .addOptions(...options.slice(0, 25)),
            ),
            // Turn Order Enforcement UX (xác nhận trực tiếp): nút LUÔN sẵn có,
            // không cần đợi hết vòng turnOrder mới thấy — GM có thể chủ động kết
            // thúc sớm hoặc xem trạng thái bất cứ lúc nào từ bảng điều khiển.
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`encendturn:${encChannelId}:${encounter.gmId}`).setLabel("🔄 Kết thúc Turn").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`gmpanelstatus:${encChannelId}:${message.author.id}`).setLabel("📊 Xem trạng thái").setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }
    if (sub === "bossmenu") {
      const kv = parseKeyValues(rest);
      const enemyKeyRaw = (kv["key"] ?? "").trim();
      if (!enemyKeyRaw) {
        message.reply("⚠️ Cú pháp: `-encounter bossmenu key: <enemy>` (VD: `-encounter bossmenu key: mo`)");
        return;
      }
      try {
        const encounter = await getEncounter(encChannelId);
        if (!encounter) throw new Error("Channel này chưa có encounter nào.");
        const isAdmin = ADMIN_IDS.has(message.author.id);
        if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM/admin mới điều khiển được enemy.");
        const ekey = normalizeEnemyKey(enemyKeyRaw);
        const enemy = encounter.enemies[ekey];
        if (!enemy) throw new Error(`Không tìm thấy enemy "${enemyKeyRaw}" — dùng \`-encounter status\` để xem danh sách.`);
        message.reply({
          embeds: [{ title: `👹 Điều khiển: ${enemy.name} (${ekey})`, description: "Chọn hành động từ dropdown bên dưới.", color: 0xe74c3c }],
          components: buildBossActionPanel(encChannelId, ekey, message.author.id),
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }
    if (sub === "clash") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const mySkillRaw = (kv["skill"] ?? "").trim();
      const oppSkillRaw = (kv["oppskill"] ?? "").trim();
      const forRaw = (kv["for"] ?? "").trim(); // clash HỘ cho ai — mặc định là chính người gõ lệnh
      if (!targetRaw || !mySkillRaw || !oppSkillRaw) {
        message.reply(
          "⚠️ Cú pháp: `-encounter clash target: <key/userId đối thủ> skill: <skill của bên mình> oppskill: <skill của đối thủ>`\n" +
          "> Tùy chọn `for: <key/userId>` nếu clash HỘ cho người khác (mặc định là chính bạn).\n" +
          "> Bot tự roll CẢ 2 skill thật, so Dice đầu tiên — ai cao hơn thắng."
        );
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");

          const forId = forRaw ? (forRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(forRaw)] ? normalizeEnemyKey(forRaw) : forRaw.replace(/[<@!>]/g, ""))) : message.author.id;
          const forResolved = resolveCombatant(encounter, forId);
          if (!forResolved) throw new Error(`Không tìm thấy "${forRaw || "bạn"}" trong encounter.`);
          const targetId = encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, "");
          const targetResolved = resolveCombatant(encounter, targetId);
          if (!targetResolved) throw new Error(`Không tìm thấy đối thủ "${targetRaw}" trong encounter.`);

          // Quyền ưu tiên theo thứ tự turn — CHỈ check nếu đã rollspeed (turnOrder tồn tại).
          if ((encounter.turnOrder ?? []).length > 0) {
            const forPos = encounter.turnOrder.findIndex(e => e.id === forId);
            const targetPos = encounter.turnOrder.findIndex(e => e.id === targetId);
            if (forPos !== -1 && targetPos !== -1 && forPos > targetPos) {
              throw new Error(`${forResolved.label} đi SAU ${targetResolved.label} trong thứ tự turn — không thể clash người đi trước mình.`);
            }
          }

          const mySkill = findSkill(mySkillRaw);
          if (!mySkill) throw new Error(`Không tìm thấy skill "${mySkillRaw}".`);
          if (mySkill.promptArg) throw new Error(`Skill "${mySkill.name}" cần input đặc biệt — chưa hỗ trợ clash trực tiếp qua lệnh này.`);
          const oppSkill = findSkill(oppSkillRaw);
          if (!oppSkill) throw new Error(`Không tìm thấy skill "${oppSkillRaw}".`);
          if (oppSkill.promptArg) throw new Error(`Skill "${oppSkill.name}" cần input đặc biệt — chưa hỗ trợ clash trực tiếp qua lệnh này.`);

          const myRoll = buildSkillRollResult({ skill: mySkill });
          if (myRoll.error) throw new Error(myRoll.error);
          const oppRoll = buildSkillRollResult({ skill: oppSkill });
          if (oppRoll.error) throw new Error(oppRoll.error);
          if (myRoll.firstDiceValue === null || oppRoll.firstDiceValue === null) {
            throw new Error("Chỉ skill có Dice mới clash được — 1 trong 2 skill không có Dice nào.");
          }
          // [Unclashable] — skill nào có tag này thì KHÔNG thể bị/được Clash, bất kể
          // bên nào dùng (xác nhận trực tiếp từ GM).
          if (extractDefenseBypassTags(myRoll.embed?.description).unclashable) {
            throw new Error(`Skill "${mySkill.name}" có tag [Unclashable] — không thể dùng để Clash.`);
          }
          if (extractDefenseBypassTags(oppRoll.embed?.description).unclashable) {
            throw new Error(`Skill "${oppSkill.name}" có tag [Unclashable] — không thể dùng để Clash.`);
          }
          // Chấn thương (Gãy tay/Gãy chân/Mất Chân) trừ thẳng vào Dice dùng để clash.
          const myPenalty = getParryClashPenalty(forResolved.combatant);
          const oppPenalty = getParryClashPenalty(targetResolved.combatant);
          // Clash Attack Boost (50-Status Nhóm 1): +1 điểm Clash FLAT/stack (max 8).
          const myEffectiveDice = myRoll.firstDiceValue - myPenalty + (forResolved.combatant.clashAttackBoost ?? 0);
          const oppEffectiveDice = oppRoll.firstDiceValue - oppPenalty + (targetResolved.combatant.clashAttackBoost ?? 0);

          let resultText;
          if (myEffectiveDice > oppEffectiveDice) {
            const myBefore = forResolved.combatant.currentSanity;
            applySanityGain(forResolved.combatant, 10);
            applyEmotionDelta(forResolved.combatant, 2);
            const oppBefore = targetResolved.combatant.currentSanity;
            applyClashLossSanity(targetResolved.combatant);
            applyEmotionDelta(targetResolved.combatant, -1);
            checkStaggerPanic(forResolved.combatant); checkStaggerPanic(targetResolved.combatant);
            const myDelta = forResolved.combatant.currentSanity - myBefore;
            const oppDelta = targetResolved.combatant.currentSanity - oppBefore;
            resultText = `🏆 ${forResolved.label} THẮNG Clash! (${myEffectiveDice} vs ${oppEffectiveDice}${(myPenalty || oppPenalty || forResolved.combatant.clashAttackBoost || targetResolved.combatant.clashAttackBoost) ? `, gốc ${myRoll.firstDiceValue} vs ${oppRoll.firstDiceValue}, đã áp chấn thương/Clash Attack Boost` : ""}) — ${myDelta >= 0 ? "+" : ""}${myDelta} Sanity +2 Coin cho ${forResolved.label}, ${oppDelta >= 0 ? "+" : ""}${oppDelta} Sanity -1 Coin cho ${targetResolved.label}.`;
            // Voracity (Desire, [30 Points]): thắng Clash +2 Light, chỉ 1 lần/turn.
            if (hasPerk(forResolved.combatant, "Voracity") && !forResolved.combatant.voracityUsedThisTurn) {
              forResolved.combatant.currentLight = Math.min(forResolved.combatant.maxLight, forResolved.combatant.currentLight + 2);
              forResolved.combatant.voracityUsedThisTurn = true;
              resultText += ` ✨+2 Light (Voracity) cho ${forResolved.label}.`;
            }
            // Pressure Point (Pride, [15 Points]): thắng Clash +5 Poise.
            if (hasPerk(forResolved.combatant, "Pressure Point")) {
              forResolved.combatant.poise = Math.min(99, (forResolved.combatant.poise ?? 0) + 5);
              resultText += ` 💪+5 Poise (Pressure Point) cho ${forResolved.label}.`;
            }
            // Thorns (Gluttony, [30 Points]): THUA Clash → áp 7 Rupture lên người thắng.
            if (hasPerk(targetResolved.combatant, "Thorns")) {
              forResolved.combatant.rupture = Math.min(99, (forResolved.combatant.rupture ?? 0) + 7);
              resultText += ` 🌵+7 Rupture (Thorns) lên ${forResolved.label}.`;
            }
          } else if (myEffectiveDice < oppEffectiveDice) {
            const oppBefore2 = targetResolved.combatant.currentSanity;
            applySanityGain(targetResolved.combatant, 10);
            applyEmotionDelta(targetResolved.combatant, 2);
            const myBefore2 = forResolved.combatant.currentSanity;
            applyClashLossSanity(forResolved.combatant);
            applyEmotionDelta(forResolved.combatant, -1);
            checkStaggerPanic(forResolved.combatant); checkStaggerPanic(targetResolved.combatant);
            const oppDelta2 = targetResolved.combatant.currentSanity - oppBefore2;
            const myDelta2 = forResolved.combatant.currentSanity - myBefore2;
            resultText = `💔 ${forResolved.label} THUA Clash! (${myEffectiveDice} vs ${oppEffectiveDice}${myPenalty || oppPenalty ? `, gốc ${myRoll.firstDiceValue} vs ${oppRoll.firstDiceValue}, đã trừ chấn thương` : ""}) — ${oppDelta2 >= 0 ? "+" : ""}${oppDelta2} Sanity +2 Coin cho ${targetResolved.label}, ${myDelta2 >= 0 ? "+" : ""}${myDelta2} Sanity -1 Coin cho ${forResolved.label}.`;
            if (hasPerk(targetResolved.combatant, "Voracity") && !targetResolved.combatant.voracityUsedThisTurn) {
              targetResolved.combatant.currentLight = Math.min(targetResolved.combatant.maxLight, targetResolved.combatant.currentLight + 2);
              targetResolved.combatant.voracityUsedThisTurn = true;
              resultText += ` ✨+2 Light (Voracity) cho ${targetResolved.label}.`;
            }
            if (hasPerk(targetResolved.combatant, "Pressure Point")) {
              targetResolved.combatant.poise = Math.min(99, (targetResolved.combatant.poise ?? 0) + 5);
              resultText += ` 💪+5 Poise (Pressure Point) cho ${targetResolved.label}.`;
            }
            if (hasPerk(forResolved.combatant, "Thorns")) {
              targetResolved.combatant.rupture = Math.min(99, (targetResolved.combatant.rupture ?? 0) + 7);
              resultText += ` 🌵+7 Rupture (Thorns) lên ${targetResolved.label}.`;
            }
          } else {
            applyEmotionDelta(forResolved.combatant, 1);
            applyEmotionDelta(targetResolved.combatant, 1);
            resultText = `⚖️ HUỀ Clash! (${myEffectiveDice} vs ${oppEffectiveDice}) — mỗi bên +1 Coin, Sanity không đổi.`;
          }
          appendActionLog(encounter, `⚔️ Clash: ${resultText}`);
          await saveEncounter(encChannelId, encounter);
          await message.reply({ embeds: [myRoll.embed, oppRoll.embed, { title: "⚔️ Kết quả Clash", description: resultText, color: 0x9b59b6 }] });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // BUG ĐÃ SỬA: trước đây "-encounter help" (gõ ĐÚNG, có chủ đích xem hướng dẫn)
    // rơi vào CHUNG message "⚠️ Lệnh không hợp lệ" — gây hiểu lầm nghiêm trọng (nội
    // dung PHÍA SAU chính là help thật, nhưng tiêu đề khiến player tưởng mình gõ
    // sai). Giờ TÁCH RIÊNG: "help" → tiêu đề tích cực "📖 Hướng dẫn"; MỌI sub khác
    // không nhận diện được → giữ nguyên "⚠️ Lệnh không hợp lệ" (đúng bản chất).
    const helpBody =
      "**Setup & quản lý trận**\n" +
      "> `-encounter start name: <tên trận> [permadeath: yes]` (admin/GM) — permadeath cho Night in the Backstreet/dungeon đặc biệt\n" +
      "> `-encounter addenemy key: <key> name: <tên> hp: <số>` (admin/GM, tùy chọn `stamina:`/`weapon:`/`res:`/`perks:`/`speedrange:`)\n" +
      "> `-encounter removeenemy key: <key>` (admin/GM) — gỡ khỏi board (bỏ chạy/bắt sống, KHÔNG tính là đã hạ)\n" +
      "> `-encounter join` — HOÀN TOÀN TỰ ĐỘNG (không cần gõ gì) — tự lấy HP còn lại từ trận trước (hoặc full theo Grade), Max Light theo Grade, weapon/outfit/Res đã equip. Gõ tay `hp:`/`stamina:`/`light:`/`weapon:`/`res:`/`speedrange:` CHỈ để ĐÈ LÊN mặc định nếu cần trường hợp đặc biệt\n" +
      "> `-encounter status` · `-encounter end` (GM, tự gửi lại action log đầy đủ trước khi xoá) · `-encounter rollspeed` (GM)\n" +
      "> `-encounter log [turn: <số>/all]` — xem lại lịch sử action đã confirm/reject (mặc định 5 turn gần nhất)\n\n" +
      "**Tấn công & phòng thủ**\n" +
      "> `-encounter attack target: <key/all> dmg: <công thức> [skill:] [ref:] [coin:] [tags:]` — M1, tự trừ Stamina\n" +
      "> `-encounter hit target: <key/all> dmg: <công thức> [skill:] [ref:] [coin:] [tags:]` — Page/Skill, tự trừ Light/Sanity theo cost\n" +
      "> `-encounter enemyattack key: <enemy> target: <@player/all> dmg: <công thức> [skill:] [ref:] [coin:] [tags:]` (GM)\n" +
      "> `tags:` gõ tay thêm: undodgeable/unblockable/unparriable/guard break/unclashable (skill thật tự phát hiện từ text roll, không cần gõ)\n" +
      "> `-encounter guard/evade` — phòng thủ tự do, dùng bao nhiêu lần cũng được, TRỘN được nhiều loại để chặn 1 đòn M1 nhiều hit\n" +
      "> `-encounter parry` — 0 Sta, roll d20, ăn/thua so với roll đối phương lúc confirm\n" +
      "> `-encounter pending` — xem hàng chờ, confirm/reject tất cả · `-encounter endturn` (GM)\n\n" +
      "**Cơ chế đặc biệt**\n" +
      "> `-encounter clash target: <id> skill: <tên> oppskill: <tên> [for: <id>]` — so Dice đầu, ảnh hưởng Sanity+Coin (+Poise/Light/Rupture nếu có perk liên quan)\n" +
      "> `-encounter shinmang` — hi sinh 25 Sanity/turn (cần sở hữu Shin) · `-encounter manifestego` — -30 Sanity (cần Emotion Level ≥1)\n" +
      "> `-encounter followup target: <key>` — Follow-Up/Pounce (cần ≥20 Sta tiêu turn này) · `-encounter overcharge` — Overcharged Vessel\n" +
      "> `-encounter swapweapon <tên>` — đổi vũ khí GIỮA TRẬN — CHỈ dùng được nếu sở hữu accessory đặc biệt (VD Dimension Pocket)\n" +
      "> `-encounter additem <tên>` / `useitem <tên>` (tối đa 4 mang/trận, 1 dùng/turn) · `-encounter healinjury target: <key> index: <số>` (GM)\n" +
      "> Item có hiệu ứng CỤ THỂ (tự động, không cần GM narrate): Chuối (+10 HP), Táo (-1 Dmg/hit tới hết turn), Dưa hấu (+20 Stamina), Medkit (chữa TOÀN BỘ chấn thương NHẸ, không chữa chấn thương nặng), K-Corp Ampule (hồi đầy HP + chữa hết injury, dùng lần 2/trận = CHẾT)\n" +
      "> `-encounter haste/bind target: <key/me> amount: <số>` — chỉnh tay Speed\n\n" +
      "**Ngoài encounter (profile, không cần đang trong trận)**\n" +
      "> `-equipweapon/-equipoutfit <tên>` · `-equipaccessory <slot 1-3> <tên>` · `-equippage/-equipegopage <slot 1-5> <tên>` · `-equipment`/`-pages`\n" +
      "> `-healitem <tên>` — hồi đầy HP ngoài trận bằng item · `-rewoundtime @user` — hồi sinh Permanent Death (miễn phí lần đầu/profile)\n" +
      "> `-readbook <tên sách>` — tiêu 1 cuốn, hiện Page/Weapon/Outfit sách đó dạy (KHÔNG chặn equip — chỉ mang tính tham khảo)\n" +
      "> `-healinjuryahn @user ahn: <số> index: <số>` (admin/GM, GM tự định giá) — chữa 1 chấn thương NGOÀI trận. Chấn thương PERSIST qua encounter — chỉ chữa được bằng Ahn (ngoài trận) hoặc K-Corp Ampule (trong trận, hồi đầy HP + chữa hết injury, dùng lần 2/trận = CHẾT)\n" +
      "> `-allocatepoints <nhánh>: <số>` — TỰ phân bổ điểm Skill Tree (không cần GM) · `-unlockskilltree <perk>` — TỰ mở khoá perk cho chính mình\n" +
      "> Admin có thể làm hộ player khác bằng cách thêm @user vào các lệnh equip/unlockskilltree ở trên";
    // BUG ĐÃ SỬA (xác nhận trực tiếp: "-encounter help không hoạt động") — helpBody
    // dài ~3468 ký tự, VƯỢT giới hạn 2000 ký tự Discord cho tin nhắn TEXT THƯỜNG
    // (message.reply(string)) — Discord API THẬT âm thầm từ chối gửi tin nhắn quá
    // dài, khiến lệnh "không phản hồi gì" (mock test trước đây không mô phỏng giới
    // hạn ký tự thật của Discord nên không bắt được lỗi này). Chuyển sang EMBED
    // (giới hạn description 4096 ký tự — đủ chỗ) cho CẢ "help" LẪN "invalid
    // command" fallback bên dưới.
    if (sub === "help") {
      message.reply({ embeds: [{ title: "📖 Hướng dẫn -encounter", description: helpBody, color: 0x5865f2 }] });
      return;
    }
    // BUG/UX ĐÃ SỬA (xác nhận trực tiếp từ GM: "mỗi lần gõ lệnh sai thì nó ra
    // phần encounter help quá dài, khiến trôi chat rất nhiều") — trước đây fallback
    // NÀY dump NGUYÊN helpBody dài ~3400 ký tự MỖI LẦN gõ sai — giờ chỉ báo NGẮN
    // GỌN + trỏ user tự gõ `-encounter help` RIÊNG nếu cần xem đầy đủ. LƯU Ý KỸ
    // THUẬT: `-encounter` là PREFIX COMMAND (tin nhắn text thường qua
    // messageCreate), KHÔNG PHẢI slash command — Discord CHỈ hỗ trợ "ephemeral"
    // (tin nhắn riêng tư, tự ẩn) cho INTERACTION RESPONSE (slash command/button/
    // dropdown), KHÔNG CÓ CƠ CHẾ ephemeral nào cho message.reply() của tin nhắn
    // text thường — đây là giới hạn CỦA DISCORD, không phải hạn chế của code, nên
    // không thể "ẩn" phản hồi này dù muốn — rút ngắn là cách khả thi duy nhất.
    message.reply({ embeds: [{ title: "⚠️ Lệnh không hợp lệ", description: `Không nhận diện được subcommand \`${sub}\`.\n> Dùng \`-encounter help\` để xem đầy đủ danh sách lệnh.`, color: 0xe74c3c }] });
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

// resolveOnePendingAction — TÁCH NGUYÊN VĂN từ thân vòng lặp "for (const p of
// encounter.pendingActions)" trong encconfirmall handler (759 dòng gốc, GIỮ
// 100% logic bên trong không đổi 1 ký tự nào ngoài continue→return đầu hàm —
// vì hàm giờ chỉ xử lý ĐÚNG 1 p, không còn "p tiếp theo" để continue tới) —
// mục đích: dùng LẠI được CẢ cho confirmAll hàng loạt (gọi trong vòng lặp)
// LẪN luồng reactive mới (gọi ngay cho 1 action duy nhất, không cần đợi GM).
// Đổi TÊN kiến trúc, KHÔNG đổi HÀNH VI — mọi effect/status/side-effect y hệt cũ.
async function resolveOnePendingAction(encounter, p) {
  const resultLines = [];
            const attacker = resolveCombatant(encounter, p.attackerId);
            if (!attacker) { resultLines.push(`⚠️ Bỏ qua 1 action — không tìm thấy attacker ${p.attackerId} (có thể đã rời encounter).`); return resultLines; }

            // Stamina cost (chỉ attack mới có) — trừ 1 LẦN cho action này, KHÔNG
            // nhân theo số target (1 đòn M1 chỉ tốn Stamina 1 lần dù AOE).
            let staminaNote = "";
            if (p.staminaCost && attacker.type === "player") {
              attacker.combatant.currentStamina = Math.max(0, attacker.combatant.currentStamina - p.staminaCost);
              attacker.combatant.staminaUsedThisTurn += p.staminaCost;
              checkStaggerPanic(attacker.combatant);
              staminaNote = ` (-${p.staminaCost} Sta${attacker.combatant.staggered ? " 💫Stagger!" : ""})`;
              // Regain Mind (Shin, [30 Points]): mỗi 40 Stamina mất do M1 (đánh
              // thường) → +10 Sanity. Tích lũy riêng (KHÔNG dùng chung
              // staminaUsedThisTurn vì cái đó reset mỗi turn còn đây cần tích lũy
              // XUYÊN TURN cho tới khi đủ 40) — 1 action tốn ≥40 Sta (VD M1 nhiều hit
              // vũ khí heavy) có thể cho nhiều lần 10 Sanity cùng lúc.
              if (hasPerk(attacker.combatant, "Regain Mind")) {
                attacker.combatant.regainMindAccumulator = (attacker.combatant.regainMindAccumulator ?? 0) + p.staminaCost;
                const sanityGainCount = Math.floor(attacker.combatant.regainMindAccumulator / 40);
                if (sanityGainCount > 0) {
                  attacker.combatant.regainMindAccumulator -= sanityGainCount * 40;
                  const sanityBeforeRegain = attacker.combatant.currentSanity;
                  applySanityGain(attacker.combatant, sanityGainCount * 10);
                  const actualSanityDelta = attacker.combatant.currentSanity - sanityBeforeRegain;
                  staminaNote += ` 🧠${actualSanityDelta >= 0 ? "+" : ""}${actualSanityDelta} Sanity (Regain Mind)`;
                }
              }
            }
            // Light/Sanity cost của Page (verify.lightCost/sanityCost, đã check ĐỦ
            // lúc declare trong resolveSkillVerification — xem comment đầy đủ ở đó,
            // bao gồm Tap Of The Light giảm 1 nửa Sanity Cost cho E.G.O Page) — trừ
            // THẬT ở đây, lúc confirm (cùng nguyên tắc với Stamina M1: reject không
            // làm mất resource oan). Áp dụng cho CẢ player lẫn enemy (enemy cũng có
            // currentLight/currentSanity, GM có thể dùng skill: cho enemy).
            let resourceNote = "";
            if (p.lightCost > 0) {
              attacker.combatant.currentLight = Math.max(0, attacker.combatant.currentLight - p.lightCost);
              resourceNote += ` (-${p.lightCost} <:Light:1513786082502770719>Light)`;
            }
            if (p.sanityCost > 0) {
              attacker.combatant.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, attacker.combatant.currentSanity - p.sanityCost);
              resourceNote += ` (-${p.sanityCost} Sanity)`;
              checkStaggerPanic(attacker.combatant);
            }
            staminaNote += resourceNote;

            const targetDmgLines = [];
            let totalHitsThisAction = 0; // tích luỹ TỔNG hit thật qua mọi target (AOE) trong action này — dùng cho Battle Ignition sau vòng lặp (xem dưới)
            // Eye Of Horus — tích luỹ riêng (KHÔNG gán trực tiếp attacker.combatant.
            // charge trong vòng lặp) — BUG ĐÃ SỬA: trước đây gán trực tiếp TRONG vòng
            // lặp targets, nhưng dòng "attacker.combatant.charge = firstPreview.
            // finalCharge" (SAU vòng lặp, xử lý Poise/Charge "trên bản thân" từ
            // dmgStr's tag +Charge nếu có) GÁN THẲNG (không cộng dồn) — GHI ĐÈ MẤT
            // HOÀN TOÀN +2 Charge Eye Of Horus vừa cộng mỗi lần đánh — verify bằng
            // test thật phát hiện Tremor tăng đúng nhưng Charge KHÔNG BAO GIỜ tăng dù
            // logic bên trong đúng. Giờ tích luỹ riêng, CỘNG THÊM (không ghi đè) SAU
            // dòng gán finalCharge — xem chỗ dùng biến này bên dưới.
            let eyeOfHorusChargeGainedThisAction = 0;
            for (const t of p.targets) {
              const targetResolved = resolveCombatant(encounter, t.targetId);
              if (!targetResolved) { targetDmgLines.push(`⚠️ target ${t.targetId} không còn tồn tại`); continue; }
              const target = targetResolved.combatant;
              const hadRuptureBeforeHit = target.rupture > 0; // Defenseless cần biết TRƯỚC khi finalRupture ghi đè
              const bleedBeforeHit = target.bleed; // Craving Synergy/Thirst/Break the Dams cần biết TRƯỚC khi finalBleed ghi đè
              let finalDmg = t.preview.totalDmg;
              let defenseNote = "";
              let evadedCompletely = false;
              // Guard/Evade/Parry — TIÊU THỤ charge SỐNG (đọc trực tiếp target lúc xử
              // lý action này trong batch, KHÔNG dùng giá trị tính sẵn lúc declare).
              // QUAN TRỌNG: 1 charge chặn được SỐ HIT theo vũ khí BÊN TẤN CÔNG — CHỈ
              // áp dụng tỉ lệ này cho đòn ĐÁNH THƯỜNG (M1) — gồm CẢ player tự attack
              // (kind "attack") VÀ GM dùng enemyattack KHÔNG kèm skill: (coi là M1 của
              // enemy, vì enemyattack không tự phân biệt M1 hay skill — chỉ biết chắc
              // là skill khi có verify.skillKey). Còn lại (Page/skill) coi 1 charge =
              // chặn cả action. Thứ tự ưu tiên: Evade (an toàn nhất) → Parry (free
              // nhưng rủi ro) → Guard (giảm 90%, không rủi ro).
              const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
              const attackerWeapon = attacker.combatant.weaponWeight ?? "medium";
              const hitsPerCharge = isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeapon] ?? 1) : null; // null = chặn cả action, không chia theo hit
              const hitCount = Math.max(1, t.preview.dmgValues?.length ?? 1);
              if (isM1Type) totalHitsThisAction += hitCount; // chỉ M1 mới tính cho Battle Ignition (Page/skill không tính, đúng comment dưới)
              // bypass — đọc từ defenseBypass đã lưu lúc declare (tự phát hiện từ
              // [Undodgeable]/[Unblockable]/[Guard Break]/[Unparriable] trong text
              // skill roll thật, gộp với tags: gõ tay nếu có) — loại đúng phòng thủ
              // KHÔNG cản được đòn này, áp dụng CẢ cho M1-mix lẫn Page/skill 1-charge.
              const bypass = p.defenseBypass ?? { blockEvade: false, blockGuard: false, blockParry: false };
              // Airborne (xác nhận trực tiếp): "biến mất... sau bị dính đòn có
              // condition Airborne" — tắt NGAY (không đợi end turn) nếu đòn này có
              // tag [Airborne] VÀ target đang airborne=true. Đặt SỚM (không phụ
              // thuộc finalDmg/evadedCompletely) vì đây là hiệu ứng của TAG, không
              // phải sát thương — nên xảy ra dù đòn có né/chặn hay không.
              if (bypass.airborneCondition && target.airborne) {
                target.airborne = false;
              }
              // computeBlock — trả { chargesUsed, fraction } cho 1 lượt thử block.
              // hitsPerCharge=null (Page/skill) → 1 charge LUÔN chặn 100% action.
              function computeBlock(chargesAvailable) {
                if (hitsPerCharge === null) {
                  return chargesAvailable >= 1 ? { chargesUsed: 1, fraction: 1 } : { chargesUsed: 0, fraction: 0 };
                }
                const chargesNeeded = Math.ceil(hitCount / hitsPerCharge);
                const chargesUsed = Math.min(chargesAvailable, chargesNeeded);
                const fraction = chargesUsed > 0 ? Math.min(1, (chargesUsed * hitsPerCharge) / hitCount) : 0;
                return { chargesUsed, fraction };
              }
              // Iron Horus (Abydos's Uniform - Lazy Style): Guard giảm 100% dmg
              // (TOÀN BỘ đòn) — ưu tiên CAO NHẤT, ghi đè cả Fortified Resolve (99%)
              // nếu có cả 2, vì "giảm TOÀN BỘ đòn" là mức tối đa tuyệt đối — Defense
              // Up/Down (50-Status) KHÔNG ảnh hưởng nhánh Iron Horus (không thể vượt
              // 100%), CHỈ cộng vào 2 nhánh còn lại, cap tối đa 1 (100%).
              // BUG ĐÃ SỬA (xác nhận trực tiếp, kèm log thật cho thấy nhân vật có
              // CẢ Iron Horus lẫn Fortified Resolve cùng lúc — Guard tốn đúng 40
              // Sta của Iron Horus, nhưng hiện "giảm 100%" thay vì đúng 99% của
              // Fortified Resolve): "đáng lẽ nó chỉ có giảm 99% thôi, tức là vẫn
              // phải nhận tí sát thương" — trước đây hasIronHorus được check TRƯỚC
              // (ưu tiên tuyệt đối 100%), HOÀN TOÀN bỏ qua Fortified Resolve nếu có
              // cả 2 — SAI theo xác nhận mới. Đổi thứ tự: Fortified Resolve (nếu
              // có) LUÔN cap ở 99%, BẤT KỂ có Iron Horus hay không — cơ chế RIÊNG
              // của Iron Horus (chặn TOÀN BỘ hit trong turn, charge KHÔNG tụt) VẪN
              // giữ nguyên (gate ở target.hasIronHorus bên dưới, không đổi), chỉ
              // % dmg giảm thay đổi khi có cả 2.
              // BUG ĐÃ SỬA (hiểu sai HOÀN TOÀN từ đầu, xác nhận trực tiếp kèm
              // nguyên văn passive card): "Iron Horus: Block tốn 40 stamina NHƯNG
              // giảm sát thương TOÀN BỘ ĐÒN" — "toàn bộ đòn" ở đây nói về PHẠM VI
              // (chặn được HẾT các hit trong đòn M1/action đó, nhờ charge KHÔNG
              // TỤT và kéo dài cả turn), KHÔNG PHẢI mức độ giảm dmg. Iron Horus
              // KHÔNG đổi % giảm dmg từ 90% mặc định lên 100% — vẫn CHỈ 90% như
              // Guard thường (hoặc 99% nếu có Fortified Resolve, không liên quan
              // gì tới Iron Horus). Toàn bộ hiệu ứng ĐẶC BIỆT của Iron Horus chỉ
              // là: (1) cost 40 Sta thay vì 10, (2) 1 charge chặn được MỌI hit
              // trong SUỐT turn đó (không giới hạn theo weaponWeight, không tự
              // tụt) — cả 2 phần này đã đúng sẵn ở nơi khác (performGuardEvade's
              // cost, và nhánh "while(hitIdx<totalHits)" bên dưới), CHỈ RIÊNG dòng
              // này (% giảm dmg) là sai, đã xoá hẳn nhánh hasIronHorus khỏi đây.
              const baseGuardPct = hasPerk(target, "Fortified Resolve") ? 0.99 : 0.9;
              // Iron Horus KHÔNG còn đặc biệt gì về % nữa (xem comment đầy đủ ở
              // baseGuardPct ngay trên) — Defense Up/Down áp dụng BÌNH THƯỜNG dù
              // có Iron Horus hay không, giống mọi combatant khác.
              const defenseUpDownPct = ((target.defenseUp ?? 0) * 1 - (target.defenseDown ?? 0) * 5) / 100;
              const guardReductionPct = Math.min(1, Math.max(0, baseGuardPct + defenseUpDownPct));
              if (isM1Type) {
                // M1 NHIỀU HIT — cho phép TRỘN nhiều LOẠI phòng thủ khác nhau để chặn
                // các CỤM hit khác nhau trong CÙNG 1 đòn M1 (xác nhận trực tiếp từ GM:
                // "có thể guard/parry/evade theo tùy thích vào số hit" — KHÔNG bắt
                // buộc chỉ 1 loại cho cả đòn như code cũ). Thứ tự ưu tiên xử lý từng
                // CỤM hit kế tiếp: Evade (free, an toàn nhất) → Parry (free nhưng rủi
                // ro ăn full nếu hụt) → Guard (chắc chắn giảm % nhưng không free) —
                // mỗi loại tiêu thụ HẾT charge/roll đang có rồi mới chuyển loại kế,
                // cho tới khi hết hit cần chặn hoặc hết toàn bộ charge các loại. Loại
                // nào bị bypass (tag Undodgeable/Unblockable/Guard Break/Unparriable)
                // thì SKIP hoàn toàn, không tiêu charge của loại đó cho đòn này.
                const instanceResults = t.preview.instanceResults ?? [];
                const totalHits = instanceResults.length || hitCount;
                const perHitMult = new Array(totalHits).fill(1);
                let hitIdx = 0;
                const noteParts = [];

                if (!bypass.blockEvade && (target.evadeCharges ?? 0) > 0 && hitIdx < totalHits) {
                  const coverStart = hitIdx;
                  let used = 0;
                  while (target.evadeCharges > 0 && hitIdx < totalHits) {
                    target.evadeCharges -= 1; used += 1;
                    for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) perHitMult[hitIdx] = 0;
                  }
                  noteParts.push(`💨**Evade** (${used} charge — né hit ${coverStart + 1}-${hitIdx})${applyEvadeSuccessPerks(target, attacker.combatant)}`);
                }
                while (!bypass.blockParry && (target.parryRolls ?? []).length > 0 && hitIdx < totalHits) {
                  const defRoll = target.parryRolls.shift();
                  const atkRoll = 1 + Math.floor(Math.random() * 20);
                  const won = defRoll >= atkRoll;
                  const coverStart = hitIdx;
                  for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) {
                    if (won) perHitMult[hitIdx] = 0;
                  }
                  if (won) {
                    noteParts.push(`🗡️**Parry THÀNH CÔNG** (${defRoll} vs ${atkRoll} — né hit ${coverStart + 1}-${hitIdx})${applyParrySuccessPerks(target, attacker.combatant)}`);
                  } else {
                    // Mastered Breaths (Sloth, [15 Points]): base cost 30 thay vì 40.
                    // Gãy tay (chấn thương) vẫn NHÂN ĐÔI bất kể base là bao nhiêu.
                    const baseFailCost = hasPerk(target, "Mastered Breaths") ? 30 : 40;
                    const failCost = (target.injuries ?? []).includes("Gãy tay") ? baseFailCost * 2 : baseFailCost;
                    target.currentStamina = Math.max(0, target.currentStamina - failCost);
                    noteParts.push(`🗡️**Parry THẤT BẠI** (${defRoll} vs ${atkRoll}, -${failCost} Sta — ăn full hit ${coverStart + 1}-${hitIdx})`);
                  }
                }
                if (!bypass.blockGuard && (target.guardCharges ?? 0) > 0 && hitIdx < totalHits) {
                  const coverStart = hitIdx;
                  // Iron Horus (Abydos's Uniform passive) — BUG ĐÃ SỬA (xác nhận
                  // trực tiếp từ GM, đang gây ăn dmg thật trên production): "1 lần
                  // guard tốn 40 Sta nhưng CẢ TURN sẽ guard TOÀN BỘ đòn, 1 charge
                  // KHÔNG BAO GIỜ tụt" — KHÁC HẲN cơ chế mặc định (charge chặn giới
                  // hạn N hit theo weaponWeight rồi tự trừ hết). Với Iron Horus: che
                  // TOÀN BỘ hit còn lại trong hit-group này, KHÔNG trừ guardCharges gì
                  // cả (giữ nguyên charge, tiếp tục che các đòn KHÁC trong CÙNG turn
                  // cho tới khi turn kết thúc — xem advanceCombatantTurn nơi charge
                  // mới thực sự reset).
                  if (target.hasIronHorus) {
                    while (hitIdx < totalHits) { perHitMult[hitIdx] = 1 - guardReductionPct; hitIdx++; }
                    noteParts.push(`🛡️**Guard (Iron Horus — chặn TOÀN BỘ, charge không tụt)** (giảm ${Math.round(guardReductionPct * 100)}% — hit ${coverStart + 1}-${hitIdx})`);
                  } else if ((target.guardHitSelections ?? []).length > 0) {
                    // GAP ĐÃ SỬA (xác nhận trực tiếp): "Guard không tùy chọn được
                    // guard đòn nào — chỉ có thể tuần tự 1 2 3 4 5, trong khi chơi
                    // thủ công có thể chọn tùy thích (VD guard đòn 3 và 5)" — NẾU
                    // player đã gọi "guard hits: X,Y" trước đó (lưu sẵn trong
                    // guardHitSelections), dùng ĐÚNG các hit index đó thay vì che
                    // tuần tự từ hitIdx hiện tại. Chỉ lấy các index HỢP LỆ nằm
                    // trong phạm vi đòn này (1..totalHits) — số dư (nếu chỉ định
                    // hit vượt quá totalHits của đòn thực tế) giữ lại cho đòn sau.
                    const validSelected = target.guardHitSelections.filter(h => h >= 1 && h <= totalHits);
                    for (const h of validSelected) perHitMult[h - 1] = 1 - guardReductionPct;
                    const chargesUsed = Math.min(target.guardCharges, Math.ceil(validSelected.length / hitsPerCharge));
                    target.guardCharges = Math.max(0, target.guardCharges - chargesUsed);
                    target.guardHitSelections = target.guardHitSelections.filter(h => !(h >= 1 && h <= totalHits));
                    hitIdx = totalHits; // đã xử lý xong khối Guard này (dù không tuần tự) — không loại khác che tiếp lên các hit CHƯA được chỉ định
                    noteParts.push(`🛡️**Guard (chọn riêng)** (${chargesUsed} charge, giảm ${Math.round(guardReductionPct * 100)}% — hit ${validSelected.join(",")})`);
                  } else {
                    let used = 0;
                    while (target.guardCharges > 0 && hitIdx < totalHits) {
                      target.guardCharges -= 1; used += 1;
                      for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) perHitMult[hitIdx] = 1 - guardReductionPct;
                    }
                    noteParts.push(`🛡️**Guard** (${used} charge, giảm ${Math.round(guardReductionPct * 100)}% — hit ${coverStart + 1}-${hitIdx})`);
                  }
                  // Guard Break: Guard VẪN cản được (đã giảm dmg ở trên), nhưng bên
                  // Guard bị Stagger NGAY (không đợi Stamina về 0) — xác nhận trực
                  // tiếp từ GM, KHÁC hẳn Unblockable (vốn làm Guard không cản được).
                  if (bypass.guardBreak) {
                    forceStagger(target);
                    noteParts.push(`💥**Guard Break** — bị Stagger ngay (Res 2x từ giờ)`);
                  }
                }

                if (instanceResults.length > 0) {
                  finalDmg = instanceResults.reduce((sum, r, i) => sum + (r.instanceDmg ?? 0) * perHitMult[i], 0);
                } else {
                  // fallback hiếm gặp (không có instanceResults chi tiết) — coi như đều
                  // (giữ hành vi gần đúng cũ, KHÔNG nên xảy ra trong thực tế vì M1 luôn
                  // có instanceResults).
                  const avgMult = perHitMult.reduce((s, m) => s + m, 0) / totalHits;
                  finalDmg *= avgMult;
                }
                // evadedCompletely CHỈ true nếu TOÀN BỘ hit đều = 0 — vì Guard KHÔNG
                // BAO GIỜ đạt 0 (tối đa giảm 99%), nên nếu true thì chắc chắn do
                // Evade/Parry-thành-công che hết, không lẫn Guard.
                evadedCompletely = totalHits > 0 && perHitMult.every((m) => m === 0);
                const bypassNote = [bypass.blockEvade && "Undodgeable", bypass.blockGuard && "Unblockable", bypass.blockParry && "Unparriable"].filter(Boolean);
                defenseNote = noteParts.length > 0 ? " " + noteParts.join(" + ") : "";
                if (bypassNote.length > 0 && hitIdx < totalHits) defenseNote += ` *(${bypassNote.join(", ")} — phần hit còn lại không thể chặn)*`;
              } else if (!bypass.blockEvade && (target.evadeCharges ?? 0) > 0) {
                const { chargesUsed, fraction } = computeBlock(target.evadeCharges);
                target.evadeCharges -= chargesUsed;
                finalDmg *= (1 - fraction);
                if (fraction >= 1) evadedCompletely = true;
                defenseNote = ` 💨**Evade** (chặn ${Math.round(fraction * 100)}% — dùng ${chargesUsed} charge)${applyEvadeSuccessPerks(target, attacker.combatant)}`;
              } else if (!bypass.blockParry && (target.parryRolls ?? []).length > 0) {
                const defRoll = target.parryRolls.shift();
                const atkRoll = 1 + Math.floor(Math.random() * 20);
                if (defRoll >= atkRoll) {
                  const { fraction } = computeBlock(1);
                  finalDmg *= (1 - fraction);
                  if (fraction >= 1) evadedCompletely = true;
                  defenseNote = ` 🗡️**Parry THÀNH CÔNG** (${defRoll} vs ${atkRoll}, chặn ${Math.round(fraction * 100)}%)`;
                  defenseNote += applyParrySuccessPerks(target, attacker.combatant);
                } else {
                  // Mastered Breaths (Sloth, [15 Points]): base cost 30 thay vì 40 khi
                  // hụt Parry. Gãy tay (chấn thương) vẫn NHÂN ĐÔI bất kể base là bao
                  // nhiêu (áp dụng SAU khi đã chọn base, không phải OR riêng).
                  const baseFailCost = hasPerk(target, "Mastered Breaths") ? 30 : 40;
                  const failCost = (target.injuries ?? []).includes("Gãy tay") ? baseFailCost * 2 : baseFailCost;
                  target.currentStamina = Math.max(0, target.currentStamina - failCost);
                  defenseNote = ` 🗡️**Parry THẤT BẠI** (${defRoll} vs ${atkRoll}, -${failCost} Sta, ăn full dmg)`;
                }
              } else if (!bypass.blockGuard && (target.guardCharges ?? 0) > 0) {
                // Iron Horus — cùng nguyên tắc như nhánh M1 nhiều hit ở trên: che
                // 100% đòn (fraction=1), KHÔNG trừ charge.
                if (target.hasIronHorus) {
                  finalDmg *= (1 - guardReductionPct);
                  defenseNote = ` 🛡️**Guard (Iron Horus — chặn TOÀN BỘ, charge không tụt)** (giảm ${Math.round(guardReductionPct * 100)}%)`;
                } else {
                  const { chargesUsed, fraction } = computeBlock(target.guardCharges);
                  target.guardCharges -= chargesUsed;
                  finalDmg *= (1 - fraction * guardReductionPct);
                  defenseNote = ` 🛡️**Guard** (giảm ${Math.round(guardReductionPct * 100)}% trên ${Math.round(fraction * 100)}% đòn — dùng ${chargesUsed} charge)`;
                }
                if (bypass.guardBreak) {
                  forceStagger(target);
                  defenseNote += ` 💥**Guard Break** — bị Stagger ngay (Res 2x từ giờ)`;
                }
              }
              // Smoldering Resolve (perk passive, KHÔNG tiêu thụ) áp SAU Guard/Evade/
              // Parry — giảm thêm % trên phần dmg CÒN LẠI sau khi đã né/đỡ.
              finalDmg *= (1 - (t.defReductionPct ?? 0) / 100);
              let killNote = "";
              // Evade né được = né LUÔN finisher (Claim Their Heart) — đã tránh đòn
              // hoàn toàn thì không có lý do vẫn bị "kết liễu" bởi chính đòn đó.
              if (t.instantKill && !evadedCompletely) { finalDmg = target.currentHp; killNote = ` ☠️KẾT LIỄU (${t.instantKill})`; }
              let bleedOverride = null; // Break the Dams — giữ bleed KHÔNG bị giảm turn này nếu trigger
              let perkNote = "";
              // Craving Synergy/Thirst/Break the Dams — CHỈ đòn đánh ĐẦU TIÊN của
              // ATTACKER lên TARGET ĐANG có Bleed mỗi turn (chung 1 cờ — trigger cả 3
              // nếu đủ điều kiện riêng từng cái, vì đều là "tận dụng đòn đầu turn").
              // BUG ĐÃ SỬA: trước đây KHÔNG check evadedCompletely — nếu đòn bị né/
              // parry HOÀN TOÀN, cả 3 perk này vẫn trigger như đòn đã trúng (vô lý —
              // "đòn đánh đầu tiên LÊN kẻ địch" hàm ý phải THỰC SỰ chạm tới, không
              // trúng thì không có "đòn đánh" nào để tính là "đầu tiên" cả). Nghiêm
              // trọng hơn: Break the Dams cũ còn "finalDmg += bleedBeforeHit" — cộng
              // thẳng vào finalDmg ĐÃ BỊ ÉP VỀ 0 bởi né hoàn toàn, khiến target VẪN ăn
              // dmg dù đã né 100% — giờ chặn hẳn nhánh này khi evadedCompletely.
              if (!evadedCompletely && attacker.type === "player" && !attacker.combatant.bleedFirstHitUsedThisTurn && bleedBeforeHit > 0) {
                let usedThisHit = false;
                if (hasPerk(attacker.combatant, "Break the Dams") && bleedBeforeHit >= 7 && (attacker.combatant.breakTheDamsCdLeft ?? 0) <= 0) {
                  finalDmg += bleedBeforeHit;
                  // Lấy bleedStacksAfter của hit CUỐI (trước khi end-turn-tick giảm nửa) thay cho finalBleed — "giữ count không giảm turn này".
                  const lastHit = t.preview.instanceResults[t.preview.instanceResults.length - 1];
                  bleedOverride = lastHit?.bleedStacksAfter ?? bleedBeforeHit;
                  attacker.combatant.breakTheDamsCdLeft = 3;
                  perkNote += ` [💥Break the Dams +${bleedBeforeHit}dmg]`;
                  usedThisHit = true;
                }
                if (hasPerk(attacker.combatant, "Thirst")) {
                  const healAmt = Math.floor(bleedBeforeHit / 2);
                  attacker.combatant.currentHp = Math.min(attacker.combatant.maxHp, attacker.combatant.currentHp + healAmt);
                  bleedOverride = 0; // "tiêu thụ chúng" — Thirst LUÔN thắng nếu cả 2 cùng trigger (hiếm khi xảy ra)
                  perkNote += ` [🩸Thirst +${healAmt}HP bản thân, tiêu thụ Bleed]`;
                  usedThisHit = true;
                }
                if (hasPerk(attacker.combatant, "Craving Synergy") && bleedBeforeHit > 5) {
                  attacker.combatant.currentLight = Math.min(attacker.combatant.maxLight, attacker.combatant.currentLight + 1);
                  perkNote += ` [✨Craving Synergy +1 Light]`;
                  usedThisHit = true;
                }
                if (usedThisHit) attacker.combatant.bleedFirstHitUsedThisTurn = true;
              }
              const wasAliveBefore = target.currentHp > 0;
              // Táo (item): giảm 1 Dmg PHẢI NHẬN mỗi HIT (không phải mỗi ACTION) cho
              // tới hết turn hiện tại — áp SAU Guard/Evade/Parry (finalDmg đã qua
              // mitigation), nhân theo hitCount thật của action này (M1 nhiều hit →
              // giảm nhiều lần, đúng "mỗi hit"). Không áp nếu evadedCompletely
              // (finalDmg đã =0 từ trước, floor tại 0 tự nhiên an toàn không cần
              // check thêm). Chỉ áp cho target LÀ PLAYER (Táo là item của player).
              if (target.appleDmgReductionActive && targetResolved.type === "player") {
                finalDmg = Math.max(0, finalDmg - hitCount);
              }
              // Foreclosure Task Force President (Eye of Horus, passive vũ khí — tự
              // động hoá theo yêu cầu trực tiếp): leo thang theo SỐ LẦN đánh thường
              // (M1) trong 1 TURN lên CÙNG 1 target. Áp dụng TẠI ĐÂY (lúc CONFIRM,
              // không phải lúc declare) để tránh counter bị tăng NHẦM nếu GM sau đó
              // reject action — đồng bộ đúng với thời điểm "hành động THỰC SỰ xảy
              // ra". CHỈ áp cho M1 (p.isM1), không áp cho Page/skill.
              // Phần TỰ ĐỘNG HOÁ ĐƯỢC: +50% dmg khi count 2-3, +2 Tremor +2 Charge
              // lên BẢN THÂN (attacker) MỖI lần đánh thường bất kể count bao nhiêu.
              // Phần KHÔNG tự động hoá (giữ nguyên GM/player tự áp — xem weapon.js):
              // "Repeat Ammo" ở lần đầu (cơ chế không rõ ràng đủ để code chính xác),
              // Base dmg 3→4 ở count 4-6 (CHỈ tự động được cho đường nút bấm "Đánh
              // mấy lần" — xem encmenu handler đọc count HIỆN TẠI để tính base động,
              // KHÔNG áp được cho lệnh text tự gõ dmgStr).
              // Foreclosure Task Force President (Eye Of Horus) — logic THẬT nằm ở
              // computeAttackerPerkContext (bonusPct theo tier, tính lúc DECLARE) +
              // khối "eyeOfHorusTremorChargeAmount" phía trên (commit Tremor/Charge lúc
              // CONFIRM) — xem 2 chỗ đó, KHÔNG áp dụng lại ở đây. (BUG ĐÃ SỬA: từng có
              // 1 bản implementation THỨ HAI ở đây, dùng field khác (hasEyeOfHorus/
              // eyeOfHorusHitCountByTarget) — SAI logic tier (+50% chỉ áp lần 2-3 thay
              // vì 1-3), THIẾU Repeat Ammo + base 3→4, và Tremor/Charge KHÔNG check
              // evadedCompletely — chạy SONG SONG với bản đúng khiến Tremor/Charge bị
              // cộng ĐÚP mỗi lần đánh, verify bằng test thật phát hiện Tremor=16 thay
              // vì 8 sau 4 lần đánh. Đã xoá hẳn, chỉ giữ 1 nguồn duy nhất.)
              let eyeOfHorusNote = "";
              // Time Moratorium (xác nhận trực tiếp): "khi bị nhận sát thương mà có
              // hiệu ứng này... KHÔNG NHẬN sát thương trong turn đó mà tích lại...
              // khi mục tiêu có hiệu ứng này giảm 10% dmg nhận vào" — chặn TOÀN BỘ
              // finalDmg CUỐI CÙNG (sau khi Guard/Evade/Parry đã áp dụng xong ở
              // trên), tích luỹ 90% (đã giảm 10%) vào timeMoratoriumAccumulated,
              // rồi set finalDmg=0 để mọi logic PHÍA SAU (regen, justDied, injury...)
              // tự nhiên coi đây là "không nhận dmg" — an toàn nhất, không cần sửa
              // lại từng chỗ phụ thuộc finalDmg riêng lẻ.
              let timeMoratoriumNote = "";
              if (target.timeMoratorium && finalDmg > 0) {
                const accumulatedGain = finalDmg * 0.9;
                target.timeMoratoriumAccumulated = (target.timeMoratoriumAccumulated ?? 0) + accumulatedGain;
                timeMoratoriumNote = ` ⏳[Time Moratorium hoãn ${accumulatedGain.toFixed(3)} dmg, tích lũy ${target.timeMoratoriumAccumulated.toFixed(3)}]`;
                finalDmg = 0;
              }
              target.currentHp = Math.max(0, target.currentHp - finalDmg);
              // Regen (50-Status Nhóm 1) — "CHỈ khi mất máu mới tự động tiêu thụ để
              // hồi HP" (xác nhận trực tiếp từ GM) — KHÔNG tự hồi mỗi turn, CHỈ kích
              // hoạt NGAY SAU khi vừa nhận dmg thật (finalDmg > 0, không tính đòn bị
              // né/chặn hoàn toàn thành 0 dmg). Tiêu thụ tối đa min(regen, finalDmg)
              // — mỗi 1 Regen hồi lại đúng 1 HP, KHÔNG hồi vượt quá lượng vừa mất.
              let regenHealNote = "";
              if (finalDmg > 0 && (target.regen ?? 0) > 0) {
                let regenConsumed = Math.min(target.regen, finalDmg);
                // Hemorrhage stack 5 (xác nhận trực tiếp): "giảm hồi máu của mục
                // tiêu dính Bleed đi 1/3" — chỉ áp ở tier CAO NHẤT (đúng 5, không
                // phải mọi tier).
                let hemorrhageHealNote = "";
                if (target.hemorrhage === HEMORRHAGE_MAX) {
                  const reduced = Math.floor(regenConsumed / 3);
                  regenConsumed -= reduced;
                  if (reduced > 0) hemorrhageHealNote = ` (Hemorrhage giảm hồi ${reduced})`;
                }
                // Burning Sensation (xác nhận trực tiếp): "giảm 1/2 lượng hồi phục"
                // — áp ĐỘC LẬP với Hemorrhage ở trên (cả 2 cùng có thì cộng dồn).
                if (target.burningSensation) {
                  const reducedBS = Math.floor(regenConsumed / 2);
                  regenConsumed -= reducedBS;
                  if (reducedBS > 0) hemorrhageHealNote += ` (Burning Sensation giảm hồi ${reducedBS})`;
                }
                target.regen -= regenConsumed;
                target.currentHp = Math.min(target.maxHp, target.currentHp + regenConsumed);
                regenHealNote = ` 💚+${regenConsumed} HP (Regen, còn ${target.regen}${hemorrhageHealNote})`;
              }
              const justDied = wasAliveBefore && target.currentHp <= 0;
              // HP Persistence (luật: "HP vẫn giữ nguyên" sau khi encounter kết
              // thúc) — đồng bộ NGAY mỗi lần HP player thay đổi (không chỉ lúc
              // -encounter end, để không mất dữ liệu nếu encounter bị bỏ dở/quên
              // end). Enemy không có profile nên không áp.
              if (targetResolved.type === "player") {
                try {
                  const { data: hpSyncData, slot: hpSyncSlot } = await getPlayerDataWithSlot(t.targetId);
                  hpSyncData.currentHp = target.currentHp;
                  hpSyncData.hpLastResetCheck = Date.now();
                  await savePlayerData(t.targetId, hpSyncData, hpSyncSlot);
                } catch { /* không chặn action chính nếu sync HP lỗi — log đủ rồi bỏ qua */ }
              }
              // Emotion Coin: "Giết 1 kẻ địch cho 3" — CHỈ áp khi target là enemy (PvE)
              // và ATTACKER là player (enemy giết enemy khác hoặc tự mình chết không
              // tính). "Đồng đội bị giết cho 5" — áp cho TẤT CẢ player KHÁC trong
              // encounter khi 1 player chết — giả định mọi player đều là "đồng đội"
              // của nhau (đúng cho PvE chuẩn; với PvP thật giữa 2 player thì coi như
              // không có "đồng đội" nào khác để cộng — không có cách phân biệt
              // team/side rõ ràng hơn trong hệ thống hiện tại nên dùng quy ước này).
              if (justDied) {
                if (targetResolved.type === "enemy" && attacker.type === "player") {
                  applyEmotionDelta(attacker.combatant, 3);
                } else if (targetResolved.type === "player") {
                  for (const otherPid of Object.keys(encounter.players)) {
                    if (otherPid === t.targetId) continue;
                    applyEmotionDelta(encounter.players[otherPid], 5);
                  }
                }
              }
              // Death Penalty — CHỈ player (enemy không có profile để trừ). Detect
              // đúng lúc HP chuyển từ >0 sang ≤0 (không trừ lại nếu ĐÃ chết từ trước
              // mà ăn thêm dmg). Logic THẬT nằm ở applyDeathPenalty (dùng CHUNG với
              // K-Corp Ampule dùng 2 lần liên tiếp — xem -encounter useitem).
              let deathNote = "";
              if (justDied && targetResolved.type === "player") {
                deathNote = await applyDeathPenalty(encounter, t.targetId);
              }
              // 5 status "trên người địch" — áp vào TARGET (bên bị tấn công).
              // QUAN TRỌNG (BUG ĐÃ SỬA): TOÀN BỘ status/Stamina/Charge effect dưới
              // đây trước kia áp VÔ ĐIỀU KIỆN từ t.preview (đã tính sẵn lúc DECLARE,
              // TRƯỚC khi biết Guard/Evade/Parry được dùng lúc CONFIRM) — nghĩa là
              // dù target NÉ HOÀN TOÀN (evadedCompletely=true, 0 dmg thật), Sinking/
              // Rupture/Burn/Bleed/Tremor/Defenseless/Convert Physical Trauma VẪN bị
              // áp như thể đòn trúng 100% — vô lý hoàn toàn (né hoàn toàn = không
              // trúng GÌ CẢ, không chỉ riêng HP). Giờ bọc toàn bộ trong
              // !evadedCompletely — NÉ MỘT PHẦN (M1 nhiều hit, evadedCompletely vẫn
              // false) thì status vẫn áp bình thường (đúng — 1 phần đòn vẫn trúng).
              if (!evadedCompletely) {
                target.sinking = t.preview.finalSinking;
                target.rupture = t.preview.finalRupture;
                // QUAN TRỌNG: dùng burnStacksAfter/bleedStacksAfter (giá trị NGAY SAU
                // gain/consume từ dmgStr, TRƯỚC khi calcMathCore áp công thức "cuối
                // turn") — KHÔNG dùng finalBurn/finalBleed (đã bị giảm nửa SẴN, vì
                // calcMathCore coi MỌI lần gọi là "nếu turn kết thúc NGAY bây giờ").
                // Trước đây dùng finalBurn/finalBleed khiến Burn/Bleed bị giảm nửa
                // NGAY SAU MỖI HIT thay vì chỉ 1 lần thật mỗi -encounter endturn — sai
                // hoàn toàn với luật, và làm hỏng cả Break the Dams/Craving Synergy/
                // Thirst (chúng cần biết bleed CHƯA bị giảm khi check điều kiện). Halving
                // THẬT giờ chỉ xảy ra trong advanceCombatantTurn (xem comment ở đó).
                const lastHitForStatus = t.preview.instanceResults[t.preview.instanceResults.length - 1];
                target.burn = lastHitForStatus?.burnStacksAfter ?? target.burn;
                const bleedBeforeThisHit = target.bleed ?? 0;
                target.bleed = bleedOverride ?? (lastHitForStatus?.bleedStacksAfter ?? target.bleed);
                // Hemorrhage (xác nhận trực tiếp): "+1 stack MỖI LẦN áp Bleed" —
                // phát hiện bằng cách so sánh Bleed TRƯỚC/SAU đòn này (tăng = có áp
                // Bleed mới). Reset check ("không áp Bleed trong 1 turn") xử lý ở
                // turn-advance.js dựa vào hemorrhageAppliedThisTurn.
                if (target.bleed > bleedBeforeThisHit) {
                  target.hemorrhage = Math.min(HEMORRHAGE_MAX, (target.hemorrhage ?? 0) + 1);
                  target.hemorrhageAppliedThisTurn = true;
                }
                target.tremor = t.preview.finalTremor;
                // Haou Sinking (xác nhận trực tiếp): "khi có stack... sẽ bị -1
                // sanity và gây bonus dmg bằng số count MỖI ĐÒN chúng bị tấn công
                // TRONG TURN LÚC -45 sanity HOẶC KHÔNG có sanity" — kiểm tra ĐIỀU
                // KIỆN bằng Sanity TRƯỚC khi đòn này ghi đè (currentSanity vẫn là
                // giá trị CŨ tại đây), nhưng ÁP DỤNG SAU khi finalSanity đã ghi
                // (nếu áp trước, dòng currentSanity=finalSanity ngay sau sẽ ghi đè
                // mất — cùng lỗi thứ tự đã gặp với Contempt of the Gaze trước đó).
                const haouSinkingTriggered = (target.haouSinking ?? 0) > 0 && target.currentSanity <= 0;
                target.currentSanity = t.preview.finalSanity;
                if (haouSinkingTriggered) {
                  target.currentHp = Math.max(0, target.currentHp - target.haouSinking);
                  target.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, target.currentSanity - 1);
                  checkStaggerPanic(target);
                }
                // Tremor Burst rút STAMINA của TARGET (kẻ mang Tremor bị rút Sta).
                if (t.preview.totalTremorStaminaLoss > 0) {
                  target.currentStamina = Math.max(0, target.currentStamina - t.preview.totalTremorStaminaLoss);
                }
                // Tremor Decay/Chain: "giảm 1 count mỗi khi nhận đòn có Tremor
                // Burst" — trừ THẬT theo số lần Tremor Burst thực sự kích hoạt
                // trong đòn này (totalTremorDecayConsumed/totalTremorChainConsumed
                // từ calcMathCore — xem damage-calc.js).
                if ((t.preview.totalTremorDecayConsumed ?? 0) > 0) {
                  target.tremorDecay = Math.max(0, (target.tremorDecay ?? 0) - t.preview.totalTremorDecayConsumed);
                }
                if ((t.preview.totalTremorChainConsumed ?? 0) > 0) {
                  target.tremorChain = Math.max(0, (target.tremorChain ?? 0) - t.preview.totalTremorChainConsumed);
                }
                // Haou Rupture (xác nhận trực tiếp): "Mỗi lần địch chịu 1 đòn tấn
                // công sẽ trừ 1 stack NẾU resistance thấp hơn 1.5x Res" — chỉ tiêu
                // khi thực sự có tác dụng (đã xác định ở preview qua haouRuptureApplied).
                if (t.haouRuptureApplied) {
                  target.haouRupture = Math.max(0, (target.haouRupture ?? 0) - 1);
                }
                // Defenseless (perk của ATTACKER): gây dmg lên target ĐANG có Rupture → -5 Stamina target.
                if (hasPerk(attacker.combatant, "Defenseless") && hadRuptureBeforeHit) {
                  target.currentStamina = Math.max(0, target.currentStamina - 5);
                }
                // Convert Physical Trauma (perk của TARGET/defender): bị tấn công trúng → +1 Charge.
                if (hasPerk(target, "Convert Physical Trauma")) {
                  target.charge = Math.min(CHARGE_MAX, target.charge + 1);
                }
                // Charge Shield (50-Status Nhóm 1) — "biến mất sau mỗi khi bị tấn
                // công" — reset về 0 NGAY SAU KHI đã phát huy tác dụng (đã cộng vào
                // defReductionPct ở trên, TRONG khối !evadedCompletely — né hoàn
                // toàn thì coi như CHƯA thực sự "bị tấn công", giữ nguyên Charge
                // Shield cho lần sau, nhất quán với mọi status khác trong khối này).
                if ((target.chargeShieldStack ?? 0) > 0) target.chargeShieldStack = 0;
                // Charge Shield (50-Status Nhóm 1): "Biến mất sau MỖI KHI bị tấn
                // công" — TOÀN BỘ stack reset về 0 (không phải trừ dần từng đòn),
                // ngay sau khi ĐÃ dùng để giảm dmg đòn NÀY (defReductionPct ở trên
                // đã tính bằng giá trị TRƯỚC khi reset). Nằm trong !evadedCompletely
                // — né hoàn toàn thì không tính là "bị tấn công", Charge Shield giữ
                // nguyên.
                if ((target.chargeShieldStack ?? 0) > 0) target.chargeShieldStack = 0;
                // Eye Of Horus — COMMIT THẬT (khác PEEK lúc declare trong
                // computeAttackerPerkContext) — áp Tremor/Charge KHI action THỰC SỰ
                // được confirm (không phải declare) VÀ KHÔNG bị né hoàn toàn (nằm
                // trong khối !evadedCompletely — "đánh thường" né hoàn toàn thì
                // không tính là đã đánh, nhất quán với mọi status effect khác trong
                // khối này).
                // MÔ HÌNH MỚI (xác nhận trực tiếp, 8 ví dụ N=1..8) — KHÔNG còn
                // counter m1CountThisTurnByTarget nữa (N giờ luôn được cung cấp trực
                // tiếp mỗi hành động, không cộng dồn qua nhiều lần bấm riêng biệt).
                // Tremor gắn lên target (KẺ ĐỊCH), Charge gắn lên bản thân (resource
                // người dùng vũ khí) — amount đã tính SẴN đúng theo N ở
                // computeAttackerPerkContext (2 × tổng số volley thật, bao gồm cả
                // volley Repeat Ammo nếu có).
                if (t.eyeOfHorusTremorChargeAmount > 0 && attacker.type === "player") {
                  target.tremor = Math.min(TREMOR_MAX, (target.tremor ?? 0) + t.eyeOfHorusTremorChargeAmount);
                  eyeOfHorusChargeGainedThisAction += t.eyeOfHorusTremorChargeAmount;
                }
                // Nails (50-Status Nhóm 2, xác nhận trực tiếp): "mỗi đòn kẻ thù
                // NHẬN sẽ nhận thêm số Bleed bằng số count Nails, mỗi lần nhận 1
                // đòn giảm 1/3 count Nails" — 1 ĐÒN (action), không phải mỗi hit —
                // dùng floor(count/3) theo đúng nghĩa đen "1/3 số count" (count
                // nhỏ 1-2 sẽ chưa giảm cho tới khi tích đủ 3, chấp nhận được vì
                // không có mô tả riêng cho trường hợp nhỏ).
                if ((target.nails ?? 0) > 0) {
                  target.bleed = Math.min(BLEED_MAX, (target.bleed ?? 0) + target.nails);
                  target.nails = Math.max(0, target.nails - Math.floor(target.nails / 3));
                }
                // Red Plum Blossom (50-Status Nhóm 2, xác nhận trực tiếp): "nếu
                // Critical sẽ gắn 1 Bleed lên kẻ địch [mang Red Plum Blossom],
                // giảm 1 Count" — dùng lastHitForStatus.didCrit (đòn CUỐI của
                // action này — nhất quán với cách đọc burn/bleed stacks ở trên).
                if ((target.redPlumBlossom ?? 0) > 0 && lastHitForStatus?.didCrit) {
                  target.bleed = Math.min(BLEED_MAX, (target.bleed ?? 0) + 1);
                  target.redPlumBlossom = Math.max(0, target.redPlumBlossom - 1);
                }
                // Fairy (50-Status Nhóm 2, xác nhận trực tiếp): "trừ HP = count/3
                // MỖI Action" — giả định (đã nêu ở combatant-factory.js): "mỗi
                // Action" = mỗi lần CHÍNH attacker (người mang Fairy) hành động —
                // tự trừ HP BẢN THÂN, KHÔNG liên quan tới target đang đánh. Đặt
                // trong loop targets.map nên với AOE nhiều target CÙNG 1 action sẽ
                // CHỈ tính đúng 1 lần cho action đó — kiểm tra targetIdx===0 để
                // tránh trừ lặp lại theo số target.
                if (p.targets.indexOf(t) === 0 && (attacker.combatant.fairy ?? 0) > 0) {
                  attacker.combatant.currentHp = Math.max(0, attacker.combatant.currentHp - Math.floor(attacker.combatant.fairy / 3));
                }
                // Ammo system — Frost/Incendiary Ammo (xác nhận trực tiếp): "Frost
                // Ammo: gây 1 Paralyze. Incendiary Ammo: gây 2 Burn." — áp lên
                // TARGET đang bị bắn, CHỈ khi đòn thực sự trúng (không evaded hoàn
                // toàn — kiểm tra ở ngoài khối này qua !evadedCompletely).
                if (p.effectiveAmmoType === "frost") {
                  target.paralyze = Math.min(99, (target.paralyze ?? 0) + 1);
                } else if (p.effectiveAmmoType === "incendiary") {
                  target.burn = Math.min(BURN_MAX, (target.burn ?? 0) + 2);
                }
                // Set Fire (Page): "đòn đánh thường sẽ áp 1/2/4 [Light/Medium/Heavy]
                // Burn... mỗi lần trúng" — CHỈ áp cho M1 (p.isM1), KHÔNG áp cho Page/
                // skill khác. BUG ĐÃ SỬA: "mỗi lần trúng" nghĩa là MỖI HIT (không
                // phải mỗi ACTION) — code cũ chỉ cộng burnAmount ĐÚNG 1 LẦN dù M1 có
                // bao nhiêu hit (vì nằm trong for loop TARGET, không phải loop HIT) —
                // giống lớp bug tôi từng sửa cho Eye Of Horus's Repeat Ammo — giờ
                // nhân theo hitCount (số hit THẬT của target này trong action). Nằm
                // trong khối !evadedCompletely — né hoàn toàn thì không tính là đã
                // đánh trúng, không áp Burn (nhất quán với mọi status effect khác).
                if (p.isM1 && attacker.type === "player" && (attacker.combatant.setFireTurnsLeft ?? 0) > 0) {
                  const burnPerHit = { light: 1, medium: 2, heavy: 4 }[attacker.combatant.weaponWeight] ?? 1;
                  target.burn = Math.min(BURN_MAX, (target.burn ?? 0) + burnPerHit * hitCount);
                }
              }
              checkStaggerPanic(target);
              // BUG ĐÃ SỬA (xác nhận trực tiếp): "Điều kiện Injury là 1 HIT phải
              // vượt qua 30% Max HP" — trước đây SO SÁNH SAI: dùng `finalDmg`
              // (TỔNG cả đòn, gồm nhiều hit) thay vì TỪNG HIT RIÊNG LẺ — VD "3x10"
              // (10 hit, mỗi hit 3 dmg) lên target 60 HP: finalDmg=30 (>18=30%
              // MaxHp) → SAI trigger Injury dù mỗi hit CHỈ 3 dmg (thấp hơn NHIỀU
              // so với 18). Đúng phải lấy dmg hit LỚN NHẤT trong đòn này để so
              // sánh — nếu KHÔNG có hit nào đơn lẻ vượt ngưỡng, dù tổng cả đòn có
              // lớn tới đâu vẫn KHÔNG trigger.
              const maxSingleHitDmg = Math.max(0, ...(t.preview.instanceResults ?? []).map(r => r.instanceDmg ?? 0));
              const injuryGained = (killNote || deathNote) ? null : rollInjury(target, maxSingleHitDmg);
              const injuryNote = injuryGained ? ` 🩻**${injuryGained}**` : "";
              // Injury Persistence — sync NGAY vào profile mỗi khi player nhận chấn
              // thương MỚI (giống cách HP sync ở trên) — không đợi -encounter end,
              // tránh mất dữ liệu nếu trận bị bỏ dở/quên end.
              if (injuryGained && targetResolved.type === "player") {
                try {
                  const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(t.targetId);
                  injSyncData.injuries = [...target.injuries];
                  await savePlayerData(t.targetId, injSyncData, injSyncSlot);
                } catch { /* không chặn action chính nếu sync injury lỗi */ }
              }
              targetDmgLines.push(`${targetResolved.label} -${finalDmg.toFixed(3)} HP${killNote}${deathNote}${defenseNote}${perkNote}${injuryNote}${eyeOfHorusNote}${regenHealNote}${timeMoratoriumNote}`);
            }
            // 2 status "trên bản thân" — áp vào ATTACKER. Với AOE (nhiều target),
            // mỗi target preview tính crit ĐỘC LẬP nên finalPoiseStacks/finalCharge
            // có thể khác nhau giữa các target — LẤY target ĐẦU TIÊN làm đại diện
            // (đơn giản hoá có chủ đích, vì luật không nói rõ Poise tính sao khi 1
            // swing AOE trúng nhiều địch — báo với GM nếu cần khác đi).
            if (p.targets.length > 0) {
              const firstPreview = p.targets[0].preview;
              // Smoke Overload: crit trúng KHÔNG giảm Poise ngay — dồn lại
              // (poiseReductionPending), trừ thật lúc end turn (xem advanceCombatantTurn).
              // Tính phần ĐÃ bị calcMathCore giảm (poiseAfterGain - poiseStacksAfter
              // mỗi hit có crit) rồi CỘNG TRẢ LẠI cho Poise ngay bây giờ, dồn phần đó
              // vào pending để trừ sau — thay vì sửa calcMathCore (tránh đụng logic
              // dùng chung cho /math thường).
              if (hasPerk(attacker.combatant, "Smoke Overload")) {
                const totalReducedThisAction = firstPreview.instanceResults.reduce(
                  (sum, r) => sum + Math.max(0, (r.poiseAfterGain ?? 0) - (r.poiseStacksAfter ?? 0)), 0
                );
                attacker.combatant.poise = Math.min(POISE_MAX, firstPreview.finalPoiseStacks + totalReducedThisAction);
                attacker.combatant.poiseReductionPending = (attacker.combatant.poiseReductionPending ?? 0) + totalReducedThisAction;
              } else {
                attacker.combatant.poise = firstPreview.finalPoiseStacks;
              }
              attacker.combatant.charge = firstPreview.finalCharge;
              // Eye Of Horus — cộng THÊM (không ghi đè) SAU dòng gán finalCharge ở
              // trên — xem comment đầy đủ tại chỗ khai báo eyeOfHorusChargeGainedThisAction.
              if (eyeOfHorusChargeGainedThisAction > 0) {
                attacker.combatant.charge = Math.min(CHARGE_MAX, attacker.combatant.charge + eyeOfHorusChargeGainedThisAction);
              }
            }
            // Bleed — "1 bleed count trên người địch sẽ gây dmg bằng 1/4 count mỗi
            // khi kẻ địch hành động tấn công trong turn" — áp dụng cho CHÍNH người
            // ĐANG TẤN CÔNG (attacker) ở action này, nếu HỌ đang mang Bleed — không
            // liên quan gì tới target. Áp dụng cho MỌI loại tấn công (attack/hit/
            // enemyattack), KHÔNG riêng M1, vì luật chỉ nói "hành động tấn công" nói
            // chung. Count KHÔNG đổi ở đây (chỉ giảm nửa lúc end turn thật).
            let bleedSelfNote = "";
            if ((attacker.combatant.bleed ?? 0) > 0) {
              // Sizzling Wound: "+50% Dmg từ Burn và Bleed" — nhân vào đây tương tự Burn.
              // Hemorrhage (xác nhận trực tiếp): "Bleed khi gây dmg sẽ /3|/2|x1|
              // x1.5|x2" theo tier 1-5 — nhân thêm vào công thức Bleed tự gây dmg.
              const HEMORRHAGE_BLEED_MULT = { 0: 1, 1: 1 / 3, 2: 1 / 2, 3: 1, 4: 1.5, 5: 2 };
              const hemorrhageMult = HEMORRHAGE_BLEED_MULT[attacker.combatant.hemorrhage ?? 0] ?? 1;
              const bleedSelfDmg = Math.floor((attacker.combatant.bleed / 4) * (attacker.combatant.sizzlingWound ? 1.5 : 1) * hemorrhageMult);
              if (bleedSelfDmg > 0) {
                attacker.combatant.currentHp = Math.max(0, attacker.combatant.currentHp - bleedSelfDmg);
                checkStaggerPanic(attacker.combatant);
                bleedSelfNote = ` [🩸Bleed tự gây ${bleedSelfDmg} dmg lên ${attacker.label}]`;
              }
            }
            // Haou Bleed (xác nhận trực tiếp): "Gây Dmg cho kẻ địch dựa vào số
            // count mỗi khi CHÚNG hành động" — tự gây dmg = FULL count (KHÔNG /4
            // như Bleed thường, mô tả gốc không nhắc chia) mỗi khi CHÍNH kẻ mang
            // Haou Bleed hành động — cùng vị trí commit với Bleed thường.
            if ((attacker.combatant.haouBleed ?? 0) > 0) {
              const haouBleedSelfDmg = attacker.combatant.haouBleed;
              attacker.combatant.currentHp = Math.max(0, attacker.combatant.currentHp - haouBleedSelfDmg);
              checkStaggerPanic(attacker.combatant);
              bleedSelfNote += ` [🩸Haou Bleed tự gây ${haouBleedSelfDmg} dmg lên ${attacker.label}]`;
            }
            // Battle Ignition/Overbearing/Blessed Sparks: đếm M1 (chỉ attack mới có
            // p.isM1=true, hit/Page không tính). 2 counter TÁCH BIỆT, đếm KHÁC kiểu:
            //   - attacksThisTurn (Battle Ignition, "đánh kẻ địch ≥10 LẦN"): đếm theo
            //     HIT THẬT (xác nhận trực tiếp từ GM) — dùng totalHitsThisAction (tích
            //     luỹ TRONG vòng for ở trên, qua MỌI target nếu AOE) — BUG ĐÃ SỬA 2
            //     LẦN: (1) trước đây +1 mỗi LƯỢT TARGET trong vòng lặp thay vì +N hit
            //     thật; (2) lần sửa đầu tiên dùng biến `hitCount` nhưng đặt code Ở
            //     NGOÀI scope của vòng for (const t of p.targets) — gây lỗi runtime
            //     "hitCount is not defined" mỗi lần confirm M1 — giờ dùng
            //     totalHitsThisAction (khai báo TRƯỚC vòng for, cộng dồn ĐÚNG TRONG
            //     vòng for, đọc lại AN TOÀN ở NGOÀI vòng for).
            //   - m1AttackCount (Overbearing/Blessed Sparks, "mỗi đòn đánh thường thứ
            //     2"): GIỮ NGUYÊN đếm theo ACTION (+1/toàn action, không nhân theo
            //     target/hit) — luật dùng từ "đòn" (1 lượt ra tay), KHÁC "lần" của
            //     Battle Ignition, và KHÔNG được GM xác nhận đổi sang hit-based, nên
            //     giữ behavior cũ.
            // PHẢI ĐẶT SAU khối gán Poise/Charge từ preview phía trên — trước đây đặt
            // TRƯỚC nên bị preview ghi đè mất ngay, Overbearing/Blessed Sparks không
            // bao giờ thấy hiệu lực thật.
            if (p.isM1 && attacker.type === "player") {
              attacker.combatant.attacksThisTurn = (attacker.combatant.attacksThisTurn ?? 0) + totalHitsThisAction;
              attacker.combatant.m1AttackCount = (attacker.combatant.m1AttackCount ?? 0) + 1;
              if (attacker.combatant.m1AttackCount % 2 === 0) {
                const poiseGain = { light: 1, medium: 2, heavy: 4 }[attacker.combatant.weaponWeight];
                if (hasPerk(attacker.combatant, "Overbearing")) {
                  attacker.combatant.poise = Math.min(POISE_MAX, attacker.combatant.poise + poiseGain);
                }
                if (hasPerk(attacker.combatant, "Blessed by the Sparks")) {
                  attacker.combatant.charge = Math.min(CHARGE_MAX, attacker.combatant.charge + poiseGain);
                }
              }
            }
            checkStaggerPanic(attacker.combatant);

            // skill:/ref: verify — set cooldown + áp Emotion Coin delta THẬT lúc
            // confirm (xem comment đầy đủ ở resolveSkillVerification/doPlayerAttack).
            // QUAN TRỌNG: counter nội bộ = cooldownTurns + 1 (KHÔNG phải đúng số CD
            // ghi trên skill) — vì luật xác nhận: "CD 2 Turn" dùng ở Turn 1 thì Turn
            // 2 PHẢI còn hiện "còn 2 turn" (chưa giảm gì), Turn 3 mới hiện "còn 1",
            // Turn 4 mới dùng lại được — nghĩa là lượt CHÍNH NÓ được cast (Turn 1)
            // không tính là 1 lần giảm. Dùng cùng logic giảm-mỗi-endturn như cũ
            // (advanceCombatantTurn) nhưng counter khởi tạo dư thêm 1 thì ra đúng số
            // turn hiển thị. Text hiển thị NGAY LÚC NÀY vẫn dùng cooldownTurns gốc
            // (đúng số ghi trên skill), CHỈ giá trị lưu nội bộ mới +1.
            let verifyNote = "";
            if (p.skillKey && p.cooldownTurns > 0) {
              attacker.combatant.skillCooldowns = attacker.combatant.skillCooldowns ?? {};
              attacker.combatant.skillCooldowns[p.skillKey] = p.cooldownTurns + 1;
              verifyNote += ` [CD ${p.skillKey}: ${p.cooldownTurns}T]`;
            }
            // Set Fire — Page tự buff (không dice, không nhắm target thật) — kích
            // hoạt NGAY khi skill confirm thành công, KHÔNG phụ thuộc evadedCompletely
            // (đây không phải đòn tấn công lên target, tương tự Light Dash/Tactical
            // Suppression). 3 turn tự áp Burn theo weaponWeight lên M1 — xem logic
            // ÁP DỤNG THẬT ở khối xử lý M1 (tìm "setFireTurnsLeft") và đếm ngược ở
            // advanceCombatantTurn.
            if (p.skillKey === "set fire") {
              attacker.combatant.setFireTurnsLeft = 3;
              verifyNote += ` 🔥 Vũ khí bốc cháy trong 3 turn!`;
            }
            if (p.emotionDelta) {
              const levelNotes = applyEmotionDelta(attacker.combatant, p.emotionDelta);
              verifyNote += ` [Coin ${p.emotionDelta >= 0 ? "+" : ""}${p.emotionDelta}]`;
              if (levelNotes.length > 0) verifyNote += " " + levelNotes.join(" ");
            }

            resultLines.push(`${attacker.label}${staminaNote}${verifyNote}${bleedSelfNote} → ${targetDmgLines.join(", ")} (\`${p.dmgStr}\`)`);

  return resultLines;
}

/** sendReactiveDefensePrompt — Yu-Gi-Oh Chain-style: khi A tấn công B, gửi NGAY
 *  1 message với nút phòng thủ cho B (xác nhận trực tiếp: "khi bị tấn công thì
 *  mới hiện ra hành động phòng thủ... check coi đủ sta để làm hành động đó
 *  không"). Dùng customId (KHÔNG dùng collector) — pendingAction vẫn nằm trong
 *  Redis nên nút vẫn hoạt động dù bot restart giữa chừng (đợi "vô thời hạn" một
 *  cách AN TOÀN, không cần giữ 1 Promise treo trong bộ nhớ process).
 *  targetUserId=null nghĩa là target là ENEMY (GM bấm thay) — vẫn gửi prompt
 *  nhưng filter cho phép GM/admin bấm thay vì đúng targetUserId. */
/** announceCurrentTurn — Turn Order Enforcement UX (xác nhận trực tiếp): "lúc
 *  xong endturn thì encounter nên tự cập nhật lại để player bấm tiếp" — TỰ ĐỘNG
 *  gửi dropdown hành động cho ĐÚNG người/enemy đang tới lượt, thay vì bắt họ tự
 *  gõ `-encounter status` lại để lấy dropdown mới mỗi lần. Player → gửi trong
 *  kênh encounter (mention họ). Enemy → route tới gmChannelId nếu đã link (GM
 *  điều khiển thay), cùng logic routing với sendReactiveDefensePrompt. Không
 *  throw gì cả — lỗi gửi message không nên làm hỏng flow chính (fire-and-forget). */
/** performEndTurn — TÁCH từ thân lệnh text `-encounter endturn` (giữ NGUYÊN 100%
 *  logic không đổi 1 dòng nào) — dùng LẠI được cho CẢ lệnh text LẪN nút bấm UI
 *  mới "🔄 Kết thúc Turn" (xem announceCurrentTurn/handler customId "encendturn:").
 *  Throw Error nếu không hợp lệ (không có quyền, còn pending action...) — CALLER
 *  tự bắt và hiển thị theo cách phù hợp (reply text hay update embed nút bấm). */
async function performEndTurn(channelId, userId, isAdmin) {
  let resultInfo;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    if (!isAdmin && userId !== encounter.gmId) throw new Error("Chỉ GM (hoặc admin) mới được kết thúc turn.");
    if ((encounter.pendingActions ?? []).length > 0) throw new Error(`Còn ${encounter.pendingActions.length} action chưa xử lý — dùng \`-encounter pending\` để confirm/reject hết trước khi qua turn.`);
    const anyEnemyStaggered = Object.values(encounter.enemies).some(e => e.staggered);
    const shroudedNotes = [];
    if (anyEnemyStaggered) {
      for (const pid of Object.keys(encounter.players)) {
        const pl = encounter.players[pid];
        if (hasPerk(pl, "Shrouded Power")) {
          pl.poise = Math.min(POISE_MAX, pl.poise + 4);
          shroudedNotes.push(`<@${pid}> +4 Poise (Shrouded Power)`);
        }
      }
    }
    for (const ekey of Object.keys(encounter.enemies)) advanceCombatantTurn(encounter.enemies[ekey]);
    for (const pid of Object.keys(encounter.players)) advanceCombatantTurn(encounter.players[pid]);
    encounter.turnNumber = (encounter.turnNumber ?? 1) + 1;
    if (Object.keys(encounter.enemies).length + Object.keys(encounter.players).length > 0) {
      determineTurnOrder(encounter);
    }
    await saveEncounter(channelId, encounter);
    announceCurrentTurn(channelId, encounter).catch(() => {});
    resultInfo = { encounter, shroudedNotes };
  });
  return resultInfo;
}

async function announceCurrentTurn(channelId, encounter) {
  try {
    const order = encounter.turnOrder ?? [];
    const entry = order[encounter.currentTurnIndex ?? 0];
    if (!entry) {
      // Turn Order Enforcement UX (xác nhận trực tiếp): "không có nút end turn
      // các thứ như 1 game rpg thực thụ" — hết 1 vòng turnOrder, thay vì im lặng
      // (bắt GM tự nhớ gõ lệnh text), gửi NGAY 1 nút bấm rõ ràng cho GM.
      const targetChannelId = encounter.gmChannelId || channelId;
      const channel = await client.channels.fetch(targetChannelId).catch(() => null);
      if (!channel) return;
      await channel.send({
        content: `<@${encounter.gmId}>`,
        embeds: [{ title: "🔄 Hết 1 vòng Turn Order!", description: "Mọi người đã hành động xong — bấm để kết thúc turn (hồi Stamina, đếm ngược status, roll lại Speed):", color: 0x9b59b6 }],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`encendturn:${channelId}:${encounter.gmId}`).setLabel("🔄 Kết thúc Turn").setStyle(ButtonStyle.Success),
        )],
      }).catch(() => {});
      return;
    }
    if (entry.type === "player") {
      const player = encounter.players[entry.id];
      if (!player || player.currentHp <= 0) return;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) return;
      await channel.send({
        content: `<@${entry.id}>`,
        embeds: [{ title: "🎲 Tới lượt bạn!", description: `Speed **${entry.speed}** — chọn hành động:`, color: 0x3498db }],
        components: buildEncounterActionPanel(channelId, player, entry.id),
      }).catch(() => {});
    } else {
      const enemy = encounter.enemies[entry.id];
      if (!enemy || enemy.currentHp <= 0) return;
      const targetChannelId = encounter.gmChannelId || channelId;
      const channel = await client.channels.fetch(targetChannelId).catch(() => null);
      if (!channel) return;
      await channel.send({
        content: `<@${encounter.gmId}>`,
        embeds: [{ title: `🎲 Tới lượt ${enemy.name}!`, description: `Speed **${entry.speed}** — chọn hành động:`, color: 0xe74c3c }],
        components: buildBossActionPanel(channelId, entry.id, encounter.gmId),
      }).catch(() => {});
    }
  } catch (err) {
    log("error", "announceCurrentTurn", "system", err.message);
  }
}

async function sendReactiveDefensePrompt(channelId, pendingId) {
  try {
    const encounter = await getEncounter(channelId);
    if (!encounter) return;
    const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
    if (!p) return; // đã bị xử lý/xoá trước đó (VD GM lỡ tay confirm cả loạt)
    const attacker = resolveCombatant(encounter, p.attackerId);
    if (!attacker) return;
    const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
    const attackerWeapon = attacker.combatant.weaponWeight ?? "medium";
    const bypass = p.defenseBypass ?? {};

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    // AOE nhiều target — MỖI target 1 prompt riêng (mỗi người tự quyết định
    // phòng thủ của mình, độc lập với người khác).
    for (const t of p.targets) {
      const targetResolved = resolveCombatant(encounter, t.targetId);
      if (!targetResolved) continue;
      const target = targetResolved.combatant;
      const hitCount = Math.max(1, t.preview?.dmgValues?.length ?? 1);
      const opts = computeDefenseOptions(target, attackerWeapon, hitCount, isM1Type, bypass);

      // Enemy target (player tấn công enemy): route reactive prompt TỚI kênh GM
      // control panel nếu đã link (`-encounter linkgm`) — enemy không có tài
      // khoản Discord riêng nên GM luôn là người bấm thay, hợp lý gửi thẳng vào
      // "buồng lái" của GM thay vì kênh encounter chính (tránh trôi chat encounter
      // NGƯỢC LẠI với lý do tách kênh ban đầu).
      const isEnemyTarget = targetResolved.type === "enemy";
      let sendChannel = channel;
      let mentionText = `<@${t.targetId}>`;
      if (isEnemyTarget) {
        mentionText = `<@${encounter.gmId}>`;
        if (encounter.gmChannelId) {
          const gmChannel = await client.channels.fetch(encounter.gmChannelId).catch(() => null);
          if (gmChannel) sendChannel = gmChannel;
        }
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:guard`)
          .setLabel(`🛡️ Guard (-${opts.guard.cost} Sta)`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!opts.guard.available),
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:evade`)
          .setLabel(`💨 Evade (-${opts.evade.cost} Sta)`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!opts.evade.available),
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:parry`)
          .setLabel(`🗡️ Parry (miễn phí, rủi ro)`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!opts.parry.available),
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:none`)
          .setLabel(`❌ Không phòng thủ`)
          .setStyle(ButtonStyle.Danger),
      );

      const dmgPreview = t.preview?.totalDmg?.toFixed(3) ?? "?";
      await sendChannel.send({
        content: mentionText,
        embeds: [{
          title: "⚔️ Đang bị tấn công!",
          description: `${attacker.label} tấn công ${targetResolved.label} với \`${p.dmgStr}\` (${hitCount} hit, dự kiến **${dmgPreview}** dmg nếu không phòng thủ)\n> ${isEnemyTarget ? "Enemy" : "Bạn"} có **${target.currentStamina} Stamina**. Chọn phòng thủ:`,
          color: 0xe67e22,
          footer: { text: opts.evade.blockedReason ? `Evade bị khoá: ${opts.evade.blockedReason}` : (isEnemyTarget ? "" : "GM cũng có thể bấm thay nếu bạn không phản hồi được.") },
        }],
        components: [row],
      }).catch(() => {});
    }
  } catch (err) {
    log("error", "sendReactiveDefensePrompt", "system", err.message);
  }
}

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

  // ── Nút xem thông tin item (từ select menu inventory) ──
  if (interaction.customId.startsWith("invinfo:")) {
    const parts = interaction.customId.split(":");
    const targetUserId = parts[1];
    const itemType = parts[2];
    const itemName = parts.slice(3).join(":");
    try {
      const infoMap = {
        "Random Book": "Mở ra 1 sách ngẫu nhiên từ pool thường.",
        "Sealed Book Cache": "Mở ra 1 sách hiếm ngẫu nhiên từ pool sealed.",
        "Chipboard Cache": "Mở ra Chipboard MK1–MK3 ngẫu nhiên.",
      };
      const recipe = CRAFT_RECIPES[itemName];
      let desc = infoMap[itemName] ?? `${itemType === "book" ? "📚 Sách" : "🔩 Vật phẩm"}: **${itemName}**`;
      if (recipe) {
        const inputs = Object.entries(recipe.inputs).map(([k, v]) => `${v}× ${k}`).join(", ");
        const outputs = Object.entries(recipe.output).map(([k, v]) => `${v}× ${k}`).join(", ");
        desc += `\n> 🔨 Craft: ${inputs} → ${outputs}`;
      }
      const data = await getPlayerData(targetUserId);
      const store = itemType === "book" ? (data.books ?? {}) : (data.items ?? {});
      const count = store[itemName] ?? 0;
      await interaction.reply({
        embeds: [{ title: itemName, description: desc, color: 0x5865f2, footer: { text: `Số lượng trong kho: ${count}` } }],
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      log("error", "invinfo button", interaction.user?.id ?? "unknown", err.message);
      interaction.reply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // ── Nút Mở (sách) / Craft (item) — từ select menu inventory ──
  // ── Nút "📚 Đọc" — từ select menu inventory, CHỈ cho sách có trong BOOK_GRANTS
  // (khác invact's "Mở" dành cho Random Book/Sealed Book Cache/Chipboard Cache).
  if (interaction.customId.startsWith("invread:")) {
    const parts = interaction.customId.split(":");
    const targetUserId = parts[1];
    // BUG ĐÃ SỬA (phát hiện qua test thật, không phải chỉ đọc code): customId chứa
    // TÊN SÁCH ĐÃ encodeURIComponent (xem nơi tạo nút, dòng ~8335 `invread:...:
    // ${itemName}` — itemName ở ĐÓ CHÍNH LÀ tên đã encode) — nhưng handler này
    // ĐỌC THẲNG RAW, KHÔNG decodeURIComponent lại, khiến MỌI tên sách có khoảng
    // trắng (gần như toàn bộ — VD "Library Book" → "Library%20Book") tra sai key
    // trong inventory, LUÔN báo "không còn trong inventory" dù sách THẬT SỰ CÓ.
    const bookName = decodeURIComponent(parts.slice(3).join(":")); // parts[2] luôn là "book" ở đây, bỏ qua
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: "⚠️ Đây không phải inventory của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (isOnCooldown(interaction.user.id, "invread", 2000)) {
      return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const { data: profileData } = await getPlayerDataWithSlot(targetUserId);
      const owned = profileData.books?.[bookName] ?? 0;
      if (owned < 1) { return interaction.reply({ content: `❌ Không còn **${bookName}** trong inventory.`, flags: MessageFlags.Ephemeral }).catch(() => {}); }
      await interaction.reply({ ...buildBookChoiceComponents(targetUserId, bookName, owned), flags: MessageFlags.Ephemeral });
    } catch (err) {
      await interaction.reply({ content: `❌ ${err.message ?? "Có lỗi xảy ra."}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("invact:")) {
    const parts = interaction.customId.split(":");
    const targetUserId = parts[1];
    const itemType = parts[2];
    const itemName = parts.slice(3).join(":");
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: "⚠️ Đây không phải inventory của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    // Mọi command khác (prefix + slash) đều có cooldown qua isOnCooldown — button này
    // ban đầu thiếu, cho phép spam-click dồn áp lực lên Redis qua withLock retry.
    if (isOnCooldown(interaction.user.id, "invact", 2000)) {
      return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (itemType === "book") {
        const handlerMap = {
          "Random Book": () => handleOpenRandomBook(targetUserId, 1),
          "Sealed Book Cache": () => handleOpenSealedBook(targetUserId, 1),
          "Chipboard Cache": () => handleOpenChipboardCache(targetUserId, 1),
        };
        const handler = handlerMap[itemName];
        if (!handler) { await interaction.editReply({ content: "❌ Không thể mở loại sách này." }); return; }
        const { success, data, results } = await handler();
        if (!success) { await interaction.editReply({ content: `❌ Không có **${itemName}** trong kho.` }); return; }
        await interaction.editReply({ content: `✅ Mở **${itemName}** → nhận được **${results[0]}**!\n> Còn lại: ${data.books[itemName] ?? 0}` });
      } else {
        if (!CRAFT_RECIPES[itemName]) { await interaction.editReply({ content: "❌ Vật phẩm này không thể craft." }); return; }
        // Tách interaction.editReply ra ngoài withLock — nếu Discord API chậm, lock
        // TTL có thể hết hạn trong khi vẫn đang giữ lock. executeCraft chỉ cần Redis.
        const { outputLines, costLines } = await withLock(targetUserId, () =>
          executeCraft(targetUserId, itemName, 1)
        );
        await interaction.editReply({ content: `✅ Craft thành công!\n${costLines.join("\n")}\n→ ${outputLines.join(", ")}` });
      }
    } catch (err) {
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra."}` });
    }
    return;
  }

  // ── Nút Xóa 1 — từ select menu inventory ──
  if (interaction.customId.startsWith("invdel:")) {
    const parts = interaction.customId.split(":");
    const targetUserId = parts[1];
    const itemType = parts[2];
    const itemName = parts.slice(3).join(":");
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: "⚠️ Đây không phải inventory của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (isOnCooldown(interaction.user.id, "invdel", 2000)) {
      return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const bookEntries = itemType === "book" ? [{ name: itemName, count: 1 }] : [];
      const itemEntries = itemType === "item" ? [{ name: itemName, count: 1 }] : [];
      await withLock(targetUserId, () => executeRemove({
        actorId: targetUserId, targetId: targetUserId,
        isAdmin: false, expRemove: 0, ahnRemove: 0, bookEntries, itemEntries,
      }));
      await interaction.editReply({ content: `🗑️ Đã xóa **1× ${itemName}** khỏi kho.` });
    } catch (err) {
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra."}` });
    }
    return;
  }

  // ── Nút chuyển profile (từ /profile info hoặc -profile info) ──
  if (interaction.customId.startsWith("profswitch:")) {
    const [, targetUserId, slotStr] = interaction.customId.split(":");
    const slot = parseInt(slotStr, 10);
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: "⚠️ Chỉ chủ nhân mới có thể đổi profile.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (isOnCooldown(interaction.user.id, "profswitch", 1500)) {
      return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 1.5 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      await setActiveProfileSlot(targetUserId, slot);
      // Rebuild embed để nút của slot mới được disable đúng (đang dùng) và phản ánh data mới.
      const { embed, components } = await buildProfileInfoEmbed(
        targetUserId,
        interaction.user.displayName ?? interaction.user.username,
        `Dùng -profile switch <1-${MAX_PROFILES}> hoặc bấm nút bên dưới để đổi profile`
      );
      await interaction.update({ embeds: [embed], components });
    } catch (err) {
      log("error", "profswitch button", interaction.user?.id ?? "unknown", err.message);
      interaction.reply({ content: "❌ Có lỗi xảy ra khi chuyển profile.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // ── Nút Xác nhận /give ──
  if (interaction.customId.startsWith("giveconfirm:")) {
    const giveId = interaction.customId.slice("giveconfirm:".length);
    const pending = pendingGives.get(giveId);
    if (!pending) {
      return interaction.update({ content: "⚠️ Giao dịch đã hết hạn hoặc đã được xử lý.", embeds: [], components: [] }).catch(() => {});
    }
    if (interaction.user.id !== pending.senderId) {
      return interaction.reply({ content: "⚠️ Chỉ người tạo lệnh /give mới được xác nhận.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    pendingGives.delete(giveId);
    await interaction.deferUpdate();
    try {
      const { senderId, targetId, isAdmin, params } = pending;
      const runGive = () => executeGive({ senderId, targetId, isAdmin, ...params });
      const changes = await withDoubleLock(senderId, targetId, runGive);
      await interaction.editReply({
        content: `✅ <@${senderId}> đã ${isAdmin ? "tặng" : "chuyển"} cho <@${targetId}>:\n` + changes.map(c => `> ${c}`).join("\n"),
        embeds: [], components: [],
      });
    } catch (err) {
      log("error", "giveconfirm button", interaction.user?.id ?? "unknown", err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}`, embeds: [], components: [] }).catch(() => {});
    }
    return;
  }

  // ── Nút Hủy /give ──
  if (interaction.customId.startsWith("givecancel:")) {
    const giveId = interaction.customId.slice("givecancel:".length);
    const pending = pendingGives.get(giveId);
    if (pending && interaction.user.id !== pending.senderId) {
      return interaction.reply({ content: "⚠️ Chỉ người tạo lệnh /give mới được hủy.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    pendingGives.delete(giveId);
    await interaction.update({ content: "❌ Đã hủy giao dịch.", embeds: [], components: [] }).catch(() => {});
    return;
  }

  // (Nút action panel cũ "encact:" đã bỏ — thay bằng dropdown "encmenu:", xem
  // listener riêng "SELECT MENU INTERACTIONS (encounter)" phía dưới.)


  if (interaction.customId.startsWith("encconfirmall:") || interaction.customId.startsWith("encrejectall:")) {
    const isConfirm = interaction.customId.startsWith("encconfirmall:");
    const channelId = interaction.customId.slice((isConfirm ? "encconfirmall:" : "encrejectall:").length);
    try {
      await withLock(encounterKey(channelId), async () => {
        const encounter = await getEncounter(channelId);
        if (!encounter || (encounter.pendingActions ?? []).length === 0) {
          return interaction.reply({ content: "⚠️ Không có action nào chờ xác nhận (có thể đã xử lý rồi).", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const isAdmin = ADMIN_IDS.has(interaction.user.id);
        if (!isAdmin && interaction.user.id !== encounter.gmId) {
          return interaction.reply({ content: "⚠️ Chỉ GM tạo encounter này (hoặc admin khác) mới được xác nhận/từ chối.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const resultLines = [];
        if (isConfirm) {
          // QUAN TRỌNG: đây là lúc DUY NHẤT state thật của encounter bị thay đổi —
          // lúc declare (-encounter attack/hit/enemyattack) chỉ TÍNH TRƯỚC (preview),
          // không áp dụng gì cả. Xử lý TUẦN TỰ từng pending action theo đúng thứ tự
          // đã declare (FIFO) — quan trọng vì action sau có thể phụ thuộc trạng thái
          // (HP/status) do action trước vừa đổi (VD: 2 player cùng đánh 1 enemy).
          for (const p of encounter.pendingActions) {
            const lines = await resolveOnePendingAction(encounter, p);
            resultLines.push(...lines);
          }
        } else {
          for (const p of encounter.pendingActions) {
            const attacker = resolveCombatant(encounter, p.attackerId);
            resultLines.push(`${attacker?.label ?? p.attackerId} (\`${p.dmgStr}\`) — đã reject`);
          }
        }

        // Ghi vào actionLog (xem -encounter log) — lưu NGUYÊN VĂN resultLines (full
        // detail, đúng những gì vừa hiện trong embed confirm) kèm Turn number lúc
        // ghi. Cap 100 entries gần nhất (drop entry CŨ NHẤT khi vượt) — tránh phình
        // vô hạn dữ liệu lưu trên Redis qua trận dài.
        if (resultLines.length > 0) {
          encounter.actionLog = encounter.actionLog ?? [];
          encounter.actionLog.push({
            turn: encounter.turnNumber ?? 1,
            type: isConfirm ? "confirm" : "reject",
            lines: resultLines,
            timestamp: Date.now(),
          });
          if (encounter.actionLog.length > 100) {
            encounter.actionLog = encounter.actionLog.slice(encounter.actionLog.length - 100);
          }
        }
        encounter.pendingActions = [];
        // Chiến thắng — luật xác nhận: cần thông báo RÕ RÀNG khi TẤT CẢ enemy đã hạ,
        // không chỉ đổi màu embed (GM dễ bỏ sót). victoryAnnounced chặn báo LẶP LẠI
        // mỗi lần confirm sau đó trong cùng trạng thái "đã thắng" — tự RESET về false
        // ngay khi có enemy MỚI còn sống (VD GM thêm enemy tiếp theo bằng addenemy),
        // để lần thắng KẾ TIẾP vẫn báo đúng.
        const allEnemiesDeadNow = Object.keys(encounter.enemies).length > 0 && Object.values(encounter.enemies).every(e => e.currentHp <= 0);
        let victoryNote = "";
        if (allEnemiesDeadNow && !encounter.victoryAnnounced) {
          encounter.victoryAnnounced = true;
          victoryNote = "\n\n🎉 **CHIẾN THẮNG!** Toàn bộ enemy đã bị hạ — dùng `-encounter end` để kết thúc trận (sẽ tự gửi lại action log đầy đủ trước khi xoá), hoặc `-encounter addenemy` nếu muốn thêm đợt tiếp theo.";
        } else if (!allEnemiesDeadNow) {
          encounter.victoryAnnounced = false;
        }
        await saveEncounter(channelId, encounter);

        await interaction.update({
          embeds: [{
            title: isConfirm ? "✅ Đã xác nhận tất cả" : "❌ Đã reject tất cả",
            description: (resultLines.join("\n") || "*(không có gì)*") + victoryNote,
            color: isConfirm ? 0x2ecc71 : 0xe74c3c,
          }],
          components: [],
        }).catch(() => {});
        if (isConfirm) {
          await interaction.channel.send({ embeds: [buildEncounterBoardEmbed(encounter)] }).catch(() => {});
        }
      });
    } catch (err) {
      log("error", "encounterConfirmAll", interaction.user?.id ?? "unknown", err.message);
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("gmpanelstatus:")) {
    const [, channelId, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới xem được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      await interaction.reply({ embeds: [buildEncounterBoardEmbed(encounter)], flags: MessageFlags.Ephemeral }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("gachapull:")) {
    const [, ownerId, countStr] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⚠️ Chỉ chủ nhân bảng gacha này mới bấm được — dùng `-gacha` để mở bảng riêng của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const count = parseInt(countStr, 10);
    try {
      const { totalCost, resultLines, rareHits, remainingLunacy } = await performGachaPull(interaction.user.id, count);
      // Cập nhật LẠI panel (Lunacy mới) NGAY trong cùng message — người chơi bấm
      // tiếp được luôn, không cần gõ `-gacha` lại mỗi lần.
      await interaction.update({
        embeds: [buildGachaPanelEmbed(remainingLunacy)],
        components: buildGachaPanelButtons(ownerId),
      }).catch(() => {});
      await interaction.followUp({
        content:
          `🎰 **Gacha x${count}** (-${formatNumber(totalCost)} <:Lunacy:1524989409529823342>Lunacy, còn **${formatNumber(remainingLunacy)}**):\n` +
          resultLines.map(l => `> ${l}`).join("\n") +
          (rareHits.length > 0 ? `\n\n🎉 **CỰC HIẾM!** Trúng: ${rareHits.join(", ")} — liên hệ GM để thiết kế cụ thể.` : ""),
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("encendturn:")) {
    const [, channelId, gmIdFromButton] = interaction.customId.split(":");
    try {
      const isAdmin = ADMIN_IDS.has(interaction.user.id);
      if (interaction.user.id !== gmIdFromButton && !isAdmin) {
        return interaction.reply({ content: "⚠️ Chỉ GM/admin mới được kết thúc turn.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const { encounter, shroudedNotes } = await performEndTurn(channelId, interaction.user.id, isAdmin);
      await interaction.update({
        content: null,
        embeds: [{
          title: "🔄 Đã kết thúc Turn",
          description: `Hồi ${ENCOUNTER_STAMINA_REGEN_PER_TURN} Stamina (trừ ai đang Stagger), đếm ngược Stagger/Panic.` +
            (shroudedNotes.length > 0 ? `\n> ${shroudedNotes.join(", ")}` : "") +
            `\n> 🎲 Thứ tự Turn mới:\n${buildTurnOrderText(encounter)}`,
          color: 0x2ecc71,
        }],
        components: [],
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("encreactivedef:")) {
    const [, channelId, pendingId, targetId, choice] = interaction.customId.split(":");
    try {
      let resultText = null;
      let stillWaitingFor = null;
      await withLock(encounterKey(channelId), async () => {
        const encounter = await getEncounter(channelId);
        if (!encounter) throw new Error("Encounter không còn tồn tại.");
        const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
        if (!p) throw new Error("Action này đã được xử lý rồi (có thể GM đã confirm/reject cả loạt trước đó).");
        const isAdmin = ADMIN_IDS.has(interaction.user.id);
        if (interaction.user.id !== targetId && !isAdmin && interaction.user.id !== encounter.gmId) {
          throw new Error("Chỉ người bị tấn công (hoặc GM) mới được chọn phòng thủ này.");
        }
        // BUG NGHIÊM TRỌNG ĐÃ SỬA (phát hiện qua rà soát): đòn AOE nhắm NHIỀU
        // target cùng lúc — TRƯỚC ĐÂY chỉ cần 1 người bấm là resolveOnePendingAction
        // chạy NGAY cho CẢ p (mọi target), rồi xoá p khỏi queue — những người CHƯA
        // kịp bấm bị tính mặc định "không phòng thủ" (charges=0) dù chưa hề được
        // hỏi. Sửa: CHỈ resolve khi TẤT CẢ target trong p.targets đã phản hồi —
        // mỗi lần bấm chỉ áp dụng lựa chọn của ĐÚNG người đó rồi ghi nhớ lại.
        if (p.reactedTargetIds?.includes(targetId)) {
          throw new Error("Bạn đã chọn phòng thủ cho đòn này rồi.");
        }
        const targetResolved = resolveCombatant(encounter, targetId);
        if (!targetResolved) throw new Error("Không tìm thấy target.");
        const target = targetResolved.combatant;
        const attacker = resolveCombatant(encounter, p.attackerId);
        if (!attacker) throw new Error("Không tìm thấy attacker.");
        const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
        const attackerWeapon = attacker.combatant.weaponWeight ?? "medium";
        const bypass = p.defenseBypass ?? {};
        const t = p.targets.find(tg => tg.targetId === targetId);
        const hitCount = Math.max(1, t?.preview?.dmgValues?.length ?? 1);
        // Tính LẠI option TẠI THỜI ĐIỂM BẤM (không dùng số đã tính lúc gửi prompt —
        // Stamina/injury có thể đã đổi giữa lúc gửi và lúc bấm).
        const opts = computeDefenseOptions(target, attackerWeapon, hitCount, isM1Type, bypass);
        let choiceNote = "";
        if (choice === "guard") {
          if (!opts.guard.available) throw new Error(`Không đủ Stamina để Guard (cần ${opts.guard.cost}, hiện có ${target.currentStamina}).`);
          target.currentStamina -= opts.guard.cost;
          // CỘNG THÊM (không ghi đè) — nếu target đã có sẵn charge dư từ trước
          // (VD từ lệnh -encounter guard chủ động khác), giữ nguyên phần dư đó.
          target.guardCharges = (target.guardCharges ?? 0) + opts.chargesNeeded;
          choiceNote = `🛡️ Guard (-${opts.guard.cost} Sta)`;
        } else if (choice === "evade") {
          if (!opts.evade.available) throw new Error(opts.evade.blockedReason ? `Evade bị khoá: ${opts.evade.blockedReason}.` : `Không đủ Stamina để Evade (cần ${opts.evade.cost}, hiện có ${target.currentStamina}).`);
          target.currentStamina -= opts.evade.cost;
          target.evadeCharges = (target.evadeCharges ?? 0) + opts.chargesNeeded;
          choiceNote = `💨 Evade (-${opts.evade.cost} Sta)`;
        } else if (choice === "parry") {
          if (!opts.parry.available) throw new Error("Parry bị khoá cho đòn này (Unparriable).");
          target.parryRolls = target.parryRolls ?? [];
          const penalty = getParryClashPenalty(target);
          for (let i = 0; i < opts.chargesNeeded; i++) {
            const rawRoll = 1 + Math.floor(Math.random() * 20);
            target.parryRolls.push(rawRoll - penalty);
          }
          choiceNote = `🗡️ Parry (${opts.chargesNeeded} roll, 0 Sta)`;
        } else {
          choiceNote = "❌ Không phòng thủ";
        }
        checkStaggerPanic(target);
        p.reactedTargetIds = p.reactedTargetIds ?? [];
        p.reactedTargetIds.push(targetId);
        const allTargetIds = p.targets.map(tg => tg.targetId);
        const allReacted = allTargetIds.every(tid => p.reactedTargetIds.includes(tid));
        if (allReacted) {
          const lines = await resolveOnePendingAction(encounter, p);
          encounter.pendingActions = (encounter.pendingActions ?? []).filter(pa => pa.id !== pendingId);
          resultText = `${interaction.user.toString()} chọn **${choiceNote}**\n${lines.join("\n")}`;
        } else {
          // Vẫn còn người khác trong đòn AOE chưa bấm — CHỈ lưu lựa chọn của
          // người này lại, KHÔNG resolve/xoá pendingAction, để họ vẫn có cơ hội
          // chọn khi tới lượt (button của họ vẫn còn nguyên, không bị đụng tới).
          resultText = `${interaction.user.toString()} chọn **${choiceNote}** — đang chờ ${allTargetIds.length - p.reactedTargetIds.length} người khác trong đòn AOE này.`;
          stillWaitingFor = allTargetIds.length - p.reactedTargetIds.length;
        }
        await saveEncounter(channelId, encounter);
      });
      await interaction.update({
        embeds: [{ title: stillWaitingFor ? "⏳ Đã ghi nhận — đang chờ người khác" : "⚔️ Đã xử lý", description: resultText, color: stillWaitingFor ? 0xf39c12 : 0x2ecc71 }],
        components: [],
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  } catch (err) {
    log("error", "buttonInteraction", interaction.user?.id ?? "unknown", err.message);
    interaction.reply({ content: "❌ Có lỗi không mong muốn xảy ra.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── MODAL SUBMIT INTERACTIONS (encounter attack/hit qua nút) ────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("encmodal:")) return;
  const parts = interaction.customId.split(":");
  const channelId = parts[1];
  const action = parts[2];
  const encodedPageName = parts[3]; // chỉ có khi action === "hit" VÀ chọn từ dropdown 1 Page cụ thể
  try {
    if (action === "repeat") {
      // Guard/Evade/Parry — Modal CHỈ có field "count" (không có targetStr) — PHẢI
      // xử lý TRƯỚC dòng đọc targetStr chung, vì field đó không tồn tại trong Modal
      // này (đọc field không tồn tại → Discord.js throw lỗi).
      const repeatType = parts[3]; // "guard" | "evade" | "parry"
      const countRaw = interaction.fields.getTextInputValue("count").trim();
      const count = countRaw === "" ? 1 : parseInt(countRaw, 10);
      if (!Number.isFinite(count) || count < 1 || count > 20) {
        throw new Error(`Số lần phải từ 1-20 (để trống = 1). Nhận được: "${countRaw}".`);
      }
      const isAdminRepeat = ADMIN_IDS.has(interaction.user.id);
      const lines = [];
      let stoppedEarly = false;
      for (let i = 0; i < count; i++) {
        try {
          let r;
          if (repeatType === "parry") r = await performParry(channelId, interaction.user.id, isAdminRepeat);
          else r = await performGuardEvade(channelId, interaction.user.id, isAdminRepeat, repeatType);
          lines.push(r);
        } catch (err) {
          lines.push(`❌ Dừng ở lần ${i + 1}/${count}: ${err.message}`);
          stoppedEarly = true;
          break;
        }
      }
      await interaction.reply({ content: lines.join("\n") + (stoppedEarly ? "" : ` ✅ (${count}/${count} lần)`) });
      return;
    }
    const targetStr = interaction.fields.getTextInputValue("targetStr");
    if (action === "attack") {
      const isAutoCalc = parts[3] === "auto";
      const isFixedBurst = parts[3] === "fixedburst";
      let dmgStr, eyeOfHorusVolleysInput;
      if (isFixedBurst) {
        // MÔ HÌNH MỚI (xác nhận trực tiếp, 8 ví dụ N=1..8) — "N lần bắn" (volleys)
        // giờ đọc TRỰC TIẾP từ field Modal, TRUYỀN QUA verifyOpts.volleys để
        // doPlayerAttack tự xây dmgStr (nhất quán với lệnh text `volleys:`) — không
        // còn tự xây dmgStr ở tầng Modal này nữa (khác bản trước).
        const volleysRaw = interaction.fields.getTextInputValue("volleys");
        eyeOfHorusVolleysInput = volleysRaw;
        dmgStr = ""; // doPlayerAttack tự xây dựng từ volleys, không cần dmgStr ở đây
      } else if (isAutoCalc) {
        const hitCountRaw = interaction.fields.getTextInputValue("hitCount");
        const hitCount = parseInt(hitCountRaw.trim(), 10);
        if (!Number.isFinite(hitCount) || hitCount < 1 || hitCount > 50) {
          throw new Error(`"Đánh mấy lần?" phải là số nguyên từ 1-50 (nhận được: "${hitCountRaw}").`);
        }
        const encounter = await getEncounter(channelId);
        const combatant = encounter?.players?.[interaction.user.id];
        if (!combatant || !Number.isFinite(combatant.weaponBaseDamage) || !combatant.weaponType) {
          throw new Error("Không tìm thấy dữ liệu vũ khí — dùng `-encounter attack target: ... dmg: ...` (lệnh text) thay vào đó.");
        }
        // Type text (Blunt/Pierce/Slash) → chữ cái dmgStr cần (B/P/S).
        const typeLetter = { Blunt: "B", Pierce: "P", Slash: "S" }[combatant.weaponType];
        if (!typeLetter) throw new Error(`Type vũ khí "${combatant.weaponType}" không nhận diện được (cần Blunt/Pierce/Slash).`);
        dmgStr = hitCount > 1 ? `${combatant.weaponBaseDamage}x${hitCount}${typeLetter}` : `${combatant.weaponBaseDamage}${typeLetter}`;
      } else {
        dmgStr = interaction.fields.getTextInputValue("dmgStr");
      }
      const { embed } = await doPlayerAttack(channelId, interaction.user.id, interaction.user.toString(), dmgStr, targetStr, { volleys: eyeOfHorusVolleysInput });
      await interaction.reply({ embeds: [embed] });
    } else if (action === "bossattack") {
      // Boss UI (theo yêu cầu trực tiếp: "phần encounter của boss cần 1 lệnh UI")
      // — enemyKey nằm ở parts[3] (thay vì encodedPageName như case "hit").
      const enemyKey = parts[3];
      const dmgStr = interaction.fields.getTextInputValue("dmgStr");
      const { embed } = await doEnemyAttack(channelId, interaction.user.id, enemyKey, dmgStr, targetStr);
      await interaction.reply({ embeds: [embed] });
    } else if (action === "hit") {
      const dmgStr = interaction.fields.getTextInputValue("dmgStr");
      // Chọn từ dropdown 1 Page cụ thể → tự điền skill: (bot tự roll thật kèm theo,
      // giống gõ tay "skill: <tên>") — KHÔNG cần player tự gõ thêm gì ngoài target+dmg.
      const skillFromDropdown = encodedPageName ? decodeURIComponent(encodedPageName) : undefined;
      const { embed, skillRollEmbed } = await doPlayerHit(channelId, interaction.user.id, interaction.user.toString(), dmgStr, targetStr, { skill: skillFromDropdown });
      await interaction.reply({ embeds: skillRollEmbed ? [skillRollEmbed, embed] : [embed] });
    } else if (action === "criticalhit") {
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "Bot tự roll Durandal, tự cho vào phần modal
      // Dmg ra dmg đầu cuối lên kẻ địch") — TÁI DÙNG kết quả roll ĐÃ LƯU lúc chọn
      // dropdown (xem case "critical:" ở encmenu select handler), KHÔNG roll lại.
      const dmgStr = interaction.fields.getTextInputValue("dmgStr");
      const pendingKey = `${channelId}:${interaction.user.id}`;
      const pending = pendingCriticalRolls.get(pendingKey);
      if (!pending) {
        return interaction.reply({ content: "⚠️ Phiên roll Critical đã hết hạn (quá 5 phút) hoặc không tìm thấy — chọn lại \"Critical\" từ dropdown để roll mới.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      pendingCriticalRolls.delete(pendingKey); // single-use — không tái sử dụng cho lần confirm khác
      const { embed, skillRollEmbed } = await doPlayerHit(channelId, interaction.user.id, interaction.user.toString(), dmgStr, targetStr, {
        prefilledVerify: {
          skillRollEmbed: pending.skillRollEmbed, skillKey: pending.skillKey, cooldownTurns: pending.cooldownTurns,
          emotionDelta: pending.emotionDelta, lightCost: pending.lightCost, sanityCost: pending.sanityCost,
          refSnippet: null, refLink: null,
        },
      });
      const warningNote = (pending.autoWarnings ?? []).length > 0 ? `\n\n⚠️ ${pending.autoWarnings.join("\n⚠️ ")}` : "";
      if (warningNote) embed.description += warningNote;
      await interaction.reply({ embeds: skillRollEmbed ? [skillRollEmbed, embed] : [embed] });
    } else if (action === "followup") {
      const { followupEmbed, hitEmbed } = await performFollowUp(channelId, interaction.user.id, interaction.user.toString(), targetStr);
      await interaction.reply({ embeds: [followupEmbed] });
      await interaction.channel.send({ embeds: [hitEmbed] }).catch(() => {});
    }
  } catch (err) {
    log("error", "encModalSubmit", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// GAP ĐÃ SỬA (xác nhận trực tiếp: "Bot tự roll Durandal, tự cho vào phần modal
// Dmg ra dmg đầu cuối lên kẻ địch") — Map<key, session> lưu TẠM kết quả roll thật
// giữa lúc chọn "Critical" từ dropdown (roll + build Modal) và lúc submit Modal
// (tính dmg cuối) — Discord KHÔNG cho hiện cả embed lẫn Modal cùng lúc trên 1
// interaction, nên roll THẬT phải xảy ra lúc chọn dropdown (pre-fill dmgStr vào
// Modal), rồi lúc submit PHẢI tái dùng CHÍNH kết quả đó (không roll lại lần 2 —
// nếu roll lại sẽ ra dice khác, dmgStr pre-fill không khớp embed thật, sai lệch
// nghiêm trọng). TTL ngắn (RAM, không cần Upstash) — cùng pattern webParrySessions
// (rtparry.js): key sống vài phút, nếu bot restart giữa chừng thì coi như hỏng
// phiên, chấp nhận được vì tần suất cực thấp.
const pendingCriticalRolls = new Map();
const PENDING_CRITICAL_ROLL_TTL_MS = 5 * 60_000; // 5 phút — đủ để mở Modal và điền
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of pendingCriticalRolls) if (s.expiresAt < now) pendingCriticalRolls.delete(key);
}, 60_000);

// ─── SELECT MENU INTERACTIONS (encounter) ────────────────────────────────────
// Dropdown hành động ĐỘNG (xem buildEncounterActionPanel) — thay cho 2 nút
// Attack/Hit cố định cũ. attack/hit:<page> mở Modal (cần target+dmg); followup mở
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("gmpanelselect:")) return;
  const [, channelId, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
    return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const ekey = interaction.values[0];
  try {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Encounter không còn tồn tại.");
    const enemy = encounter.enemies[ekey];
    if (!enemy) throw new Error("Không tìm thấy enemy này (có thể đã bị xoá).");
    await interaction.update({
      embeds: [{ title: `👹 Điều khiển: ${enemy.name} (${ekey})`, description: `HP: ${enemy.currentHp}/${enemy.maxHp} | Stamina: ${enemy.currentStamina}/${enemy.maxStamina}\nChọn hành động:`, color: 0xe74c3c }],
      components: buildBossActionPanel(channelId, ekey, interaction.user.id),
    }).catch(() => {});
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});
// Modal đơn giản hơn (chỉ target); còn lại (guard/evade/parry/shinmang/
// manifestego/overcharge) thực thi NGAY qua các hàm perform* dùng CHUNG với lệnh
// text -encounter (xem định nghĩa performGuardEvade/performParry/...).
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("encmenu:")) return;
  const [, channelId, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân dropdown này mới chọn được — dùng `-encounter status` để có dropdown riêng của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const value = interaction.values[0];
  try {
    if (value === "attack") {
      // M1 (Đánh thường) — theo yêu cầu trực tiếp: hỏi "đánh mấy lần" thay vì bắt
      // gõ tay cả công thức dmgStr — tự tính từ vũ khí đã equip (weaponBaseDamage/
      // weaponType lưu trên combatant, xem createCombatant/join/swapweapon). Nếu
      // KHÔNG có dữ liệu vũ khí (chưa từng equip gì rõ ràng) → fallback về Modal
      // dmgStr CŨ (gõ tay), để không chặn hoàn toàn player chưa equip.
      const encounter = await getEncounter(channelId);
      const combatant = encounter?.players?.[interaction.user.id];
      const hasWeaponData = combatant && Number.isFinite(combatant.weaponBaseDamage) && combatant.weaponType;
      // Eye Of Horus — BUG ĐÃ SỬA (xác nhận trực tiếp từ GM): "M1 của Eye of Horus
      // là 3x9P — 1 lần đánh sẽ ra 9 hit" — nghĩa là số hit KHÔNG PHẢI player tự
      // chọn (khác mọi vũ khí khác), mà LUÔN CỐ ĐỊNH 9 mỗi lần "đánh thường" (vũ
      // khí burst cố định, gắn liền với cơ chế Ammo). Trước đây dùng CHUNG Modal
      // "hỏi mấy lần" như vũ khí thường — sai hoàn toàn, cho phép player tự ý nhập
      // số hit tuỳ ý thay vì luôn đúng 9.
      const isFixedBurstWeapon = hasWeaponData && (combatant.weaponName ?? "").toLowerCase() === "eye of horus";
      const modal = new ModalBuilder()
        .setCustomId(`encmodal:${channelId}:attack${isFixedBurstWeapon ? ":fixedburst" : hasWeaponData ? ":auto" : ""}`)
        .setTitle("Đánh thường (M1)");
      const targetInput = new TextInputBuilder()
        .setCustomId("targetStr")
        .setLabel("Target (key enemy, key1,key2, hoặc all)")
        .setPlaceholder("VD: mo  hoặc  mo,arnold  hoặc  all")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      if (isFixedBurstWeapon) {
        // MÔ HÌNH MỚI (xác nhận trực tiếp, 8 ví dụ N=1..8) — HỎI "N lần bắn" (số
        // volley TỰ CHỌN cho hành động NÀY) — khác trước đây (chỉ hỏi target, vì
        // dùng counter cộng dồn qua nhiều lần bấm riêng biệt, giờ không còn nữa).
        const volleysInput = new TextInputBuilder()
          .setCustomId("volleys")
          .setLabel("Bắn mấy lần? (volley 9-hit/lần)")
          .setPlaceholder("VD: 4")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(
          new ActionRowBuilder().addComponents(targetInput),
          new ActionRowBuilder().addComponents(volleysInput),
        );
      } else if (hasWeaponData) {
        const hitCountInput = new TextInputBuilder()
          .setCustomId("hitCount")
          .setLabel(`Đánh mấy lần? (${combatant.weaponBaseDamage} ${combatant.weaponType}/hit, vũ khí ${combatant.weaponWeight})`.slice(0, 45))
          .setPlaceholder("VD: 4")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(
          new ActionRowBuilder().addComponents(targetInput),
          new ActionRowBuilder().addComponents(hitCountInput),
        );
      } else {
        const dmgInput = new TextInputBuilder()
          .setCustomId("dmgStr")
          .setLabel("Công thức dmg (chưa rõ vũ khí — gõ tay)")
          .setPlaceholder("VD: 50x2B+2Sinking")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(
          new ActionRowBuilder().addComponents(targetInput),
          new ActionRowBuilder().addComponents(dmgInput),
        );
      }
      await interaction.showModal(modal).catch(() => {});
      return;
    }
    if (value.startsWith("critical:")) {
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "Bot tự roll Durandal, tự cho vào phần
      // modal Dmg ra dmg đầu cuối lên kẻ địch") — roll skill THẬT NGAY LÚC CHỌN
      // dropdown (Discord không cho hiện embed + Modal cùng lúc trên 1 interaction),
      // lưu kết quả vào pendingCriticalRolls để MODAL SUBMIT tái dùng (không roll
      // lại lần 2 — xem comment đầy đủ ở khai báo Map phía trên), rồi pre-fill
      // field dmgStr với công thức đã tính.
      const critSkillName = value.slice(9);
      const encounter = await getEncounter(channelId);
      const combatant = encounter?.players?.[interaction.user.id];
      if (!combatant) {
        return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!isCurrentTurnHolder(encounter, interaction.user.id)) {
        return interaction.reply({ content: "⚠️ Chưa tới lượt bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      let verify;
      try {
        verify = await resolveSkillVerification(channelId, combatant, critSkillName, null, true);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!verify.autoDmgStr) {
        // BUG NGHIÊM TRỌNG ĐÃ SỬA (phát hiện qua ảnh chụp thật của user — "Durandal"
        // Critical không có dmg trực tiếp): TRƯỚC ĐÂY nhánh này chỉ hiện embed rồi
        // DỪNG HẲN — resolveSkillVerification ĐÃ mutate combatant (paralyze/chains/
        // busyAsTribbie) NHƯNG KHÔNG saveEncounter nào cả (mất trắng thay đổi), Light
        // Cost/Cooldown KHÔNG được áp dụng (skill dùng "miễn phí"), VÀ turn KHÔNG bao
        // giờ advance (kẹt game — mọi người bị Turn Order Enforcement chặn vĩnh viễn
        // cho tới khi ai đó tự gõ `-encounter pass`). Sửa: build 1 pendingAction với
        // targets RỖNG (không có dmg/target nào để tính) nhưng ĐẦY ĐỦ skillKey/
        // cooldownTurns/emotionDelta/lightCost/sanityCost — route qua ĐÚNG
        // resolveOnePendingAction (tái dùng nguyên logic áp dụng side-effect, y hệt
        // mọi hành động khác), rồi advance turn + save như bình thường.
        const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const p = {
          id: pendingId, kind: "critical", attackerId: interaction.user.id,
          targets: [], dmgStr: `Critical: ${critSkillName}`, defenseBypass: {},
          skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: verify.emotionDelta ?? 0,
          lightCost: verify.lightCost, sanityCost: verify.sanityCost,
        };
        const lines = await resolveOnePendingAction(encounter, p);
        advanceToNextTurnHolder(encounter);
        await saveEncounter(channelId, encounter);
        announceCurrentTurn(channelId, encounter).catch(() => {});
        return interaction.reply({
          embeds: [verify.skillRollEmbed, { description: `*(Critical này không có dice sát thương trực tiếp để tự tính dmg — dùng \`-encounter buff\`/lệnh liên quan để narrate hiệu ứng nếu cần.)*${lines.length ? `\n${lines.join("\n")}` : ""}`, color: 0x95a5a6 }],
        }).catch(() => {});
      }
      const pendingKey = `${channelId}:${interaction.user.id}`;
      pendingCriticalRolls.set(pendingKey, {
        skillRollEmbed: verify.skillRollEmbed,
        skillKey: verify.skillKey,
        cooldownTurns: verify.cooldownTurns,
        emotionDelta: verify.emotionDelta,
        lightCost: verify.lightCost,
        sanityCost: verify.sanityCost,
        autoWarnings: verify.autoWarnings,
        expiresAt: Date.now() + PENDING_CRITICAL_ROLL_TTL_MS,
      });
      const modal = new ModalBuilder()
        .setCustomId(`encmodal:${channelId}:criticalhit:${encodeURIComponent(critSkillName)}`)
        .setTitle(`Critical: ${critSkillName}`.slice(0, 45));
      const targetInput = new TextInputBuilder()
        .setCustomId("targetStr")
        .setLabel("Target (key enemy, key1,key2, hoặc all)")
        .setPlaceholder("VD: mo  hoặc  mo,arnold  hoặc  all")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const dmgInput = new TextInputBuilder()
        .setCustomId("dmgStr")
        .setLabel("Dmg (đã tự roll — sửa nếu cần)")
        .setValue(verify.autoDmgStr)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(targetInput),
        new ActionRowBuilder().addComponents(dmgInput),
      );
      await interaction.showModal(modal).catch(() => {});
      return;
    }
    if (value.startsWith("hit:")) {
      // Page/Skill — GIỮ NGUYÊN Modal target+dmgStr (KHÔNG tự động tính được an
      // toàn như M1, vì mỗi Page có dice/hiệu ứng khác nhau hoàn toàn — tự bịa số
      // có nguy cơ sai lệch dmg thật). Chọn từ dropdown vẫn tự điền đúng skill: (áp
      // dụng ở lúc submit modal, xem encmodal handler) — chỉ cần gõ target+dmg.
      const pageName = value.slice(4);
      const modal = new ModalBuilder()
        .setCustomId(`encmodal:${channelId}:hit:${encodeURIComponent(pageName)}`)
        .setTitle(`Dùng Page: ${pageName}`.slice(0, 45));
      const targetInput = new TextInputBuilder()
        .setCustomId("targetStr")
        .setLabel("Target (key enemy, key1,key2, hoặc all)")
        .setPlaceholder("VD: mo  hoặc  mo,arnold  hoặc  all")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const dmgInput = new TextInputBuilder()
        .setCustomId("dmgStr")
        .setLabel("Công thức dmg (giống /math)")
        .setPlaceholder("VD: 50x2B+2Sinking")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(targetInput),
        new ActionRowBuilder().addComponents(dmgInput),
      );
      await interaction.showModal(modal).catch(() => {});
      return;
    }
    if (value === "followup") {
      const modal = new ModalBuilder().setCustomId(`encmodal:${channelId}:followup`).setTitle("Follow-Up / Pounce");
      const targetInput = new TextInputBuilder()
        .setCustomId("targetStr")
        .setLabel("Target (key enemy, key1,key2, hoặc all)")
        .setPlaceholder("VD: mo")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(targetInput));
      await interaction.showModal(modal).catch(() => {});
      return;
    }
    if (value === "guard" || value === "evade" || value === "parry") {
      // Guard/Evade/Parry — theo yêu cầu trực tiếp: hỏi "mấy lần" qua Modal thay vì
      // bắt chọn lại dropdown nhiều lần cho mỗi charge muốn có. Modal NHẸ, chỉ 1
      // field, để trống = mặc định 1 lần (không bắt buộc phải gõ số cho trường hợp
      // đơn giản nhất).
      const label = { guard: "🛡️ Guard", evade: "💨 Evade", parry: "🗡️ Parry" }[value];
      const modal = new ModalBuilder()
        .setCustomId(`encmodal:${channelId}:repeat:${value}`)
        .setTitle(`${label} — mấy lần?`);
      const countInput = new TextInputBuilder()
        .setCustomId("count")
        .setLabel("Số lần (để trống = 1)")
        .setPlaceholder("VD: 3")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(countInput));
      await interaction.showModal(modal).catch(() => {});
      return;
    }
    const isAdmin = ADMIN_IDS.has(interaction.user.id);
    let resultMsg;
    if (value === "shinmang") resultMsg = await performShinMang(channelId, interaction.user.id);
    else if (value === "manifestego") resultMsg = await performManifestEgo(channelId, interaction.user.id);
    else if (value === "overcharge") resultMsg = await performOvercharge(channelId, interaction.user.id);
    else { await interaction.reply({ content: "⚠️ Hành động không hợp lệ.", flags: MessageFlags.Ephemeral }).catch(() => {}); return; }
    await interaction.reply({ content: resultMsg });
  } catch (err) {
    log("error", "encMenuSelect", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (bossmenu — GM điều khiển 1 enemy cụ thể) ───────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("bossmenu:")) return;
  const [, channelId, enemyKey, gmUserId] = interaction.customId.split(":");
  const isAdmin = ADMIN_IDS.has(interaction.user.id);
  if (interaction.user.id !== gmUserId && !isAdmin) {
    return interaction.reply({ content: "⚠️ Chỉ GM/admin điều khiển được enemy này.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const value = interaction.values[0];
  try {
    if (value === "attack") {
      // Boss KHÔNG có weaponBaseDamage/weaponType tự động (enemy dùng lệnh text
      // tuỳ ý từ trước tới giờ, không gắn với hệ thống equip weapon) — luôn hỏi
      // dmgStr gõ tay, giống -encounter enemyattack.
      const modal = new ModalBuilder()
        .setCustomId(`encmodal:${channelId}:bossattack:${enemyKey}`)
        .setTitle(`${enemyKey} tấn công`.slice(0, 45));
      const targetInput = new TextInputBuilder()
        .setCustomId("targetStr")
        .setLabel("Target (mention player, hoặc all)")
        .setPlaceholder("VD: @player  hoặc  all")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const dmgInput = new TextInputBuilder()
        .setCustomId("dmgStr")
        .setLabel("Công thức dmg")
        .setPlaceholder("VD: 50x2B+2Sinking")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(targetInput),
        new ActionRowBuilder().addComponents(dmgInput),
      );
      await interaction.showModal(modal).catch(() => {});
      return;
    }
    if (value === "guard" || value === "evade" || value === "parry") {
      const label = { guard: "🛡️ Guard", evade: "💨 Evade", parry: "🗡️ Parry" }[value];
      let resultMsg;
      if (value === "parry") resultMsg = await performParry(channelId, interaction.user.id, isAdmin, enemyKey);
      else resultMsg = await performGuardEvade(channelId, interaction.user.id, isAdmin, value, enemyKey);
      await interaction.reply({ content: resultMsg });
      return;
    }
    await interaction.reply({ content: "⚠️ Hành động không hợp lệ.", flags: MessageFlags.Ephemeral }).catch(() => {});
  } catch (err) {
    log("error", "bossMenuSelect", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (inventory) ────────────────────────────────────
// ─── SELECT MENU INTERACTIONS (đọc sách — chọn 1 Page/Weapon/Outfit) ─────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("bookchoice:")) return;
  const [, ownerId, encodedBookName] = interaction.customId.split(":");
  const bookName = decodeURIComponent(encodedBookName);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const [chosenType, chosenName] = interaction.values[0].split(":");
  if (chosenType === "group") {
    // TẦNG 2 — hiện Page cụ thể TRONG nhóm đã chọn (CHỈ "Library Book" mới có
    // nhánh này, vì đây là sách DUY NHẤT có >25 lựa chọn cần chia 2 tầng).
    const groupChoices = getBookGroupChoices(bookName, chosenName);
    const options = groupChoices.slice(0, 25).map(c =>
      new StringSelectMenuOptionBuilder().setLabel(c.name.slice(0, 100)).setDescription("Page").setValue(`page:${c.name}`).setEmoji("📖")
    );
    return interaction.reply({
      embeds: [{ title: `📂 ${bookName} — Nhóm ${chosenName}`, description: "Chọn ĐÚNG 1 Page trong nhóm này:", color: 0x5865f2 }],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`bookchoice:${ownerId}:${encodeURIComponent(bookName)}`).setPlaceholder("Chọn Page...").addOptions(options)
      )],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
  // page/weapon/outfit cụ thể — CHỐT LUÔN.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await withLock(ownerId, () => executeReadBookChoose(ownerId, bookName, chosenType, chosenName));
    const typeLabel = chosenType === "page" ? "Page" : chosenType === "weapon" ? "Vũ khí" : "Outfit";
    await interaction.editReply({
      embeds: [{
        title: `📖 Đã đọc: ${result.bookName}`,
        description: `Nhận được: **${result.chosenName}** (${typeLabel})\n\n*Còn lại: ${result.remaining} cuốn.*`,
        color: 0x5865f2,
      }],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (-balance: phân bổ điểm / unlock perk) ─────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("balbranch:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const branchKey = interaction.values[0].split(":")[1]; // "branch:sloth" → "sloth"
  const modal = new ModalBuilder()
    .setCustomId(`balmodal:${ownerId}:${branchKey}`)
    .setTitle(`Phân bổ điểm — ${branchKey[0].toUpperCase() + branchKey.slice(1)}`);
  const amountInput = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("Số điểm muốn cộng thêm")
    .setPlaceholder("VD: 10")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
  await interaction.showModal(modal).catch(() => {});
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("balmodal:")) return;
  const [, ownerId, branchKey] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const addAmount = parseInt(interaction.fields.getTextInputValue("amount").trim(), 10);
    if (!Number.isFinite(addAmount) || addAmount <= 0) throw new Error("Số điểm phải là số dương.");
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      data.branchPoints = data.branchPoints ?? {};
      const before = data.branchPoints[branchKey] ?? 0;
      const proposedBranchPoints = { ...data.branchPoints, [branchKey]: before + addAmount };
      const proposedTotal = BRANCH_KEYS.reduce((sum, k) => sum + (proposedBranchPoints[k] ?? 0), 0);
      const pool = calcSkillTreePointsEarned(data);
      if (proposedTotal > pool) {
        const currentAllocated = calcBranchPointsAllocated(data);
        throw new Error(`Không đủ điểm — tổng sẽ thành ${proposedTotal}, vượt quá pool ${pool} (còn dư ${pool - currentAllocated} điểm).`);
      }
      // Gate CỨNG — đồng bộ với -allocatepoints text command (xem comment đầy đủ ở
      // đó). Dropdown này LUÔN self-service (đã check user.id===ownerId ở trên).
      if ((branchKey === "shin" && !data.ShinUnlock) || (branchKey === "light" && !data.LightSkillTreeUnlock)) {
        throw new Error(`Bạn CHƯA đủ điều kiện phân bổ điểm vào nhánh ${branchKey[0].toUpperCase() + branchKey.slice(1)} (chưa được GM xác nhận) — liên hệ GM.`);
      }
      data.branchPoints[branchKey] = proposedBranchPoints[branchKey];
      await savePlayerData(ownerId, data, slot);
      await interaction.editReply({ content: `✅ ${branchKey[0].toUpperCase() + branchKey.slice(1)}: ${before} → **${data.branchPoints[branchKey]}** [tổng: ${proposedTotal}/${pool}]\n> Dùng lại \`-balance\` để thấy cập nhật.` });
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("balunlock:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (isOnCooldown(interaction.user.id, "balunlock", 2000)) {
    return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const perkName = interaction.values[0].split(":").slice(1).join(":"); // "perk:Fortified Resolve" → "Fortified Resolve" (giữ nguyên nếu tên perk có dấu ":")
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      data.unlockedSkillTree = data.unlockedSkillTree ?? [];
      if (data.unlockedSkillTree.includes(perkName)) throw new Error(`Đã có "${perkName}" rồi.`);
      const conflict = findExclusiveConflict(data.unlockedSkillTree, perkName);
      if (conflict) throw new Error(`"${perkName}" loại trừ với "${conflict}" đã có sẵn.`);
      const cost = PERK_POINT_COSTS[perkName];
      const branch = PERK_BRANCH[perkName];
      const branchHave = (data.branchPoints ?? {})[branch] ?? 0;
      if (branchHave < cost) throw new Error(`Cần ${cost} điểm ${branch} — hiện chỉ có ${branchHave}.`);
      data.unlockedSkillTree.push(perkName);
      await savePlayerData(ownerId, data, slot);
      await interaction.editReply({ content: `✅ Đã mở khoá **${perkName}** (nhánh ${branch}, ${cost} điểm)!\n> Dùng lại \`-balance\` để thấy cập nhật.` });
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (-balance: equip weapon/outfit/accessory) ──────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("balequipgear:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (isOnCooldown(interaction.user.id, "balequipgear", 2000)) {
    return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const [chosenType, chosenName] = [interaction.values[0].split(":")[0], interaction.values[0].split(":").slice(1).join(":")];
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      // Re-check sở hữu NGAY LÚC BẤM (không chỉ lúc build dropdown) — phòng
      // trường hợp đã dùng/mất item giữa lúc dropdown hiện và lúc bấm chọn.
      // BUG ĐÃ SỬA (xác nhận trực tiếp: "chưa thấy brawler được free... vẫn chưa
      // pick được") — vũ khí UNIVERSALLY_KNOWN_WEAPONS (VD Brawler) BYPASS check
      // này, nhất quán với -equipweapon text command.
      const isUniversalChosen = chosenType === "weapon" && UNIVERSALLY_KNOWN_WEAPONS.has(chosenName.toLowerCase());
      if (!isUniversalChosen && (data.items?.[chosenName] ?? 0) < 1) throw new Error(`Không còn sở hữu **${chosenName}** — dùng lại \`-balance\` để cập nhật danh sách.`);
      let resultMsg;
      if (chosenType === "weapon") {
        const weapon = findWeaponAnywhere(chosenName);
        data.equippedWeapon = weapon.name;
        resultMsg = `✅ Đã equip vũ khí **${weapon.name}** (${weapon.weight}/${weapon.type}, Base Dmg ${weapon.baseDamage}).`;
      } else if (chosenType === "outfit") {
        const outfit = findOutfit(chosenName);
        data.equippedOutfit = outfit.name;
        const r = outfit.resistance;
        resultMsg = `✅ Đã equip outfit **${outfit.name}** (Res: ${r.B}xB ${r.P}xP ${r.S}xS).`;
      } else if (chosenType === "accessory") {
        const accessory = findAccessory(chosenName);
        data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
        // BUG ĐÃ SỬA (xác nhận trực tiếp: "1 player chỉ có 1 item accessory duy
        // nhất nhưng lại equip được cả ở 3 slot accessory") — đếm số slot ĐÃ dùng
        // CÙNG accessory này trước khi tự chọn slot trống/ghi đè — chặn nếu vượt
        // quá số lượng sở hữu (đã re-check ở dòng trên, ownedCount = data.items).
        const ownedCount = data.items?.[accessory.name] ?? 0;
        const usedInAnySlot = data.equippedAccessories.filter(name => name === accessory.name).length;
        if (usedInAnySlot >= ownedCount) {
          throw new Error(`Bạn chỉ sở hữu **${ownedCount}** **${accessory.name}** và đã dùng hết ở các slot hiện tại — không đủ để equip thêm.`);
        }
        // Tự chọn slot TRỐNG đầu tiên — nếu cả 3 đã đầy, ghi đè slot 1 (kèm cảnh
        // báo) — muốn chọn slot cụ thể, dùng lệnh text `-equipaccessory <slot>`.
        let targetSlot = data.equippedAccessories.findIndex(s => !s);
        const overwritten = targetSlot === -1;
        if (overwritten) targetSlot = 0;
        data.equippedAccessories[targetSlot] = accessory.name;
        resultMsg = `✅ Đã equip accessory **${accessory.name}** vào slot #${targetSlot + 1}${overwritten ? " (đã GHI ĐÈ slot đầy — dùng `-equipaccessory <slot>` nếu muốn chọn slot khác)" : ""}.`;
      } else {
        throw new Error("Loại trang bị không hợp lệ.");
      }
      await savePlayerData(ownerId, data, slot);
      await interaction.editReply({ content: resultMsg + "\n> Dùng lại `-balance`/`-equipment` để xem cập nhật." });
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (-balance: equip Page/E.G.O Page) ──────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  // Chấp nhận CẢ 2 customId (Page thường VÀ E.G.O Page) — BUG ĐÃ SỬA: trước đây
  // CẢ 2 dropdown (Page thường/E.G.O Page trong -balance) dùng CHUNG 1 customId
  // "balequippage:" y hệt nhau (Discord không thể phân biệt 2 component TRÙNG
  // customId trong cùng 1 message) — đã tách riêng "balequipego:" cho dropdown
  // E.G.O Page, giờ handler CHUNG này chấp nhận CẢ 2 (logic bên trong ĐÃ phân biệt
  // đúng qua giá trị chọn "page:"/"egopage:", không cần customId phân biệt).
  if (!interaction.customId.startsWith("balequippage:") && !interaction.customId.startsWith("balequipego:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (isOnCooldown(interaction.user.id, "balequippage", 2000)) {
    return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const [chosenType, chosenName] = [interaction.values[0].split(":")[0], interaction.values[0].split(":").slice(1).join(":")];
    const isEgo = chosenType === "egopage";
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      if ((data.pages?.[chosenName] ?? 0) < 1) throw new Error(`Không còn sở hữu Page **${chosenName}** — dùng lại \`-balance\` để cập nhật danh sách.`);
      const skill = findSkill(chosenName);
      if (!skill) throw new Error(`Không tìm thấy Page "${chosenName}" trong hệ thống.`);
      const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
      data[listKey] = data[listKey] ?? [null, null, null, null, null];
      let targetSlot;
      let slotNote = "";
      if (isEgo) {
        // E.G.O Page — slot XÁC ĐỊNH theo Tier, KHÔNG tự chọn (khác Page thường).
        const skillTier = getEgoTier(skill);
        if (!skillTier) throw new Error(`Không xác định được Tier của "${skill.name}".`);
        targetSlot = EGO_TIER_SLOT_ORDER.indexOf(skillTier);
        slotNote = ` (Tier ${skillTier})`;
      } else {
        targetSlot = data[listKey].findIndex(s => !s);
        if (targetSlot === -1) { targetSlot = 0; slotNote = " (đã GHI ĐÈ slot đầy — dùng `-equippage <slot>` nếu muốn chọn slot khác)"; }
      }
      data[listKey][targetSlot] = skill.name;
      await savePlayerData(ownerId, data, slot);
      await interaction.editReply({ content: `✅ Đã equip **${skill.name}** vào ${isEgo ? "E.G.O " : ""}slot #${targetSlot + 1}${slotNote}.\n> Dùng lại \`-balance\`/\`-pages\` để xem cập nhật.` });
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (inventory) ────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("invsel:")) return;
  try {
    const [, targetUserId] = interaction.customId.split(":");
    // Chỉ chủ nhân inventory mới được chọn — tránh người khác thao túng select menu
    // trên 1 message public (dù /inventory hiển thị công khai).
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({
        content: "⚠️ Chỉ chủ nhân inventory này mới có thể chọn.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    const value = interaction.values[0]; // "book:Random Book" hoặc "item:Chipboard MK1"
    const colonIdx = value.indexOf(":");
    const itemType = value.slice(0, colonIdx);
    const itemName = value.slice(colonIdx + 1);

    const data = await getPlayerData(targetUserId);
    const store = itemType === "book" ? (data.books ?? {}) : (data.items ?? {});
    const currentCount = store[itemName] ?? 0;

    const canOpen = itemType === "book" && ["Random Book", "Sealed Book Cache", "Chipboard Cache"].includes(itemName);
    const canCraft = itemType === "item" && !!CRAFT_RECIPES[itemName];
    // canRead — sách "kiến thức" (có trong BOOK_GRANTS, VD "Cinq Association Book")
    // KHÁC hẳn "Random Book"/"Sealed Book Cache"/"Chipboard Cache" (hộp/gói ngẫu
    // nhiên dùng nút "Mở") — GAP ĐÃ SỬA: trước đây các sách kiến thức hoàn toàn
    // KHÔNG có nút hành động nào phù hợp trong menu này (chỉ "Xem info"/"Xóa"), dù
    // lệnh text `-readbook` đã tồn tại — giờ thêm nút riêng "📚 Đọc" để dùng được
    // ngay từ menu -inventory (xác nhận trực tiếp từ GM: "-readbook là phần sử
    // dụng sách trong menu của -inventory").
    const canRead = itemType === "book" && !!BOOK_GRANTS[itemName];

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`invinfo:${targetUserId}:${itemType}:${itemName}`)
        .setLabel("ℹ️ Xem info")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(canRead ? `invread:${targetUserId}:${itemType}:${itemName}` : `invact:${targetUserId}:${itemType}:${itemName}`)
        .setLabel(canRead ? "📚 Đọc" : (itemType === "book" ? "📖 Mở" : "⚙️ Craft"))
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canOpen && !canCraft && !canRead),
      new ButtonBuilder()
        .setCustomId(`invdel:${targetUserId}:${itemType}:${itemName}`)
        .setLabel("🗑️ Xóa 1")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(currentCount === 0),
    );

    await interaction.reply({
      content: `**${itemName}** × ${currentCount}\nChọn hành động:`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log("error", "invsel select", interaction.user?.id ?? "unknown", err.message);
    interaction.reply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {

  // ── /rtparry ── (tương đương -rtparry, nhưng link gửi qua EPHEMERAL thay vì DM —
  // slash command mới ephemeral được, prefix message thường thì Discord không hỗ trợ.
  // Cooldown dùng key "parryrt_web" THỦ CÔNG (không qua replyOnCooldown — hàm đó tự
  // dùng interaction.commandName làm key, sẽ tạo cooldown RIÊNG cho slash command,
  // cho phép spam đổi qua đổi lại -rtparry/`/rtparry` để né cooldown 5s).
  if (interaction.commandName === "rtparry") {
    const nameArg = interaction.options.getString("name");
    let targetSkill = null;
    if (nameArg) {
      targetSkill = findSkill(nameArg);
      if (!targetSkill) {
        await interaction.reply({ content: `⚠️ Không tìm thấy skill **"${nameArg}"**. Bỏ trống \`name\` cho bản mặc định.`, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
    }
    // targetSkill = null nếu bỏ trống name — KHÔNG tự chọn random skill, xem comment
    // đầy đủ ở createRtparryToken().

    if (isOnCooldown(interaction.user.id, "parryrt_web", 5000)) {
      await interaction.reply({ content: "⏳ Chờ vài giây trước khi thử lại nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    // Reply CÔNG KHAI trước (placeholder, sẽ edit lại khi có kết quả) — y như prefix,
    // để channel vẫn thấy được thành tích. Message ephemeral KHÔNG fetch/edit lại
    // được qua API channel thường (chỉ qua webhook token riêng, hết hạn sau interaction
    // token ~15 phút — không đáng thêm phức tạp đó chỉ để né 1 placeholder công khai).
    let sentMsg;
    try {
      await interaction.reply({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description: `${interaction.user} đang chơi Parry Real Time…` +
            (targetSkill ? `\n> Page: **${targetSkill.name}**` : ""),
          color: 0xf39c12,
          footer: { text: "Kết quả sẽ tự hiện lại ở đây sau khi chơi xong" },
        }],
      });
      sentMsg = await interaction.fetchReply();
    } catch (err) {
      log("error", "parryrt", interaction.user.id, err.message);
      return;
    }

    const linkInfo = createRtparryToken({ userId: interaction.user.id, channelId: interaction.channelId, messageId: sentMsg.id, skill: targetSkill });
    if (!linkInfo) {
      await interaction.followUp({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description:
            "⚠️ Bot chưa biết URL public của mình (thiếu env var `RENDER_EXTERNAL_URL` hoặc `PUBLIC_URL`).\n" +
            "> Báo admin set 1 trong 2 biến này thì lệnh này mới hoạt động được.",
          color: 0xe74c3c,
        }],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    // Link riêng qua ephemeral — chỉ người gõ lệnh thấy, không cần DM, không ai
    // khác trong channel bấm hộ được.
    await interaction.followUp({
      embeds: [{ title: "⚔️ Parry Real Time", description: "Bấm nút dưới để mở Parry Real Time.", color: 0xf39c12 }],
      components: [buildRtparryLinkButton(linkInfo.url)],
      flags: MessageFlags.Ephemeral,
    }).catch(err => log("error", "parryrt_ephemeral", interaction.user.id, err.message));
    return;
  }

  // ── /skill ── (tương đương -skill, dùng CHUNG buildSkillListResult/buildSkillRollResult
  // để đảm bảo hành vi giống prefix 100% — không tự viết lại logic riêng ở đây)
  if (interaction.commandName === "skill") {
    if (await replyOnCooldown(interaction, 2000)) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      await interaction.deferReply();
      const keyword = interaction.options.getString("keyword");
      const page = interaction.options.getInteger("page") ?? 1;
      const result = buildSkillListResult({ keyword, page });
      if (result.error) { await interaction.editReply({ content: result.error }); return; }
      await interaction.editReply({ embeds: [result.embed] });
      return;
    }

    if (sub === "roll") {
      await interaction.deferReply();
      const nameInput = interaction.options.getString("name") ?? "";
      const rollCount = interaction.options.getInteger("count") ?? 1;
      // "arg" dùng cho skill có promptArg (VD: Thrust cần nhập Light hiện tại qua arg).
      const argInput = interaction.options.getString("arg");
      const forceDullahan = interaction.options.getBoolean("dullahan") ?? false;

      const skill = findSkill(nameInput);
      if (!skill) {
        await interaction.editReply({ content: `❌ Không tìm thấy skill: \`${nameInput}\`\nDùng \`/skill list\` để xem danh sách.` });
        return;
      }

      const result = buildSkillRollResult({ skill, rollCount, promptArgRaw: argInput, forceDullahan });
      if (result.error) { await interaction.editReply({ content: result.error }); return; }
      await interaction.editReply({ embeds: [result.embed] });
      return;
    }
    return;
  }

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
    const critMul = interaction.options.getNumber("critmul") ?? 1.3;
    const diceMul = interaction.options.getNumber("dicemul") ?? 1;
    const sinkingInit = interaction.options.getInteger("sinking") ?? 0;
    const ruptureInit = interaction.options.getInteger("rupture") ?? 0;
    const sanityInit = interaction.options.getInteger("sanity") ?? 0;
    const theLiving = interaction.options.getInteger("living") ?? 0;
    const theDeparted = interaction.options.getInteger("departed") ?? 0;
    const burnInit = interaction.options.getInteger("burn") ?? 0;
    const bleedInit = interaction.options.getInteger("bleed") ?? 0;
    const bleedActions = interaction.options.getInteger("bleedactions") ?? 1;
    const tremorInit = interaction.options.getInteger("tremor") ?? 0;
    const chargeInit = interaction.options.getInteger("charge") ?? 0;
    const bonusPct = interaction.options.getNumber("bonus") ?? 0;
    const sanityBonusPct = interaction.options.getNumber("sanitybonus") ?? 0;
    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving, theDeparted, burnInit, bleedInit, bleedActions, tremorInit, chargeInit });
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
      burnInit,
      bleedInit,
      bleedActions,
      chargeInit,
      tremorInit,
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
      await interaction.editReply(await buildBalanceEmbed(targetUser, targetUser.id === interaction.user.id));
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

    // Thay vì thực hiện ngay, hiển thị preview + nút Xác nhận/Hủy — nhất quán với
    // prefix -give, tránh chuyển nhầm người/nhầm số lượng.
    const previewLines = buildGivePreviewLines({ ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget });
    const giveId = registerPendingGive(interaction.user.id, targetUser.id, isAdmin, {
      ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget,
    });
    await interaction.editReply({
      embeds: [{
        title: "📦 Xác nhận chuyển đồ",
        description:
          `${interaction.user} muốn ${isAdmin ? "tặng" : "chuyển"} cho ${targetUser}:\n` +
          previewLines.map(l => `> ${l}`).join("\n"),
        color: 0xf0a500,
        footer: { text: "Hết hạn sau 60 giây" },
      }],
      components: [buildGiveConfirmRow(giveId)],
    });
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
  // ── /dothihelp — ephemeral (chỉ người dùng lệnh thấy được), theo yêu cầu trực
  // tiếp — KHÁC -dothihelp (gửi qua DM).
  if (interaction.commandName === "dothihelp") {
    const isAdminHelp = ADMIN_IDS.has(interaction.user.id);
    await interaction.reply({ embeds: [buildDothihelpEmbed(isAdminHelp)], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

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
      const { embed, components } = await buildProfileInfoEmbed(
        userId,
        interaction.user.displayName ?? interaction.user.username,
        "Bấm nút bên dưới để đổi profile"
      );
      await interaction.editReply({ embeds: [embed], components });
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

// ─── RTPARRY WEB PAGE ───────────────────────────────────────────────────────
/** Render trang Parry Real Time — HTML/CSS/JS thuần, không phụ thuộc gì bên ngoài.
 *  performance.now() chạy hoàn toàn trên máy user, không qua round-trip server
 *  lúc đo — đây là điểm khác biệt cốt lõi so với bản -rtparry trong Discord. */
function renderParryWebPage(token, windowMs, yellowMs, skillName) {
  // Audio hook — CHƯA có file thật (user sẽ cung cấp sau), nên đọc từ env var, fallback
  // rỗng. Client tự kiểm tra "có URL không" trước khi play — không lỗi gì nếu để trống,
  // chỉ là chạy không có âm thanh (im lặng) cho tới khi set 2 biến này.
  const soundYellowUrl = process.env.RTPARRY_SOUND_YELLOW_URL || "";
  const soundGoUrl = process.env.RTPARRY_SOUND_GO_URL || "";

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Parry Real Time</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
  #stage {
    height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 24px; user-select: none;
    background: #2c2f33; color: #fff; cursor: pointer;
  }
  #stage.idle    { background: #2c2f33; }
  #stage.waiting { background: #c0392b; }
  #stage.yellow  { background: #f1c40f; color: #2c2f33; }
  #stage.go      { background: #27ae60; }
  #stage.early   { background: #8e44ad; }
  #stage.missed  { background: #7f8c8d; }
  #stage.done    { background: #2c2f33; cursor: default; }
  h1 { font-size: clamp(22px, 7vw, 42px); margin: 0 0 12px; }
  p  { font-size: clamp(15px, 4vw, 20px); max-width: 480px; opacity: 0.9; }
  .big { font-size: clamp(36px, 12vw, 90px); font-weight: 800; margin: 8px 0; }
  button.start {
    margin-top: 16px; padding: 16px 32px; font-size: 18px; border: none; border-radius: 12px;
    background: #5865f2; color: #fff; cursor: pointer;
  }
  .footer { position: fixed; bottom: 12px; font-size: 12px; opacity: 0.5; }
</style>
</head>
<body>
<div id="stage" class="idle">
  <h1>⚔️ Parry Real Time</h1>
  <p>${skillName ? `Page: <b>${skillName}</b><br>` : ""}Đỏ = chuẩn bị · Vàng = sắp tới · Xanh = BẤM NGAY (trong ${windowMs}ms)</p>
  <button class="start" id="startBtn">Bắt đầu</button>
</div>
<div class="footer">Token: ${token.slice(0, 8)}… · Kết quả sẽ tự gửi vào Discord</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const WINDOW_MS = ${windowMs};
const YELLOW_MS = ${yellowMs};
const SOUND_YELLOW_URL = ${JSON.stringify(soundYellowUrl)};
const SOUND_GO_URL = ${JSON.stringify(soundGoUrl)};
const stage = document.getElementById("stage");
const startBtn = document.getElementById("startBtn");
let phase = "idle"; // idle | waiting | yellow | go | late | done
let t0 = null;
let timer = null;
let yellowTimer = null;
let goTimeoutTimer = null;
let noClickTimer = null;

function setPhase(p, html) {
  phase = p;
  stage.className = p === "late" ? "missed" : p; // dùng lại màu "missed" cho "late"
  stage.innerHTML = html;
}

// Preload audio NGAY lúc trang load — KHÔNG đợi tới lúc cần phát mới tạo Audio() như
// trước (đó là bug thật: tạo mới + bắt đầu fetch network đúng lúc màn vàng/xanh xuất
// hiện, có thể làm việc tải/decode file cạnh tranh CPU với việc render màn hình ngay
// lúc cần chính xác nhất — đặc biệt rõ với Page "fast" vì vàng chỉ kéo dài 50-150ms,
// file có thể chưa tải xong khi cần chuyển xanh). Giờ tạo Audio() 1 lần, gọi .load()
// chủ động ngay khi script chạy — lúc thật sự cần phát, file đã sẵn sàng từ trước.
const yellowAudio = SOUND_YELLOW_URL ? new Audio(SOUND_YELLOW_URL) : null;
const goAudio = SOUND_GO_URL ? new Audio(SOUND_GO_URL) : null;
if (yellowAudio) { yellowAudio.preload = "auto"; yellowAudio.load(); }
if (goAudio) { goAudio.preload = "auto"; goAudio.load(); }

// playSound — KHÔNG lỗi gì nếu chưa có audio (url rỗng) hoặc browser chặn autoplay.
// User đã bấm "Bắt đầu" trước đó nên đã có user-gesture trong page, audio.play()
// thường được phép sau đó, nhưng vẫn catch lỗi cho chắc (Safari/mobile có thể khác).
// Dùng LẠI audio object đã preload (currentTime reset về 0 để phát lại từ đầu nếu
// user chơi nhiều lần) — không tạo mới mỗi lần gọi.
function playSound(audio) {
  if (!audio) return;
  try {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch (e) {}
}

function startRound() {
  setPhase("waiting", "<h1>Chờ…</h1><p>ĐỪNG bấm vội — chờ qua VÀNG rồi tới XANH</p>");
  const delay = 1200 + Math.random() * 2800; // 1.2s~4s, random để không đoán được nhịp
  timer = setTimeout(() => {
    // Màn VÀNG — thời gian giữ vàng (YELLOW_MS) phụ thuộc tốc độ Page đang luyện, suy
    // ra từ cooldown thật của skill (xem inferPageSpeed phía server) — Page nhanh thì
    // vàng gần như tức khắc chuyển xanh, Page chậm thì giữ vàng lâu hơn nhiều.
    setPhase("yellow", "<h1>⚠️ Sắp tới!</h1>");
    playSound(yellowAudio);
    yellowTimer = setTimeout(() => {
      // QUAN TRỌNG: setPhase() TRƯỚC, ghi t0 SAU — và không ghi ngay mà đợi qua
      // double requestAnimationFrame. Trước đây ghi t0 = performance.now() NGAY
      // LẬP TỨC rồi MỚI gọi setPhase() — nghĩa là t0 đo "lúc code bắt đầu chạy",
      // không phải "lúc màn hình THẬT SỰ chuyển xanh". Giữa lúc yêu cầu đổi DOM
      // (className + innerHTML) và lúc trình duyệt thực sự PAINT thay đổi đó lên
      // màn hình luôn có 1 khoảng trễ (đợi tới vsync/frame kế tiếp, vài ms tới hơn
      // chục ms tùy máy). requestAnimationFrame lồng đôi là kỹ thuật chuẩn để chờ
      // tới khi chắc chắn frame chứa thay đổi đó ĐÃ được vẽ — rAF đầu tiên chạy
      // ngay TRƯỚC frame kế tiếp (đổi màu vừa apply nhưng có thể chưa lên màn
      // hình), rAF thứ hai (lồng trong rAF đầu) chạy ở frame SAU đó — lúc này chắc
      // chắn frame xanh đã vẽ xong. t0 ghi ở đây mới đúng là "lúc xanh thật sự".
      setPhase("go", "<div class='big'>BẤM NGAY!</div>");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          t0 = performance.now();
          // playSound() ĐẶT SAU khi đã chốt t0 — trước đây gọi TRƯỚC double rAF, nghĩa
          // là việc khởi động audio (seek currentTime=0 + play()) có khả năng (dù nhỏ)
          // chiếm main-thread đúng lúc rAF cần chạy, làm trễ thêm vài ms ngoài dự kiến.
          // Giờ âm thanh phát SAU khi đã đo xong — đánh đổi vài ms lệch audio-visual
          // (không đáng kể, tai người khó phân biệt) để đảm bảo việc ĐO không bị bất kỳ
          // công việc nào khác chen vào.
          playSound(goAudio);
          // Đếm ngược WINDOW_MS cũng neo theo CHÍNH XÁC mốc t0 này — không phải
          // mốc setTimeout fire — để 2 con số (thời điểm "xanh thật" và thời điểm
          // "hết giờ") luôn khớp nhau, không lệch theo độ trễ rAF kể trên.
          goTimeoutTimer = setTimeout(() => {
            setPhase("late", "<h1>⌛ Trễ rồi!</h1><p>Vẫn bấm để xem bạn trễ bao nhiêu</p>");
            // Failsafe: nếu sau đó vẫn không bấm luôn, tự submit "missed" thật (không
            // số) sau 1 khoảng đủ dài — không để phiên treo vô hạn.
            noClickTimer = setTimeout(() => submitResult(null, "missed"), 5000);
          }, WINDOW_MS);
        });
      });
    }, YELLOW_MS);
  }, delay);
}

async function submitResult(reactionMs, resultType) {
  clearTimeout(goTimeoutTimer);
  clearTimeout(noClickTimer);
  setPhase("done", "<h1>⏳ Đang gửi kết quả…</h1>");
  try {
    const res = await fetch("/rtparry/" + TOKEN + "/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reactionMs, resultType }),
    });
    const data = await res.json();
    if (data.ok) {
      const msgByType = {
        success: "<h1>✅ " + Math.round(reactionMs) + "ms</h1><p>Kết quả đã gửi vào Discord. Có thể đóng tab này.</p>",
        early:   "<h1>❌ Bấm sớm quá!</h1><p>Kết quả đã gửi vào Discord. Có thể đóng tab này.</p>",
        missed:  "<h1>⌛ Bỏ lỡ!</h1><p>Kết quả đã gửi vào Discord. Có thể đóng tab này.</p>",
      };
      setPhase("done", msgByType[resultType] ?? msgByType.success);
    } else {
      setPhase("done", "<h1>⚠️ " + (data.error || "Có lỗi xảy ra") + "</h1><p>Link có thể đã hết hạn — quay lại Discord dùng <code>-rtparry</code> lại.</p>");
    }
  } catch (e) {
    setPhase("done", "<h1>⚠️ Lỗi kết nối</h1><p>Không gửi được kết quả — kiểm tra mạng rồi thử lại.</p>");
  }
}

startBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  startRound();
});

stage.addEventListener("click", () => {
  if (phase === "waiting" || phase === "yellow") {
    // Bấm sớm (kể cả lúc ĐÃ vàng nhưng chưa xanh) = THẤT BẠI THẬT — khớp đúng cảm giác
    // Sekiro: thấy ký hiệu báo trước không có nghĩa được đỡ ngay, phải đợi đúng lúc đòn
    // landing (xanh) mới đỡ được. Trước đây cho "thử lại tại chỗ" miễn phí ở phase
    // "waiting", không báo server — nghĩa là spam-click suốt từ đầu KHÔNG BAO GIỜ bị
    // tính fail. Giờ bấm sớm 1 lần (dù đỏ hay vàng) là kết thúc phiên luôn, y như bấm
    // trễ (missed) hay bấm đúng lúc (success) — phải gõ -rtparry lại để có lượt mới.
    clearTimeout(timer);
    clearTimeout(yellowTimer);
    submitResult(null, "early");
  } else if ((phase === "go" || phase === "late") && t0 !== null) {
    // "late" vẫn submit như "success" — server tự ép thành "missed" nếu reactionMs
    // vượt windowMs (xem route POST), nhưng giờ có SỐ THẬT để hiển thị khi báo bỏ lỡ.
    const reactionMs = performance.now() - t0;
    submitResult(reactionMs, "success");
  } else if (phase === "go") {
    // Edge case cực hiếm: phase đã là "go" nhưng t0 chưa kịp set (đang chờ qua double
    // rAF xác nhận đã paint xong, xem comment ở startRound). Click rơi đúng vào khe vài
    // ms này thực tế gần như không thể xảy ra với phản xạ người thật — coi như bấm
    // sớm để an toàn, tránh tính ra reactionMs vô nghĩa (performance.now() - null).
    submitResult(null, "early");
  }
});
</script>
</body>
</html>`;
}


// ─── EXPRESS SERVER ────────────────────────────────────────────────────────────
app.get("/", (req, res) => botReady ? res.send("Bot is alive and kicking!") : res.status(503).send("Bot is starting up..."));

// GET /rtparry/:token — serve trang test phản xạ (chỉ nếu token còn hợp lệ).
app.get("/rtparry/:token", (req, res) => {
  const session = webParrySessions.get(req.params.token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).send(
      "<!DOCTYPE html><html><body style='font-family:sans-serif;text-align:center;padding:40px;background:#2c2f33;color:#fff'>" +
      "<h2>⚠️ Link đã hết hạn hoặc không hợp lệ</h2><p>Quay lại Discord và dùng <code>-rtparry</code> để lấy link mới.</p>" +
      "</body></html>"
    );
  }
  res.send(renderParryWebPage(req.params.token, session.windowMs, session.yellowMs, session.skillName));
});

// POST /rtparry/:token/result — nhận kết quả đo được TỪ TRÌNH DUYỆT user (đã tính
// xong reactionMs bằng performance.now() phía client), rồi edit lại message Discord
// gốc với kết quả thật, không lẫn latency.
app.post("/rtparry/:token/result", async (req, res) => {
  const session = webParrySessions.get(req.params.token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).json({ ok: false, error: "Link đã hết hạn hoặc đã được dùng." });
  }
  webParrySessions.delete(req.params.token); // single-use — dùng 1 lần là xoá ngay

  const { reactionMs, resultType } = req.body ?? {};
  // Validate input — đây là endpoint public, ai có token cũ (đã hết hạn nhưng đoán
  // được) hoặc tự curl cũng gọi được, nên không tin tưởng giá trị gửi lên vô điều
  // kiện. Tách riêng 2 loại: (a) dữ liệu hỏng hẳn (không phải number, NaN, âm, hoặc
  // >10s — gần như chỉ xảy ra khi tự gọi API thô, không phải từ trang web thật) thì
  // từ chối thẳng, message Discord giữ nguyên "đang chờ"; (b) số HỢP LỆ về kiểu dữ
  // liệu nhưng QUÁ NHANH để là phản xạ con người thật — đây mới là case đáng quan
  // tâm hơn, nên BÁO RÕ trong Discord (xem RTPARRY_MIN_HUMAN_MS) thay vì để message
  // treo mãi "đang chờ kết quả" không bao giờ cập nhật.
  const isNumberSane = typeof reactionMs === "number" && Number.isFinite(reactionMs) && reactionMs >= 0 && reactionMs < 10_000;
  if (resultType === "success" && !isNumberSane) {
    return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
  }

  // QUAN TRỌNG: client tự báo "success" không có nghĩa nó THẬT — JS phía client có
  // thể bị sửa qua devtools/curl trực tiếp để bypass timeout WINDOW_MS và luôn báo
  // "success" với bất kỳ reactionMs nào. Server PHẢI tự validate lại: nếu reactionMs
  // vượt windowMs của session, ép về "missed" dù client gửi gì lên — đây chính là
  // bug đã gặp (1077ms vẫn báo "thành công") vì trước đây hoàn toàn tin client.
  let finalType = resultType;
  if (resultType === "success" && reactionMs > session.windowMs) {
    finalType = "missed";
  } else if (resultType === "success" && reactionMs < RTPARRY_MIN_HUMAN_MS) {
    // SÀN SINH LÝ HỌC: con người KHÔNG THỂ phản xạ thị giác dưới ~80ms dù luyện tập
    // nhiều (giới hạn dẫn truyền thần kinh-cơ, không phải kỹ năng). Random delay
    // 1.2-4s trước khi xanh chỉ chống được macro ĐOÁN timing cố định — không chống
    // được script tự động kiểu MutationObserver theo dõi class đổi thành "go" rồi
    // tự bắn click NGAY khi thấy (không đoán gì cả, phản ứng thật với sự kiện DOM)
    // — loại này luôn ra reactionMs ~1-10ms bất kể random delay bao nhiêu. Không
    // phải "chặn tuyệt đối mọi cheat" (vẫn có thể script giả lập delay 90-100ms để
    // né), nhưng chặn được trường hợp lộ liễu nhất, chi phí gần như 0.
    finalType = "rejected";
  }

  try {
    const channel = await client.channels.fetch(session.channelId);
    const msg = await channel.messages.fetch(session.messageId);

    if (finalType === "early") {
      await msg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time — Web",
          description: `<@${session.userId}> đã **bấm sớm quá**! ❌` + (session.skillName ? `\n> Page: **${session.skillName}**` : ""),
          color: 0xe74c3c,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
      });
    } else if (finalType === "missed") {
      // reactionMs có giá trị thật khi user CÓ bấm nhưng trễ (server tự ép success→missed
      // vì vượt windowMs) — hiển thị số đó để họ biết chính xác trễ bao nhiêu. Chỉ khi
      // reactionMs null (failsafe client tự submit vì không bấm luôn) mới hiện chung chung.
      const lateMs = (typeof reactionMs === "number" && Number.isFinite(reactionMs)) ? Math.round(reactionMs) : null;
      await msg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time — Web",
          description:
            `<@${session.userId}> đã **bỏ lỡ** đòn! ❌\n` +
            (lateMs !== null
              ? `> Phản ứng: **${lateMs}ms** — chậm hơn cửa sổ **${session.windowMs}ms**`
              : `> Cửa sổ parry: **${session.windowMs}ms** — không bấm kịp!`) +
            (session.skillName ? `\n> Page: **${session.skillName}**` : ""),
          color: 0xe74c3c,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
      });
    } else if (finalType === "rejected") {
      await msg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time — Web",
          description:
            `<@${session.userId}> kết quả **không hợp lệ** ⚠️\n` +
            `> Phản ứng dưới **${RTPARRY_MIN_HUMAN_MS}ms** — nhanh hơn khả năng phản xạ thật của con người, không được tính.`,
          color: 0x95a5a6,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
      });
    } else {
      const ms = Math.round(reactionMs);
      const rating =
        // Mốc tính theo phản xạ thật (windowMs=250) — không còn latency Discord/CSS
        // pha trộn vào nữa, nên hạ hẳn so với mốc cũ (100/200/300, vốn tính trên số
        // đo bị thổi phồng do bug/latency). <120ms gần như chỉ người phản xạ rất tốt
        // hoặc có luyện tập mới đạt được liên tục; 250ms là giới hạn cứng (window).
        ms < 120 ? "🏆 **AMAZING!** Phản ứng SIÊU NHANH!" :
        ms < 160 ? "⚡ **GREAT!** Phản ứng rất nhanh!"   :
        ms < 200 ? "✅ **GOOD!** Phản ứng tốt!"          :
                   "😅 **NOT BAD!** Vừa kịp!";
      await msg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time — Web",
          description:
            `<@${session.userId}> **PARRY THÀNH CÔNG!** ✅\n` +
            `> ⚡ Phản ứng: **${ms}ms** — ${rating}\n` +
            `> Cửa sổ parry: **${session.windowMs}ms**` + (session.skillName ? ` · Page: **${session.skillName}**` : ""),
          color: 0x2ecc71,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
      });
    }
  } catch (err) {
    log("error", "parryrt_web_result", session.userId, err.message);
    // Vẫn trả ok cho client — họ đã đo xong, lỗi edit message Discord không phải
    // lỗi của họ, không cần báo lỗi lên trang web.
  }

  res.json({ ok: true });
});

app.use((req, res) => res.status(404).send("Not found."));
app.use((err, req, res, next) => { console.error("[Express error]", err); res.status(500).send("Internal server error."); });

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () => log("info", "startup", "system", `Server running on port ${PORT}`));

// Clear timer khi process shutdown để tránh memory leak
// BUG THẬT ĐÃ SỬA (phát hiện qua test thật, không phải yêu cầu trực tiếp):
// webParrySessionCleanupTimer đã CHUYỂN sang rtparry.js từ session tách file
// trước đó và KHÔNG được export ra ngoài — dòng clearInterval cũ tham chiếu 1
// biến KHÔNG TỒN TẠI trong scope index.js, gây ReferenceError MỖI LẦN graceful
// shutdown (SIGTERM/SIGINT) chạy — process bị crash thay vì thoát êm. Bỏ dòng
// đó — timer của rtparry.js tự quản lý riêng, process.exit() tự dọn dẹp mọi
// interval khi process thực sự kết thúc, không cần clear thủ công ở đây.
function gracefulShutdown(signal) {
  log("info", "shutdown", "system", `${signal} received, shutting down.`);
  clearInterval(cooldownCleanupTimer);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => log("error", "uncaughtException", "system", err.message, { stack: err.stack }));
process.on("unhandledRejection", (reason) => log("error", "unhandledRejection", "system", String(reason)));
