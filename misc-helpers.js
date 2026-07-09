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
    let reductionPct = 0;
    if (hasPerk(defender, "Smoldering Resolve") && defender.currentHp < defender.maxHp * 0.4) reductionPct += 10;
    if (hasPerk(defender, "No Will To Break") && defender.manifestedEGO) reductionPct += 20;
    // 50-Status Nhóm 1 — Fragile TĂNG dmg nhận (dấu ÂM, ngược Protection/Charge
    // Shield vốn GIẢM dmg nhận). Charge Shield reset về 0 SAU MỖI LẦN áp dụng (xem
    // nơi gọi hàm này lúc confirm — decrement ngay sau khi tính finalDmg).
    reductionPct -= (defender.fragile ?? 0) * 1;
    reductionPct += (defender.protection ?? 0) * 5;
    reductionPct += (defender.chargeShieldStack ?? 0) * 10;
    // Smoke (50-Status Nhóm 2, xác nhận trực tiếp): "+2,5%/stack sát thương từ
    // ĐÁNH THƯỜNG vào bản thân (Max 15)" — CHỈ áp dụng khi đòn này LÀ M1.
    if (isM1) reductionPct -= (defender.smoke ?? 0) * 2.5;
    // Vengeance Mark (xác nhận trực tiếp): "+5%/stack dmg từ skill của The Middle
    // [Max 10]" — CHỈ áp dụng khi skill đang dùng thuộc "The Middle".
    if (isMiddleSkill) reductionPct -= (defender.vengeanceMark ?? 0) * 5;
    // Tremor Decay (xác nhận trực tiếp): "nhận 1 Fragile mỗi 4 Tremor có trên bản
    // thân" — LIÊN TỤC (không chỉ lúc Tremor Burst), dựa trên Tremor HIỆN TẠI —
    // chỉ áp nếu defender CÓ tremorDecay (status này chỉ ảnh hưởng người MANG NÓ).
    if ((defender.tremorDecay ?? 0) > 0) {
      reductionPct -= Math.floor((defender.tremor ?? 0) / 4) * 1;
    }
    // Gaze[Awe]/Contempt (xác nhận trực tiếp): defender NHẬN thêm X% dmg CHỈ khi
    // đòn này đến từ ĐÚNG "kẻ đã gắn" (so khớp sourceId), không áp dụng chung.
    if (defender.gazeAwe > 0 && defender.gazeAweSourceId === attackerId) reductionPct -= defender.gazeAwe * 10;
    if (defender.contempt > 0 && defender.contemptSourceId === attackerId) reductionPct += 50;
    // Contempt of the Gaze — SELF-debuff giảm dmg NHẬN (bù lại việc giảm dmg gây
    // ra ở computeAttackerPerkContext).
    if (defender.contemptOfTheGaze) reductionPct += 70;
    // Hemorrhage (xác nhận trực tiếp): "+10%/20%/30%/40%/50% sát thương phải chịu"
    // theo tier (= số stack) — dùng dấu ÂM (giống Fragile) vì TĂNG dmg nhận.
    if ((defender.hemorrhage ?? 0) > 0) reductionPct -= defender.hemorrhage * 10;
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
