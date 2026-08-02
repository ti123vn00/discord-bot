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

// EXTRA_CRITICALS — Critical THỨ 2 (và 3) của từng vũ khí, kèm ĐIỀU KIỆN mở khoá.
// `cond(combatant)` trả { ok, note } — note hiện trong label để người chơi biết
// giá phải trả. Điều kiện lấy NGUYÊN VĂN từ field `cost` của skill trong skills.js
// (đã đọc và đối chiếu từng cái), KHÔNG tự chế thêm luật mới.
const EXTRA_CRITICALS = [
  // Index Longsword — "Castigation" chain sau khi Unlock đủ 3 lần (Unlocked Blade).
  // Điều kiện KHỚP với gate đã có ở skill-verification.js (unlockBladeStage >= 3),
  // nếu lệch nhau thì nút hiện ra rồi bấm lại báo lỗi.
  {
    weapon: "Index Longsword", skillKey: "castigation",
    cond: (c) => ({ ok: (c.unlockBladeStage ?? 0) >= 3, note: "Unlocked Blade" }),
  },
  // Mook Workshop — "Slay All", cost ghi rõ "Cần kẻ địch Airborne". Panel KHÔNG
  // truy được encounter (chỉ nhận combatant) nên không tự kiểm tra được địch nào
  // đang Airborne — hiện nút kèm nhắc điều kiện, để skill-verification chặn thật.
  {
    weapon: "Mook Workshop", skillKey: "slay all",
    cond: () => ({ ok: true, note: "cần địch Airborne" }),
  },
  // Mimicry Blade — "Great Split", cost "Tiêu 5 Imitation". Bản Horizontal cần
  // THÊM "bản thân dưới 30% HP" nên chỉ hiện khi đủ cả 2.
  {
    weapon: "Mimicry Blade", skillKey: "great split vertical",
    cond: (c) => ({ ok: (c.imitation ?? 0) >= 5, note: "tiêu 5 Imitation" }),
  },
  {
    weapon: "Mimicry Blade", skillKey: "great split horizontal",
    cond: (c) => ({
      ok: (c.imitation ?? 0) >= 5 && c.maxHp > 0 && c.currentHp < c.maxHp * 0.3,
      note: "tiêu 5 Imitation, <30% HP",
    }),
  },
  // Soldato Rifle — "Shock Round" (trước đây hardcode riêng, giờ vào bảng chung).
  {
    weapon: "Soldato Rifle", skillKey: "shock round",
    cond: (c) => ({ ok: (c.bulletStack ?? 0) >= 5, note: `tiêu 5 đạn, còn ${c.bulletStack ?? 0}` }),
  },
];

module.exports = function ({ findSkill, hasPerk, hasShinAccess }) {

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
    // "Atelier Logic" — GAP ĐÃ SỬA (Fragaria: "Atelier Logic chưa hoạt động, cụ
    // thể là critical xong không đổi qua lại giữa dạng shotgun và pistol").
    // Vũ khí có 2 FORM, mỗi form là 1 Critical riêng, và mô tả roll() của cả 2
    // đều ghi rõ "sau đó đổi qua dạng <form kia>". Nhưng weaponCriticalKey là
    // giá trị TĨNH lấy từ weapon.js lúc join ("atelier logic shotgun") nên nút
    // Critical VĨNH VIỄN là Shotgun — không có state nào theo dõi form cả.
    // Giờ form lưu ở `atelierLogicForm` ("shotgun"/"pistols"), panel đọc field
    // này để dựng nút, resolve-pending-action.js lật form sau khi dùng.
    const isAtelierLogic = combatant.weaponName === "Atelier Logic";
    const criticalKeyEffective = isAtelierLogic
      ? `atelier logic ${combatant.atelierLogicForm ?? "shotgun"}`
      : combatant.weaponCriticalKey;
    const criticalSkill = criticalKeyEffective ? findSkill(criticalKeyEffective) : null;
    if (criticalSkill) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(`⚡ Critical: ${criticalSkill.name}`).setValue(`critical:${criticalSkill.name}`));
    }
    // ── CRITICAL THỨ 2 (BUG ĐÃ SỬA — Fragaria: "khi xài mấy weap không kích
    // crit-2 khi đủ condition... Index Longsword, Mook Workshop, Brawler" +
    // "cây Mimicry khi đủ 5 stack không có sài crit 2") ───────────────────────
    // NGUYÊN NHÂN GỐC: `weaponCriticalKey` chỉ chứa ĐÚNG 1 giá trị, nên panel
    // vĩnh viễn chỉ hiện được 1 Critical. Crit-2 duy nhất từng được làm là Shock
    // Round — HARDCODE riêng cho Soldato Rifle. Mọi vũ khí khác có Critical thứ
    // 2 (đã tồn tại đầy đủ trong skills.js với `weaponOf` đúng) KHÔNG có đường
    // nào để bấm.
    // Giờ gom thành BẢNG chung: mỗi entry = { weapon, skillKey, cond, label }.
    // Thêm crit-2 cho vũ khí mới = thêm 1 dòng ở đây, không phải sửa logic.
    for (const extra of EXTRA_CRITICALS) {
      if (combatant.weaponName !== extra.weapon) continue;
      const sk = findSkill(extra.skillKey);
      if (!sk) continue;
      const state = extra.cond(combatant);
      if (!state.ok) continue;
      options.push(new StringSelectMenuOptionBuilder()
        .setLabel(`⚡ Critical: ${sk.name}${state.note ? ` (${state.note})` : ""}`.slice(0, 100))
        .setValue(`critical:${sk.name}`));
    }
    // "You're Too Slow" — option đòn đâm sau khi counter thành công (Fragaria yêu
    // cầu: "đánh dấu kẻ địch bị counter rồi hiện tiếp option ở moves để tấn công
    // kẻ địch gây dmg sau đó skill sẽ bắt đầu cd"). Đặt ĐẦU danh sách cho dễ thấy
    // — đây là hành động có thời hạn (mất khi mục tiêu gục).
    if (combatant.youreTooSlowMark?.markedTargetId) {
      options.push(new StringSelectMenuOptionBuilder()
        .setLabel(`⚡ You're Too Slow — Đâm ${combatant.youreTooSlowMark.markedLabel ?? "mục tiêu đã đánh dấu"}`.slice(0, 100))
        .setValue("ytsfollowup"));
    }
    const addedPageNames = new Set();
    // GAP ĐÃ SỬA (Fragaria báo trực tiếp: "counter page và light dash/fleetfoot
    // steps sử dụng tùy ý được ở moves — nên xóa ra ở moves, đáng lẽ phải chỉ
    // được dùng ở reactive defense"). TRƯỚC ĐÂY dropdown Moves đổ THẲNG toàn bộ
    // unlockedPagesSnapshot/unlockedEgoPagesSnapshot, không lọc gì — nên page
    // PHẢN ỨNG (counter page dùng qua minigame rtparry khi BỊ đánh; Light Dash/
    // Fleet Footsteps chỉ để né 1 đòn) vẫn bấm chủ động được lúc tới lượt mình,
    // vô nghĩa về luật và cho phép "đốt" CD/Light miễn phí.
    // 2 tiêu chí lọc:
    //   - skill.counterEffect  → page-counter (đã có nút riêng ở prompt Reactive
    //                            Defense, xem reactive-defense.js)
    //   - skill.reactiveOnly   → cờ tường minh (Light Dash / Fleet Footsteps)
    function isReactiveOnlyPage(pageName) {
      const sk = findSkill(pageName);
      if (!sk) return false;
      return !!(sk.counterEffect || sk.reactiveOnly);
    }
    for (const pageName of combatant.unlockedPagesSnapshot ?? []) {
      if (pageName && !addedPageNames.has(pageName) && !isReactiveOnlyPage(pageName)) {
        addedPageNames.add(pageName);
        options.push(new StringSelectMenuOptionBuilder().setLabel(`📖 ${pageName}`).setValue(`hit:${pageName}`));
      }
    }
    for (const pageName of combatant.unlockedEgoPagesSnapshot ?? []) {
      if (pageName && !addedPageNames.has(pageName) && !isReactiveOnlyPage(pageName)) {
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
      if (condition && !addedPageNames.has(name) && !isReactiveOnlyPage(name)) {
        addedPageNames.add(name);
        options.push(new StringSelectMenuOptionBuilder().setLabel(`📖 ${name}`).setValue(`hit:${name}`));
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
    // BUG ĐÃ SỬA — dùng hasShinAccess thay hasPerk("Shin") trần: perk "Shin"
    // TRƯỚC ĐÂY không tồn tại trong PERK_POINT_COSTS/PERK_BRANCH nên không ai
    // cấp được, và người đã có perk NHÁNH shin vẫn bị chặn. Xem skill-tree.js.
    if (hasShinAccess(combatant)) {
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
