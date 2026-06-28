// accessory.js — Dữ liệu Accessory, tách riêng khỏi skills.js theo yêu cầu. Mỗi
// người được mang tối đa 3 Accessory (xem luật "Trang bị" — 1 vũ khí + 1 outfit +
// 3 accessory). Mỗi Accessory có passives (mô tả TỰ DO, GM tự áp dụng).
//
// QUAN TRỌNG (phát hiện sau khi đối chiếu): "Furioso" (đòn ultimate 9-dice của Găng
// Tay Câm Lặng) ĐÃ CÓ SẴN trong skills.js (key "furioso") với ĐÚNG 9 dice/effect —
// KHÔNG lặp lại roll() ở đây nữa, chỉ giữ criticalSkillKey để biết roll qua đâu.
// 3 passive (Dimension Pocket/A Prayer For Loving Sorrow/Orlando Furioso) KHÔNG bị
// trùng ở đâu khác — vẫn giữ nguyên mô tả đầy đủ ở đây.
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
    // Furioso ĐÃ CÓ trong skills.js (key "furioso") — roll qua `-skill furioso`.
    criticalSkillKey: "furioso",
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

module.exports = { ACCESSORIES, findAccessory };
