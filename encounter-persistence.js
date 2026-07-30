// encounter-persistence.js
// Lớp Redis persistence của encounter (encounterKey, getEncounter, saveEncounter,
// deleteEncounter) — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp tục tách
// đi". Dùng RẤT RỘNG khắp file (73 lần) nhưng chỉ cần sửa 1 nơi định nghĩa (mọi
// nơi gọi không cần đổi gì). Đã có 1 file khác (encounter-actions.js) inject
// sẵn 3 trong 4 hàm này — vị trí require nằm SAU dòng này trong index.js nên an
// toàn (không TDZ).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ redis, withTimeout, log }) {

  function encounterKey(channelId) {
    return `encounter:${channelId}`;
  }
  
  async function getEncounter(channelId) {
    const raw = await withTimeout(redis.get(encounterKey(channelId)));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  
  async function saveEncounter(channelId, data) {
    await withTimeout(redis.set(encounterKey(channelId), JSON.stringify(data)));
  }
  
  // deleteEncounter — GAP THẬT phát hiện qua bug report trực tiếp (Fragaria báo
  // contract thắng xong nhưng encounter bị "treo", không tự xoá, kẹt không tạo
  // contract mới được) — TRƯỚC ĐÂY mọi lời gọi đều bọc `.catch(() => {})` im
  // lặng hoàn toàn, nếu redis.del thất bại (mạng chập chờn, timeout thật trên
  // Upstash REST API — KHÔNG tái hiện được ở mock local vì mock không bao giờ
  // lỗi) thì KHÔNG CÓ DẤU VẾT gì để biết chuyện gì xảy ra, và encounter tồn tại
  // mãi. Giờ RETRY tối đa 3 lần (backoff nhẹ) + LOG rõ ràng nếu vẫn thất bại sau
  // cùng — không chặn luồng chính (vẫn throw ở lần cuối để caller.catch() xử lý
  // như cũ, nhưng giờ CÓ log để biết mà điều tra/dùng lệnh khôi phục thủ công —
  // xem -encounter forceend, message-create-handler.js).
  async function deleteEncounter(channelId) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await withTimeout(redis.del(encounterKey(channelId)));
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await new Promise(r => setTimeout(r, 200 * attempt));
      }
    }
    log("error", "deleteEncounter", "system", `Xoá encounter channel ${channelId} THẤT BẠI sau 3 lần thử: ${lastErr?.message}. Dùng \`-encounter forceend\` (admin/GM) để xoá thủ công nếu bị kẹt.`);
    throw lastErr;
  }

  return { encounterKey, getEncounter, saveEncounter, deleteEncounter };
};
