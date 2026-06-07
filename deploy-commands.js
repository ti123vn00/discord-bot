// deploy-commands.js
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
if (!TOKEN || !CLIENT_ID) {
  console.error("Thiếu DISCORD_TOKEN hoặc CLIENT_ID trong environment variables!");
  process.exit(1);
}
const commands = [
  new SlashCommandBuilder()
    .setName("math")
    .setDescription("Tính DMG theo công thức game Fixer")
    .addStringOption(opt =>
      opt.setName("dmg").setDescription("VD: 100B 50x2P 30DiceS+1Sinking").setRequired(true))
    .addStringOption(opt =>
      opt.setName("res").setDescription("VD: 0.5B 0.8P 1S").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("bonus").setDescription("% DMG Bonus (VD: 20)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("sanitybonus").setDescription("Sanity % DMG Bonus (VD: 15)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("critmul").setDescription("Crit Multiplier (VD: 1.3)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("critrate").setDescription("Crit Rate % (VD: 50)").setRequired(false))
    .addBooleanOption(opt =>
      opt.setName("critdiv").setDescription("Crit Divide? (mỗi lần crit, crit rate giảm đôi)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("sanity").setDescription("Sanity ban đầu của địch (VD: 45)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("dicemul").setDescription("Dice Multiplier (VD: 1.2)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("sinking").setDescription("Sinking counts ban đầu của địch").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("rupture").setDescription("Rupture counts ban đầu của địch").setRequired(false)),
  new SlashCommandBuilder()
    .setName("huntermath")
    .setDescription("Tính DMG theo công thức game Hunter")
    .addNumberOption(opt =>
      opt.setName("dmgbaseweapon").setDescription("Base DMG của vũ khí").setRequired(true))
    .addNumberOption(opt =>
      opt.setName("stat").setDescription("Stat value").setRequired(true))
    .addNumberOption(opt =>
      opt.setName("scaleskill").setDescription("Scale Skill % (VD: 150)").setRequired(true))
    .addNumberOption(opt =>
      opt.setName("bonus").setDescription("Bonus % (VD: 20)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("dmgnegationboss").setDescription("Boss DMG Negation % (VD: 30)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("vulnerability").setDescription("Vulnerability % (VD: 10)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("buffbonus").setDescription("Buff Bonus value").setRequired(false)),
  new SlashCommandBuilder()
    .setName("parry")
    .setDescription("Roll xác suất parry (Attacker d16 vs Defender d20)")
    .addIntegerOption(opt =>
      opt.setName("rolls").setDescription("Số lần roll (tối đa 50, mặc định 1)").setMinValue(1).setMaxValue(50).setRequired(false)),
  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Điểm danh hàng ngày để nhận Exp, Ahn và sách (reset lúc 0h VN)"),
  new SlashCommandBuilder()
    .setName("randombook")
    .setDescription("Mở 1 Random Book để nhận ngẫu nhiên 1 cuốn sách thường"),
  new SlashCommandBuilder()
    .setName("randomsealedbook")
    .setDescription("Mở 1 Sealed Book Cache để nhận ngẫu nhiên 1 cuốn sách hiếm"),
].map(cmd => cmd.toJSON());
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  try {
    console.log("🔄 Đang đăng ký slash commands...");
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log("✅ Đã đăng ký slash commands thành công!");
  } catch (err) {
    console.error("❌ Lỗi khi đăng ký commands:", err);
    process.exit(1);
  }
})();
