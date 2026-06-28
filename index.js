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
  "name", "hp", "weapon", "stamina", "light", "key", "target", "skill", "ref", "text", "index", "coin", "perks", "speedrange", "amount", "oppskill", "for", // -encounter
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
    data.unlockedSkillTree = data.unlockedSkillTree ?? [];
    data.equippedPages = data.equippedPages ?? [null, null, null, null, null];
    data.equippedEgoPages = data.equippedEgoPages ?? [null, null, null, null, null];
    data.equippedWeapon = data.equippedWeapon ?? null;
    data.equippedOutfit = data.equippedOutfit ?? null;
    data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
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
  data.unlockedSkillTree = data.unlockedSkillTree ?? [];
  data.equippedPages = data.equippedPages ?? [null, null, null, null, null];
  data.equippedEgoPages = data.equippedEgoPages ?? [null, null, null, null, null];
  data.equippedWeapon = data.equippedWeapon ?? null;
  data.equippedOutfit = data.equippedOutfit ?? null;
  data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
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
      if (!raw) return { exp: 0, ahn: 0, books: {}, items: {}, unlockedSkillTree: [], equippedPages: [null,null,null,null,null], equippedEgoPages: [null,null,null,null,null], equippedWeapon: null, equippedOutfit: null, equippedAccessories: [null,null,null] };
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
        : { exp: 0, ahn: 0, books: {}, items: {}, unlockedSkillTree: [], equippedPages: [null,null,null,null,null], equippedEgoPages: [null,null,null,null,null], equippedWeapon: null, equippedOutfit: null, equippedAccessories: [null,null,null] };
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
      : { exp: 0, ahn: 0, books: {}, items: {}, unlockedSkillTree: [], equippedPages: [null,null,null,null,null], equippedEgoPages: [null,null,null,null,null], equippedWeapon: null, equippedOutfit: null, equippedAccessories: [null,null,null] };
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
  // QUAN TRỌNG: hỗ trợ multiplier "x<N>" ở CẢ 2 vị trí — TRƯỚC type letter (cú pháp
  // gốc, VD "15x2B+3Poise") VÀ NGAY SAU type letter, TRƯỚC effects (cú pháp tự nhiên
  // hay viết nhầm, VD "15Bx2+3Poise") — trước đây CHỈ hỗ trợ vị trí đầu, viết theo
  // thứ tự sau sẽ làm "x2" bị bỏ qua (không nhân hit) RỒI "2" còn sót lại bị regex
  // hiểu lầm thành 1 hit MỚI, sai hoàn toàn (VD "+3Poise" sau "x2" bị nuốt mất, biến
  // "2+3Poise" thành hit giả "2 dmg +3% bonus Pierce"). Giờ khớp được CẢ 2, lấy bất
  // kỳ bên nào có giá trị.
  const damageRegex =
    /([\d.]+)(?:x([\d.]+))?(?:\+([\d.]+)%?)?\s*(Dice)?([BPSbps])(?:x([\d.]+))?((?:\+\d*Sinking|\+\d*Rupture|[+-]\d*Poise|[+-]\d*Charge|[+-]\d*Burn|[+-]\d*Bleed|\+\d*TremorBurst|[+-]\d*Tremor|\+\d*Living|\+\d*Departed|\+Crit\d+)*)/gi;
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
    const multiplier = match[2] ? parseInt(match[2]) : (match[6] ? parseInt(match[6]) : 1);
    const extraPct = match[3] ? parseFloat(match[3]) : 0;
    const isDice = !!match[4];
    const dmgType = match[5] ? match[5].toUpperCase() : "B";
    const effectsStr = match[7] || "";
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
    // sớm nếu tremor về 0 giữa chừng (không có gì để Burst tiếp). LÀM TRÒN XUỐNG sau
    // mỗi lần giảm nửa (VD: 7→3, không phải 3.5) — Math.floor thay vì chia thường.
    let tremorStaminaLoss = 0;
    for (let burstIdx = 0; burstIdx < tremorBurstCount; burstIdx++) {
      if (enemyTremor <= 0) break;
      tremorStaminaLoss += enemyTremor * 5;
      enemyTremor = Math.floor(enemyTremor / 2);
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
  // phải -1 như Sinking/Rupture)." — tính SAU khi đã áp dụng hết mọi +N/-NBurn từ các
  // hit trong dmgStr (enemyBurn, không phải burnInit thô) — để skill có thể "gây thêm
  // Burn" hoặc "tiêu thụ Burn" ngay trong cùng 1 lần roll, rồi mới tick cuối turn trên
  // số liệu CUỐI CÙNG. LÀM TRÒN XUỐNG sau khi giảm nửa (VD: 7→3, không phải 3.5).
  const burnDmgThisTurn = enemyBurn * 2;
  const burnAfter = Math.floor(enemyBurn / 2);

  // ── Bleed (trigger mỗi lần ĐỊCH hành động tấn công — không phải lúc bị tấn công
  // — RỒI giảm 1 nửa lúc end turn, đây là 2 thời điểm KHÁC NHAU) ────────────────
  // "1 bleed count gây dmg = 1/4 count mỗi khi địch hành động tấn công trong turn,
  // giảm 1 nửa sau end turn." — bleedActions = số lần địch hành động turn này (không
  // tự suy ra được, phải nhập tay vì /math không mô phỏng hành động của địch). Cũng
  // tính trên enemyBleed SAU khi áp dụng +N/-NBleed từ dmgStr, giống Burn ở trên.
  // LÀM TRÒN XUỐNG sau khi giảm nửa, giống Burn/Tremor.
  const bleedDmgPerAction = enemyBleed / 4;
  const bleedDmgThisTurn = bleedDmgPerAction * Math.max(0, bleedActions);
  const bleedAfter = Math.floor(enemyBleed / 2);

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
      extraInfo += ` | <:TremorBurst:1513802464632246352>Tremor Burst${burstNote}: -${r.tremorStaminaLoss} Sta địch → ${r.tremorStacksAfter} Counts`;
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
    { name: "<:TremorBurst:1513802464632246352>Tremor Burst", value: `-${totalTremorStaminaLoss} Sta địch — count: ${tremorInit} → ${finalTremor}`, inline: true, showIf: tremorInit > 0 || finalTremor > 0 || totalTremorStaminaLoss > 0 },
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
const MUTUALLY_EXCLUSIVE_PERKS = [
  ["Overbearing", "Steady Breathing"],
  ["Follow-Up", "Pounce"],
];
function findExclusiveConflict(existingPerks, newPerk) {
  for (const [a, b] of MUTUALLY_EXCLUSIVE_PERKS) {
    if (newPerk === a && existingPerks.includes(b)) return b;
    if (newPerk === b && existingPerks.includes(a)) return a;
  }
  return null;
}

function hasPerk(combatant, perkName) {
  return (combatant.unlockedPerks ?? []).includes(perkName);
}

// ── SKILL TREE PERK ENGINE ───────────────────────────────────────────────────
// Chỉ tự động hoá perk dựa trên hệ thống ĐÃ CÓ (HP%/Sanity/Stamina/Poise/Charge/
// Rupture/Bleed/Tremor/Stagger/crit/Emotion Level/M1). Perk phụ thuộc Guard/Evade/
// Parry/Clash/E.G.O/Shin (hệ thống CHƯA CÓ trong V2) CHỈ nằm trong unlockedPerks
// dạng ghi chú — GM tự áp dụng tay, KHÔNG có logic nào ở đây cho chúng (theo đúng
// quyết định: không thêm lại Guard/Evade/Parry chỉ để 1 nhánh skill tree có cái
// để hóa vào).

/** applyStatusMultiplierToDmgStr — viết lại TẤT CẢ "+N<tag>" trong dmgStr thành
 *  "+ceil(N*multiplier)<tag>" — dùng cho perk dạng "Tăng X lần khả năng áp <status>"
 *  (Tear To Shreds, A Beautiful Mess, Inner Ardor...). Multiplier=1 thì trả nguyên
 *  dmgStr (không tốn chi phí regex nếu không cần). Chỉ sửa GAIN (+N), không đụng
 *  CONSUME (-N) — vì luật chỉ nói "khả năng ÁP", không nói gì về tiêu thụ. */
function applyStatusMultiplierToDmgStr(dmgStr, tagName, multiplier) {
  if (multiplier === 1 || !dmgStr) return dmgStr;
  return dmgStr.replace(new RegExp(`\\+(\\d*)${tagName}`, "gi"), (match, numStr) => {
    const num = numStr ? parseInt(numStr, 10) : 1;
    return `+${Math.ceil(num * multiplier)}${tagName}`;
  });
}

/**
 * computeAttackerPerkContext — tính TẤT CẢ hiệu ứng từ perk của BÊN TẤN CÔNG ảnh
 * hưởng tới 1 đòn đánh lên 1 target cụ thể. Gọi TRƯỚC khi build calcOpts (để lấy
 * bonusPct/critMul/critDiv đưa vào), và sau khi build dmgStr-đã-rewrite-multiplier
 * (để đưa vào calcMathCore). isM1 phân biệt Kinetic Energy (chỉ áp cho M1, không
 * áp cho Page/skill).
 * @returns { bonusPct, critMul, critDivOverride, dmgStrRewritten, instantKill }
 */
function computeAttackerPerkContext(attacker, target, dmgStr, { isM1 = false } = {}) {
  let bonusPct = 0;
  // BUG ĐÃ SỬA: trước đây critMul khởi tạo = 1 (không có bonus crit dmg nào trừ
  // khi có Sharp Eyes) — SAI hoàn toàn so với luật ("crit dmg [1,3x]" là mặc định
  // CHO MỌI NGƯỜI, không phải đặc quyền của 1 perk). Mọi crit từ trước tới giờ
  // (M1/Page/enemy) ĐỀU không có bonus dmg nào trừ khi attacker có Sharp Eyes —
  // lỗi không bị phát hiện vì mọi test crit trước đó đều dùng Sharp Eyes (che mất
  // bug, vì 1.5x luôn được set ĐÚNG bất kể giá trị khởi tạo là gì).
  let critMul = 1.3;
  let critDivOverride = null;
  let instantKill = false;

  // Battle Ignition: turn trước đánh ≥10 lần → +15% Dmg turn này
  if (hasPerk(attacker, "Battle Ignition") && (attacker.lastTurnAttackCount ?? 0) >= 10) bonusPct += 15;
  // Manifested E.G.O đang active: +30% Dmg M1+skill bản thân gây ra — cơ chế GỐC
  // của game (không phải Skill Tree perk), không cần hasPerk gate.
  if (attacker.manifestedEGO) bonusPct += 30;
  // Chấn thương nặng "Mất tay": -50% sát thương gây ra — cơ chế GỐC, không cần unlock.
  if ((attacker.injuries ?? []).includes("Mất tay")) bonusPct -= 50;
  // Backdraft: Stamina ≥50 (xấp xỉ "lúc turn start" bằng Stamina hiện tại, vì không
  // lưu snapshot riêng lúc turn start) → +20% Dmg
  if (hasPerk(attacker, "Backdraft") && attacker.currentStamina >= 50) bonusPct += 20;
  // Death Comes For All: target có Rupture → +30% Dmg
  if (hasPerk(attacker, "Death Comes For All") && target.rupture > 0) bonusPct += 30;
  // Break and Punish: target bị Stagger → +20% Dmg
  if (hasPerk(attacker, "Break and Punish") && target.staggered) bonusPct += 20;
  // Kinetic Energy: CHỈ áp cho M1, cần ≥10 Charge → +10% Dmg
  if (isM1 && hasPerk(attacker, "Kinetic Energy") && attacker.charge >= 10) bonusPct += 10;
  // Wail: bản thân dưới -25 Sanity → +10% Dmg
  if (hasPerk(attacker, "Wail") && attacker.currentSanity < -25) bonusPct += 10;
  // Borderline Breakdown: mỗi -5 Sanity (âm) → +2% Dmg, tối đa 18%
  if (hasPerk(attacker, "Borderline Breakdown") && attacker.currentSanity < 0) {
    bonusPct += Math.min(18, Math.floor(-attacker.currentSanity / 5) * 2);
  }
  // Sharp Eyes: Crit dmg multiplier → 1.5x (thay 1.3x mặc định)
  if (hasPerk(attacker, "Sharp Eyes")) critMul = 1.5;
  // Steady Breathing: Poise crit chia 1.5 thay vì giảm nửa (critDiv override)
  if (hasPerk(attacker, "Steady Breathing")) critDivOverride = 1.5;
  // Overcharged Vessel: đang active (overchargedTurnsLeft > 0) → +N% Dmg đã tính
  // sẵn lúc kích hoạt (xem -encounter overcharge). Dice Up bonus KHÔNG tự áp được
  // (ảnh hưởng lúc roll skill tay qua -skill, không phải lúc tính dmgStr ở đây) —
  // chỉ hiện trong status để player tự cộng tay lúc roll.
  if ((attacker.overchargedTurnsLeft ?? 0) > 0) bonusPct += attacker.overchargedDmgBonusPct ?? 0;

  // Claim Their Heart: target Stagger + dưới 15% HP → kết liễu ngay
  if (hasPerk(attacker, "Claim Their Heart") && target.staggered && target.currentHp > 0 && target.currentHp < target.maxHp * 0.15) {
    instantKill = true;
  }

  // Multiplier áp status — viết lại dmgStr TRƯỚC khi đưa vào calcMathCore.
  let dmgStrRewritten = dmgStr;
  if (hasPerk(attacker, "Tear To Shreds")) dmgStrRewritten = applyStatusMultiplierToDmgStr(dmgStrRewritten, "Rupture", 1.5);
  if (hasPerk(attacker, "A Beautiful Mess") && target.bleed >= 7) dmgStrRewritten = applyStatusMultiplierToDmgStr(dmgStrRewritten, "Bleed", 1.5);
  if (hasPerk(attacker, "Cry On Deaf Ears") && attacker.currentSanity < -25) dmgStrRewritten = applyStatusMultiplierToDmgStr(dmgStrRewritten, "Sinking", 1.5);
  if (hasPerk(attacker, "Inner Ardor")) {
    const burnMul = attacker.emotionLevel >= 2 ? 2 : attacker.emotionLevel === 1 ? 1.5 : 1;
    dmgStrRewritten = applyStatusMultiplierToDmgStr(dmgStrRewritten, "Burn", burnMul);
  }
  // Biting Embrace/Shockwave: target Stagger + hit có gây Rupture/Tremor → +5 nữa.
  // Chỉ áp khi dmgStr THỰC SỰ có tag tương ứng (không tự thêm tag mới nếu hit gốc
  // không nhắm tới status đó).
  if (target.staggered) {
    if (hasPerk(attacker, "Biting Embrace") && /\+\d*Rupture/i.test(dmgStrRewritten)) {
      dmgStrRewritten = dmgStrRewritten.replace(/\+(\d*)Rupture/gi, (m, n) => `+${(n ? parseInt(n, 10) : 1) + 5}Rupture`);
    }
    if (hasPerk(attacker, "Shockwave") && /\+\d*TremorBurst/i.test(dmgStrRewritten) === false && /[+-]\d*Tremor/i.test(dmgStrRewritten)) {
      dmgStrRewritten = dmgStrRewritten.replace(/\+(\d*)Tremor(?!Burst)/gi, (m, n) => `+${(n ? parseInt(n, 10) : 1) + 5}Tremor`);
    }
    if (hasPerk(attacker, "Wasted Hours, Lying Down") && /\+TremorBurst/i.test(dmgStrRewritten)) {
      // Gấp đôi Tremor Burst lên Stagger — nhân số LẦN burst (TremorBurst count), không phải tăng count Tremor.
      dmgStrRewritten = dmgStrRewritten.replace(/\+(\d*)TremorBurst/gi, (m, n) => `+${(n ? parseInt(n, 10) : 1) * 2}TremorBurst`);
    }
  }

  return { bonusPct, critMul, critDivOverride, dmgStrRewritten, instantKill };
}

/** computeDefenderDmgReduction — % giảm dmg NHẬN VÀO của bên BỊ tấn công, dựa trên
 *  perk tự thân (Smoldering Resolve) + trạng thái Manifested E.G.O (No Will To Break). */
function computeDefenderDmgReduction(defender) {
  let reductionPct = 0;
  if (hasPerk(defender, "Smoldering Resolve") && defender.currentHp < defender.maxHp * 0.4) reductionPct += 10;
  if (hasPerk(defender, "No Will To Break") && defender.manifestedEGO) reductionPct += 20;
  return reductionPct;
}

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
function applyEmotionDelta(combatant, delta) {
  const notes = [];
  if (!delta) return notes;
  combatant.emotionCoin = (combatant.emotionCoin ?? 0) + delta;
  const maxLevel = getMaxEmotionLevel(combatant);
  while (
    combatant.emotionLevel < maxLevel &&
    (combatant.emotionLevel > 0 || (combatant.emotionLevelCooldownLeft ?? 0) <= 0) &&
    combatant.emotionCoin >= EMOTION_LEVEL_TABLE[combatant.emotionLevel + 1].coinNeeded
  ) {
    const nextLevel = combatant.emotionLevel + 1;
    const tier = EMOTION_LEVEL_TABLE[nextLevel];
    combatant.emotionCoin -= tier.coinNeeded;
    combatant.emotionLevel = nextLevel;
    combatant.emotionLevelCooldownLeft = 0; // đang active — không còn CD nào treo nữa
    combatant.emotionLevelTurnsLeft = hasPerk(combatant, "Light Body") ? Infinity : EMOTION_LEVEL_DURATION_TURNS;
    const healAmount = Math.round(combatant.maxHp * tier.healPct / 100 * 100) / 100;
    combatant.currentHp = Math.min(combatant.maxHp, combatant.currentHp + healAmount);
    combatant.maxLight = combatant.baseMaxLight + tier.maxLightBonus;
    if (hasPerk(combatant, "Emotion Surge")) combatant.currentLight = combatant.maxLight;
    else combatant.currentLight = Math.min(combatant.currentLight, combatant.maxLight);
    notes.push(`🆙 Emotion Level ${nextLevel}! (+${healAmount.toFixed(2)} HP, +${tier.diceUp} Dice Up khi dùng skill, Max Light → ${combatant.maxLight})`);
  }
  return notes;
}

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

function normalizeWeaponWeight(w) {
  const x = (w ?? "").trim().toLowerCase();
  if (x === "light" || x === "l") return "light";
  if (x === "heavy" || x === "h") return "heavy";
  return "medium"; // default — bao gồm cả khi gõ "medium"/"m"/để trống
}

/** Chuẩn hoá key ngắn cho enemy (VD "Mo" → "mo") — dùng làm định danh trong lệnh,
 *  KHÔNG dùng tên hiển thị đầy đủ (VD "Mo (Brother of Iron)") để gõ lệnh cho nhanh. */
function normalizeEnemyKey(k) {
  return (k ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/** Combatant — dùng CHUNG cho mọi enemy và mọi player trong encounter. */
function createCombatant({ name, maxHp, maxStamina = ENCOUNTER_DEFAULT_MAX_STAMINA, maxLight = ENCOUNTER_DEFAULT_MAX_LIGHT, weaponWeight = "medium", resistance = null, speedRangeMin = 3, speedRangeMax = 6 }) {
  return {
    name,
    maxHp, currentHp: maxHp,
    maxStamina, currentStamina: maxStamina,
    maxSanity: ENCOUNTER_SANITY_MAX, currentSanity: 0,
    // baseMaxLight: giá trị GỐC, KHÔNG đổi — maxLight (effective) = baseMaxLight +
    // bonus từ Emotion Level đang active (xem EMOTION_LEVEL_TABLE.maxLightBonus),
    // tính lại mỗi khi Level thay đổi (lên/hết hạn) — xem applyEmotionDelta/
    // advanceCombatantTurn. Tách riêng để KHÔNG mất giá trị gốc khi Level hết hạn.
    baseMaxLight: maxLight, maxLight, currentLight: 0,
    weaponWeight: normalizeWeaponWeight(weaponWeight),
    resistance: resistance ?? { B: 1, P: 1, S: 1 },
    // 7 status effect — LƯU Ý quan trọng về AI mang gì: Poise/Charge là "trên bản
    // thân" (self) — combatant này tự mang, áp dụng khi NÓ là người TẤN CÔNG.
    // Sinking/Rupture/Burn/Bleed/Tremor là "trên người địch" (enemy) — combatant này
    // mang khi NÓ là người BỊ TẤN CÔNG (target). Khi build calcOpts cho 1 action, phải
    // lấy poiseInit/chargeInit từ COMBATANT TẤN CÔNG, còn sinkingInit/ruptureInit/
    // burnInit/bleedInit/tremorInit từ COMBATANT BỊ TẤN CÔNG.
    sinking: 0, rupture: 0, poise: 0, charge: 0, burn: 0, bleed: 0, tremor: 0,
    staggered: false, staggerTurnsLeft: 0,
    panic: false, panicTurnsLeft: 0,
    // staminaUsedThisTurn: để tính Light gain ("đánh đủ 20 sta M1 trong turn → +1
    // Light turn sau") — reset về 0 mỗi lần endturn.
    staminaUsedThisTurn: 0,
    // Emotion Level — buff TẠM THỜI (xem comment đầy đủ ở EMOTION_LEVEL_TABLE phía
    // trên), KHÔNG cộng dồn vĩnh viễn. emotionLevel=0 nghĩa là KHÔNG có level active.
    // emotionLevelTurnsLeft: số turn còn lại của level ĐANG active (Infinity nếu đã
    // mở khóa Light Body — "kéo dài tới hết encounter"). emotionLevelCooldownLeft:
    // số turn còn lại của CD SAU KHI 1 level hết hạn (trong CD thì KHÔNG lên lại
    // được dù coin đủ, dù về 0).
    emotionLevel: 0, emotionCoin: 0, emotionLevelTurnsLeft: 0, emotionLevelCooldownLeft: 0,
    // unlockedPerks: COPY từ profile (data.unlockedSkillTree) lúc -encounter join —
    // KHÔNG tự khai trực tiếp ở đây nữa (đã chuyển sang -unlockskilltree, lưu vĩnh
    // viễn trên profile thay vì tạm trong encounter — xem comment ở lệnh đó).
    unlockedPerks: [],
    // buffs/debuffs: list TỰ DO (text do GM/player khai, KHÔNG tự tính/tự hết hạn) —
    // vì hiệu ứng buff quá đa dạng giữa các skill, không có cách tự động hoá an toàn.
    // Mỗi entry: { text, addedAt }. Xem -encounter buff/debuff/unbuff.
    buffs: [], debuffs: [],
    // skillCooldowns: { skillKey: số turn còn lại }. Set khi attack/hit có skill:
    // reference VÀ skill đó có cd (cooldown) > 0 theo skills.js — decrement mỗi
    // endturn, xoá khi về 0. Dùng để CHẶN spam lại skill đang cooldown.
    skillCooldowns: {},
    // ── Skill Tree tracking (xem PERK_DEFS) — các field dưới đây CHỈ phục vụ phần
    // perk TỰ ĐỘNG hoá được (dựa trên HP%/Sanity/Stamina/Poise/Charge/Rupture/Bleed/
    // Tremor/Stagger/crit/Emotion Level/M1 — hệ thống ĐÃ CÓ). Perk phụ thuộc Guard/
    // Evade/Parry/Clash/E.G.O/Shin (hệ thống CHƯA CÓ) chỉ nằm trong unlockedPerks
    // dạng ghi chú, GM tự áp dụng tay — KHÔNG có field riêng nào ở đây cho chúng.
    attacksThisTurn: 0, lastTurnAttackCount: 0, // Battle Ignition
    followUpUsedThisTurn: false, // Follow-Up/Pounce — CHUNG 1 cờ vì 2 perk loại trừ nhau + đều chỉ 1 lần/turn
    bleedFirstHitUsedThisTurn: false, // Craving Synergy/Thirst/Break the Dams — "đòn đánh ĐẦU TIÊN mỗi turn"
    breakTheDamsCdLeft: 0, // CD 3 turn riêng cho Break the Dams
    m1AttackCount: 0, // tổng M1 đã đánh (không reset theo turn) — cho Overbearing/Blessed Sparks "mỗi đòn thứ 2"
    poiseReductionPending: 0, // Smoke Overload — số Poise ĐÁNG LẼ bị giảm do crit, dồn lại chờ end turn mới trừ thật
    overchargedTurnsLeft: 0, overchargedDiceUpBonus: 0, overchargedDmgBonusPct: 0, // Overcharged Vessel
    // Manifested E.G.O — Duration = Emotion Level hiện tại × 3 turn (Lv1=3, Lv2=6,
    // suy ra Lv3=9/Lv4=12/Lv5=15 theo cùng quy luật — chỉ Lv1/2 được xác nhận trực
    // tiếp). CD 5 turn SAU KHI hết hiệu lực. -30 Sanity lúc kích hoạt. Active: +3
    // Dice Up (chỉ hiển thị, không tự áp vào roll skill — như mọi nguồn Dice Up
    // khác) + 30% Dmg M1+skill bản thân gây ra.
    manifestedEGO: false, manifestedEGOTurnsLeft: 0, manifestedEGOCooldownLeft: 0, firstManifestEGOUsed: false,
    // Chấn thương — nhận dmg >30% Max HP trong 1 đòn → roll 10% nặng/40% nhẹ/50%
    // không gì. injuries: list các chấn thương ĐANG có (có thể nhiều, KHÔNG tự hết
    // — chỉ GM xoá tay nếu chữa lành, xem -encounter healinjury). daseStacks riêng
    // (Choáng) vì cộng dồn nhiều stack mới phát huy tác dụng, khác các chấn thương
    // khác (chỉ cần CÓ là đủ).
    injuries: [], dazedStacks: 0,
    // ── Speed/Turn Order (update mới) — mỗi Outfit có 1 Range Speed riêng (VD 3~6),
    // roll trong range đó mỗi turn để quyết định thứ tự hành động. Haste/Bind là 2
    // status MỚI ảnh hưởng Speed (+1 Speed/Haste, -1 Speed/Bind) — chỉnh tay qua
    // -encounter haste/bind (KHÔNG qua dmgStr tag như 7 status cũ, vì chưa rõ luật
    // gain/consume chi tiết đủ để tích hợp sâu vào calcMathCore như Poise/Sinking...).
    speedRangeMin: speedRangeMin, speedRangeMax: speedRangeMax,
    haste: 0, bind: 0,
    currentSpeed: null, // null = chưa roll turn này — set bởi -encounter rollspeed
    // Guard/Evade — hành động phòng thủ CHUNG (không cần skill cụ thể), dùng TỰ DO
    // bao nhiêu lần cũng được (chỉ giới hạn bởi Stamina) — 1 charge chặn ĐƯỢC SỐ HIT
    // theo vũ khí của BÊN TẤN CÔNG M1 (Light=4 hit/charge, Medium=2, Heavy=1 — đúng
    // luật thật, xem WEAPON_DEFENSE_HITS). Ưu tiên Evade trước nếu có cả 2.
    guardCharges: 0, evadeCharges: 0,
    // parryRolls: mỗi lần dùng -encounter parry sẽ roll d20 NGAY và đẩy vào đây — 1
    // phần tử = 1 lần parry sẵn sàng, KHÔNG phải số nguyên đơn giản như guard/evade
    // (vì mỗi lần parry có kết quả roll RIÊNG, ăn/thua phụ thuộc so với roll của bên
    // tấn công lúc CONFIRM, không phải lúc declare).
    parryRolls: [],
    // Shin/Mang — hi sinh 25 Sanity/turn (CHẶN nếu Sanity hiện tại ≤ -10) để nhận
    // Shin (-0.2x mọi Res BẢN THÂN — dễ ăn dmg hơn) + Mang (+10%/+10% mỗi vòng kích
    // hoạt liên tiếp Dmg M1+skill TRONG TURN, gây True Dmg — Res mục tiêu < 1x bị
    // ép về 1x). shinMangRounds KHÔNG tự reset (giả định "vòng" = số lần kích hoạt
    // liên tiếp tự track, không tự suy ra "liên tiếp" qua nhiều turn — GM tự theo
    // dõi nếu cần đúng nghĩa "liên tiếp không gián đoạn").
    shinMangActive: false, shinMangRounds: 0, shinMangUsedThisTurn: false,
  };
}

/** rollSpeedValue — roll trong Range Speed của combatant, cộng Haste trừ Bind
 *  ("1 Haste +1 Speed, 1 Bind -1 Speed" theo update mới). */
function rollSpeedValue(combatant) {
  const base = combatant.speedRangeMin + Math.floor(Math.random() * (combatant.speedRangeMax - combatant.speedRangeMin + 1));
  return base + (combatant.haste ?? 0) - (combatant.bind ?? 0);
}

/**
 * determineTurnOrder — roll Speed cho TẤT CẢ combatant, sắp xếp giảm dần quyết
 * định thứ tự hành động. Khi bằng Speed:
 *   - CÙNG PHE (player-player hoặc enemy-enemy) → KHÔNG tự roll lại — đánh dấu
 *     "tiedWith" để GM/player tự thoả thuận ai trước (giữ thứ tự hiện tại làm
 *     fallback nếu không ai lên tiếng).
 *   - KHÁC PHE (có cả player VÀ enemy cùng Speed) → reroll NGAY giữa các bên đang
 *     tie cho tới khi hết tie (lặp, chặn tối đa 20 lần phòng hờ — gần như không
 *     thể chạm trần này với range hữu hạn của dice thật).
 * Lưu kết quả vào encounter.turnOrder để dùng cho hiển thị/tham chiếu Clash sau này.
 */
function determineTurnOrder(encounter) {
  const entries = [];
  for (const ekey of Object.keys(encounter.enemies)) {
    const c = encounter.enemies[ekey];
    c.currentSpeed = rollSpeedValue(c);
    entries.push({ id: ekey, type: "enemy", combatant: c });
  }
  for (const pid of Object.keys(encounter.players)) {
    const c = encounter.players[pid];
    c.currentSpeed = rollSpeedValue(c);
    entries.push({ id: pid, type: "player", combatant: c });
  }

  let guard = 0;
  while (guard++ < 20) {
    const bySpeed = new Map();
    for (const e of entries) {
      const list = bySpeed.get(e.combatant.currentSpeed) ?? [];
      list.push(e);
      bySpeed.set(e.combatant.currentSpeed, list);
    }
    let rerolled = false;
    for (const group of bySpeed.values()) {
      if (group.length < 2) continue;
      if (new Set(group.map(e => e.type)).size > 1) {
        for (const e of group) e.combatant.currentSpeed = rollSpeedValue(e.combatant);
        rerolled = true;
      }
    }
    if (!rerolled) break;
  }

  entries.sort((a, b) => b.combatant.currentSpeed - a.combatant.currentSpeed);
  const order = entries.map((e, i) => ({
    id: e.id, type: e.type, speed: e.combatant.currentSpeed,
    tiedWith: entries.filter((o, j) => j !== i && o.combatant.currentSpeed === e.combatant.currentSpeed).map(o => o.id),
  }));
  encounter.turnOrder = order;
  return order;
}

/** buildTurnOrderText — hiện danh sách thứ tự turn đã roll, kèm cảnh báo hoà cùng phe. */
function buildTurnOrderText(encounter) {
  const order = encounter.turnOrder ?? [];
  if (order.length === 0) return "Chưa roll Speed — dùng `-encounter rollspeed`.";
  return order.map((e, i) => {
    const label = e.type === "enemy" ? `**${encounter.enemies[e.id]?.name ?? e.id}**` : `<@${e.id}>`;
    const tieNote = e.tiedWith.length > 0 ? ` ⚖️ *(hoà Speed — tự thoả thuận thứ tự với ${e.tiedWith.length} người khác cùng phe)*` : "";
    return `**#${i + 1}** ${label} — Speed **${e.speed}**${tieNote}`;
  }).join("\n");
}

/** Đổi { B, P, S } resistance object thành resStr cho calcMathCore — Stagger thì
 *  ĐÈ TOÀN BỘ về 2x bất kể resistance gốc, đúng luật "Khi bị Stagger Resistance set 2x". */
function combatantResStr(combatant) {
  if (combatant.staggered) return "2xB 2xP 2xS";
  const r = combatant.resistance;
  // Shin (đang active): -0,2x mọi Res BẢN THÂN khi combatant này là bên BỊ TẤN
  // CÔNG (defender) — dễ ăn dmg hơn, đánh đổi lấy Mang +Dmg.
  if (combatant.shinMangActive) {
    return `${Math.max(0, r.B - 0.2)}xB ${Math.max(0, r.P - 0.2)}xP ${Math.max(0, r.S - 0.2)}xS`;
  }
  return `${r.B}xB ${r.P}xP ${r.S}xS`;
}

/** trueDmgResStr — dùng khi BÊN TẤN CÔNG có Mang active: ép Res của TARGET tối
 *  thiểu 1x cho mọi loại dmg (nếu target có Res < 1x ở loại đó, coi như đúng 1x —
 *  "True Dmg" — không khuếch đại nếu Res target ĐÃ ≥1x, chỉ neutralize phần KHÁNG
 *  dưới 1x). Gọi THAY combatantResStr(target) khi attacker.shinMangActive — đã bao
 *  gồm luôn phần Shin của TARGET (nếu target cũng có Shin active, áp dụng giảm 0.2x
 *  TRƯỚC rồi mới clamp min 1x, đúng thứ tự "Res hiệu lực sau Shin" mới là Res thật
 *  để so sánh với True Dmg). */
function trueDmgResStr(target) {
  const base = combatantResStr(target); // đã áp Shin/Stagger của target nếu có
  const matches = [...base.matchAll(/([\d.]+)x([BPS])/g)];
  return matches.map(([, val, type]) => `${Math.max(1, parseFloat(val))}x${type}`).join(" ");
}

/** Kiểm tra + set Stagger (Stamina=0) / Panic (Sanity=-45) sau khi 1 combatant vừa
 *  bị trừ Stamina/Sanity — gọi MỖI LẦN sau khi thay đổi 2 giá trị này. Không tự bỏ
 *  qua nếu đã đang stagger/panic (idempotent — set lại staggerTurnsLeft=1 chỉ nếu
 *  CHƯA staggered, tránh việc bị trừ Stamina=0 nhiều lần liên tục lại reset đếm ngược). */
function checkStaggerPanic(combatant) {
  if (combatant.currentStamina <= 0 && !combatant.staggered) {
    combatant.staggered = true;
    // Choáng (chấn thương nhẹ, từ 2 stack trở lên): lần Stagger này kéo dài 2 turn
    // thay vì 1.
    combatant.staggerTurnsLeft = (combatant.dazedStacks ?? 0) >= 2 ? 2 : 1;
    combatant.currentStamina = 0;
  }
  // Negative Thoughts (Gloom, [30 Points]): "Chỉ bị Panic ở +45 Sanity" — đảo
  // NGƯỢC chiều ngưỡng Panic hoàn toàn (thay vì -45). Các phần KHÁC của perk này
  // (đảo dice bonus từ Sanity, nguồn hồi Sanity thành giảm, thắng/thua Clash) PHỤ
  // THUỘC Clash hoặc đụng quá sâu vào core calcMathCore — để GM tự áp dụng tay,
  // CHỈ phần ngưỡng Panic này được code (đủ contained, không rủi ro cho player khác).
  if (hasPerk(combatant, "Negative Thoughts")) {
    if (combatant.currentSanity >= ENCOUNTER_SANITY_MAX && !combatant.panic) {
      combatant.panic = true;
      combatant.panicTurnsLeft = 1;
      combatant.currentSanity = ENCOUNTER_SANITY_MAX;
    }
  } else if (combatant.currentSanity <= -ENCOUNTER_SANITY_MAX && !combatant.panic) {
    combatant.panic = true;
    combatant.panicTurnsLeft = 1;
    combatant.currentSanity = -ENCOUNTER_SANITY_MAX;
  }
}

/** Tiến 1 turn cho 1 combatant — hồi Stamina (hoặc đếm ngược Stagger), đếm ngược
 *  Panic, tính Light gain. Gọi cho TỪNG combatant (mọi enemy + mọi player) khi
 *  -encounter endturn được gọi. */
const MINOR_INJURIES = ["Gãy tay", "Gãy chân", "Gãy Xương", "Choáng"];
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
function getParryClashPenalty(combatant) {
  const injuries = combatant.injuries ?? [];
  let penalty = 0;
  if (injuries.includes("Gãy tay")) penalty += 5;
  if (injuries.includes("Gãy chân")) penalty += 3;
  if (injuries.includes("Mất Chân")) penalty += 10;
  return penalty;
}

function rollInjury(combatant, dmgDealtThisHit) {
  if (dmgDealtThisHit <= combatant.maxHp * 0.3) return null;
  const roll = Math.random();
  let injuryName;
  if (roll < 0.10) injuryName = SEVERE_INJURIES[Math.floor(Math.random() * SEVERE_INJURIES.length)];
  else if (roll < 0.50) injuryName = MINOR_INJURIES[Math.floor(Math.random() * MINOR_INJURIES.length)];
  else return null;

  combatant.injuries = combatant.injuries ?? [];
  if (injuryName === "Choáng") {
    combatant.dazedStacks = (combatant.dazedStacks ?? 0) + 1;
    combatant.injuries.push(`Choáng (stack ${combatant.dazedStacks})`);
  } else if (injuryName === "Gãy Xương") {
    combatant.maxHp = Math.max(1, combatant.maxHp - 30);
    combatant.currentHp = Math.min(combatant.currentHp, combatant.maxHp);
    combatant.injuries.push("Gãy Xương (-30 Max HP)");
  } else if (injuryName === "Vết thương lớn") {
    combatant.maxHp = Math.max(1, combatant.maxHp - 100);
    combatant.currentHp = Math.min(combatant.currentHp, combatant.maxHp);
    combatant.injuries.push("Vết thương lớn (-100 Max HP)");
  } else {
    combatant.injuries.push(injuryName);
  }
  return injuryName;
}

function advanceCombatantTurn(combatant) {
  combatant.currentSpeed = null; // phải roll lại mỗi turn mới (xem -encounter rollspeed)
  // Burn — gây dmg = count×2 lúc CUỐI turn, SAU ĐÓ mới giảm nửa (đúng thứ tự luật:
  // "gây dmg... sau đó giảm nó đi 1 nửa"). Bleed dmg = count/4 mỗi khi CHÍNH kẻ
  // mang Bleed hành động tấn công — xử lý ở CONFIRM HANDLER (mỗi lần attacker thực
  // hiện attack/hit/enemyattack), KHÔNG ở đây — chỉ giảm nửa COUNT của Bleed ở đây.
  if ((combatant.burn ?? 0) > 0) {
    const burnDmg = combatant.burn * 2;
    combatant.currentHp = Math.max(0, combatant.currentHp - burnDmg);
  }
  combatant.burn = Math.floor((combatant.burn ?? 0) / 2);
  combatant.bleed = Math.floor((combatant.bleed ?? 0) / 2);
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
  // Light Dash perk (mở khóa từ Skill Tree) — +2 Light mỗi turn start, CỘNG THÊM
  // (không thay thế) cơ chế +1 Light từ staminaUsedThisTurn>=20 phía trên.
  if (hasPerk(combatant, "Light Dash")) {
    combatant.currentLight = Math.min(combatant.maxLight, combatant.currentLight + 2);
  }
  combatant.staminaUsedThisTurn = 0;
  // Emotion Level — đếm ngược Duration (Infinity nếu có Light Body = không bao giờ
  // hết tới khi encounter kết thúc). Hết Duration → rớt về Level 0, maxLight về lại
  // baseMaxLight, vào CD EMOTION_LEVEL_COOLDOWN_TURNS turn (không lên lại được dù
  // coin đủ — xem applyEmotionDelta). Nếu KHÔNG có level active, đếm ngược CD nếu có.
  if (combatant.emotionLevel > 0 && Number.isFinite(combatant.emotionLevelTurnsLeft)) {
    combatant.emotionLevelTurnsLeft -= 1;
    if (combatant.emotionLevelTurnsLeft <= 0) {
      combatant.emotionLevel = 0;
      combatant.maxLight = combatant.baseMaxLight;
      combatant.currentLight = Math.min(combatant.currentLight, combatant.maxLight);
      combatant.emotionLevelCooldownLeft = EMOTION_LEVEL_COOLDOWN_TURNS;
    }
  } else if ((combatant.emotionLevelCooldownLeft ?? 0) > 0) {
    combatant.emotionLevelCooldownLeft -= 1;
  }
  // Giảm cooldown skill — xoá hẳn khi về 0 (không giữ key rác trong object).
  if (combatant.skillCooldowns) {
    for (const sk of Object.keys(combatant.skillCooldowns)) {
      combatant.skillCooldowns[sk] -= 1;
      if (combatant.skillCooldowns[sk] <= 0) delete combatant.skillCooldowns[sk];
    }
  }
  // ── Skill Tree — reset/đếm ngược các cờ/CD theo turn ─────────────────────────
  // Battle Ignition: "turn TRƯỚC đánh ≥10 lần" — shift count turn này thành "turn
  // trước" cho lần check kế tiếp, rồi reset bộ đếm turn mới.
  combatant.lastTurnAttackCount = combatant.attacksThisTurn ?? 0;
  combatant.attacksThisTurn = 0;
  // Follow-Up/Pounce + Craving Synergy/Thirst/Break the Dams ("đòn đầu tiên mỗi
  // turn") — đều là cờ 1 LẦN/turn, reset về false mỗi turn mới.
  combatant.followUpUsedThisTurn = false;
  // Shin/Mang chỉ active TRONG TURN đã kích hoạt — hết turn thì tắt hẳn (phải dùng
  // lại -encounter shinmang, tốn thêm 25 Sanity, nếu muốn duy trì turn sau).
  combatant.shinMangActive = false;
  combatant.shinMangUsedThisTurn = false;
  combatant.bleedFirstHitUsedThisTurn = false;
  if ((combatant.breakTheDamsCdLeft ?? 0) > 0) combatant.breakTheDamsCdLeft -= 1;
  // Manifest E.G.O — đếm ngược Duration (Level×3 turn), hết thì tắt + vào CD 5 turn.
  // Nếu KHÔNG active, đếm ngược CD nếu có.
  if (combatant.manifestedEGO) {
    combatant.manifestedEGOTurnsLeft -= 1;
    if (combatant.manifestedEGOTurnsLeft <= 0) {
      combatant.manifestedEGO = false;
      combatant.manifestedEGOCooldownLeft = 5;
    }
  } else if ((combatant.manifestedEGOCooldownLeft ?? 0) > 0) {
    combatant.manifestedEGOCooldownLeft -= 1;
  }
  // Smoke Overload: Poise ĐÁNG LẼ bị giảm do crit trong turn (đã dồn lại, không trừ
  // ngay) — giờ mới trừ THẬT lúc end turn.
  if ((combatant.poiseReductionPending ?? 0) > 0) {
    combatant.poise = Math.max(0, combatant.poise - combatant.poiseReductionPending);
    combatant.poiseReductionPending = 0;
  }
  // Overcharged Vessel: hết Duration 3 turn thì mất hẳn bonus Dice Up/Dmg đã kích hoạt.
  if ((combatant.overchargedTurnsLeft ?? 0) > 0) {
    combatant.overchargedTurnsLeft -= 1;
    if (combatant.overchargedTurnsLeft <= 0) {
      combatant.overchargedDiceUpBonus = 0;
      combatant.overchargedDmgBonusPct = 0;
    }
  }
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

/** resolveCombatant — tra 1 "id" (key enemy HOẶC userId player) thành combatant
 *  thật + label hiển thị + loại ("enemy"|"player"). Dùng chung cho mọi nơi cần tra
 *  1 bên cụ thể (không phải multi-target — xem resolveTargets cho multi-target). */
function resolveCombatant(encounter, id) {
  if (encounter.enemies[id]) return { combatant: encounter.enemies[id], label: `**${encounter.enemies[id].name}**`, type: "enemy" };
  if (encounter.players[id]) return { combatant: encounter.players[id], label: `<@${id}>`, type: "player" };
  return null;
}

/**
 * resolveTargets — tìm combatant theo target: <key/mention/all>.
 * allowedType:
 *   "enemy"  — CHỈ tìm trong enemies (hành vi cũ, doEnemyAttack KHÔNG dùng giá trị
 *              này — xem "player" dưới).
 *   "player" — CHỈ tìm trong players (doEnemyAttack — enemy đánh player, hành vi cũ
 *              giữ nguyên 100%).
 *   "enemy_or_player" — PvP: player M1/Page giờ có thể target ENEMY (ưu tiên thử
 *              trước, giữ đúng cú pháp key ngắn cũ "mo") HOẶC PLAYER khác (mention/ID
 *              — tự nhận diện, không cần cú pháp riêng). "all" vẫn chỉ áp dụng cho
 *              enemy (pool mặc định) — "tất cả" trong ngữ cảnh có cả PvE+PvP cùng lúc
 *              dễ gây nhầm lẫn nếu áp cho cả 2 phe, nên giữ AN TOÀN: phải gõ rõ từng
 *              player muốn nhắm nếu là PvP, "all" KHÔNG tự động gồm cả player.
 */
function resolveTargets(encounter, targetStr, allowedType) {
  const searchEnemy = allowedType === "enemy" || allowedType === "enemy_or_player";
  const searchPlayer = allowedType === "player" || allowedType === "enemy_or_player";
  const primaryIsEnemy = allowedType === "enemy" || allowedType === "enemy_or_player";
  const primaryPool = primaryIsEnemy ? encounter.enemies : encounter.players;
  const primaryLabel = primaryIsEnemy ? "enemy" : "player";
  const trimmed = (targetStr ?? "").trim();
  if (!trimmed) throw new Error(`Cần chỉ định target: (VD: \`target: mo\` hoặc \`target: all\`).`);
  if (trimmed.toLowerCase() === "all") {
    const ids = Object.keys(primaryPool);
    if (ids.length === 0) throw new Error(`Chưa có ${primaryLabel} nào trong encounter để chọn "all".`);
    return ids.map(id => ({ id, combatant: primaryPool[id], label: primaryIsEnemy ? `**${primaryPool[id].name}**` : `<@${id}>`, type: primaryLabel }));
  }
  const rawKeys = trimmed.split(",").map(s => s.trim());
  const results = [];
  const notFound = [];
  for (const rawKey of rawKeys) {
    let matched = false;
    if (searchEnemy) {
      const enemyKey = normalizeEnemyKey(rawKey);
      if (encounter.enemies[enemyKey]) {
        results.push({ id: enemyKey, combatant: encounter.enemies[enemyKey], label: `**${encounter.enemies[enemyKey].name}**`, type: "enemy" });
        matched = true;
      }
    }
    if (!matched && searchPlayer) {
      const playerId = rawKey.replace(/[<@!>]/g, "");
      if (encounter.players[playerId]) {
        results.push({ id: playerId, combatant: encounter.players[playerId], label: `<@${playerId}>`, type: "player" });
        matched = true;
      }
    }
    if (!matched) notFound.push(rawKey);
  }
  if (notFound.length > 0) {
    const poolDesc = allowedType === "enemy_or_player" ? "enemy/player" : primaryLabel;
    throw new Error(`Không tìm thấy ${poolDesc}: ${notFound.join(", ")} — dùng \`-encounter status\` để xem danh sách.`);
  }
  return results;
}

/** Render 1 dòng trạng thái cho 1 combatant (enemy hoặc player) — dùng chung để
 *  không lặp code giữa phần hiện enemy và phần hiện từng player. */
function formatCombatantBlock(combatant, label) {
  const hpPct = combatant.maxHp > 0 ? Math.max(0, combatant.currentHp / combatant.maxHp) : 0;
  const filled = Math.round(hpPct * 10);
  const hpBar = "🟥".repeat(filled) + "⬛".repeat(10 - filled);
  const r = combatant.resistance;
  const resLine = combatant.staggered
    ? `2x/2x/2x (STAGGER, gốc ${r.B}xB ${r.P}xP ${r.S}xS)`
    : combatant.shinMangActive
      ? `${Math.max(0, r.B - 0.2)}xB ${Math.max(0, r.P - 0.2)}xP ${Math.max(0, r.S - 0.2)}xS (gốc ${r.B}xB ${r.P}xP ${r.S}xS, đang Shin -0,2x)`
      : `${r.B}xB ${r.P}xP ${r.S}xS`;
  const lines = [
    `**${label}**${combatant.currentHp <= 0 ? " — ĐÃ HẠ! 💀" : ""}`,
    `${hpBar} **${Math.max(0, Math.round(combatant.currentHp * 100) / 100)}/${combatant.maxHp}** HP`,
    `> Stamina: **${combatant.currentStamina}/${combatant.maxStamina}** | Sanity: **${combatant.currentSanity}/${combatant.maxSanity}** | Light: **${combatant.currentLight}/${combatant.maxLight}**`,
    `> Res: **${resLine}** | Vũ khí: **${combatant.weaponWeight}**`,
    `> Speed Range: **${combatant.speedRangeMin}~${combatant.speedRangeMax}**${combatant.currentSpeed !== null ? ` | Speed turn này: **${combatant.currentSpeed}**` : ""}${combatant.haste > 0 ? ` | <:Haste:1375181763994849333>${combatant.haste}` : ""}${combatant.bind > 0 ? ` | <:Fix_Bind:1513768025881317457>${combatant.bind}` : ""}`,
  ];
  if ((combatant.guardCharges ?? 0) > 0 || (combatant.evadeCharges ?? 0) > 0) {
    const parts = [];
    if (combatant.guardCharges > 0) parts.push(`🛡️ Guard sẵn sàng x${combatant.guardCharges}`);
    if (combatant.evadeCharges > 0) parts.push(`💨 Evade sẵn sàng x${combatant.evadeCharges}`);
    lines.push(`> ${parts.join(" | ")}`);
  }
  const lvl = combatant.emotionLevel ?? 0;
  const maxLvl = getMaxEmotionLevel(combatant);
  let emotionLine = `> Emotion Level **${lvl}**`;
  if (lvl < maxLvl) emotionLine += ` [Coin: ${combatant.emotionCoin ?? 0}/${EMOTION_LEVEL_TABLE[lvl + 1].coinNeeded}]`;
  else emotionLine += ` (MAX) [Coin: ${combatant.emotionCoin ?? 0}]`;
  if (lvl > 0) {
    emotionLine += !Number.isFinite(combatant.emotionLevelTurnsLeft)
      ? ` — 🔆 vĩnh viễn (Light Body)`
      : ` — còn ${combatant.emotionLevelTurnsLeft} turn`;
  } else if ((combatant.emotionLevelCooldownLeft ?? 0) > 0) {
    emotionLine += ` — ⏳ CD còn ${combatant.emotionLevelCooldownLeft} turn`;
  }
  lines.push(emotionLine);
  if ((combatant.unlockedPerks ?? []).length > 0) lines.push(`> ✨ Perk: ${combatant.unlockedPerks.join(", ")}`);
  if ((combatant.overchargedTurnsLeft ?? 0) > 0) lines.push(`> ⚡ **Overcharged** — +${combatant.overchargedDiceUpBonus} Dice Up, +${combatant.overchargedDmgBonusPct}% Dmg — còn ${combatant.overchargedTurnsLeft} turn`);
  if ((combatant.breakTheDamsCdLeft ?? 0) > 0) lines.push(`> ⏳ Break the Dams CD — còn ${combatant.breakTheDamsCdLeft} turn`);
  if (combatant.shinMangActive) lines.push(`> 🌑 **Shin/Mang active** (vòng ${combatant.shinMangRounds}) — -0,2x Res bản thân, +${combatant.shinMangRounds * 10}% Dmg M1+skill, True Dmg`);
  if (combatant.manifestedEGO) lines.push(`> 😈 **Manifest E.G.O** — còn ${combatant.manifestedEGOTurnsLeft} turn — +3 Dice Up, +30% Dmg M1+skill`);
  else if ((combatant.manifestedEGOCooldownLeft ?? 0) > 0) lines.push(`> ⏳ Manifest E.G.O CD — còn ${combatant.manifestedEGOCooldownLeft} turn`);
  if ((combatant.injuries ?? []).length > 0) lines.push(`> 🩻 Chấn thương: ${combatant.injuries.join(", ")}`);
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
  if ((combatant.buffs ?? []).length > 0) lines.push(`> 🟢 Buff: ${combatant.buffs.map(b => b.text).join(" | ")}`);
  if ((combatant.debuffs ?? []).length > 0) lines.push(`> 🔴 Debuff: ${combatant.debuffs.map(d => d.text).join(" | ")}`);
  const cds = Object.entries(combatant.skillCooldowns ?? {});
  if (cds.length > 0) lines.push(`> ⏱️ CD: ${cds.map(([k, v]) => `${k} (${v}T)`).join(" | ")}`);
  return lines.join("\n");
}

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
async function performGuardEvade(channelId, userId, isAdmin, type, enemyKeyRaw = "") {
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    let combatant, label;
    if (enemyKeyRaw) {
      if (!isAdmin && userId !== encounter.gmId) throw new Error("Chỉ GM/admin mới điều khiển được enemy.");
      const ekey = normalizeEnemyKey(enemyKeyRaw);
      combatant = encounter.enemies[ekey];
      if (!combatant) throw new Error(`Không tìm thấy enemy "${enemyKeyRaw}".`);
      label = `**${combatant.name}**`;
    } else {
      combatant = encounter.players[userId];
      if (!combatant) throw new Error("Bạn chưa tham gia encounter này.");
      label = `<@${userId}>`;
    }
    if (combatant.staggered) throw new Error(`${label} đang bị Stagger — không thể hành động.`);
    if (type === "evade" && (combatant.injuries ?? []).includes("Mất Chân")) {
      throw new Error(`${label} đã Mất Chân — không thể Evade được nữa.`);
    }
    let cost = type === "guard" ? 10 : 20;
    if (type === "evade" && (combatant.injuries ?? []).includes("Gãy chân")) cost *= 2;
    // Close Call Wind (Wrath, [10 Points]): dưới 50% HP → Evade -5 Stamina.
    if (type === "evade" && hasPerk(combatant, "Close Call Wind") && combatant.currentHp < combatant.maxHp * 0.5) {
      cost = Math.max(0, cost - 5);
    }
    // Fleeting Steps (Sloth, [10 Points]): cứ 3 lần né, lần né tiếp theo (lần thứ 4,
    // 8, 12...) KHÔNG tốn Stamina — đếm TRƯỚC khi tính cost, áp dụng NGAY lần này
    // nếu rơi đúng mốc (không phải "lần tới mới free", mà CHÍNH lần thứ 4 này free).
    let freeFromFleetingSteps = false;
    if (type === "evade" && hasPerk(combatant, "Fleeting Steps")) {
      combatant.evadeCountForFleetingSteps = (combatant.evadeCountForFleetingSteps ?? 0) + 1;
      if (combatant.evadeCountForFleetingSteps % 4 === 0) { freeFromFleetingSteps = true; cost = 0; }
    }
    if (combatant.currentStamina < cost) throw new Error(`Không đủ Stamina — cần ${cost}, còn ${combatant.currentStamina}.`);
    combatant.currentStamina -= cost;
    combatant.staminaUsedThisTurn = (combatant.staminaUsedThisTurn ?? 0) + cost;
    const chargeField = type === "guard" ? "guardCharges" : "evadeCharges";
    combatant[chargeField] = (combatant[chargeField] ?? 0) + 1;
    checkStaggerPanic(combatant);
    await saveEncounter(channelId, encounter);
    result = `${type === "guard" ? "🛡️ Guard" : "💨 Evade"}! ${label} -${cost} Stamina${freeFromFleetingSteps ? " (Fleeting Steps — FREE lần này!)" : ""} → đang có ${combatant[chargeField]} charge ${type} (1 charge chặn 4 hit M1 Light / 2 hit Medium / 1 hit Heavy của đối phương).`;
  });
  return result;
}

/** performParry — logic CHUNG cho -encounter parry VÀ dropdown hành động. */
async function performParry(channelId, userId, isAdmin, enemyKeyRaw = "") {
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    let combatant, label;
    if (enemyKeyRaw) {
      if (!isAdmin && userId !== encounter.gmId) throw new Error("Chỉ GM/admin mới điều khiển được enemy.");
      const ekey = normalizeEnemyKey(enemyKeyRaw);
      combatant = encounter.enemies[ekey];
      if (!combatant) throw new Error(`Không tìm thấy enemy "${enemyKeyRaw}".`);
      label = `**${combatant.name}**`;
    } else {
      combatant = encounter.players[userId];
      if (!combatant) throw new Error("Bạn chưa tham gia encounter này.");
      label = `<@${userId}>`;
    }
    if (combatant.staggered) throw new Error(`${label} đang bị Stagger — không thể hành động.`);
    const rawRoll = 1 + Math.floor(Math.random() * 20);
    const penalty = getParryClashPenalty(combatant);
    const roll = rawRoll - penalty;
    combatant.parryRolls = combatant.parryRolls ?? [];
    combatant.parryRolls.push(roll);
    await saveEncounter(channelId, encounter);
    result = `🗡️ Parry! ${label} roll được **${rawRoll}**${penalty > 0 ? ` -${penalty} (chấn thương) = **${roll}**` : ""} (0 Stamina) — đang có ${combatant.parryRolls.length} lần parry chờ sẵn.`;
  });
  return result;
}

/** performShinMang — logic CHUNG cho -encounter shinmang VÀ dropdown hành động. */
async function performShinMang(channelId, userId) {
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    const player = encounter.players[userId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này.");
    if (!hasPerk(player, "Shin")) throw new Error("Bạn chưa sở hữu Shin (GM cấp qua `-unlockskilltree @bạn Shin` nếu thực sự có sở hữu).");
    if (player.shinMangUsedThisTurn) throw new Error("Đã dùng Shin/Mang trong turn này rồi — chỉ 1 lần/turn.");
    if (player.currentSanity <= -10) throw new Error(`Không thể hi sinh để dùng Shin/Mang khi Sanity hiện tại ≤ -10 (hiện tại: ${player.currentSanity}).`);
    player.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, player.currentSanity - 25);
    player.shinMangActive = true;
    player.shinMangUsedThisTurn = true;
    player.shinMangRounds = (player.shinMangRounds ?? 0) + 1;
    checkStaggerPanic(player);
    await saveEncounter(channelId, encounter);
    result =
      `🌑 **Shin/Mang kích hoạt!** -25 Sanity (còn ${player.currentSanity}) → Shin: -0,2x mọi Res bản thân. ` +
      `Mang: +${player.shinMangRounds * 10}% Dmg M1+skill turn này (vòng ${player.shinMangRounds}), gây True Dmg.`;
  });
  return result;
}

/** performManifestEgo — logic CHUNG cho -encounter manifestego VÀ dropdown hành động. */
async function performManifestEgo(channelId, userId) {
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    const player = encounter.players[userId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này.");
    if ((player.emotionLevel ?? 0) < 1) throw new Error("Cần đang ở Emotion Level ≥1 mới kích hoạt được Manifest E.G.O.");
    if (!player.manifestedEGO && (player.manifestedEGOCooldownLeft ?? 0) > 0) {
      throw new Error(`Đang trong CD Manifest E.G.O — còn ${player.manifestedEGOCooldownLeft} turn.`);
    }
    player.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, player.currentSanity - 30);
    player.manifestedEGO = true;
    player.manifestedEGOTurnsLeft = player.emotionLevel * 3;
    player.manifestedEGOCooldownLeft = 0;
    checkStaggerPanic(player);
    let healNote = "";
    if (!player.firstManifestEGOUsed && hasPerk(player, "Comeback Time")) {
      const healAmt = Math.round(player.maxHp * 0.25 * 100) / 100;
      player.currentHp = Math.min(player.maxHp, player.currentHp + healAmt);
      healNote = ` 🩹+${healAmt} HP (Comeback Time — lần đầu Manifest E.G.O)`;
    }
    player.firstManifestEGOUsed = true;
    await saveEncounter(channelId, encounter);
    result =
      `😈 **Manifest E.G.O!** -30 Sanity (còn ${player.currentSanity}) → Duration ${player.manifestedEGOTurnsLeft} turn ` +
      `(theo Emotion Level ${player.emotionLevel}) — +3 Dice Up, +30% Dmg M1+skill.${healNote}`;
  });
  return result;
}

/** performOvercharge — logic CHUNG cho -encounter overcharge VÀ dropdown hành động. */
async function performOvercharge(channelId, userId) {
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    const player = encounter.players[userId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này.");
    if (!hasPerk(player, "Overcharged Vessel")) throw new Error("Bạn chưa mở khóa perk Overcharged Vessel.");
    if (player.charge < 10) throw new Error(`Cần ≥10 Charge để kích hoạt (hiện tại: ${player.charge}).`);
    const tiers = Math.floor(player.charge / 10);
    player.overchargedDiceUpBonus = tiers;
    player.overchargedDmgBonusPct = tiers * 5;
    player.overchargedTurnsLeft = 3;
    player.charge = 0;
    await saveEncounter(channelId, encounter);
    result = `⚡ **Overcharged!** Tiêu ${tiers * 10} Charge → +${tiers} Dice Up, +${tiers * 5}% Dmg trong 3 turn.`;
  });
  return result;
}

/** performFollowUp — logic CHUNG cho -encounter followup VÀ dropdown hành động.
 *  Trả về { followupEmbed, hitEmbed } — caller tự gửi 2 embed này. */
async function performFollowUp(channelId, userId, userMention, targetStr) {
  const encounter = await getEncounter(channelId);
  if (!encounter) throw new Error("Channel này chưa có encounter nào.");
  const player = encounter.players[userId];
  if (!player) throw new Error("Bạn chưa tham gia encounter này.");
  const hasFollowUp = hasPerk(player, "Follow-Up");
  const hasPounce = hasPerk(player, "Pounce");
  if (!hasFollowUp && !hasPounce) throw new Error("Bạn chưa mở khóa perk Follow-Up hoặc Pounce.");
  if (player.staminaUsedThisTurn < 20) throw new Error(`Cần tiêu ≥20 Stamina qua đánh thường trong turn này trước (hiện tại: ${player.staminaUsedThisTurn}).`);
  if (player.followUpUsedThisTurn) throw new Error("Đã dùng Follow-Up/Pounce trong turn này rồi — chỉ 1 lần/turn.");
  const dmgStr = hasFollowUp ? `${r(10, 14)}B` : `${r(8, 30)}B`;
  const { embed: hitEmbed } = await doPlayerHit(channelId, userId, userMention, dmgStr, targetStr, {});
  // Đánh dấu đã dùng NGAY lúc declare (không đợi confirm) — chấp nhận sai số nhỏ
  // này (nếu GM reject thì vẫn coi như đã dùng) để tránh phải thêm field riêng
  // theo dõi pending cho 1 trường hợp hiếm.
  await withLock(encounterKey(channelId), async () => {
    const enc2 = await getEncounter(channelId);
    if (enc2?.players[userId]) {
      enc2.players[userId].followUpUsedThisTurn = true;
      await saveEncounter(channelId, enc2);
    }
  });
  const followupEmbed = {
    title: hasFollowUp ? "⚡ Follow-Up!" : "🐾 Pounce!",
    description: `Tung đòn theo sau: \`${dmgStr}\`${hasFollowUp ? " — kẻ địch rơi vào **[Airborne]** (tự narrate, không phải status hệ thống)" : ""}`,
    color: 0xf39c12,
  };
  return { followupEmbed, hitEmbed };
}

function buildEncounterActionPanel(channelId, combatant, playerId) {
  if (!combatant || !playerId) return [];
  const options = [
    new StringSelectMenuOptionBuilder().setLabel("⚔️ Đánh thường (M1)").setValue("attack"),
  ];
  for (const pageName of combatant.unlockedPagesSnapshot ?? []) {
    if (pageName) options.push(new StringSelectMenuOptionBuilder().setLabel(`📖 ${pageName}`).setValue(`hit:${pageName}`));
  }
  for (const pageName of combatant.unlockedEgoPagesSnapshot ?? []) {
    if (pageName) options.push(new StringSelectMenuOptionBuilder().setLabel(`✨ ${pageName} (E.G.O)`).setValue(`hit:${pageName}`));
  }
  options.push(
    new StringSelectMenuOptionBuilder().setLabel("🛡️ Guard (-10 Sta, giảm 90% dmg)").setValue("guard"),
    new StringSelectMenuOptionBuilder().setLabel("💨 Evade (-20 Sta, né 100%)").setValue("evade"),
    new StringSelectMenuOptionBuilder().setLabel("🗡️ Parry (0 Sta, roll d20)").setValue("parry"),
  );
  if (hasPerk(combatant, "Shin")) {
    options.push(new StringSelectMenuOptionBuilder().setLabel("🌑 Shin/Mang (-25 Sanity)").setValue("shinmang"));
  }
  if ((combatant.emotionLevel ?? 0) >= 1) {
    options.push(new StringSelectMenuOptionBuilder().setLabel("😈 Manifest E.G.O (-30 Sanity)").setValue("manifestego"));
  }
  if (hasPerk(combatant, "Overcharged Vessel") && combatant.charge >= 10) {
    options.push(new StringSelectMenuOptionBuilder().setLabel(`⚡ Overcharged Vessel (tiêu ${combatant.charge} Charge)`).setValue("overcharge"));
  }
  if ((hasPerk(combatant, "Follow-Up") || hasPerk(combatant, "Pounce")) && combatant.staminaUsedThisTurn >= 20 && !combatant.followUpUsedThisTurn) {
    options.push(new StringSelectMenuOptionBuilder().setLabel("⚡ Follow-Up/Pounce").setValue("followup"));
  }
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`encmenu:${channelId}:${playerId}`)
        .setPlaceholder("Chọn hành động...")
        .addOptions(...options.slice(0, 25)), // Discord cap 25 — slice phòng hờ nếu equip đủ 10 page + nhiều buff cùng lúc
    ),
  ];
}

/** parseSkillCooldownTurns — đọc field cd của skill ("2 Turn", "1 Turn sau khi...",
 *  "—", "???", text mô tả riêng) → số turn cooldown. Chỉ parse được dạng "<N> Turn"
 *  ở đầu chuỗi — các dạng đặc biệt (text, "—", "???") trả về 0 (không track tự động
 *  được, không chặn gì cả — GM tự nhớ luật riêng cho skill đó nếu cần).
 */
function parseSkillCooldownTurns(cdStr) {
  const m = (cdStr ?? "").match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * resolveSkillVerification — xử lý 2 cách GM verify dmgStr người chơi tự gõ:
 *   1. skill: <tên skill> — bot TỰ ROLL skill đó NGAY (dùng buildSkillRollResult có
 *      sẵn, CHẠY THẬT calcMathCore/RNG, không phải tham chiếu tĩnh) → dice value THẬT
 *      không thể gian lận, + tự tính Emotion Coin delta luôn (tái dùng side-channel
 *      startEmotionTracking đã có sẵn cho -skill thường) + enforce/set cooldown.
 *      HẠN CHẾ: skill có promptArg (cần input riêng, VD: Thrust cần Light hiện tại)
 *      CHƯA hỗ trợ qua đường này — phải dùng -skill riêng rồi dán ref: thay vào đó,
 *      vì promptArg cần GM/player tự nhập số bổ sung không có trong attack/hit.
 *   2. ref: <message link hoặc ID> — fetch lại message ĐÃ roll trước đó (qua -skill
 *      riêng), hiện snippet + link nhảy tới cho GM tự xem, KHÔNG tự verify được gì
 *      (chỉ là tiện cho GM, không suy ra được Emotion Coin/cooldown từ đây).
 * Cả 2 đều OPTIONAL và ĐỘC LẬP — có thể dùng 1, cả 2, hoặc không cái nào (lúc đó GM
 * chỉ dựa vào dmgStr suông, như trước).
 * @returns { skillRollEmbed, skillKey, cooldownTurns, emotionDelta, refSnippet, refLink }
 * @throws Error nếu skill không tìm thấy/đang cooldown/cần promptArg, hoặc ref: sai định dạng/không fetch được
 */
async function resolveSkillVerification(channelId, attacker, skillNameRaw, refRaw) {
  let skillRollEmbed = null, skillKey = null, cooldownTurns = 0, emotionDelta = 0;
  let refSnippet = null, refLink = null;

  if (skillNameRaw && skillNameRaw.trim()) {
    const skill = findSkill(skillNameRaw.trim());
    if (!skill) throw new Error(`Không tìm thấy skill "${skillNameRaw}" — dùng \`-skill list\` để xem danh sách.`);
    if (skill.promptArg) throw new Error(`Skill "${skill.name}" cần input đặc biệt (VD: Light hiện tại) — chưa roll trực tiếp qua encounter được. Dùng \`-skill ${skillNameRaw}\` riêng rồi dán link message đó vào ref: thay vào đó.`);
    skillKey = skillNameRaw.trim().toLowerCase();
    const existingCd = attacker.skillCooldowns?.[skillKey] ?? 0;
    if (existingCd > 0) throw new Error(`Skill "${skill.name}" đang cooldown — còn ${existingCd} turn nữa.`);
    const rollResult = buildSkillRollResult({ skill, rollCount: 1 });
    if (rollResult.error) throw new Error(rollResult.error);
    skillRollEmbed = rollResult.embed;
    emotionDelta = rollResult.totalEmotionDelta ?? 0;
    cooldownTurns = parseSkillCooldownTurns(skill.cd);
  }

  if (refRaw && refRaw.trim()) {
    const idMatch = refRaw.trim().match(/(\d{15,20})\s*$/); // lấy ID số ở CUỐI chuỗi — khớp cả link đầy đủ và ID thô
    if (!idMatch) throw new Error(`ref: không hợp lệ — cần message ID hoặc link Discord (VD: dán link "Copy Message Link" của message roll skill).`);
    try {
      const channel = await client.channels.fetch(channelId);
      const fetchedMsg = await channel.messages.fetch(idMatch[1]);
      refLink = fetchedMsg.url ?? `https://discord.com/channels/@me/${channelId}/${idMatch[1]}`;
      const embedDesc = fetchedMsg.embeds?.[0]?.description;
      refSnippet = (embedDesc ?? fetchedMsg.content ?? "(không có nội dung text)").slice(0, 300);
    } catch {
      throw new Error(`Không tìm được message ref: "${refRaw}" — kiểm tra lại link/ID (phải là message trong CHANNEL này).`);
    }
  }

  return { skillRollEmbed, skillKey, cooldownTurns, emotionDelta, refSnippet, refLink };
}

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
  if (!dmgStr || !dmgStr.trim()) throw new Error("Cần nhập công thức dmg (VD: `50x2B+2Sinking`).");
  const { skill: skillNameRaw, ref: refRaw, coin: manualCoinRaw } = verifyOpts;
  const manualCoin = parseInt(manualCoinRaw ?? "0", 10) || 0;
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
    const player = encounter.players[playerId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này — dùng `-encounter join hp: <số>` trước.");
    if (player.staggered) throw new Error("Bạn đang bị Stagger — không thể hành động turn này.");
    if ((encounter.pendingActions ?? []).length >= ENCOUNTER_PENDING_MAX) throw new Error(`Đã có quá nhiều action chờ xác nhận (tối đa ${ENCOUNTER_PENDING_MAX}) — chờ GM xử lý trước.`);

    // skill:/ref: — xem comment đầy đủ ở resolveSkillVerification. Gọi TRƯỚC khi
    // build preview vì có thể throw (skill không tồn tại/đang cooldown) — fail sớm,
    // tránh tính toán dư.
    const verify = await resolveSkillVerification(channelId, player, skillNameRaw, refRaw);

    const targets = resolveTargets(encounter, targetStr, "enemy_or_player");
    // QUAN TRỌNG: Poise/Charge là "trên bản thân" → lấy từ PLAYER (người tấn công),
    // dùng CHUNG cho mọi target trong AOE (vẫn là 1 người tấn công, 1 lượng Poise).
    // Sinking/Rupture/Burn/Bleed/Tremor là "trên người địch HOẶC player khác (PvP)"
    // → lấy RIÊNG cho từng target — tính calcMathCore riêng từng target.
    const previews = targets.map(t => {
      const perkCtx = computeAttackerPerkContext(player, t.combatant, dmgStr, { isM1: true });
      const defReductionPct = computeDefenderDmgReduction(t.combatant);
      // Mang (Shin/Mang, đang active): True Dmg — Res target dưới 1x bị ép về 1x;
      // +10%/vòng Dmg M1+skill turn này.
      const mangBonusPct = player.shinMangActive ? player.shinMangRounds * 10 : 0;
      const calcOpts = {
        dmgStr: perkCtx.dmgStrRewritten,
        resStr: player.shinMangActive ? trueDmgResStr(t.combatant) : combatantResStr(t.combatant),
        bonusPct: perkCtx.bonusPct + mangBonusPct, critMul: perkCtx.critMul,
        // Sanity dice bonus ("+1 Sanity = +1% dice value, -1 Sanity = -1%") LUÔN tự
        // áp dụng từ Sanity HIỆN TẠI của người tấn công — KHÔNG phải tham số tự gõ
        // tay (trước đây M1 hoàn toàn THIẾU dòng này, /hit thì có nhưng phải tự gõ
        // — cả 2 đều sai, vì luật nói đây là cơ chế MẶC ĐỊNH không cần khai báo).
        sanityBonusPct: player.currentSanity,
        critDiv: perkCtx.critDivOverride ?? undefined,
        poiseInit: player.poise, chargeInit: player.charge,
        sinkingInit: t.combatant.sinking, ruptureInit: t.combatant.rupture,
        burnInit: t.combatant.burn, bleedInit: t.combatant.bleed, tremorInit: t.combatant.tremor,
        sanityInit: t.combatant.currentSanity,
      };
      const preview = calcMathCore(calcOpts);
      // Defender reduction (Smoldering Resolve) áp NGAY ở preview để hiển thị đúng
      // số dự kiến — KHÔNG sửa preview.totalDmg gốc (giữ nguyên cho breakdown), chỉ
      // tính finalDmgAfterReduction riêng để show + dùng lại lúc confirm.
      const finalDmgAfterReduction = preview.totalDmg * (1 - defReductionPct / 100);
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill };
    });
    const hitCount = previews[0].preview.dmgValues.length;
    const staminaCost = WEAPON_STAMINA_COST[player.weaponWeight] * hitCount;
    if (player.currentStamina < staminaCost) {
      throw new Error(`Không đủ Stamina — cần ${staminaCost} (${hitCount} hit × ${WEAPON_STAMINA_COST[player.weaponWeight]}/hit vũ khí ${player.weaponWeight}), còn ${player.currentStamina}.`);
    }

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "attack",
      attackerId: playerId, attackerType: "player",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: p.target.type, calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill })),
      dmgStr, staminaCost, isM1: true,
      // Lưu lại kết quả verify — encconfirmall áp dụng emotionDelta + set cooldown
      // THẬT lúc confirm (không phải lúc declare — khớp nguyên tắc "chưa gì là thật
      // cho tới khi GM xác nhận"). refLink/refSnippet/skillRollEmbed chỉ để HIỂN THỊ.
      // emotionDelta = TỔNG của delta tự roll skill (Max/Min dice) + manualCoin (GM/
      // player tự khai từ Clash/giết địch/đồng đội chết — bot không tự detect được).
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
    });
    await saveEncounter(channelId, encounter);

    const targetLines = previews.map(p => {
      let line = `> → ${p.target.label}: dự kiến **${p.finalDmgAfterReduction.toFixed(3)}** dmg`;
      if (p.defReductionPct > 0) line += ` *(đã giảm ${p.defReductionPct}% từ perk Smoldering Resolve, gốc ${p.preview.totalDmg.toFixed(3)})*`;
      if (p.instantKill) line += ` ☠️ **KẾT LIỄU NGAY** (Claim Their Heart — Stagger + dưới 15% HP)`;
      return line;
    }).join("\n");
    let verifyNote = "";
    if (verify.skillKey) verifyNote += `\n> 🎲 Đã tự roll skill **${verify.skillKey}** kèm theo (xem embed dưới) — Emotion Coin ${verify.emotionDelta >= 0 ? "+" : ""}${verify.emotionDelta} (tự động), CD ${verify.cooldownTurns} turn nếu confirm.`;
    if (manualCoin) verifyNote += `\n> 🪙 Coin tự khai (Clash/kill/...): ${manualCoin >= 0 ? "+" : ""}${manualCoin}`;
    if (verify.refLink) verifyNote += `\n> 🔗 Tham chiếu: ${verify.refLink}\n> > ${verify.refSnippet}`;
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
  const { resStr = "", drStr = "", bonusPct = 0, sanityBonusPct = 0, critMul: manualCritMul, diceMul = 1, critDiv = 0, skill: skillNameRaw, ref: refRaw, coin: manualCoinRaw } = extra;
  const manualCoin = parseInt(manualCoinRaw ?? "0", 10) || 0;
  let result;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
    const player = encounter.players[playerId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này — dùng `-encounter join hp: <số>` trước.");
    if ((encounter.pendingActions ?? []).length >= ENCOUNTER_PENDING_MAX) throw new Error(`Đã có quá nhiều action chờ xác nhận (tối đa ${ENCOUNTER_PENDING_MAX}) — chờ GM xử lý trước.`);

    const verify = await resolveSkillVerification(channelId, player, skillNameRaw, refRaw);

    const targets = resolveTargets(encounter, targetStr, "enemy_or_player");
    const previews = targets.map(t => {
      const perkCtx = computeAttackerPerkContext(player, t.combatant, dmgStr, { isM1: false });
      const defReductionPct = computeDefenderDmgReduction(t.combatant);
      const mangBonusPct = player.shinMangActive ? player.shinMangRounds * 10 : 0;
      const calcOpts = {
        dmgStr: perkCtx.dmgStrRewritten,
        resStr: resStr || (player.shinMangActive ? trueDmgResStr(t.combatant) : combatantResStr(t.combatant)), drStr,
        bonusPct: bonusPct + perkCtx.bonusPct + mangBonusPct,
        // Tự động cộng Sanity HIỆN TẠI của người dùng Page vào dice bonus (xem
        // comment đầy đủ ở doPlayerAttack) — sanityBonusPct (tham số tự gõ tay nếu
        // có) CỘNG THÊM vào, không thay thế, để vẫn linh hoạt cho trường hợp đặc biệt.
        sanityBonusPct: player.currentSanity + sanityBonusPct,
        // critMul: ưu tiên giá trị NGƯỜI DÙNG GÕ TAY (critmul: ...) nếu có — còn
        // không thì lấy từ perk context (giờ ĐÃ đúng default 1.3x, xem comment đầy
        // đủ ở computeAttackerPerkContext — trước đây so sánh "!== 1" để biết "có
        // perk đổi không", giờ default đã là 1.3 nên cách so sánh đó SAI, phải check
        // trực tiếp xem người dùng có gõ critmul: hay không).
        critMul: manualCritMul ?? perkCtx.critMul, diceMul,
        critDiv: perkCtx.critDivOverride ?? critDiv,
        poiseInit: player.poise, chargeInit: player.charge,
        sinkingInit: t.combatant.sinking, ruptureInit: t.combatant.rupture,
        burnInit: t.combatant.burn, bleedInit: t.combatant.bleed, tremorInit: t.combatant.tremor,
        sanityInit: t.combatant.currentSanity,
      };
      const preview = calcMathCore(calcOpts);
      const finalDmgAfterReduction = preview.totalDmg * (1 - defReductionPct / 100);
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill };
    });

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "hit",
      attackerId: playerId, attackerType: "player",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: p.target.type, calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill })),
      dmgStr,
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
    });
    await saveEncounter(channelId, encounter);

    const targetLines = previews.map(p => {
      let line = `> → ${p.target.label}: dự kiến **${p.finalDmgAfterReduction.toFixed(3)}** dmg`;
      if (p.defReductionPct > 0) line += ` *(đã giảm ${p.defReductionPct}% từ perk Smoldering Resolve, gốc ${p.preview.totalDmg.toFixed(3)})*`;
      if (p.instantKill) line += ` ☠️ **KẾT LIỄU NGAY** (Claim Their Heart — Stagger + dưới 15% HP)`;
      return line;
    }).join("\n");
    let verifyNote = "";
    if (verify.skillKey) verifyNote += `\n> 🎲 Đã tự roll skill **${verify.skillKey}** kèm theo (xem embed dưới) — Emotion Coin ${verify.emotionDelta >= 0 ? "+" : ""}${verify.emotionDelta} (tự động), CD ${verify.cooldownTurns} turn nếu confirm.`;
    if (manualCoin) verifyNote += `\n> 🪙 Coin tự khai (Clash/kill/...): ${manualCoin >= 0 ? "+" : ""}${manualCoin}`;
    if (verify.refLink) verifyNote += `\n> 🔗 Tham chiếu: ${verify.refLink}\n> > ${verify.refSnippet}`;
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
  const { skill: skillNameRaw, ref: refRaw, coin: manualCoinRaw } = verifyOpts;
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
    if ((encounter.pendingActions ?? []).length >= ENCOUNTER_PENDING_MAX) throw new Error(`Đã có quá nhiều action chờ xác nhận (tối đa ${ENCOUNTER_PENDING_MAX}) — xử lý trước.`);

    const verify = await resolveSkillVerification(channelId, enemy, skillNameRaw, refRaw);

    const targets = resolveTargets(encounter, targetStr, "player");
    // QUAN TRỌNG: chiều này ENEMY là người tấn công → Poise/Charge lấy từ ENEMY.
    // TARGET (player) là người bị tấn công → 5 status kia lấy từ TỪNG TARGET riêng.
    const previews = targets.map(t => {
      const perkCtx = computeAttackerPerkContext(enemy, t.combatant, dmgStr, { isM1: false });
      const defReductionPct = computeDefenderDmgReduction(t.combatant);
      const calcOpts = {
        dmgStr: perkCtx.dmgStrRewritten, resStr: combatantResStr(t.combatant),
        bonusPct: perkCtx.bonusPct, critMul: perkCtx.critMul, critDiv: perkCtx.critDivOverride ?? undefined,
        sanityBonusPct: enemy.currentSanity,
        poiseInit: enemy.poise, chargeInit: enemy.charge,
        sinkingInit: t.combatant.sinking, ruptureInit: t.combatant.rupture,
        burnInit: t.combatant.burn, bleedInit: t.combatant.bleed, tremorInit: t.combatant.tremor,
        sanityInit: t.combatant.currentSanity,
      };
      const preview = calcMathCore(calcOpts);
      const finalDmgAfterReduction = preview.totalDmg * (1 - defReductionPct / 100);
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill };
    });

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "enemyattack",
      attackerId: ekey, attackerType: "enemy",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: "player", calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill })),
      dmgStr,
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
    });
    await saveEncounter(channelId, encounter);

    const targetLines = previews.map(p => {
      let line = `> → ${p.target.label}: dự kiến **${p.finalDmgAfterReduction.toFixed(3)}** dmg`;
      if (p.defReductionPct > 0) line += ` *(đã giảm ${p.defReductionPct}% từ perk Smoldering Resolve, gốc ${p.preview.totalDmg.toFixed(3)})*`;
      if (p.instantKill) line += ` ☠️ **KẾT LIỄU NGAY** (Claim Their Heart — Stagger + dưới 15% HP)`;
      return line;
    }).join("\n");
    let verifyNote = "";
    if (verify.skillKey) verifyNote += `\n> 🎲 Đã tự roll skill **${verify.skillKey}** kèm theo (xem embed dưới) — Emotion Coin ${verify.emotionDelta >= 0 ? "+" : ""}${verify.emotionDelta} (tự động), CD ${verify.cooldownTurns} turn nếu confirm.`;
    if (manualCoin) verifyNote += `\n> 🪙 Coin tự khai (Clash/kill/...): ${manualCoin >= 0 ? "+" : ""}${manualCoin}`;
    if (verify.refLink) verifyNote += `\n> 🔗 Tham chiếu: ${verify.refLink}\n> > ${verify.refSnippet}`;
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
function buildEncounterBoardEmbed(encounter) {
  const blocks = [];
  if ((encounter.turnOrder ?? []).length > 0) {
    blocks.push(`🎲 **Thứ tự Turn**\n${buildTurnOrderText(encounter)}`);
  }
  for (const ekey of Object.keys(encounter.enemies)) {
    blocks.push(formatCombatantBlock(encounter.enemies[ekey], `⚔️ ${encounter.enemies[ekey].name} (${ekey})`));
  }
  for (const pid of Object.keys(encounter.players)) {
    blocks.push(formatCombatantBlock(encounter.players[pid], `<@${pid}>`));
  }
  const pending = encounter.pendingActions ?? [];
  if (pending.length > 0) {
    blocks.push(`⏳ **${pending.length} action đang chờ GM xác nhận** — dùng \`-encounter pending\` để xem chi tiết.`);
  }
  const allDead = Object.keys(encounter.enemies).length > 0 && Object.values(encounter.enemies).every(e => e.currentHp <= 0);
  return {
    title: `Encounter: ${encounter.name}`,
    description: blocks.join("\n\n") || "*(chưa có enemy/player nào)*",
    color: allDead ? 0x555555 : 0xe74c3c,
    footer: { text: "-encounter attack/hit/enemyattack/pending/confirmall/endturn — xem -encounter help để biết hết lệnh" },
  };
}

/** buildPendingListText — danh sách đầy đủ pending action cho `-encounter pending`. */
function buildPendingListText(encounter) {
  const pending = encounter.pendingActions ?? [];
  if (pending.length === 0) return "✅ Không có action nào đang chờ.";
  return pending.map((p, i) => {
    const attackerLabel = p.attackerType === "enemy" ? `**${encounter.enemies[p.attackerId]?.name ?? p.attackerId}**` : `<@${p.attackerId}>`;
    const targetLines = p.targets.map(t => {
      const label = t.targetType === "enemy" ? `**${encounter.enemies[t.targetId]?.name ?? t.targetId}**` : `<@${t.targetId}>`;
      return `${label} (${t.preview.totalDmg.toFixed(3)} dmg)`;
    }).join(", ");
    let verifyNote = "";
    if (p.skillKey) verifyNote += ` | 🎲 đã roll skill **${p.skillKey}** (xem embed lúc declare)`;
    if (p.refLink) verifyNote += ` | 🔗 [tham chiếu](${p.refLink})`;
    return `**#${i + 1}** [${p.kind}] ${attackerLabel} → ${targetLines}: \`${p.dmgStr}\`${verifyNote}`;
  }).join("\n");
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

/** isEgoSkill — check skill.tags có chứa "EGO"/"E.G.O" không (case-insensitive,
 *  bỏ qua dấu chấm/khoảng trắng) — dùng để phân biệt Page thường vs E.G.O Page lúc
 *  equip (5 slot riêng, không chung với 5 Page thường — đúng luật "E.G.O Page sẽ
 *  không tính slot chung với 5 Page thường"). */
function isEgoSkill(skill) {
  return /e\.?g\.?o/i.test((skill.tags ?? "").replace(/<:[^>]+>/g, ""));
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
    totalEmotionDelta: allTracked.reduce((sum, t) => sum + t.delta, 0),
    firstDiceValue: allTracked[0]?.result ?? null,
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

  // ── -unlockskilltree / -ununlockskilltree ──────────────────────────────────
  // Lưu trên PROFILE (vĩnh viễn, theo slot đang active), KHÔNG còn lưu tạm trong
  // encounter (mất khi encounter kết thúc) như bản unlockperk cũ — vì đây là Point
  // thật đã tốn trong game, phải tồn tại qua mọi trận đấu, giống Grade/EXP. Admin
  // only — giống -setplayer, vì đây là tài nguyên cần GM duyệt, không phải thứ
  // player tự cấp cho mình.
  if (message.content.startsWith("-unlockskilltree") || message.content.startsWith("-ununlockskilltree")) {
    if (!ADMIN_IDS.has(message.author.id)) {
      message.reply("❌ Bạn không có quyền dùng lệnh này.");
      return;
    }
    const isUnlock = message.content.startsWith("-unlockskilltree");
    const targetUsers = [...message.mentions.users.values()];
    const rawInput = message.content.replace(/^-(un)?unlockskilltree/, "").replace(/<@!?\d+>/g, "").trim();
    const perkName = rawInput.replace(/^text:\s*/i, "").trim();
    if (targetUsers.length === 0 || !perkName) {
      message.reply(
        `❌ Cú pháp: \`-${isUnlock ? "" : "un"}unlockskilltree @user <tên perk>\`\n` +
        "> VD: `-unlockskilltree @user Ein Sof`"
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
          data.unlockedSkillTree.push(perkName);
          await savePlayerData(user.id, data, slot);
          results.push(`✅ ${user.username}: mở khóa "${perkName}".`);
        } else {
          const idx = data.unlockedSkillTree.indexOf(perkName);
          if (idx === -1) { results.push(`⚠️ ${user.username}: chưa có "${perkName}".`); continue; }
          data.unlockedSkillTree.splice(idx, 1);
          await savePlayerData(user.id, data, slot);
          results.push(`✅ ${user.username}: đã xoá "${perkName}".`);
        }
      }
      message.reply(results.join("\n"));
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
    const rawInput = message.content.replace(isEgo ? "-equipegopage" : "-equippage", "").trim();
    const m = rawInput.match(/^([1-5])\s+(.+)$/);
    if (!m) {
      message.reply(`⚠️ Cú pháp: \`-${isEgo ? "equipegopage" : "equippage"} <slot 1-5> <tên skill>\`\n> VD: \`-${isEgo ? "equipegopage" : "equippage"} 1 sky kick\``);
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
      const { data, slot } = await getPlayerDataWithSlot(message.author.id);
      const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
      data[listKey] = data[listKey] ?? [null, null, null, null, null];
      data[listKey][slotNum - 1] = skill.name;
      await savePlayerData(message.author.id, data, slot);
      message.reply(`✅ Đã equip **${skill.name}** vào ${isEgo ? "E.G.O " : ""}slot #${slotNum}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequippage") || message.content.startsWith("-unequipegopage")) {
    const isEgo = message.content.startsWith("-unequipegopage");
    const rawInput = message.content.replace(isEgo ? "-unequipegopage" : "-unequippage", "").trim();
    const slotNum = parseInt(rawInput, 10);
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 5) {
      message.reply(`⚠️ Cú pháp: \`-${isEgo ? "unequipegopage" : "unequippage"} <slot 1-5>\``);
      return;
    }
    try {
      const { data, slot } = await getPlayerDataWithSlot(message.author.id);
      const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
      data[listKey] = data[listKey] ?? [null, null, null, null, null];
      const removed = data[listKey][slotNum - 1];
      data[listKey][slotNum - 1] = null;
      await savePlayerData(message.author.id, data, slot);
      message.reply(removed ? `✅ Đã gỡ **${removed}** khỏi ${isEgo ? "E.G.O " : ""}slot #${slotNum}.` : `⚠️ ${isEgo ? "E.G.O " : ""}Slot #${slotNum} đang trống.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -pages: xem loadout hiện tại (5 Page + 5 E.G.O Page) ───────────────────
  if (message.content.startsWith("-pages")) {
    try {
      const { data } = await getPlayerDataWithSlot(message.author.id);
      const pages = data.equippedPages ?? [null, null, null, null, null];
      const egoPages = data.equippedEgoPages ?? [null, null, null, null, null];
      const fmt = (list) => list.map((p, i) => `**#${i + 1}** ${p ?? "*(trống)*"}`).join("\n");
      message.reply({
        embeds: [{
          title: "📖 Loadout Page",
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
    const rawInput = message.content.replace("-equipweapon", "").trim();
    if (!rawInput) { message.reply("⚠️ Cú pháp: `-equipweapon <tên vũ khí>` (VD: `-equipweapon durandal`)"); return; }
    try {
      const weapon = findWeaponAnywhere(rawInput);
      if (!weapon) throw new Error(`Không tìm thấy vũ khí "${rawInput}" trong weapon.js hoặc skills.js.`);
      const { data, slot } = await getPlayerDataWithSlot(message.author.id);
      data.equippedWeapon = weapon.name;
      await savePlayerData(message.author.id, data, slot);
      message.reply(`✅ Đã equip vũ khí **${weapon.name}** (${weapon.weight}/${weapon.type}, Base Dmg ${weapon.baseDamage}).`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipweapon")) {
    try {
      const { data, slot } = await getPlayerDataWithSlot(message.author.id);
      const removed = data.equippedWeapon;
      data.equippedWeapon = null;
      await savePlayerData(message.author.id, data, slot);
      message.reply(removed ? `✅ Đã gỡ vũ khí **${removed}**.` : "⚠️ Chưa equip vũ khí nào.");
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-equipoutfit")) {
    const rawInput = message.content.replace("-equipoutfit", "").trim();
    if (!rawInput) { message.reply("⚠️ Cú pháp: `-equipoutfit <tên outfit>` (VD: `-equipoutfit black suit`)"); return; }
    try {
      const outfit = findOutfit(rawInput);
      if (!outfit) throw new Error(`Không tìm thấy outfit "${rawInput}" trong outfit.js.`);
      const { data, slot } = await getPlayerDataWithSlot(message.author.id);
      data.equippedOutfit = outfit.name;
      await savePlayerData(message.author.id, data, slot);
      const r = outfit.resistance;
      message.reply(`✅ Đã equip outfit **${outfit.name}** (Res: ${r.B}xB ${r.P}xP ${r.S}xS${outfit.speedRange ? `, Speed ${outfit.speedRange.min}~${outfit.speedRange.max}` : ""}).`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipoutfit")) {
    try {
      const { data, slot } = await getPlayerDataWithSlot(message.author.id);
      const removed = data.equippedOutfit;
      data.equippedOutfit = null;
      await savePlayerData(message.author.id, data, slot);
      message.reply(removed ? `✅ Đã gỡ outfit **${removed}**.` : "⚠️ Chưa equip outfit nào.");
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-equipaccessory")) {
    const rawInput = message.content.replace("-equipaccessory", "").trim();
    const m = rawInput.match(/^([1-3])\s+(.+)$/);
    if (!m) { message.reply("⚠️ Cú pháp: `-equipaccessory <slot 1-3> <tên accessory>` (VD: `-equipaccessory 1 perfect cube`)"); return; }
    const slotNum = parseInt(m[1], 10);
    try {
      const accessory = findAccessory(m[2].trim());
      if (!accessory) throw new Error(`Không tìm thấy accessory "${m[2].trim()}" trong accessory.js.`);
      const { data, slot } = await getPlayerDataWithSlot(message.author.id);
      data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
      data.equippedAccessories[slotNum - 1] = accessory.name;
      await savePlayerData(message.author.id, data, slot);
      message.reply(`✅ Đã equip accessory **${accessory.name}** vào slot #${slotNum}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipaccessory")) {
    const rawInput = message.content.replace("-unequipaccessory", "").trim();
    const slotNum = parseInt(rawInput, 10);
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) { message.reply("⚠️ Cú pháp: `-unequipaccessory <slot 1-3>`"); return; }
    try {
      const { data, slot } = await getPlayerDataWithSlot(message.author.id);
      data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
      const removed = data.equippedAccessories[slotNum - 1];
      data.equippedAccessories[slotNum - 1] = null;
      await savePlayerData(message.author.id, data, slot);
      message.reply(removed ? `✅ Đã gỡ accessory **${removed}** khỏi slot #${slotNum}.` : `⚠️ Slot #${slotNum} đang trống.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -equipment: xem Weapon/Outfit/3 Accessory hiện tại ─────────────────────
  if (message.content.startsWith("-equipment")) {
    try {
      const { data } = await getPlayerDataWithSlot(message.author.id);
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
          title: "🎒 Trang bị hiện tại",
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
    const argStr = message.content.replace(/^-encounter/i, "").trim();
    const subMatch = argStr.match(/^(\S+)\s*/);
    const sub = (subMatch?.[1] ?? "").toLowerCase();
    const rest = subMatch ? argStr.slice(subMatch[0].length).trim() : "";

    if (sub === "start") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được tạo encounter."); return; }
      const kv = parseKeyValues(rest);
      const name = (kv["name"] ?? "").trim();
      if (!name || name.length > ENCOUNTER_NAME_MAX_LENGTH) {
        message.reply(`⚠️ Cú pháp: \`-encounter start name: <tên trận>\` (tối đa ${ENCOUNTER_NAME_MAX_LENGTH} ký tự). Thêm enemy sau bằng \`-encounter addenemy\`.`);
        return;
      }
      try {
        await withLock(encounterKey(message.channel.id), async () => {
          const existing = await getEncounter(message.channel.id);
          if (existing) throw new Error(`Channel này đang có encounter **${existing.name}** chạy — dùng \`-encounter end\` trước.`);
          const encounter = {
            name, enemies: {}, players: {},
            gmId: message.author.id, createdAt: Date.now(),
            pendingActions: [],
          };
          await saveEncounter(message.channel.id, encounter);
          await message.reply({
            content: `✅ Đã tạo encounter **${name}**. Dùng \`-encounter addenemy key: <key> name: <tên> hp: <số>\` để thêm enemy.`,
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
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
          if (encounter.players[key]) throw new Error(`Key "${key}" đang trùng với 1 player đã join — đổi key khác.`);
          const wasExisting = !!encounter.enemies[key];
          encounter.enemies[key] = createCombatant({
            name, maxHp: hp,
            maxStamina: Number.isFinite(stamina) && stamina > 0 ? stamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
            weaponWeight: weapon, resistance: res, speedRangeMin, speedRangeMax,
          });
          encounter.enemies[key].unlockedPerks = perksList;
          await saveEncounter(message.channel.id, encounter);
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

    if (sub === "join") {
      const kv = parseKeyValues(rest);
      const hp = parseInt(kv["hp"] ?? "", 10);
      const stamina = parseInt(kv["stamina"] ?? "", 10);
      if (!Number.isFinite(hp) || hp <= 0) {
        message.reply(
          "⚠️ Cú pháp: `-encounter join hp: <số>` (tùy chọn thêm `stamina:`/`light:`/`weapon: light|medium|heavy`/`res: 1.3xB 1.3xP 1.3xS`/`speedrange: <min>~<max>` — nếu đã `-equipweapon`/`-equipoutfit` thì KHÔNG cần gõ weapon:/res:/speedrange: nữa, tự lấy từ đó; gõ tay sẽ ĐÈ lên giá trị từ trang bị)"
        );
        return;
      }
      const light = parseInt(kv["light"] ?? "", 10);
      // Lấy profile TRƯỚC để biết Weapon/Outfit đã equip (nếu có) — làm GIÁ TRỊ MẶC
      // ĐỊNH cho weapon:/res:/speedrange: khi KHÔNG gõ tay tham số đó. Gõ tay vẫn
      // ĐÈ LÊN trang bị (linh hoạt cho trường hợp đặc biệt, không bắt buộc equip).
      const profileDataForDefaults = await getPlayerData(message.author.id);
      const equippedWeaponObj = profileDataForDefaults.equippedWeapon ? findWeaponAnywhere(profileDataForDefaults.equippedWeapon) : null;
      const equippedOutfitObj = profileDataForDefaults.equippedOutfit ? findOutfit(profileDataForDefaults.equippedOutfit) : null;
      const weapon = normalizeWeaponWeight(kv["weapon"] ?? equippedWeaponObj?.weight ?? "medium");
      const resRaw = kv["res"] ?? "";
      const res = equippedOutfitObj ? { ...equippedOutfitObj.resistance } : { B: 1, P: 1, S: 1 };
      for (const m of resRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi)) res[m[2].toUpperCase()] = parseFloat(m[1]);
      const speedRangeMatch = (kv["speedrange"] ?? "").match(/(\d+)\s*[~\-]\s*(\d+)/);
      const speedRangeMin = speedRangeMatch ? parseInt(speedRangeMatch[1], 10) : (equippedOutfitObj?.speedRange?.min ?? 3);
      const speedRangeMax = speedRangeMatch ? parseInt(speedRangeMatch[2], 10) : (equippedOutfitObj?.speedRange?.max ?? 6);
      try {
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
          const wasJoined = !!encounter.players[message.author.id];
          encounter.players[message.author.id] = createCombatant({
            name: message.author.username, maxHp: hp,
            maxStamina: Number.isFinite(stamina) && stamina > 0 ? stamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
            maxLight: Number.isFinite(light) && light > 0 ? light : ENCOUNTER_DEFAULT_MAX_LIGHT,
            weaponWeight: weapon, resistance: res, speedRangeMin, speedRangeMax,
          });
          // Copy Skill Tree đã mở khóa TỪ PROFILE (vĩnh viễn) vào combatant của
          // encounter này — snapshot lúc join, giống cách HP/Stamina/vũ khí cũng
          // được "chốt" lúc join (không tự đồng bộ real-time nếu admin unlock thêm
          // GIỮA lúc encounter đang chạy — phải join lại để cập nhật, y hệt nguyên
          // tắc đang áp dụng cho mọi field khác). Dùng LẠI profileDataForDefaults
          // đã fetch ở trên (tránh gọi Redis 2 lần + tránh race condition).
          const profileData = profileDataForDefaults;
          const joined = encounter.players[message.author.id];
          joined.unlockedPerks = [...(profileData.unlockedSkillTree ?? [])];
          // Snapshot 5 Page + 5 E.G.O Page đã equip trên profile — dùng để build
          // dropdown hành động (xem buildEncounterActionPanel) — CHỐT lúc join, y
          // hệt nguyên tắc đang áp dụng cho unlockedPerks/HP/Stamina/... (đổi loadout
          // giữa trận thì phải join lại để cập nhật).
          joined.unlockedPagesSnapshot = (profileData.equippedPages ?? []).filter(Boolean);
          joined.unlockedEgoPagesSnapshot = (profileData.equippedEgoPages ?? []).filter(Boolean);
          // Perk "đầu encounter" — áp dụng 1 LẦN ngay lúc join (KHÔNG áp lại nếu join
          // lại để cập nhật stat — chỉ áp khi THỰC SỰ là lần tham gia đầu, tránh free
          // refill Light/Poise/Sanity mỗi lần gõ lại join).
          const startNotes = [];
          if (!wasJoined) {
            if (hasPerk(joined, "Here We Go Again")) { joined.currentLight = Math.min(joined.maxLight, 3); startNotes.push("+3 Light (Here We Go Again)"); }
            if (hasPerk(joined, "Adrenaline Rush")) { joined.poise = Math.min(POISE_MAX, 10); startNotes.push("+10 Poise (Adrenaline Rush)"); }
            if (hasPerk(joined, "No Mind To Cure")) { joined.currentSanity = -25; startNotes.push("-25 Sanity (No Mind To Cure)"); }
          }
          await saveEncounter(message.channel.id, encounter);
          const equipNotes = [];
          if (equippedWeaponObj && !kv["weapon"]) equipNotes.push(`Vũ khí: ${equippedWeaponObj.name} (${equippedWeaponObj.weight})`);
          if (equippedOutfitObj && !kv["res"]) equipNotes.push(`Outfit: ${equippedOutfitObj.name} (Res ${res.B}xB ${res.P}xP ${res.S}xS)`);
          await message.reply({
            content: `✅ ${wasJoined ? "Đã cập nhật lại" : "Đã tham gia"} encounter **${encounter.name}** với ${hp} HP.` +
              (equipNotes.length > 0 ? `\n> 🎒 Tự lấy từ trang bị: ${equipNotes.join(", ")}` : "") +
              (joined.unlockedPerks.length > 0 ? ` (Perk từ profile: ${joined.unlockedPerks.join(", ")})` : "") +
              (startNotes.length > 0 ? `\n> 🆙 ${startNotes.join(", ")}` : ""),
            components: buildEncounterActionPanel(message.channel.id, joined, message.author.id),
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── rollspeed: roll Speed cho TẤT CẢ combatant, quyết định thứ tự turn (xem
    // determineTurnOrder — xử lý tie cùng phe/khác phe khác nhau theo update mới).
    if (sub === "rollspeed") {
      try {
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM (hoặc admin) mới roll thứ tự turn.");
          if (Object.keys(encounter.enemies).length + Object.keys(encounter.players).length < 1) throw new Error("Chưa có combatant nào để roll.");
          determineTurnOrder(encounter);
          await saveEncounter(message.channel.id, encounter);
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
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          resolved.combatant[sub] = Math.max(0, (resolved.combatant[sub] ?? 0) + amount);
          await saveEncounter(message.channel.id, encounter);
          message.reply(`✅ ${resolved.label}: ${sub === "haste" ? "Haste" : "Bind"} ${amount >= 0 ? "+" : ""}${amount} → còn ${resolved.combatant[sub]}.`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "status") {
      const encounter = await getEncounter(message.channel.id);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào. Dùng `-encounter start` để tạo."); return; }
      message.reply({ embeds: [buildEncounterBoardEmbed(encounter)], components: buildEncounterActionPanel(message.channel.id, encounter.players[message.author.id], message.author.id) });
      return;
    }

    if (sub === "pending") {
      const encounter = await getEncounter(message.channel.id);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      const pending = encounter.pendingActions ?? [];
      message.reply({
        embeds: [{
          title: `⏳ Pending Actions (${pending.length})`,
          description: buildPendingListText(encounter),
          color: 0xf39c12,
        }],
        components: pending.length > 0 ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`encconfirmall:${message.channel.id}`).setLabel("✅ Confirm tất cả").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`encrejectall:${message.channel.id}`).setLabel("❌ Reject tất cả").setStyle(ButtonStyle.Danger),
        )] : [],
      });
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
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const listKey = sub === "buff" ? "buffs" : "debuffs";
          resolved.combatant[listKey] = resolved.combatant[listKey] ?? [];
          resolved.combatant[listKey].push({ text, addedAt: Date.now() });
          await saveEncounter(message.channel.id, encounter);
          message.reply(`✅ Đã thêm ${sub === "buff" ? "🟢 buff" : "🔴 debuff"} cho ${resolved.label}: "${text}"`);
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
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const listKey = sub === "unbuff" ? "buffs" : "debuffs";
          const list = resolved.combatant[listKey] ?? [];
          if (index > list.length) throw new Error(`${resolved.label} chỉ có ${list.length} ${listKey === "buffs" ? "buff" : "debuff"} — không có #${index}.`);
          const removed = list.splice(index - 1, 1)[0];
          await saveEncounter(message.channel.id, encounter);
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
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, "");
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const list = resolved.combatant.injuries ?? [];
          if (index > list.length) throw new Error(`${resolved.label} chỉ có ${list.length} chấn thương — không có #${index}.`);
          const removed = list.splice(index - 1, 1)[0];
          if (removed?.startsWith("Choáng")) resolved.combatant.dazedStacks = Math.max(0, (resolved.combatant.dazedStacks ?? 0) - 1);
          await saveEncounter(message.channel.id, encounter);
          message.reply(`✅ Đã chữa khỏi chấn thương #${index} của ${resolved.label}: "${removed}"`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }


    if (sub === "end") {
      const encounter = await getEncounter(message.channel.id);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      if (!isAdmin && message.author.id !== encounter.gmId) { message.reply("⚠️ Chỉ GM tạo encounter này (hoặc admin khác) mới được kết thúc."); return; }
      await deleteEncounter(message.channel.id);
      message.reply(`✅ Đã kết thúc encounter **${encounter.name}**.`);
      return;
    }

    if (sub === "endturn") {
      try {
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM (hoặc admin) mới được kết thúc turn.");
          if ((encounter.pendingActions ?? []).length > 0) throw new Error(`Còn ${encounter.pendingActions.length} action chưa xử lý — dùng \`-encounter pending\` để confirm/reject hết trước khi qua turn.`);
          // Shrouded Power (Pride) — check TRƯỚC khi advanceCombatantTurn (vì Stagger
          // có thể tự hết NGAY trong lượt advance này) — bất kỳ enemy nào ĐANG Stagger
          // lúc turn kết thúc → player có perk này nhận +4 Poise.
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
          await saveEncounter(message.channel.id, encounter);
          await message.reply({
            content: `🔄 **Hết turn** — hồi ${ENCOUNTER_STAMINA_REGEN_PER_TURN} Stamina (trừ ai đang Stagger), đếm ngược Stagger/Panic.` +
              (shroudedNotes.length > 0 ? `\n> ${shroudedNotes.join(", ")}` : ""),
            embeds: [buildEncounterBoardEmbed(encounter)],
          });
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
        const { embed, skillRollEmbed } = await doPlayerHit(message.channel.id, message.author.id, message.author.toString(), dmgStr, targetStr, {
          resStr: kv["res"] ?? "", drStr: kv["dr"] ?? "", bonusPct, sanityBonusPct, critMul, diceMul, critDiv,
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"],
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
      if (!dmgStr.trim() || !targetStr.trim()) {
        message.reply(
          "⚠️ Cú pháp: `-encounter attack target: <key hoặc key1,key2 hoặc all> dmg: <công thức>` (M1 — tự trừ Stamina theo vũ khí của bạn).\n" +
          "> VD: `-encounter attack target: mo dmg: 20B`\n" +
          "> Tùy chọn `skill: <tên skill>` hoặc `ref: <link message>` để GM dễ verify."
        );
        return;
      }
      try {
        const { embed, skillRollEmbed } = await doPlayerAttack(message.channel.id, message.author.id, message.author.toString(), dmgStr, targetStr, {
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"],
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
        const { embed, skillRollEmbed } = await doEnemyAttack(message.channel.id, message.author.id, enemyKey, dmgStr, targetStr, {
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"],
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
        const { followupEmbed, hitEmbed } = await performFollowUp(message.channel.id, message.author.id, message.author.toString(), targetStr);
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
        const resultMsg = await performOvercharge(message.channel.id, message.author.id);
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
      try {
        const resultMsg = await performGuardEvade(message.channel.id, message.author.id, isAdmin, sub, enemyKeyRaw);
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
        const resultMsg = await performParry(message.channel.id, message.author.id, isAdmin, enemyKeyRaw);
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
        const resultMsg = await performShinMang(message.channel.id, message.author.id);
        message.reply(resultMsg);
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
        const resultMsg = await performManifestEgo(message.channel.id, message.author.id);
        message.reply(resultMsg);
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
        await withLock(encounterKey(message.channel.id), async () => {
          const encounter = await getEncounter(message.channel.id);
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
          // Chấn thương (Gãy tay/Gãy chân/Mất Chân) trừ thẳng vào Dice dùng để clash.
          const myPenalty = getParryClashPenalty(forResolved.combatant);
          const oppPenalty = getParryClashPenalty(targetResolved.combatant);
          const myEffectiveDice = myRoll.firstDiceValue - myPenalty;
          const oppEffectiveDice = oppRoll.firstDiceValue - oppPenalty;

          let resultText;
          if (myEffectiveDice > oppEffectiveDice) {
            forResolved.combatant.currentSanity = Math.min(ENCOUNTER_SANITY_MAX, forResolved.combatant.currentSanity + 10);
            applyEmotionDelta(forResolved.combatant, 2);
            targetResolved.combatant.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, targetResolved.combatant.currentSanity - 10);
            applyEmotionDelta(targetResolved.combatant, -1);
            checkStaggerPanic(forResolved.combatant); checkStaggerPanic(targetResolved.combatant);
            resultText = `🏆 ${forResolved.label} THẮNG Clash! (${myEffectiveDice} vs ${oppEffectiveDice}${myPenalty || oppPenalty ? `, gốc ${myRoll.firstDiceValue} vs ${oppRoll.firstDiceValue}, đã trừ chấn thương` : ""}) — +10 Sanity +2 Coin cho ${forResolved.label}, -10 Sanity -1 Coin cho ${targetResolved.label}.`;
          } else if (myEffectiveDice < oppEffectiveDice) {
            targetResolved.combatant.currentSanity = Math.min(ENCOUNTER_SANITY_MAX, targetResolved.combatant.currentSanity + 10);
            applyEmotionDelta(targetResolved.combatant, 2);
            forResolved.combatant.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, forResolved.combatant.currentSanity - 10);
            applyEmotionDelta(forResolved.combatant, -1);
            checkStaggerPanic(forResolved.combatant); checkStaggerPanic(targetResolved.combatant);
            resultText = `💔 ${forResolved.label} THUA Clash! (${myEffectiveDice} vs ${oppEffectiveDice}${myPenalty || oppPenalty ? `, gốc ${myRoll.firstDiceValue} vs ${oppRoll.firstDiceValue}, đã trừ chấn thương` : ""}) — +10 Sanity +2 Coin cho ${targetResolved.label}, -10 Sanity -1 Coin cho ${forResolved.label}.`;
          } else {
            applyEmotionDelta(forResolved.combatant, 1);
            applyEmotionDelta(targetResolved.combatant, 1);
            resultText = `⚖️ HUỀ Clash! (${myEffectiveDice} vs ${oppEffectiveDice}) — mỗi bên +1 Coin, Sanity không đổi.`;
          }
          await saveEncounter(message.channel.id, encounter);
          await message.reply({ embeds: [myRoll.embed, oppRoll.embed, { title: "⚔️ Kết quả Clash", description: resultText, color: 0x9b59b6 }] });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    message.reply(
      "⚠️ Lệnh không hợp lệ. Dùng:\n" +
      "> `-encounter start name: <tên trận>` (admin/GM)\n" +
      "> `-encounter addenemy key: <key> name: <tên> hp: <số>` (admin/GM)\n" +
      "> `-encounter join hp: <số>` (player tham gia — tự copy Skill Tree đã mở từ profile)\n" +
      "> `-encounter attack target: <key/all> dmg: <công thức> [skill: <tên>] [ref: <link>] [coin: <số>]` — M1, tự trừ Stamina\n" +
      "> `-encounter hit target: <key/all> dmg: <công thức> [skill:] [ref:] [coin:]` — Page/Skill\n" +
      "> `-encounter enemyattack key: <enemy> target: <@player/all> dmg: <công thức> [skill:] [ref:] [coin:]` (GM)\n" +
      "> `-encounter pending` — xem hàng chờ, confirm/reject tất cả\n" +
      "> `-encounter buff/debuff target: <key/me> text: <mô tả>` · `-encounter unbuff/undebuff target: <key/me> index: <số>`\n" +
      "> `-encounter endturn` (GM) — hồi Stamina, đếm ngược Stagger/Panic/cooldown\n" +
      "> `-encounter status` · `-encounter end` (GM)\n" +
      "> `-encounter rollspeed` (GM) — roll Speed quyết định thứ tự turn\n" +
      "> `-encounter guard/evade` — phòng thủ tự do (Guard -10 Sta giảm 90% dmg, Evade -20 Sta né 100%), dùng bao nhiêu lần cũng được\n" +
      "> `-encounter parry` — 0 Sta, roll d20, ăn/thua so với roll đối phương lúc confirm\n" +
      "> `-encounter clash target: <id> skill: <tên> oppskill: <tên>` — so Dice đầu, thắng/thua/huề ảnh hưởng Sanity+Emotion Coin\n" +
      "> `-encounter shinmang` — hi sinh 25 Sanity/turn (cần sở hữu Shin) — -0,2x Res bản thân, +Dmg M1+skill, True Dmg\n" +
      "> `-encounter manifestego` — -30 Sanity (cần Emotion Level ≥1) — Duration theo Level, +30% Dmg M1+skill\n" +
      "> `-encounter healinjury target: <key/id> index: <số>` (GM) — chữa khỏi 1 chấn thương\n" +
      "> `-encounter haste/bind target: <key/me> amount: <số>` — chỉnh tay (+1 Haste = +1 Speed, +1 Bind = -1 Speed)\n" +
      "> `-encounter followup target: <key>` — Follow-Up/Pounce (cần ≥20 Sta tiêu turn này, 1 lần/turn)\n" +
      "> `-encounter overcharge` — Overcharged Vessel (tiêu hết Charge ≥10 đổi Dice Up/Dmg 3 turn)\n" +
      "> Skill Tree (Ein Sof/Light Body/...) dùng lệnh riêng `-unlockskilltree @user <perk>` (admin, lưu vĩnh viễn trên profile)"
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
            const attacker = resolveCombatant(encounter, p.attackerId);
            if (!attacker) { resultLines.push(`⚠️ Bỏ qua 1 action — không tìm thấy attacker ${p.attackerId} (có thể đã rời encounter).`); continue; }

            // Stamina cost (chỉ attack mới có) — trừ 1 LẦN cho action này, KHÔNG
            // nhân theo số target (1 đòn M1 chỉ tốn Stamina 1 lần dù AOE).
            let staminaNote = "";
            if (p.staminaCost && attacker.type === "player") {
              attacker.combatant.currentStamina = Math.max(0, attacker.combatant.currentStamina - p.staminaCost);
              attacker.combatant.staminaUsedThisTurn += p.staminaCost;
              checkStaggerPanic(attacker.combatant);
              staminaNote = ` (-${p.staminaCost} Sta${attacker.combatant.staggered ? " 💫Stagger!" : ""})`;
            }

            const targetDmgLines = [];
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
              const guardReductionPct = hasPerk(target, "Fortified Resolve") ? 0.99 : 0.9;
              if (isM1Type) {
                // M1 NHIỀU HIT — cho phép TRỘN nhiều LOẠI phòng thủ khác nhau để chặn
                // các CỤM hit khác nhau trong CÙNG 1 đòn M1 (xác nhận trực tiếp từ GM:
                // "có thể guard/parry/evade theo tùy thích vào số hit" — KHÔNG bắt
                // buộc chỉ 1 loại cho cả đòn như code cũ). Thứ tự ưu tiên xử lý từng
                // CỤM hit kế tiếp: Evade (free, an toàn nhất) → Parry (free nhưng rủi
                // ro ăn full nếu hụt) → Guard (chắc chắn giảm % nhưng không free) —
                // mỗi loại tiêu thụ HẾT charge/roll đang có rồi mới chuyển loại kế,
                // cho tới khi hết hit cần chặn hoặc hết toàn bộ charge các loại.
                const instanceResults = t.preview.instanceResults ?? [];
                const totalHits = instanceResults.length || hitCount;
                const perHitMult = new Array(totalHits).fill(1);
                let hitIdx = 0;
                const noteParts = [];

                if ((target.evadeCharges ?? 0) > 0 && hitIdx < totalHits) {
                  const coverStart = hitIdx;
                  let used = 0;
                  while (target.evadeCharges > 0 && hitIdx < totalHits) {
                    target.evadeCharges -= 1; used += 1;
                    for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) perHitMult[hitIdx] = 0;
                  }
                  noteParts.push(`💨**Evade** (${used} charge — né hit ${coverStart + 1}-${hitIdx})`);
                }
                while ((target.parryRolls ?? []).length > 0 && hitIdx < totalHits) {
                  const defRoll = target.parryRolls.shift();
                  const atkRoll = 1 + Math.floor(Math.random() * 20);
                  const won = defRoll >= atkRoll;
                  const coverStart = hitIdx;
                  for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) {
                    if (won) perHitMult[hitIdx] = 0;
                  }
                  if (won) {
                    noteParts.push(`🗡️**Parry THÀNH CÔNG** (${defRoll} vs ${atkRoll} — né hit ${coverStart + 1}-${hitIdx})`);
                  } else {
                    // Mastered Breaths (Sloth, [15 Points]): base cost 30 thay vì 40.
                    // Gãy tay (chấn thương) vẫn NHÂN ĐÔI bất kể base là bao nhiêu.
                    const baseFailCost = hasPerk(target, "Mastered Breaths") ? 30 : 40;
                    const failCost = (target.injuries ?? []).includes("Gãy tay") ? baseFailCost * 2 : baseFailCost;
                    target.currentStamina = Math.max(0, target.currentStamina - failCost);
                    noteParts.push(`🗡️**Parry THẤT BẠI** (${defRoll} vs ${atkRoll}, -${failCost} Sta — ăn full hit ${coverStart + 1}-${hitIdx})`);
                  }
                }
                if ((target.guardCharges ?? 0) > 0 && hitIdx < totalHits) {
                  const coverStart = hitIdx;
                  let used = 0;
                  while (target.guardCharges > 0 && hitIdx < totalHits) {
                    target.guardCharges -= 1; used += 1;
                    for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) perHitMult[hitIdx] = 1 - guardReductionPct;
                  }
                  noteParts.push(`🛡️**Guard** (${used} charge, giảm ${Math.round(guardReductionPct * 100)}% — hit ${coverStart + 1}-${hitIdx})`);
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
                defenseNote = noteParts.length > 0 ? " " + noteParts.join(" + ") : "";
              } else if ((target.evadeCharges ?? 0) > 0) {
                const { chargesUsed, fraction } = computeBlock(target.evadeCharges);
                target.evadeCharges -= chargesUsed;
                finalDmg *= (1 - fraction);
                if (fraction >= 1) evadedCompletely = true;
                defenseNote = ` 💨**Evade** (chặn ${Math.round(fraction * 100)}% — dùng ${chargesUsed} charge)`;
              } else if ((target.parryRolls ?? []).length > 0) {
                const defRoll = target.parryRolls.shift();
                const atkRoll = 1 + Math.floor(Math.random() * 20);
                if (defRoll >= atkRoll) {
                  const { fraction } = computeBlock(1);
                  finalDmg *= (1 - fraction);
                  if (fraction >= 1) evadedCompletely = true;
                  defenseNote = ` 🗡️**Parry THÀNH CÔNG** (${defRoll} vs ${atkRoll}, chặn ${Math.round(fraction * 100)}%)`;
                } else {
                  // Mastered Breaths (Sloth, [15 Points]): base cost 30 thay vì 40 khi
                  // hụt Parry. Gãy tay (chấn thương) vẫn NHÂN ĐÔI bất kể base là bao
                  // nhiêu (áp dụng SAU khi đã chọn base, không phải OR riêng).
                  const baseFailCost = hasPerk(target, "Mastered Breaths") ? 30 : 40;
                  const failCost = (target.injuries ?? []).includes("Gãy tay") ? baseFailCost * 2 : baseFailCost;
                  target.currentStamina = Math.max(0, target.currentStamina - failCost);
                  defenseNote = ` 🗡️**Parry THẤT BẠI** (${defRoll} vs ${atkRoll}, -${failCost} Sta, ăn full dmg)`;
                }
              } else if ((target.guardCharges ?? 0) > 0) {
                const { chargesUsed, fraction } = computeBlock(target.guardCharges);
                target.guardCharges -= chargesUsed;
                finalDmg *= (1 - fraction * guardReductionPct);
                defenseNote = ` 🛡️**Guard** (giảm ${Math.round(guardReductionPct * 100)}% trên ${Math.round(fraction * 100)}% đòn — dùng ${chargesUsed} charge)`;
              }
              // Smoldering Resolve (perk passive, KHÔNG tiêu thụ) áp SAU Guard/Evade/
              // Parry — giảm thêm % trên phần dmg CÒN LẠI sau khi đã né/đỡ.
              finalDmg *= (1 - (t.defReductionPct ?? 0) / 100);
              let killNote = "";
              // Evade né được = né LUÔN finisher (Claim Their Heart) — đã tránh đòn
              // hoàn toàn thì không có lý do vẫn bị "kết liễu" bởi chính đòn đó.
              if (t.instantKill && !evadedCompletely) { finalDmg = target.currentHp; killNote = " ☠️KẾT LIỄU"; }
              let bleedOverride = null; // Break the Dams — giữ bleed KHÔNG bị giảm turn này nếu trigger
              let perkNote = "";
              // Craving Synergy/Thirst/Break the Dams — CHỈ đòn đánh ĐẦU TIÊN của
              // ATTACKER lên TARGET ĐANG có Bleed mỗi turn (chung 1 cờ — trigger cả 3
              // nếu đủ điều kiện riêng từng cái, vì đều là "tận dụng đòn đầu turn").
              if (attacker.type === "player" && !attacker.combatant.bleedFirstHitUsedThisTurn && bleedBeforeHit > 0) {
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
              target.currentHp = Math.max(0, target.currentHp - finalDmg);
              // Death Penalty — CHỈ player (enemy không có profile để trừ). Detect
              // đúng lúc HP chuyển từ >0 sang ≤0 (không trừ lại nếu ĐÃ chết từ trước
              // mà ăn thêm dmg). Mất 50% Ahn + 50% EXP của MỐC HIỆN TẠI (không tụt
              // grade — vì chỉ trừ tối đa 1 nửa expInCurrentGrade, không bao giờ đủ
              // để rớt dưới mốc grade đang đứng).
              let deathNote = "";
              if (wasAliveBefore && target.currentHp <= 0 && targetResolved.type === "player") {
                const { data: profileData, slot } = await getPlayerDataWithSlot(t.targetId);
                const { expInCurrentGrade } = calcGrade(profileData.exp ?? 0);
                const ahnLost = Math.floor((profileData.ahn ?? 0) * 0.5);
                const expLost = Math.floor(expInCurrentGrade * 0.5);
                profileData.ahn = Math.max(0, (profileData.ahn ?? 0) - ahnLost);
                profileData.exp = Math.max(0, (profileData.exp ?? 0) - expLost);
                await savePlayerData(t.targetId, profileData, slot);
                deathNote = ` ☠️**TỬ VONG** — mất ${ahnLost} Ahn + ${expLost} EXP (profile, không tụt grade)`;
              }
              // 5 status "trên người địch" — áp vào TARGET (bên bị tấn công).
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
              target.bleed = bleedOverride ?? (lastHitForStatus?.bleedStacksAfter ?? target.bleed);
              target.tremor = t.preview.finalTremor;
              target.currentSanity = t.preview.finalSanity;
              // Tremor Burst rút STAMINA của TARGET (kẻ mang Tremor bị rút Sta).
              if (t.preview.totalTremorStaminaLoss > 0) {
                target.currentStamina = Math.max(0, target.currentStamina - t.preview.totalTremorStaminaLoss);
              }
              // Defenseless (perk của ATTACKER): gây dmg lên target ĐANG có Rupture → -5 Stamina target.
              if (hasPerk(attacker.combatant, "Defenseless") && hadRuptureBeforeHit) {
                target.currentStamina = Math.max(0, target.currentStamina - 5);
              }
              // Convert Physical Trauma (perk của TARGET/defender): bị tấn công trúng → +1 Charge.
              if (hasPerk(target, "Convert Physical Trauma")) {
                target.charge = Math.min(CHARGE_MAX, target.charge + 1);
              }
              checkStaggerPanic(target);
              // Chấn thương — nhận dmg >30% Max HP trong đòn NÀY → roll 10% nặng/40% nhẹ.
              // Bỏ qua nếu đã chết (kill/death) — không cần lo chấn thương khi đã ra trận.
              const injuryGained = (killNote || deathNote) ? null : rollInjury(target, finalDmg);
              const injuryNote = injuryGained ? ` 🩻**${injuryGained}**` : "";
              targetDmgLines.push(`${targetResolved.label} -${finalDmg.toFixed(3)} HP${killNote}${deathNote}${defenseNote}${perkNote}${injuryNote}`);
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
            }
            // Bleed — "1 bleed count trên người địch sẽ gây dmg bằng 1/4 count mỗi
            // khi kẻ địch hành động tấn công trong turn" — áp dụng cho CHÍNH người
            // ĐANG TẤN CÔNG (attacker) ở action này, nếu HỌ đang mang Bleed — không
            // liên quan gì tới target. Áp dụng cho MỌI loại tấn công (attack/hit/
            // enemyattack), KHÔNG riêng M1, vì luật chỉ nói "hành động tấn công" nói
            // chung. Count KHÔNG đổi ở đây (chỉ giảm nửa lúc end turn thật).
            let bleedSelfNote = "";
            if ((attacker.combatant.bleed ?? 0) > 0) {
              const bleedSelfDmg = Math.floor(attacker.combatant.bleed / 4);
              if (bleedSelfDmg > 0) {
                attacker.combatant.currentHp = Math.max(0, attacker.combatant.currentHp - bleedSelfDmg);
                checkStaggerPanic(attacker.combatant);
                bleedSelfNote = ` [🩸Bleed tự gây ${bleedSelfDmg} dmg lên ${attacker.label}]`;
              }
            }
            // Battle Ignition/Overbearing/Blessed Sparks: đếm M1 (chỉ attack mới có
            // p.isM1=true, hit/Page không tính) — tăng cả "turn này" (cho Battle
            // Ignition turn SAU) và "tổng" (cho Overbearing/Blessed Sparks "mỗi đòn
            // thứ 2", không reset theo turn). PHẢI ĐẶT SAU khối gán Poise/Charge từ
            // preview phía trên — trước đây đặt TRƯỚC nên bị preview ghi đè mất ngay,
            // Overbearing/Blessed Sparks không bao giờ thấy hiệu lực thật.
            if (p.isM1 && attacker.type === "player") {
              attacker.combatant.attacksThisTurn = (attacker.combatant.attacksThisTurn ?? 0) + 1;
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
            if (p.emotionDelta) {
              const levelNotes = applyEmotionDelta(attacker.combatant, p.emotionDelta);
              verifyNote += ` [Coin ${p.emotionDelta >= 0 ? "+" : ""}${p.emotionDelta}]`;
              if (levelNotes.length > 0) verifyNote += " " + levelNotes.join(" ");
            }

            resultLines.push(`${attacker.label}${staminaNote}${verifyNote}${bleedSelfNote} → ${targetDmgLines.join(", ")} (\`${p.dmgStr}\`)`);
          }
        } else {
          for (const p of encounter.pendingActions) {
            const attacker = resolveCombatant(encounter, p.attackerId);
            resultLines.push(`${attacker?.label ?? p.attackerId} (\`${p.dmgStr}\`) — đã reject`);
          }
        }

        encounter.pendingActions = [];
        await saveEncounter(channelId, encounter);

        await interaction.update({
          embeds: [{
            title: isConfirm ? "✅ Đã xác nhận tất cả" : "❌ Đã reject tất cả",
            description: resultLines.join("\n") || "*(không có gì)*",
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
  const targetStr = interaction.fields.getTextInputValue("targetStr");
  try {
    if (action === "attack") {
      const dmgStr = interaction.fields.getTextInputValue("dmgStr");
      const { embed } = await doPlayerAttack(channelId, interaction.user.id, interaction.user.toString(), dmgStr, targetStr);
      await interaction.reply({ embeds: [embed] });
    } else if (action === "hit") {
      const dmgStr = interaction.fields.getTextInputValue("dmgStr");
      // Chọn từ dropdown 1 Page cụ thể → tự điền skill: (bot tự roll thật kèm theo,
      // giống gõ tay "skill: <tên>") — KHÔNG cần player tự gõ thêm gì ngoài target+dmg.
      const skillFromDropdown = encodedPageName ? decodeURIComponent(encodedPageName) : undefined;
      const { embed, skillRollEmbed } = await doPlayerHit(channelId, interaction.user.id, interaction.user.toString(), dmgStr, targetStr, { skill: skillFromDropdown });
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

// ─── SELECT MENU INTERACTIONS (encounter) ────────────────────────────────────
// Dropdown hành động ĐỘNG (xem buildEncounterActionPanel) — thay cho 2 nút
// Attack/Hit cố định cũ. attack/hit:<page> mở Modal (cần target+dmg); followup mở
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
    if (value === "attack" || value.startsWith("hit:")) {
      const isHit = value.startsWith("hit:");
      const pageName = isHit ? value.slice(4) : null;
      const modal = new ModalBuilder()
        .setCustomId(`encmodal:${channelId}:${isHit ? "hit" : "attack"}${pageName ? `:${encodeURIComponent(pageName)}` : ""}`)
        .setTitle(isHit ? `Dùng Page: ${pageName}`.slice(0, 45) : "Đánh thường (M1)");
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
    const isAdmin = ADMIN_IDS.has(interaction.user.id);
    let resultMsg;
    if (value === "guard" || value === "evade") resultMsg = await performGuardEvade(channelId, interaction.user.id, isAdmin, value);
    else if (value === "parry") resultMsg = await performParry(channelId, interaction.user.id, isAdmin);
    else if (value === "shinmang") resultMsg = await performShinMang(channelId, interaction.user.id);
    else if (value === "manifestego") resultMsg = await performManifestEgo(channelId, interaction.user.id);
    else if (value === "overcharge") resultMsg = await performOvercharge(channelId, interaction.user.id);
    else { await interaction.reply({ content: "⚠️ Hành động không hợp lệ.", flags: MessageFlags.Ephemeral }).catch(() => {}); return; }
    await interaction.reply({ content: resultMsg });
  } catch (err) {
    log("error", "encMenuSelect", interaction.user?.id ?? "unknown", err.message);
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
