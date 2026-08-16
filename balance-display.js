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

module.exports = function ({ MANG_DMG_PCT_PER_LEVEL, findSingularity, EGO_TIER_SLOT_ORDER, getPlayerData, getActiveProfileSlot, getProfileNames, calcGrade, GRADE_MAX, GRADE_MIN, calcInjuryMaxHpPenalty, calcSkillTreePointsEarned, calcBranchPointsAllocated, PERK_BRANCH, PERK_POINT_COSTS, BRANCH_KEYS, formatNumber, EXP_MAX, INVENTORY_HINT_TEXT, findWeaponAnywhere, findOutfit, findAccessory, findSkill, isEgoSkill, getEgoTier, isConsumableItem, UNIVERSALLY_KNOWN_WEAPONS }) {

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
        // Faction & Title — Fragaria: "hai phần này sẽ hiện trong -balance luôn".
        // Nhiều đồ/page bị gate theo 2 trường này (requiresFaction/requiresTitle)
        // nên người chơi PHẢI thấy mình đang thuộc đâu, không thì không hiểu vì
        // sao không equip/dùng được.
        ...((data.faction || data.title) ? [{
          name: "🏛️ Faction & Title",
          value: [
            `> - Faction: **${data.faction ?? "*(chưa có)*"}**`,
            `> - Title: **${data.title ?? "*(chưa có)*"}**`,
          ].join("\n"),
          inline: false,
        }] : []),
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
            ` — +${(data.MangLevel ?? 1) * MANG_DMG_PCT_PER_LEVEL}% Dmg, +${data.MangLevel ?? 1} Dice Up, +${data.MangLevel ?? 1} Clash Power Up` +
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
      // ❗ Fragaria: "Blade Lineage Mentor bị dính vô field Weapon trong khi nó là
      // OUTFIT; equip vào ô weapon thì nó trở thành Blade Lineage Hwando."
      // GỐC: `findWeaponAnywhere` không tìm thấy trong weapon.js thì FALLBACK sang
      // `findSkill(raw)` — tên outfit khớp alias của một skill Weapon (Hwando) nên
      // trả về vũ khí SAI. Loại thẳng mọi tên là OUTFIT ra khỏi danh sách vũ khí.
      const ownedWeaponsSet = new Set(Object.keys(data.items ?? {}).filter(n =>
        (data.items[n] ?? 0) > 0 && !findOutfit(n) && !findAccessory(n) && findWeaponAnywhere(n)));
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
      // ── DROPDOWN 3: WEAPON / OUTFIT / ACCESSORY (equip ➕ + gỡ ➖) ──────
      // Fragaria: "sửa lại equip accessory và page ở balance giống kiểu
      // consumable item có nút equip và gỡ khỏi loadout vì hiện tại nó khá clunky".
      //
      // 3 điểm CLUNKY của bản cũ, sửa hết ở đây:
      //   (1) KHÔNG có đường gỡ — muốn tháo accessory phải nhớ gõ
      //       `-unequipaccessory <slot>`, trong khi consumable đã gỡ được bằng
      //       dropdown từ lâu.
      //   (2) Đầy 3 slot thì `findIndex(s => !s)` trả -1 → code cũ ép
      //       `targetSlot = 0` ⇒ GHI ĐÈ slot #1 mà người chơi không hề chọn.
      //       Giờ đầy slot = ẨN option equip (đúng như consumable ẩn khi đủ 4),
      //       và handler chặn lại lần nữa thay vì ghi đè.
      //   (3) Dropdown cũ KHÔNG kiểm `exclusive`/`exclusiveType` (chỉ lệnh text
      //       `-equipaccessory` mới kiểm) ⇒ đeo được 2 "Nón Ánh Sáng" qua UI.
      //       Handler mới dùng CHUNG luật với lệnh text.
      const accSlots = data.equippedAccessories ?? [null, null, null];
      const accSlotsFull = accSlots.filter(Boolean).length >= accSlots.length;
      const gearOptions = [];
      // GỠ đứng TRƯỚC: tối đa 1 outfit + 3 accessory = 4 option, không bao giờ
      // bị cắt bởi trần 25 của Discord dù người chơi sở hữu rất nhiều đồ.
      if (data.equippedOutfit) {
        gearOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel(`➖ Gỡ Outfit: ${data.equippedOutfit}`.slice(0, 100))
          .setDescription("Bỏ outfit đang mặc (Res về mặc định)")
          .setValue(`unoutfit:${data.equippedOutfit}`.slice(0, 100)).setEmoji("🗑️"));
      }
      accSlots.forEach((n, i) => {
        if (!n) return;
        gearOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel(`➖ Gỡ Accessory #${i + 1}: ${n}`.slice(0, 100))
          .setDescription("Bỏ khỏi slot accessory")
          .setValue(`unacc:${i}|${n.slice(0, 70)}`.slice(0, 100)).setEmoji("🗑️"));
      });
      gearOptions.push(
        ...ownedWeapons.map(n => new StringSelectMenuOptionBuilder().setLabel(`➕ ${n}`.slice(0, 100)).setDescription("Vũ khí — thay cây đang cầm").setValue(`weapon:${n}`).setEmoji("⚔️")),
        ...ownedOutfits.map(n => new StringSelectMenuOptionBuilder().setLabel(`➕ ${n}`.slice(0, 100)).setDescription("Outfit — thay bộ đang mặc").setValue(`outfit:${n}`).setEmoji("🧥")),
      );
      // ── SINGULARITY — ĐÚNG 1 SLOT (Fragaria: "chưa có option equip Singularity
      // ở -balance; singularity là 1 slot riêng biệt, chỉ có 1 slot duy nhất").
      if (data.equippedSingularity) {
        gearOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel(`➖ Gỡ Singularity: ${data.equippedSingularity}`.slice(0, 100))
          .setDescription("Bỏ Singularity đang mang")
          .setValue(`unsing:${data.equippedSingularity}`.slice(0, 100)).setEmoji("🌌"));
      }
      {
        const ownedSing = Object.keys(data.items ?? {}).filter(n =>
          (data.items[n] ?? 0) > 0 && findSingularity && findSingularity(n) && n !== data.equippedSingularity);
        gearOptions.push(...ownedSing.map(n => new StringSelectMenuOptionBuilder()
          .setLabel(`➕ ${n}`.slice(0, 100))
          .setDescription("Singularity — chỉ 1 slot duy nhất")
          .setValue(`singularity:${n}`.slice(0, 100)).setEmoji("🌌")));
      }
      if (!accSlotsFull) {
        gearOptions.push(...ownedAccessories.map(n => new StringSelectMenuOptionBuilder()
          .setLabel(`➕ ${n}`.slice(0, 100))
          .setDescription(`Accessory — đang ${accSlots.filter(Boolean).length}/${accSlots.length} slot`.slice(0, 100))
          .setValue(`accessory:${n}`).setEmoji("💍")));
      } else if (ownedAccessories.length > 0) {
        gearOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel(`⚠️ Đủ ${accSlots.length}/${accSlots.length} slot accessory — gỡ bớt trước`.slice(0, 100))
          .setDescription(`Còn ${ownedAccessories.length} accessory chưa đeo`.slice(0, 100))
          .setValue("noop").setEmoji("⛔"));
      }
      if (gearOptions.length > 0) {
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balequipgear:${targetUser.id}`)
            .setPlaceholder(`⚔️ Trang bị — Weapon/Outfit/Accessory (${accSlots.filter(Boolean).length}/${accSlots.length} acc)...`.slice(0, 150))
            .setMinValues(1).setMaxValues(Math.min(25, gearOptions.length))
            .addOptions(gearOptions.slice(0, 25))
        ));
      }
      // ── OFFHAND SLOT — Nebula-Stitched Grips "Left Hand" (Fragaria 14/08) ──
      // *"Làm nút trong submenu balance, CHỈ HIỆN khi player đang equip
      //  Nebula-Stitched Grips, và nó hiện ra nút để equip vũ khí phụ."*
      // ⚠️ Ẩn hoàn toàn khi không equip Nebula — Discord chặn CỨNG 5 ActionRow
      // mỗi message; thêm row vô điều kiện là đẩy row khác ra ngoài.
      if ((data.equippedWeapon ?? "").toLowerCase() === "nebula-stitched grips") {
        const offOptions = [];
        if (data.equippedOffhandWeapon) {
          offOptions.push(new StringSelectMenuOptionBuilder()
            .setLabel("❌ Tháo vũ khí phụ").setValue("off:__none__")
            .setDescription(`Đang đeo: ${data.equippedOffhandWeapon}`.slice(0, 100)));
        }
        for (const name of ownedWeaponsSet) {
          const w = findWeaponAnywhere(name);
          if (!w || w.name === "Nebula-Stitched Grips") continue;
          offOptions.push(new StringSelectMenuOptionBuilder()
            .setLabel(`${w.name}`.slice(0, 100))
            .setDescription(`${w.weight} · ${w.type} · ${w.baseDamage} Base Dmg`.slice(0, 100))
            .setValue(`off:${w.name}`.slice(0, 100)));
        }
        if (offOptions.length > 0) {
          components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`baloffhand:${targetUser.id}`)
              .setPlaceholder(`🤚 Left Hand — chọn vũ khí PHỤ${data.equippedOffhandWeapon ? ` (đang: ${data.equippedOffhandWeapon})` : ""}...`.slice(0, 150))
              .setMinValues(1).setMaxValues(1)
              .addOptions(offOptions.slice(0, 25))
          ));
        }
      }
      // ── CONSUMABLE LOADOUT ────────────────────────────────────────────
      // Fragaria: "-balance chưa có chỗ để equip consumable item đem vào
      // encounter". LUẬT: tối đa 4/trận, mỗi turn dùng 1 lần (cả 2 vế đã có sẵn
      // trong code — xem encounter-actions.js/turn-advance.js).
      //
      // ⚠️ CHỈ item trong `CONSUMABLE_ITEMS` (constants.js) — Fragaria: "chỉ có
      // Táo, Chuối, Dưa hấu, Medkit, K-Corp Ampule mới được mang vào loadout,
      // chặn toàn bộ còn lại". Bản trước tôi suy ngược "mọi item không phải
      // accessory" nên Fixer's Note / Sealed Book Cache / Chipboard Cache cũng
      // xếp được — vô nghĩa vì không có nhánh dùng cho chúng.
      //
      // ⚠️ GỘP xếp + gỡ vào MỘT dropdown: Discord chặn cứng **5 action row**
      // mỗi message. Đây là KHUÔN MẪU mà gear/page ở trên-dưới đang bắt chước.
      const equippedConsumables = data.equippedConsumables ?? [];
      const consumableCounts = {};
      for (const n of equippedConsumables) consumableCounts[n] = (consumableCounts[n] ?? 0) + 1;
      const addableConsumables = Object.keys(data.items ?? {}).filter(n =>
        (data.items[n] ?? 0) > 0 && isConsumableItem(n)
        && (consumableCounts[n] ?? 0) < data.items[n]);
      const consumableOptions = [];
      equippedConsumables.forEach((n, i) => {
        consumableOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel(`➖ Gỡ #${i + 1} ${n}`.slice(0, 100))
          .setDescription("Bỏ khỏi loadout mang vào trận")
          .setValue(`del:${i}|${n}`.slice(0, 100)).setEmoji("🗑️"));
      });
      if (equippedConsumables.length < 4) {
        for (const n of addableConsumables) {
          consumableOptions.push(new StringSelectMenuOptionBuilder()
            .setLabel(`➕ ${n} (có ${data.items[n]})`.slice(0, 100))
            .setDescription(`Xếp vào loadout — đang ${equippedConsumables.length}/4`.slice(0, 100))
            .setValue(`add:${n}`.slice(0, 100)).setEmoji("🎒"));
        }
      }
      if (consumableOptions.length > 0) {
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balconsumable:${targetUser.id}`)
            .setPlaceholder(`🎒 Item mang vào trận (${equippedConsumables.length}/4) — xếp hoặc gỡ...`)
            .setMinValues(1).setMaxValues(1)
            .addOptions(consumableOptions.slice(0, 25))
        ));
      }
      // ── DROPDOWN 4: PAGE + E.G.O PAGE (equip ➕ + gỡ ➖) ────────────────
      // GỘP Page thường và E.G.O Page vào MỘT hàng. Trước đây là 2 hàng riêng
      // ⇒ -balance có 6 action row ⇒ Discord NUỐT IM LẶNG hàng thứ 6. Chốt chặn
      // ở cuối hàm có cắt về 5 nhưng đó chỉ là "mất có báo"; gộp lại mới là
      // sửa gốc — giờ tối đa đúng 5 hàng, không bao giờ mất hàng nào.
      //
      // BỎ HẲN bước 2 "chọn slot 1–5": đó chính là chỗ clunky Fragaria nói.
      // Slot của Page KHÔNG có ý nghĩa cơ chế nào — `player-join-builder.js`
      // đọc `(profileData.equippedPages ?? []).filter(Boolean)` nên thứ tự bị
      // vứt đi hoàn toàn lúc vào trận. Vậy nên equip = lấp ô trống đầu tiên
      // (như consumable), muốn đổi chỗ thì gỡ rồi xếp lại.
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
      const pageSlots = data.equippedPages ?? [null, null, null, null, null];
      const egoSlots = data.equippedEgoPages ?? [null, null, null, null, null];
      const pageSlotsFull = pageSlots.filter(Boolean).length >= 5;
      const pageOptions = [];
      // GỠ trước (tối đa 5 + 5 = 10 option) — luôn nằm trong trần 25 nên người
      // chơi có 200 page vẫn gỡ được, chỉ phần equip mới bị cắt.
      pageSlots.forEach((n, i) => {
        if (!n) return;
        pageOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel(`➖ Gỡ Page #${i + 1}: ${n}`.slice(0, 100))
          .setDescription("Bỏ khỏi loadout Page thường")
          .setValue(`unpage:${i}|${n.slice(0, 70)}`.slice(0, 100)).setEmoji("🗑️"));
      });
      egoSlots.forEach((n, i) => {
        if (!n) return;
        pageOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel(`➖ Gỡ E.G.O #${i + 1}: ${n}`.slice(0, 100))
          .setDescription(`Slot Tier ${EGO_TIER_SLOT_ORDER[i] ?? "?"}`.slice(0, 100))
          .setValue(`unego:${i}|${n.slice(0, 70)}`.slice(0, 100)).setEmoji("🗑️"));
      });
      if (!pageSlotsFull) {
        for (const n of ownedRegularPages) {
          pageOptions.push(new StringSelectMenuOptionBuilder()
            .setLabel(`➕ ${n}`.slice(0, 100))
            .setDescription(`Page thường — đang ${pageSlots.filter(Boolean).length}/5 slot`.slice(0, 100))
            .setValue(`page:${n}`.slice(0, 100)).setEmoji("📖"));
        }
      } else if (ownedRegularPages.length > 0) {
        pageOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel("⚠️ Đủ 5/5 slot Page — gỡ bớt trước".slice(0, 100))
          .setDescription(`Còn ${ownedRegularPages.length} page chưa xếp`.slice(0, 100))
          .setValue("noop").setEmoji("⛔"));
      }
      for (const n of ownedEgoPages) {
        pageOptions.push(new StringSelectMenuOptionBuilder()
          .setLabel(`➕ ${n}`.slice(0, 100))
          .setDescription(`E.G.O Page — Tier ${getEgoTier(findSkill(n)) ?? "?"}, tự vào đúng slot Tier`.slice(0, 100))
          .setValue(`egopage:${n}`.slice(0, 100)).setEmoji("✨"));
      }
      if (pageOptions.length > 0) {
        // Tràn 25 KHÔNG được im lặng (bài học đã ghi ở HANDOFF: `slice(0,25)`
        // trần trụi làm page thứ 25 trở đi biến mất mà không ai biết).
        let pageOptionsFinal = pageOptions;
        if (pageOptions.length > 25) {
          const hidden = pageOptions.length - 24;
          pageOptionsFinal = [
            ...pageOptions.slice(0, 24),
            new StringSelectMenuOptionBuilder()
              .setLabel(`⚠️ Còn ${hidden} lựa chọn nữa không hiện được`.slice(0, 100))
              .setDescription("Discord giới hạn 25 dòng — dùng `-equippage <slot> <tên>`")
              .setValue("noop"),
          ];
        }
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balequippage:${targetUser.id}`)
            .setPlaceholder(`📖 Page (${pageSlots.filter(Boolean).length}/5) & E.G.O Page (${egoSlots.filter(Boolean).length}/5)...`.slice(0, 150))
            .setMinValues(1).setMaxValues(Math.min(25, pageOptionsFinal.length))
            .addOptions(pageOptionsFinal)
        ));
      }
    }
    // ⚠️ CHỐT CHẶN CỨNG: Discord chỉ cho **5 action row** mỗi message — hàng
    // thứ 6 trở đi bị NUỐT IM LẶNG (không báo lỗi), đúng hiện tượng Fragaria
    // gặp: "dropdown ở -balance tận 6, khiến đôi khi nó làm ẩn mất phần mở khoá
    // perks nếu đang có loadout consumable".
    // Cắt Ở ĐÂY thay vì tin rằng mọi nhánh phía trên cộng lại luôn ≤5 — thêm
    // dropdown mới sau này cũng không bao giờ làm mất hàng khác mà không báo.
    if (components.length > 5) {
      embed.footer = { text: `⚠️ Ẩn ${components.length - 5} dropdown (Discord giới hạn 5 hàng) — gỡ bớt loadout hoặc dùng lệnh text.` };
      components.length = 5;
    }
    return { embeds: [embed], components };
  }

  return { buildBalanceEmbed };
};
