// singularity.js — Dữ liệu SINGULARITY, slot trang bị RIÊNG BIỆT.
//
// Fragaria chốt trực tiếp: "Borrowed Eyes ... cũng là một item của Eye Gouger drop
// ra, sử dụng slot Singularity (MỖI NGƯỜI CÓ 1 SLOT SINGULARITY TÁCH BIỆT với
// weapon/outfit/accessory)" và "có lẽ nên làm singularity.js và ego.js vì sẽ có
// các Singularity riêng biệt".
//
// KHÁC accessory ở đâu:
//   • Accessory: 3 slot, `data.equippedAccessories` (mảng 3).
//   • Singularity: ĐÚNG 1 slot, `data.equippedSingularity` (chuỗi hoặc null).
// Vì chỉ 1 slot nên KHÔNG cần tham số slot ở lệnh equip — khác hẳn page/accessory.
//
// Mỗi Singularity có thể có:
//   • passives[] — mô tả hiệu ứng bị động
//   • criticalSkillKey — key skill trong skills.js dùng làm Critical của nó
// Đặt Critical trong skills.js (KHÔNG viết roll() ở đây) để mọi cơ chế sẵn có —
// autoBuildDmgStrFromSkillRoll, cdKeyFor, extractNonDmgStrEffects — chạy y hệt
// weapon/accessory, không phải nhân đôi đường xử lý.

const SINGULARITIES = {
  "borrowed eyes": {
    name: "Borrowed Eyes",
    // Drop từ Eye Gouger.
    source: "Eye Gouger",
    passives: [
      {
        name: "Borrowed Eye",
        desc: "Sau khi dùng Critical **Borrowed Eyes**, nhận buff **Borrowed Eye**: tự động nhận số charge né bằng đúng số dice gieo ra. Không né được đòn có [Undodgeable].",
      },
    ],
    criticalSkillKey: "borrowed eyes",
  },
};

/** findSingularity — tra theo key chuẩn hoá hoặc tên hiển thị (case-insensitive).
 *  Bỏ dấu câu ở CẢ HAI PHÍA giống findSkill — đã có bài học: "Wheel's Industry"
 *  từng trả null vì bước strip không bỏ dấu nháy. */
function findSingularity(raw) {
  const key = (raw ?? "").toLowerCase().trim();
  if (SINGULARITIES[key]) return SINGULARITIES[key];
  const norm = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
  const nk = norm(key);
  for (const [k, v] of Object.entries(SINGULARITIES)) {
    if (norm(k) === nk || norm(v.name) === nk) return v;
  }
  return null;
}

module.exports = { SINGULARITIES, findSingularity };
