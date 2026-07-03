// pending-list.js
// Hàm build text danh sách pending action cho "-encounter pending" — tách khỏi
// index.js theo yêu cầu trực tiếp: "tách tiếp đi, một mạch luôn". HOÀN TOÀN THUẦN
// (chỉ đọc trực tiếp encounter object), 0 dependency ngoài — export TRỰC TIẾP,
// không cần factory pattern.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

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

module.exports = { buildPendingListText };
