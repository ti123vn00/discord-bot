// index.js
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const express = require("express");
const { Redis } = require("@upstash/redis");

const app = express();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

if (!TOKEN) {
  console.warn("DISCORD_TOKEN is not set — Discord bot will not start.");
  process.exit(1);
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SANITY_MIN = -45;
const POISE_CRIT_BONUS_PER_STACK = 0.05;
const POISE_RESET_THRESHOLD = 1;
const POISE_MAX = 99;
const POISE_CRIT_HALVE = 0.5;
const SINKING_MAX = 99;
const RUPTURE_MAX = 99;

// ─── LEVELING ─────────────────────────────────────────────────────────────────
// Grade 9 (thấp nhất) → Grade 1 (cao nhất). Có 9 grade.
// EXP để lên từ grade X xuống grade X-1:
//   grade 9→8: 5 exp
//   grade 8→7: 10 exp
//   grade 7→6: 20 exp
//   ...nhân đôi mỗi lần
const GRADE_EXP_REQUIRED = {
  9: 5,    // cần 5 exp để lên grade 8
  8: 10,
  7: 20,
  6: 40,
  5: 80,
  4: 160,
  3: 320,
  2: 640,
  // grade 1 là max, không lên thêm
};
const GRADE_MAX = 1;
const GRADE_MIN = 9;

/**
 * Tính grade và exp dư dựa trên tổng exp tích lũy.
 * Trả về { grade, expInCurrentGrade, expNeeded }
 */
function calcGrade(totalExp) {
  let grade = GRADE_MIN; // bắt đầu từ grade 9
  let remaining = totalExp;

  while (grade > GRADE_MAX) {
    const needed = GRADE_EXP_REQUIRED[grade];
    if (needed === undefined) break; // grade 1, không lên nữa
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

/**
 * Tính tổng EXP tối thiểu cần để ĐẠT đúng targetGrade (không dư exp).
 * VD: calcExpForGrade(3) = 5+10+20+40+80+160 = 315
 */
function calcExpForGrade(targetGrade) {
  let total = 0;
  for (let g = GRADE_MIN; g > targetGrade; g--) {
    total += GRADE_EXP_REQUIRED[g] ?? 0;
  }
  return total;
}

// ─── ADMIN USER IDs ───────────────────────────────────────────────────────────
// Thêm Discord User ID của admin vào đây
const ADMIN_IDS = new Set([
  "208187560692940803", // ← thay bằng ID thật
  // thêm ID khác nếu cần
]);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// ─── VALID BOOKS ──────────────────────────────────────────────────────────────
const VALID_BOOKS = [
  "Random Book",
  "Sealed Book Cache",
  "Book of Choice",
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
  "Chipboard MK1",
  "Chipboard MK2",
  "Chipboard MK3",
  "Chipboard MK4",
  "Chipboard MK5",
];

// Tìm tên sách khớp (case-insensitive)
function findBook(input) {
  const lower = input.toLowerCase().trim();
  return VALID_BOOKS.find(b => b.toLowerCase() === lower) ?? null;
}


function parseKeyValues(input) {
  const map = {};
  const regex = /([A-Za-z]+)\s*:\s*([\s\S]*?)(?=\s+[A-Za-z]+\s*:|$)/gi;
  let match;
  while ((match = regex.exec(input)) !== null) {
    map[match[1].toLowerCase()] = match[2].trim();
  }
  return map;
}

function filterZeroFields(fields) {
  const ALWAYS_SHOW = new Set([
    "Final DMG",
    "Crit Rate",
    "CritMul",
    "% Dmg Bonus",
    "Res Multipliers",
  ]);
  return fields.filter((f) => {
    if (ALWAYS_SHOW.has(f.name)) return true;
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

function validateMathInputs({ bonusPct, sanityBonusPct, critMul, startingCritRate, diceMul, sinkingInit, ruptureInit, sanityInit }) {
  const errors = [];
  if (startingCritRate < 0 || startingCritRate > 100) errors.push("CritRate phải từ 0–100%");
  if (critMul < 1) errors.push("CritMul phải ≥ 1");
  if (diceMul < 0) errors.push("DiceMul phải ≥ 0");
  if (sinkingInit < 0 || sinkingInit > SINKING_MAX) errors.push(`Sinking phải từ 0–${SINKING_MAX}`);
  if (ruptureInit < 0 || ruptureInit > RUPTURE_MAX) errors.push(`Rupture phải từ 0–${RUPTURE_MAX}`);
  if (sanityInit < SANITY_MIN) errors.push(`Sanity phải ≥ ${SANITY_MIN}`);
  return errors;
}

// ─── PLAYER DATA HELPERS ──────────────────────────────────────────────────────

/**
 * Lấy dữ liệu player từ Redis.
 * Schema: { exp, ahn, inventory: { [bookName]: count } }
 */
async function getPlayerData(userId) {
  const key = `player:${userId}`;
  try {
    const raw = await redis.get(key);
    if (!raw) return { exp: 0, ahn: 0, inventory: {} };
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data.inventory) data.inventory = {};
    return data;
  } catch {
    return { exp: 0, ahn: 0, inventory: {} };
  }
}

async function savePlayerData(userId, data) {
  const key = `player:${userId}`;
  await redis.set(key, JSON.stringify(data));
}

/** Format số lớn: 1000000 → "1,000,000" */
function formatNumber(n) {
  return Math.floor(n).toLocaleString("en-US");
}

// ─── CORE LOGIC ───────────────────────────────────────────────────────────────

function calcMath(opts) {
  const {
    dmgStr = "",
    resStr = "",
    bonusPct = 0,
    sanityBonusPct = 0,
    critMul = 1,
    startingCritRate = 0,
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
  let currentCritRate = startingCritRate;
  let totalDmg = 0;
  let totalPoise = 0;
  let enemySinking = Math.min(sinkingInit, SINKING_MAX);
  let enemyRupture = Math.min(ruptureInit, RUPTURE_MAX);
  const instanceResults = [];

  for (const dmgObj of dmgValues) {
    const { value: dmg, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply, effectsStr } = dmgObj;
    const currentRes = resValues[dmgType] ?? 1.0;

    let critChance = currentCritRate + totalPoise * POISE_CRIT_BONUS_PER_STACK;
    let didCrit = false;
    const critMatch = effectsStr ? effectsStr.match(/\+Crit(\d+)/i) : null;
    const baseCritRate = critMatch ? parseInt(critMatch[1]) / 100 : null;
    if (baseCritRate !== null) {
      critChance = Math.min(currentCritRate + baseCritRate + totalPoise * POISE_CRIT_BONUS_PER_STACK, 1);
    }
    if (critChance >= 1) didCrit = true;
    else didCrit = Math.random() < critChance;

    const multiplier = didCrit ? critMul : 1;
    const bonusFactor = 1 + bonusPct / 100 + (isDice ? sanityBonusPct / 100 : 0) + extraPct / 100;
    let instanceDmg = dmg * bonusFactor * multiplier * currentRes;
    if (isDice) instanceDmg *= diceMul;

    let sinkingBonus = 0;
    if (enemySinking > 0) {
      sanity = Math.max(sanity - 1, SANITY_MIN);
      if (sanity <= SANITY_MIN || isNaN(sanity)) {
        instanceDmg += enemySinking;
        sinkingBonus = enemySinking;
      }
      enemySinking = Math.max(enemySinking - 1, 0);
    }

    let ruptureUsed = false;
    if (enemyRupture > 0 && currentRes < 1) {
      instanceDmg = dmg * bonusFactor * multiplier;
      if (isDice) instanceDmg *= diceMul;
      ruptureUsed = true;
      enemyRupture = Math.max(enemyRupture - 1, 0);
    }

    totalDmg += instanceDmg;
    if (poiseToApply > 0) totalPoise += poiseToApply;
    if (sinkingToApply > 0) enemySinking = Math.min(enemySinking + sinkingToApply, SINKING_MAX);
    if (ruptureToApply > 0) enemyRupture = Math.min(enemyRupture + ruptureToApply, RUPTURE_MAX);

    instanceResults.push({ dmg, dmgType, didCrit, critRateUsed: critChance, instanceDmg, ruptureUsed, sinkingBonus, sinkingApplied: sinkingToApply, ruptureApplied: ruptureToApply, poiseApplied: poiseToApply, effectsStr, isDice });

    if (didCrit && critDiv) {
      totalPoise *= POISE_CRIT_HALVE;
      if (totalPoise < POISE_RESET_THRESHOLD) totalPoise = 0;
      if (totalPoise > POISE_MAX) totalPoise = POISE_MAX;
      if (baseCritRate === null || baseCritRate < 1) {
        currentCritRate /= 2;
        if (currentCritRate < 0.05) currentCritRate = 0;
      }
    }
  }

  const finalCritRate = currentCritRate;
  const critCount = instanceResults.filter((r) => r.didCrit).length;

  const breakdownLines = instanceResults.map((r, i) => {
    const rateStr = `${(r.critRateUsed * 100).toFixed(1)}%`;
    const critLabel = r.didCrit ? "✅" : "❌";
    let extraInfo = "";
    if (r.sinkingBonus > 0) extraInfo += ` +${r.sinkingBonus} dmg từ Sinking`;
    if (r.sinkingApplied > 0) extraInfo += ` | áp ${r.sinkingApplied} Sinking`;
    if (r.ruptureUsed) extraInfo += " | xuyên Res từ Rupture";
    if (r.ruptureApplied > 0) extraInfo += ` | áp ${r.ruptureApplied} Rupture`;
    if (r.poiseApplied > 0) extraInfo += ` | +${r.poiseApplied} Poise (+${(r.poiseApplied * 5).toFixed(1)}% Crit)`;
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

  const critRateDisplay =
    critDiv && critCount > 0
      ? `${(startingCritRate * 100).toFixed(1)}% → ${(finalCritRate * 100).toFixed(2)}% (after ${critCount} crit${critCount > 1 ? "s" : ""})`
      : `${(startingCritRate * 100).toFixed(1)}%`;

  const resDisplay = `B: ${resValues.B}x | P: ${resValues.P}x | S: ${resValues.S}x`;

  const allFields = [
    { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
    { name: "% Dmg Bonus", value: bonusPct.toFixed(1) + "%", inline: true },
    { name: "Sanity % DMG Bonus", value: sanityBonusPct.toFixed(1) + "%", inline: true },
    { name: "CritMul", value: critMul + "x", inline: true },
    { name: "Res Multipliers", value: resDisplay, inline: true },
    { name: "Dice Multiplier", value: diceMul.toFixed(2) + "x", inline: true },
    { name: "Crit Rate", value: critRateDisplay, inline: true },
    { name: "Crit Divide", value: critDiv ? "Yes" : "No", inline: true },
    { name: "Final DMG", value: totalDmg.toFixed(3), inline: false },
    { name: "Enemy's Sanity", value: sanity.toString(), inline: true },
    { name: "Poise Counts", value: totalPoise.toString(), inline: true },
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

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`Bot đã online với tên ${client.user.tag}`);
});

// ─── PREFIX COMMANDS ──────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // ── -parry ──
  if (message.content.startsWith("-parry")) {
    const args = message.content.replace("-parry", "").trim().split(/\s+/);
    let rolls = 1;
    const parsed = parseInt(args[0]);
    if (!isNaN(parsed) && parsed > 0) rolls = parsed;
    if (rolls > 50) {
      message.reply("❌ Số lần roll tối đa là 50.");
      return;
    }

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
      if (isSuccess) successCount++;
      else failCount++;

      const rerollNote = rerolls > 0 ? ` *(Hòa và roll lại ${rerolls} lần)*` : "";
      const result = isSuccess ? "Parry thành công ✅" : "Parry thất bại ❌";
      lines.push(`Lần ${i + 1}: Attacker: \`${atk}\` vs Defender: \`${pry}\`${rerollNote} → ${result}`);
    }

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
    const userId = message.author.id;
    const dailyKey = `daily:${userId}`;

    function getVNDateString() {
      const now = new Date();
      const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      return vnTime.toISOString().slice(0, 10);
    }

    function secondsUntilVNMidnight() {
      const now = new Date();
      const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const vnMidnight = new Date(Date.UTC(
        vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate(), 17, 0, 0, 0
      ));
      if (vnMidnight <= now) vnMidnight.setUTCDate(vnMidnight.getUTCDate() + 1);
      return Math.floor((vnMidnight - now) / 1000);
    }

    try {
      const raw = await redis.get(dailyKey);
      const dailyData = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      const today = getVNDateString();

      if (dailyData && dailyData.lastClaim === today) {
        const remaining = secondsUntilVNMidnight();
        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = remaining % 60;
        message.reply(
          `${message.author}, bạn đã nhận daily hôm nay rồi.\n` +
          `Thời gian còn lại đến reset: **${hours}h ${minutes}m ${seconds}s**.`
        );
      } else {
        const nowUtc = new Date();
        const vnNow = new Date(nowUtc.getTime() + 7 * 60 * 60 * 1000);
        const vnYesterday = new Date(vnNow);
        vnYesterday.setUTCDate(vnYesterday.getUTCDate() - 1);
        const yesterdayStr = vnYesterday.toISOString().slice(0, 10);

        let streak = dailyData && dailyData.lastClaim === yesterdayStr
          ? (dailyData.streak || 1) + 1
          : 1;

        const isWeekComplete = streak >= 7;

        const newDailyData = { lastClaim: today, streak: isWeekComplete ? 0 : streak };
        await redis.set(dailyKey, JSON.stringify(newDailyData), { ex: 86400 * 2 });

        // Cộng phần thưởng vào player data
        const EXP_REWARD = 5;
        const AHN_REWARD = 100000;
        const playerData = await getPlayerData(userId);
        playerData.exp = (playerData.exp ?? 0) + EXP_REWARD;
        playerData.ahn = (playerData.ahn ?? 0) + AHN_REWARD;
        playerData.inventory = playerData.inventory ?? {};
        playerData.inventory["Random Book"] = (playerData.inventory["Random Book"] ?? 0) + 1;

        if (isWeekComplete) {
          playerData.exp += 25;
          playerData.ahn += 400000;
          playerData.inventory["Sealed Book Cache"] = (playerData.inventory["Sealed Book Cache"] ?? 0) + 1;
        }

        await savePlayerData(userId, playerData);

        const displayStreak = isWeekComplete ? 7 : streak;
        const bar = Array.from({ length: 7 }, (_, i) => i < displayStreak ? "🟩" : "⬛").join("");

        let replyMsg =
          `🎉 ${message.author} đã điểm danh thành công!\n` +
          `> 📦 **5 Exp** | **100k Ahn** | **1 Random Book**\n` +
          `> 🔥 Streak: **${displayStreak}/7** ngày  ${bar}`;

        if (isWeekComplete) {
          replyMsg +=
            `\n\n🏆 **Hoàn thành streak 7 ngày!** Bạn nhận thêm **25 Exp**, **400k Ahn** và **1 Sealed Book Cache**!\n` +
            `> Streak đã reset, bắt đầu lại từ ngày 1 nhé!`;
        }

        message.reply(replyMsg);
      }
    } catch (err) {
      console.error("[daily] Redis error:", err);
      message.reply("❌ Có lỗi xảy ra, thử lại sau nhé.");
    }
    return;
  }

  // ── -balance ──
  if (message.content.startsWith("-balance")) {
    // Cho phép xem balance của người khác nếu mention, hoặc của chính mình
    let targetUser = message.mentions.users.first() ?? message.author;
    try {
      const data = await getPlayerData(targetUser.id);
      const { grade, expInCurrentGrade, expNeeded } = calcGrade(data.exp ?? 0);

      const totalBooks = Object.values(data.inventory ?? {}).reduce((a, b) => a + b, 0);

      const gradeDisplay = grade === GRADE_MAX
        ? `**Grade ${grade}** (MAX)`
        : `**Grade ${grade}** (${expInCurrentGrade}/${expNeeded} EXP → Grade ${grade - 1})`;

      // Progress bar grade (0–max EXP trong grade hiện tại)
      let progressBar = "";
      if (grade > GRADE_MAX && expNeeded) {
        const filled = Math.round((expInCurrentGrade / expNeeded) * 10);
        progressBar = "\n> " + "🟦".repeat(filled) + "⬛".repeat(10 - filled) + ` ${expInCurrentGrade}/${expNeeded}`;
      }

      message.reply({
        embeds: [{
          title: `💼 Thông tin của ${targetUser.displayName ?? targetUser.username}`,
          color: 0x5865f2,
          thumbnail: { url: targetUser.displayAvatarURL({ dynamic: true }) },
          fields: [
            { name: "🏅 Grade", value: gradeDisplay + progressBar, inline: false },
            { name: "✨ Tổng EXP", value: `**${formatNumber(data.exp ?? 0)}** EXP`, inline: true },
            { name: "💰 Ahn", value: `**${formatNumber(data.ahn ?? 0)}** Ahn`, inline: true },
            { name: "📚 Tổng sách", value: `**${totalBooks}** cuốn`, inline: true },
          ],
          footer: { text: "Dùng -inventory để xem chi tiết sách" },
        }],
      });
    } catch (err) {
      console.error("[balance] error:", err);
      message.reply("❌ Có lỗi xảy ra khi lấy dữ liệu.");
    }
    return;
  }

  // ── -inventory ──
  if (message.content.startsWith("-inventory")) {
    let targetUser = message.mentions.users.first() ?? message.author;
    try {
      const data = await getPlayerData(targetUser.id);
      const inv = data.inventory ?? {};
      const entries = Object.entries(inv).filter(([, count]) => count > 0);

      if (entries.length === 0) {
        message.reply(`📦 ${targetUser} không có sách nào trong kho.`);
        return;
      }

      // Sắp xếp theo tên
      entries.sort(([a], [b]) => a.localeCompare(b));

      // Nhóm thành dòng, mỗi dòng một cuốn
      const lines = entries.map(([name, count]) => `• **${name}** × ${count}`);
      const total = entries.reduce((s, [, c]) => s + c, 0);

      // Chia thành nhiều fields nếu quá dài
      const CHUNK = 20;
      const fields = [];
      for (let i = 0; i < lines.length; i += CHUNK) {
        fields.push({
          name: i === 0 ? "📚 Danh sách sách" : "​", // zero-width space cho field tiếp theo
          value: lines.slice(i, i + CHUNK).join("\n"),
          inline: false,
        });
      }
      fields.push({ name: "📊 Tổng cộng", value: `**${total}** cuốn`, inline: false });

      message.reply({
        embeds: [{
          title: `🎒 Inventory của ${targetUser.displayName ?? targetUser.username}`,
          color: 0xf0a500,
          fields,
        }],
      });
    } catch (err) {
      console.error("[inventory] error:", err);
      message.reply("❌ Có lỗi xảy ra khi lấy dữ liệu.");
    }
    return;
  }

  // ── -give ──
  // Admin: -give @user exp: 50 ahn: 200000 book: Random Book count: 3 grade: 3
  // Player: -give @user book: Random Book count: 2  (trừ từ kho của mình)
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

    // Parse input sau tên lệnh và mention
    const rawInput = message.content
      .replace("-give", "")
      .replace(/<@!?\d+>/, "")
      .trim();

    const kv = parseKeyValues(rawInput);

    const expGain = parseInt(kv["exp"] ?? "0", 10) || 0;
    const ahnGain = parseFloat(kv["ahn"] ?? "0") || 0;
    const bookRaw = kv["book"] ?? null;
    const bookCount = Math.max(1, parseInt(kv["count"] ?? "1", 10) || 1);
    const gradeTarget = kv["grade"] ? parseInt(kv["grade"], 10) : null;

    // Player thường chỉ được tặng sách, không được tặng exp/ahn/grade
    if (!isAdmin && (expGain !== 0 || ahnGain !== 0 || gradeTarget !== null)) {
      message.reply("❌ Bạn chỉ có thể tặng sách cho người khác.");
      return;
    }

    // Validate grade (admin only)
    if (gradeTarget !== null) {
      if (isNaN(gradeTarget) || gradeTarget < GRADE_MAX || gradeTarget > GRADE_MIN) {
        message.reply(`❌ Grade phải từ ${GRADE_MAX}–${GRADE_MIN}.`);
        return;
      }
    }

    // Validate tên sách
    let bookName = null;
    if (bookRaw) {
      bookName = findBook(bookRaw);
      if (!bookName) {
        message.reply(
          `❌ Tên sách không hợp lệ: \`${bookRaw}\`\nDùng \`-books\` để xem danh sách sách hợp lệ.`
        );
        return;
      }
    }

    if (expGain === 0 && ahnGain === 0 && !bookName && gradeTarget === null) {
      message.reply("❌ Cần chỉ định ít nhất một trong: `exp`, `ahn`, `book`, `grade`.");
      return;
    }

    try {
      const senderData = isAdmin ? null : await getPlayerData(message.author.id);

      // Kiểm tra kho người gửi (nếu là player)
      if (!isAdmin && bookName) {
        const owned = senderData.inventory?.[bookName] ?? 0;
        if (owned < bookCount) {
          message.reply(
            `❌ Bạn không đủ sách để tặng. Bạn có **${owned}** **${bookName}**, cần **${bookCount}**.`
          );
          return;
        }
      }

      const recipientData = await getPlayerData(targetUser.id);
      const changes = [];

      // grade: set EXP đúng bằng mốc grade đó (admin only)
      if (gradeTarget !== null) {
        const expNeeded = calcExpForGrade(gradeTarget);
        recipientData.exp = expNeeded;
        changes.push(`Grade set → **Grade ${gradeTarget}** (EXP set thành **${expNeeded}**)`);
      } else if (expGain !== 0) {
        recipientData.exp = (recipientData.exp ?? 0) + expGain;
        changes.push(`${expGain > 0 ? "+" : ""}${expGain} EXP`);
      }
      if (ahnGain !== 0) {
        recipientData.ahn = (recipientData.ahn ?? 0) + ahnGain;
        changes.push(`${ahnGain > 0 ? "+" : ""}${formatNumber(ahnGain)} Ahn`);
      }
      if (bookName) {
        recipientData.inventory = recipientData.inventory ?? {};
        recipientData.inventory[bookName] = Math.max(0, (recipientData.inventory[bookName] ?? 0) + bookCount);
        changes.push(`+${bookCount} **${bookName}**`);

        // Trừ sách từ kho người gửi (nếu là player)
        if (!isAdmin) {
          senderData.inventory[bookName] -= bookCount;
          if (senderData.inventory[bookName] <= 0) delete senderData.inventory[bookName];
          await savePlayerData(message.author.id, senderData);
        }
      }

      await savePlayerData(targetUser.id, recipientData);

      const verb = isAdmin ? "tặng" : "chuyển";
      message.reply(
        `✅ ${message.author} đã ${verb} cho ${targetUser}:\n` +
        changes.map(c => `> ${c}`).join("\n")
      );
    } catch (err) {
      console.error("[give] error:", err);
      message.reply("❌ Có lỗi xảy ra khi lưu dữ liệu.");
    }
    return;
  }

  // ── -remove ──
  // Admin:  -remove @user exp: 50 ahn: 100000 book: Random Book count: 3
  // Player: -remove book: Random Book count: 1  (tự xóa của bản thân, không mention)
  if (message.content.startsWith("-remove")) {
    const isAdmin = ADMIN_IDS.has(message.author.id);

    // Xác định target: admin có thể mention người khác, player chỉ tự remove
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

    const rawInput = message.content
      .replace("-remove", "")
      .replace(/<@!?\d+>/, "")
      .trim();

    const kv = parseKeyValues(rawInput);

    const expRemove = parseInt(kv["exp"] ?? "0", 10) || 0;
    const ahnRemove = parseFloat(kv["ahn"] ?? "0") || 0;
    const bookRaw = kv["book"] ?? null;
    const bookCount = Math.max(1, parseInt(kv["count"] ?? "1", 10) || 1);

    // Player thường chỉ được remove sách
    if (!isAdmin && (expRemove !== 0 || ahnRemove !== 0)) {
      message.reply("❌ Bạn chỉ có thể tự xóa sách của mình.");
      return;
    }

    // Validate tên sách
    let bookName = null;
    if (bookRaw) {
      bookName = findBook(bookRaw);
      if (!bookName) {
        message.reply(
          `❌ Tên sách không hợp lệ: \`${bookRaw}\`\nDùng \`-books\` để xem danh sách.`
        );
        return;
      }
    }

    if (expRemove === 0 && ahnRemove === 0 && !bookName) {
      message.reply("❌ Cần chỉ định ít nhất một trong: `exp`, `ahn`, `book`.");
      return;
    }

    try {
      const data = await getPlayerData(targetUser.id);
      data.inventory = data.inventory ?? {};
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
      if (bookName) {
        const owned = data.inventory[bookName] ?? 0;
        if (owned < bookCount && !isAdmin) {
          message.reply(
            `❌ Bạn chỉ có **${owned}** **${bookName}**, không đủ để xóa **${bookCount}**.`
          );
          return;
        }
        const removed = Math.min(owned, bookCount);
        data.inventory[bookName] = owned - removed;
        if (data.inventory[bookName] <= 0) delete data.inventory[bookName];
        changes.push(`-${removed} **${bookName}** (còn lại: ${data.inventory[bookName] ?? 0})`);
      }

      await savePlayerData(targetUser.id, data);

      const isSelf = targetUser.id === message.author.id;
      const header = isSelf
        ? `🗑️ ${message.author} đã xóa khỏi kho của mình:`
        : `🗑️ ${message.author} (admin) đã xóa khỏi kho của ${targetUser}:`;

      message.reply(header + "\n" + changes.map(c => `> ${c}`).join("\n"));
    } catch (err) {
      console.error("[remove] error:", err);
      message.reply("❌ Có lỗi xảy ra khi lưu dữ liệu.");
    }
    return;
  }

  // ── -setplayer ──
  // Cú pháp: -setplayer @user exp: 582 ahn: 28700000 books: Random Book x55, N Corp Book x4
  // Hoặc dùng grade thay exp: -setplayer @user grade: 3 ahn: 5000000 books: Red Mist Book x4
  if (message.content.startsWith("-setplayer")) {
    if (!ADMIN_IDS.has(message.author.id)) {
      message.reply("❌ Bạn không có quyền dùng lệnh này.");
      return;
    }

    const targetUser = message.mentions.users.first();
    if (!targetUser) {
      message.reply("❌ Hãy mention người cần set. Ví dụ: `-setplayer @user exp: 100 ahn: 50000 books: Random Book x3, N Corp Book x1`");
      return;
    }

    const rawInput = message.content
      .replace("-setplayer", "")
      .replace(/<@!?\d+>/, "")
      .trim();

    const kv = parseKeyValues(rawInput);

    // Parse books: "Random Book x55, N Corp Book x4, Zwei Association Book x3"
    const booksRaw = kv["books"] ?? null;
    const bookEntries = []; // [{ name, count }]
    if (booksRaw) {
      const parts = booksRaw.split(",").map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const match = part.match(/^(.+?)\s+x(\d+)$/i);
        if (!match) {
          message.reply(`❌ Định dạng sách sai: \`${part}\`\nĐúng: \`Tên Sách x<số>\` (VD: \`Random Book x5\`)`);
          return;
        }
        const bookName = findBook(match[1].trim());
        if (!bookName) {
          message.reply(`❌ Tên sách không hợp lệ: \`${match[1].trim()}\`\nDùng \`-books\` để xem danh sách.`);
          return;
        }
        bookEntries.push({ name: bookName, count: parseInt(match[2], 10) });
      }
    }

    const expGain = parseInt(kv["exp"] ?? "0", 10) || 0;
    const ahnSet = kv["ahn"] ? parseFloat(kv["ahn"]) : null;
    const gradeTarget = kv["grade"] ? parseInt(kv["grade"], 10) : null;

    if (gradeTarget !== null && (isNaN(gradeTarget) || gradeTarget < GRADE_MAX || gradeTarget > GRADE_MIN)) {
      message.reply(`❌ Grade phải từ ${GRADE_MAX}–${GRADE_MIN}.`);
      return;
    }

    if (expGain === 0 && ahnSet === null && gradeTarget === null && bookEntries.length === 0) {
      message.reply("❌ Không có gì để set. Dùng: `exp`, `grade`, `ahn`, `books`.");
      return;
    }

    try {
      const data = await getPlayerData(targetUser.id);
      data.inventory = data.inventory ?? {};
      const changes = [];

      if (gradeTarget !== null) {
        const expNeeded = calcExpForGrade(gradeTarget);
        data.exp = expNeeded;
        changes.push(`Grade → **Grade ${gradeTarget}** (EXP = **${expNeeded}**)`);
      } else if (expGain !== 0) {
        data.exp = expGain; // set trực tiếp, không cộng dồn
        changes.push(`EXP set → **${expGain}**`);
      }

      if (ahnSet !== null) {
        data.ahn = ahnSet;
        changes.push(`Ahn set → **${formatNumber(ahnSet)}**`);
      }

      if (bookEntries.length > 0) {
        for (const { name, count } of bookEntries) {
          data.inventory[name] = count; // set trực tiếp
        }
        changes.push(`Sách set:\n` + bookEntries.map(e => `> • **${e.name}** × ${e.count}`).join("\n"));
      }

      await savePlayerData(targetUser.id, data);

      message.reply(
        `✅ Đã set data cho ${targetUser}:\n` +
        changes.map(c => `> ${c}`).join("\n")
      );
    } catch (err) {
      console.error("[setplayer] error:", err);
      message.reply("❌ Có lỗi xảy ra khi lưu dữ liệu.");
    }
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

  // ── -math ──
  if (message.content.startsWith("-math")) {
    const input = message.content.replace("-math", "").trim();
    const kv = parseKeyValues(input);

    const bonusPct = parseFloat((kv["bonus"] ?? "0").replace("%", ""));
    const sanityBonusPct = parseFloat((kv["sanitybonus"] ?? "0").replace("%", ""));
    const critMul = parseFloat((kv["critmul"] ?? "1").replace("x", ""));
    const critRate = parseFloat((kv["critrate"] ?? "0").replace("%", ""));
    const diceMul = parseFloat((kv["dicemul"] ?? "1").replace("x", ""));
    const sinkingInit = parseInt(kv["sinking"] ?? "0", 10);
    const ruptureInit = parseInt(kv["rupture"] ?? "0", 10);
    const sanityInit = parseInt(kv["sanity"] ?? "0", 10);

    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, startingCritRate: critRate, diceMul, sinkingInit, ruptureInit, sanityInit });
    if (errors.length > 0) {
      message.reply(`❌ Input không hợp lệ:\n${errors.map(e => `• ${e}`).join("\n")}`);
      return;
    }

    const result = calcMath({
      dmgStr: kv["dmg"] ?? "",
      resStr: kv["res"] ?? "",
      bonusPct,
      sanityBonusPct,
      critMul,
      startingCritRate: critRate / 100,
      critDiv: (kv["critdiv"] ?? "no").toLowerCase() === "yes",
      sanityInit,
      diceMul,
      sinkingInit,
      ruptureInit,
    });

    message.reply(result);
    return;
  }

  // ── -huntermath ──
  if (message.content.startsWith("-huntermath")) {
    const input = message.content.replace("-huntermath", "").trim();
    const kv = parseKeyValues(input);

    const result = calcHunterMath({
      dmgBaseWeapon: parseFloat(kv["dmgbaseweapon"] ?? "0"),
      bonusPct: parseFloat((kv["bonus"] ?? "0").replace("%", "")),
      statValue: parseFloat(kv["stat"] ?? "0"),
      scaleSkillPct: parseFloat((kv["scaleskill"] ?? "0").replace("%", "")),
      dmgNegationPct: parseFloat((kv["dmgnegationboss"] ?? "0").replace("%", "")),
      vulnerabilityPct: parseFloat((kv["vulnerability"] ?? "0").replace("%", "")),
      buffDmgBonus: parseFloat(kv["buffbonus"] ?? "0"),
    });

    message.reply(result);
    return;
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── /math ──
  if (interaction.commandName === "math") {
    await interaction.deferReply();

    const critRate = interaction.options.getNumber("critrate") ?? 0;
    const critMul = interaction.options.getNumber("critmul") ?? 1;
    const diceMul = interaction.options.getNumber("dicemul") ?? 1;
    const sinkingInit = interaction.options.getNumber("sinking") ?? 0;
    const ruptureInit = interaction.options.getNumber("rupture") ?? 0;
    const sanityInit = interaction.options.getNumber("sanity") ?? 0;
    const bonusPct = interaction.options.getNumber("bonus") ?? 0;
    const sanityBonusPct = interaction.options.getNumber("sanitybonus") ?? 0;

    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, startingCritRate: critRate, diceMul, sinkingInit, ruptureInit, sanityInit });
    if (errors.length > 0) {
      await interaction.editReply({ content: `❌ Input không hợp lệ:\n${errors.map(e => `• ${e}`).join("\n")}` });
      return;
    }

    const result = calcMath({
      dmgStr: interaction.options.getString("dmg") ?? "",
      resStr: interaction.options.getString("res") ?? "",
      bonusPct,
      sanityBonusPct,
      critMul,
      startingCritRate: critRate / 100,
      critDiv: interaction.options.getBoolean("critdiv") ?? false,
      sanityInit,
      diceMul,
      sinkingInit,
      ruptureInit,
    });

    await interaction.editReply(result);
    return;
  }

  // ── /huntermath ──
  if (interaction.commandName === "huntermath") {
    await interaction.deferReply();

    const result = calcHunterMath({
      dmgBaseWeapon: interaction.options.getNumber("dmgbaseweapon") ?? 0,
      bonusPct: interaction.options.getNumber("bonus") ?? 0,
      statValue: interaction.options.getNumber("stat") ?? 0,
      scaleSkillPct: interaction.options.getNumber("scaleskill") ?? 0,
      dmgNegationPct: interaction.options.getNumber("dmgnegationboss") ?? 0,
      vulnerabilityPct: interaction.options.getNumber("vulnerability") ?? 0,
      buffDmgBonus: interaction.options.getNumber("buffbonus") ?? 0,
    });

    await interaction.editReply(result);
    return;
  }

  // ── /parry ──
  if (interaction.commandName === "parry") {
    await interaction.deferReply();

    const rolls = Math.min(interaction.options.getInteger("rolls") ?? 1, 50);

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
      if (isSuccess) successCount++;
      else failCount++;

      const rerollNote = rerolls > 0 ? ` *(Hòa và roll lại ${rerolls} lần)*` : "";
      const result = isSuccess ? "Parry thành công ✅" : "Parry thất bại ❌";
      lines.push(`Lần ${i + 1}: Attacker: \`${atk}\` vs Defender: \`${pry}\`${rerollNote} → ${result}`);
    }

    const summary = `**Kết quả tổng kết:**\n• Thành công: \`${successCount}\` lần\n• Thất bại: \`${failCount}\` lần`;
    let body = `**Parry ${rolls} lần:**\n${lines.join("\n")}\n${summary}`;
    if (body.length > 2000) body = body.substring(0, 1990) + "\n…(bị cắt bớt)";

    await interaction.editReply({ content: body });
    return;
  }

  // ── /daily ──
  if (interaction.commandName === "daily") {
    await interaction.deferReply();

    const userId = interaction.user.id;
    const dailyKey = `daily:${userId}`;

    function getVNDateString() {
      const now = new Date();
      const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      return vnTime.toISOString().slice(0, 10);
    }

    function secondsUntilVNMidnight() {
      const now = new Date();
      const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const vnMidnight = new Date(Date.UTC(
        vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate(), 17, 0, 0, 0
      ));
      if (vnMidnight <= now) vnMidnight.setUTCDate(vnMidnight.getUTCDate() + 1);
      return Math.floor((vnMidnight - now) / 1000);
    }

    try {
      const raw = await redis.get(dailyKey);
      const dailyData = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      const today = getVNDateString();

      if (dailyData && dailyData.lastClaim === today) {
        const remaining = secondsUntilVNMidnight();
        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = remaining % 60;
        await interaction.editReply({
          content:
            `${interaction.user}, bạn đã nhận daily hôm nay rồi.\n` +
            `Thời gian còn lại đến reset: **${hours}h ${minutes}m ${seconds}s**.`,
        });
      } else {
        const nowUtc = new Date();
        const vnNow = new Date(nowUtc.getTime() + 7 * 60 * 60 * 1000);
        const vnYesterday = new Date(vnNow);
        vnYesterday.setUTCDate(vnYesterday.getUTCDate() - 1);
        const yesterdayStr = vnYesterday.toISOString().slice(0, 10);

        let streak = dailyData && dailyData.lastClaim === yesterdayStr
          ? (dailyData.streak || 1) + 1
          : 1;

        const isWeekComplete = streak >= 7;

        const newDailyData = { lastClaim: today, streak: isWeekComplete ? 0 : streak };
        await redis.set(dailyKey, JSON.stringify(newDailyData), { ex: 86400 * 2 });

        const EXP_REWARD = 5;
        const AHN_REWARD = 100000;
        const playerData = await getPlayerData(userId);
        playerData.exp = (playerData.exp ?? 0) + EXP_REWARD;
        playerData.ahn = (playerData.ahn ?? 0) + AHN_REWARD;
        playerData.inventory = playerData.inventory ?? {};
        playerData.inventory["Random Book"] = (playerData.inventory["Random Book"] ?? 0) + 1;

        if (isWeekComplete) {
          playerData.exp += 25;
          playerData.ahn += 400000;
          playerData.inventory["Sealed Book Cache"] = (playerData.inventory["Sealed Book Cache"] ?? 0) + 1;
        }

        await savePlayerData(userId, playerData);

        const displayStreak = isWeekComplete ? 7 : streak;
        const bar = Array.from({ length: 7 }, (_, i) => i < displayStreak ? "🟩" : "⬛").join("");

        let replyMsg =
          `🎉 ${interaction.user} đã điểm danh thành công!\n` +
          `> 📦 **5 Exp** | **100k Ahn** | **1 Random Book**\n` +
          `> 🔥 Streak: **${displayStreak}/7** ngày  ${bar}`;

        if (isWeekComplete) {
          replyMsg +=
            `\n\n🏆 **Hoàn thành streak 7 ngày!** Bạn nhận thêm **25 Exp**, **400k Ahn** và **1 Sealed Book Cache**!\n` +
            `> Streak đã reset, bắt đầu lại từ ngày 1 nhé!`;
        }

        await interaction.editReply({ content: replyMsg });
      }
    } catch (err) {
      console.error("[/daily] Redis error:", err);
      await interaction.editReply({ content: "❌ Có lỗi xảy ra, thử lại sau nhé." });
    }
    return;
  }
});


client.login(TOKEN);

// ─── EXPRESS SERVER ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Bot is alive and kicking!");
});

app.use((req, res) => {
  res.status(404).send("Not found.");
});

app.use((err, req, res, next) => {
  console.error("[Express error]", err);
  res.status(500).send("Internal server error.");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] Bot sẽ không crash:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] Promise bị rejected:", reason);
});
