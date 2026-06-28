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
};

/** findWeapon — tra theo key chuẩn hoá hoặc tên hiển thị (case-insensitive), giống
 *  pattern findSkill ở skills.js. */
function findWeapon(raw) {
  const key = (raw ?? "").toLowerCase().trim();
  if (WEAPONS[key]) return WEAPONS[key];
  for (const w of Object.values(WEAPONS)) {
    if (w.name.toLowerCase() === key) return w;
  }
  return null;
}

module.exports = { WEAPONS, findWeapon, WD1, WD2, WD3, WD4, WD5, WD6, WD7, WD8, WD9, SLASH, PIERCE, BLUNT, DICEUP, BLEED, POISE };
