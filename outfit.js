// outfit.js — Dữ liệu Outfit (giáp), tách riêng khỏi skills.js theo yêu cầu.
// Mỗi Outfit có: resistance ({B,P,S} — map trực tiếp vào res: của -encounter join,
// xem index.js), speedRange ({min,max} — map vào speedrange:, NẾU outfit có ghi rõ
// — không phải outfit nào cũng có info Speed, để null nếu thiếu thay vì tự bịa số),
// và keypage (mô tả hiệu ứng TỰ DO, giống cách Page/passive khác được lưu — KHÔNG
// tự mô phỏng máy trừ khi sau này được yêu cầu code cụ thể).
const OUTFITS = {
  "black suit": {
    name: "Black Suit",
    resistance: { B: 1, P: 1.3, S: 1.3 },
    speedRange: null, // chưa có thông tin Speed cho outfit này
    keypage: [
      "Mỗi khi đạt Emotion Level nhận được 1 <:DiceUp:1513767795681398894>Dice Up, 1 Clash Power và 1 Protection kéo dài cho đến hết encounter",
      "Refund 1/5 Stamina khi đánh thường",
    ],
  },
};

/** findOutfit — tra theo key chuẩn hoá hoặc tên hiển thị (case-insensitive). */
function findOutfit(raw) {
  const key = (raw ?? "").toLowerCase().trim();
  if (OUTFITS[key]) return OUTFITS[key];
  for (const o of Object.values(OUTFITS)) {
    if (o.name.toLowerCase() === key) return o;
  }
  return null;
}

module.exports = { OUTFITS, findOutfit };
