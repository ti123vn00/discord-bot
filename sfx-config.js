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

module.exports = { SFX_MAP, findSfx };
