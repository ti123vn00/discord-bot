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

  // buildEncounterActionPanel — TOP-LEVEL dropdown, GAP REDESIGN (xác nhận
  // trực tiếp, spec chi tiết từ user): thay vì 1 dropdown DÀI gộp hết mọi hành
  // động, giờ chia 3 nhóm — "Attack" (M1, chọn là thực thi NGAY, không sub-menu),
  // "Moves" (mở sub-menu riêng: Critical/Page/Follow-Up-Pounce/Overcharged
  // Vessel), "Special" (mở sub-menu riêng: Shin/Manifested E.G.O/Reload/các
  // hành động đặc biệt sau này) — CHỈ hiện "Moves"/"Special" nếu có ít nhất 1
  // option bên trong (tránh bấm vào rỗng).
  function buildEncounterActionPanel(channelId, combatant, playerId) {
    if (!combatant || !playerId) return [];
    const options = [];
    if ((combatant.currentStamina ?? 0) > 0) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("⚔️ Attack (M1)").setValue("attack"));
    }
    if (buildMovesOptions(combatant).length > 0) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("🎯 Moves").setValue("openmoves"));
    }
    if (buildSpecialOptions(combatant).length > 0) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("✨ Special").setValue("openspecial"));
    }
    // "Items" — GAP MỚI (xác nhận trực tiếp): "làm thêm 1 dropdown submenu mới
    // nữa là Items (nơi chứa những consumable items trong inventory)" — thực
    // ra là consumablesLoadout (item đã MANG vào trận qua `-encounter additem`,
    // sẵn sàng dùng qua `-encounter useitem`/dropdown này) — không phải toàn bộ
    // inventory (vì luật giới hạn 4 item/trận riêng biệt với inventory tổng).
    if (buildItemsOptions(combatant).length > 0) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("🎒 Items").setValue("openitems"));
    }
    options.push(new StringSelectMenuOptionBuilder().setLabel("🏁 Kết thúc lượt của tôi").setValue("endmyturn"));
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`encmenu:${channelId}:${playerId}`)
          .setPlaceholder("Chọn hành động...")
          .addOptions(...options.slice(0, 25)),
      ),
    ];
  }

  // buildMovesOptions — TRẢ VỀ MẢNG option THÔ (không phải ActionRow) để
  // buildEncounterActionPanel dùng kiểm tra "có gì để hiện Moves không", và
  // buildMovesPanel dùng để build sub-menu thật — tránh tính 2 lần logic.
  function buildMovesOptions(combatant) {
    const options = [];
    const criticalSkill = combatant.weaponCriticalKey ? findSkill(combatant.weaponCriticalKey) : null;
    if (criticalSkill) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(`⚡ Critical: ${criticalSkill.name}`).setValue(`critical:${criticalSkill.name}`));
    }
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
    if ((hasPerk(combatant, "Follow-Up") || hasPerk(combatant, "Pounce")) && combatant.staminaUsedThisTurn >= 20 && !combatant.followUpUsedThisTurn) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("⚡ Follow-Up/Pounce").setValue("followup"));
    }
    return options;
  }

  // buildSpecialOptions — tương tự buildMovesOptions, cho nhóm "Special".
  function buildSpecialOptions(combatant) {
    const options = [];
    if (hasPerk(combatant, "Shin")) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("Shin/Mang (-25 Sanity)").setValue("shinmang").setEmoji({ id: "1528452250861699215", name: "Shin" }));
    }
    if ((combatant.emotionLevel ?? 0) >= 1) {
      options.push(new StringSelectMenuOptionBuilder().setLabel("😈 Manifest E.G.O (-30 Sanity)").setValue("manifestego"));
    }
    // "Overcharged Vessel" — GAP ĐÃ SỬA (xác nhận trực tiếp): "overcharged
    // vessel nằm ở bên Special chỉ có page, critical và followup/pounce nằm ở
    // Moves thôi" — chuyển từ Moves sang đây.
    if (hasPerk(combatant, "Overcharged Vessel") && combatant.charge >= 10) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(`⚡ Overcharged Vessel (tiêu ${combatant.charge} Charge)`).setValue("overcharge"));
    }
    if (combatant.weaponName === "Soldato Rifle") {
      options.push(new StringSelectMenuOptionBuilder().setLabel(`🔫 Reload (${combatant.bulletStack ?? 0}/8 đạn trong súng)`).setValue("reload"));
    }
    return options;
  }

  // buildMovesPanel/buildSpecialPanel — sub-menu THẬT (kèm nút "◀ Back" đầu
  // tiên để quay lại dropdown top-level Attack/Moves/Special).
  function buildMovesPanel(channelId, combatant, playerId) {
    const options = [new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...buildMovesOptions(combatant)];
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`encmenumoves:${channelId}:${playerId}`)
          .setPlaceholder("Moves — chọn hành động...")
          .addOptions(...options.slice(0, 25)),
      ),
    ];
  }

  function buildSpecialPanel(channelId, combatant, playerId) {
    const options = [new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...buildSpecialOptions(combatant)];
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`encmenuspecial:${channelId}:${playerId}`)
          .setPlaceholder("Special — chọn hành động...")
          .addOptions(...options.slice(0, 25)),
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

  // buildItemsOptions — tương tự buildMovesOptions/buildSpecialOptions, cho
  // nhóm "Items" — lấy từ consumablesLoadout (item đã mang vào trận, KHÔNG
  // phải toàn bộ inventory). Loại trùng tên (giữ đúng semantics "dùng" chỉ
  // cần biết TÊN, không quan tâm mang mấy cái cùng loại — giống pattern
  // addedPageNames ở buildMovesOptions).
  function buildItemsOptions(combatant) {
    const options = [];
    const addedItemNames = new Set();
    for (const itemName of combatant.consumablesLoadout ?? []) {
      if (itemName && !addedItemNames.has(itemName)) {
        addedItemNames.add(itemName);
        const countInLoadout = (combatant.consumablesLoadout ?? []).filter(n => n === itemName).length;
        options.push(new StringSelectMenuOptionBuilder().setLabel(`🧪 ${itemName}${countInLoadout > 1 ? ` (×${countInLoadout})` : ""}`).setValue(`useitem:${itemName}`));
      }
    }
    return options;
  }

  function buildItemsPanel(channelId, combatant, playerId) {
    const options = [new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...buildItemsOptions(combatant)];
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`encmenuitems:${channelId}:${playerId}`)
          .setPlaceholder("Items — chọn vật phẩm để dùng...")
          .addOptions(...options.slice(0, 25)),
      ),
    ];
  }

  return {
    buildEncounterActionPanel,
    buildMovesPanel,
    buildSpecialPanel,
    buildItemsPanel,
    buildBossActionPanel,
  };
};
