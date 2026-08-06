// balance-display.js
// Hàm build embed "-balance" (Grade/EXP/Ahn/Skill Tree/dropdown tự phục vụ) —
// tách khỏi index.js theo yêu cầu trực tiếp: "tách tiếp đi, một mạch luôn".
//
// LƯU Ý QUAN TRỌNG VỀ VỊ TRÍ ĐẶT REQUIRE: findOutfit/findAccessory là CONST
// (require từ outfit.js/accessory.js), ĐỊNH NGHĨA SAU vị trí extraction gốc
// trong index.js — dòng require gọi factory này PHẢI đặt SAU 2 dòng const đó.
// findWeaponAnywhere/getEgoTier là function declaration (hoisted) nên vị trí
// không quan trọng — nhưng vẫn nhất quán inject qua factory cho rõ ràng.
// buildBalanceEmbed chỉ được GỌI bên trong thân các command handler khác (không
// phải top-level statement) nên an toàn dù định nghĩa nằm ở vị trí này.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

const { StringSelectMenuOptionBuilder, StringSelectMenuBuilder, ActionRowBuilder } = require("discord.js");

module.exports = function ({ getPlayerData, getActiveProfileSlot, getProfileNames, calcGrade, GRADE_MAX, GRADE_MIN, calcInjuryMaxHpPenalty, calcSkillTreePointsEarned, calcBranchPointsAllocated, PERK_BRANCH, PERK_POINT_COSTS, BRANCH_KEYS, formatNumber, EXP_MAX, INVENTORY_HINT_TEXT, findWeaponAnywhere, findOutfit, findAccessory, findSkill, isEgoSkill, getEgoTier, UNIVERSALLY_KNOWN_WEAPONS }) {

  async function buildBalanceEmbed(targetUser, isSelf = false) {
    const data = await getPlayerData(targetUser.id);
    // BUG ĐÃ SỬA (Fragaria: "phần hiển thị display profile name chưa đúng, nó ra
    // một số ngẫu nhiên thay vì đúng tên profile user" — ảnh chụp: "Thông tin của 8").
    // NGUYÊN NHÂN GỐC: tôi ĐOÁN SAI signature. `resolveProfileLabel(names, slot)`
    // nhận OBJECT tên (map slot→tên) và là hàm ĐỒNG BỘ; tôi lại truyền userId vào
    // vị trí `names` rồi `await` nó. Kết quả `names[String(slot)]` biến thành
    // `userId["1"]` = KÝ TỰ THỨ 2 của chuỗi userId → ra 1 chữ số ngẫu nhiên.
    // Đúng cách: lấy bảng tên bằng getProfileNames(userId) trước, rồi mới resolve.
    // resolveProfileLabel tự fallback về PROFILE_LABELS[slot] ("Profile 1"...) nếu
    // slot chưa đặt tên — nhưng ở đây ưu tiên tên Discord cho thân thiện hơn.
    const slotForName = await getActiveProfileSlot(targetUser.id);
    const profileNamesMap = await getProfileNames(targetUser.id);
    const profileLabel = profileNamesMap?.[String(slotForName)]
      ?? (targetUser.displayName ?? targetUser.username);
    const { grade, expInCurrentGrade, expNeeded } = calcGrade(data.exp ?? 0);
    const totalBooks = Object.values(data.books ?? {}).reduce((a, b) => a + b, 0);
    const totalItems = Object.values(data.items ?? {}).reduce((a, b) => a + b, 0);
    const gradeDisplay = grade === GRADE_MAX
      ? `**Grade ${grade}** (MAX)`
      : `**Grade ${grade}** (${expInCurrentGrade}/${expNeeded} EXP → Grade ${grade - 1})`;
    let progressBar = "";
    if (grade > GRADE_MAX && expNeeded) {
      const filled = Math.round((expInCurrentGrade / expNeeded) * 10);
      progressBar = "\n> " + "🟦".repeat(filled) + "⬛".repeat(10 - filled) + ` ${expInCurrentGrade}/${expNeeded}`;
    }
    // Skill Tree — hiện ĐẦY ĐỦ giống format ví dụ GM cho (Hoshino Takanashi): 7 nhánh
    // THƯỜNG (Wrath/Desire/Sloth/Gluttony/Gloom/Pride/Envy) LUÔN hiện dù =0 — Shin/
    // Light CHỈ hiện nếu ĐÃ có điểm phân bổ (>0), vì 2 nhánh này CHỈ dành cho nhân
    // vật đủ điều kiện đặc biệt (xác nhận trực tiếp từ GM) — im lặng với người
    // thường, không gây hiểu lầm "ai cũng có quyền truy cập 2 nhánh này".
    const bp = data.branchPoints ?? {};
    const pool = calcSkillTreePointsEarned(data);
    const allocated = calcBranchPointsAllocated(data);
    const STANDARD_BRANCHES = ["wrath", "desire", "sloth", "gluttony", "gloom", "pride", "envy"];
    const BRANCH_DISPLAY_NAME = { wrath: "Wrath", desire: "Desire", sloth: "Sloth", gluttony: "Gluttony", gloom: "Gloom", pride: "Pride", envy: "Envy", shin: "Shin", light: "Light" };
    const branchLines = STANDARD_BRANCHES.map(k => `${BRANCH_DISPLAY_NAME[k]}: ${bp[k] ?? 0}`);
    if ((bp.shin ?? 0) > 0) branchLines.push(`Shin: ${bp.shin}`);
    if ((bp.light ?? 0) > 0) branchLines.push(`Light: ${bp.light}`);
    const unlockedByBranch = {};
    for (const perk of data.unlockedSkillTree ?? []) {
      const b = PERK_BRANCH[perk] ?? "khác";
      unlockedByBranch[b] = unlockedByBranch[b] ?? [];
      unlockedByBranch[b].push(perk);
    }
    const perkLines = Object.entries(unlockedByBranch)
      .map(([b, perks]) => `**${BRANCH_DISPLAY_NAME[b] ?? b}:** ${perks.join(", ")}`);
    const skillTreeValue = `${branchLines.join(" | ")}\n> **Chưa phân bổ:** ${pool - allocated}/${pool} điểm` +
      (perkLines.length > 0 ? `\n\n${perkLines.join("\n")}` : "\n\n*(chưa mở khoá perk nào)*");
    // Task yêu cầu trực tiếp: "-balance nên hiện hp hiện tại" — dùng CHÍNH công
    // thức Max HP theo Grade (khớp player-join-builder.js's effectiveGradeMaxHp,
    // KHÔNG lặp lại bug carry-over đã sửa — đây CHỈ hiển thị, không tạo combatant).
    const gradeBasedMaxHpForDisplay = 140 + 20 * (GRADE_MIN - grade);
    const injuryPenaltyForDisplay = calcInjuryMaxHpPenalty(data.injuries ?? []);
    const effectiveMaxHpForDisplay = Math.max(1, gradeBasedMaxHpForDisplay - injuryPenaltyForDisplay);
    const currentHpForDisplay = Math.min(data.currentHp ?? effectiveMaxHpForDisplay, effectiveMaxHpForDisplay);
    const embed = {
      // GAP ĐÃ SỬA (Fragaria: "Ở phần -balance nên hiện profile name hiện tại hơn
      // là display name discord của user") — profile name là tên NHÂN VẬT đang
      // chơi (mỗi user có nhiều slot, mỗi slot 1 nhân vật khác nhau), nên hiện
      // display name Discord là sai ngữ cảnh RP. Fallback về tên Discord nếu slot
      // chưa được đặt tên.
      title: `💼 Thông tin của ${profileLabel}`,
      color: 0x5865f2,
      thumbnail: { url: targetUser.displayAvatarURL({ dynamic: true }) },
      fields: [
        { name: "🏅 Grade", value: gradeDisplay + progressBar, inline: false },
        { name: "❤️ HP hiện tại", value: `**${currentHpForDisplay}** / **${effectiveMaxHpForDisplay}** HP${isSelf ? `\n> Dùng \`-heal hp: <ahn>\` để hồi thêm bằng Ahn` : ""}`, inline: true },
        { name: "<:EXP:1525313466905399346> Tổng EXP", value: `**${formatNumber(data.exp ?? 0)}** / **${EXP_MAX}** EXP`, inline: true },
        { name: "💰 Ahn", value: `**${formatNumber(data.ahn ?? 0)}** Ahn`, inline: true },
        { name: "<:Lunacy:1524989409529823342> Lunacy", value: `**${formatNumber(data.lunacy ?? 0)}** Lunacy`, inline: true },
        { name: "📚 Tổng sách", value: `**${totalBooks}** cuốn`, inline: true },
        { name: "<:Equipment:1525313207021867159> Tổng vật phẩm", value: `**${totalItems}** cái`, inline: true },
        { name: "<:000:1525313179339460739> Skill Tree", value: skillTreeValue, inline: false },
        // Shin/Mang — CHỈ hiện khi profile đã mở khoá (Fragaria yêu cầu: "nên làm
        // Shin và Mang lvl hiển thị ở -balance khi player có mở khóa Shin").
        // Người chưa mở khoá không cần thấy ô này (đỡ rối + không lộ cơ chế chưa
        // tới lượt họ). `?? mặc định` để profile cũ thiếu field không hiện NaN.
        ...(data.ShinUnlock ? [{
          // Fragaria: "phần Shin / Mang ở đầu nó quá thừa" — 2 dòng bên dưới đã
          // ghi rõ "Shin Lvl …" và "Mang Lvl …" rồi, tiêu đề chỉ lặp lại.
          // Discord bắt buộc field phải có name → dùng ZWSP để ẩn hẳn dòng tiêu đề.
          name: "\u200b",
          value:
            `<:Fix_Shin:1507591140180754588> **Shin Lvl ${data.ShinLevel ?? 10}** / 50` +
            ` — giảm 0,2x mọi Res khi kích hoạt` +
            `\n<:Fix_Mang:1507591172770631822> **Mang Lvl ${data.MangLevel ?? 1}** / 5` +
            ` — +${(data.MangLevel ?? 1) * 10}% Dmg, +${data.MangLevel ?? 1} Dice Up, +${data.MangLevel ?? 1} Clash Power Up` +
            (isSelf ? "\n> Dùng **Fixer's Note** (`-usenote`) để +10 Shin Lvl và +1 Mang Lvl" : ""),
          inline: false,
        }] : []),
        // Loadout consumable — hiện LUÔN khi có, để người chơi biết mình mang gì
        // trước khi vào trận (trước đây chỉ thấy được sau khi encounter đã chạy).
        ...((data.equippedConsumables ?? []).length > 0 ? [{
          name: "🎒 Item mang vào trận",
          value: `${data.equippedConsumables.map((n, i) => `**#${i + 1}** ${n}`).join(" · ")}` +
            `\n> ${data.equippedConsumables.length}/4 slot · **mỗi turn chỉ dùng được 1 item**`,
          inline: false,
        }] : []),
      ],
      footer: { text: INVENTORY_HINT_TEXT },
    };
    // 2 dropdown TỰ PHỤC VỤ (theo yêu cầu trực tiếp: "-balance cần thêm nút cộng
    // stats với unlock skill tree") — CHỈ hiện cho CHÍNH CHỦ profile (isSelf), tránh
    // người khác vô tình/cố ý phân bổ điểm hộ người khác qua UI công khai.
    const components = [];
    if (isSelf) {
      const branchOptions = BRANCH_KEYS.map(k =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${BRANCH_DISPLAY_NAME[k]} (hiện ${bp[k] ?? 0} điểm)`.slice(0, 100))
          .setDescription("Phân bổ thêm điểm vào nhánh này")
          .setValue(`branch:${k}`)
      );
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`balbranch:${targetUser.id}`)
          .setPlaceholder("🌳 Phân bổ điểm vào 1 nhánh...")
          .addOptions(branchOptions)
      ));
      // Perk ĐỦ ĐIỀU KIỆN unlock ngay (branchPoints đủ) NHƯNG CHƯA unlock — giới hạn
      // 25 option (giới hạn cứng của Discord StringSelectMenu).
      // GAP ĐÃ SỬA (xác nhận trực tiếp phản hồi tester: "nên có multiple
      // choice cho dễ chọn nhanh hơn") — setMinValues(1)/setMaxValues(N) cho
      // phép chọn NHIỀU cùng lúc — handler áp dụng TUẦN TỰ qua interaction.values.
      const unlockedSet = new Set(data.unlockedSkillTree ?? []);
      const eligiblePerks = Object.entries(PERK_POINT_COSTS)
        .filter(([perk, cost]) => {
          if (unlockedSet.has(perk)) return false;
          const branch = PERK_BRANCH[perk];
          if (!branch) return false;
          return (bp[branch] ?? 0) >= cost;
        })
        .slice(0, 25);
      if (eligiblePerks.length > 0) {
        const perkOptions = eligiblePerks.map(([perk, cost]) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(perk.slice(0, 100))
            .setDescription(`${PERK_BRANCH[perk]} — ${cost} điểm`.slice(0, 100))
            .setValue(`perk:${perk}`)
        );
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balunlock:${targetUser.id}`)
            .setPlaceholder("🔓 Mở khoá perk đủ điều kiện (chọn nhiều được)...")
            .setMinValues(1).setMaxValues(perkOptions.length)
            .addOptions(perkOptions)
        ));
      }
      // 3 dropdown EQUIP — theo yêu cầu trực tiếp ("balance chưa thấy chỗ equip
      // page/weapon/vũ khí") — CHỈ hiện những gì ĐÃ SỞ HỮU (khớp kiến trúc mới: đọc
      // sách/GM cấp → sở hữu → equip). Gộp Weapon+Outfit+Accessory vào 1 dropdown
      // (đỡ tốn row — Discord giới hạn CỨNG 5 ActionRow/message, đã dùng 2 cho
      // branch/unlock, còn đúng 3 cho equip). Page thường và E.G.O Page tách riêng
      // vì logic slot khác nhau (E.G.O cần khớp đúng Tier).
      // BUG ĐÃ SỬA (xác nhận trực tiếp: "chưa thấy brawler được free cho tất cả
      // mọi người, vẫn chưa pick được") — dropdown TRƯỚC ĐÂY chỉ liệt kê vũ khí
      // trong data.items (SỞ HỮU THẬT), hoàn toàn KHÔNG biết tới
      // UNIVERSALLY_KNOWN_WEAPONS (Brawler — không cần sở hữu, xem equip gate ở
      // -equipweapon) — dù lệnh text vẫn cho equip đúng, dropdown không bao giờ
      // hiện Brawler làm lựa chọn. Gộp thêm universal weapons, tránh trùng lặp
      // nếu lỡ VỪA sở hữu VỪA universal.
      const ownedWeaponsSet = new Set(Object.keys(data.items ?? {}).filter(n => (data.items[n] ?? 0) > 0 && findWeaponAnywhere(n)));
      for (const key of UNIVERSALLY_KNOWN_WEAPONS) {
        const universalWeapon = findWeaponAnywhere(key);
        if (universalWeapon) ownedWeaponsSet.add(universalWeapon.name);
      }
      // GAP ĐÃ SỬA (xác nhận trực tiếp phản hồi tester: "vũ khí, outfit, page
      // đang equip rồi vẫn hiện khiến họ bị rối mắt — nên ẩn những thứ bản
      // thân đang equip") — weapon/outfit chỉ có ĐÚNG 1 slot mỗi loại nên lọc
      // trực tiếp = equippedWeapon/equippedOutfit hiện tại.
      const ownedWeapons = [...ownedWeaponsSet].filter(n => n !== data.equippedWeapon);
      const ownedOutfits = Object.keys(data.items ?? {}).filter(n => (data.items[n] ?? 0) > 0 && findOutfit(n) && n !== data.equippedOutfit);
      // Accessory: CÓ THỂ sở hữu NHIỀU hơn 1 cùng tên (equip vào nhiều slot
      // khác nhau) — chỉ ẩn khi số slot ĐÃ dùng >= số lượng SỞ HỮU (không còn
      // "phần dư" nào để equip thêm), không ẩn tuyệt đối như weapon/outfit.
      const equippedAccCounts = {};
      for (const name of (data.equippedAccessories ?? [])) { if (name) equippedAccCounts[name] = (equippedAccCounts[name] ?? 0) + 1; }
      const ownedAccessories = Object.keys(data.items ?? {}).filter(n => {
        if (!((data.items[n] ?? 0) > 0 && findAccessory(n))) return false;
        return (equippedAccCounts[n] ?? 0) < data.items[n];
      });
      const gearOptions = [
        ...ownedWeapons.map(n => new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription("Vũ khí").setValue(`weapon:${n}`).setEmoji("⚔️")),
        ...ownedOutfits.map(n => new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription("Outfit").setValue(`outfit:${n}`).setEmoji("🧥")),
        ...ownedAccessories.map(n => new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription("Accessory").setValue(`accessory:${n}`).setEmoji("💍")),
      ].slice(0, 25);
      if (gearOptions.length > 0) {
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balequipgear:${targetUser.id}`)
            .setPlaceholder("⚔️ Equip Weapon/Outfit/Accessory (chọn nhiều được)...")
            .setMinValues(1).setMaxValues(gearOptions.length)
            .addOptions(gearOptions)
        ));
      }
      // ── CONSUMABLE LOADOUT (Fragaria: "-balance chưa có chỗ để equip
      // consumable item đem vào encounter") ────────────────────────────────
      // LUẬT: "một trận chỉ có thể mang 4 consumable vào trận, và mỗi turn chỉ
      // được sử dụng một lần một consumable item".
      // Cả 2 vế ĐÃ có sẵn trong code (`consumablesLoadout` cap 4 ở
      // -encounter additem; `usedItemThisTurn` chặn 1 lần/turn ở
      // encounter-actions.js, reset ở turn-advance.js) — chỉ THIẾU đường đặt
      // trước từ -balance, nên người chơi buộc phải gõ `-encounter additem`
      // từng món SAU khi trận đã bắt đầu.
      //
      // Cách làm: lưu `data.equippedConsumables` (mảng ≤4) trên PROFILE, rồi
      // player-join-builder chép sang `combatant.consumablesLoadout` lúc join —
      // cùng mô hình với weapon/outfit/accessory/page, đặt 1 lần dùng mãi.
      // KHÔNG trừ item lúc equip: item chỉ bị tiêu lúc DÙNG trong trận
      // (encounter-actions.js đã trừ), equip chỉ là danh sách mang theo.
      const equippedConsumables = data.equippedConsumables ?? [];
      // Item được coi là consumable = có trong kho, KHÔNG phải accessory
      // (accessory đeo 3 slot riêng, không phải đồ dùng 1 lần).
      const consumableCounts = {};
      for (const n of equippedConsumables) consumableCounts[n] = (consumableCounts[n] ?? 0) + 1;
      const ownedConsumables = Object.keys(data.items ?? {}).filter(n =>
        (data.items[n] ?? 0) > 0 && !findAccessory(n)
        // Chỉ hiện món CÒN DƯ so với số đã xếp vào loadout — mang 2 Chuối thì
        // phải sở hữu ≥2, đúng luật của `-encounter additem`.
        && (consumableCounts[n] ?? 0) < data.items[n]);
      if (ownedConsumables.length > 0 && equippedConsumables.length < 4) {
        const consumableOptions = ownedConsumables.slice(0, 25).map(n =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${n} (có ${data.items[n]})`.slice(0, 100))
            .setDescription(`Mang vào trận — đang xếp ${equippedConsumables.length}/4`.slice(0, 100))
            .setValue(`consumable:${n}`).setEmoji("🎒"));
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balequipconsumable:${targetUser.id}`)
            .setPlaceholder(`🎒 Item mang vào trận (${equippedConsumables.length}/4) — chọn thêm...`)
            .setMinValues(1).setMaxValues(Math.min(consumableOptions.length, 4 - equippedConsumables.length))
            .addOptions(consumableOptions)
        ));
      }
      if (equippedConsumables.length > 0) {
        // Dropdown GỠ riêng — trùng tên vẫn gỡ đúng 1 cái nhờ value kèm index.
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balunequipconsumable:${targetUser.id}`)
            .setPlaceholder(`🗑️ Gỡ item khỏi loadout (${equippedConsumables.length}/4)...`)
            .setMinValues(1).setMaxValues(1)
            .addOptions(equippedConsumables.slice(0, 25).map((n, i) =>
              new StringSelectMenuOptionBuilder().setLabel(`#${i + 1} ${n}`.slice(0, 100)).setValue(`${i}|${n}`.slice(0, 100)).setEmoji("🗑️")))
        ));
      }
      // Page/E.G.O Page: cùng logic "số dư" như accessory (có thể sở hữu
      // nhiều bản cùng tên, equip vào nhiều slot Page/E.G.O Page khác nhau).
      const equippedPageCounts = {};
      for (const name of (data.equippedPages ?? [])) { if (name) equippedPageCounts[name] = (equippedPageCounts[name] ?? 0) + 1; }
      const equippedEgoPageCounts = {};
      for (const name of (data.equippedEgoPages ?? [])) { if (name) equippedEgoPageCounts[name] = (equippedEgoPageCounts[name] ?? 0) + 1; }
      const ownedPageNames = Object.keys(data.pages ?? {}).filter(n => (data.pages[n] ?? 0) > 0);
      const ownedRegularPages = ownedPageNames.filter(n => {
        const s = findSkill(n);
        if (!s || isEgoSkill(s)) return false;
        return (equippedPageCounts[n] ?? 0) < data.pages[n];
      });
      const ownedEgoPages = ownedPageNames.filter(n => {
        const s = findSkill(n);
        if (!s || !isEgoSkill(s)) return false;
        return (equippedEgoPageCounts[n] ?? 0) < data.pages[n];
      });
      if (ownedRegularPages.length > 0) {
        // BUG ĐÃ SỬA (Fragaria: "nên cho dropdown ở balance cho equip page theo
        // slot 1/2/3/4/5 vì giờ nó chỉ cho equip page vào slot 1").
        // TRƯỚC ĐÂY slot được CHỌN HỘ: `findIndex(s => !s)` = ô trống đầu tiên,
        // và khi ĐÃ ĐẦY 5 slot thì rơi vào `targetSlot = 0` → mọi lần equip sau
        // đều GHI ĐÈ slot 1. Người chơi không có cách nào đưa page vào slot 3.
        // Giờ chọn 1 page → hiện tiếp dropdown 5 slot (kèm page đang nằm trong
        // mỗi slot) để tự chọn. E.G.O Page vẫn tự động vì slot của nó do Tier
        // quyết định, không được chọn tay.
        const pageOptions = ownedRegularPages.slice(0, 25).map(n =>
          new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription("Chọn xong sẽ hỏi slot 1–5").setValue(`page:${n}`).setEmoji("📖")
        );
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balequippage:${targetUser.id}`)
            .setPlaceholder("📖 Equip Page thường — chọn 1 page...")
            .setMinValues(1).setMaxValues(1)
            .addOptions(pageOptions)
        ));
      }
      if (ownedEgoPages.length > 0) {
        const egoOptions = ownedEgoPages.slice(0, 25).map(n =>
          new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription(`Tier ${getEgoTier(findSkill(n)) ?? "?"} — tự vào đúng slot Tier`).setValue(`egopage:${n}`).setEmoji("✨")
        );
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balequipego:${targetUser.id}`)
            .setPlaceholder("✨ Equip E.G.O Page (chọn nhiều được)...")
            .setMinValues(1).setMaxValues(egoOptions.length)
            .addOptions(egoOptions)
        ));
      }
    }
    return { embeds: [embed], components };
  }

  return { buildBalanceEmbed };
};
