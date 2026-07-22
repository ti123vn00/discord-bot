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
    const options = [];
    // "dùng m1 cạn stamina xong vẫn còn act được thông qua dropdown" — GAP ĐÃ
    // SỬA (xác nhận trực tiếp) — trước đây option M1 LUÔN hiện bất kể còn
    // Stamina hay không (chỉ chặn lúc xác nhận qua doPlayerAttack, gây cảm
    // giác "vẫn act được" ngay từ dropdown). Ẩn HẲN nếu currentStamina <= 0
    // (không đủ cho BẤT KỲ weaponWeight nào — light cần tối thiểu 5).
    if ((combatant.currentStamina ?? 0) > 0) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("⚔️ Đánh thường (M1)").setValue("attack"));
    }
    // Critical vũ khí — GAP ĐÃ SỬA (xác nhận trực tiếp: "không có dropdown để sử
    // dụng critical của vũ khí"). CHỈ hiện nếu findSkill() THỰC SỰ tìm được (loại
    // đúng trường hợp vũ khí không có Critical nào, VD Patron Librarian Baton —
    // không tự giả định dựa trên có/không field criticalSkillKey).
    const criticalSkill = combatant.weaponCriticalKey ? findSkill(combatant.weaponCriticalKey) : null;
    if (criticalSkill) {
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "Bot tự roll Durandal, tự cho vào phần
      // modal Dmg ra dmg đầu cuối lên kẻ địch") — value RIÊNG "critical:" (khác
      // "hit:" của Page thường) để handler biết cần TỰ ROLL + pre-fill dmgStr,
      // xem xử lý đầy đủ ở customId "critical:" trong encmenu select handler.
      options.push(new StringSelectMenuOptionBuilder().setLabel(`⚡ Critical: ${criticalSkill.name}`).setValue(`critical:${criticalSkill.name}`));
    }
    // GAP ĐÃ SỬA (lỗi thật từ Discord: "Invalid Form Body...
    // COMPONENT_OPTION_VALUE_DUPLICATED") — nếu CÙNG 1 tên Page được equip vào
    // NHIỀU slot khác nhau (có thể xảy ra nếu sở hữu nhiều bản — VD qua
    // -balance multi-select hoặc "-equippage <slot>" tay), cả 2 slot đều tạo
    // value "hit:<tên>" GIỐNG HỆT nhau → Discord từ chối toàn bộ dropdown.
    // Dùng Set để chỉ thêm MỖI TÊN 1 lần — dropdown không cần phân biệt slot
    // (hành động "hit" chỉ cần biết TÊN skill, không quan tâm nó ở slot nào).
    const addedPageNames = new Set();
    for (const pageName of combatant.unlockedPagesSnapshot ?? []) {
      if (pageName && !addedPageNames.has(pageName)) {
        addedPageNames.add(pageName);
        options.push(new StringSelectMenuOptionBuilder().setLabel(`📖 ${pageName}`).setValue(`hit:${pageName}`));
      }
    }
    for (const pageName of combatant.unlockedEgoPagesSnapshot ?? []) {
      if (pageName && !addedPageNames.has(pageName)) {
        addedPageNames.add(pageName);
        options.push(new StringSelectMenuOptionBuilder().setLabel(`✨ ${pageName} (E.G.O)`).setValue(`hit:${pageName}`));
      }
    }
    // "5 page đặc biệt không tốn slot page bình thường và chỉ mở khóa khi đúng
    // faction và outfit, vũ khí đang mặc" (xác nhận trực tiếp) — Unlock, Yield
    // My Flesh, Boundary of Death, Re-Load, Ignite Weaponry. Không phụ thuộc
    // unlockedPagesSnapshot — tự động hiện nếu điều kiện thoả, không cần equip
    // vào slot thường. (Tanglecleaver Reload là page-counter riêng, xử lý ở
    // reactive-defense.js chứ không phải dropdown hit: này.)
    const outfit = combatant.equippedOutfit;
    const weapon = combatant.weaponName;
    const offices = combatant.offices ?? [];
    const SPECIAL_NO_SLOT_PAGES = [
      { name: "Unlock", condition: outfit === "Index Proselyte" },
      { name: "Yield My Flesh", condition: outfit === "Blade Lineage" },
      { name: "Boundary of Death", condition: outfit === "Shi Association" },
      { name: "Re-Load", condition: weapon === "Soldato Rifle" && (outfit === "Thumb Capo IIII" || outfit === "Thumb Soldato") },
      { name: "Ignite Weaponry", condition: outfit === "Liu Association" && offices.includes("Liu Association") },
    ];
    for (const { name, condition } of SPECIAL_NO_SLOT_PAGES) {
      if (condition && !addedPageNames.has(name)) {
        addedPageNames.add(name);
        options.push(new StringSelectMenuOptionBuilder().setLabel(`📖 ${name} (không tốn slot)`).setValue(`hit:${name}`));
      }
    }
    // guard/evade/parry ĐÃ GỠ KHỎI dropdown này (xác nhận trực tiếp: "nghĩ nên bỏ
    // hẳn... thuần tương tác qua menu UI là cách tốt nhất... đã sử dụng hệ thống
    // guard mới rồi nên cái đó không cần thiết lắm") — Reactive Defense (tự động
    // hiện prompt riêng khi bị tấn công, xem sendReactiveDefensePrompt trong
    // index.js) đã thay thế hoàn toàn nhu cầu chọn phòng thủ CHỦ ĐỘNG ở đây.
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
    // "Reload" (nút RIÊNG, KHÁC Page "Re-Load") — xác nhận trực tiếp: "Page
    // Reload và hành động Reload khác nhau, nên làm 1 nút reload dành cho
    // reload thông thường ở dropdown nữa" — nạp từ kho dự trữ Encounter
    // (ammo/frostAmmo/incendiaryAmmo, đã có sẵn qua -encounter reload) vào
    // bulletStack (Soldato Rifle), số lượng tùy ý, KHÔNG giới hạn số lần/turn.
    // Chỉ hiện khi đang dùng Soldato Rifle (vũ khí DUY NHẤT dùng bulletStack).
    if (combatant.weaponName === "Soldato Rifle") {
      options.push(new StringSelectMenuOptionBuilder().setLabel(`🔫 Reload (${combatant.bulletStack ?? 0}/8 đạn trong súng)`).setValue("reload"));
    }
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "game được thiết kế là 1 turn act bao nhiêu
    // lần cũng được miễn là đủ tài nguyên... hãy làm 1 nút dropdown chỉ khi họ
    // bấm nút End Turn thì mới End Turn của họ") — TRƯỚC ĐÂY mỗi hành động tự
    // động kết thúc lượt luôn, SAI với thiết kế gốc. Giờ chỉ khi CHỌN option
    // này, turn mới thực sự chuyển sang người tiếp theo (xem value ===
    // "endmyturn" ở encmenu handler — dùng lại ĐÚNG logic advanceToNextTurnHolder
    // của lệnh "-encounter pass" đã có).
    options.push(new StringSelectMenuOptionBuilder().setLabel("🏁 Kết thúc lượt của tôi").setValue("endmyturn"));
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
   * cho MỌI hành động của enemy, không có UI nào tương tự player action panel.
   * guard/evade/parry ĐÃ GỠ (cùng lý do với buildEncounterActionPanel — Reactive
   * Defense tự động gửi prompt riêng tới kênh GM khi enemy bị tấn công, xem
   * sendReactiveDefensePrompt trong index.js) — chỉ còn "Tấn công".
   * @param enemyKey — key ngắn của enemy (VD "mo") — gắn vào customId để handler
   *  biết đang điều khiển CON NÀO khi có NHIỀU enemy trong encounter.
   */
  function buildBossActionPanel(channelId, enemyKey, gmUserId) {
    const options = [
      // GAP ĐÃ SỬA (xác nhận trực tiếp): "m1 cho boss — không có cách nào
      // trực tiếp tiêu hao stamina của boss, phần dropdown điều khiển boss
      // cần thêm option" — tách "Tấn công" cũ thành 2 lựa chọn RIÊNG: M1
      // (tự trừ Stamina theo weaponWeight, value "attackm1") và Skill/
      // Critical (không tự trừ Stamina, value "attack" giữ nguyên hành vi cũ).
      new StringSelectMenuOptionBuilder().setLabel("⚔️ M1 (tự trừ Stamina)").setValue("attackm1"),
      new StringSelectMenuOptionBuilder().setLabel("📖 Skill/Critical (không tự trừ Stamina)").setValue("attack"),
      new StringSelectMenuOptionBuilder().setLabel("🏁 Kết thúc lượt").setValue("endmyturn"),
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
