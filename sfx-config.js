// sfx-config.js — Data tĩnh map skill (key thường, VD "durandal") -> tên file SFX
// (VD "durandal_ultimate.mp3"). CHỈ ghi tên file, KHÔNG ghi full path — code tự
// ghép với thư mục cố định /assets/audio/sfx/ khi gửi (xem findSfxFilePath ở
// message-create-handler.js). File audio THẬT (.mp3/.ogg) do Fragaria tự cung
// cấp và đặt đúng tên vào thư mục /assets/audio/sfx/ trong repo thật — code ở
// đây CHỈ định nghĩa map, không tạo ra nội dung audio.
//
// Theo yêu cầu trực tiếp: "chỉ 1 số skill kiểu như ultimate" — KHÔNG BẮT BUỘC
// mọi skill phải có SFX, chỉ những skill được liệt kê dưới đây mới tự động
// đính kèm file khi dùng. Thêm/sửa/xoá bằng cách sửa trực tiếp SFX_MAP này
// (giống quy ước data tĩnh của weapon.js/outfit.js/accessory.js).

const SFX_MAP = {
  // "durandal": "durandal_ultimate.mp3", // VÍ DỤ — bỏ comment + đổi tên file khi có file thật.
};

/** findSfx — tra SFX theo skill key (case-insensitive, chuẩn hoá giống findSkill).
 *  Trả về tên file (string) hoặc null nếu skill này không có SFX riêng. */
function findSfx(skillKeyRaw) {
  const key = (skillKeyRaw ?? "").toLowerCase().trim();
  return SFX_MAP[key] ?? null;
}

/** pickRandomBgm — chọn ngẫu nhiên 1 trong 9 file BGM cố định (BGM1.mp3 —
 *  BGM9.mp3, đặt trong /assets/audio/bgm/ trong repo thật, xem quy ước cùng
 *  SFX_MAP ở trên). Gọi 1 LẦN DUY NHẤT lúc encounter START (KHÔNG gọi lại mỗi
 *  lần xem status — theo yêu cầu trực tiếp: "chạy bgm... cho đến hết encounter"
 *  nghĩa là 1 bài CỐ ĐỊNH suốt cả trận, không đổi bài giữa chừng) — kết quả
 *  lưu vào encounter.currentBgm, dùng lại field đó mỗi lần hiện status. */
function pickRandomBgm() {
  const n = 1 + Math.floor(Math.random() * 9);
  return `BGM${n}.mp3`;
}

module.exports = { SFX_MAP, findSfx, pickRandomBgm };
