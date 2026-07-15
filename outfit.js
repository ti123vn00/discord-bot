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
  "casual outfit": {
    name: "Casual Outfit",
    resistance: { B: 1.3, P: 1.3, S: 1.3 },
    speedRange: { min: 3, max: 6 },
    keypage: ["Gia tăng 20% EXP và Ahn khi win combat"],
  },
  "rats outfit": {
    name: "Rats Outfit",
    resistance: { B: 1.3, P: 1.3, S: 1.3 },
    speedRange: { min: 3, max: 6 },
    keypage: ["Gia tăng 50% EXP khi win combat nhưng bù lại giảm 50% Ahn khi win combat"],
  },
  "businessman": {
    name: "Businessman",
    resistance: { B: 1.3, P: 1.3, S: 1.3 },
    speedRange: { min: 3, max: 6 },
    keypage: ["Gia tăng 50% Ahn Gain nhưng bù lại bị giảm 50% EXP Gain"],
  },
  "ambitious fixer": {
    name: "Ambitious Fixer",
    resistance: { B: 1, P: 1.3, S: 1.6 },
    speedRange: { min: 5, max: 6 },
    keypage: [
      "Gia tăng 10% Dmg Slash",
      "Khi vào Encounter bạn nhận được 3 Haste",
    ],
  },
  "zwei association": {
    name: "Zwei Association",
    resistance: { B: 1.5, P: 1, S: 1.1 },
    speedRange: { min: 3, max: 4 },
    keypage: [
      "Mỗi lần đỡ thành công bạn sẽ bị nhận 1 Tremor. Critical của vũ khí bạn sẽ áp Tremor lên kẻ địch tương đương với 1/2 Tremor trên người bạn hiện tại",
      "Nếu bạn có trên hoặc bằng 10 Defense Up và khi đỡ đòn Guard Break, bạn sẽ tiêu thụ hết chúng và sẽ không bị Guard Break; có thể đỡ đòn Undodgeable bằng cách tương tự",
    ],
  },
  "hana association": {
    name: "Hana Association",
    resistance: { B: 1.3, P: 1.2, S: 1.3 },
    speedRange: { min: 4, max: 7 },
    keypage: ["Bạn nhận được 1 Dice Up cho đến hết turn với mỗi 10 HP bạn mất trong turn"],
  },
  "kurokumo wakashu": {
    name: "Kurokumo Wakashu",
    resistance: { B: 1.3, P: 1.1, S: 1.5 },
    speedRange: { min: 3, max: 6 },
    keypage: [
      "Bạn nhận 1% Dmg Up với mỗi 1 Bleed có trên người địch",
      "Sau khi sử dụng page của Kurokumo Syndicate bạn nhận được 2 Dark Cloud. Mỗi turn trừ 2 Stack (3 stack: +1.25x Bleed | 6 stack: mỗi 20 Stamina tiêu thụ qua đánh thường sẽ nổ dmg Bleed trên người kẻ địch)",
    ],
  },
  "shi association": {
    name: "Shi Association",
    resistance: { B: 1.3, P: 1.6, S: 1 },
    speedRange: { min: 4, max: 7 },
    keypage: [
      "Bạn nhận thêm 60 Max HP, tuy nhiên HP của bạn không thể vượt quá hơn mốc 60 Max HP được cho thêm đó",
      "Khi dưới hoặc bằng 25% HP, Poise của bạn sẽ được set về 5 Poise và sẽ không bao giờ giảm xuống hơn mức này",
      "Mỗi 1 đồng minh chết trong trận bạn nhận được 2 Dice Up cho đến hết encounter",
    ],
  },
  "liu association": {
    name: "Liu Association",
    resistance: { B: 0.9, P: 1.7, S: 1.3 },
    speedRange: { min: 4, max: 7 },
    keypage: [
      "Nhận được thêm 2 Dice Up khi bạn ở trong Emotion Level",
      "Mỗi khi gây Burn cho kẻ địch, bạn giảm 5 Stamina của chúng",
    ],
  },
  "dieci association": {
    name: "Dieci Association",
    resistance: { B: 1.1, P: 1.6, S: 1.2 },
    speedRange: { min: 4, max: 7 },
    keypage: [
      "Khi bị tấn công và bạn có Shield HP, kẻ địch sẽ nhận 2 Sinking",
      "Mỗi 20 Stamina tiêu thụ qua đòn đánh thường sẽ áp 2 Sinking lên người kẻ địch và cho bạn 4 Shield HP. Khi có trên hoặc bằng 20 Shield HP bạn nhận được 15% Dmg Up",
    ],
  },
  "thumb soldato": {
    name: "Thumb Soldato",
    resistance: { B: 1.6, P: 1.3, S: 1 },
    speedRange: { min: 3, max: 6 },
    keypage: [
      "Các vũ khí/skill/page sử dụng đạn sẽ được tăng thêm 15% Dmg gây ra",
      "Mỗi đòn đánh thường thứ 4 bạn sẽ nhận được 1 đạn",
      "Đồng minh thuộc Thumb ở trong trận sẽ nhận được đạn đặc biệt của riêng họ bằng một nửa số đạn mà bạn nạp được (làm tròn lên) thông qua Re-Load",
    ],
  },
  "the middle little sibling": {
    name: "The Middle Little Sibling",
    resistance: { B: 1.5, P: 1.3, S: 1.1 },
    speedRange: { min: 4, max: 7 },
    keypage: [
      "Khi parry/đòn đánh thường nhận light thành công nhận được 1 Stack Enhancement Tattoos. Cho phép giảm 5% Dmg nhận vào và tăng 10% Dmg gây ra với mỗi Stack, kéo dài 2 Turn",
      "Nếu kẻ địch có Stack Vengeance Mark trên người thì bạn sẽ tăng 10% Dmg Blunt bản thân gây ra",
    ],
  },
  "the middle big sibling": {
    name: "The Middle Big Sibling",
    resistance: { B: 2, P: 0.8, S: 0.8 },
    speedRange: { min: 5, max: 8 },
    keypage: [
      "Khi parry/đòn đánh thường nhận light thành công nhận được 1 Stack Enhancement Tattoos. Cho phép giảm 5% Dmg nhận vào và tăng 10% Dmg gây ra với mỗi Stack, kéo dài 2 Turn",
      "Nếu kẻ địch có Stack Vengeance Mark trên người thì bạn sẽ tăng 15% Dmg bản thân gây ra",
    ],
  },
  "seven association": {
    name: "Seven Association",
    resistance: { B: 1.5, P: 1.1, S: 1.3 },
    speedRange: { min: 4, max: 7 },
    keypage: [
      "Cho phép bạn kiểm tra toàn bộ thông tin của kẻ địch",
      "Gia tăng 1.5x hiệu quả áp Rupture của bạn",
    ],
  },
  "udjat": {
    name: "Udjat",
    resistance: { B: 0.9, P: 1.5, S: 1.4 },
    speedRange: { min: 4, max: 7 },
    keypage: ["Khi start encounter bạn nhận được 10 Protection [ĐÃ TỰ ĐỘNG HOÁ]"],
  },
  "warp corp. cleaner": {
    name: "WARP Corp. Cleaner",
    resistance: { B: 1.3, P: 1, S: 1.3 },
    speedRange: { min: 3, max: 6 },
    keypage: ["Gia tăng 1.5x hiệu quả nhận Charge của bản thân"],
  },
  "reverberation ensemble": {
    name: "Reverberation Ensemble",
    resistance: { B: 1.1, P: 1.6, S: 1.1 },
    speedRange: { min: 4, max: 7 },
    keypage: ["Cho bạn 40% Dmg Reduction"],
  },
  "cinq association": {
    name: "Cinq Association",
    resistance: { B: 1.5, P: 1, S: 1.6 },
    speedRange: { min: 5, max: 8 },
    keypage: [
      "Nhận được 7% Crit Rate với mỗi 2 Haste mà bạn có (Tối đa 25%)",
      "Nhận được 2 Haste vào mỗi 20 Stamina tiêu thụ thông qua đánh thường của bạn",
    ],
  },
  "blade lineage": {
    name: "Blade Lineage",
    resistance: { B: 1.3, P: 1.6, S: 1 },
    speedRange: { min: 3, max: 6 },
    keypage: [
      "Mỗi khi kẻ địch block đòn đánh của bạn, bạn nhận được 2 Poise",
      "Nếu người dùng có trên hoặc bằng 10 Poise, đòn đánh thường của bạn sẽ bỏ qua 50% giảm dmg của block",
      "Bạn nhận được 3 Poise mỗi khi dùng Page",
    ],
  },
  "blade lineage salsu": {
    name: "Blade Lineage Salsu",
    resistance: { B: 1.6, P: 1.3, S: 1 },
    speedRange: { min: 3, max: 6 },
    keypage: [
      "Vào turn start nếu Poise lớn hơn hoặc bằng 10, bạn add vào base dmg của page và critical theo 1/2 lượng Poise",
      "Khi Crit bạn gây 1 Red Plum Blossom lên kẻ địch, nếu có hơn hoặc bằng 5 Red Plum Blossom thì sẽ gây 1 Bleed",
    ],
  },
  "pointillist's uniform": {
    name: "Pointillist's Uniform",
    resistance: { B: 1.4, P: 1.2, S: 1.3 },
    speedRange: { min: 2, max: 5 },
    keypage: [
      "Khi Max Sanity mọi hiệu ứng bất lợi bạn gây ra được gia tăng 1.25x lần",
      "Mỗi khi đánh thường bạn nhận được 1 Sanity tương ứng với mỗi 1 hiệu ứng bất lợi khác nhau kẻ địch có trên người",
    ],
  },
  "index proselyte": {
    name: "Index Proselyte",
    resistance: { B: 1.3, P: 1.1, S: 1.5 },
    speedRange: { min: 4, max: 7 },
    keypage: [
      "Mỗi turn sẽ gieo dice từ 1 đến 7 để lấy sắc lệnh, và phải thực hiện nó trong vòng turn đó. Nếu thành công sẽ nhận được 1 Grace of Prescript. Nếu thất bại sắc lệnh sẽ nhận 5 Karmic Consequence; khiến bạn nhận thêm 1% Dmg cho mỗi stack. Max 100 Stack. (1: Tấn công | 2: Né | 3: Block | 4: Parry | 5: 1 phòng thủ + 1 tấn công | 6: Không làm gì | 7: Clash) — [ĐÃ TỰ ĐỘNG HOÁ HOÀN TOÀN — roll tự động đầu mỗi turn, track hành động thật (attack/evade/guard/parry/clash), tự cộng Grace/Karmic cuối turn.]",
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
