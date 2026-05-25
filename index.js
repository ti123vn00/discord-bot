import { Client, GatewayIntentBits } from "discord.js";
import { logger } from "./lib/logger";

export function startBot() {
  const TOKEN = process.env.DISCORD_TOKEN;

  if (!TOKEN) {
    logger.warn("DISCORD_TOKEN is not set — Discord bot will not start.");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("ready", () => {
    logger.info(`Bot đã online với tên ${client.user?.tag}`);
  });

  client.on("messageCreate", (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith("-math")) {
      const input = message.content.replace("-math", "").trim();
      const normalized = input.replace(/([A-Za-z]+)\s*:\s*/g, "$1:");

      // Parse Dmg — supports multiple instances: Dmg:100+100+100
      const dmgMatch = normalized.match(/Dmg:([\d\s+.]+?)(?=\s+[A-Za-z]+:|$)/i);
      const dmgValues = dmgMatch
        ? dmgMatch[1].split("+").map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0)
        : [0];

      const parts = normalized.split(/\s+/);
      const getVal = (key) => {
        const found = parts.find(p => p.toLowerCase().startsWith(key.toLowerCase() + ":"));
        return found ? found.split(":")[1] : null;
      };

      const bonusPct = parseFloat((getVal("Bonus") ?? "0").replace("%", ""));
      const critMul = parseFloat((getVal("CritMul") ?? "1").replace("x", ""));
      const res = parseFloat((getVal("Res") ?? "1").replace("x", ""));
      let currentCritRate = parseFloat((getVal("CritRate") ?? "0").replace("%", "")) / 100;
      const critDiv = (getVal("CritDiv") ?? "No").toLowerCase() === "yes";

      let totalDmg = 0;
      let critCount = 0;
      const breakdownLines = [];

      dmgValues.forEach((base, i) => {
        const didCrit = Math.random() < currentCritRate;
        if (didCrit) critCount++;
        const multiplier = didCrit ? critMul : 1;
        const instanceDmg = base * (1 + bonusPct / 100) * multiplier * res;
        totalDmg += instanceDmg;

        const rateStr = `${(currentCritRate * 100).toFixed(1)}%`;
        const critLabel = didCrit ? "✅" : "❌";
        breakdownLines.push(`#${i + 1}(${rateStr}) ${critLabel} → ${instanceDmg.toFixed(2)}`);

        if (didCrit && critDiv) {
          currentCritRate /= 2;
          if (currentCritRate < 0.05) currentCritRate = 0;
        }
      });

      // Hiển thị ngang, cách nhau bằng " · "
      let breakdownValue = breakdownLines.join(" · ");
      if (breakdownValue.length > 1024) {
        const shown = [];
        for (const line of breakdownLines) {
          if ((shown.join(" · ") + " · " + line).length > 990) {
            shown.push(`…+${breakdownLines.length - shown.length} hits`);
            break;
          }
          shown.push(line);
        }
        breakdownValue = shown.join(" · ");
      }

      const critRateDisplay =
        critDiv && critCount > 0
          ? `${(parseFloat((getVal("CritRate") ?? "0").replace("%", "")))}% → ${(currentCritRate * 100).toFixed(2)}% (after ${critCount} crit${critCount > 1 ? "s" : ""})`
          : `${(parseFloat((getVal("CritRate") ?? "0").replace("%", "")))}%`;

      const fields = [
        { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
        { name: "Bonus", value: bonusPct.toFixed(1) + "%", inline: true },
        { name: "CritMul", value: critMul + "x", inline: true },
        { name: "Res", value: res + "x", inline: true },
        { name: "CritRate", value: critRateDisplay, inline: true },
        { name: "CritDiv", value: critDiv ? "Yes" : "No", inline: true },
        { name: "Final DMG", value: totalDmg.toFixed(3), inline: false }
      ];

      message.reply({
        embeds: [{
          title: "📊 Kết quả tính DMG",
          color: 0x00ae86,
          fields
        }]
      });
    }
  });

  client.login(TOKEN);
}
