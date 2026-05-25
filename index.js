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
    // Parse input theo dạng key:value
    const input = message.content.replace('-math', '').trim();
    const parts = input.split(/\s+/);

    // Hàm tiện ích lấy số từ chuỗi
    const getVal = (key) => {
      const found = parts.find(p => p.startsWith(key + ":"));
      if (!found) return null;
      return found.split(":")[1];
    };

    // Lấy các giá trị
    const dmg = parseFloat(getVal("Dmg")) || 0;
    const bonus = parseFloat((getVal("Bonus") || "0").replace("%",""))/100;
    const mod = parseFloat((getVal("Mod") || "0").replace("%",""))/100;
    const critMul = parseFloat((getVal("CritMul") || "1").replace("x",""));
    const res = parseFloat((getVal("Res") || "1").replace("x",""));
    const critRate = parseFloat((getVal("CritRate") || "0").replace("%",""))/100;
    const critDiv = (getVal("CritDiv") || "No");

    // Công thức: (Dmg × (Bonus+Mod) × CritMultiplier) × ResistanceNumber
    const critMultiplier = 1 + critRate * (critMul - 1);
    const final = dmg * (bonus + mod) * critMultiplier * res;

    // Trả kết quả bằng embed
    message.reply({
      embeds: [{
        title: "📊 Kết quả tính DMG",
        color: 0x00AE86,
        fields: [
          { name: "Dmg", value: dmg.toString(), inline: true },
          { name: "Bonus", value: bonus.toString(), inline: true },
          { name: "Mod", value: mod.toString(), inline: true },
          { name: "CritMul", value: critMul.toString(), inline: true },
          { name: "Res", value: res.toString(), inline: true },
          { name: "CritRate", value: (critRate*100).toFixed(1) + "%", inline: true },
          { name: "CritDiv", value: critDiv, inline: true },
          { name: "Final DMG", value: final.toFixed(3), inline: false }
        ]
      }]
    });
  }
});

const TOKEN = process.env.DISCORD_TOKEN;
client.login(TOKEN);
