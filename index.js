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
    let allCrit = true;
    let critCount = 0;
    let fields = [];

    dmgInstances.forEach((base) => {
    dmgInstances.forEach((base, i) => {
      const isCrit = Math.random() < critRate;
      if (!isCrit) allCrit = false;
      if (isCrit) critCount++;
      const multiplier = isCrit ? critMul : 1;
      const dmgThis = base * (1 + bonus) * multiplier * res;
      total += dmgThis;

      const rateDisplay = (critRate * 100).toFixed(1) + "%";
      const emoji = isCrit ? "✅" : "❌";
      fields.push({
        name: `#${i + 1}(${rateDisplay}) ${emoji}`,
        value: `→ ${dmgThis.toFixed(2)}`,
        inline: false
      });

      // Divide crit rate only if critDiv is enabled and this hit was crit
      if (critDiv && isCrit) {
        critRate /= 2;
      }
    });

    fields.unshift({
      name: `Hits (${critCount}/${dmgInstances.length} crit)`,
      value: "\u200B",
      inline: false
    });

    // If CritDiv is enabled and all instances crit, divide critRate
    if (critDiv && allCrit && dmgInstances.length > 1) {
      critRate = critRate / dmgInstances.length;
    }
    fields.push(
      { name: "Bonus", value: (bonus * 100).toFixed(1) + "%", inline: true },
      { name: "CritMul", value: critMul.toString(), inline: true },
      { name: "Res", value: res.toString(), inline: true },
      { name: "CritRate", value: (critRate * 100).toFixed(2) + "% (after " + critCount + " crits)", inline: true },
      { name: "CritDiv", value: critDiv ? "Yes" : "No", inline: true },
      { name: "Final DMG", value: total.toFixed(3), inline: false }
    );

    message.reply({
      embeds: [{
        title: "📊 Kết quả tính DMG",
        color: 0x00AE86,
        fields: [
          { name: "Dmg Instances", value: dmgInstances.join(" + "), inline: true },
          { name: "Bonus", value: bonus.toString(), inline: true },
          { name: "CritMul", value: critMul.toString(), inline: true },
          { name: "Res", value: res.toString(), inline: true },
          { name: "CritRate", value: (critRate*100).toFixed(2) + "%", inline: true },
          { name: "CritDiv", value: critDiv ? "Yes" : "No", inline: true },
          { name: "Final DMG", value: total.toFixed(3), inline: false }
        ]
        fields: fields
      }]
    });
  }
});

const TOKEN = process.env.DISCORD_TOKEN;
client.login(TOKEN);
