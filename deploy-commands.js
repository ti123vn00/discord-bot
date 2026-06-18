//  deploy-commands.js
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const {
  SANITY_MIN,
  POISE_MAX,
  SINKING_MAX,
  RUPTURE_MAX,
  PARRY_MAX_ROLLS,
  OPEN_COUNT_MAX,
  MAX_PROFILES,
  PROFILE_NAME_MAX_LENGTH,
  BUTTERFLY_LIVING_MAX,
  BUTTERFLY_DEPARTED_MAX,
} = require("./constants");
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // Set để deploy guild (nhanh hơn); bỏ trống để deploy global

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
      opt.setName("res").setDescription("Resistance Multiplier. VD: 2xS 2xB 2xP hoặc 0.5B 1.3P").setRequired(false))
    .addStringOption(opt =>
      opt.setName("dr").setDescription("% Damage Reduction flat. VD: 90%").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("bonus").setDescription("% DMG Bonus (VD: 20)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("sanitybonus").setDescription("Sanity của bản thân (VD: 15 = 15 Sanity → +15% DMG Bonus cho Dice)").setRequired(false))
    .addNumberOption(opt =>
      opt.setName("critmul").setDescription("Crit Multiplier (VD: 1.3)").setMinValue(1).setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("poise").setDescription(`Starting Poise stacks (1 stack = 5% crit, tối đa ${POISE_MAX})`)
        .setMinValue(0).setMaxValue(POISE_MAX).setRequired(false))
    .addStringOption(opt =>
      opt.setName("critdiv")
        .setDescription("Crit Divide: 'yes'/số (VD: 2, 1.5). Mặc định không dùng.")
        .setRequired(false))
    // sanity: sanity ban đầu của địch (để tính Sinking bonus khi địch đạt -45)
    .addIntegerOption(opt =>
      opt.setName("sanity").setDescription(`Sanity ban đầu của địch để tính Sinking (VD: 0, min ${SANITY_MIN})`).setMinValue(SANITY_MIN).setRequired(false))
    .addNumberOption(opt =>
      opt.setName("dicemul").setDescription("Dice Multiplier (VD: 1.2)").setMinValue(0).setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("sinking").setDescription("Sinking counts ban đầu của địch (số nguyên)").setMinValue(0).setMaxValue(SINKING_MAX).setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("rupture").setDescription("Rupture counts ban đầu của địch (số nguyên)").setMinValue(0).setMaxValue(RUPTURE_MAX).setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("living")
        .setDescription(`The Living: Count khởi đầu, hồi Sanity = count÷4 mỗi hit (tối đa ${BUTTERFLY_LIVING_MAX})`)
        .setMinValue(0).setMaxValue(BUTTERFLY_LIVING_MAX).setRequired(false))
    .addIntegerOption(opt =>
      opt.setName("departed")
        .setDescription(`The Departed: Count khởi đầu, bonus dmg = Sinking÷2+count mỗi hit (tối đa ${BUTTERFLY_DEPARTED_MAX})`)
        .setMinValue(0).setMaxValue(BUTTERFLY_DEPARTED_MAX).setRequired(false)),


  // ── /parry ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("parry")
    .setDescription("Roll xác suất parry (Attacker d16 vs Defender d20)")
    .addIntegerOption(opt =>
      opt.setName("rolls").setDescription(`Số lần roll (tối đa ${PARRY_MAX_ROLLS}, mặc định 1)`)
        .setMinValue(1).setMaxValue(PARRY_MAX_ROLLS).setRequired(false)),

  // ── /daily ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Điểm danh hàng ngày để nhận Exp, Ahn và sách (reset lúc 0h VN)"),

  // ── /randombook ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("randombook")
    .setDescription("Mở Random Book để nhận ngẫu nhiên sách thường")
    .addIntegerOption(opt =>
      opt.setName("count").setDescription(`Số lần mở (tối đa ${OPEN_COUNT_MAX}, mặc định 1)`)
        .setMinValue(1).setMaxValue(OPEN_COUNT_MAX).setRequired(false)),

  // ── /randomsealedbook ───────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("randomsealedbook")
    .setDescription("Mở Sealed Book Cache để nhận ngẫu nhiên sách hiếm")
    .addIntegerOption(opt =>
      opt.setName("count").setDescription(`Số lần mở (tối đa ${OPEN_COUNT_MAX}, mặc định 1)`)
        .setMinValue(1).setMaxValue(OPEN_COUNT_MAX).setRequired(false)),

  // ── /chipboardcache ─────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("chipboardcache")
    .setDescription("Mở Chipboard Cache để nhận Chipboard MK1–MK3 ngẫu nhiên")
    .addIntegerOption(opt =>
      opt.setName("count").setDescription(`Số lần mở (tối đa ${OPEN_COUNT_MAX}, mặc định 1)`)
        .setMinValue(1).setMaxValue(OPEN_COUNT_MAX).setRequired(false)),

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
      opt.setName("ahn").setDescription("Số Ahn muốn chuyển").setMinValue(0).setRequired(false))
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
      opt.setName("ahn").setDescription("Số Ahn muốn xóa (admin only)").setMinValue(0).setRequired(false))
    .addStringOption(opt =>
      opt.setName("books").setDescription("Xóa nhiều sách (VD: Random Book x2, N Corp Book x1)").setRequired(false))
    .addStringOption(opt =>
      opt.setName("items").setDescription("Xóa nhiều vật phẩm (VD: Chipboard MK1 x3, Chipboard MK2 x1)").setRequired(false)),

  // ── /profile ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Quản lý các save profile (tối đa 3 profile riêng biệt)")
    .addSubcommand(sub =>
      sub.setName("switch")
        .setDescription("Chuyển sang profile khác (inventory, daily, ahn đều riêng biệt)")
        .addIntegerOption(opt =>
          opt.setName("slot")
            .setDescription(`Profile muốn chuyển sang (1–${MAX_PROFILES})`)
            .setMinValue(1)
            .setMaxValue(MAX_PROFILES)
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName("info")
        .setDescription("Xem tổng quan tất cả profile và trạng thái daily của từng cái"))
    .addSubcommand(sub =>
      sub.setName("rename")
        .setDescription("Đặt tên tuỳ chỉnh cho profile hiện tại (bỏ trống để reset về mặc định)")
        .addStringOption(opt =>
          opt.setName("name")
            .setDescription(`Tên mới (tối đa ${PROFILE_NAME_MAX_LENGTH} ký tự). Bỏ trống = reset về mặc định.`)
            .setMaxLength(PROFILE_NAME_MAX_LENGTH)
            .setRequired(false))),

].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    const scope = GUILD_ID ? `guild ${GUILD_ID} (tức thì)` : "global (propagate ~1 giờ)";
    console.log(`🔄 Đang đăng ký ${commands.length} slash commands (${scope})...`);
    await rest.put(route, { body: commands });
    console.log(`✅ Đã đăng ký slash commands thành công! (${scope})`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Lỗi khi đăng ký commands:", err);
    process.exit(1);
  }
})();
