// encounter-panels.js
// Hàm build dropdown UI cho player (buildEncounterActionPanel) và GM điều khiển
// boss (buildBossActionPanel) — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp
// tục tách hàm ra thành file riêng". Cả 2 hàm HOÀN TOÀN THUẦN (chỉ tạo UI
// component từ combatant object, không Redis/side-effect).
//
// LƯU Ý QUAN TRỌNG (bài học từ lần tách encounter-actions.js trước): findSkill
// đến từ `const { findSkill } = require("./skills")` — đây là CONST, KHÔNG được
// hoisting như function declaration (có Temporal Dead Zone) — dòng require gọi
// factory này BẮT BUỘC phải đặt SAU dòng import skills.js trong index.js, nếu
// không sẽ lỗi "Cannot access 'findSkill' before initialization" ngay lúc khởi
// động (đã tự kiểm tra kỹ và xác nhận không có gì gọi 2 hàm này ở khoảng giữa).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

const { StringSelectMenuOptionBuilder, StringSelectMenuBuilder, ActionRowBuilder } = require("discord.js");

module.exports = function ({ findSkill, hasPerk }) {

  function buildEncounterActionPanel(channelId, combatant, playerId) {
    if (!combatant || !playerId) return [];
    const options = [
      new StringSelectMenuOptionBuilder().setLabel("⚔️ Đánh thường (M1)").setValue("attack"),
    ];
    // Critical vũ khí — GAP ĐÃ SỬA (xác nhận trực tiếp: "không có dropdown để sử
    // dụng critical của vũ khí"). CHỈ hiện nếu findSkill() THỰC SỰ tìm được (loại
    // đúng trường hợp vũ khí không có Critical nào, VD Patron Librarian Baton —
    // không tự giả định dựa trên có/không field criticalSkillKey).
    const criticalSkill = combatant.weaponCriticalKey ? findSkill(combatant.weaponCriticalKey) : null;
    if (criticalSkill) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(`⚡ Critical: ${criticalSkill.name}`).setValue(`hit:${criticalSkill.name}`));
    }
    for (const pageName of combatant.unlockedPagesSnapshot ?? []) {
      if (pageName) options.push(new StringSelectMenuOptionBuilder().setLabel(`📖 ${pageName}`).setValue(`hit:${pageName}`));
    }
    for (const pageName of combatant.unlockedEgoPagesSnapshot ?? []) {
      if (pageName) options.push(new StringSelectMenuOptionBuilder().setLabel(`✨ ${pageName} (E.G.O)`).setValue(`hit:${pageName}`));
    }
    options.push(
      new StringSelectMenuOptionBuilder().setLabel("🛡️ Guard (-10 Sta, giảm 90% dmg)").setValue("guard"),
      new StringSelectMenuOptionBuilder().setLabel("💨 Evade (-20 Sta, né 100%)").setValue("evade"),
      new StringSelectMenuOptionBuilder().setLabel("🗡️ Parry (0 Sta, roll d20)").setValue("parry"),
    );
    if (hasPerk(combatant, "Shin")) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("🌑 Shin/Mang (-25 Sanity)").setValue("shinmang"));
    }
    if ((combatant.emotionLevel ?? 0) >= 1) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("😈 Manifest E.G.O (-30 Sanity)").setValue("manifestego"));
    }
    if (hasPerk(combatant, "Overcharged Vessel") && combatant.charge >= 10) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(`⚡ Overcharged Vessel (tiêu ${combatant.charge} Charge)`).setValue("overcharge"));
    }
    if ((hasPerk(combatant, "Follow-Up") || hasPerk(combatant, "Pounce")) && combatant.staminaUsedThisTurn >= 20 && !combatant.followUpUsedThisTurn) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("⚡ Follow-Up/Pounce").setValue("followup"));
    }
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`encmenu:${channelId}:${playerId}`)
          .setPlaceholder("Chọn hành động...")
          .addOptions(...options.slice(0, 25)), // Discord cap 25 — slice phòng hờ nếu equip đủ 10 page + nhiều buff cùng lúc
      ),
    ];
  }
  
  /**
   * buildBossActionPanel — dropdown GM dùng để điều khiển 1 ENEMY/BOSS cụ thể, theo
   * yêu cầu trực tiếp: "phần encounter của boss cần 1 lệnh UI" — trước đây GM phải
   * gõ tay TỪNG lệnh text (`-encounter enemyattack key: ... target: ... dmg: ...`)
   * cho MỌI hành động của enemy, không có UI nào tương tự player action panel. Chỉ
   * gồm Attack/Guard/Evade/Parry (4 hành động PHỔ BIẾN NHẤT) — Shin/Mang/Manifest
   * E.G.O/Overcharge/Follow-Up là cơ chế RIÊNG của PLAYER (Skill Tree perk cá nhân),
   * KHÔNG áp dụng cho enemy nên không đưa vào đây.
   * @param enemyKey — key ngắn của enemy (VD "mo") — gắn vào customId để handler
   *  biết đang điều khiển CON NÀO khi có NHIỀU enemy trong encounter.
   */
  function buildBossActionPanel(channelId, enemyKey, gmUserId) {
    const options = [
      new StringSelectMenuOptionBuilder().setLabel("⚔️ Tấn công (M1/skill)").setValue("attack"),
      new StringSelectMenuOptionBuilder().setLabel("🛡️ Guard").setValue("guard"),
      new StringSelectMenuOptionBuilder().setLabel("💨 Evade").setValue("evade"),
      new StringSelectMenuOptionBuilder().setLabel("🗡️ Parry").setValue("parry"),
    ];
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`bossmenu:${channelId}:${enemyKey}:${gmUserId}`)
          .setPlaceholder(`Điều khiển ${enemyKey}...`)
          .addOptions(...options)
      ),
    ];
  }

  return {
    buildEncounterActionPanel,
    buildBossActionPanel,
  };
};
