// encounter-board.js
// Hàm build embed "-encounter status" (board tổng — turn order + tất cả
// combatant + pending count) — tách khỏi index.js theo yêu cầu trực tiếp:
// "tách tiếp đi, một mạch luôn". Chỉ cần buildTurnOrderText (combat-utils.js) +
// formatCombatantBlock (encounter-display.js), cả 2 đã định nghĩa TRƯỚC vị trí
// gốc trong index.js — không có rủi ro TDZ.
//
// "phân trang" — GAP ĐÃ SỬA (xác nhận trực tiếp): "encounter quá nhiều thì sẽ
// cần phải phân luồng" → sau đó đổi ý thành "làm 1 nút để sang trang" — thay
// vì cắt bỏ/ẩn combatant khi board quá dài (bug cũ) hay dồn nhiều embed cùng
// lúc (thiết kế "phân luồng" ban đầu), giờ CHIA thành nhiều TRANG, chỉ hiện 1
// trang tại 1 thời điểm, kèm nút "◀ Trang trước / Trang sau ▶" để lật qua lại
// — gọn gàng hơn nhiều so với dồn embed.

module.exports = function ({ ActionRowBuilder, ButtonBuilder, ButtonStyle, buildTurnOrderText, formatCombatantBlock }) {

  const MAX_DESC_PER_PAGE = 3900; // chừa đệm an toàn dưới giới hạn 4096 ký tự/embed description của Discord

  // buildEncounterBoardPages — trả về MẢNG các trang { title, description, color },
  // KHÔNG ẩn/cắt bỏ combatant nào (khác bug cũ) — chỉ tự động tách sang trang
  // tiếp theo khi trang hiện tại gần đầy.
  function buildEncounterBoardPages(encounter) {
    const blocks = [];
    if ((encounter.turnOrder ?? []).length > 0) {
      blocks.push(`🎲 **Thứ tự Turn**\n${buildTurnOrderText(encounter)}`);
    }
    // Task yêu cầu trực tiếp: "kẻ địch bị đánh bại hp về 0 thì nên ẩn ra khỏi
    // encounter status để nhìn cho gọn" — CHỈ ẩn enemy ĐÃ CHẾT (currentHp<=0),
    // KHÔNG liên quan gì tới quyết định "không cắt bớt khi board dài" ở trên
    // (đó là về ĐỘ DÀI, đây là về TRẠNG THÁI đã-chết cụ thể) — nếu TẤT CẢ đều
    // đã chết thì hiện 1 dòng tóm tắt thay vì bỏ trống hẳn phần enemy.
    const aliveEnemyKeys = Object.keys(encounter.enemies).filter(ekey => encounter.enemies[ekey].currentHp > 0);
    if (aliveEnemyKeys.length > 0) {
      for (const ekey of aliveEnemyKeys) {
        blocks.push(formatCombatantBlock(encounter.enemies[ekey], `⚔️ ${encounter.enemies[ekey].name} (${ekey})`));
      }
    } else if (Object.keys(encounter.enemies).length > 0) {
      blocks.push(`☠️ *(Tất cả enemy đã bị đánh bại)*`);
    }
    for (const pid of Object.keys(encounter.players)) {
      blocks.push(formatCombatantBlock(encounter.players[pid], `<@${pid}>`));
    }
    const allDead = Object.keys(encounter.enemies).length > 0 && Object.values(encounter.enemies).every(e => e.currentHp <= 0);
    const color = allDead ? 0x555555 : 0xe74c3c;
    const pageDescs = [];
    let current = "";
    for (const rawBlock of blocks) {
      // BUG ĐÃ SỬA (Fragaria: "encounter nhiều người quá không load hết nổi") —
      // TRƯỚC ĐÂY 1 block ĐƠN LẺ dài hơn MAX_DESC_PER_PAGE vẫn được đẩy nguyên
      // vào trang (nhánh `else` khi `current` rỗng), làm description vượt giới
      // hạn 4096 ký tự của Discord → API TỪ CHỐI cả embed → `.catch(() => {})`
      // nuốt lỗi → board KHÔNG hiện gì cả, im lặng. Encounter đông người + nhiều
      // status/buff trên mỗi combatant là chạm ngưỡng rất dễ.
      // Cắt an toàn ở ranh giới dòng để không xé giữa chừng cú pháp markdown.
      let block = rawBlock;
      if (block.length > MAX_DESC_PER_PAGE) {
        const keep = [];
        let used = 0;
        for (const line of block.split("\n")) {
          if (used + line.length + 1 > MAX_DESC_PER_PAGE - 60) break;
          keep.push(line); used += line.length + 1;
        }
        block = keep.join("\n") + "\n*… (rút gọn — quá dài để hiện hết)*";
      }
      const candidate = current ? current + "\n\n" + block : block;
      if (candidate.length > MAX_DESC_PER_PAGE && current) {
        pageDescs.push(current);
        current = block;
      } else {
        current = candidate;
      }
    }
    pageDescs.push(current || "*(chưa có enemy/player nào)*");
    return pageDescs.map((desc, i) => ({
      title: pageDescs.length > 1 ? `Encounter: ${encounter.name} (Trang ${i + 1}/${pageDescs.length})` : `Encounter: ${encounter.name}`,
      description: desc,
      color,
    }));
  }

  // buildBoardPaginationRow — nút "◀ Trang trước / Trang sau ▶", CHỈ hiện nếu
  // có hơn 1 trang. customId lưu channelId + page hiện tại để handler tự tính
  // lại prev/next (KHÔNG lưu snapshot cũ — luôn đọc encounter MỚI NHẤT lúc bấm).
  function buildBoardPaginationRow(channelId, page, totalPages) {
    if (totalPages <= 1) return null;
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`encboardpage:${channelId}:${page - 1}`).setLabel("◀ Trang trước").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`encboardpage:${channelId}:${page + 1}`).setLabel("Trang sau ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    );
  }

  // buildEncounterBoardEmbed — GIỮ TÊN CŨ (đổi kiểu trả về: giờ trả về payload
  // {embed, components} thay vì 1 embed thuần — MỌI call site cần cập nhật
  // cách dùng tương ứng) — luôn build TRANG ĐẦU (page=0) làm mặc định.
  function buildEncounterBoardEmbed(encounter, channelId = null, page = 0) {
    const pages = buildEncounterBoardPages(encounter);
    const clampedPage = Math.max(0, Math.min(page, pages.length - 1));
    const row = channelId ? buildBoardPaginationRow(channelId, clampedPage, pages.length) : null;
    return { embed: pages[clampedPage], components: row ? [row] : [] };
  }

  return { buildEncounterBoardEmbed, buildEncounterBoardPages, buildBoardPaginationRow };
};
