// deploy-commands.js
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("Thiếu DISCORD_TOKEN hoặc CLIENT_ID trong environment variables!");
  process.exit(1);
}

const commands = [
  // ── /math ──────────────────────────────────────────────────────────────────
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
    .addIntegerOption(opt =>
      opt.setName("poise").setDescription("Starting Poise stacks (1 stack = 5% crit, tối đa 99)")
        .setMinValue(0).setMaxValue(99).setRequired(false))
    .addBooleanOption(opt =>
      opt.setName("critdiv").setDescription("Crit Divide? (mỗi lần crit, Poise stacks giảm đôi)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("sanity").setDescription("Sanity ban đầu của địch (VD: 45)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("dicemul").setDescription("Dice Multiplier (VD: 1.2)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("sinking").setDescription("Sinking counts ban đầu của địch").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("rupture").setDescription("Rupture counts ban đầu của địch").setRequired(false)),

  // ── /huntermath ─────────────────────────────────────────────────────────────
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

  // ── /parry ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("parry")
    .setDescription("Roll xác suất parry (Attacker d16 vs Defender d20)")
    .addIntegerOption(opt =>
      opt.setName("rolls").setDescription("Số lần roll (tối đa 50, mặc định 1)")
        .setMinValue(1).setMaxValue(50).setRequired(false)),

  // ── /daily ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Điểm danh hàng ngày để nhận Exp, Ahn và sách (reset lúc 0h VN)"),

  // ── /randombook ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("randombook")
    .setDescription("Mở Random Book để nhận ngẫu nhiên sách thường")
    .addIntegerOption(opt =>
      opt.setName("count").setDescription("Số lần mở (tối đa 20, mặc định 1)")
        .setMinValue(1).setMaxValue(20).setRequired(false)),

  // ── /randomsealedbook ───────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("randomsealedbook")
    .setDescription("Mở Sealed Book Cache để nhận ngẫu nhiên sách hiếm")
    .addIntegerOption(opt =>
      opt.setName("count").setDescription("Số lần mở (tối đa 20, mặc định 1)")
        .setMinValue(1).setMaxValue(20).setRequired(false)),

  // ── /chipboardcache ─────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("chipboardcache")
    .setDescription("Mở Chipboard Cache để nhận Chipboard MK1–MK3 ngẫu nhiên")
    .addIntegerOption(opt =>
      opt.setName("count").setDescription("Số lần mở (tối đa 20, mặc định 1)")
        .setMinValue(1).setMaxValue(20).setRequired(false)),

  // ── /balance ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Xem thông tin Grade, EXP, Ahn và tổng kho")
    .addUserOption(opt =>
      opt.setName("user").setDescription("Người muốn xem (bỏ trống = bản thân)").setRequired(false)),

  // ── /inventory ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("inventory")
    .setDescription("Xem chi tiết toàn bộ sách và vật phẩm trong kho")
    .addUserOption(opt =>
      opt.setName("user").setDescription("Người muốn xem (bỏ trống = bản thân)").setRequired(false)),

  // ── /use ────────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("use")
    .setDescription("Craft vật phẩm bằng nguyên liệu trong kho")
    .addStringOption(opt =>
      opt.setName("item").setDescription("Tên vật phẩm muốn craft (VD: Chipboard MK2)").setRequired(true))
    .addIntegerOption(opt =>
      opt.setName("count").setDescription("Số lần craft (mặc định 1)")
        .setMinValue(1).setRequired(false)),

  // ── /give ───────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("give")
    .setDescription("Chuyển Ahn, sách hoặc vật phẩm cho người khác")
    .addUserOption(opt =>
      opt.setName("user").setDescription("Người nhận").setRequired(true))
    .addNumberOption(opt =>
      opt.setName("ahn").setDescription("Số Ahn muốn chuyển").setRequired(false))
    .addStringOption(opt =>
      opt.setName("book").setDescription("Tên sách muốn chuyển (VD: Random Book)").setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("bookcount").setDescription("Số lượng sách (mặc định 1)").setMinValue(1).setRequired(false))
    .addStringOption(opt =>
      opt.setName("item").setDescription("Tên vật phẩm muốn chuyển (VD: Chipboard MK1)").setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("itemcount").setDescription("Số lượng vật phẩm (mặc định 1)").setMinValue(1).setRequired(false)),

  // ── /remove ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Xóa sách hoặc vật phẩm khỏi kho (admin có thể xóa của người khác)")
    .addUserOption(opt =>
      opt.setName("user").setDescription("Người bị xóa (bỏ trống = bản thân, admin only cho người khác)").setRequired(false))
    .addStringOption(opt =>
      opt.setName("book").setDescription("Tên sách muốn xóa").setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("bookcount").setDescription("Số lượng sách (mặc định 1)").setMinValue(1).setRequired(false))
    .addStringOption(opt =>
      opt.setName("item").setDescription("Tên vật phẩm muốn xóa").setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("itemcount").setDescription("Số lượng vật phẩm (mặc định 1)").setMinValue(1).setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("exp").setDescription("Số EXP muốn xóa (admin only)").setMinValue(1).setRequired(false))
    .addNumberOption(opt =>
      opt.setName("ahn").setDescription("Số Ahn muốn xóa (admin only)").setRequired(false))
    .addStringOption(opt =>
      opt.setName("books").setDescription("Xóa nhiều sách (VD: Random Book x2, N Corp Book x1)").setRequired(false))
    .addStringOption(opt =>
      opt.setName("items").setDescription("Xóa nhiều vật phẩm (VD: Chipboard MK1 x3, Chipboard MK2 x1)").setRequired(false)),

].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log(`🔄 Đang đăng ký ${commands.length} slash commands...`);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Đã đăng ký slash commands thành công!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Lỗi khi đăng ký commands:", err);
    process.exit(1);
  }
})();
