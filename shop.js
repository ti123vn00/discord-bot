// shop.js — Cửa hàng (Fragaria yêu cầu trực tiếp).
// Gồm 2 phần:
//   1. RESET toàn bộ stats point + skill tree — 1.000.000 Ahn.
//   2. Bán consumable / accessory / ammo.
//
// LƯU Ý THIẾT KẾ:
// - Tất cả item bán ở đây ĐỀU đã có logic sử dụng sẵn (Chuối/Táo/Dưa hấu/Medkit ở
//   encounter-actions.js's performUseItem; 3 accessory ở player-join-builder.js;
//   ammo ở Reload/Firing) — shop CHỈ là đường mua, không thêm cơ chế mới.
// - Mua bị kẹp bởi ITEM_STACK_MAX (99) như mọi nguồn item khác.
// - Accessory là hàng ĐỘC NHẤT về mặt sử dụng (chỉ đeo được 3 slot) nhưng KHÔNG
//   chặn mua nhiều — người chơi có thể mua dự phòng/cho profile khác.
module.exports = function ({
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  MessageFlags, withLock, getPlayerDataWithSlot, savePlayerData, formatNumber, ITEM_STACK_MAX, log,
}) {
  const RESET_COST = 1_000_000;

  /** SHOP_CATALOG — 1 nguồn sự thật cho cả UI lẫn xử lý mua.
   *  `key` phải TRÙNG tên item trong kho (data.items[...]) để logic dùng item
   *  hiện có nhận ra — KHÔNG đặt tên mới. */
  const SHOP_CATALOG = [
    { key: "Chuối", price: 10_000, emoji: "🍌", desc: "Hồi phục 10 HP" },
    { key: "Táo", price: 20_000, emoji: "🍎", desc: "Giảm 1 Dmg phải nhận trong 1 Turn" },
    { key: "Dưa hấu", price: 50_000, emoji: "🍉", desc: "Hồi phục 20 Stamina" },
    { key: "Medkit", price: 50_000, emoji: "🩹", desc: "Chữa các chấn thương nhẹ" },
    { key: "Ammo", price: 10_000, emoji: "🔫", desc: "Đạn thường — 1 viên" },
    { key: "Incendiary Ammo", price: 50_000, emoji: "🔥", desc: "Đạn cháy — 1 viên" },
    { key: "Frost Ammo", price: 50_000, emoji: "❄️", desc: "Đạn băng — 1 viên" },
    { key: "Giày Wan MK3", price: 10_000_000, emoji: "👟", desc: "Accessory — Resourceful / Chain-Dashes / Quickstep" },
    { key: "Composition Tool", price: 10_000_000, emoji: "🧩", desc: "Accessory — Reactive / Shimmering / Energetic" },
    { key: "Perfect Cube", price: 10_000_000, emoji: "🎲", desc: "Accessory — Perfect Start / Mind / Body" },
  ];
  const CATALOG_BY_KEY = Object.fromEntries(SHOP_CATALOG.map(i => [i.key, i]));

  /** Số lượng mua mỗi lần bấm — ammo mua lẻ hay bị bấm nhiều lần nên cho gói sẵn. */
  const QUANTITY_CHOICES = [1, 5, 10];

  function buildShopEmbed(data) {
    const lines = SHOP_CATALOG.map(i =>
      `${i.emoji} **${i.key}** — ${formatNumber(i.price)} Ahn\n> ${i.desc}` +
      `${(data.items?.[i.key] ?? 0) > 0 ? ` *(đang có ${data.items[i.key]})*` : ""}`
    );
    return {
      title: "🏪 Cửa hàng",
      description:
        `💰 Số dư: **${formatNumber(data.ahn ?? 0)} Ahn**\n\n` +
        `${lines.join("\n\n")}\n\n` +
        `♻️ **Reset toàn bộ điểm Stats + Skill Tree** — ${formatNumber(RESET_COST)} Ahn\n` +
        `> Hoàn lại TOÀN BỘ điểm đã phân bổ (xoá hết perk đã mở). Dùng khi muốn xây lại build.`,
      color: 0xf1c40f,
      footer: { text: `Mỗi item tối đa ${ITEM_STACK_MAX} cái trong kho.` },
    };
  }

  function buildShopComponents(userId) {
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`shopbuy:${userId}`)
          .setPlaceholder("🛒 Chọn món muốn mua...")
          .addOptions(SHOP_CATALOG.map(i =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${i.key} — ${formatNumber(i.price)} Ahn`.slice(0, 100))
              .setDescription(i.desc.slice(0, 100))
              .setValue(`item:${i.key}`)
              .setEmoji(i.emoji)
          ))
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`shopreset:${userId}`)
          .setLabel(`♻️ Reset Stats + Skill Tree (${formatNumber(RESET_COST)} Ahn)`)
          .setStyle(ButtonStyle.Danger)
      ),
    ];
  }

  /** buildQuantityComponents — bước 2 sau khi chọn món: chọn số lượng.
   *  Tách 2 bước để tránh 30 option (10 món × 3 số lượng) trong 1 dropdown. */
  function buildQuantityComponents(userId, itemKey) {
    const item = CATALOG_BY_KEY[itemKey];
    return [new ActionRowBuilder().addComponents(
      ...QUANTITY_CHOICES.map(q =>
        new ButtonBuilder()
          .setCustomId(`shopqty:${userId}:${itemKey}:${q}`)
          .setLabel(`×${q} (${formatNumber(item.price * q)} Ahn)`)
          .setStyle(ButtonStyle.Primary)
      ),
      new ButtonBuilder().setCustomId(`shopback:${userId}`).setLabel("◀ Quay lại").setStyle(ButtonStyle.Secondary),
    )];
  }

  /** purchase — trừ Ahn + cộng item, TẤT CẢ trong 1 lock để không mua đúp khi
   *  bấm nhanh 2 lần (Discord cho phép double-click gửi 2 interaction).
   *  @returns {ok, message} */
  async function purchase(userId, itemKey, quantity) {
    const item = CATALOG_BY_KEY[itemKey];
    if (!item) return { ok: false, message: "❌ Món này không có trong cửa hàng." };
    const qty = Math.max(1, Math.min(99, parseInt(quantity, 10) || 1));
    return withLock(userId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(userId);
      const total = item.price * qty;
      if ((data.ahn ?? 0) < total) {
        return { ok: false, message: `❌ Không đủ Ahn — cần **${formatNumber(total)}**, bạn có **${formatNumber(data.ahn ?? 0)}**.` };
      }
      data.items = data.items ?? {};
      const before = data.items[itemKey] ?? 0;
      if (before >= ITEM_STACK_MAX) {
        return { ok: false, message: `❌ **${itemKey}** đã đạt giới hạn ${ITEM_STACK_MAX} trong kho.` };
      }
      // Chỉ tính tiền phần THỰC SỰ nhận được — nếu cap chặn bớt thì không thu
      // tiền phần thừa (tránh mất Ahn mà không nhận hàng).
      const actualQty = Math.min(qty, ITEM_STACK_MAX - before);
      const actualCost = item.price * actualQty;
      data.ahn = (data.ahn ?? 0) - actualCost;
      data.items[itemKey] = before + actualQty;
      await savePlayerData(userId, data, slot);
      return {
        ok: true,
        message: `✅ Đã mua **${item.emoji} ${itemKey} ×${actualQty}** — trừ ${formatNumber(actualCost)} Ahn.` +
          `${actualQty < qty ? ` *(chỉ mua được ${actualQty} do giới hạn kho ${ITEM_STACK_MAX})*` : ""}\n` +
          `> Còn lại: **${formatNumber(data.ahn)} Ahn** · **${itemKey}**: ${data.items[itemKey]}`,
        data,
      };
    });
  }

  /** resetSkillTree — hoàn lại TOÀN BỘ điểm đã phân bổ.
   *
   *  BUG ĐÃ SỬA (Fragaria: "chỗ reset stats + skill tree chưa hoạt động, nó chỉ
   *  clear unlocked skill tree ra chứ stats không được hoàn trả lại khiến không
   *  thể đổi build được... sau khi reset xong tôi vẫn còn kẹt Light: 50").
   *
   *  NGUYÊN NHÂN GỐC: tôi GIẢ ĐỊNH điểm nhánh được SUY RA từ `unlockedSkillTree`
   *  nên xoá danh sách perk là tự hoàn hết. SAI — có HAI kho dữ liệu ĐỘC LẬP:
   *    • `data.branchPoints`      = điểm đã rót vào TỪNG NHÁNH (Wrath/Light/...)
   *    • `data.unlockedSkillTree` = danh sách perk đã mở bằng số điểm đó
   *  `calcBranchPointsAllocated` đọc THẲNG `branchPoints`, hoàn toàn không liên
   *  quan tới `unlockedSkillTree`. Xoá 1 kho mà giữ kho kia → perk mất sạch
   *  nhưng điểm vẫn kẹt trong nhánh cũ: mất build mà KHÔNG đổi được build mới.
   *
   *  SỬA: xoá CẢ HAI. Điểm khả dụng = calcSkillTreePointsEarned(grade) −
   *  calcBranchPointsAllocated(branchPoints), nên `branchPoints = {}` là trả hết
   *  điểm về pool. */
  async function resetSkillTree(userId) {
    return withLock(userId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(userId);
      if ((data.ahn ?? 0) < RESET_COST) {
        return { ok: false, message: `❌ Không đủ Ahn — cần **${formatNumber(RESET_COST)}**, bạn có **${formatNumber(data.ahn ?? 0)}**.` };
      }
      const clearedPerks = (data.unlockedSkillTree ?? []).length;
      const clearedPoints = Object.values(data.branchPoints ?? {}).reduce((a, b) => a + (b ?? 0), 0);
      // Chặn khi KHÔNG có gì để reset — phải kiểm CẢ HAI kho, vì người chơi hoàn
      // toàn có thể đã rót điểm vào nhánh mà chưa mở perk nào (đúng tình huống
      // trong ảnh Fragaria gửi: Light 50 điểm, 0 perk).
      if (clearedPerks === 0 && clearedPoints === 0) {
        return { ok: false, message: "⚠️ Bạn chưa phân bổ điểm hay mở perk nào — không có gì để reset (không trừ Ahn)." };
      }
      data.ahn = (data.ahn ?? 0) - RESET_COST;
      data.unlockedSkillTree = [];
      data.branchPoints = {};
      await savePlayerData(userId, data, slot);
      log("info", "shop-reset", userId, `cleared ${clearedPerks} perks + ${clearedPoints} branch points`);
      return {
        ok: true,
        message: `♻️ Đã reset — hoàn lại **${clearedPoints} điểm** đã rót vào nhánh và xoá **${clearedPerks} perk**.\n` +
          `> Trừ ${formatNumber(RESET_COST)} Ahn · còn **${formatNumber(data.ahn)} Ahn**.\n` +
          `> Dùng \`-balance\` để phân bổ lại từ đầu.`,
        data,
      };
    });
  }

  return {
    SHOP_CATALOG, CATALOG_BY_KEY, RESET_COST,
    buildShopEmbed, buildShopComponents, buildQuantityComponents,
    purchase, resetSkillTree,
  };
};
