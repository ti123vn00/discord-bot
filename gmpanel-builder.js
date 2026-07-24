// gmpanel-builder.js
// buildGmPanelContent — TÁCH từ logic "-encounter gmpanel" (message-create-handler.js)
// thành 1 hàm TRẢ VỀ { embeds, components } (không tự reply), để dùng chung
// cho CẢ lệnh text "-encounter gmpanel" LẪN nút "🎛️ Mở GM Panel" mới (GAP MỚI,
// xác nhận trực tiếp: "có thể tạo 1 nút ở dưới khiến GM có thẩm quyền mở được
// gmpanel luôn") — tránh trùng lặp logic ở 2 nơi.

module.exports = function ({ ADMIN_IDS, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, getEncounter }) {
  /** buildGmPanelContent — throw Error nếu không hợp lệ (channel chưa có
   *  encounter, hoặc không phải GM/admin), ngược lại trả về { embeds, components }
   *  sẵn sàng dùng cho message.reply/interaction.reply. */
  async function buildGmPanelContent(channelId, userId) {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào — dùng `-encounter start` trước (hoặc `-encounter linkgm` nếu đang ở kênh điều khiển riêng).");
    const isAdmin = ADMIN_IDS.has(userId);
    if (!isAdmin && userId !== encounter.gmId) throw new Error("Chỉ GM/admin mới mở được bảng điều khiển.");
    const aliveEnemies = Object.entries(encounter.enemies).filter(([, e]) => e.currentHp > 0);
    const alivePlayers = Object.entries(encounter.players).filter(([, p]) => p.currentHp > 0);
    const components = [];
    if (aliveEnemies.length > 0) {
      const enemyOptions = aliveEnemies.map(([ekey, e]) =>
        new StringSelectMenuOptionBuilder().setLabel(`👹 ${e.name} (${ekey}) — ${e.currentHp}/${e.maxHp} HP`).setValue(ekey)
      );
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`gmpanelselect:${channelId}:${userId}`)
          .setPlaceholder("Chọn enemy (điều khiển hoặc chỉnh sửa)...")
          .addOptions(...enemyOptions.slice(0, 25)),
      ));
    }
    if (alivePlayers.length > 0) {
      const playerOptions = alivePlayers.map(([pid, p]) =>
        new StringSelectMenuOptionBuilder().setLabel(`🧑 ${p.name} — ${p.currentHp}/${p.maxHp} HP`).setValue(pid)
      );
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`gmpanelplayerselect:${channelId}:${userId}`)
          .setPlaceholder("Chọn player để chỉnh sửa...")
          .addOptions(...playerOptions.slice(0, 25)),
      ));
    }
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`encendturn:${channelId}:${encounter.gmId}`).setLabel("🔄 Kết thúc Turn").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gmpanelstatus:${channelId}:${userId}`).setLabel("📊 Xem trạng thái").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gmpaneladdenemy:${channelId}:${userId}`).setLabel("➕ Add Enemy").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`gmpanelquickstatus:${channelId}:${userId}`).setLabel("🎯 Set Status (chọn nhanh)").setStyle(ButtonStyle.Secondary),
    ));
    return {
      embeds: [{
        title: `🎛️ Bảng điều khiển GM — ${encounter.name}`,
        description: `Turn **${encounter.turnNumber ?? 1}** | ${aliveEnemies.length} enemy còn sống | ${alivePlayers.length} player còn sống.` +
          (aliveEnemies.length === 0 ? "\n*(Chưa có enemy nào — dùng nút ➕ Add Enemy bên dưới.)*" : ""),
        color: 0x9b59b6,
      }],
      components,
    };
  }

  return { buildGmPanelContent };
};
