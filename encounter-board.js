// encounter-board.js
// Hàm build embed "-encounter status" (board tổng — turn order + tất cả
// combatant + pending count) — tách khỏi index.js theo yêu cầu trực tiếp:
// "tách tiếp đi, một mạch luôn". Chỉ cần buildTurnOrderText (combat-utils.js) +
// formatCombatantBlock (encounter-display.js), cả 2 đã định nghĩa TRƯỚC vị trí
// gốc trong index.js — không có rủi ro TDZ.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ buildTurnOrderText, formatCombatantBlock }) {

  function buildEncounterBoardEmbed(encounter) {
    const blocks = [];
    if ((encounter.turnOrder ?? []).length > 0) {
      blocks.push(`🎲 **Thứ tự Turn**\n${buildTurnOrderText(encounter)}`);
    }
    for (const ekey of Object.keys(encounter.enemies)) {
      blocks.push(formatCombatantBlock(encounter.enemies[ekey], `⚔️ ${encounter.enemies[ekey].name} (${ekey})`));
    }
    for (const pid of Object.keys(encounter.players)) {
      blocks.push(formatCombatantBlock(encounter.players[pid], `<@${pid}>`));
    }
    // GAP ĐÃ SỬA (xác nhận trực tiếp phản hồi tester: "bảng status có quá
    // nhiều chữ không cần thiết (kể cả disclaimer)... cái encounter pending
    // khá không cần thiết cũng hiện liên tục") — xoá dòng "N action đang chờ"
    // (GM có thể tự gõ `-encounter pending` khi cần) và footer disclaimer.
    const allDead = Object.keys(encounter.enemies).length > 0 && Object.values(encounter.enemies).every(e => e.currentHp <= 0);
    // BUG ĐÃ SỬA: trước đây join() KHÔNG giới hạn độ dài — trận nhiều enemy/player
    // (VD 2v2 trở lên, hoặc nhiều enemy cùng lúc) có thể VƯỢT 4096 ký tự giới hạn
    // embed description của Discord, khiến request bị Discord TỪ CHỐI hoàn toàn (lỗi
    // im lặng, GM không thấy board nào cả). Giờ GHÉP TỪNG BLOCK tới khi gần chạm giới
    // hạn (3900, chừa đệm an toàn cho title/footer), rồi dừng + ghi rõ còn bao nhiêu
    // combatant chưa hiện — KHÔNG để Discord tự xử lý/từ chối.
    let description = "";
    let omittedCount = 0;
    for (let i = 0; i < blocks.length; i++) {
      const candidate = description ? description + "\n\n" + blocks[i] : blocks[i];
      if (candidate.length > 3900) { omittedCount = blocks.length - i; break; }
      description = candidate;
    }
    if (omittedCount > 0) {
      description += `\n\n*(... còn ${omittedCount} mục nữa, board quá dài để hiện hết — dùng \`-encounter status\` để GM/player tự xem riêng từng người)*`;
    }
    return {
      title: `Encounter: ${encounter.name}`,
      description: description || "*(chưa có enemy/player nào)*",
      color: allDead ? 0x555555 : 0xe74c3c,
    };
  }

  return { buildEncounterBoardEmbed };
};
