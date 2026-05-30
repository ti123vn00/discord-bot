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
const damageRegex = /([\d.]+)(?:\+([\d.]+)%?)?(?:x([\d.]+))?\s*(Dice)?([BPSbps])((?:\+\d*Sinking|\+\d*Rupture|\+\d*Poise)*)/gi;
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
dmgValues.push({ value: base, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply });  }
}
}
if (dmgValues.length === 0) {
  dmgValues.push({ value: 0, type: "B", isDice: false, extraPct: 0, effectType: null });
}

  // --- OTHER STATS ---
  const bonusPct = parseFloat((getVal("Bonus") ?? "0").replace("%", ""));
  const sanityBonusPct = parseFloat((getVal("SanityBonus") ?? "0").replace("%", ""));
  const critMul = parseFloat((getVal("CritMul") ?? "1").replace("x", ""));
  const startingCritRate = parseFloat((getVal("CritRate") ?? "0").replace("%", "")) / 100;
  const critDiv = (getVal("CritDiv") ?? "No").toLowerCase() === "yes";
  let sanity = parseInt(getVal("Sanity") ?? "0");

  let currentCritRate = startingCritRate;
  let totalDmg = 0;
  const instanceResults = [];
  let enemySinking = 0;
  let enemyRupture = 0;

  // --- LOOP HITS ---
for (const dmgObj of dmgValues) {
const { value: dmg, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseToApply } = dmgObj;  const currentRes = resValues[dmgType] ?? 1.0;

  const didCrit = Math.random() < currentCritRate;
  const multiplier = didCrit ? critMul : 1;
  const bonusFactor = 1 + (bonusPct / 100) + (isDice ? sanityBonusPct / 100 : 0) + (extraPct / 100);

  let instanceDmg = dmg * bonusFactor * multiplier * currentRes;

// --- Sanity giảm sau mỗi hit ---
if (!isNaN(sanity)) {
  sanity -= 1; // mỗi hit giảm đúng 1 Sanity
}


// --- Sinking ---
let sinkingBonus = 0;
if (enemySinking > 0 && (sanity <= -45 || isNaN(sanity))) {
  instanceDmg += enemySinking; // chỉ cộng dmg khi sanity <= -45 hoặc None
  sinkingBonus = enemySinking;
  enemySinking = Math.max(enemySinking - 1, 0); // tiêu hao 1 stack
}


// --- Rupture ---
let ruptureBonus = 0;
if (enemyRupture > 0) {
  // Nếu Res < 1x thì Rupture xuyên Res (tính như 1x)
  if (currentRes < 1) {
    instanceDmg = instanceDmg / currentRes * 1; // xuyên Res < 1x
  }

  ruptureBonus = enemyRupture;
  enemyRupture = Math.max(enemyRupture - 1, 0); // tiêu hao 1 stack
}


let poiseBonusCrit = 0;
let poiseApplied = 0;
if (dmgObj.poiseToApply > 0) {
  poiseApplied = dmgObj.poiseToApply;
  poiseBonusCrit = poiseApplied * 0.05; // 5% mỗi Poise
  currentCritRate = Math.min(currentCritRate + poiseBonusCrit, 1); // không vượt quá 100%
}



  totalDmg += instanceDmg;

  // Sau khi hit kết thúc, nếu cú pháp có +Sinking hoặc +Rupture thì áp stack mới
if (dmgObj.sinkingToApply > 0) enemySinking += dmgObj.sinkingToApply;
if (dmgObj.ruptureToApply > 0) enemyRupture += dmgObj.ruptureToApply;


instanceResults.push({
  dmg,
  dmgType,
  didCrit,
  critRateUsed: currentCritRate,
  instanceDmg,
  ruptureUsed: ruptureBonus > 0,
  sinkingBonus,
  sinkingApplied: sinkingToApply || 0,
  ruptureApplied: ruptureToApply || 0,
  poiseApplied
});


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
  { name: "CritRate", value: critRateDisplay, inline: true },
  { name: "CritDiv", value: critDiv ? "Yes" : "No", inline: true },
  { name: "Rupture", value: getVal("Rupture") ?? "0", inline: true },
  { name: "Sinking", value: getVal("Sinking") ?? "0", inline: true },
  { name: "Final DMG", value: totalDmg.toFixed(3), inline: false },
  { name: "Enemy's Sanity", value: sanity.toString(), inline: true },
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
