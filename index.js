// index.js
const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");

const app = express();

const TOKEN = process.env.DISCORD_TOKEN;
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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Lấy giá trị của một key từ mảng parts đã split theo khoảng trắng.
 * Ví dụ: getVal(parts, "Bonus") → "20%" nếu parts chứa "Bonus:20%"
 */
function getVal(parts, key) {
  const found = parts.find((p) =>
    p.toLowerCase().startsWith(key.toLowerCase() + ":")
  );
  if (!found) return null;
  return found.split(":")[1] ?? null;
}

/**
 * Filter bỏ các embed field có giá trị = 0 / 0.0% / 0.00x / "No" tuỳ theo tên field.
 * Các field luôn hiện (Final DMG, Hits, ...) được giữ nguyên.
 */
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
    // Loại bỏ các giá trị rỗng về mặt ý nghĩa
    if (v === "0") return false;
    if (v === "0.0%") return false;
    if (v === "0.00%") return false;
    if (v === "0.00x") return false;
    if (v === "1.00x") return false; // DiceMul mặc định
    if (v === "No") return false;    // CritDiv = No
    return true;
  });
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

// ─── SINGLE MESSAGE HANDLER ───────────────────────────────────────────────────
client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  // ── -math ──────────────────────────────────────────────────────────────────
  if (message.content.startsWith("-math")) {
    const input = message.content.replace("-math", "").trim();
    const normalized = input.replace(/([A-Za-z]+)\s*:\s*/g, "$1:");
    const parts = normalized.split(/\s+/);

    // --- RES ---
    const resMatch = normalized.match(/Res:([^]+?)(?=\s+[A-Za-z]+:|$)/i);
    const resStr = resMatch ? resMatch[1].trim() : "";
    const resValues = { B: 1, P: 1, S: 1 };
    const resRegex = /([\d.]+)(?:x)?([BPS])/gi;
    let match;
    while ((match = resRegex.exec(resStr)) !== null) {
      resValues[match[2].toUpperCase()] = parseFloat(match[1]);
    }

    // --- DMG ---
    const dmgMatch = normalized.match(/Dmg:([^]+?)(?=\s+[A-Za-z]+:|$)/i);
    const dmgValues = [];
    if (dmgMatch) {
      const dmgContent = dmgMatch[1];
      const damageRegex =
        /([\d.]+)(?:x([\d.]+))?(?:\+([\d.]+)%?)?\s*(Dice)?([BPSbps])((?:\+\d*Sinking|\+\d*Rupture|\+\d*Poise|\+Crit\d+)*)/gi;
      while ((match = damageRegex.exec(dmgContent)) !== null) {
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
          dmgValues.push({
            value: base,
            type: dmgType,
            isDice,
            extraPct,
            sinkingToApply,
            ruptureToApply,
            poiseToApply,
            effectsStr,
          });
        }
      }
    }
    if (dmgValues.length === 0) {
      dmgValues.push({ value: 0, type: "B", isDice: false, extraPct: 0 });
    }

    // --- OTHER STATS ---
    const bonusPct = parseFloat((getVal(parts, "Bonus") ?? "0").replace("%", ""));
    const sanityBonusPct = parseFloat((getVal(parts, "SanityBonus") ?? "0").replace("%", ""));
    const critMul = parseFloat((getVal(parts, "CritMul") ?? "1").replace("x", ""));
    const startingCritRate =
      parseFloat((getVal(parts, "CritRate") ?? "0").replace("%", "")) / 100;
    const critDiv = (getVal(parts, "CritDiv") ?? "No").toLowerCase() === "yes";
    let sanity = parseInt(getVal(parts, "Sanity") ?? "0");
    const diceMul = parseFloat((getVal(parts, "DiceMul") ?? "1").replace("x", ""));
    let currentCritRate = startingCritRate;
    let totalDmg = 0;
    const instanceResults = [];
    let enemySinking = parseInt(getVal(parts, "Sinking") ?? "0");
    let enemyRupture = parseInt(getVal(parts, "Rupture") ?? "0");
    let totalPoise = 0;

    // --- LOOP HITS ---
    for (const dmgObj of dmgValues) {
      const {
        value: dmg,
        type: dmgType,
        isDice,
        extraPct,
        sinkingToApply,
        ruptureToApply,
        poiseToApply,
        effectsStr,
      } = dmgObj;
      const currentRes = resValues[dmgType] ?? 1.0;

      // --- Crit ---
      let critChance = currentCritRate + totalPoise * POISE_CRIT_BONUS_PER_STACK;
      let didCrit = false;

      const critMatch = effectsStr ? effectsStr.match(/\+Crit(\d+)/i) : null;
      const baseCritRate = critMatch ? parseInt(critMatch[1]) / 100 : null;

      if (baseCritRate !== null) {
        critChance = Math.min(baseCritRate + totalPoise * POISE_CRIT_BONUS_PER_STACK, 1);
      }

      if (critChance >= 1) {
        didCrit = true;
      } else {
        didCrit = Math.random() < critChance;
      }

      const multiplier = didCrit ? critMul : 1;
      const bonusFactor =
        1 +
        bonusPct / 100 +
        (isDice ? sanityBonusPct / 100 : 0) +
        extraPct / 100;
      let instanceDmg = dmg * bonusFactor * multiplier * currentRes;

      if (isDice) instanceDmg *= diceMul;

      // --- Sinking ---
      let sinkingBonus = 0;
      if (enemySinking > 0) {
        sanity = Math.max(sanity - 1, SANITY_MIN);
        if (sanity <= SANITY_MIN || isNaN(sanity)) {
          instanceDmg += enemySinking;
          sinkingBonus = enemySinking;
        }
        enemySinking = Math.max(enemySinking - 1, 0);
      }

      // --- Rupture ---
      let ruptureUsed = false;
      if (enemyRupture > 0 && currentRes < 1) {
        instanceDmg = dmg * bonusFactor * multiplier;
        if (isDice) instanceDmg *= diceMul;
        ruptureUsed = true;
        enemyRupture = Math.max(enemyRupture - 1, 0);
      }

      totalDmg += instanceDmg;

      if (poiseToApply > 0) totalPoise += poiseToApply;
      if (sinkingToApply > 0) enemySinking += sinkingToApply;
      if (ruptureToApply > 0) enemyRupture += ruptureToApply;

      instanceResults.push({
        dmg,
        dmgType,
        didCrit,
        critRateUsed: critChance,
        instanceDmg,
        ruptureUsed,
        sinkingBonus,
        sinkingApplied: sinkingToApply || 0,
        ruptureApplied: ruptureToApply || 0,
        poiseApplied: poiseToApply || 0,
        effectsStr,
        isDice,
      });

      if (didCrit) {
        totalPoise *= POISE_CRIT_HALVE;
        if (totalPoise < POISE_RESET_THRESHOLD) totalPoise = 0;
        if (totalPoise > POISE_MAX) totalPoise = POISE_MAX;
      }

      if (didCrit && critDiv) {
        currentCritRate /= 2;
        if (currentCritRate < 0.05) currentCritRate = 0;
      }
    }

    const finalCritRate = currentCritRate;
    const critCount = instanceResults.filter((r) => r.didCrit).length;

    // --- BREAKDOWN ---
    const breakdownLines = instanceResults.map((r, i) => {
      const rateStr = `${(r.critRateUsed * 100).toFixed(1)}%`;
      const critLabel = r.didCrit ? "✅" : "❌";
      let extraInfo = "";
      if (r.sinkingBonus > 0) extraInfo += ` +${r.sinkingBonus} dmg từ Sinking`;
      if (r.sinkingApplied > 0) extraInfo += ` | áp ${r.sinkingApplied} Sinking`;
      if (r.ruptureUsed) extraInfo += " | xuyên Res từ Rupture";
      if (r.ruptureApplied > 0) extraInfo += ` | áp ${r.ruptureApplied} Rupture`;
      if (r.poiseApplied > 0)
        extraInfo += ` | +${r.poiseApplied} Poise (+${(r.poiseApplied * 5).toFixed(1)}% Crit)`;
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
      { name: "Rupture", value: getVal(parts, "Rupture") ?? "0", inline: true },
      { name: "Sinking", value: getVal(parts, "Sinking") ?? "0", inline: true },
      { name: "Final DMG", value: totalDmg.toFixed(3), inline: false },
      { name: "Enemy's Sanity", value: sanity.toString(), inline: true },
      { name: "Poise Counts", value: totalPoise.toString(), inline: true },
      { name: "Enemy's Sinking Counts", value: enemySinking.toString(), inline: true },
      { name: "Enemy's Rupture Counts", value: enemyRupture.toString(), inline: true },
    ];

    message.reply({
      embeds: [
        {
          title: "📊 Kết quả tính DMG",
          color: 0x00ae86,
          fields: filterZeroFields(allFields),
        },
      ],
    });

    return;
  }

  // ── -huntermath ────────────────────────────────────────────────────────────
  if (message.content.startsWith("-huntermath")) {
    const input = message.content.replace("-huntermath", "").trim();
    const normalized = input.replace(/([A-Za-z]+)\s*:\s*/g, "$1:");
    const parts = normalized.split(/\s+/);

    const dmgBaseWeapon = parseFloat(getVal(parts, "DmgBaseWeapon") ?? "0");
    const bonusPct = parseFloat((getVal(parts, "Bonus") ?? "0").replace("%", "")) / 100;
    const statValue = parseFloat(getVal(parts, "Stat") ?? "0");
    const scaleSkillPct =
      parseFloat((getVal(parts, "ScaleSkill") ?? "0").replace("%", "")) / 100;
    const dmgNegationPct =
      parseFloat((getVal(parts, "DmgNegationBoss") ?? "0").replace("%", "")) / 100;
    const vulnerabilityPct =
      parseFloat((getVal(parts, "Vulnerability") ?? "0").replace("%", "")) / 100;
    const buffDmgBonus = parseFloat(getVal(parts, "BuffBonus") ?? "0");

    const partWeapon =
      dmgBaseWeapon * (1 + bonusPct) * (1 - dmgNegationPct) * (1 + vulnerabilityPct) +
      scaleSkillPct * buffDmgBonus;

    const partStat =
      statValue * scaleSkillPct * (1 - dmgNegationPct) * (1 + vulnerabilityPct) +
      scaleSkillPct * buffDmgBonus;

    const finalDmg = partWeapon + partStat;

    const allFields = [
      { name: "DmgBaseWeapon", value: dmgBaseWeapon.toString(), inline: true },
      { name: "Bonus %", value: (bonusPct * 100).toFixed(1) + "%", inline: true },
      { name: "Stat Value", value: statValue.toString(), inline: true },
      { name: "ScaleSkill %", value: (scaleSkillPct * 100).toFixed(1) + "%", inline: true },
      { name: "Boss Negation %", value: (dmgNegationPct * 100).toFixed(1) + "%", inline: true },
      { name: "Vulnerability %", value: (vulnerabilityPct * 100).toFixed(1) + "%", inline: true },
      { name: "BuffBonus", value: buffDmgBonus.toString(), inline: true },
      { name: "Final DMG", value: finalDmg.toFixed(3), inline: false },
    ];

    message.reply({
      embeds: [
        {
          title: "📊 Kết quả tính DMG",
          color: 0xff6600,
          fields: filterZeroFields(allFields),
        },
      ],
    });

    return;
  }
});

client.login(TOKEN);

// ─── EXPRESS SERVER ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Bot is alive and kicking!");
});

// 404 handler
app.use((req, res) => {
  res.status(404).send("Not found.");
});

// 500 handler
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
