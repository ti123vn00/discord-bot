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
  "blade lineage mentor": {
    name: "Blade Lineage Mentor",
    resistance: { B: 1.3, P: 1.3, S: 1 },
    speedRange: { min: 3, max: 6 },
    keypage: [
      "Mỗi khi sử dụng page của Blade Lineage Syndicate bạn nhận được Rending cho đến hết turn. Giúp gia tăng 30% Dmg Slash và tăng 3 <:DiceUp:1513767795681398894>Dice Up cho mọi Dice là Slash",
      "Khi trên hoặc bằng 10 <:Poise:1513762945715142736>Poise, To Claim Their Bones của bạn sẽ trở thành Undodgeable và nhận 5 <:DiceUp:1513767795681398894>Dice Up",
    ],
  },
  "thumb capo iiii": {
    name: "Thumb Capo IIII",
    resistance: { B: 1.5, P: 1.1, S: 1 },
    speedRange: { min: 2, max: 5 },
    keypage: [
      "Các vũ khí/skill/page sử dụng đạn sẽ được tăng thêm 20% Dmg gây ra",
      "Khi sử dụng Tiantui Star's Blade [天退星刀]: Khi gây <:Tremor:1513762737388257380>Tremor bạn sẽ áp thêm <:Burn:1513762753691652177>Burn bằng một nửa count của <:Tremor:1513762737388257380>Tremor và ngược lại",
    ],
  },
  "abydos's uniform - lazy style": {
    name: "Abydos's Uniform - Lazy Style",
    resistance: { B: 1.1, P: 1.5, S: 1.3 },
    speedRange: { min: 2, max: 5 },
    keypage: [
      // "Iron Horus" — thay đổi cơ chế Guard CƠ BẢN (40 Sta thay vì 10, giảm TOÀN
      // BỘ sát thương thay vì 90%/99%) — KHÔNG tự động hoá trong -encounter guard
      // (hệ thống hiện dùng cứng 10 Sta/90% giảm cho mọi player, không có field
      // "override Guard cost/hiệu quả theo outfit") — GM/player tự áp dụng bằng
      // tay khi Guard trong lúc mặc outfit này.
      "Iron Horus: Block tốn 40 stamina nhưng giảm sát thương TOÀN BỘ đòn (KHÔNG tự động hoá — GM/player tự áp khi Guard).",
    ],
  },
};

/** findOutfit — tra theo key chuẩn hoá hoặc tên hiển thị (case-insensitive). */
function findOutfit(raw) {
  const key = (raw ?? "").toLowerCase().trim().replace(/^["']+|["']+$/g, "").trim();
  if (OUTFITS[key]) return OUTFITS[key];
  for (const o of Object.values(OUTFITS)) {
    if (o.name.toLowerCase() === key) return o;
  }
  return null;
}

module.exports = { OUTFITS, findOutfit };
