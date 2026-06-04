// index.js
const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express"); 

const app = express(); 

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.warn("DISCORD_TOKEN is not set — Discord bot will not start.");
  process.exit(1);
}

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

client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("-math")) return;

  const input = message.content.replace("-math", "").trim();
  const normalized = input.replace(/([A-Za-z]+)\s*:\s*/g, "$1:");

  const parts = normalized.split(/\s+/);
  const getVal = (key) => {
    const found = parts.find((p) =>
      p.toLowerCase().startsWith(key.toLowerCase() + ":")
    );
    if (!found) return null;
    return found.split(":")[1] ?? null;
  };

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
const damageRegex = /([\d.]+)(?:\+([\d.]+)%?)?(?:x([\d.]+))?\s*(Dice)?([BPSbps])((?:\+\d*Sinking|\+\d*Rupture|\+\d*Poise|\+Crit\d+)*)/gi;
let match;
while ((match = damageRegex.exec(dmgContent)) !== null) {
  const base = parseFloat(match[1]);
  const extraPct = match[2] ? parseFloat(match[2]) : 0;
  const multiplier = match[3] ? parseInt(match[3]) : 1;
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
dmgValues.push({ value: base, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply, effectsStr });  }
}
}
if (dmgValues.length === 0) {
dmgValues.push({ value: 0, type: "B", isDice: false, extraPct: 0 });
}

  // --- OTHER STATS ---
  const bonusPct = parseFloat((getVal("Bonus") ?? "0").replace("%", ""));
  const sanityBonusPct = parseFloat((getVal("SanityBonus") ?? "0").replace("%", ""));
  const critMul = parseFloat((getVal("CritMul") ?? "1").replace("x", ""));
  const startingCritRate = parseFloat((getVal("CritRate") ?? "0").replace("%", "")) / 100;
  const critDiv = (getVal("CritDiv") ?? "No").toLowerCase() === "yes";
  let sanity = parseInt(getVal("Sanity") ?? "0");
  const diceMul = parseFloat((getVal("DiceMul") ?? "1").replace("x",""));
  let currentCritRate = startingCritRate;
  let totalDmg = 0;
  const instanceResults = [];
  let enemySinking = parseInt(getVal("Sinking") ?? "0");
  let enemyRupture = parseInt(getVal("Rupture") ?? "0");
  let totalPoise = 0;

// --- LOOP HITS ---
  
for (const dmgObj of dmgValues) {
  const { value: dmg, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply, effectsStr } = dmgObj;
  const currentRes = resValues[dmgType] ?? 1.0;

  // --- Crit ---
  let critChance = currentCritRate + totalPoise * 0.05; 
  let didCrit = false;

  const critMatch = effectsStr ? effectsStr.match(/\+Crit(\d+)/i) : null;
  let baseCritRate = critMatch ? parseInt(critMatch[1]) / 100 : null;
  
  // Kiểm tra điều kiện Crit dựa trên biến chance được cập nhật liên tục
  if (baseCritRate !== null) {
    critChance = Math.min(baseCritRate + totalPoise * 0.05, 1);
  }

  // Nếu tỉ lệ chí mạng hiện tại là 1 (100%), chắc chắn crit
  if (critChance >= 1) {
    didCrit = true;
  } else {
    didCrit = Math.random() < critChance;
  }

  const multiplier = didCrit ? critMul : 1;
  const bonusFactor = 1 + (bonusPct / 100) + (isDice ? sanityBonusPct / 100 : 0) + (extraPct / 100);
  let instanceDmg = dmg * bonusFactor * multiplier * currentRes;

  // Áp dụng Dice multiplier nếu là Dice
  if (isDice) {
    instanceDmg *= diceMul;
  }

  // --- Sinking ---
  let sinkingBonus = 0;
  if (enemySinking > 0) {
    sanity = Math.max(sanity - 1, -45);
    if (sanity <= -45 || isNaN(sanity)) {
      instanceDmg += enemySinking;
      sinkingBonus = enemySinking;
    }
    enemySinking = Math.max(enemySinking - 1, 0);
  }

  // --- Rupture ---
  let ruptureBonus = 0;
  let ruptureUsed = false;
  if (enemyRupture > 0) {
    if (currentRes < 1) {
      instanceDmg = dmg * bonusFactor * multiplier;
      if (isDice) instanceDmg *= diceMul;
      ruptureUsed = true;
      enemyRupture = Math.max(enemyRupture - 1, 0);
    }
  }

  totalDmg += instanceDmg;

  // ✅ Cộng dồn Poise cho các hit sau
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
    isDice
  });

if (didCrit) {
  // Giảm Poise một nửa sau khi gây crit
  totalPoise *= 0.5;

  // Nếu Poise Count < 1 thì coi như hết (dưới 5% crit rate)
  if (totalPoise < 1) totalPoise = 0;

  // Giới hạn tối đa 99 Poise
  if (totalPoise > 99) totalPoise = 99;
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
  if (r.poiseApplied > 0) extraInfo += ` | +${r.poiseApplied} Poise (+${(r.poiseApplied * 5).toFixed(1)}% Crit)`;
if (r.effectsStr && /\+Crit(\d+)/i.test(r.effectsStr)) {
  const critVal = r.effectsStr.match(/\+Crit(\d+)/i)[1];
  extraInfo += ` | +Crit${critVal}%`;
}
if (r.isDice && diceMul !== 1) {
  extraInfo += ` | DiceMul ${diceMul}x`;
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

const critRateDisplay =
  critDiv && critCount > 0
    ? `${(startingCritRate * 100).toFixed(1)}% → ${(finalCritRate * 100).toFixed(2)}% (after ${critCount} crit${critCount > 1 ? "s" : ""})`
    : `${(startingCritRate * 100).toFixed(1)}%`;

  const resDisplay = `B: ${resValues.B}x | P: ${resValues.P}x | S: ${resValues.S}x`;

const fields = [
  { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
  { name: "% Dmg Bonus", value: bonusPct.toFixed(1) + "%", inline: true },
  { name: "Sanity % DMG Bonus", value: sanityBonusPct.toFixed(1) + "%", inline: true }, // 👈 thêm dòng này
  { name: "CritMul", value: critMul + "x", inline: true },
  { name: "Res Multipliers", value: resDisplay, inline: true },
  { name: "Dice Multiplier", value: diceMul.toFixed(2) + "x", inline: true },
  { name: "Crit Rate", value: critRateDisplay, inline: true },
  { name: "Crit Divide", value: critDiv ? "Yes" : "No", inline: true },
  { name: "Rupture", value: getVal("Rupture") ?? "0", inline: true },
  { name: "Sinking", value: getVal("Sinking") ?? "0", inline: true },
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
        fields,
      },
    ],
  });
});


client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  // --- Command -math ---
  if (message.content.startsWith("-math")) {
    // ... toàn bộ code xử lý -math như bạn đã viết ...
    return;
  }

// --- Command -huntermath ---
if (message.content.startsWith("-huntermath")) {
  const input = message.content.replace("-huntermath", "").trim();
  const normalized = input.replace(/([A-Za-z]+)\s*:\s*/g, "$1:");

  const parts = normalized.split(/\s+/);
  const getVal = (key) => {
    const found = parts.find((p) =>
      p.toLowerCase().startsWith(key.toLowerCase() + ":")
    );
    if (!found) return null;
    return found.split(":")[1] ?? null;
  };

  // Lấy các giá trị từ input
  const dmgBaseWeapon = parseFloat(getVal("DmgBaseWeapon") ?? "0");
  const bonusPct = parseFloat((getVal("Bonus") ?? "0").replace("%", "")) / 100;
  const statValue = parseFloat(getVal("Stat") ?? "0");
  const scaleSkillPct = parseFloat((getVal("ScaleSkill") ?? "0").replace("%", "")) / 100; // dùng % cho cả hai
  const dmgNegationPct = parseFloat((getVal("DmgNegationBoss") ?? "0").replace("%", "")) / 100;
  const vulnerabilityPct = parseFloat((getVal("Vulnerability") ?? "0").replace("%", "")) / 100;
  const buffDmgBonus = parseFloat(getVal("BuffBonus") ?? "0");

  // Công thức tính toán mới
  const partWeapon =
    (dmgBaseWeapon * (1 + bonusPct)) * (1 - dmgNegationPct) * (1 + vulnerabilityPct)
    + (scaleSkillPct * buffDmgBonus);

  const partStat =
    (statValue * scaleSkillPct) * (1 - dmgNegationPct) * (1 + vulnerabilityPct)
    + (scaleSkillPct * buffDmgBonus);

  const finalDmg = partWeapon + partStat;

  // Tạo embed hiển thị
  const fields = [
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
          fields,
        },
      ],
    });
  }
}); // <-- đóng ngoặc callback ở đây

client.login(TOKEN);

// --- KEEP ALIVE WEB SERVER ---
app.get("/", (req, res) => {
  res.send("Bot is alive and kicking!");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
