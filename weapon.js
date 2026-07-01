// weapon.js — Dữ liệu Vũ khí (Weapon), tách riêng khỏi skills.js theo yêu cầu.
//
// QUAN TRỌNG (phát hiện sau khi đối chiếu): skills.js ĐÃ CÓ sẵn 1 hệ thống vũ khí
// rất lớn (tags: "Weapon" cho entry định nghĩa vũ khí, weaponOf: "<tên vũ khí>" cho
// Critical riêng của nó — VD "durandal"/"sharp cuts"/"tiantui star's blade"...).
// Để KHÔNG trùng lặp, file này CHỈ chứa:
//   1. Vũ khí HOÀN TOÀN không có trong skills.js (chưa có cái nào tới giờ — mọi
//      vũ khí được đưa qua đều hoá ra đã có sẵn, chỉ thiếu metadata).
//   2. Metadata (weight/type/baseDamage/passives) cho vũ khí ĐÃ CÓ Critical trong
//      skills.js nhưng skills.js KHÔNG lưu weight/baseDamage (chỉ lưu được qua
//      weaponType/weaponDmg trên entry tags:"Weapon", không phải mọi vũ khí có) —
//      Critical THẬT vẫn roll qua `-skill <criticalSkillKey>`, KHÔNG roll qua đây.
//
// LƯU Ý ĐẶC BIỆT: "Blade Lineage Hwando" có 2 VŨ KHÍ KHÁC NHAU dùng CHUNG 1 TÊN
// trong skills.js — 1 cái có entry tags:"Weapon" riêng (passive "Poised", Critical
// Striker's Stance/Heel Turn/Flank Thrust), 1 cái CHỈ có Critical "Sharp Cuts"
// (weaponOf: "Blade Lineage Hwando") mà KHÔNG có entry weapon riêng nào — đây CHÍNH
// LÀ cái được lưu metadata ở weapon.js dưới đây (không gây trùng vì khác hẳn nhau).
const { r, startEmotionTracking, stopEmotionTracking, D1, D2, D3, D4, D5, D6, D7, D8, D9 } = require("./skills");

const WD1 = D1, WD2 = D2, WD3 = D3, WD4 = D4, WD5 = D5, WD6 = D6, WD7 = D7, WD8 = D8, WD9 = D9;

const SLASH = "<:Slash:1513768633434640517>Slash";
const PIERCE = "<:Pierce:1513768511179329556>Pierce";
const BLUNT = "<:Blunt:1513768529718022254>Blunt";
const DICEUP = "<:DiceUp:1513767795681398894>Dice Up";
const BLEED = "<:Bleed:1513762688226955285>Bleed";
const POISE = "<:Poise:1513762945715142736>Poise";

const WEAPONS = {
  "durandal": {
    name: "Durandal",
    weight: "medium",
    type: "Slash",
    baseDamage: 14,
    passives: [
      { name: "Orlando Furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua" },
    ],
    // Critical "Durandal" ĐÃ CÓ trong skills.js (key "durandal", weaponOf:
    // "Durandal") — roll qua `-skill durandal`, KHÔNG lặp lại roll() ở đây.
    criticalSkillKey: "durandal",
  },
  "blade lineage hwando": {
    name: "Blade Lineage Hwando",
    weight: "medium",
    type: "Slash",
    baseDamage: 13,
    passives: [
      { name: "Blade", desc: "3 đòn đánh thường (M1) sẽ nhận 1 Poise" },
    ],
    // Critical "Sharp Cuts" ĐÃ CÓ trong skills.js (key "sharp cuts", weaponOf:
    // "Blade Lineage Hwando") — roll qua `-skill sharp cuts`. LƯU Ý: skills.js CŨNG
    // có 1 entry KHÁC tên "blade lineage hwando" (passive "Poised") — đó là vũ khí
    // KHÁC trùng tên, không phải cái này.
    criticalSkillKey: "sharp cuts",
  },
  "patron librarian baton": {
    name: "Patron Librarian Baton",
    weight: "light",
    type: "Blunt",
    baseDamage: 6,
    passives: [],
    // KHÔNG có Critical nào trong skills.js cho vũ khí này (đã rà soát kỹ — chỉ có
    // 9 Page riêng: Alleyway Counter/Thrust/Onslaught Command/Charge and Cover/
    // Focused Strikes/Light Dash/Dodge and Strike/You're too slow/Light attack,
    // không có entry weaponOf:"Patron Librarian Baton" nào) — để trống
    // criticalSkillKey, không bịa ra Critical không tồn tại.
  },
  "brawler": {
    name: "Brawler",
    weight: "light",
    type: "Blunt",
    baseDamage: 5,
    passives: [],
    // Critical "Grappling" ĐÃ CÓ trong skills.js (key "grappling", weaponOf:
    // "Brawler") — roll qua `-skill grappling`. Có passive [Hakuda] gắn liền trong
    // chính text roll của Grappling ("Nếu xài Critical sau khi xài skill có tag
    // Airborne: dice đổi thành [14~30]") — KHÔNG tự động hoá được (phụ thuộc việc
    // "vừa mới xài skill có tag Airborne" trước đó trong cùng turn, hệ thống hiện
    // tại không track tag "Airborne" của lần roll skill gần nhất) — GM tự áp dụng.
    criticalSkillKey: "grappling",
  },
  "eyes of horus": {
    name: "Eyes Of Horus",
    weight: "heavy",
    type: "Pierce",
    // "3x9" theo mô tả gốc: 1 LẦN BẮN (1 lượt M1) tự động ra 9 hit, mỗi hit 3 dmg
    // (tổng 27 dmg raw/lượt bắn) — baseDamage lưu ở đây là dmg MỖI HIT (3), người
    // dùng nút "Đánh mấy lần" trong encounter nên nhập THEO BỘI SỐ CỦA 9 (VD "9"
    // cho 1 lần bắn trọn vẹn = 27 dmg, "18" cho 2 lần bắn = 54 dmg) — hệ thống
    // KHÔNG tự ép bội số 9, GM/player tự áp đúng quy ước vũ khí này khi nhập.
    baseDamage: 3,
    passives: [
      {
        name: "Foreclosure Task Force President",
        desc:
          "Trong 1 turn khi tấn công 1 đối tượng, nếu đánh thường: 1 lần → bắn thêm 1 Repeat Ammo, gây sát thương chuẩn. " +
          "Dưới hoặc bằng 3 lần → +50% sát thương. Dưới hoặc bằng 6 lần → Base dmg nâng lên 4x9. " +
          "Mỗi lần đánh thường: gắn 2 Tremor + 2 Charge lên bản thân. " +
          "[KHÔNG TỰ ĐỘNG HOÁ — leo thang theo SỐ LẦN đánh thường TRONG 1 TURN lên CÙNG 1 đối tượng, hệ thống hiện không track " +
          "counter dạng này; GM/player tự cộng % dmg + đổi base dmg + gắn Tremor/Charge bằng tay theo đúng mốc.]",
      },
      {
        name: "Ammo: 8",
        desc:
          "[KHÔNG TỰ ĐỘNG HOÁ — không có hệ thống \"đạn\"/reload trong bot, tương tự Light/Stamina/Sanity/Charge. " +
          "GM/player tự đếm 8 lượt bắn rồi tự narrate hết đạn/reload theo ý đồ riêng của bàn chơi.]",
      },
    ],
    // Critical "Tactical Suppression" — có trong skills.js (key "tactical
    // suppression", weaponOf: "Eyes Of Horus") — LƯU Ý: bản chất là kích hoạt
    // trạng thái Shield 2-turn phức tạp, KHÔNG phải 1 lần roll dmg đơn thuần — xem
    // đầy đủ comment ở entry skills.js tương ứng.
    criticalSkillKey: "tactical suppression",
  },
};

/** findWeapon — tra theo key chuẩn hoá hoặc tên hiển thị (case-insensitive), giống
 *  pattern findSkill ở skills.js. */
function findWeapon(raw) {
  // Strip dấu " thừa ở đầu/cuối (item name đôi khi lưu KÈM dấu ngoặc kép do copy từ
  // text có định dạng markdown, VD từ inventory) — để cả 2 cách gõ (có/không ngoặc)
  // đều match đúng.
  const key = (raw ?? "").toLowerCase().trim().replace(/^["']+|["']+$/g, "").trim();
  if (WEAPONS[key]) return WEAPONS[key];
  for (const w of Object.values(WEAPONS)) {
    if (w.name.toLowerCase() === key) return w;
  }
  return null;
}

module.exports = { WEAPONS, findWeapon, WD1, WD2, WD3, WD4, WD5, WD6, WD7, WD8, WD9, SLASH, PIERCE, BLUNT, DICEUP, BLEED, POISE };
