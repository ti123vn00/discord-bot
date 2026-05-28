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
  // Chuẩn hóa khoảng trống quanh dấu hai chấm
  const normalized = input.replace(/([A-Za-z]+)\s*:\s*/g, "$1:");

  const parts = normalized.split(/\s+/);
  const getVal = (key) => {
    const found = parts.find((p) =>
      p.toLowerCase().startsWith(key.toLowerCase() + ":")
    );
    if (!found) return null;
    return found.split(":")[1] ?? null;
  };

  // 1. XỬ LÝ KHÁNG (RES) - Bóc tách riêng lẻ B, P, S từ chuỗi Res (Ví dụ: "0.5xB 1xP 1.5S")
const resStr = getVal("Res") ?? "1";

const getResMultiplier = (typeChar) => {
  // Regex tìm số đứng trước xB, xP, xS hoặc chỉ B, P, S
  const regex = new RegExp(`([\\d.]+)(?:x)?${typeChar}`, "i");
  const match = resStr.match(regex);
  return match ? parseFloat(match[1]) : 1.0; // Mặc định là 1x nếu không điền loại đó
};

const resValues = {
  B: getResMultiplier("B"),
  P: getResMultiplier("P"),
  S: getResMultiplier("S"),
};

// 2. Xử lý Dmg với hỗ trợ nhân (ví dụ: 50x2B)
const dmgMatch = normalized.match(/Dmg:([\d\s+.x]+?[BPSbps](?:\s*\+\s*[\d\s+.x]+?[BPSbps])*)/i);
const dmgValues = [];

if (dmgMatch) {
  const dmgContent = dmgMatch[1];
  // Regex mới: bắt được cả dạng 50x2B
  const damageRegex = /([\d.]+)(?:x([\d.]+))?\s*([BPSbps])/gi;
  let match;

  while ((match = damageRegex.exec(dmgContent)) !== null) {
    const base = parseFloat(match[1]);
    const multiplier = match[2] ? parseFloat(match[2]) : 1;
    const dmgType = match[3].toUpperCase();
    dmgValues.push({
      value: base * multiplier,
      type: dmgType,
    });
  }
}

// Nếu không quét được damage nào hợp lệ, gán mặc định sát thương bằng 0 loại B
if (dmgValues.length === 0) {
  dmgValues.push({ value: 0, type: "B" });
}

  // 3. XỬ LÝ CÁC CHỈ SỐ CÒN LẠI
  const bonusPct = parseFloat((getVal("Bonus") ?? "0").replace("%", ""));
  const critMul = parseFloat((getVal("CritMul") ?? "1").replace("x", ""));
  const startingCritRate = parseFloat((getVal("CritRate") ?? "0").replace("%", "")) / 100;
  const critDiv = (getVal("CritDiv") ?? "No").toLowerCase() === "yes";

  let currentCritRate = startingCritRate;
  let totalDmg = 0;
  const instanceResults = [];

  // 4. VÒNG LẶP TÍNH TOÁN CHO TỪNG ĐÒN ĐÁNH (HIT)
  for (const dmgObj of dmgValues) {
    const { value: dmg, type: dmgType } = dmgObj;
    
    // Lấy đúng hệ số kháng tương ứng với loại damage của hit này
    const currentRes = resValues[dmgType] ?? 1.0;

    const didCrit = Math.random() < currentCritRate;
    const multiplier = didCrit ? critMul : 1;
    
    // Công thức tính toán áp dụng riêng hệ số kháng cụ thể
    const instanceDmg = dmg * (1 + bonusPct / 100) * multiplier * currentRes;

    instanceResults.push({
      dmg,
      dmgType,
      didCrit,
      critRateUsed: currentCritRate,
      instanceDmg,
    });

    totalDmg += instanceDmg;

    // Cơ chế giảm nửa CritRate nếu kích hoạt CritDiv
    if (didCrit && critDiv) {
      currentCritRate /= 2;
      if (currentCritRate < 0.05) currentCritRate = 0;
    }
  }

  const finalCritRate = currentCritRate;
  const critCount = instanceResults.filter((r) => r.didCrit).length;

  // 5. TẠO CHUỖI ĐỂ HIỂN THỊ CHI TIẾT (BREAKDOWN)
  const breakdownLines = instanceResults.map((r, i) => {
    const rateStr = `${(r.critRateUsed * 100).toFixed(1)}%`;
    const critLabel = r.didCrit ? "✅" : "❌";
    return `#${i + 1}[${r.dmgType}](${rateStr}) ${critLabel} → ${r.instanceDmg.toFixed(2)}`;
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

  // Hiển thị cụ thể mức kháng của từng loại trong Embed
  const resDisplay = `B: ${resValues.B}x | P: ${resValues.P}x | S: ${resValues.S}x`;

  const fields = [
    { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
    { name: "Bonus", value: bonusPct.toFixed(1) + "%", inline: true },
    { name: "CritMul", value: critMul + "x", inline: true },
    { name: "Res Multipliers", value: resDisplay, inline: true },
    { name: "CritRate", value: critRateDisplay, inline: true },
    { name: "CritDiv", value: critDiv ? "Yes" : "No", inline: true },
    { name: "Final DMG", value: totalDmg.toFixed(3), inline: false },
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

  // --- Command -math (giữ nguyên như bạn đã có) ---
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
    const statValue = parseFloat(getVal("Stat") ?? "0"); // Intelligent/Faith/Knowledge
    const scaleSkillPct = parseFloat((getVal("ScaleSkill") ?? "0").replace("%", "")) / 100;
    const dmgNegationPct = parseFloat((getVal("DmgNegationBoss") ?? "0").replace("%", "")) / 100;
    const armorBreakPct = parseFloat((getVal("ArmorBreak") ?? "0").replace("%", "")) / 100;
    const scaleBase = parseFloat(getVal("ScaleBase") ?? "1");
    const buffDmgBonus = parseFloat(getVal("BuffBonus") ?? "0");

    // Công thức tính toán
    const part1 = dmgBaseWeapon * (1 + bonusPct);
    const part2 = statValue * scaleSkillPct * (1 - dmgNegationPct);
    const part3 = 1 + armorBreakPct;
    const part4 = 1 * scaleBase * buffDmgBonus;

    const finalDmg = part1 + (part2 * part3) + part4;

    // Tạo embed hiển thị
    const fields = [
      { name: "DmgBaseWeapon", value: dmgBaseWeapon.toString(), inline: true },
      { name: "Bonus %", value: (bonusPct * 100).toFixed(1) + "%", inline: true },
      { name: "Stat Value", value: statValue.toString(), inline: true },
      { name: "ScaleSkill %", value: (scaleSkillPct * 100).toFixed(1) + "%", inline: true },
      { name: "Boss Negation %", value: (dmgNegationPct * 100).toFixed(1) + "%", inline: true },
      { name: "ArmorBreak %", value: (armorBreakPct * 100).toFixed(1) + "%", inline: true },
      { name: "ScaleBase", value: scaleBase.toString(), inline: true },
      { name: "BuffBonus", value: buffDmgBonus.toString(), inline: true },
      { name: "Final DMG", value: finalDmg.toFixed(3), inline: false },
    ];

    message.reply({
      embeds: [
        {
          title: "🎯 HunterMath Result",
          color: 0xff6600,
          fields,
        },
      ],
    });
  }
});

client.login(TOKEN);

// --- KEEP ALIVE WEB SERVER ---
app.get("/", (req, res) => {
    res.send("Bot is alive and kicking!");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
