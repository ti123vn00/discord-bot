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

// ─── REAL-TIME PARRY (web flow — đo chính xác 100%, không lẫn latency Discord) ──
// `-rtparry` / `/rtparry` gửi DM 1 link ra trang Parry Real Time độc lập (route
// Express bên dưới), performance.now() chạy NGAY trên máy user — không qua
// round-trip Discord nào lúc đo, nên không có vấn đề clock-skew/latency như bản
// message-edit-đếm-ngược cũ (đã bỏ hoàn toàn — không còn fallback).
// Map<token, session> — token sống NGẮN (chỉ vài chục giây) nên dùng RAM, không cần
// Upstash: nếu bot restart giữa lúc user đang làm bài thì coi như hỏng phiên, chấp
// nhận được vì tỉ lệ xảy ra cực thấp và đây chỉ là minigame, không phải economy.
const webParrySessions = new Map();
const WEB_PARRY_TTL_MS = 90_000; // đủ thời gian user mở tab, đọc hướng dẫn, rồi mới bấm
// Cửa sổ parry (ms) — quá mốc này coi như "bỏ lỡ". Đặt thành const chung 1 chỗ thay vì
// hardcode rải rác (help text, route POST, v.v.) — tránh lệch số như đã từng gặp khi
// đổi 400→500→550 mà quên sửa hết chỗ. Đã hạ từ 550 xuống 250 vì giờ đo phản xạ thật,
// không còn latency Discord/CSS transition bù vào nữa.
const RTPARRY_WINDOW_MS = 400;
// Sàn sinh lý học — không ai phản xạ thị giác dưới mức này thật, dùng để lọc kết
// quả từ script tự động (xem comment đầy đủ ở route POST /rtparry/:token/result).
const RTPARRY_MIN_HUMAN_MS = 0;
const webParrySessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, s] of webParrySessions)
    if (s.expiresAt < now) webParrySessions.delete(token);
}, 30_000);

/** Lấy base URL public của bot — Render tự set RENDER_EXTERNAL_URL, fallback PUBLIC_URL
 *  cho môi trường khác (VD: chạy local hoặc host khác không tự set biến này). */
function getPublicBaseUrl() {
  return process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || null;
}

// ─── RTPARRY — TỐC ĐỘ PAGE (hệ thống 3 màu: đỏ→vàng→xanh, lấy cảm hứng Sekiro) ────
// Game gốc turn-based, KHÔNG có khái niệm "tốc độ real-time" nào — không có field
// nào trong skills.js được thiết kế để đại diện cho việc này. Đây là HEURISTIC suy
// luận từ field gần nhất có sẵn, không phải dữ liệu chính xác:
//   - weaponType (Heavy/Medium/Light): chỉ 7/302 skill có field này, và phần lớn skill
//     dùng weaponOf lại trỏ tới vũ khí KHÔNG có weaponType (VD: Durandal tự trỏ vào
//     chính nó) → phủ quá ít, không dùng được.
//   - diceMul: có ở mọi skill, nhưng 253/302 (84%) đều là "1x" → không phân biệt được.
//   - cd (cooldown): phân bố tốt nhất (120×2Turn, 55×1Turn, 52×3Turn, 37×4Turn, 16×"—",
//     9×5Turn, 7×6Turn) — suy luận: cd ngắn = đòn cơ bản/nhẹ dùng liên tục = NHANH;
//     cd dài = đòn nặng/ulti cần hồi lâu = CHẬM (telegraph dài hơn, giống đòn nặng
//     trong Sekiro có ký hiệu báo trước lâu hơn).
// Một số skill có thể bị suy luận sai (cd không = tốc độ thật) — chấp nhận được vì
// đây chỉ là minigame vui, không phải dữ liệu combat chính thức.
function inferPageSpeed(skill) {
  const cd = (skill.cd ?? "").trim();
  if (cd === "—" || cd === "") return "fast";
  const match = cd.match(/^(\d+)/);
  if (!match) return "normal"; // text không parse được rõ ràng (VD: "Khi X kích hoạt")
  const turns = parseInt(match[1], 10);
  if (turns <= 1) return "fast";
  if (turns <= 3) return "normal";
  return "slow";
}

// Khoảng thời gian (ms) màn vàng hiện trước khi chuyển xanh, theo tốc độ suy luận được.
// fast gần như tức khắc ("vàng cái thì instant xanh luôn" — ý gốc của Hugo); slow giữ
// lâu ("đợi lóe lên một lúc lâu mới xanh").
const PAGE_SPEED_YELLOW_MS = {
  fast:   { min: 50,   max: 150 },
  normal: { min: 500,  max: 900 },
  slow:   { min: 1300, max: 2000 },
};

// Cửa sổ parry (ms) — CŨNG phải đổi theo tốc độ Page, không chỉ riêng màn vàng. Lý do:
// Page chậm giữ vàng rất lâu (lên tới 2000ms) trước khi xanh — đã chờ lâu như vậy mà
// cửa sổ vẫn cố định 300ms như Page nhanh thì cảm giác RẤT khó/trễ (đợi căng cả 2s mà
// chỉ có 300ms để phản ứng, không tương xứng với độ "nặng"/báo trước dài của đòn chậm).
// Đòn chậm trong nhiều game parry cũng thường DỄ đỡ hơn vì thấy rõ trước — nên window
// rộng hơn cho slow, hẹp hơn cho fast (đòn nhanh cần phản ứng chính xác, ít khoan nhượng).
const PAGE_SPEED_WINDOW_MS = {
  fast:   300,
  normal: 400,
  slow:   560,
};

function randomYellowMs(speedTier) {
  const { min, max } = PAGE_SPEED_YELLOW_MS[speedTier] ?? PAGE_SPEED_YELLOW_MS.normal;
  return Math.round(min + Math.random() * (max - min));
}

/**
 * createRtparryToken — tạo token mới + lưu session, trả về URL đầy đủ. Đây là phần
 * CHUNG thật sự giữa prefix và slash — phần GỬI link (DM hay ephemeral) khác nhau đủ
 * nhiều (xem comment ở từng handler) nên để mỗi bên tự lo, không gò vào 1 hàm chung.
 * @param {object|null} skill — skill object (đã resolve qua findSkill ở caller) dùng để
 *   suy ra tốc độ vàng→xanh + cửa sổ qua inferPageSpeed(). NULL khi gọi `-rtparry` /
 *   `/rtparry` KHÔNG kèm tên — lúc đó dùng mốc mặc định cố định (RTPARRY_WINDOW_MS +
 *   tier "normal" cho vàng), KHÔNG tự chọn skill ngẫu nhiên (trước đây có làm vậy,
 *   user phản hồi là sai — "-rtparry" trần không liên quan gì tới page cụ thể nào cả,
 *   nên giữ hành vi đơn giản/cố định như cũ, chỉ thêm màn vàng cho đồng bộ UI 3 màu).
 * @returns {{ url: string, token: string } | null} null nếu thiếu baseUrl
 */
function createRtparryToken({ userId, channelId, messageId, skill = null }) {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) return null;
  const token = crypto.randomBytes(16).toString("hex");
  const speedTier = skill ? inferPageSpeed(skill) : "normal";
  webParrySessions.set(token, {
    userId,
    channelId,
    messageId,
    windowMs: skill ? PAGE_SPEED_WINDOW_MS[speedTier] : RTPARRY_WINDOW_MS,
    yellowMs: randomYellowMs(speedTier),
    skillName: skill ? skill.name : null,
    expiresAt: Date.now() + WEB_PARRY_TTL_MS,
  });
  return { url: `${baseUrl}/rtparry/${token}`, token };
}

function buildRtparryLinkButton(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("🔗 Mở Parry Real Time").setStyle(ButtonStyle.Link).setURL(url)
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
  "burn", "bleed", "bleedactions", "tremor", "charge",
  "books", "items",
  "name", "hp", "weapon", "stamina", "light", // -encounter start/join/bossattack
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

function validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving = 0, theDeparted = 0, burnInit = 0, bleedInit = 0, bleedActions = 1, tremorInit = 0, chargeInit = 0 }) {
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
  if (isNaN(burnInit) || !Number.isInteger(burnInit) || burnInit < 0 || burnInit > BURN_MAX) errors.push(`Burn phải từ 0–${BURN_MAX}`);
  if (isNaN(bleedInit) || !Number.isInteger(bleedInit) || bleedInit < 0 || bleedInit > BLEED_MAX) errors.push(`Bleed phải từ 0–${BLEED_MAX}`);
  if (isNaN(bleedActions) || !Number.isInteger(bleedActions) || bleedActions < 0) errors.push("bleedactions phải là số nguyên ≥ 0");
  if (isNaN(tremorInit) || !Number.isInteger(tremorInit) || tremorInit < 0 || tremorInit > TREMOR_MAX) errors.push(`Tremor phải từ 0–${TREMOR_MAX}`);
  if (isNaN(chargeInit) || !Number.isInteger(chargeInit) || chargeInit < 0 || chargeInit > CHARGE_MAX) errors.push(`Charge phải từ 0–${CHARGE_MAX}`);
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

// buildProfileInfoEmbed đã chuyển sang player-actions.js (xem phần require + wiring bên dưới)
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


function calcMathCore(opts) {
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
    burnInit = 0,
    bleedInit = 0,
    bleedActions = 1, // số lần địch hành động trong turn — Bleed trigger MỖI LẦN địch
                       // hành động (không phải lúc bị mình tấn công), /math không tự
                       // biết enemy hành động mấy lần nên cần nhập tay số này.
    tremorInit = 0,
    chargeInit = 0,
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
  // Poise/Charge/Burn/Bleed/Tremor hỗ trợ CẢ +N (cộng) và -N (tiêu thụ/trừ) — VD Draw
  // of the Sword: "Nhận 2 Poise. Tiêu thụ 6 Poise để nhận 2 Light" → dmgStr ghi
  // "+2Poise-6Poise" trên CÙNG 1 hit. Sinking/Rupture/Living/Departed GIỮ NGUYÊN chỉ
  // +N (không đổi) — không có yêu cầu hỗ trợ trừ cho 4 cái này.
  //
  // QUAN TRỌNG: "TremorBurst" PHẢI đứng TRƯỚC "Tremor" trong alternation — vì
  // "TremorBurst" CHỨA chuỗi "Tremor" làm tiền tố. Nếu "Tremor" được thử trước,
  // regex sẽ khớp nhầm "+3Tremor" (trong "+3TremorBurst") rồi để lại "Burst" dư ra
  // không khớp được gì cả → cả tag TremorBurst bị "nuốt mất" âm thầm, không lỗi gì
  // nhưng hiệu ứng biến mất khỏi effectsStr hoàn toàn.
  const damageRegex =
    /([\d.]+)(?:x([\d.]+))?(?:\+([\d.]+)%?)?\s*(Dice)?([BPSbps])((?:\+\d*Sinking|\+\d*Rupture|[+-]\d*Poise|[+-]\d*Charge|[+-]\d*Burn|[+-]\d*Bleed|\+\d*TremorBurst|[+-]\d*Tremor|\+\d*Living|\+\d*Departed|\+Crit\d+)*)/gi;
  // sumSignedTag — tách riêng GAIN (tổng "+N<tag>") và CONSUME (tổng "-N<tag>", dạng
  // số dương) trong effectsStr của 1 hit — KHÔNG gộp net ngay ở đây, vì cần biết riêng
  // 2 phần để phát hiện "tiêu thụ không đủ" (VD: +2Poise-6Poise mà lúc áp dụng chỉ có
  // 4 Poise sau gain thì thiếu 2, cần báo rõ thay vì chỉ lặng lẽ clamp về 0).
  // excludeSuffix: negative lookahead để loại match bị "lẫn" vào tag dài hơn cùng tiền
  // tố (VD tagName="Tremor", excludeSuffix="Burst" → "+3Tremor" trong "+3TremorBurst"
  // KHÔNG được tính là gain Tremor, vì đó thực ra là số lần TremorBurst).
  function sumSignedTag(effectsStr, tagName, excludeSuffix = null) {
    if (!effectsStr) return { gain: 0, consume: 0 };
    const lookahead = excludeSuffix ? `(?!${excludeSuffix})` : "";
    const re = new RegExp(`([+-])(\\d*)${tagName}${lookahead}`, "gi");
    let gain = 0, consume = 0, m;
    while ((m = re.exec(effectsStr)) !== null) {
      const count = m[2] ? parseInt(m[2], 10) : 1;
      if (m[1] === "-") consume += count; else gain += count;
    }
    return { gain, consume };
  }
  while ((match = damageRegex.exec(dmgStr)) !== null) {
    const base = parseFloat(match[1]);
    const multiplier = match[2] ? parseInt(match[2]) : 1;
    const extraPct = match[3] ? parseFloat(match[3]) : 0;
    const isDice = !!match[4];
    const dmgType = match[5] ? match[5].toUpperCase() : "B";
    const effectsStr = match[6] || "";
    const sinkingMatch = effectsStr.match(/\+(\d+)?Sinking/i);
    const ruptureMatch = effectsStr.match(/\+(\d+)?Rupture/i);
    const livingMatch = effectsStr.match(/\+(\d+)?Living/i);
    const departedMatch = effectsStr.match(/\+(\d+)?Departed/i);
    // TremorBurst — giờ CÓ số đếm tùy chọn ("+NTremorBurst" = kích hoạt chu kỳ
    // dùng+giảm-nửa N LẦN trên CÙNG hit này, mặc định N=1 nếu không ghi số).
    const tremorBurstMatch = effectsStr.match(/\+(\d*)TremorBurst/i);
    const tremorBurstCount = tremorBurstMatch ? parseInt(tremorBurstMatch[1] || "1", 10) : 0;
    const sinkingToApply = sinkingMatch ? parseInt(sinkingMatch[1] || "1") : 0;
    const ruptureToApply = ruptureMatch ? parseInt(ruptureMatch[1] || "1") : 0;
    const livingToApply = livingMatch ? parseInt(livingMatch[1] || "1") : 0;
    const departedToApply = departedMatch ? parseInt(departedMatch[1] || "1") : 0;
    // Poise/Charge/Burn/Bleed/Tremor — giữ riêng gain/consume (không gộp net) để phát
    // hiện thiếu hụt lúc áp dụng thật (xem comment ở khối "Apply stack mới" trong loop).
    const poiseTag = sumSignedTag(effectsStr, "Poise");
    const chargeTag = sumSignedTag(effectsStr, "Charge");
    const burnTag = sumSignedTag(effectsStr, "Burn");
    const bleedTag = sumSignedTag(effectsStr, "Bleed");
    const tremorTag = sumSignedTag(effectsStr, "Tremor", "Burst");
    for (let i = 0; i < multiplier; i++) {
      dmgValues.push({ value: base, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseTag, chargeTag, burnTag, bleedTag, tremorTag, tremorBurstCount, livingToApply, departedToApply, effectsStr });
    }
  }
  if (dmgValues.length === 0) {
    const zeroTag = { gain: 0, consume: 0 };
    dmgValues.push({ value: 0, type: "B", isDice: false, extraPct: 0, sinkingToApply: 0, ruptureToApply: 0, poiseTag: zeroTag, chargeTag: zeroTag, burnTag: zeroTag, bleedTag: zeroTag, tremorTag: zeroTag, tremorBurstCount: 0, livingToApply: 0, departedToApply: 0, effectsStr: "" });
  }

  let sanity = sanityInit;
  let totalDmg = 0;
  let totalPoise = poiseInit;
  let totalCharge = Math.min(Math.max(chargeInit, 0), CHARGE_MAX); // Charge: cộng/trừ qua dmg tag, KHÔNG có decay tự động (không như Poise crit-halve)
  let enemySinking = Math.min(sinkingInit, SINKING_MAX);
  let enemyTremor = Math.min(tremorInit, TREMOR_MAX);
  let totalTremorStaminaLoss = 0; // tích lũy từ các hit có +TremorBurst
  let enemyRupture = Math.min(ruptureInit, RUPTURE_MAX);
  // Burn/Bleed giờ là biến THEO DÕI được (giống enemySinking/enemyRupture), KHÔNG còn
  // là input tĩnh chỉ dùng 1 lần — vì dmg tag +N/-NBurn, +N/-NBleed có thể sửa số
  // count NGAY TRONG lúc đang tính các hit, trước khi áp dụng công thức end-turn-tick
  // (×2 dmg rồi giảm nửa cho Burn; ÷4×actions dmg rồi giảm nửa cho Bleed) ở CUỐI.
  let enemyBurn = Math.min(Math.max(burnInit, 0), BURN_MAX);
  let enemyBleed = Math.min(Math.max(bleedInit, 0), BLEED_MAX);
  let livingStacks = Math.min(theLiving, BUTTERFLY_LIVING_MAX);     // Count The Living hiện tại, có thể tăng qua +Living trong dmg
  let departedStacks = Math.min(theDeparted, BUTTERFLY_DEPARTED_MAX); // Count The Departed hiện tại, có thể tăng qua +Departed trong dmg
  let totalSanityHeal = 0;   // tích lũy từ The Living qua các hit
  let totalDepartedDmg = 0;  // tích lũy bonus dmg từ The Departed
  // Sanity Bonus hiệu dụng tích lũy: bắt đầu từ sanityBonusPct (input),
  // cộng thêm livingHeal sau mỗi hit — áp dụng cho Dice hit tiếp theo.
  let effectiveSanityBonus = sanityBonusPct;
  const instanceResults = [];

  for (const dmgObj of dmgValues) {
    const { value: dmg, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseTag, chargeTag, burnTag, bleedTag, tremorTag, tremorBurstCount, livingToApply, departedToApply, effectsStr } = dmgObj;
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

    // Apply stack mới từ đòn này sau khi đã tính dmg xong. Poise/Charge/Burn/Bleed áp
    // GAIN trước (cộng, clamp max) RỒI MỚI CONSUME (trừ, không cho âm) — khớp đúng
    // tường thuật "Nhận 2 Poise. Tiêu thụ 6 Poise" (cộng trước, trừ sau trên CÙNG 1
    // hit). Nếu consume > số đang có SAU gain (VD: crit ở hit trước đã làm hao Poise,
    // hit này gain không đủ bù) → shortfall > 0, được báo RÕ trong breakdown (xem
    // dưới) thay vì lặng lẽ clamp về 0 như trước — đúng câu hỏi: "lỡ không đủ thì sao?"
    const poiseAfterRawGain = Math.min(totalPoise + poiseTag.gain, POISE_MAX);
    const poiseShortfall = Math.max(0, poiseTag.consume - poiseAfterRawGain);
    totalPoise = Math.max(0, poiseAfterRawGain - poiseTag.consume);

    const chargeAfterRawGain = Math.min(totalCharge + chargeTag.gain, CHARGE_MAX);
    const chargeShortfall = Math.max(0, chargeTag.consume - chargeAfterRawGain);
    totalCharge = Math.max(0, chargeAfterRawGain - chargeTag.consume);

    const burnAfterRawGain = Math.min(enemyBurn + burnTag.gain, BURN_MAX);
    const burnShortfall = Math.max(0, burnTag.consume - burnAfterRawGain);
    enemyBurn = Math.max(0, burnAfterRawGain - burnTag.consume);

    const bleedAfterRawGain = Math.min(enemyBleed + bleedTag.gain, BLEED_MAX);
    const bleedShortfall = Math.max(0, bleedTag.consume - bleedAfterRawGain);
    enemyBleed = Math.max(0, bleedAfterRawGain - bleedTag.consume);

    // Tremor: GAIN/CONSUME (từ tag +N/-NTremor) áp dụng TRƯỚC, RỒI MỚI tới TremorBurst
    // (dùng giá trị tremor đã cập nhật — nếu hit này VỪA gây thêm Tremor vừa Burst,
    // Burst sẽ dùng được cả phần mới gây ra, khớp đúng tường thuật "gây X Tremor rồi
    // Burst luôn" trong 1 hit).
    const tremorAfterRawGain = Math.min(enemyTremor + tremorTag.gain, TREMOR_MAX);
    const tremorShortfall = Math.max(0, tremorTag.consume - tremorAfterRawGain);
    enemyTremor = Math.max(0, tremorAfterRawGain - tremorTag.consume);

    // ── Tremor Burst — "+NTremorBurst" lặp lại chu kỳ (dùng×5 Sta rồi giảm nửa) N
    // LẦN trên CÙNG hit này (mặc định N=1 nếu chỉ ghi "+TremorBurst" không số). Dừng
    // sớm nếu tremor về 0 giữa chừng (không có gì để Burst tiếp).
    let tremorStaminaLoss = 0;
    for (let burstIdx = 0; burstIdx < tremorBurstCount; burstIdx++) {
      if (enemyTremor <= 0) break;
      tremorStaminaLoss += enemyTremor * 5;
      enemyTremor = enemyTremor / 2;
      if (enemyTremor <= 0.5) enemyTremor = 0;
    }
    totalTremorStaminaLoss += tremorStaminaLoss;

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

    const poiseToApply = poiseTag.gain - poiseTag.consume; // net, dùng cho hiển thị +/-N gọn
    const chargeToApply = chargeTag.gain - chargeTag.consume;
    const burnToApply = burnTag.gain - burnTag.consume;
    const bleedToApply = bleedTag.gain - bleedTag.consume;
    const tremorToApply = tremorTag.gain - tremorTag.consume;

    instanceResults.push({
      dmg, dmgType, didCrit, critChance, poiseOverflow,
      poiseStacksAfter: totalPoise,  // sau critDiv — giá trị thực dùng cho hit tiếp theo
      poiseAfterGain,                 // sau gain, trước critDiv — để hiển thị gain chính xác
      poiseShortfall,
      instanceDmg, ruptureBonus, sinkingBonus,
      sinkingApplied: sinkingToApply,
      ruptureApplied: ruptureToApply,
      poiseApplied: poiseToApply,
      chargeApplied: chargeToApply, chargeStacksAfter: totalCharge, chargeShortfall,
      burnApplied: burnToApply, burnStacksAfter: enemyBurn, burnShortfall,
      bleedApplied: bleedToApply, bleedStacksAfter: enemyBleed, bleedShortfall,
      tremorApplied: tremorToApply, tremorStacksAfter: enemyTremor, tremorShortfall,
      tremorStaminaLoss, tremorBurstCount,
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

  // ── Burn (end-turn tick) ─────────────────────────────────────────────────────
  // "1 burn count sẽ gây dmg = 2x count mỗi khi end turn, sau đó giảm 1 NỬA (không
  // phải -1 như Sinking/Rupture), nếu đạt 0.5 thì hết." — tính SAU khi đã áp dụng
  // hết mọi +N/-NBurn từ các hit trong dmgStr (enemyBurn, không phải burnInit thô) —
  // để skill có thể "gây thêm Burn" hoặc "tiêu thụ Burn" ngay trong cùng 1 lần roll,
  // rồi mới tick cuối turn trên số liệu CUỐI CÙNG.
  const burnDmgThisTurn = enemyBurn * 2;
  let burnAfter = enemyBurn / 2;
  if (burnAfter <= 0.5) burnAfter = 0;

  // ── Bleed (trigger mỗi lần ĐỊCH hành động tấn công — không phải lúc bị tấn công
  // — RỒI giảm 1 nửa lúc end turn, đây là 2 thời điểm KHÁC NHAU) ────────────────
  // "1 bleed count gây dmg = 1/4 count mỗi khi địch hành động tấn công trong turn,
  // giảm 1 nửa sau end turn." — bleedActions = số lần địch hành động turn này (không
  // tự suy ra được, phải nhập tay vì /math không mô phỏng hành động của địch). Cũng
  // tính trên enemyBleed SAU khi áp dụng +N/-NBleed từ dmgStr, giống Burn ở trên.
  const bleedDmgPerAction = enemyBleed / 4;
  const bleedDmgThisTurn = bleedDmgPerAction * Math.max(0, bleedActions);
  let bleedAfter = enemyBleed / 2;
  if (bleedAfter <= 0.5) bleedAfter = 0;

  // Trả về TẤT CẢ biến cần cho phần display (calcMath) VÀ cho hệ thống khác (encounter)
  // muốn lấy số liệu thuần để lưu lại — không lọc bớt, tránh sót biến nào cần dùng sau.
  return {
    // Input gốc (echo lại để display dùng, không cần destructure lại opts)
    dmgStr, resStr, drStr, bonusPct, sanityBonusPct, critMul, poiseInit, critDiv,
    sanityInit, diceMul, sinkingInit, ruptureInit, theLiving, theDeparted,
    burnInit, bleedInit, bleedActions, tremorInit, chargeInit,
    // Kết quả tính toán — DÙNG ĐỂ LƯU LẠI cho encounter (số liệu mới sau hit này)
    totalDmg, finalSanity: sanity, finalPoiseStacks, finalSinking: enemySinking,
    finalRupture: enemyRupture, finalLivingStacks: livingStacks, finalDepartedStacks: departedStacks,
    finalCharge: totalCharge,
    totalSanityHeal, totalDepartedDmg, critCount,
    // Burn/Bleed (end-turn tick) — KHÔNG cộng vào totalDmg, vì đây là dmg ở 1 THỜI
    // ĐIỂM KHÁC (end turn), không phải dmg của hit đang tính.
    burnDmgThisTurn, finalBurn: burnAfter,
    bleedDmgThisTurn, finalBleed: bleedAfter,
    // Tremor Burst (per-hit, đã tích lũy trong loop ở trên)
    totalTremorStaminaLoss, finalTremor: enemyTremor,
    // Chi tiết — dùng để build breakdown display trong calcMath()
    instanceResults, dmgValues, resRaw, resValues, hasDR, drMult, drRawPct, effectiveSanityBonus,
  };
}

function calcMath(opts) {
  const calcResult = calcMathCore(opts);
  const {
    dmgStr, resStr, drStr, bonusPct, sanityBonusPct, critMul, poiseInit, critDiv,
    sanityInit, diceMul, sinkingInit, ruptureInit, theLiving, theDeparted,
    burnInit, bleedInit, bleedActions, tremorInit, chargeInit,
    totalDmg, finalSanity: sanity, finalPoiseStacks, finalSinking: enemySinking,
    finalRupture: enemyRupture, finalLivingStacks: livingStacks, finalDepartedStacks: departedStacks,
    finalCharge,
    totalSanityHeal, totalDepartedDmg, critCount,
    burnDmgThisTurn, finalBurn, bleedDmgThisTurn, finalBleed,
    totalTremorStaminaLoss, finalTremor,
    instanceResults, dmgValues, resRaw, resValues, hasDR, drMult, drRawPct, effectiveSanityBonus,
  } = calcResult;

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
    if (r.poiseApplied !== 0) {
      const sign = r.poiseApplied > 0 ? "+" : "";
      const label = r.poiseApplied > 0 ? "" : " (tiêu thụ)";
      if (critDiv > 1 && r.didCrit && r.poiseAfterGain !== r.poiseStacksAfter) {
        extraInfo += ` | ${sign}${r.poiseApplied} <:Poise:1513762945715142736>Poise${label}: ${r.poiseAfterGain} → ÷${critDiv} = ${r.poiseStacksAfter} Counts`;
      } else {
        extraInfo += ` | ${sign}${r.poiseApplied} <:Poise:1513762945715142736>Poise${label} → ${r.poiseStacksAfter} Counts`;
      }
    }
    if (r.poiseShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.poiseShortfall} <:Poise:1513762945715142736>Poise để tiêu thụ hết`;
    if (r.chargeApplied !== 0) {
      const sign = r.chargeApplied > 0 ? "+" : "";
      const label = r.chargeApplied > 0 ? "" : " (tiêu thụ)";
      extraInfo += ` | ${sign}${r.chargeApplied} <:Charge:1513762867558613033>Charge${label} → ${r.chargeStacksAfter} Counts`;
    }
    if (r.chargeShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.chargeShortfall} <:Charge:1513762867558613033>Charge để tiêu thụ hết`;
    if (r.burnApplied !== 0) {
      const sign = r.burnApplied > 0 ? "+" : "";
      const label = r.burnApplied > 0 ? "" : " (tiêu thụ)";
      extraInfo += ` | ${sign}${r.burnApplied} <:Burn:1513762753691652177>Burn${label} → ${r.burnStacksAfter} Counts`;
    }
    if (r.burnShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.burnShortfall} <:Burn:1513762753691652177>Burn để tiêu thụ hết`;
    if (r.bleedApplied !== 0) {
      const sign = r.bleedApplied > 0 ? "+" : "";
      const label = r.bleedApplied > 0 ? "" : " (tiêu thụ)";
      extraInfo += ` | ${sign}${r.bleedApplied} <:Bleed:1513762688226955285>Bleed${label} → ${r.bleedStacksAfter} Counts`;
    }
    if (r.bleedShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.bleedShortfall} <:Bleed:1513762688226955285>Bleed để tiêu thụ hết`;
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
    if (r.tremorApplied !== 0) {
      const sign = r.tremorApplied > 0 ? "+" : "";
      const label = r.tremorApplied > 0 ? "" : " (tiêu thụ)";
      extraInfo += ` | ${sign}${r.tremorApplied} <:Tremor:1513762737388257380>Tremor${label} → ${r.tremorStacksAfter} Counts`;
    }
    if (r.tremorShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.tremorShortfall} <:Tremor:1513762737388257380>Tremor để tiêu thụ hết`;
    if (r.tremorStaminaLoss > 0) {
      const burstNote = r.tremorBurstCount > 1 ? ` (x${r.tremorBurstCount} lần)` : "";
      extraInfo += ` | <:Tremor:1513762737388257380>Tremor Burst${burstNote}: -${r.tremorStaminaLoss} Sta địch → ${r.tremorStacksAfter} Counts`;
    }
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
    { name: "<:Burn:1513762753691652177>Burn (end turn)", value: `${burnDmgThisTurn.toFixed(2)} dmg — count: ${burnInit} → ${finalBurn}`, inline: true, showIf: burnInit > 0 || finalBurn > 0 || burnDmgThisTurn > 0 },
    { name: "Bleed (end turn)", value: `${bleedDmgThisTurn.toFixed(2)} dmg (x${bleedActions} hành động) — count: ${bleedInit} → ${finalBleed}`, inline: true, showIf: bleedInit > 0 || finalBleed > 0 || bleedDmgThisTurn > 0 },
    { name: "<:Tremor:1513762737388257380>Tremor Burst", value: `-${totalTremorStaminaLoss} Sta địch — count: ${tremorInit} → ${finalTremor}`, inline: true, showIf: tremorInit > 0 || finalTremor > 0 || totalTremorStaminaLoss > 0 },
    { name: "<:Charge:1513762867558613033>Charge Stacks", value: `${chargeInit} → ${finalCharge}`, inline: true, showIf: chargeInit > 0 || finalCharge > 0 },
  ];

  return {
    embeds: [{
      title: "📊 Kết quả tính DMG",
      color: 0x00ae86,
      fields: filterZeroFields(allFields),
    }],
  };
}


// ─── ENCOUNTER SYSTEM ───────────────────────────────────────────────────────
// Giải quyết đúng vấn đề Fragaria/Sora bàn: Profile bị bind cứng với 1 player cụ
// thể (key Redis luôn có userId), không thể tái dùng làm "entity có stat" cho boss.
// Encounter là model HOÀN TOÀN TÁCH BIỆT khỏi Profile — key theo channelId, không
// theo userId nào cả. Chỉ 1 encounter active / channel (đơn giản, theo yêu cầu).
//
// Phiên bản đầy đủ: track CẢ 2 phía (boss + từng player) bằng 1 "Combatant" model
// chung — HP/Stamina/Sanity/Light/Resistance/vũ khí/Sinking/Rupture/Poise/Stagger/
// Panic/thế thủ — vì theo luật, Sinking/Rupture/Poise/Stagger/Panic áp dụng được
// cho CẢ 2 bên (không chỉ riêng boss), không có lý do tách 2 model khác nhau.
const ENCOUNTER_BOSS_NAME_MAX_LENGTH = 100;
const ENCOUNTER_DEFAULT_MAX_STAMINA = 100;
const ENCOUNTER_DEFAULT_MAX_LIGHT = 4;
const ENCOUNTER_SANITY_MAX = 45; // luôn bắt đầu 0/45 mỗi trận theo luật
const ENCOUNTER_STAMINA_REGEN_PER_TURN = 30;
const ENCOUNTER_GUARD_DR_PCT = 90; // Guard giảm 90% dmg nhận
const ENCOUNTER_PARRY_FAIL_STAMINA_LOSS = 40;

// Stamina cost cho 1 lần M1 (đánh thường), theo độ nặng vũ khí.
const WEAPON_STAMINA_COST = { light: 5, medium: 10, heavy: 20 };
// Số hit M1 mà 1 lần Guard/Evade/Parry chặn được, theo độ nặng vũ khí CỦA NGƯỜI TẤN
// CÔNG (không phải người thủ) — "Guard/evade/parry các đòn đánh thường của Light
// weapon thì 1 lần sẽ guard/evade/parry được 4 hit còn Medium là 2, Heavy là 1".
const WEAPON_GUARD_CHARGES = { light: 4, medium: 2, heavy: 1 };

function normalizeWeaponWeight(w) {
  const x = (w ?? "").trim().toLowerCase();
  if (x === "light" || x === "l") return "light";
  if (x === "heavy" || x === "h") return "heavy";
  return "medium"; // default — bao gồm cả khi gõ "medium"/"m"/để trống
}

/** Combatant — dùng CHUNG cho cả boss và mỗi player trong encounter. */
function createCombatant({ name, maxHp, maxStamina = ENCOUNTER_DEFAULT_MAX_STAMINA, maxLight = ENCOUNTER_DEFAULT_MAX_LIGHT, weaponWeight = "medium", resistance = null }) {
  return {
    name,
    maxHp, currentHp: maxHp,
    maxStamina, currentStamina: maxStamina,
    maxSanity: ENCOUNTER_SANITY_MAX, currentSanity: 0,
    maxLight, currentLight: 0,
    weaponWeight: normalizeWeaponWeight(weaponWeight),
    resistance: resistance ?? { B: 1, P: 1, S: 1 },
    // 7 status effect — LƯU Ý quan trọng về AI mang gì: Poise/Charge là "trên bản
    // thân" (self) — combatant này tự mang, áp dụng khi NÓ là người TẤN CÔNG.
    // Sinking/Rupture/Burn/Bleed/Tremor là "trên người địch" (enemy) — combatant này
    // mang khi NÓ là người BỊ TẤN CÔNG (target). Khi build calcOpts cho 1 action, phải
    // lấy poiseInit/chargeInit từ COMBATANT TẤN CÔNG, còn sinkingInit/ruptureInit/
    // burnInit/bleedInit/tremorInit từ COMBATANT BỊ TẤN CÔNG — KHÔNG lấy cả 7 từ cùng
    // 1 bên (đây chính là bug đã sửa — trước đó poiseInit bị lấy nhầm từ boss/target
    // dù player mới là người tấn công, tức người LẼ RA giữ Poise của hit đó).
    sinking: 0, rupture: 0, poise: 0, charge: 0, burn: 0, bleed: 0, tremor: 0,
    staggered: false, staggerTurnsLeft: 0,
    panic: false, panicTurnsLeft: 0,
    // stance: thế thủ đang giữ — { type: "evade"|"guard", chargesLeft } | null. KHÔNG
    // tự hết theo turn (theo luật là hết theo SỐ HIT chặn được, không phải thời gian) —
    // chỉ bị xoá khi charges về 0 sau khi đỡ đòn, hoặc bị ghi đè bởi 1 lần tuyên bố mới.
    stance: null,
    // parryRoll: kết quả d20 đã roll, chờ bị tấn công để so sánh — cũng KHÔNG tự hết
    // theo turn, chỉ tiêu thụ khi có 1 đòn tấn công thật được áp dụng vào combatant này.
    parryRoll: null,
    // staminaUsedThisTurn: để tính Light gain ("đánh đủ 20 sta M1 trong turn → +1
    // Light turn sau") — reset về 0 mỗi lần endturn.
    staminaUsedThisTurn: 0,
  };
}

/** Đổi { B, P, S } resistance object thành resStr cho calcMathCore — Stagger thì
 *  ĐÈ TOÀN BỘ về 2x bất kể resistance gốc, đúng luật "Khi bị Stagger Resistance set 2x". */
function combatantResStr(combatant) {
  if (combatant.staggered) return "2xB 2xP 2xS";
  const r = combatant.resistance;
  return `${r.B}xB ${r.P}xP ${r.S}xS`;
}

/** Kiểm tra + set Stagger (Stamina=0) / Panic (Sanity=-45) sau khi 1 combatant vừa
 *  bị trừ Stamina/Sanity — gọi MỖI LẦN sau khi thay đổi 2 giá trị này. Không tự bỏ
 *  qua nếu đã đang stagger/panic (idempotent — set lại staggerTurnsLeft=1 chỉ nếu
 *  CHƯA staggered, tránh việc bị trừ Stamina=0 nhiều lần liên tục lại reset đếm ngược). */
function checkStaggerPanic(combatant) {
  if (combatant.currentStamina <= 0 && !combatant.staggered) {
    combatant.staggered = true;
    combatant.staggerTurnsLeft = 1;
    combatant.currentStamina = 0;
  }
  if (combatant.currentSanity <= -ENCOUNTER_SANITY_MAX && !combatant.panic) {
    combatant.panic = true;
    combatant.panicTurnsLeft = 1;
    combatant.currentSanity = -ENCOUNTER_SANITY_MAX;
  }
}

/** Tiến 1 turn cho 1 combatant — hồi Stamina (hoặc đếm ngược Stagger), đếm ngược
 *  Panic, tính Light gain. Gọi cho TỪNG combatant (boss + mọi player) khi -encounter
 *  endturn được gọi. */
function advanceCombatantTurn(combatant) {
  if (combatant.staggered) {
    combatant.staggerTurnsLeft -= 1;
    if (combatant.staggerTurnsLeft <= 0) {
      combatant.staggered = false;
      combatant.currentStamina = combatant.maxStamina; // hồi đầy sau khi hết Stagger
    }
    // Đang stagger thì KHÔNG hồi 30 Stamina thường — turn này coi như "không hành
    // động được", hồi đầy 1 LẦN lúc hết stagger (đã xử lý ở trên).
  } else {
    combatant.currentStamina = Math.min(combatant.maxStamina, combatant.currentStamina + ENCOUNTER_STAMINA_REGEN_PER_TURN);
  }
  if (combatant.panic) {
    combatant.panicTurnsLeft -= 1;
    if (combatant.panicTurnsLeft <= 0) {
      combatant.panic = false;
      combatant.currentSanity = 0; // reset Sanity về 0 sau khi hết Panic
    }
  }
  if (combatant.staminaUsedThisTurn >= 20 && combatant.currentLight < combatant.maxLight) {
    combatant.currentLight += 1;
  }
  combatant.staminaUsedThisTurn = 0;
}

function encounterKey(channelId) {
  return `encounter:${channelId}`;
}

async function getEncounter(channelId) {
  const raw = await withTimeout(redis.get(encounterKey(channelId)));
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function saveEncounter(channelId, data) {
  await withTimeout(redis.set(encounterKey(channelId), JSON.stringify(data)));
}

async function deleteEncounter(channelId) {
  await withTimeout(redis.del(encounterKey(channelId)));
}

/** Build embed "bảng" hiển thị trạng thái encounter hiện tại — gọi lại mỗi khi
 *  start/hit-confirm/status để luôn phản ánh đúng state mới nhất đã lưu. */
/** Render 1 dòng trạng thái cho 1 combatant (boss hoặc player) — dùng chung để
 *  không lặp code giữa phần hiện boss và phần hiện từng player. */
function formatCombatantBlock(combatant, label) {
  const hpPct = combatant.maxHp > 0 ? Math.max(0, combatant.currentHp / combatant.maxHp) : 0;
  const filled = Math.round(hpPct * 10);
  const hpBar = "🟥".repeat(filled) + "⬛".repeat(10 - filled);
  const r = combatant.resistance;
  const resLine = combatant.staggered
    ? `2x/2x/2x (STAGGER, gốc ${r.B}xB ${r.P}xP ${r.S}xS)`
    : `${r.B}xB ${r.P}xP ${r.S}xS`;
  const lines = [
    `**${label}**${combatant.currentHp <= 0 ? " — ĐÃ HẠ! 💀" : ""}`,
    `${hpBar} **${Math.max(0, Math.round(combatant.currentHp * 100) / 100)}/${combatant.maxHp}** HP`,
    `> Stamina: **${combatant.currentStamina}/${combatant.maxStamina}** | Sanity: **${combatant.currentSanity}/${combatant.maxSanity}** | Light: **${combatant.currentLight}/${combatant.maxLight}**`,
    `> Res: **${resLine}** | Vũ khí: **${combatant.weaponWeight}**`,
  ];
  const statusParts = [];
  if (combatant.sinking > 0) statusParts.push(`<:Sinking:1513762793436741652>${combatant.sinking}`);
  if (combatant.rupture > 0) statusParts.push(`<:Rupture:1513762812722155682>${combatant.rupture}`);
  if (combatant.poise > 0) statusParts.push(`<:Poise:1513762945715142736>${combatant.poise}`);
  if (combatant.charge > 0) statusParts.push(`<:Charge:1513762867558613033>${combatant.charge}`);
  if (combatant.burn > 0) statusParts.push(`<:Burn:1513762753691652177>${combatant.burn}`);
  if (combatant.bleed > 0) statusParts.push(`<:Bleed:1513762688226955285>${combatant.bleed}`);
  if (combatant.tremor > 0) statusParts.push(`<:Tremor:1513762737388257380>${combatant.tremor}`);
  if (statusParts.length > 0) lines.push(`> ${statusParts.join(" | ")}`);
  if (combatant.staggered) lines.push(`> 💫 **STAGGER** — còn ${combatant.staggerTurnsLeft} turn`);
  if (combatant.panic) lines.push(`> 😱 **PANIC** — còn ${combatant.panicTurnsLeft} turn`);
  if (combatant.stance) lines.push(`> 🛡️ Đang ${combatant.stance.type === "guard" ? "Guard" : "Evade"} — còn chặn được ${combatant.stance.chargesLeft} hit`);
  if (combatant.parryRoll !== null) lines.push(`> 🗡️ Đang chờ Parry (đã roll **${combatant.parryRoll}**)`);
  return lines.join("\n");
}

/** Preview (READ-ONLY, không sửa target) — dùng để hiện dự kiến trong pending action.
 *  Parry không roll thật ở đây (vì random — roll ở preview rồi roll lại lúc confirm
 *  sẽ ra 2 kết quả khác nhau, gây hiểu nhầm) — chỉ báo "sẽ roll lúc confirm". */
function previewDefenseOutcome(target, rawDmg) {
  if (target.parryRoll !== null) {
    return { finalDmg: null, note: `🗡️ Target đang chờ Parry (đã roll **${target.parryRoll}**) — kết quả thật sẽ roll khi GM xác nhận` };
  }
  if (target.stance?.type === "evade") {
    return { finalDmg: 0, note: `🛡️ Target đang Evade — dự kiến đỡ được, KHÔNG nhận dmg (còn ${target.stance.chargesLeft} charge)` };
  }
  if (target.stance?.type === "guard") {
    return { finalDmg: rawDmg * (1 - ENCOUNTER_GUARD_DR_PCT / 100), note: `🛡️ Target đang Guard — dự kiến giảm ${ENCOUNTER_GUARD_DR_PCT}% dmg (còn ${target.stance.chargesLeft} charge)` };
  }
  return { finalDmg: rawDmg, note: null };
}

/** Resolve THẬT (SỬA target) — CHỈ gọi lúc GM xác nhận, không gọi lúc preview. Roll
 *  d20 thật cho Parry, tiêu charge Guard/Evade, trừ Stamina nếu Parry thất bại. */
function resolveDefenseOutcome(target, rawDmg) {
  if (target.parryRoll !== null) {
    const bossRoll = 1 + Math.floor(Math.random() * 20);
    const playerRoll = target.parryRoll;
    target.parryRoll = null;
    if (playerRoll >= bossRoll) {
      return { finalDmg: 0, note: `🗡️ Parry THÀNH CÔNG! (roll ${playerRoll} vs ${bossRoll}) — không nhận dmg` };
    }
    target.currentStamina = Math.max(0, target.currentStamina - ENCOUNTER_PARRY_FAIL_STAMINA_LOSS);
    checkStaggerPanic(target);
    return { finalDmg: rawDmg, note: `🗡️ Parry THẤT BẠI! (roll ${playerRoll} vs ${bossRoll}) — mất ${ENCOUNTER_PARRY_FAIL_STAMINA_LOSS} Stamina, ăn full dmg` };
  }
  if (target.stance?.type === "evade") {
    target.stance.chargesLeft -= 1;
    const note = `🛡️ Evade thành công (còn ${Math.max(0, target.stance.chargesLeft)} charge)`;
    if (target.stance.chargesLeft <= 0) target.stance = null;
    return { finalDmg: 0, note };
  }
  if (target.stance?.type === "guard") {
    const reduced = rawDmg * (1 - ENCOUNTER_GUARD_DR_PCT / 100);
    target.stance.chargesLeft -= 1;
    const note = `🛡️ Guard — giảm ${ENCOUNTER_GUARD_DR_PCT}% dmg (còn ${Math.max(0, target.stance.chargesLeft)} charge)`;
    if (target.stance.chargesLeft <= 0) target.stance = null;
    return { finalDmg: reduced, note };
  }
  return { finalDmg: rawDmg, note: null };
}

/** Action panel — 5 nút cho player bấm thay vì gõ lệnh text. Attack/Hit cần nhập
 *  công thức dmg nên mở Modal (form nhập liệu) khi bấm; Guard/Evade/Parry không
 *  cần nhập gì nên thực thi NGAY khi bấm. */
function buildEncounterActionPanel(channelId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`encact:${channelId}:attack`).setLabel("⚔️ Đánh thường").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`encact:${channelId}:hit`).setLabel("📖 Dùng Page").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`encact:${channelId}:guard`).setLabel("🛡️ Guard").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`encact:${channelId}:evade`).setLabel("💨 Evade").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`encact:${channelId}:parry`).setLabel("🗡️ Parry").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * doPlayerAttack — logic CHUNG cho `-encounter attack` (text) và nút "Đánh thường"
 * (qua Modal). QUAN TRỌNG: KHÔNG trừ Stamina ở đây — chỉ TÍNH TRƯỚC stamina cần và
 * lưu vào pendingAction.staminaCost, trừ THẬT lúc GM xác nhận (xem encconfirm
 * handler). Trước đây trừ ngay lúc declare — nghĩa là GM từ chối (VD: vì lý do gõ
 * sai công thức) vẫn làm player mất Stamina oan, dù hành động đó không có hiệu lực
 * gì cả. Giờ: declare chỉ KIỂM TRA đủ Stamina không (báo lỗi sớm nếu thiếu), CHƯA
 * trừ; confirm mới trừ thật — khớp đúng nguyên tắc "không gì là thật cho tới khi
 * GM xác nhận" đã áp dụng cho HP/status từ trước.
 * @returns {{ embed, components }}
 * @throws Error nếu input/điều kiện không hợp lệ
 */
async function doPlayerAttack(channelId, playerId, playerMention, dmgStr) {
  if (!dmgStr || !dmgStr.trim()) throw new Error("Cần nhập công thức dmg (VD: `50x2B+2Sinking`).");
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
    const player = encounter.players[playerId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này — dùng `-encounter join hp: <số>` trước.");
    if (encounter.pendingAction) throw new Error("Đang có 1 action khác chờ GM xác nhận — chờ GM xử lý xong trước.");
    if (player.staggered) throw new Error("Bạn đang bị Stagger — không thể hành động turn này.");

    const boss = encounter.boss;
    // QUAN TRỌNG: Poise/Charge là "trên bản thân" → lấy từ PLAYER (người tấn công).
    // Sinking/Rupture/Burn/Bleed/Tremor là "trên người địch" → lấy từ BOSS (bị tấn
    // công). Trước đây lấy NHẦM cả 7 từ boss — sai hoàn toàn với Poise/Charge.
    const calcOpts = {
      dmgStr, resStr: combatantResStr(boss),
      poiseInit: player.poise, chargeInit: player.charge,
      sinkingInit: boss.sinking, ruptureInit: boss.rupture,
      burnInit: boss.burn, bleedInit: boss.bleed, tremorInit: boss.tremor,
      sanityInit: boss.currentSanity,
    };
    const preview = calcMathCore(calcOpts);
    const hitCount = preview.dmgValues.length;
    const staminaCost = WEAPON_STAMINA_COST[player.weaponWeight] * hitCount;
    if (player.currentStamina < staminaCost) {
      throw new Error(`Không đủ Stamina — cần ${staminaCost} (${hitCount} hit × ${WEAPON_STAMINA_COST[player.weaponWeight]}/hit vũ khí ${player.weaponWeight}), còn ${player.currentStamina}.`);
    }

    encounter.pendingAction = {
      direction: "playerToBoss", attackerId: playerId, targetId: "boss",
      calcOpts, preview, finalDmg: preview.totalDmg,
      staminaCost, // CHỈ attack có field này — đánh dấu cho encconfirm biết cần trừ Stamina người tấn công lúc confirm
    };
    await saveEncounter(channelId, encounter);

    result = {
      embed: {
        title: "🎯 M1 chờ GM xác nhận",
        description:
          `${playerMention} đánh thường (${hitCount} hit) lên **${encounter.bossName}**: \`${dmgStr}\`\n` +
          `> Dự kiến: **${preview.totalDmg.toFixed(3)}** dmg\n` +
          `> Sẽ trừ **${staminaCost} Stamina** NẾU được GM xác nhận (từ chối thì không mất gì).\n` +
          `> GM bấm nút dưới để áp dụng thật vào encounter.`,
        color: 0xf39c12,
      },
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`encconfirm:${channelId}`).setLabel("✅ Xác nhận").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`encreject:${channelId}`).setLabel("❌ Từ chối").setStyle(ButtonStyle.Danger),
      )],
    };
  });
  return result;
}

/** doPlayerHit — logic CHUNG cho `-encounter hit` (text) và nút "Dùng Page". Page
 *  tốn Light (player tự khai báo/quản lý riêng), KHÔNG đụng tới Stamina — đúng yêu
 *  cầu giữ rõ ranh giới: chỉ M1/Guard/Evade tốn Stamina, Page không. */
async function doPlayerHit(channelId, playerId, playerMention, dmgStr, extra = {}) {
  if (!dmgStr || !dmgStr.trim()) throw new Error("Cần nhập công thức dmg (VD: `50x2B+2Sinking`).");
  const { resStr = "", drStr = "", bonusPct = 0, sanityBonusPct = 0, critMul = 1, diceMul = 1, critDiv = 0 } = extra;
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
    if (encounter.pendingAction) throw new Error("Đang có 1 action khác chờ GM xác nhận — chờ GM xử lý xong trước.");
    const player = encounter.players[playerId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này — dùng `-encounter join hp: <số>` trước.");
    const boss = encounter.boss;
    // QUAN TRỌNG: Poise/Charge lấy từ PLAYER (người dùng Page, "trên bản thân"),
    // Sinking/Rupture/Burn/Bleed/Tremor lấy từ BOSS (bị tấn công, "trên người địch").
    const calcOpts = {
      dmgStr, resStr: resStr || combatantResStr(boss), drStr,
      bonusPct, sanityBonusPct, critMul, diceMul, critDiv,
      poiseInit: player.poise, chargeInit: player.charge,
      sinkingInit: boss.sinking, ruptureInit: boss.rupture,
      burnInit: boss.burn, bleedInit: boss.bleed, tremorInit: boss.tremor,
      sanityInit: boss.currentSanity,
    };
    const preview = calcMathCore(calcOpts);

    encounter.pendingAction = {
      direction: "playerToBoss", attackerId: playerId, targetId: "boss",
      calcOpts, preview, finalDmg: preview.totalDmg,
    };
    await saveEncounter(channelId, encounter);

    result = {
      embed: {
        title: "🎯 Action chờ GM xác nhận",
        description:
          `${playerMention} dùng Page lên **${encounter.bossName}**: \`${dmgStr}\`\n` +
          `> Dự kiến: **${preview.totalDmg.toFixed(3)}** dmg\n` +
          `> GM bấm nút dưới để áp dụng thật vào encounter.`,
        color: 0xf39c12,
      },
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`encconfirm:${channelId}`).setLabel("✅ Xác nhận").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`encreject:${channelId}`).setLabel("❌ Từ chối").setStyle(ButtonStyle.Danger),
      )],
    };
  });
  return result;
}

/** doPlayerGuardEvade — logic CHUNG cho -encounter guard/evade (text) và nút
 *  Guard/Evade. KHÔNG qua pending/confirm (thực thi NGAY) — vì đây là tuyên bố thế
 *  thủ của RIÊNG player đó, không cần GM duyệt số liệu gì cả (không có damage math
 *  nào để sai ở đây). */
async function doPlayerGuardEvade(channelId, playerId, type) {
  let message;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    const player = encounter.players[playerId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này — dùng `-encounter join hp: <số>` trước.");
    if (player.staggered) throw new Error("Bạn đang bị Stagger — không thể hành động turn này.");
    const cost = type === "evade" ? 20 : 10;
    if (player.currentStamina < cost) throw new Error(`Không đủ Stamina (cần ${cost}, còn ${player.currentStamina}).`);
    player.currentStamina -= cost;
    checkStaggerPanic(player);
    const charges = WEAPON_GUARD_CHARGES[encounter.boss.weaponWeight];
    player.stance = { type, chargesLeft: charges };
    await saveEncounter(channelId, encounter);
    message = `🛡️ <@${playerId}> vào thế **${type === "evade" ? "Evade" : "Guard"}** (-${cost} Stamina, chặn được ${charges} hit tới).`;
  });
  return message;
}

/** doPlayerParry — logic CHUNG cho -encounter parry (text) và nút Parry. 0 Stamina,
 *  roll d20 ngay, lưu lại chờ đòn tới (xem previewDefenseOutcome/resolveDefenseOutcome). */
async function doPlayerParry(channelId, playerId) {
  let message;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    const player = encounter.players[playerId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này — dùng `-encounter join hp: <số>` trước.");
    if (player.staggered) throw new Error("Bạn đang bị Stagger — không thể hành động turn này.");
    const roll = 1 + Math.floor(Math.random() * 20);
    player.parryRoll = roll;
    await saveEncounter(channelId, encounter);
    message = `🗡️ <@${playerId}> chuẩn bị Parry — roll được **${roll}** (0 Stamina). Chờ đòn tới để so kết quả.`;
  });
  return message;
}

function buildEncounterBoardEmbed(encounter) {
  const blocks = [formatCombatantBlock(encounter.boss, `⚔️ ${encounter.bossName}`)];
  const playerIds = Object.keys(encounter.players);
  for (const pid of playerIds) {
    blocks.push(formatCombatantBlock(encounter.players[pid], `<@${pid}>`));
  }
  if (encounter.pendingAction) {
    const { direction, attackerId, targetId, calcOpts, preview, finalDmg } = encounter.pendingAction;
    const attackerLabel = attackerId === "boss" ? encounter.bossName : `<@${attackerId}>`;
    const targetLabel = targetId === "boss" ? encounter.bossName : `<@${targetId}>`;
    const dmgToShow = typeof finalDmg === "number" ? finalDmg : preview.totalDmg;
    blocks.push(`⏳ **${attackerLabel}** → **${targetLabel}**: \`${calcOpts.dmgStr}\` → dự kiến **${dmgToShow.toFixed(3)}** dmg (chờ GM xác nhận)`);
  }
  return {
    title: `Encounter Board`,
    description: blocks.join("\n\n"),
    color: encounter.boss.currentHp <= 0 ? 0x555555 : 0xe74c3c,
    footer: { text: "-encounter attack/bossattack/evade/guard/parry/endturn — xem -encounter help để biết hết lệnh" },
  };
}


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

/**
 * Build StringSelectMenu chứa các item trên ĐÚNG trang đang hiển thị.
 * QUAN TRỌNG: buildInventoryPages sinh trang sách TRƯỚC (1..bookPageCount),
 * rồi trang item SAU — không gộp chung. Hàm này phải dùng đúng công thức
 * bookPageCount = Math.ceil(books.length / INV_PAGE_SIZE) để xác định trang
 * hiện tại đang ở phía "sách" hay phía "item", nếu không select menu sẽ liệt
 * kê sai item so với embed đang hiển thị.
 */
function buildInvSelectMenu(targetUserId, data, page) {
  const books = Object.entries(data.books ?? {}).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
  const items = Object.entries(data.items ?? {}).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));

  const bookPageCount = Math.ceil(books.length / INV_PAGE_SIZE); // = 0 nếu không có sách

  let chunk, type;
  if (page < bookPageCount) {
    chunk = books.slice(page * INV_PAGE_SIZE, (page + 1) * INV_PAGE_SIZE);
    type = "book";
  } else {
    const itemPage = page - bookPageCount;
    chunk = items.slice(itemPage * INV_PAGE_SIZE, (itemPage + 1) * INV_PAGE_SIZE);
    type = "item";
  }
  if (chunk.length === 0) return null;

  const options = chunk.map(([name, count]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`${name} ×${count}`)
      .setDescription(type === "book" ? "📚 Sách" : "🔩 Vật phẩm")
      .setValue(`${type}:${name}`)
      .setEmoji(type === "book" ? "📖" : "🔩")
  );

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`invsel:${targetUserId}:${page}`)
      .setPlaceholder("📋 Chọn item để thao tác...")
      .addOptions(options)
  );
}

/** Wrapper async dùng chung cho prefix và slash command. */
async function fetchInventoryReply(targetUser, page = 0) {
  const data = await getPlayerData(targetUser.id);
  const pages = buildInventoryPages(targetUser, data);
  if (!pages) return null;
  const clampedPage = Math.max(0, Math.min(page, pages.length - 1));
  const embed = buildInvEmbed(targetUser, pages, clampedPage);

  const components = [];
  if (pages.length > 1) components.push(buildInvRow(targetUser.id, clampedPage, pages.length));
  const selectMenu = buildInvSelectMenu(targetUser.id, data, clampedPage);
  if (selectMenu) components.push(selectMenu);

  return { embeds: [embed], components };
}

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
const { SKILLS, SKILL_ALIASES, findSkill, findByKeyword, r, computeEmotionDelta, startEmotionTracking, stopEmotionTracking } = require("./skills");


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
function buildSkillRollResult({ skill, rollCount = 1, promptArgRaw = null, forceDullahan = false }) {
  // Skill đặc biệt cần arg — dùng promptArg nếu có (VD: Thrust cần nhập Light hiện tại)
  if (skill.promptArg) {
    const { parse, validate, errorMsg, buildHeader } = skill.promptArg;
    const parsed = parse(promptArgRaw ?? "");
    if (!validate(parsed)) return { error: errorMsg };
    startEmotionTracking();
    const lines = skill.roll(parsed);
    const tracked = stopEmotionTracking();
    const header = buildHeader(parsed, skill);
    return {
      embed: {
        title: `🎲 ${skill.name}`,
        color: skill.embedColor ?? 0x5865f2,
        description: header + "\n\n" + annotateLinesWithEmotion(lines, tracked),
      },
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
    const lines = skill.hasDullahanRoll ? skill.roll(forceDullahan, reuseIndex) : skill.roll(reuseIndex);
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
  };
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
      { name: "🎯 -rtparry", value: `Parry phản xạ thời gian thực! Bot gửi link riêng cho bạn (\`-rtparry\` qua DM, \`/rtparry\` qua ephemeral) — đo phản ứng chính xác 100% trên trình duyệt, không lẫn latency mạng.\n> Bấm sớm = ❌ thất bại | Bỏ lỡ cửa sổ (${RTPARRY_WINDOW_MS}ms) = ❌ thất bại | Đúng lúc = ✅ thành công`, inline: false },
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
    const critMul = parseFloat((kv["critmul"] ?? "1").replace("x", ""));
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
    const argStr = message.content.replace(/^-encounter/i, "").trim();
    const subMatch = argStr.match(/^(\S+)\s*/);
    const sub = (subMatch?.[1] ?? "").toLowerCase();
    const rest = subMatch ? argStr.slice(subMatch[0].length).trim() : "";

    if (sub === "start") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được tạo encounter."); return; }
      const kv = parseKeyValues(rest);
      const bossName = (kv["name"] ?? "").trim();
      const hp = parseInt(kv["hp"] ?? "", 10);
      if (!bossName || bossName.length > ENCOUNTER_BOSS_NAME_MAX_LENGTH || !Number.isFinite(hp) || hp <= 0) {
        message.reply(
          "⚠️ Cú pháp: `-encounter start name: <tên boss> hp: <số>` (tùy chọn thêm `stamina:`/`weapon: light|medium|heavy`/`res: 1.3xB 1.3xP 1.3xS`)\n" +
          `> Tên tối đa ${ENCOUNTER_BOSS_NAME_MAX_LENGTH} ký tự, hp phải là số nguyên dương.`
        );
        return;
      }
      const bossStamina = parseInt(kv["stamina"] ?? "", 10);
      const bossWeapon = normalizeWeaponWeight(kv["weapon"] ?? "medium");
      const bossResRaw = kv["res"] ?? "";
      const bossRes = { B: 1, P: 1, S: 1 };
      const resMatch = bossResRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi);
      for (const m of resMatch) bossRes[m[2].toUpperCase()] = parseFloat(m[1]);
      try {
        await withLock(encounterKey(message.channel.id), async () => {
          const existing = await getEncounter(message.channel.id);
          if (existing) {
            throw new Error(`Channel này đang có encounter **${existing.bossName}** chạy — dùng \`-encounter end\` trước.`);
          }
          const boss = createCombatant({
            name: bossName, maxHp: hp,
            maxStamina: Number.isFinite(bossStamina) && bossStamina > 0 ? bossStamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
            weaponWeight: bossWeapon, resistance: bossRes,
          });
          const encounter = {
            bossName, boss, players: {},
            gmId: message.author.id, createdAt: Date.now(),
            pendingAction: null,
          };
          await saveEncounter(message.channel.id, encounter);
          await message.reply({ embeds: [buildEncounterBoardEmbed(encounter)], components: buildEncounterActionPanel(message.channel.id) });
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
      if (!Number.isFinite(hp) || hp <= 0) {
        message.reply(
          "⚠️ Cú pháp: `-encounter join hp: <số>` (tùy chọn thêm `stamina:`/`light:`/`weapon: light|medium|heavy`/`res: 1.3xB 1.3xP 1.3xS`)"
        );
        return;
      }
      const light = parseInt(kv["light"] ?? "", 10);
      const weapon = normalizeWeaponWeight(kv["weapon"] ?? "medium");
      const resRaw = kv["res"] ?? "";
      const res = { B: 1, P: 1, S: 1 };
      for (const m of resRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi)) res[m[2].toUpperCase()] = parseFloat(m[1]);
      try {
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
          const wasJoined = !!encounter.players[message.author.id];
          encounter.players[message.author.id] = createCombatant({
            name: message.author.username, maxHp: hp,
            maxStamina: Number.isFinite(stamina) && stamina > 0 ? stamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
            maxLight: Number.isFinite(light) && light > 0 ? light : ENCOUNTER_DEFAULT_MAX_LIGHT,
            weaponWeight: weapon, resistance: res,
          });
          await saveEncounter(message.channel.id, encounter);
          await message.reply({
            content: `✅ ${wasJoined ? "Đã cập nhật lại" : "Đã tham gia"} encounter **${encounter.bossName}** với ${hp} HP.`,
            components: buildEncounterActionPanel(message.channel.id),
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "status") {
      const encounter = await getEncounter(message.channel.id);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào. Dùng `-encounter start` để tạo."); return; }
      message.reply({ embeds: [buildEncounterBoardEmbed(encounter)], components: buildEncounterActionPanel(message.channel.id) });
      return;
    }

    if (sub === "end") {
      const encounter = await getEncounter(message.channel.id);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      if (!isAdmin && message.author.id !== encounter.gmId) { message.reply("⚠️ Chỉ GM tạo encounter này (hoặc admin khác) mới được kết thúc."); return; }
      await deleteEncounter(message.channel.id);
      message.reply(`✅ Đã kết thúc encounter **${encounter.bossName}**.`);
      return;
    }

    if (sub === "endturn") {
      try {
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM (hoặc admin) mới được kết thúc turn.");
          advanceCombatantTurn(encounter.boss);
          for (const pid of Object.keys(encounter.players)) advanceCombatantTurn(encounter.players[pid]);
          await saveEncounter(message.channel.id, encounter);
          await message.reply({
            content: `🔄 **Hết turn** — hồi ${ENCOUNTER_STAMINA_REGEN_PER_TURN} Stamina (trừ ai đang Stagger), đếm ngược Stagger/Panic.`,
            embeds: [buildEncounterBoardEmbed(encounter)],
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── hit: dùng Page/Skill (Light cost) lên BOSS — giữ nguyên cú pháp cũ, KHÔNG tự
    // trừ Stamina (vì Page tốn Light, không tốn Stamina theo luật). Muốn M1 đánh
    // thường (tốn Stamina) thì dùng `attack` ở dưới.
    if (sub === "hit") {
      const kv = parseKeyValues(rest);
      const dmgStr = kv["dmg"] ?? "";
      if (!dmgStr.trim()) {
        message.reply(
          "⚠️ Cú pháp: `-encounter hit dmg: <công thức>` (dùng cho Page/Skill — tốn Light tự khai báo riêng, KHÔNG tự trừ Stamina).\n" +
          "> Muốn đánh thường (M1, tự trừ Stamina theo vũ khí) thì dùng `-encounter attack dmg: ...`\n" +
          "> VD: `-encounter hit dmg: 50x2B+2Sinking res: 1.5xB bonus: 20`"
        );
        return;
      }
      const bonusPct = parseFloat((kv["bonus"] ?? "0").replace("%", ""));
      const sanityBonusPct = parseFloat((kv["sanitybonus"] ?? "0").replace("%", ""));
      const critMul = parseFloat((kv["critmul"] ?? "1").replace("x", ""));
      const diceMul = parseFloat((kv["dicemul"] ?? "1").replace("x", ""));
      if (isNaN(bonusPct) || isNaN(sanityBonusPct) || isNaN(critMul) || isNaN(diceMul)) {
        message.reply("❌ bonus/sanitybonus/critmul/dicemul phải là số.");
        return;
      }
      const critDivStr = (kv["critdiv"] ?? "").trim().toLowerCase();
      let critDiv = 0;
      if (critDivStr === "yes" || critDivStr === "true" || critDivStr === "1") critDiv = 2;
      else { const p = parseFloat(critDivStr); if (!isNaN(p) && p > 1) critDiv = p; }

      try {
        const { embed, components } = await doPlayerHit(message.channel.id, message.author.id, message.author.toString(), dmgStr, {
          resStr: kv["res"] ?? "", drStr: kv["dr"] ?? "", bonusPct, sanityBonusPct, critMul, diceMul, critDiv,
        });
        await message.reply({ embeds: [embed], components });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── attack: M1 (đánh thường) lên BOSS — tự TÍNH Stamina cần, trừ thật lúc GM
    // xác nhận (xem doPlayerAttack — đã sửa để reject không làm mất Stamina oan).
    if (sub === "attack") {
      const kv = parseKeyValues(rest);
      const dmgStr = kv["dmg"] ?? "";
      if (!dmgStr.trim()) {
        message.reply("⚠️ Cú pháp: `-encounter attack dmg: <công thức>` (M1 — tự trừ Stamina theo vũ khí của bạn).");
        return;
      }
      try {
        const { embed, components } = await doPlayerAttack(message.channel.id, message.author.id, message.author.toString(), dmgStr);
        await message.reply({ embeds: [embed], components });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── bossattack: GM cho boss đánh 1 player cụ thể — áp dụng thế thủ/Parry NGAY
    // ở bước preview (read-only), CHỈ tiêu thụ charge/roll thật lúc confirm.
    if (sub === "bossattack") {
      if (!isAdmin) {
        const enc = await getEncounter(message.channel.id);
        if (!enc || message.author.id !== enc.gmId) { message.reply("⚠️ Chỉ GM/admin mới điều khiển được boss."); return; }
      }
      const kv = parseKeyValues(rest);
      const dmgStr = kv["dmg"] ?? "";
      const targetMention = message.mentions.users.first();
      if (!dmgStr.trim() || !targetMention) {
        message.reply("⚠️ Cú pháp: `-encounter bossattack @player dmg: <công thức>`");
        return;
      }
      try {
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          if (encounter.pendingAction) throw new Error("Đang có 1 action khác chờ GM xác nhận — chờ xử lý xong trước.");
          const target = encounter.players[targetMention.id];
          if (!target) throw new Error(`<@${targetMention.id}> chưa tham gia encounter này.`);

          const boss = encounter.boss;
          // QUAN TRỌNG: chiều này BOSS là người tấn công → Poise/Charge lấy từ BOSS.
          // TARGET (player) là người bị tấn công → Sinking/Rupture/Burn/Bleed/Tremor
          // lấy từ TARGET — ĐẢO NGƯỢC so với attack/hit (player tấn công boss).
          const calcOpts = {
            dmgStr, resStr: kv["res"] ?? combatantResStr(target), drStr: kv["dr"] ?? "",
            poiseInit: boss.poise, chargeInit: boss.charge,
            sinkingInit: target.sinking, ruptureInit: target.rupture,
            burnInit: target.burn, bleedInit: target.bleed, tremorInit: target.tremor,
            sanityInit: target.currentSanity,
          };
          const preview = calcMathCore(calcOpts);
          const { finalDmg, note } = previewDefenseOutcome(target, preview.totalDmg);

          encounter.pendingAction = {
            direction: "bossToPlayer", attackerId: "boss", targetId: targetMention.id,
            calcOpts, preview, finalDmg,
          };
          await saveEncounter(message.channel.id, encounter);

          await message.reply({
            embeds: [{
              title: "🎯 Boss attack chờ GM xác nhận",
              description:
                `**${encounter.bossName}** đánh <@${targetMention.id}>: \`${dmgStr}\`\n` +
                `> Dự kiến (chưa tính thế thủ): **${preview.totalDmg.toFixed(3)}** dmg` +
                (note ? `\n> ${note}` : "") +
                `\n> GM bấm nút dưới để áp dụng thật (thế thủ/Parry sẽ resolve lúc xác nhận).`,
              color: 0xf39c12,
            }],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`encconfirm:${message.channel.id}`).setLabel("✅ Xác nhận").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`encreject:${message.channel.id}`).setLabel("❌ Từ chối").setStyle(ButtonStyle.Danger),
            )],
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "evade" || sub === "guard") {
      try {
        const msg = await doPlayerGuardEvade(message.channel.id, message.author.id, sub);
        message.reply(msg);
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "parry") {
      try {
        const msg = await doPlayerParry(message.channel.id, message.author.id);
        message.reply(msg);
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    message.reply(
      "⚠️ Lệnh không hợp lệ. Dùng:\n" +
      "> `-encounter start name: <tên> hp: <số>` (admin/GM)\n" +
      "> `-encounter join hp: <số>` (player tham gia)\n" +
      "> `-encounter attack dmg: <công thức>` — M1, tự trừ Stamina\n" +
      "> `-encounter hit dmg: <công thức>` — Page/Skill lên boss\n" +
      "> `-encounter bossattack @player dmg: <công thức>` (GM)\n" +
      "> `-encounter evade` / `-encounter guard` / `-encounter parry`\n" +
      "> `-encounter endturn` (GM) — hồi Stamina, đếm ngược Stagger/Panic\n" +
      "> `-encounter status` · `-encounter end` (GM)"
    );
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

  // ── Nút action panel (Attack/Hit/Guard/Evade/Parry) ──────────────────────────
  if (interaction.customId.startsWith("encact:")) {
    const [, channelId, action] = interaction.customId.split(":");

    if (action === "guard" || action === "evade") {
      try {
        const msg = await doPlayerGuardEvade(channelId, interaction.user.id, action);
        await interaction.reply({ content: msg }).catch(() => {});
      } catch (err) {
        await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }

    if (action === "parry") {
      try {
        const msg = await doPlayerParry(channelId, interaction.user.id);
        await interaction.reply({ content: msg }).catch(() => {});
      } catch (err) {
        await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }

    // attack/hit cần nhập công thức dmg — mở Modal (form nhập liệu) thay vì xử lý
    // ngay, vì button không mang theo text tự do được. Modal submit xử lý ở listener
    // riêng (xem "MODAL SUBMIT INTERACTIONS" phía dưới).
    if (action === "attack" || action === "hit") {
      const modal = new ModalBuilder()
        .setCustomId(`encmodal:${channelId}:${action}`)
        .setTitle(action === "attack" ? "Đánh thường (M1)" : "Dùng Page/Skill");
      const dmgInput = new TextInputBuilder()
        .setCustomId("dmgStr")
        .setLabel("Công thức dmg (giống /math)")
        .setPlaceholder("VD: 50x2B+2Sinking")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(dmgInput));
      await interaction.showModal(modal).catch(() => {});
      return;
    }
  }


  if (interaction.customId.startsWith("encconfirm:") || interaction.customId.startsWith("encreject:")) {
    const isConfirm = interaction.customId.startsWith("encconfirm:");
    const channelId = interaction.customId.slice((isConfirm ? "encconfirm:" : "encreject:").length);
    try {
      await withLock(encounterKey(channelId), async () => {
        const encounter = await getEncounter(channelId);
        if (!encounter || !encounter.pendingAction) {
          return interaction.reply({ content: "⚠️ Không có action nào chờ xác nhận (có thể đã xử lý rồi).", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const isAdmin = ADMIN_IDS.has(interaction.user.id);
        if (!isAdmin && interaction.user.id !== encounter.gmId) {
          return interaction.reply({ content: "⚠️ Chỉ GM tạo encounter này (hoặc admin khác) mới được xác nhận/từ chối.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const { direction, attackerId, targetId, calcOpts, preview, staminaCost } = encounter.pendingAction;
        const attackerLabel = attackerId === "boss" ? `**${encounter.bossName}**` : `<@${attackerId}>`;
        const targetLabel = targetId === "boss" ? `**${encounter.bossName}**` : `<@${targetId}>`;
        const target = targetId === "boss" ? encounter.boss : encounter.players[targetId];
        // attacker — combatant GIỮ Poise/Charge ("trên bản thân") của action này. Khác
        // với target (giữ Sinking/Rupture/Burn/Bleed/Tremor, "trên người địch").
        const attacker = attackerId === "boss" ? encounter.boss : encounter.players[attackerId];

        if (isConfirm) {
          // QUAN TRỌNG: đây là lúc DUY NHẤT state thật của encounter bị thay đổi —
          // lúc tạo pending action (-encounter hit/attack/bossattack) chỉ TÍNH TRƯỚC
          // (preview), không áp dụng gì cả. Confirm mới thật sự trừ HP + ghi đè status
          // mới + resolve thế thủ/Parry thật (roll d20 thật cho Parry ở ĐÂY, không
          // phải lúc preview — xem comment ở resolveDefenseOutcome) + trừ Stamina của
          // NGƯỜI TẤN CÔNG nếu là action loại attack (staminaCost chỉ có ở attack —
          // xem doPlayerAttack — KHÔNG trừ lúc declare nữa để reject không làm mất
          // Stamina oan).
          let staminaNote = "";
          if (staminaCost && attackerId !== "boss") {
            const staminaAttacker = encounter.players[attackerId];
            if (staminaAttacker) {
              staminaAttacker.currentStamina = Math.max(0, staminaAttacker.currentStamina - staminaCost);
              staminaAttacker.staminaUsedThisTurn += staminaCost;
              checkStaggerPanic(staminaAttacker);
              staminaNote = `\n> ${attackerLabel} -${staminaCost} Stamina` + (staminaAttacker.staggered ? ` — 💫 **Stagger**!` : "");
            }
          }
          let finalDmg = preview.totalDmg;
          let defenseNote = "";
          if (direction === "bossToPlayer") {
            const resolved = resolveDefenseOutcome(target, preview.totalDmg);
            finalDmg = resolved.finalDmg;
            if (resolved.note) defenseNote = `\n> ${resolved.note}`;
          }
          target.currentHp = Math.max(0, target.currentHp - finalDmg);
          // 5 status "trên người địch" — áp vào TARGET (bên bị tấn công).
          target.sinking = preview.finalSinking;
          target.rupture = preview.finalRupture;
          target.burn = preview.finalBurn;
          target.bleed = preview.finalBleed;
          target.tremor = preview.finalTremor;
          target.currentSanity = preview.finalSanity;
          // Tremor Burst rút STAMINA của TARGET (kẻ mang Tremor bị rút Sta, không phải
          // người tấn công) — xem luật "Tremor Burst dùng lên địch sẽ trừ Sta tương
          // ứng" — trước đây totalTremorStaminaLoss được TÍNH nhưng KHÔNG hề trừ vào
          // Stamina của ai cả, thiếu bước áp dụng thật này.
          if (preview.totalTremorStaminaLoss > 0) {
            target.currentStamina = Math.max(0, target.currentStamina - preview.totalTremorStaminaLoss);
          }
          // 2 status "trên bản thân" — áp vào ATTACKER (bên tấn công), KHÔNG phải target.
          if (attacker) {
            attacker.poise = preview.finalPoiseStacks;
            attacker.charge = preview.finalCharge;
          }
          checkStaggerPanic(target); // Sanity/Stamina target vừa đổi — check Panic/Stagger
          if (attacker && attacker !== target) checkStaggerPanic(attacker); // Charge/Poise không ảnh hưởng Stamina/Sanity nên ít khi cần, nhưng check cho chắc nếu sau này có tương tác khác
          encounter.pendingAction = null;
          await saveEncounter(channelId, encounter);

          await interaction.update({
            embeds: [{
              title: "✅ Action đã xác nhận",
              description: `${attackerLabel} → ${targetLabel}: \`${calcOpts.dmgStr}\`\n> Gây **${finalDmg.toFixed(3)}** dmg thật${defenseNote}${staminaNote}`,
              color: 0x2ecc71,
            }],
            components: [],
          }).catch(() => {});
          await interaction.channel.send({ embeds: [buildEncounterBoardEmbed(encounter)] }).catch(() => {});
        } else {
          encounter.pendingAction = null;
          await saveEncounter(channelId, encounter);
          await interaction.update({
            embeds: [{
              title: "❌ Action bị từ chối",
              description: `${attackerLabel} → ${targetLabel} (\`${calcOpts.dmgStr}\`) đã bị GM từ chối — không có gì thay đổi (Stamina chưa từng bị trừ cho tới lúc xác nhận, nên không mất gì).`,
              color: 0xe74c3c,
            }],
            components: [],
          }).catch(() => {});
        }
      });
    } catch (err) {
      log("error", "encounterConfirm", interaction.user?.id ?? "unknown", err.message);
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
  const [, channelId, action] = interaction.customId.split(":");
  const dmgStr = interaction.fields.getTextInputValue("dmgStr");
  try {
    if (action === "attack") {
      const { embed, components } = await doPlayerAttack(channelId, interaction.user.id, interaction.user.toString(), dmgStr);
      await interaction.reply({ embeds: [embed], components });
    } else if (action === "hit") {
      const { embed, components } = await doPlayerHit(channelId, interaction.user.id, interaction.user.toString(), dmgStr);
      await interaction.reply({ embeds: [embed], components });
    }
  } catch (err) {
    log("error", "encModalSubmit", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
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

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`invinfo:${targetUserId}:${itemType}:${itemName}`)
        .setLabel("ℹ️ Xem info")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`invact:${targetUserId}:${itemType}:${itemName}`)
        .setLabel(itemType === "book" ? "📖 Mở" : "⚙️ Craft")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canOpen && !canCraft),
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
    const critMul = interaction.options.getNumber("critmul") ?? 1;
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
function gracefulShutdown(signal) {
  log("info", "shutdown", "system", `${signal} received, shutting down.`);
  clearInterval(cooldownCleanupTimer);
  clearInterval(webParrySessionCleanupTimer);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => log("error", "uncaughtException", "system", err.message, { stack: err.stack }));
process.on("unhandledRejection", (reason) => log("error", "unhandledRejection", "system", String(reason)));
