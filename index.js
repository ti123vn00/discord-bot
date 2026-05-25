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

    dmgInstances.forEach((base) => {
      const isCrit = Math.random() < critRate;
      if (!isCrit) allCrit = false;
      const multiplier = isCrit ? critMul : 1;
      const dmgThis = base * (1 + bonus) * multiplier * res;
      total += dmgThis;
    });

    // If CritDiv is enabled and all instances crit, divide critRate
    if (critDiv && allCrit && dmgInstances.length > 1) {
      critRate = critRate / dmgInstances.length;
    }

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
      }]
    });
  }
});

const TOKEN = process.env.DISCORD_TOKEN;
client.login(TOKEN);
