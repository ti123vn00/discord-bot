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
  const dmgMatch = normalized.match(/Dmg:([\d\s+.x]+?[BPSbps](?:\s*\+\s*[\d\s+.x]+?[BPSbps])*)/i);
  const dmgValues = [];
  if (dmgMatch) {
    const dmgContent = dmgMatch[1];
    const damageRegex = /([\d.]+)(?:x([\d.]+))?\s*([BPSbps])/gi;
    let match;
    while ((match = damageRegex.exec(dmgContent)) !== null) {
const base = parseFloat(match[1]);
const multiplier = match[2] ? parseFloat(match[2]) : 1;
const dmgType = match[3].toUpperCase();

// Nếu multiplier > 1, coi như số hit
for (let i = 0; i < multiplier; i++) {
  dmgValues.push({ value: base, type: dmgType });
}
    }
  }
  if (dmgValues.length === 0) {
    dmgValues.push({ value: 0, type: "B" });
  }

  // --- OTHER STATS ---
  const bonusPct = parseFloat((getVal("Bonus") ?? "0").replace("%", ""));
  const critMul = parseFloat((getVal("CritMul") ?? "1").replace("x", ""));
  const startingCritRate = parseFloat((getVal("CritRate") ?? "0").replace("%", "")) / 100;
  const critDiv = (getVal("CritDiv") ?? "No").toLowerCase() === "yes";

  let ruptureCount = parseInt(getVal("Rupture") ?? "0");
  let sinkingCount = parseInt(getVal("Sinking") ?? "0");
  let sanity = parseInt(getVal("Sanity") ?? "0");

  let currentCritRate = startingCritRate;
  let totalDmg = 0;
  const instanceResults = [];

  // --- LOOP HITS ---
  for (const dmgObj of dmgValues) {
    const { value: dmg, type: dmgType } = dmgObj;
    const currentRes = resValues[dmgType] ?? 1.0;

    const didCrit = Math.random() < currentCritRate;
    const multiplier = didCrit ? critMul : 1;

    let instanceDmg = dmg * (1 + bonusPct / 100) * multiplier * currentRes;
    let extraDmg = 0;
    let ruptureUsed = false;
    let sinkingBonus = 0;

    // Rupture: nếu res < 1 thì thêm 1 hit bỏ qua kháng
    if (ruptureCount > 0 && currentRes < 1) {
      extraDmg += dmg * (1 - currentRes) * (1 + bonusPct / 100) * multiplier;
      ruptureCount -= 1;
      ruptureUsed = true;
    }

// Sinking: mỗi hit trừ sanity, nếu sanity <= -45 hoặc không có sanity thì gây dmg theo count
if (sinkingCount > 0) {
  sanity -= 1; // mỗi hit trừ 1 sanity
  if (sanity < -45) sanity = -45; // 🔒 Giới hạn sanity không giảm quá -45
  if (sanity <= -45 || isNaN(sanity)) {
    extraDmg += sinkingCount;
    sinkingBonus = sinkingCount;
  }
  sinkingCount -= 1;
}

    const finalInstanceDmg = instanceDmg + extraDmg;

    instanceResults.push({
      dmg,
      dmgType,
      didCrit,
      critRateUsed: currentCritRate,
      instanceDmg: finalInstanceDmg,
      ruptureUsed,
      sinkingBonus,
    });

    totalDmg += finalInstanceDmg;

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
    if (r.ruptureUsed) extraInfo += " Rupture✔";
    if (r.sinkingBonus > 0) extraInfo += ` Sinking+${r.sinkingBonus}`;
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
    { name: "Bonus", value: bonusPct.toFixed(1) + "%", inline: true },
    { name: "CritMul", value: critMul + "x", inline: true },
    { name: "Res Multipliers", value: resDisplay, inline: true },
    { name: "CritRate", value: critRateDisplay, inline: true },
    { name: "CritDiv", value: critDiv ? "Yes" : "No", inline: true },
    { name: "Rupture", value: getVal("Rupture") ?? "0", inline: true },
    { name: "Sinking", value: getVal("Sinking") ?? "0", inline: true },
    { name: "Final DMG", value: totalDmg.toFixed(3), inline: false },
    { name: "Sanity", value: sanity.toString(), inline: true },
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
