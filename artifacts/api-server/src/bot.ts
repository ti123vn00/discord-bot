import { Client, GatewayIntentBits } from "discord.js";
import { logger } from "./lib/logger";

export function startBot() {
  const TOKEN = process.env["DISCORD_TOKEN"];

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

      // Normalize spaces around colons so "Key: Value" → "Key:Value"
      const normalized = input.replace(/([A-Za-z]+)\s*:\s*/g, "$1:");

      // Parse Dmg — supports multiple instances: Dmg:100 + 100 + 100
      const dmgMatch = normalized.match(
        /Dmg:([\d\s+.]+?)(?=\s+[A-Za-z]+:|$)/i,
      );
      const dmgValues = dmgMatch
        ? dmgMatch[1]
            .split("+")
            .map((s) => parseFloat(s.trim()))
            .filter((n) => !isNaN(n) && n > 0)
        : [0];

      // Parse the remaining single-value params
      const parts = normalized.split(/\s+/);
      const getVal = (key: string): string | null => {
        const found = parts.find((p) =>
          p.toLowerCase().startsWith(key.toLowerCase() + ":"),
        );
        if (!found) return null;
        return found.split(":")[1] ?? null;
      };

      const bonusPct = parseFloat((getVal("Bonus") ?? "0").replace("%", ""));
      const critMul = parseFloat((getVal("CritMul") ?? "1").replace("x", ""));
      const res = parseFloat((getVal("Res") ?? "1").replace("x", ""));
      const startingCritRate =
        parseFloat((getVal("CritRate") ?? "0").replace("%", "")) / 100;
      const critDiv =
        (getVal("CritDiv") ?? "No").toLowerCase() === "yes";

      // Simulate each damage instance
      // - Each instance rolls its own crit against the current crit rate
      // - If CritDiv:Yes and the hit crits, halve the rate for the next hit
      let currentCritRate = startingCritRate;
      let totalDmg = 0;

      type InstanceResult = {
        dmg: number;
        didCrit: boolean;
        critRateUsed: number;
        instanceDmg: number;
      };

      const instanceResults: InstanceResult[] = [];

      for (const dmg of dmgValues) {
        const didCrit = Math.random() < currentCritRate;
        const multiplier = didCrit ? critMul : 1;
        // Formula: Dmg × (1 + Bonus/100) × (crit ? CritMul : 1) × Res
        const instanceDmg = dmg * (1 + bonusPct / 100) * multiplier * res;

        instanceResults.push({
          dmg,
          didCrit,
          critRateUsed: currentCritRate,
          instanceDmg,
        });

        totalDmg += instanceDmg;

        // Only halve crit rate if this hit actually crit
        if (didCrit && critDiv) {
          currentCritRate /= 2;
          // 1 Poise = 5% crit rate — anything below 5% rounds down to 0%
          if (currentCritRate < 0.05) {
            currentCritRate = 0;
          }
        }
      }

      const finalCritRate = currentCritRate;
      const critCount = instanceResults.filter((r) => r.didCrit).length;

      // Build embed fields
      const fields: Array<{
        name: string;
        value: string;
        inline: boolean;
      }> = [];

      // Per-instance breakdown (compact, Discord field max 1024 chars)
      const breakdownLines = instanceResults.map((r, i) => {
        const rateStr = `${(r.critRateUsed * 100).toFixed(1)}%`;
        const critLabel = r.didCrit ? `✅` : `❌`;
        return `#${i + 1}(${rateStr}) ${critLabel} → ${r.instanceDmg.toFixed(2)}`;
      });

      // Truncate if too many hits would overflow the 1024-char limit
      let breakdownValue = breakdownLines.join("\n");
      if (breakdownValue.length > 1024) {
        const shown: string[] = [];
        for (const line of breakdownLines) {
          if ((shown.join("\n") + "\n" + line).length > 990) {
            shown.push(`…+${breakdownLines.length - shown.length} more hits`);
            break;
          }
          shown.push(line);
        }
        breakdownValue = shown.join("\n");
      }

      fields.push({
        name: `Hits (${critCount}/${dmgValues.length} crit)`,
        value: breakdownValue,
        inline: false,
      });

      // Parameters summary
      fields.push(
        {
          name: "Bonus",
          value: bonusPct.toFixed(1) + "%",
          inline: true,
        },
        {
          name: "CritMul",
          value: critMul + "x",
          inline: true,
        },
        {
          name: "Res",
          value: res + "x",
          inline: true,
        },
      );

      // CritRate — show start → end when CritDiv is active
      const critRateDisplay =
        critDiv && critCount > 0
          ? `${(startingCritRate * 100).toFixed(1)}% → ${(finalCritRate * 100).toFixed(2)}% (after ${critCount} crit${critCount > 1 ? "s" : ""})`
          : `${(startingCritRate * 100).toFixed(1)}%`;

      fields.push(
        {
          name: "CritRate",
          value: critRateDisplay,
          inline: true,
        },
        {
          name: "CritDiv",
          value: critDiv ? "Yes" : "No",
          inline: true,
        },
        {
          name: "Final DMG",
          value: totalDmg.toFixed(3),
          inline: false,
        },
      );

      message.reply({
        embeds: [
          {
            title: "📊 Kết quả tính DMG",
            color: 0x00ae86,
            fields,
          },
        ],
      });
    }
  });

  client.login(TOKEN);
}
