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

module.exports = function ({ getPlayerData, calcGrade, GRADE_MAX, calcSkillTreePointsEarned, calcBranchPointsAllocated, PERK_BRANCH, PERK_POINT_COSTS, BRANCH_KEYS, formatNumber, EXP_MAX, INVENTORY_HINT_TEXT, findWeaponAnywhere, findOutfit, findAccessory, findSkill, isEgoSkill, getEgoTier, UNIVERSALLY_KNOWN_WEAPONS }) {

  async function buildBalanceEmbed(targetUser, isSelf = false) {
    const data = await getPlayerData(targetUser.id);
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
    const embed = {
      title: `💼 Thông tin của ${targetUser.displayName ?? targetUser.username}`,
      color: 0x5865f2,
      thumbnail: { url: targetUser.displayAvatarURL({ dynamic: true }) },
      fields: [
        { name: "🏅 Grade", value: gradeDisplay + progressBar, inline: false },
        { name: "<:EXP:1525313466905399346> Tổng EXP", value: `**${formatNumber(data.exp ?? 0)}** / **${EXP_MAX}** EXP`, inline: true },
        { name: "💰 Ahn", value: `**${formatNumber(data.ahn ?? 0)}** Ahn`, inline: true },
        { name: "<:Lunacy:1524989409529823342> Lunacy", value: `**${formatNumber(data.lunacy ?? 0)}** Lunacy`, inline: true },
        { name: "📚 Tổng sách", value: `**${totalBooks}** cuốn`, inline: true },
        { name: "<:Equipment:1525313207021867159> Tổng vật phẩm", value: `**${totalItems}** cái`, inline: true },
        { name: "<:000:1525313179339460739> Skill Tree", value: skillTreeValue, inline: false },
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
          .setPlaceholder("<:000:1525313179339460739> Phân bổ điểm vào 1 nhánh...")
          .addOptions(branchOptions)
      ));
      // Perk ĐỦ ĐIỀU KIỆN unlock ngay (branchPoints đủ) NHƯNG CHƯA unlock — giới hạn
      // 25 option (giới hạn cứng của Discord StringSelectMenu).
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
            .setPlaceholder("🔓 Mở khoá 1 perk đủ điều kiện...")
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
      const ownedWeapons = [...ownedWeaponsSet];
      const ownedOutfits = Object.keys(data.items ?? {}).filter(n => (data.items[n] ?? 0) > 0 && findOutfit(n));
      const ownedAccessories = Object.keys(data.items ?? {}).filter(n => (data.items[n] ?? 0) > 0 && findAccessory(n));
      const gearOptions = [
        ...ownedWeapons.map(n => new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription("Vũ khí").setValue(`weapon:${n}`).setEmoji("⚔️")),
        ...ownedOutfits.map(n => new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription("Outfit").setValue(`outfit:${n}`).setEmoji("🧥")),
        ...ownedAccessories.map(n => new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription("Accessory").setValue(`accessory:${n}`).setEmoji("💍")),
      ].slice(0, 25);
      if (gearOptions.length > 0) {
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balequipgear:${targetUser.id}`)
            .setPlaceholder("⚔️ Equip Weapon/Outfit/Accessory đã sở hữu...")
            .addOptions(gearOptions)
        ));
      }
      const ownedPageNames = Object.keys(data.pages ?? {}).filter(n => (data.pages[n] ?? 0) > 0);
      const ownedRegularPages = ownedPageNames.filter(n => { const s = findSkill(n); return s && !isEgoSkill(s); });
      const ownedEgoPages = ownedPageNames.filter(n => { const s = findSkill(n); return s && isEgoSkill(s); });
      if (ownedRegularPages.length > 0) {
        const pageOptions = ownedRegularPages.slice(0, 25).map(n =>
          new StringSelectMenuOptionBuilder().setLabel(n.slice(0, 100)).setDescription("Page — tự chọn slot trống đầu tiên").setValue(`page:${n}`).setEmoji("📖")
        );
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`balequippage:${targetUser.id}`)
            .setPlaceholder("📖 Equip Page thường đã sở hữu...")
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
            .setPlaceholder("✨ Equip E.G.O Page đã sở hữu...")
            .addOptions(egoOptions)
        ));
      }
    }
    return { embeds: [embed], components };
  }

  return { buildBalanceEmbed };
};
