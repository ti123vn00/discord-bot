// misc-helpers.js
// Gộp 4 hàm tiện ích nhỏ trước đây bị tách thành 4 file riêng biệt (damage-
// reduction.js, equip-target.js, pending-list.js, parse-batch.js) — theo phản
// hồi trực tiếp: những file đó chỉ 24-30 dòng, phần "đóng gói" (factory wrapper,
// comment header, require line) còn dài hơn cả logic thật, không đáng có file
// riêng. Gộp về đây để giảm số file mà vẫn giữ tách khỏi index.js.
//
// computeDefenderDmgReduction cần hasPerk. resolveEquipTarget cần ADMIN_IDS.
// buildPendingListText/parseBatchEntries không cần dependency ngoài nào.
//
// COPY NGUYÊN VĂN từ index.js/các file cũ (không sửa 1 dòng logic nào).

module.exports = function ({ hasPerk, ADMIN_IDS }) {

  function computeDefenderDmgReduction(defender, { isM1 = false, isMiddleSkill = false, attackerId = null } = {}) {
    let reductionPct = defender.gmReductionPctOverride ?? 0;
    // "Dullahan" (Fused Blade passive) — xác nhận trực tiếp: "Khi có Dullahan
    // bạn... giảm 15% Dmg Reduction".
    if ((defender.dullahanStacks ?? 0) > 0) reductionPct -= 15;
    if (hasPerk(defender, "Smoldering Resolve") && defender.currentHp < defender.maxHp * 0.4) reductionPct += 10;
    if (hasPerk(defender, "No Will To Break") && defender.manifestedEGO) reductionPct += 20;
    // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — "Reverberation
    // Ensemble" (outfit): "Cho bạn 40% Dmg Reduction" — cố định, không điều
    // kiện. BUG ĐÃ SỬA: combatant không có field chung "outfitName" nào cả —
    // mỗi outfit-specific mechanic tự tạo 1 boolean flag riêng lúc join (giống
    // pattern hasIronHorus đã có), không phải defender.equippedOutfit (field
    // đó chỉ tồn tại trên profileData, không tồn tại trên combatant).
    if (defender.hasReverberationEnsemble) reductionPct += 40;
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "các status làm tăng dmg nhận... khác
    // biệt với Dmg Bonus là người khác cũng có thể hưởng lợi do là debuff lên
    // người kẻ địch") — Fragile/Smoke/Vengeance Mark/Tremor Decay/Gaze[Awe]/
    // Hemorrhage (TẤT CẢ TĂNG dmg nhận) đã CHUYỂN sang computeAttackerPerkContext
    // (bonusPct, đi qua saturateBonusPct đúng công thức của nó — KHÔNG PHẢI
    // saturateDR ở đây, vốn chỉ dành riêng cho REDUCTION thật của defender).
    reductionPct += (defender.protection ?? 0) * 5;
    reductionPct += (defender.chargeShieldStack ?? 0) * 10;
    // Contempt (xác nhận trực tiếp, ĐÍNH CHÍNH comment cũ SAI — code += 50 vẫn
    // ĐÚNG từ trước): "Contempt là debuff khiến cho kẻ dính phải sẽ bị giảm 50%
    // sát thương gây ra (xem computeAttackerPerkContext) VÀ giảm 50% sát thương
    // PHẢI NHẬN VÀO từ kẻ đã gắn nó" — tức GIẢM dmg nhận (không phải tăng như
    // comment cũ ghi nhầm), CHỈ khi đòn đến từ ĐÚNG "kẻ đã gắn" (so khớp sourceId).
    if (defender.contempt > 0 && defender.contemptSourceId === attackerId) reductionPct += 50;
    // Contempt of the Gaze — SELF-debuff giảm dmg NHẬN (bù lại việc giảm dmg gây
    // ra ở computeAttackerPerkContext).
    if (defender.contemptOfTheGaze) reductionPct += 70;
    return reductionPct;
  }

  function resolveEquipTarget(message, rawInput) {
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const mentionMatch = rawInput.match(/^<@!?(\d+)>\s*/);
    if (isAdmin && mentionMatch) {
      const mentionedUser = message.mentions.users.first();
      return {
        targetUserId: mentionMatch[1],
        targetLabel: mentionedUser ? mentionedUser.username : mentionMatch[1],
        remainingInput: rawInput.slice(mentionMatch[0].length).trim(),
      };
    }
    return { targetUserId: message.author.id, targetLabel: null, remainingInput: rawInput };
  }

  function buildPendingListText(encounter) {
    const pending = encounter.pendingActions ?? [];
    if (pending.length === 0) return "✅ Không có action nào đang chờ.";
    return pending.map((p, i) => {
      const attackerLabel = p.attackerType === "enemy" ? `**${encounter.enemies[p.attackerId]?.name ?? p.attackerId}**` : `<@${p.attackerId}>`;
      const targetLines = p.targets.map(t => {
        const label = t.targetType === "enemy" ? `**${encounter.enemies[t.targetId]?.name ?? t.targetId}**` : `<@${t.targetId}>`;
        return `${label} (${t.preview.totalDmg.toFixed(3)} dmg)`;
      }).join(", ");
      let verifyNote = "";
      if (p.skillKey) verifyNote += ` | 🎲 đã roll skill **${p.skillKey}** (xem embed lúc declare)`;
      if (p.refLink) verifyNote += ` | 🔗 [tham chiếu](${p.refLink})`;
      return `**#${i + 1}** [${p.kind}] ${attackerLabel} → ${targetLines}: \`${p.dmgStr}\`${verifyNote}`;
    }).join("\n");
  }

  function parseBatchEntries(raw, findFn, entityLabel) {
    // Dùng Map để tự động gộp entries cùng tên (VD: "Random Book x2, Random Book x3" → x5)
    const entryMap = new Map();
    const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      const match = part.match(/^(.+?)\s+x(\d+)$/i);
      if (!match) {
        return { error: `❌ Định dạng ${entityLabel} sai: \`${part}\`\nĐúng: \`Tên ${entityLabel === "sách" ? "Sách" : "Item"} x<số>\` (VD: \`${entityLabel === "sách" ? "Random Book x2" : "Chipboard MK1 x3"}\`)` };
      }
      const count = parseInt(match[2], 10);
      if (count <= 0) {
        return { error: `❌ Số lượng ${entityLabel} phải lớn hơn 0: \`${part}\`` };
      }
      const name = findFn(match[1].trim());
      if (!name) return { error: `❌ Tên ${entityLabel} không hợp lệ: \`${match[1].trim()}\`` };
      entryMap.set(name, (entryMap.get(name) ?? 0) + count);
    }
    const entries = Array.from(entryMap.entries()).map(([name, count]) => ({ name, count }));
    return { entries };
  }

  return { computeDefenderDmgReduction, resolveEquipTarget, buildPendingListText, parseBatchEntries };
};
