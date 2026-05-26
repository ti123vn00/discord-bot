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

  const dmgMatch = normalized.match(/Dmg:([\d\s+.]+?)(?=\s+[A-Za-z]+:|$)/i);
  const dmgValues = dmgMatch
    ? dmgMatch[1]
        .split("+")
        .map((s) => parseFloat(s.trim()))
        .filter((n) => !isNaN(n) && n > 0)
    : [0];

  const parts = normalized.split(/\s+/);
  const getVal = (key) => {
    const found = parts.find((p) =>
      p.toLowerCase().startsWith(key.toLowerCase() + ":")
    );
    if (!found) return null;
    return found.split(":")[1] ?? null;
  };

  const bonusPct = parseFloat((getVal("Bonus") ?? "0").replace("%", ""));
  const critMul = parseFloat((getVal("CritMul") ?? "1").replace("x", ""));
  const res = parseFloat((getVal("Res") ?? "1").replace("x", ""));
  const startingCritRate =
    parseFloat((getVal("CritRate") ?? "0").replace("%", "")) / 100;
  const critDiv = (getVal("CritDiv") ?? "No").toLowerCase() === "yes";

  let currentCritRate = startingCritRate;
  let totalDmg = 0;
  const instanceResults = [];

  for (const dmg of dmgValues) {
    const didCrit = Math.random() < currentCritRate;
    const multiplier = didCrit ? critMul : 1;
    const instanceDmg = dmg * (1 + bonusPct / 100) * multiplier * res;

    instanceResults.push({
      dmg,
      didCrit,
      critRateUsed: currentCritRate,
      instanceDmg,
    });

    totalDmg += instanceDmg;

    if (didCrit && critDiv) {
      currentCritRate /= 2;
      if (currentCritRate < 0.05) currentCritRate = 0;
    }
  }

  const finalCritRate = currentCritRate;
  const critCount = instanceResults.filter((r) => r.didCrit).length;

  const breakdownLines = instanceResults.map((r, i) => {
    const rateStr = `${(r.critRateUsed * 100).toFixed(1)}%`;
    const critLabel = r.didCrit ? "✅" : "❌";
    return `#${i + 1}(${rateStr}) ${critLabel} → ${r.instanceDmg.toFixed(2)}`;
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

  const fields = [
    { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
    { name: "Bonus", value: bonusPct.toFixed(1) + "%", inline: true },
    { name: "CritMul", value: critMul + "x", inline: true },
    { name: "Res", value: res + "x", inline: true },
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

client.login(TOKEN);

// --- KEEP ALIVE WEB SERVER ---
app.get("/", (req, res) => {
    res.send("Bot is alive and kicking!");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
