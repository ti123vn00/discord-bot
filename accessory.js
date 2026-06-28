// accessory.js — Dữ liệu Accessory, tách riêng khỏi skills.js theo yêu cầu. Mỗi
// người được mang tối đa 3 Accessory (xem luật "Trang bị" — 1 vũ khí + 1 outfit +
// 3 accessory). Mỗi Accessory có passives (mô tả TỰ DO, GM tự áp dụng — giống cách
// effect named phức tạp được lưu ở skills.js/weapon.js, KHÔNG tự mô phỏng máy trừ
// phần có cấu trúc rõ ràng đủ để roll được, VD special attack như Furioso).
//
// Furioso (Găng Tay Câm Lặng) dùng LẠI đúng D1-D10 (qua weapon.js) + emoji status
// effect ĐÃ CHUẨN HOÁ của skills.js (Tremor/Rupture/Bleed/Fragile/TremorBurst) —
// bộ ID riêng trước đây là DO SAI lúc nhập liệu, đã sửa lại theo đúng nguồn.
const { startEmotionTracking, stopEmotionTracking } = require("./skills");
const { WD1, WD2, WD3, WD4, WD5, WD6, WD7, WD8, WD9, SLASH, PIERCE, BLUNT } = require("./weapon");
const { r } = require("./skills");

// Status effect emoji — dùng ĐÚNG ID đã chuẩn hoá trong skills.js, KHÔNG còn bộ
// riêng cho Weapon/Accessory.
const A_TREMOR = "<:Tremor:1513762737388257380>Tremor";
const A_RUPTURE = "<:Rupture:1513762812722155682>Rupture";
const A_BLEED = "<:Bleed:1513762688226955285>Bleed";
const A_FRAGILE = "<:Fragile:1513763336167100536>Fragile";
const A_TREMORBURST = "<:TremorBurst:1513802464632246352>Tremor Burst";
const A_REALIZATION = "<:Realization:1449582220481134705>Realization";
const A_BLACKSILENCE = "<:BlackSilence:1449581989400281260>Struggling";

const ACCESSORIES = {
  "gang tay cam lang": {
    name: "Găng Tay Câm Lặng",
    passives: [
      { name: "Dimension Pocket", desc: "Cho phép bạn trữ toàn bộ vũ khí của Black Silence bên trong cặp găng [Maximum 9 cái]. Có thể thay đổi vũ khí giữa trận bằng cách tiêu hao 1 Light" },
      { name: "A Prayer For Loving Sorrow", desc: `Mỗi lần đổi vũ khí Black Silence bằng Dimension Pocket và sử dụng Critical của chúng bạn nhận được 1 ${A_REALIZATION} [Mỗi vũ khí chỉ cho 1 ${A_REALIZATION} cho đến khi tổng số stack được reset lại]. Khi trên hoặc bằng 5 ${A_REALIZATION} bạn nhận được một buff **Mặt nạ chống nhận thức** cho phép đòn tấn công của bạn trở thành Unclashable và đòn tấn công cuối cùng của bạn vào mỗi turn sẽ nhận được hiệu ứng [Unevadeable] [Unblockable] [Unparriable]` },
      { name: "Orlando Furioso", desc: `Khi đủ 9 ${A_REALIZATION} lần tiếp theo bạn đổi vũ khí, thay vì đổi bạn sẽ sử dụng Furioso. Xóa toàn bộ stack ${A_REALIZATION} hiện tại trên người và nhận được 1 Stack ${A_BLACKSILENCE} trong 3 Turn. Trong lúc có stack ${A_BLACKSILENCE} bạn sẽ không thể nhận được thêm ${A_REALIZATION} và mọi page bạn xài sẽ được -1 Light Cost [Page có Light Cost là 1 thì vẫn là 1] đồng thời mọi critical của vũ khí của bạn được +4 Dice Up` },
    ],
    // Furioso — "ultimate" 9 hit khi đủ 9 Realization, thay cho 1 lần đổi vũ khí.
    furioso: {
      name: "Furioso",
      diceMul: "2.5x",
      roll() {
        const d = [r(12, 21), r(11, 20), r(16, 25), r(15, 21), r(17, 26), r(14, 23), r(17, 26), r(29, 38), r(17, 26)];
        const tag = "[Undodgeable] [Unblockable] [Unparriable] [Unclashable]";
        return [
          `${WD1} **${d[0]}** [${PIERCE}] ${tag} — Rút ra cặp súng Atelier Logic Pistols bắn kẻ địch`,
          `${WD2} **${d[1]}** [${PIERCE}] ${tag} — Rút ra ngọn giáo Allas Workshop xiên thủng chúng`,
          `${WD3} **${d[2]}** [${BLUNT}] ${tag} — Rút ra búa Old Boys Workshop tán một đòn vào đầu chúng gây 2 ${A_TREMOR}`,
          `${WD4} **${d[3]}** [${SLASH}] ${tag} — Rút ra katana Mook Workshop cắt gọn không gian nơi chúng đứng gây 1 ${A_RUPTURE}`,
          `${WD5} **${d[4]}** [${PIERCE}] ${tag} — Rút ra dao và găng Ranga Workshop thực hiện tổ hợp cấu, đâm và xé chúng gây 3 ${A_BLEED} ở turn sau`,
          `${WD6} **${d[5]}** [50% Dmg Slash/50% Dmg Blunt] ${tag} — Rút ra cặp chùy và rìu Zelkova Workshop vung và nghiền chúng gây 4 ${A_FRAGILE} và ${A_TREMORBURST} 1 lần`,
          `${WD7} **${d[6]}** [${BLUNT}] ${tag} — Rút ra đại kiếm Wheel's Industry rồi thực hiện một đòn bổ dọc chúng ra làm đôi gây 10 ${A_TREMOR}`,
          `${WD8} **${d[7]}** [50% Dmg Slash/50% Dmg Blunt] ${tag} — Rút ra song kiếm Crystal Atelier lướt ngang người chúng chém, rồi lập tức rút ra khẩu shotgun Atelier Logic để bóp cò`,
          `${WD9} **${d[8]}** [${SLASH}] ${tag} — Cuối cùng rút ra thanh Durandal của mình, thực hiện một đòn chém ngang nhằm để cắt đôi chúng ra. Gây 1 ${A_RUPTURE} trước khi gây Dmg`,
        ];
      },
    },
  },
  "perfect cube": {
    name: "Perfect Cube",
    passives: [
      { name: "Perfect Start", desc: "Bạn start encounter với 50% Max Light hiện tại" },
      { name: "Perfect Mind", desc: "Bạn start encounter với +30 Sanity" },
      { name: "Perfect Body", desc: "Mỗi turn end được hồi 10 HP" },
    ],
  },
  "giay wan mk3": {
    name: "Giày Wan MK3",
    passives: [
      { name: "Quickstep", desc: "Mỗi 3 đòn Critical của bạn, đòn critical tiếp theo sẽ reset cd ngay (Phải cùng là 1 đòn)" },
      { name: "Chain-Dashes", desc: "Cứ mỗi hai lần né thì lần né tiếp theo sẽ né được 2 hit" },
      { name: "Resourceful", desc: "Các hành động phòng thủ được refund 1/4 Stamina" },
    ],
  },
  "composition tool": {
    name: "Composition Tool",
    passives: [
      { name: "Reactive", desc: "Cho khả năng kháng Stagger hai lần mỗi encounter" },
      { name: "Shimmering", desc: "Cho 1 <:Light:1513786082502770719>Light khi né hoặc parry thành công" },
      { name: "Energetic", desc: "Gia tăng x2 hiệu quả nhận Emotion Coin" },
    ],
  },
};

/** findAccessory — tra theo key chuẩn hoá hoặc tên hiển thị (case-insensitive). */
function findAccessory(raw) {
  const key = (raw ?? "").toLowerCase().trim();
  if (ACCESSORIES[key]) return ACCESSORIES[key];
  for (const a of Object.values(ACCESSORIES)) {
    if (a.name.toLowerCase() === key) return a;
  }
  return null;
}

/** buildFuriosoResult — roll Furioso (Găng Tay Câm Lặng) — tái dùng side-channel
 *  Emotion Coin tracking giống buildSkillRollResult/buildWeaponCriticalResult. */
function buildFuriosoResult(accessory) {
  if (!accessory.furioso) return { error: `${accessory.name} không có đòn đặc biệt nào để roll.` };
  startEmotionTracking();
  const lines = accessory.furioso.roll();
  const tracked = stopEmotionTracking();
  return {
    embed: {
      title: `✨ ${accessory.name} — ${accessory.furioso.name}`,
      color: 0x8e44ad,
      description: `[Dice Multiplier: ${accessory.furioso.diceMul}]\n\n` + lines.join("\n\n"),
    },
    totalEmotionDelta: tracked.reduce((sum, t) => sum + t.delta, 0),
    firstDiceValue: tracked[0]?.result ?? null,
  };
}

module.exports = { ACCESSORIES, findAccessory, buildFuriosoResult };
