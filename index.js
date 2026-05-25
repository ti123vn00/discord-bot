const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', () => {
  console.log(`Bot đã online với tên ${client.user.tag}`);
});

client.on('messageCreate', (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('-math')) {
    const input = message.content.replace('-math', '').trim();
    const parts = input.split(/\s+/);

    const getVal = (key) => {
      const found = parts.find(p => p.startsWith(key + ":"));
      if (!found) return null;
      return found.split(":")[1];
    };

    // Parse values
    const dmgRaw = (getVal("Dmg") || "0").replace(/\s+/g, "");
    const dmgInstances = dmgRaw.split("+").map(v => parseFloat(v) || 0);

    const bonus = parseFloat((getVal("Bonus") || "0").replace("%",""))/100;
    const critMul = parseFloat((getVal("CritMul") || "1").replace("x",""));
    const res = parseFloat((getVal("Res") || "1").replace("x",""));
    let critRate = parseFloat((getVal("CritRate") || "0").replace("%",""))/100;
    const critDiv = (getVal("CritDiv") || "No").toLowerCase() === "yes";

    let total = 0;
    let critCount = 0;
    const breakdownLines = [];

    dmgInstances.forEach((base, i) => {
      const isCrit = Math.random() < critRate;
      if (isCrit) critCount++;
      const multiplier = isCrit ? critMul : 1;
      const dmgThis = base * (1 + bonus) * multiplier * res;
      total += dmgThis;

      const rateDisplay = (critRate * 100).toFixed(1) + "%";
      const emoji = isCrit ? "✅" : "❌";
      breakdownLines.push(`#${i + 1}(${rateDisplay}) ${emoji} → ${dmgThis.toFixed(2)}`);

      // Divide crit rate only if critDiv is enabled and this hit was crit
      if (critDiv && isCrit) {
        critRate /= 2;
        if (critRate < 0.05) critRate = 0;
      }
    });

    const breakdownValue = breakdownLines.join("\n");
    const critRateDisplay =
      critDiv && critCount > 0
        ? `${(parseFloat((getVal("CritRate") || "0").replace("%","")))}% → ${(critRate * 100).toFixed(2)}% (after ${critCount} crit${critCount > 1 ? "s" : ""})`
        : `${(parseFloat((getVal("CritRate") || "0").replace("%","")))}%`;

    const fields = [
      { name: `Hits (${critCount}/${dmgInstances.length} crit)`, value: breakdownValue, inline: false },
      { name: "Bonus", value: (bonus * 100).toFixed(1) + "%", inline: true },
      { name: "CritMul", value: critMul.toString() + "x", inline: true },
      { name: "Res", value: res.toString() + "x", inline: true },
      { name: "CritRate", value: critRateDisplay, inline: true },
      { name: "CritDiv", value: critDiv ? "Yes" : "No", inline: true },
      { name: "Final DMG", value: total.toFixed(3), inline: false }
    ];

    message.reply({
      embeds: [{
        title: "📊 Kết quả tính DMG",
        color: 0x00AE86,
        fields: fields
      }]
    });
  }
});

const TOKEN = process.env.DISCORD_TOKEN;
client.login(TOKEN);
