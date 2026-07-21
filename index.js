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
const { renderParryWebPage } = require("./rtparry-webpage"); // ĐÃ TÁCH sang file riêng (rtparry-webpage.js) — hàm thuần render HTML, không phụ thuộc gì khác

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
// GAP ĐÃ SỬA (xác nhận trực tiếp): "Thêm pool banner giới hạn thời gian và pool
// banner thường... Pool lúc trước là banner thường... làm một banner giới hạn"
// — tái cấu trúc từ 3 hằng số phẳng (GACHA_POOL_HIGH/MID/RARE) thành object
// GACHA_BANNERS (mỗi banner tự có pool + tên riêng) để hỗ trợ nhiều banner cùng
// lúc. Tỷ lệ 80/19/1% và Pity áp dụng CHUNG cho cả 2 banner (xác nhận trực tiếp).
const GACHA_RATES = { high: 80, mid: 19, rare: 1 }; // % — xác nhận trực tiếp, tổng = 100
const GACHA_COST_PER_PULL = 130; // Lunacy/lần — xác nhận trực tiếp (1300 Lunacy code đầu = đúng 10 lần)
const GACHA_PITY_MAX = 100; // xác nhận trực tiếp: "1 Pity = 1 roll khi đạt 100 có thể đổi bất kỳ 1 món từ Tier 3"
// Naruto's Banner hết hạn 31/7/2026 23:59 giờ VN (UTC+7) = 2026-07-31T16:59:00Z
// — hardcode timestamp (không parse string lúc runtime) để tránh rủi ro
// timezone của máy chủ.
const NARUTO_BANNER_EXPIRES_AT = 1785517140000;

const GACHA_BANNERS = {
  standard: {
    name: "Standard Banner",
    poolHigh: RANDOM_BOOK_POOL, // 17 item — pool gốc, KHÔNG đổi
    poolMid: [...SEALED_BOOK_POOL, ...CHIPBOARD_CACHE_POOL, "Uptie Module"], // 16 item — KHÔNG đổi
    poolRare: ["Custom Accessory", "Custom Weapon", "Custom Outfit", "Custom Page", "Custom E.G.O", "Chipboard MK4", "Chipboard MK5"], // 7 item — KHÔNG đổi
    expiresAt: null, // không giới hạn thời gian
  },
  naruto: {
    name: "Naruto's Banner",
    poolHigh: RANDOM_BOOK_POOL, // Tier 1 giữ nguyên (không nhắc tới thay đổi)
    // Tier 2: giữ nguyên pool cũ + THÊM Sharingan, Secret Scroll (xác nhận trực tiếp)
    poolMid: [...SEALED_BOOK_POOL, ...CHIPBOARD_CACHE_POOL, "Uptie Module", "Sharingan", "Secret Scroll"],
    // Tier 3: THAY HOÀN TOÀN — xác nhận trực tiếp loại bỏ luôn Custom Page,
    // chỉ còn 3 item mới (Rinnegan, Kurama, Hiraishin Kunai), không còn
    // Chipboard MK4/MK5/Custom X nào trong banner này.
    poolRare: ["Rinnegan", "Kurama", "Hiraishin Kunai"],
    expiresAt: NARUTO_BANNER_EXPIRES_AT,
  },
};

/** isBannerActive — banner không giới hạn (expiresAt=null) luôn active; banner
 *  giới hạn thời gian hết hạn sau NARUTO_BANNER_EXPIRES_AT. */
function isBannerActive(bannerKey) {
  const banner = GACHA_BANNERS[bannerKey];
  if (!banner) return false;
  return banner.expiresAt === null || Date.now() < banner.expiresAt;
}

/** rollGachaOnce — roll 1 lần theo 3 tier GACHA_RATES, trả về { item, tier }
 *  (tier cần để biết có phải Tier 3 hay không, phục vụ Pity). */
function rollGachaOnce(bannerKey) {
  const banner = GACHA_BANNERS[bannerKey];
  const roll = Math.random() * 100;
  if (roll < GACHA_RATES.high) {
    return { item: banner.poolHigh[Math.floor(Math.random() * banner.poolHigh.length)], tier: 1 };
  } else if (roll < GACHA_RATES.high + GACHA_RATES.mid) {
    return { item: banner.poolMid[Math.floor(Math.random() * banner.poolMid.length)], tier: 2 };
  } else {
    return { item: banner.poolRare[Math.floor(Math.random() * banner.poolRare.length)], tier: 3 };
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
  "banner", // -gacha banner: naruto/standard
  "usebullet", // -encounter attack usebullet: yes (Soldato Rifle's Firing passive)
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

// GAP ĐÃ SỬA (dự án GM Panel mở rộng, xác nhận trực tiếp: "gm có thể chỉnh sửa
// bất cứ thứ gì... status") — TÁCH logic CỐT LÕI của -encounter setstatus ra
// thành hàm dùng CHUNG, để gmpanel's Modal chỉnh sửa (gmeditmodal:) cũng gọi lại
// được — COPY NGUYÊN VĂN từ bên trong lệnh text (không đổi 1 dòng logic nào),
// chỉ đổi input từ "đọc kv trực tiếp" thành "nhận entries đã parse sẵn".
const STATUS_CAPS_SHARED = {
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
  // GAP ĐÃ SỬA (xác nhận trực tiếp: "dropdown set status... thấy còn thiếu
  // khá nhiều status") — TRƯỚC ĐÂY thiếu HOÀN TOÀN "7 status effect" cơ bản
  // (comment gốc ở combatant-factory.js: Sinking/Rupture/Poise/Charge/Burn/
  // Bleed/Tremor) — chỉ có mặt ở tham số -math, chưa BAO GIỜ set được qua GM
  // Panel dropdown. Thêm cả Haste/Bind (2 status Speed riêng, có lệnh text
  // "-encounter haste/bind" nhưng cũng thiếu trong dropdown này).
  sinking: SINKING_MAX, rupture: RUPTURE_MAX, poise: POISE_MAX, charge: CHARGE_MAX,
  burn: BURN_MAX, bleed: BLEED_MAX, tremor: TREMOR_MAX,
  haste: 99, bind: 20, // Bind cap=20 xác nhận từ logic Spectro Frazzle đã có sẵn (dòng "resolved.combatant.bind = Math.min(20, ...)")
};
const STATUS_FIELD_MAP_SHARED = {
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
  // 7 status cơ bản (map trực tiếp, không cần camelCase — field trên
  // combatant đã sẵn lowercase) + Haste/Bind.
  sinking: "sinking", rupture: "rupture", poise: "poise", charge: "charge",
  burn: "burn", bleed: "bleed", tremor: "tremor",
  haste: "haste", bind: "bind",
};
function applyStatusEntries(resolved, entries, sourceId, checkStaggerPanicFn) {
  const changes = [];
  // GAP ĐÃ SỬA (xác nhận trực tiếp: "toàn bộ tất cả chỉ số... injuries, emotion
  // coin, emotion level, cd skill, dmg bonus, dmg reduction") — map field cho
  // "set" (SET trực tiếp, không cộng dồn/không cap) — CHỈ những field này được
  // phép set trực tiếp qua gmeditmodal, để tránh GM vô tình set field nhạy cảm
  // khác gây lỗi (VD currentHp/maxHp nên đi qua field HP riêng của Modal).
  const SETTABLE_FIELD_MAP = {
    emotioncoin: "emotionCoin", emotionlevel: "emotionLevel",
    bonuspct: "gmBonusPctOverride", reductionpct: "gmReductionPctOverride",
  };
  for (const entry of entries) {
    if (entry.type === "note") {
      const before = resolved.combatant.gmNote || "(trống)";
      resolved.combatant.gmNote = entry.text;
      changes.push(`Note: "${before}" → **"${entry.text}"**`);
      continue;
    }
    if (entry.type === "set") {
      const amount = parseInt(entry.raw, 10);
      if (!Number.isFinite(amount)) throw new Error(`\`set ${entry.key}:\` phải là số.`);
      const field = SETTABLE_FIELD_MAP[entry.key];
      if (!field) throw new Error(`"set ${entry.key}" không hợp lệ — dùng: ${Object.keys(SETTABLE_FIELD_MAP).join("/")}`);
      const before = resolved.combatant[field] ?? 0;
      resolved.combatant[field] = amount;
      changes.push(`${entry.key} (set): ${before} → **${amount}**`);
      continue;
    }
    if (entry.type === "injuryAdd") {
      resolved.combatant.injuries = resolved.combatant.injuries ?? [];
      resolved.combatant.injuries.push(entry.name);
      changes.push(`+ injury: **${entry.name}**`);
      continue;
    }
    if (entry.type === "injuryRemove") {
      resolved.combatant.injuries = resolved.combatant.injuries ?? [];
      const idx = resolved.combatant.injuries.indexOf(entry.name);
      if (idx === -1) throw new Error(`Không tìm thấy injury "${entry.name}" trên ${resolved.label} (kiểm tra đúng tên chính xác, phân biệt hoa/thường).`);
      resolved.combatant.injuries.splice(idx, 1);
      changes.push(`- injury: **${entry.name}**`);
      continue;
    }
    if (entry.type === "cd") {
      const amount = parseInt(entry.raw, 10);
      if (!Number.isFinite(amount)) throw new Error(`\`cd ${entry.skillKey}:\` phải là số.`);
      resolved.combatant.skillCooldowns = resolved.combatant.skillCooldowns ?? {};
      const before = resolved.combatant.skillCooldowns[entry.skillKey] ?? 0;
      resolved.combatant.skillCooldowns[entry.skillKey] = Math.max(0, amount);
      changes.push(`CD ${entry.skillKey}: ${before} → **${Math.max(0, amount)}**`);
      continue;
    }
    // entry.type === "status" (mặc định, GIỮ NGUYÊN logic gốc — cộng dồn có cap)
    const { key, raw } = entry;
    const amount = parseInt(raw, 10);
    if (!Number.isFinite(amount)) throw new Error(`\`${key}:\` phải là số.`);
    if (key === "gazeofcontempt" && amount > 0 && resolved.combatant.contemptOfTheGaze) {
      throw new Error(`${resolved.label} đang có Contempt of the Gaze — không thể nhận thêm Gaze of Contempt lúc này.`);
    }
    const field = STATUS_FIELD_MAP_SHARED[key];
    const cap = STATUS_CAPS_SHARED[key];
    if (!field) throw new Error(`Status "${key}" không hợp lệ — dùng: ${Object.keys(STATUS_CAPS_SHARED).join("/")}`);
    const before = resolved.combatant[field] ?? 0;
    resolved.combatant[field] = Math.max(0, Math.min(cap, before + amount));
    if ((key === "gazeawe" || key === "contempt") && amount > 0) {
      if (!sourceId) throw new Error(`Dùng "${key}:" cần kèm "source: <key enemy hoặc mention player>" để biết ai là "kẻ đã gắn".`);
      resolved.combatant[key === "gazeawe" ? "gazeAweSourceId" : "contemptSourceId"] = sourceId;
    }
    if (key === "protection" && amount > 0) resolved.combatant.protectionTurnsLeft = 2;
    if (key === "borrowedtime" && amount > 0) resolved.combatant.borrowedTimeTurnsLeft = 3;
    if (key === "fairy" && amount > 0) resolved.combatant.fairyTurnsLeft = 2;
    if (key === "hemorrhage" && amount > 0) resolved.combatant.hemorrhageAppliedThisTurn = true;
    if (key === "spectrofrazzle" && amount > 0) {
      resolved.combatant.bind = Math.min(20, (resolved.combatant.bind ?? 0) + amount);
      const staLoss = amount * 10;
      if (resolved.combatant.staggered || resolved.combatant.currentStamina <= 0) {
        resolved.combatant.spectroFrazzlePendingLoss = (resolved.combatant.spectroFrazzlePendingLoss ?? 0) + staLoss * 2;
      } else if (resolved.combatant.currentStamina < staLoss) {
        const shortfall = staLoss - resolved.combatant.currentStamina;
        resolved.combatant.currentStamina = 0;
        resolved.combatant.spectroFrazzlePendingLoss = (resolved.combatant.spectroFrazzlePendingLoss ?? 0) + shortfall * 2;
        checkStaggerPanicFn(resolved.combatant);
      } else {
        resolved.combatant.currentStamina -= staLoss;
        checkStaggerPanicFn(resolved.combatant);
      }
    }
    changes.push(`${key}: ${before} → **${resolved.combatant[field]}**`);
  }
  return changes;
}
// Parse cú pháp tự do "key: amount, key2: amount2" (dùng cho ô Paragraph trong
// gmeditmodal — khác parseKeyValues vốn dùng cho toàn bộ message content).
// GAP ĐÃ SỬA (xác nhận trực tiếp: "toàn bộ tất cả chỉ số" — injuries, emotion
// coin, emotion level, cd skill, dmg bonus, dmg reduction) — mở rộng thêm 3
// dạng cú pháp mới, tách biệt hoàn toàn với "key: amount" gốc (status cộng dồn
// có cap):
//   "set <field>: <value>"       → SET trực tiếp (không cộng dồn, không cap) —
//                                   dùng cho emotioncoin/emotionlevel/bonuspct/
//                                   reductionpct.
//   "injury+: <tên>" / "injury-: <tên>" → thêm/xoá 1 injury theo TÊN chính xác.
//   "cd <skillkey>: <value>"     → set skillCooldowns[skillkey] trực tiếp.
function parseStatusFreeText(text) {
  const entries = [];
  let workingText = text ?? "";
  // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 phần để thêm note lên chỗ status của
  // player hoặc boss/mob phòng trong các status đặc biệt mà chưa kịp
  // implement vào code") — "note:" PHẢI ở CUỐI chuỗi (mọi thứ sau nó, kể cả
  // dấu phẩy, được coi là nội dung note tự do — không thể parse tiếp status
  // nào sau "note:").
  const noteMatch = workingText.match(/note\s*:\s*(.+)$/is);
  if (noteMatch) {
    entries.push({ type: "note", text: noteMatch[1].trim() });
    workingText = workingText.slice(0, noteMatch.index);
  }
  for (const part of workingText.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const setMatch = trimmed.match(/^set\s+([a-zA-Z]+)\s*:\s*(-?\d+)$/i);
    if (setMatch) { entries.push({ type: "set", key: setMatch[1].toLowerCase(), raw: setMatch[2] }); continue; }
    const injuryAddMatch = trimmed.match(/^injury\+\s*:\s*(.+)$/i);
    if (injuryAddMatch) { entries.push({ type: "injuryAdd", name: injuryAddMatch[1].trim() }); continue; }
    const injuryRemoveMatch = trimmed.match(/^injury-\s*:\s*(.+)$/i);
    if (injuryRemoveMatch) { entries.push({ type: "injuryRemove", name: injuryRemoveMatch[1].trim() }); continue; }
    const cdMatch = trimmed.match(/^cd\s+(.+?)\s*:\s*(-?\d+)$/i);
    if (cdMatch) { entries.push({ type: "cd", skillKey: cdMatch[1].trim().toLowerCase(), raw: cdMatch[2] }); continue; }
    const normalMatch = trimmed.match(/^([a-zA-Z]+)\s*:\s*(-?\d+)$/);
    if (normalMatch) entries.push({ type: "status", key: normalMatch[1].toLowerCase(), raw: normalMatch[2] });
  }
  return entries;
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
const { migratePlayerData, isTimeoutError, numberEmoji, profileNamesKey, getProfileNames, setProfileName, resolveProfileLabel, getActiveProfileSlot, setActiveProfileSlot, playerKeyForSlot, dailyKeyForSlot, getPlayerData, getPlayerDataWithSlot, savePlayerData, saveMultiplePlayerData, unwrapPipelineResults, formatNumber, PROFILE_EMOJIS, PROFILE_LABELS } = require("./player-data")({ MAX_PROFILES, Redis, VALID_ITEMS_SET, log, redis, withTimeout }); // ĐÃ TÁCH sang file riêng (player-data.js) — PROFILE_EMOJIS/PROFILE_LABELS được định nghĩa NỘI BỘ trong module này nhưng cần export ngược lại vì index.js truyền tiếp cho player-actions.js/message-create-handler.js/interaction-handlers.js

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
function computeDefenseOptions(target, attackerWeaponWeight, hitCount, isM1Type, bypass, isEyeOfHorusFixedBurst = false) {
  // ĐIỀU CHỈNH LẠI (xác nhận trực tiếp — sửa lại nhận định trước đó): "light
  // weapon... chỉ cần guard 1 lần được 4 hit m1... Medium 2 hit/charge... Heavy
  // 1 hit/charge" — WEAPON_DEFENSE_HITS (ưu đãi theo vũ khí cho M1) KHÔI PHỤC
  // LẠI, ĐÚNG như thiết kế gốc — lần sửa trước đã HIỂU SAI và xoá nhầm hẳn ưu
  // đãi này cho CẢ M1 (chỉ nên áp dụng cho skill: Blade Flourish 3-hit tốn 1
  // charge chặn hết là sai, NHƯNG Rat 2-hit M1 light 1 charge chặn hết là ĐÚNG).
  // NGOẠI LỆ Eye Of Horus (xác nhận trực tiếp): dù là vũ khí heavy (bình thường
  // 1 hit/charge), nhưng M1 bắn theo "volley" 9-hit MỘT LẦN — 1 charge chặn
  // ĐƯỢC HẾT 1 volley (9 hit), không phải chỉ 1/9 hit như heavy thường. Bắn
  // nhiều volley (kể cả từ repeat ammo) vẫn cần TƯƠNG ỨNG số charge (1
  // charge/volley, không phải 1 charge cho TẤT CẢ volley).
  const hitsPerCharge = isEyeOfHorusFixedBurst ? 9 : (isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeaponWeight] ?? 1) : 1);
  const chargesNeeded = target.hasIronHorus ? 1 : Math.ceil(hitCount / hitsPerCharge);


  const guardCostPerCharge = target.hasIronHorus ? 40 : 10;
  const guardCost = chargesNeeded * guardCostPerCharge;
  const guardAvailable = !bypass.blockGuard && target.currentStamina >= guardCost;
  // maxAffordableGuardCharges — GAP ĐÃ SỬA (xác nhận trực tiếp: "hệ thống tùy
  // chọn né theo từng hit... nhận hit 1 và 2 nhưng né/guard hit 3") — reactive
  // prompt cần biết TỐI ĐA bao nhiêu hit có thể chọn (dropdown "Chọn hit") dựa
  // trên Stamina hiện có, KHÔNG PHẢI chargesNeeded (số cần để che HẾT).
  const maxAffordableGuardCharges = Math.min(hitCount, Math.floor(target.currentStamina / guardCostPerCharge));

  const evadeBlocked = (target.injuries ?? []).includes("Mất Chân");
  const evadeCostPerCharge = 20 * ((target.injuries ?? []).includes("Gãy chân") ? 2 : 1);
  // "Light Dash" (Page, KHÁC HOÀN TOÀN "Light Dash" PERK skill tree — trùng
  // tên, không liên quan): "né một đòn tấn công của kẻ địch (không thể né
  // Undodgeable)" — 1 lượt né MIỄN PHÍ (0 Sta), KHÔNG dùng evadeCharges thường
  // (field riêng lightDashFreeEvadeCharges, tiêu thụ ƯU TIÊN trước charge mua
  // bằng Stamina bình thường).
  const hasLightDashFreeEvade = !bypass.blockEvade && (target.lightDashFreeEvadeCharges ?? 0) > 0;
  const evadeCost = hasLightDashFreeEvade ? 0 : chargesNeeded * evadeCostPerCharge;
  const evadeAvailable = !bypass.blockEvade && !evadeBlocked && (hasLightDashFreeEvade || target.currentStamina >= evadeCost);
  const maxAffordableEvadeCharges = evadeBlocked ? 0 : Math.min(hitCount, Math.floor(target.currentStamina / evadeCostPerCharge));

  // Parry: 0 Stamina lúc "kích hoạt" — nhưng CÓ THỂ tốn Sta SAU NẾU roll thua
  // (40/30 tùy perk, x2 nếu Gãy tay) — không chặn hiển thị option theo Sta hiện
  // tại vì bản chất Parry "miễn phí lúc quyết định", rủi ro nằm ở kết quả roll.
  const parryAvailable = !bypass.blockParry;

  return {
    chargesNeeded, hitsPerCharge, maxAffordableGuardCharges, maxAffordableEvadeCharges,
    guard: { available: guardAvailable, cost: guardCost, costPerCharge: guardCostPerCharge },
    evade: { available: evadeAvailable, cost: evadeCost, blockedReason: evadeBlocked ? "Mất Chân" : null, costPerCharge: evadeCostPerCharge },
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

const { rollSpeedValue, determineTurnOrder, isCurrentTurnHolder, hasEncounterStarted, validateAndRerollPrescript, insertIntoTurnOrderMidRound, advanceToNextTurnHolder, buildTurnOrderText, combatantResStr, trueDmgResStr, haouRuptureResStr, applyParrySuccessPerks, applyEvadeSuccessPerks, restoreInjuryMaxHp, applyDeathPenalty, appendActionLog, getActionLogIcon, checkStaggerPanic } = require("./combat-utils")({ hasPerk, getPlayerDataWithSlot, savePlayerData, calcGrade, CHARGE_MAX, ENCOUNTER_SANITY_MAX, findWeaponAnywhere });

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

async function doPlayerAttack(channelId, playerId, playerMention, dmgStr, targetStr, verifyOpts = {}) {
  const { skill: skillNameRaw, ref: refRaw, coin: manualCoinRaw, tags: manualTagsRaw, ammotype: ammoTypeRaw, usebullet: useBulletRaw, bullettype: bulletTypeRaw } = verifyOpts;
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
    if (!hasEncounterStarted(encounter)) {
      throw new Error("⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước khi ai đó có thể hành động.");
    }
    if (!isCurrentTurnHolder(encounter, playerId)) {
      const order = encounter.turnOrder ?? [];
      const holderLabel = order[encounter.currentTurnIndex ?? 0]
        ? (order[encounter.currentTurnIndex].type === "enemy" ? encounter.enemies[order[encounter.currentTurnIndex].id]?.name ?? "?" : `<@${order[encounter.currentTurnIndex].id}>`)
        : "?";
      throw new Error(`Chưa tới lượt bạn — đang là lượt của ${holderLabel}. Bạn vẫn có thể phòng thủ (Guard/Evade/Parry) nếu bị tấn công.`);
    }
    if ((encounter.pendingActions ?? []).length >= ENCOUNTER_PENDING_MAX) throw new Error(`Đã có quá nhiều action chờ xác nhận (tối đa ${ENCOUNTER_PENDING_MAX}) — chờ GM xử lý trước.`);

    const isEyeOfHorus = (player.weaponName ?? "").toLowerCase() === "eye of horus";
    // GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3 (xác nhận trực tiếp kèm passive text đầy đủ
    // "Foreclosure Task Force President") — "N lần" = số lần M1 đã dùng lên
    // CHÍNH TARGET NÀY trong turn (mỗi target tính riêng biệt), KHÔNG PHẢI tham
    // số "volleys: N" tự nhập — 2 lần hiểu trước đó (per-target counter rồi lại
    // đổi sang "volley tự chọn") đều sai. Giờ HOÀN TOÀN TỰ ĐỘNG — không cần input
    // gì, dmgStr được xây RIÊNG cho từng target trong AOE (không phải 1 dmgStr
    // chung nữa, vì mỗi target có thể có count khác nhau) — xem previews.map bên
    // dưới. Do đó dmgStr người dùng tự gõ KHÔNG áp dụng cho Eye Of Horus M1 nữa.
    if (!isEyeOfHorus && (!dmgStr || !dmgStr.trim())) throw new Error("Cần nhập công thức dmg (VD: `50x2B+2Sinking`).");

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

    // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — "Firing" (Soldato
    // Rifle): "Có thể tiêu stack đạn có trong người để đòn đánh thường chuyển
    // qua dmg Pierce và +4 Base Dmg" — usebullet: yes để kích hoạt, tiêu 1
    // stack (không phải toàn bộ). +4 Base Dmg áp qua flatDmgPerHit (cơ chế có
    // sẵn cho Attack Power Up); ĐỔI SANG Pierce cần người chơi tự đổi ký tự
    // loại dmg trong công thức (VD 10x2B → 10x2P) — hệ thống KHÔNG tự parse/
    // sửa dmgStr người dùng nhập (rủi ro cao nếu tự động sửa sai công thức).
    const useBulletNormalized = (useBulletRaw ?? "").trim().toLowerCase();
    const willUseBullet = useBulletNormalized === "yes" || useBulletNormalized === "true" || useBulletNormalized === "1";
    // GAP ĐÃ SỬA (xác nhận trực tiếp): bulletStack là TỔNG (max 8, không phân
    // biệt loại), bulletStackFrost/Incendiary = trong số đó bao nhiêu là loại
    // đặc biệt — "Firing" cần biết CHỌN tiêu loại nào (bullettype: riêng biệt,
    // KHÔNG dùng chung ammotype: vì đó là hệ thống M1 thường khác, field khác
    // hẳn) để áp đúng hiệu ứng phụ (Frost=+1 Paralyze, Incendiary=+2 Burn)
    // CÙNG với +4 Base Dmg/Pierce vốn có của Firing.
    let effectiveBulletType = null;
    if (willUseBullet) {
      if ((player.bulletStack ?? 0) < 1) throw new Error(`Không đủ đạn (Soldato Rifle) — hiện có ${player.bulletStack ?? 0}/8.`);
      const bulletTypeNormalized = (bulletTypeRaw ?? "").trim().toLowerCase();
      if (bulletTypeNormalized === "frost") {
        if ((player.bulletStackFrost ?? 0) < 1) throw new Error(`Không đủ đạn Frost trong súng (0) — dùng \`-encounter reload type: frost\` hoặc Re-Load trước.`);
        player.bulletStackFrost -= 1;
        effectiveBulletType = "frost";
      } else if (bulletTypeNormalized === "incendiary") {
        if ((player.bulletStackIncendiary ?? 0) < 1) throw new Error(`Không đủ đạn Incendiary trong súng (0) — dùng \`-encounter reload type: incendiary\` hoặc Re-Load trước.`);
        player.bulletStackIncendiary -= 1;
        effectiveBulletType = "incendiary";
      }
      player.bulletStack -= 1;
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
    // "Rotate Trigram" — "Ri": áp dụng vào M1 ĐẦU TIÊN sau khi rơi vào "Ri"
    // (rotateTrigramRiPending từ turn-advance.js) — "phá hủy 2 Light" nếu đủ,
    // ngược lại giảm 10% Stamina của target ĐẦU TIÊN (không phải AOE toàn bộ —
    // gốc chỉ nói "kẻ địch", số ít).
    if (player.rotateTrigramRiPending) {
      player.rotateTrigramRiPending = false;
      if ((player.currentLight ?? 0) >= 2) {
        player.currentLight -= 2;
      } else if (targets[0]) {
        const riTarget = targets[0].combatant;
        riTarget.currentStamina = Math.max(0, riTarget.currentStamina - Math.round(riTarget.maxStamina * 0.1));
      }
    }
    // "Tactical Suppression" (Eye Of Horus Critical) — xác nhận trực tiếp:
    // "Nếu đánh thường trong trạng thái này, tiêu thụ toàn bộ Charge thành
    // Charge Shield lên bản thân".
    if (player.tacticalSuppressionActive && (player.charge ?? 0) > 0) {
      const chargeConsumed = player.charge;
      player.chargeShieldStack = Math.min(20, (player.chargeShieldStack ?? 0) + chargeConsumed);
      player.charge = 0;
    }
    // QUAN TRỌNG: Poise/Charge là "trên bản thân" → lấy từ PLAYER (người tấn công),
    // dùng CHUNG cho mọi target trong AOE (vẫn là 1 người tấn công, 1 lượng Poise).
    // Sinking/Rupture/Burn/Bleed/Tremor là "trên người địch HOẶC player khác (PvP)"
    // → lấy RIÊNG cho từng target — tính calcMathCore riêng từng target.
    const previews = targets.map(t => {
      // GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3 — "Foreclosure Task Force President":
      // tính RIÊNG cho TỪNG target (không phải 1 dmgStr chung, vì mỗi target có
      // thể đã bị đánh SỐ LẦN KHÁC NHAU trong turn này, kể cả trong CÙNG 1 AOE
      // action). eyeOfHorusNewCount CHỈ tính ở đây để build dmgStr/preview —
      // CHƯA ghi thật vào player.eyeOfHorusTargetHitCounts (chỉ ghi thật lúc
      // commit, xem resolveOnePendingAction — khớp nguyên tắc "chưa gì là thật
      // cho tới khi GM xác nhận", giống staminaCost/eyeOfHorusAmmo).
      let targetDmgStr = dmgStr;
      let eyeOfHorusNewCount = null;
      if (isEyeOfHorus) {
        eyeOfHorusNewCount = (player.eyeOfHorusTargetHitCounts?.[t.id] ?? 0) + 1;
        const totalVolleys = eyeOfHorusNewCount === 1 ? 2 : 1; // lần ĐẦU TIÊN lên target này → auto +1 Repeat Ammo volley
        // GAP ĐÃ SỬA (xác nhận trực tiếp — passive text cập nhật): "Dưới hoặc
        // bằng 3 lần: Base dmg... 4x9" — TRƯỚC ĐÂY sai ngưỡng (<=6), giờ đúng <=3.
        const base = eyeOfHorusNewCount <= 3 ? 4 : 3;
        const typeLetter = { Blunt: "B", Pierce: "P", Slash: "S" }[player.weaponType] ?? "P";
        targetDmgStr = Array(totalVolleys).fill(`${base}x9${typeLetter}`).join(" + ");
      }
      const perkCtx = computeAttackerPerkContext(player, t.combatant, targetDmgStr, { isM1: true, targetId: t.id, eyeOfHorusNewCount, attackerId: playerId, willUseBullet });
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
        poiseInit: player.poise, chargeInit: player.charge,
        // Attack Power Up/Down (50-Status Nhóm 1) — CHỈ áp dụng cho player ĐANG
        // TẤN CÔNG (attacker), KHÔNG áp cho target. +4 nếu "Firing" (Soldato
        // Rifle) đang tiêu đạn (willUseBullet) — chỉ M1, không áp skill/Critical.
        flatDmgPerHit: (player.attackPowerUp ?? 0) - (player.attackPowerDown ?? 0) + (willUseBullet ? 4 : 0),
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
      const finalDmgAfterReduction = preview.totalDmg * saturateDR(1 - defReductionPct / 100);
      const totalVolleysForThisTarget = isEyeOfHorus ? (eyeOfHorusNewCount === 1 ? 2 : 1) : 0;
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill, eyeOfHorusTremorChargeAmount: perkCtx.eyeOfHorusTremorChargeAmount, haouRuptureApplied: haouRuptureCheck?.applied ?? false, eyeOfHorusNewCount, targetDmgStr, totalVolleysForThisTarget };
    });
    const hitCount = previews[0].preview.dmgValues.length;
    // Eye Of Horus — Stamina cost ĐẶC BIỆT: 20 Sta cho MỖI "lần bắn" (volley
    // 9-hit) — GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3: KHÔNG còn 1 con số N chung nữa
    // (không có input "volleys:"), mà là TỔNG số volley CỘNG DỒN qua TẤT CẢ
    // target trong AOE (mỗi target tự có totalVolleys riêng theo count của nó).
    // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp): "1 lần bắn chỉ tốn 20 sta và
    // 1 đạn thôi" — volley TỰ ĐỘNG kích hoạt từ "Bắn thêm 1 Repeat Ammo" (lần đầu
    // lên 1 target, count===1) ĐÚNG BẢN CHẤT "Repeat Ammo" (miễn phí hoàn toàn cả
    // Stamina lẫn Ammo, CHỈ vẫn gây dmg — giống hệt ammotype: repeat tự gõ tay) —
    // TRƯỚC ĐÂY tính SAI, cộng dồn CẢ volley miễn phí đó vào cost (totalVolleys=2
    // → 40 Sta/2 Ammo). Giờ cost LUÔN = 1 volley/target (20 Sta + 1 Ammo), BẤT KỂ
    // count là bao nhiêu hay có auto-repeat hay không — dmg vẫn tính đủ theo
    // totalVolleysForThisTarget (xem targetDmgStr ở trên), chỉ CHI PHÍ tách riêng.
    const totalVolleysForStamina = isEyeOfHorus ? previews.length : 0;
    // BUG ĐÃ SỬA (xác nhận trực tiếp): "repeat ammo của Eye of Horus lại tốn 40
    // sta trong khi đáng lẽ nó không tốn ammo lẫn stamina" — Repeat Ammo (lặp
    // lại viên đạn TRƯỚC, không phải bắn volley mới) trước đây CHỈ miễn Ammo
    // Stack, vẫn bị tính Stamina như bắn bình thường — giờ miễn PHÍ HOÀN TOÀN
    // (cả Stamina) khi ammotype: repeat.
    const isRepeatAmmo = ammoTypeNormalized === "repeat";
    const staminaCost = isRepeatAmmo ? 0 : (isEyeOfHorus ? totalVolleysForStamina * 20 : WEAPON_STAMINA_COST[player.weaponWeight] * hitCount);
    if (player.currentStamina < staminaCost) {
      throw new Error(isEyeOfHorus
        ? `Không đủ Stamina — Eye Of Horus tốn 20 Sta/volley — tổng ${totalVolleysForStamina} volley (cộng dồn qua ${previews.length} target) = ${staminaCost} Sta, còn ${player.currentStamina}.`
        : `Không đủ Stamina — cần ${staminaCost} (${hitCount} hit × ${WEAPON_STAMINA_COST[player.weaponWeight]}/hit vũ khí ${player.weaponWeight}), còn ${player.currentStamina}.`);
    }
    // eyeOfHorusAmmo — GAP ĐÃ SỬA (xác nhận trực tiếp, ĐÍNH CHÍNH lại lần trước):
    // "repeat ammo miễn ammo từ nội tại đó" — Repeat Ammo giờ MIỄN HOÀN TOÀN cả
    // pool nội tại này (không chỉ Stamina/ammo-inventory như hiểu nhầm trước
    // đó) — "vẫn cần 1 charge guard/evade/parry nữa" ở lần xác nhận trước chỉ
    // nói về charge phòng thủ của TARGET (đã xử lý đúng qua hitsPerCharge=9/
    // volley), không liên quan gì tới ammo của ATTACKER.
    if (isEyeOfHorus && !isRepeatAmmo && (player.eyeOfHorusAmmo ?? 8) < totalVolleysForStamina) {
      throw new Error(`Không đủ Ammo nội tại của Eye Of Horus — cần ${totalVolleysForStamina} (còn ${player.eyeOfHorusAmmo ?? 8}/8) — phải đợi hết turn để reset về 8.`);
    }

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "attack",
      attackerId: playerId, attackerType: "player",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: p.target.type, calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill, eyeOfHorusTremorChargeAmount: p.eyeOfHorusTremorChargeAmount, eyeOfHorusNewCount: p.eyeOfHorusNewCount })),
      // GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3 — dmgStr hiển thị: Eye Of Horus giờ có
      // thể khác nhau MỖI target trong AOE (count riêng từng cái) — nếu chỉ 1
      // target hoặc tất cả cùng công thức, hiện như cũ; nếu KHÁC NHAU, liệt kê
      // rõ từng target để tránh hiểu lầm.
      dmgStr: isEyeOfHorus
        ? (previews.every(p => p.targetDmgStr === previews[0].targetDmgStr)
          ? previews[0].targetDmgStr
          : previews.map(p => `${p.target.label ?? p.target.id}: ${p.targetDmgStr}`).join(" | "))
        : dmgStr,
      staminaCost, isM1: true, defenseBypass,
      isEyeOfHorusFixedBurst: isEyeOfHorus, eyeOfHorusVolleyCount: totalVolleysForStamina, isRepeatAmmo,
      // Lưu lại kết quả verify — encconfirmall áp dụng emotionDelta + set cooldown
      // THẬT lúc confirm (không phải lúc declare — khớp nguyên tắc "chưa gì là thật
      // cho tới khi GM xác nhận"). refLink/refSnippet/skillRollEmbed chỉ để HIỂN THỊ.
      // emotionDelta = TỔNG của delta tự roll skill (Max/Min dice) + manualCoin (GM/
      // player tự khai từ Clash/giết địch/đồng đội chết — bot không tự detect được).
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin, orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
      lightCost: verify.lightCost, sanityCost: verify.sanityCost, effectiveAmmoType, effectiveBulletType,
    });
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 turn act bao nhiêu lần cũng được miễn
    // là đủ tài nguyên") — KHÔNG còn tự động advance turn sau MỖI hành động —
    // announceCurrentTurn bên dưới sẽ tự resend đúng dropdown cho CHÍNH người
    // này (vì currentTurnIndex không đổi) — turn chỉ thực sự chuyển khi họ chủ
    // động chọn "Kết thúc lượt" (xem sub === "pass" / value === "endmyturn").
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
    if (!hasEncounterStarted(encounter)) {
      throw new Error("⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước khi ai đó có thể hành động.");
    }
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
    // "Waltz In Black": tính 1 lần (dùng target đầu tiên — skill này không AOE)
    // rồi áp cho CẢ dmgStr lẫn Unevadeable — xem comment đầy đủ ở
    // computeAttackerPerkContext (attacker-perk-context.js). BUG ĐÃ SỬA: "diceMul"
    // (tham số của calcMathCore) CHỈ có tác dụng khi dmgStr có tag "Dice" đặc biệt
    // (VD "1Dice11S") — với dmgStr thông thường ("11S") nó HOÀN TOÀN không nhân
    // gì cả (đã verify trực tiếp — diceMul=1 và diceMul=3 cho CÙNG totalDmg).
    // Chuyển sang nhân TRỰC TIẾP giá trị base trong dmgStr string bằng regex.
    const waltzInBlackApplies = verify.skillKey === "waltz in black" && targets[0]?.combatant?.waltzInWhiteHitLastRound;
    if (waltzInBlackApplies) defenseBypass.blockEvade = true;
    const previews = targets.map(t => {
      const isMiddleSkill = skillNameRaw ? MIDDLE_SYNDICATE_SKILLS.has(skillNameRaw.trim().toLowerCase()) : false;
      const perkCtx = computeAttackerPerkContext(player, t.combatant, dmgStr, { isM1: false, attackerId: playerId, targetId: t.id, isMiddleSkill, skillKey: verify.skillKey });
      // Nhân base value x3 TRỰC TIẾP trong dmgStr (SAU dmgStrRewritten, để giữ
      // nguyên các tag khác perkCtx có thể đã thêm, VD Cinq Association's Crit).
      const effectiveDmgStr = waltzInBlackApplies
        ? perkCtx.dmgStrRewritten.replace(/([\d.]+)(?=(?:x[\d.]+)?(?:\+[\d.]+%?)?\s*(?:Dice)?[BPSbps])/gi, (m) => (parseFloat(m) * 3).toString())
        : perkCtx.dmgStrRewritten;
      const defReductionPct = computeDefenderDmgReduction(t.combatant, { isM1: false, isMiddleSkill, attackerId: playerId });
      const mangBonusPct = player.shinMangActive ? player.shinMangRounds * 10 : 0;
      const haouRuptureCheck = !resStr && (t.combatant.haouRupture ?? 0) > 0 ? haouRuptureResStr(t.combatant) : null;
      const finalResStr = resStr || (haouRuptureCheck?.applied ? haouRuptureCheck.resStr : (player.shinMangActive ? trueDmgResStr(t.combatant) : combatantResStr(t.combatant)));
      const calcOpts = {
        dmgStr: effectiveDmgStr,
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
        poiseInit: player.poise, chargeInit: player.charge,
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
      const finalDmgAfterReduction = preview.totalDmg * saturateDR(1 - defReductionPct / 100);
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill, haouRuptureApplied: haouRuptureCheck?.applied ?? false };
    });

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "hit",
      attackerId: playerId, attackerType: "player",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: p.target.type, calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill })),
      dmgStr, defenseBypass,
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin, orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
      lightCost: verify.lightCost, sanityCost: verify.sanityCost,
    });
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 turn act bao nhiêu lần cũng được miễn
    // là đủ tài nguyên") — KHÔNG còn tự động advance turn sau MỖI hành động —
    // announceCurrentTurn bên dưới sẽ tự resend đúng dropdown cho CHÍNH người
    // này (vì currentTurnIndex không đổi) — turn chỉ thực sự chuyển khi họ chủ
    // động chọn "Kết thúc lượt" (xem sub === "pass" / value === "endmyturn").
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
    if (!hasEncounterStarted(encounter)) {
      throw new Error("⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước khi ai đó có thể hành động.");
    }
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
      const isMiddleSkill = skillNameRaw ? MIDDLE_SYNDICATE_SKILLS.has(skillNameRaw.trim().toLowerCase()) : false;
      const perkCtx = computeAttackerPerkContext(enemy, t.combatant, dmgStr, { isM1: false, attackerId: enemyKey, targetId: t.id, isMiddleSkill });
      const defReductionPct = computeDefenderDmgReduction(t.combatant, { isM1: false, isMiddleSkill, attackerId: enemyKey });
      const haouRuptureCheck = (t.combatant.haouRupture ?? 0) > 0 ? haouRuptureResStr(t.combatant) : null;
      const calcOpts = {
        dmgStr: perkCtx.dmgStrRewritten, resStr: haouRuptureCheck?.applied ? haouRuptureCheck.resStr : combatantResStr(t.combatant),
        bonusPct: perkCtx.bonusPct, critMul: perkCtx.critMul, critDiv: perkCtx.critDivOverride ?? undefined,
        sanityBonusPct: getEffectiveSanityForDiceBonus(enemy),
        poiseInit: enemy.poise, chargeInit: enemy.charge,
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
      const finalDmgAfterReduction = preview.totalDmg * saturateDR(1 - defReductionPct / 100);
      return { target: t, calcOpts, preview, defReductionPct, finalDmgAfterReduction, instantKill: perkCtx.instantKill, haouRuptureApplied: haouRuptureCheck?.applied ?? false };
    });

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    encounter.pendingActions = encounter.pendingActions ?? [];
    encounter.pendingActions.push({
      id: pendingId, kind: "enemyattack",
      attackerId: ekey, attackerType: "enemy",
      targets: previews.map(p => ({ targetId: p.target.id, targetType: "player", calcOpts: p.calcOpts, preview: p.preview, defReductionPct: p.defReductionPct, instantKill: p.instantKill })),
      dmgStr, defenseBypass,
      skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: (verify.emotionDelta ?? 0) + manualCoin, orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false,
      skillRollEmbed: verify.skillRollEmbed, refSnippet: verify.refSnippet, refLink: verify.refLink,
      lightCost: verify.lightCost, sanityCost: verify.sanityCost,
    });
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 turn act bao nhiêu lần cũng được miễn
    // là đủ tài nguyên") — KHÔNG còn tự động advance turn sau MỖI hành động —
    // announceCurrentTurn bên dưới sẽ tự resend đúng dropdown cho CHÍNH người
    // này (vì currentTurnIndex không đổi) — turn chỉ thực sự chuyển khi họ chủ
    // động chọn "Kết thúc lượt" (xem sub === "pass" / value === "endmyturn").
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
const { parseSkillCooldownTurns, parseSkillCost, extractDefenseBypassTags, mergeDefenseBypassTags, forceStagger, resolveSkillVerification } = require("./skill-verification")({ findSkill, hasPerk, isEgoSkill, buildSkillRollResult, client, ENCOUNTER_SANITY_MAX, annotateLinesWithEmotion, autoBuildDmgStrFromSkillRoll, r, combatantResStr, findWeaponAnywhere });
const { resolveOnePendingAction } = require("./resolve-pending-action")({ BLEED_MAX, BURN_MAX, CHARGE_MAX, ENCOUNTER_SANITY_MAX, HEMORRHAGE_MAX, POISE_MAX, TREMOR_MAX, WEAPON_DEFENSE_HITS, advanceCombatantTurn, applyDeathPenalty, applyEmotionDelta, applyEvadeSuccessPerks, applyParrySuccessPerks, applySanityGain, calcMathCore, checkStaggerPanic, combatantResStr, computeAttackerPerkContext, computeDefenderDmgReduction, doPlayerAttack, findSkill, findWeaponAnywhere, forceStagger, getPlayerDataWithSlot, hasPerk, log, performGuardEvade, r, resolveCombatant, resolveSkillVerification, rollInjury, saturateDR, savePlayerData }); // ĐÃ TÁCH sang file riêng (resolve-pending-action.js) — đặt SAU tất cả 33 dependency của nó để tránh TDZ
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
/** buildEnemyTargetOptions — GAP ĐÃ SỬA (xác nhận trực tiếp: "phần target ở toàn
 *  bộ dropdown nên sửa lại thành cho bấm thay vì là key... giống 1 game hơn") —
 *  dùng CHUNG cho attack/critical/hit/followup — liệt kê enemy CÒN SỐNG bằng TÊN
 *  THẬT (không phải gõ key tay), + option "Tất cả (AOE)" CHỈ khi skill/M1 THẬT
 *  SỰ AOE KHÔNG giới hạn (allowAllOption param) — BUG BẢO MẬT ĐÃ SỬA 2 LẦN (xác
 *  nhận trực tiếp): lần 1 — trước đây LUÔN thêm option "all" bất kể có phải AOE
 *  hay không; lần 2 — "có 1 số page/skill là aoe 2~4 người chứ không phải là
 *  aoe full" — dù đã gate isAoe, option "all" vẫn hiện cho skill giới hạn N
 *  người, và chọn "all" sẽ BỎ QUA HOÀN TOÀN giới hạn N đó (resolveTargets coi
 *  "all" là TOÀN BỘ enemy). Giờ allowAllOption CHỈ true khi maxTargets thật sự
 *  = Infinity (không giới hạn) — skill "[AOE N người]" KHÔNG có option "all".
 */
function buildEnemyTargetOptions(encounter, allowAllOption = false) {
  const aliveEnemyKeys = Object.keys(encounter?.enemies ?? {}).filter(k => encounter.enemies[k].currentHp > 0);
  const options = aliveEnemyKeys.map(k =>
    new StringSelectMenuOptionBuilder().setLabel(`${encounter.enemies[k].name} (${k})`.slice(0, 100)).setValue(k)
  );
  if (allowAllOption) options.push(new StringSelectMenuOptionBuilder().setLabel("🎯 Tất cả (AOE)").setValue("all"));
  return options.slice(0, 25);
}
// Nhận diện AOE THẬT từ chính text roll() (tag "[AOE...]" — xem skills.js) —
// KHÔNG đoán mò, đọc trực tiếp từ nội dung skill đã roll thật. GAP ĐÃ SỬA (xác
// nhận trực tiếp: "có 1 số page/skill là aoe 2~4 người chứ không phải là aoe
// full") — trước đây coi MỌI "[AOE...]" là AOE KHÔNG giới hạn (cho phép chọn
// TỐI ĐA tất cả enemy hiện có) — SAI với các skill giới hạn cụ thể (VD "[AOE 3
// người]"/"[AOE 5 mục tiêu]") — giờ đọc THÊM con số nếu có, trả về maxTargets
// riêng để cap đúng số lượng chọn được (không giới hạn nếu tag không có số —
// VD "[AOE]"/"[AOE tất cả]"/"[AOE/True Dmg]").
function parseAoeInfo(text) {
  const t = text ?? "";
  const isAoe = /\[AOE\b/i.test(t);
  if (!isAoe) return { isAoe: false, maxTargets: 1 };
  const countMatch = t.match(/\[AOE\s+(\d+)\s+(?:người|mục tiêu)\]/i);
  return { isAoe: true, maxTargets: countMatch ? parseInt(countMatch[1], 10) : Infinity };
}

/** parsePerHitBypass — GAP ĐÃ SỬA (xác nhận trực tiếp: "Durandal crit có 3
 *  hit... Hit 1 unblockable, Hit 2 không có tag gì, Hit 3 guard break. Thế
 *  nhưng lúc hiện responsive guard thì phần guard bị chặn lại") — BUG THẬT:
 *  extractDefenseBypassTags() trước đây chạy trên TOÀN BỘ skillRollEmbed
 *  description (3 dòng dice ghép lại) — regex "/\[Unblockable\]/" tìm thấy tag
 *  này ở BẤT KỲ đâu trong text, dù chỉ ở 1 dòng — khiến CẢ 3 hit bị coi là
 *  Unblockable (chặn Guard cho TẤT CẢ, kể cả hit 2/3 không xứng đáng bị chặn).
 *  Hàm này tách TỪNG dòng dice THẬT riêng biệt (cùng logic lọc với
 *  autoBuildDmgStrFromSkillRoll: dòng bắt đầu "<:DiceN:" VÀ có tag kiểu dmg
 *  [Slash/Blunt/Pierce] — bỏ qua dòng điều kiện/mô tả không tính là hit thật),
 *  trích bypass tag RIÊNG cho từng dòng đó — trả về mảng đúng `totalHits` phần
 *  tử. Với M1 (không có skillRollEmbed, dmgStr đơn thuần) — mọi hit dùng CHUNG
 *  1 bypass (từ tag gõ tay, nếu có — M1 hiếm khi có tag đặc biệt riêng).
 */
function parsePerHitBypass(skillRollEmbedDescription, manualTagsRaw, totalHits) {
  const manualBypass = mergeDefenseBypassTags({ blockEvade: false, blockGuard: false, blockParry: false, guardBreak: false, unclashable: false }, manualTagsRaw);
  if (!skillRollEmbedDescription) {
    // M1 hoặc không có roll text — mọi hit dùng chung bypass từ tag gõ tay.
    return Array.from({ length: totalHits }, () => ({ ...manualBypass }));
  }
  const perLine = [];
  for (const line of skillRollEmbedDescription.split("\n")) {
    if (!/^<:Dice\d+:/.test(line)) continue;
    const hasTypeTag = /\[<:(?:Slash|Blunt|Pierce):\d+>(?:Slash|Blunt|Pierce)\]/.test(line);
    if (!hasTypeTag) continue; // dòng điều kiện/mô tả, không phải hit thật — bỏ qua giống autoBuildDmgStrFromSkillRoll
    const lineBypass = extractDefenseBypassTags(line);
    // Gộp tag gõ tay (áp dụng cho MỌI hit, cộng thêm — không thể tắt tag dòng đó tự có).
    perLine.push({
      blockEvade: lineBypass.blockEvade || manualBypass.blockEvade,
      blockGuard: lineBypass.blockGuard || manualBypass.blockGuard,
      blockParry: lineBypass.blockParry || manualBypass.blockParry,
      guardBreak: lineBypass.guardBreak || manualBypass.guardBreak,
      unclashable: lineBypass.unclashable || manualBypass.unclashable,
    });
  }
  if (perLine.length === 0) return Array.from({ length: totalHits }, () => ({ ...manualBypass }));
  // Nếu số dòng parse được KHÔNG khớp totalHits (VD 1 dòng dice đại diện nhiều
  // hit qua diceMul/multiplier) — lặp lại phần tử CUỐI cho các hit dư, an toàn
  // hơn là để mảng ngắn hơn totalHits (có thể gây lỗi truy cập ngoài mảng).
  const result = [];
  for (let i = 0; i < totalHits; i++) result.push(perLine[Math.min(i, perLine.length - 1)]);
  return result;
}

const { performGachaPull, performPityExchange, buildGachaPanelEmbed, buildGachaPanelButtons } = require("./gacha-system")({ ActionRowBuilder, ButtonBuilder, ButtonStyle, GACHA_BANNERS, GACHA_COST_PER_PULL, GACHA_PITY_MAX, GACHA_RATES, VALID_BOOKS, formatNumber, getPlayerDataWithSlot, isBannerActive, r, rollGachaOnce, savePlayerData, withLock }); // ĐÃ TÁCH sang file riêng (gacha-system.js)

const { finalizeReactiveChoice, performEndTurn, announceCurrentTurn, sendThirdPartyClashPrompts, sendYourShieldPrompts, applyDullahanParryCounter, sendReactiveDefensePrompt } = require("./reactive-defense")({ ActionRowBuilder, ButtonBuilder, ButtonStyle, POISE_MAX, Redis, WEAPON_DEFENSE_HITS, advanceCombatantTurn, advanceToNextTurnHolder, buildBossActionPanel, buildEncounterActionPanel, buildEncounterBoardEmbed, calcMathCore, checkStaggerPanic, client, combatantResStr, computeDefenseOptions, determineTurnOrder, encounterKey, findSkill, getEncounter, hasPerk, log, parsePerHitBypass, parseSkillCost, r, resolveCombatant, resolveOnePendingAction, saveEncounter, validateAndRerollPrescript, withLock }); // ĐÃ TÁCH sang file riêng (reactive-defense.js) — đặt TRƯỚC message-create-handler.js vì handler đó cần announceCurrentTurn/performEndTurn

const handleMessageCreate = require("./message-create-handler")({ ADMIN_IDS, ActionRowBuilder, BOOK_GRANTS, BRANCH_KEYS, ButtonBuilder, ButtonStyle, CRAFT_RECIPES, EGO_TIER_SLOT_ORDER, ENCOUNTER_DEFAULT_MAX_STAMINA, ENCOUNTER_KEY_MAX_LENGTH, ENCOUNTER_NAME_MAX_LENGTH, ENCOUNTER_STAMINA_REGEN_PER_TURN, EXP_MAX, GACHA_BANNERS, GACHA_COST_PER_PULL, GACHA_PITY_MAX, GACHA_RATES, GRADE_MAX, GRADE_MIN, MAX_PROFILES, MINOR_INJURIES, OPEN_COUNT_MAX, PARRY_MAX_ROLLS, PERK_BRANCH, PERK_POINT_COSTS, POISE_MAX, PRESCRIPT_TABLE, PROFILE_EMOJIS, PROFILE_LABELS, PROFILE_NAME_MAX_LENGTH, Redis, STATUS_CAPS_SHARED, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, UNIVERSALLY_KNOWN_WEAPONS, VALID_BOOKS, VALID_ITEMS, advanceCombatantTurn, advanceToNextTurnHolder, announceCurrentTurn, appendActionLog, applyClashLossSanity, applyDeathPenalty, applyEmotionDelta, applySanityGain, applyStatusEntries, buildBalanceEmbed, buildBookChoiceComponents, buildBossActionPanel, buildDothihelpEmbed, buildEncounterActionPanel, buildEncounterBoardEmbed, buildGiveConfirmRow, buildGivePreviewLines, buildPendingListText, buildProfileInfoEmbed, buildRollDescription, buildRtparryLinkButton, buildSkillListResult, buildSkillRollResult, buildTurnOrderText, calcBranchPointsAllocated, calcExpForGrade, calcGrade, calcInjuryMaxHpPenalty, calcMath, calcSkillTreePointsEarned, checkStaggerPanic, clampExpWithLunacy, client, computeAttackerPerkContext, createCombatant, createRtparryToken, deleteEncounter, determineTurnOrder, doEnemyAttack, doPlayerAttack, doPlayerHit, encounterKey, executeCraft, executeReadBookChoose, executeRemove, extractDefenseBypassTags, fetchInventoryReply, findAccessory, findBook, findExclusiveConflict, findItem, findItemAdmin, findOutfit, findSkill, findWeapon, findWeaponAnywhere, formatEmotionSummary, formatNumber, getActionLogIcon, getActiveProfileSlot, getEffectiveCurrentHp, getEgoTier, getEncounter, getParryClashPenalty, getPlayerData, getPlayerDataWithSlot, getProfileNames, handleOpenChipboardCache, handleOpenRandomBook, handleOpenSealedBook, hasEncounterStarted, hasPerk, insertIntoTurnOrderMidRound, isBannerActive, isEgoSkill, isOnCooldown, isValidBookChoice, log, normalizeEnemyKey, normalizeWeaponWeight, parseBatchEntries, parseKeyValues, parseOpenCount, performEndTurn, performFollowUp, performGachaPull, performGuardEvade, performManifestEgo, performOvercharge, performParry, performShinMang, processDailyClaimForUser, r, redis, registerPendingGive, resolveCombatant, resolveEquipTarget, resolveGmLinkedChannel, resolveProfileLabel, restoreInjuryMaxHp, runParryRolls, saturateBonusPct, saturateDR, saveEncounter, savePlayerData, setActiveProfileSlot, setProfileName, startEmotionTracking, stopEmotionTracking, validateAndRerollPrescript, validateMathInputs, webParrySessions, withLock }); // ĐÃ TÁCH sang file riêng (message-create-handler.js)
client.on("messageCreate", handleMessageCreate);

// ─── BUTTON INTERACTIONS ──────────────────────────────────────────────────────


const registerInteractionHandlers = require("./interaction-handlers")({ ADMIN_IDS, ActionRowBuilder, BOOK_GRANTS, BRANCH_KEYS, ButtonBuilder, ButtonStyle, CRAFT_RECIPES, EGO_TIER_SLOT_ORDER, ENCOUNTER_DEFAULT_MAX_STAMINA, ENCOUNTER_KEY_MAX_LENGTH, ENCOUNTER_STAMINA_REGEN_PER_TURN, GACHA_BANNERS, GACHA_PITY_MAX, MAX_PROFILES, MessageFlags, ModalBuilder, OPEN_COUNT_MAX, PARRY_MAX_ROLLS, PERK_BRANCH, PERK_POINT_COSTS, PROFILE_EMOJIS, PROFILE_LABELS, PROFILE_NAME_MAX_LENGTH, Redis, STATUS_CAPS_SHARED, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TREMOR_VARIANT_MAX, TextInputBuilder, TextInputStyle, UNIVERSALLY_KNOWN_WEAPONS, WEAPON_DEFENSE_HITS, advanceToNextTurnHolder, announceCurrentTurn, appendActionLog, applyClashLossSanity, applyDullahanParryCounter, applyEmotionDelta, applySanityGain, applyStatusEntries, autoBuildDmgStrFromSkillRoll, buildBalanceEmbed, buildBookChoiceComponents, buildBossActionPanel, buildDothihelpEmbed, buildEncounterActionPanel, buildEncounterBoardEmbed, buildEnemyTargetOptions, buildGachaPanelButtons, buildGachaPanelEmbed, buildGiveConfirmRow, buildGivePreviewLines, buildProfileInfoEmbed, buildRollDescription, buildRtparryLinkButton, buildSkillListResult, buildSkillRollResult, buildTurnOrderText, calcBranchPointsAllocated, calcMath, calcMathCore, calcSkillTreePointsEarned, checkStaggerPanic, client, combatantResStr, computeDefenseOptions, createCombatant, createRtparryToken, doEnemyAttack, doPlayerAttack, doPlayerHit, encounterKey, executeCraft, executeGive, executeReadBookChoose, executeRemove, fetchInventoryReply, finalizeReactiveChoice, findAccessory, findBook, findExclusiveConflict, findItem, findItemAdmin, findOutfit, findSkill, findWeaponAnywhere, formatNumber, getActiveProfileSlot, getBookGroupChoices, getEgoTier, getEncounter, getParryClashPenalty, getPlayerData, getPlayerDataWithSlot, getProfileNames, handleOpenChipboardCache, handleOpenRandomBook, handleOpenSealedBook, hasEncounterStarted, insertIntoTurnOrderMidRound, isBannerActive, isCurrentTurnHolder, isOnCooldown, log, normalizeEnemyKey, normalizeWeaponWeight, parseAoeInfo, parseBatchEntries, parsePerHitBypass, parseSkillCooldownTurns, parseSkillCost, parseStatusFreeText, pendingGives, performEndTurn, performFollowUp, performGachaPull, performGuardEvade, performManifestEgo, performOvercharge, performParry, performPityExchange, performShinMang, processDailyClaimForUser, r, registerPendingGive, replyOnCooldown, resolveCombatant, resolveOnePendingAction, resolveProfileLabel, resolveSkillVerification, resolveTargets, runParryRolls, saveEncounter, savePlayerData, sendReactiveDefensePrompt, setActiveProfileSlot, setProfileName, validateMathInputs, webParrySessions, withDoubleLock, withLock }); // ĐÃ TÁCH sang file riêng (interaction-handlers.js)
registerInteractionHandlers();

const getBotReady = () => botReady; // closure - LUÔN đọc giá trị MỚI NHẤT của "let botReady" (mutated sau client.once("ready")), không "đóng băng" giá trị lúc gọi.
require("./express-routes")({ RTPARRY_MIN_HUMAN_MS, WEAPON_DEFENSE_HITS, advanceCombatantTurn, app, autoBuildDmgStrFromSkillRoll, getBotReady, calcMathCore, client, combatantResStr, encounterKey, finalizeReactiveChoice, findSkill, getEncounter, log, parseSkillCooldownTurns, parseSkillCost, r, renderParryWebPage, resolveCombatant, resolveOnePendingAction, webParrySessions, withLock }); // ĐÃ TÁCH sang file riêng (express-routes.js)

client.login(TOKEN);

function gracefulShutdown(signal) {
  log("info", "shutdown", "system", `${signal} received, shutting down.`);
  clearInterval(cooldownCleanupTimer);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => log("error", "uncaughtException", "system", err.message, { stack: err.stack }));
process.on("unhandledRejection", (reason) => log("error", "unhandledRejection", "system", String(reason)));
