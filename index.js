// index.js
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const express = require("express");

const app = express();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Parse key:value pairs from a full command string, supporting multi-word values.
 * Returns a map of key (lowercase) → value string.
 */
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

/**
 * Validate and clamp slash command inputs, returning an error message if invalid.
 */
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

// ─── CORE LOGIC ───────────────────────────────────────────────────────────────

/**
 * Tính DMG cho -math / /math
 */
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

  // --- RES ---
  const resValues = { B: 1, P: 1, S: 1 };
  const resRegex = /([\d.]+)(?:x)?([BPS])/gi;
  let match;
  while ((match = resRegex.exec(resStr)) !== null) {
    resValues[match[2].toUpperCase()] = parseFloat(match[1]);
  }

  // --- DMG ---
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

/**
 * Tính DMG cho -huntermath / /huntermath
 */
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

// ─── PREFIX COMMANDS (-math, -huntermath) ────────────────────────────────────
client.on("messageCreate", (message) => {
  if (message.author.bot) return;

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
