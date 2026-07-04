// parse-batch.js
// Hàm parseBatchEntries (parse chuỗi "Tên x<số>, Tên x<số>" cho -give/-remove/
// -setplayer nhiều item cùng lúc) — tách khỏi index.js theo yêu cầu trực tiếp:
// "tiếp tục tách đi". HOÀN TOÀN THUẦN, 0 dependency ngoài (findFn là tham số của
// chính hàm) — export TRỰC TIẾP.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

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

module.exports = { parseBatchEntries };
