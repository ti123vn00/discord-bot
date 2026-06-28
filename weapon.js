// weapon.js — Dữ liệu Vũ khí (Weapon), tách riêng khỏi skills.js theo yêu cầu.
// Mỗi Vũ khí có: weight (Light/Medium/Heavy — quyết định Stamina cost M1, số hit
// Guard/Evade/Parry chặn được — xem WEAPON_STAMINA_COST/WEAPON_DEFENSE_HITS ở
// index.js), type (damage type M1 mặc định), baseDamage (dmg gốc M1 nếu không có
// gì khác ghi đè), passives (mô tả TỰ DO — KHÔNG tự mô phỏng máy, GM tự áp dụng,
// giống cách skills.js xử lý hiệu ứng named phức tạp), và critical (đòn Critical
// riêng của vũ khí — có CD + roll() giống 1 skill, dùng findWeapon() để tra).
//
// Dice1-10 dùng LẠI ĐÚNG bộ D1-D10 của skills.js (Page) — KHÔNG có bộ riêng cho
// Weapon/Accessory (ID khác trước đây là DO SAI, đã sửa lại theo đúng nguồn).
const { r, startEmotionTracking, stopEmotionTracking, D1, D2, D3, D4, D5, D6, D7, D8, D9 } = require("./skills");

const WD1 = D1, WD2 = D2, WD3 = D3, WD4 = D4, WD5 = D5, WD6 = D6, WD7 = D7, WD8 = D8, WD9 = D9;

// Type tag emoji — dùng chung ID đã chuẩn hoá với skills.js (Slash/Pierce/Blunt là
// khái niệm chung toàn bộ hệ thống, không có lý do tách riêng bộ khác).
const SLASH = "<:Slash:1513768633434640517>Slash";
const PIERCE = "<:Pierce:1513768511179329556>Pierce";
const BLUNT = "<:Blunt:1513768529718022254>Blunt";
const DICEUP = "<:DiceUp:1513767795681398894>Dice Up";

const WEAPONS = {
  "durandal": {
    name: "Durandal",
    weight: "medium",
    type: "Slash",
    baseDamage: 14,
    passives: [
      { name: "Orlando Furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua" },
    ],
    critical: {
      name: "Durandal",
      cd: "2 Turn",
      roll() {
        const d1 = r(4, 7), d2 = r(5, 8), d3 = r(6, 9);
        return [
          `${WD1} **${d1}** [Unblockable] [${SLASH}] — Chém kẻ địch một nhát`,
          `${WD2} **${d2}** [${SLASH}] — Theo sau một nhát nữa`,
          `${WD3} **${d3}** [Guard Break] [${SLASH}] — Cuối cùng trảm xuống một đường, nhận 3 ${DICEUP} cho đến hết turn này`,
        ];
      },
    },
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

/**
 * buildWeaponCriticalResult — roll Critical của 1 vũ khí, tái dùng side-channel
 * Emotion Coin tracking giống buildSkillRollResult ở index.js (Roll Max/Min Dice
 * trong Critical CŨNG tính Emotion Coin, vì về bản chất vẫn là 1 lần roll dice).
 */
function buildWeaponCriticalResult(weapon) {
  if (!weapon.critical) return { error: `${weapon.name} không có Critical riêng.` };
  startEmotionTracking();
  const lines = weapon.critical.roll();
  const tracked = stopEmotionTracking();
  return {
    embed: {
      title: `⚔️ ${weapon.name} — Critical`,
      color: 0xc0392b,
      description: `[CD: ${weapon.critical.cd}]\n\n` + lines.join("\n"),
    },
    totalEmotionDelta: tracked.reduce((sum, t) => sum + t.delta, 0),
    firstDiceValue: tracked[0]?.result ?? null,
  };
}

module.exports = { WEAPONS, findWeapon, buildWeaponCriticalResult, WD1, WD2, WD3, WD4, WD5, WD6, WD7, WD8, WD9, SLASH, PIERCE, BLUNT, DICEUP };
