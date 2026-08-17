// skills.js — Toàn bộ skill data, tách ra để dễ quản lý
// Được require bởi index.js: const { SKILLS, SKILL_ALIASES, findSkill } = require("./skills");
// ─── SKILL DATA ───────────────────────────────────────────────────────────────
// Bảng 9 mặt Caduceus — SAO CHÉP tối thiểu từ constants.js để skills.js giữ được
// tính "module dữ liệu thuần" (không require ngược). Giá trị phải khớp
// CADUCEUS_DICE; t-index.js có check đối chiếu hai bên.
const CADUCEUS_FACES = [
  { n: 1, dmg: 8,  type: "Blunt",  name: "When hacking through the ribs with a hatchet..." },
  { n: 2, dmg: 8,  type: "Pierce", name: "When penetrating the lungs with a stiletto..." },
  { n: 3, dmg: 15, type: "Slash",  name: "When cleaving through the shoulder and the skull with a bastard sword..." },
  { n: 4, dmg: 15, type: "Pierce", name: "When punching 10 or more holes in the torso with a rapier..." },
  { n: 5, dmg: 15, type: "Blunt",  name: "When caving in the back of the skull with a hammer..." },
  { n: 6, dmg: 24, type: "Slash",  name: "When rending the body with a greatsword..." },
  { n: 7, dmg: 24, type: "Pierce", name: "When boring a 20-inch hole with a lance..." },
  { n: 8, dmg: 24, type: "Blunt",  name: "When ripping the flesh to ten thousand strips with a whip..." },
  { n: 9, dmg: 30, type: "Slash",  name: "When lacerating through space itself with a scythe, like a certain someone..." },
];
// Emoji type — DÙNG ĐÚNG dạng các skill khác đang dùng (`<:Blunt:…>`), không
// phải `<:Fix_Blunt:…>`: parser dựng dmgStr nhận diện theo khuôn dòng dice sẵn có.
// Hiệu ứng riêng của từng mặt Caduceus — dùng cho Furioso (mọi dice đều ăn
// hiệu ứng của mặt tương ứng). Viết đúng khuôn parser chung để tự áp.
const CADUCEUS_FACE_FX = {
  1: " — nhận 2 <:Poise:1513762945715142736>Poise",
  2: " — gây 2 <:Sinking:1513762793436741652>Sinking",
  3: " — bản thân +10% Dmg turn sau",
  4: " — địch nhận thêm 5% Dmg turn này",
  5: " — giảm 50 Stamina của kẻ địch",
  6: " — địch nhận thêm 10% Dmg từ Slash turn này",
  7: " — địch nhận thêm 10% Dmg từ Pierce turn này",
  8: " — địch nhận thêm 10% Dmg từ Blunt turn này",
  9: " [+Crit100] — chắc chắn gây critical",
};
const TYPE_EMOJI_CAD = { Blunt: "<:Blunt:1513768529718022254>", Pierce: "<:Pierce:1513768511179329556>", Slash: "<:Slash:1513768633434640517>" };

const D1 = "<:Dice1:1508173590078558369>";
const D2 = "<:Dice2:1508173623691710625>";
const D3 = "<:Dice3:1508173643518050395>";
const D4 = "<:Dice4:1508176464367845600>";
const D5 = "<:Dice5:1508176500438990968>";
const D6 = "<:Dice6:1517712655106838638>";
const D7 = "<:Dice7:1517712721796403272>";
const D8 = "<:Dice8:1517712757053591642>";
const D9 = "<:Dice9:1517712785612603462>";
// Mảng 9 emoji dice — dùng cho Caduceus Critical/Furioso (index 0..8 ↔ D1..D9).
// Phải đặt SAU D1..D9 (const là TDZ).
const DICE_EMOJI_N = [D1, D2, D3, D4, D5, D6, D7, D8, D9];
const D10 = "<:Dice10:1517712814314225704>";

// ─── EMOTION COIN TRACKING ──────────────────────────────────────────────────
// Cơ chế game: roll ra đúng MAX của dice → +1 Emotion Coin; roll ra đúng MIN → -1.
// Nếu min === max (dice cố định 1 giá trị, VD: [5~5]) thì không tính (không thể biết
// nên coi là "max" hay "min"). CHỈ hiển thị cho người chơi tự cộng/trừ tay — bot KHÔNG
// lưu lại Emotion Coin ở đâu cả.
//
// VẤN ĐỀ: mỗi skill's roll() tự gọi r(min, max) nhiều lần với range KHÁC NHAU cho từng
// dice, rồi tự build string mô tả riêng — không có chỗ nào "biết" min/max ban đầu sau
// khi đã roll xong để mà annotate. Thay vì sửa tay ~290 skill (rủi ro cực cao, dễ sót/sai),
// dùng side-channel: r() tự ghi lại {min, max, result, delta} vào 1 mảng module-level mỗi
// khi được gọi, NẾU đang ở chế độ tracking. index.js gọi startEmotionTracking() ngay
// trước skill.roll(...) và stopEmotionTracking() ngay sau, lấy lại toàn bộ các lần roll
// đã xảy ra TRONG khoảng đó để build dòng tổng kết Emotion Coin.
//
// AN TOÀN VỚI CONCURRENT REQUEST: biến module-level dùng chung cho mọi user, nhưng vì
// toàn bộ chuỗi start→roll()→stop chạy ĐỒNG BỘ (không có await ở giữa, do mọi roll()
// hiện tại đều là hàm sync thuần), Node.js không thể context-switch sang xử lý request
// của user khác giữa lúc đó — không có race condition.
let emotionTracker = null; // null = không track; Array nếu đang track

// ─── PARALYZE — ép Min Dice ─────────────────────────────────────────────────
// Status Paralyze (xác nhận trực tiếp): "khi trên người kẻ thù có 1 paralyze sẽ
// khiến cho 1 skill của kẻ thù sử dụng sẽ 100% Min Dice, sau khi sử dụng skill
// Min Dice sẽ giảm 1 count Paralyze" — dùng CÙNG side-channel pattern với
// emotionTracker ở trên (r() là điểm DUY NHẤT mọi skill roll() gọi để lấy dice
// value, nên can thiệp tại đây thay vì sửa tay ~300 skill). Khi bật, r(min,max)
// LUÔN trả về min (bỏ qua random) — vẫn ghi nhận đúng vào emotionTracker nếu
// đang track đồng thời (dùng min/max THẬT, không phải giá trị đã ép, để Emotion
// Coin tính đúng — dù kết quả luôn min nên delta luôn -1 nếu min≠max, đúng bản
// chất "Paralyze ép Min Dice" nghĩa là chắc chắn mất Emotion Coin lần đó).
let forceMinDiceActive = false;

function startForceMinDice() {
  forceMinDiceActive = true;
}

function stopForceMinDice() {
  forceMinDiceActive = false;
}

// ─── ÉP MAX DICE — đối xứng với forceMinDice ở trên ─────────────────────────
// Nguồn hiện có: passive "The Strongest" (Manifested E.G.O: Red Mist) — "toàn
// bộ Dice bạn gieo đều CHẮC CHẮN ra Max Dice".
//
// ⚠️ KHÁC forceMinDice ở đúng MỘT điểm: forceMinDice trả THẲNG `min`, BỎ QUA
// diceModifier (Paralyze là debuff — Dice Up không được cứu). Còn "The Strongest"
// cấp Max Dice VÀ 10 Dice Up trong CÙNG một passive, nên nếu ở đây cũng bỏ qua
// diceModifier thì 10 Dice Up kia thành vô nghĩa — tự passive mâu thuẫn với
// chính nó. Vì vậy: `max + diceModifierActive`.
//
// Nếu cả hai cùng bật thì MIN thắng (debuff ưu tiên). Thực tế không xảy ra —
// Shattered E.G.O chỉ tồn tại SAU khi Manifest đã tắt — nhưng vẫn định nghĩa
// rõ để không phụ thuộc vào may mắn.
let forceMaxDiceActive = false;

function startForceMaxDice() {
  forceMaxDiceActive = true;
}

function stopForceMaxDice() {
  forceMaxDiceActive = false;
}

// ─── DICE UP/DOWN (Value Power Up/Down) — cộng/trừ trực tiếp vào kết quả roll ──
// "Dice Up: +1 Dice. Biến mất sau End Turn" / "Dice Down: -1 Dice..." (xác nhận
// trực tiếp) — CÙNG side-channel pattern, khác Paralyze ở chỗ đây là CỘNG THÊM
// (không phải ép cứng về 1 giá trị), và KHÔNG clamp vào [min,max] gốc — Dice Up
// có thể đẩy kết quả VƯỢT max bình thường (đúng bản chất buff "tăng dice").
let diceModifierActive = 0;

// ── SANITY ẢNH HƯỞNG DICE ROLL (Fragaria 14/08) ──────────────────────────────
// *"Mỗi 1 Sanity dương so với mức 0 thì có thêm 1% sẽ roll ra dice max dễ hơn, và
//  ngược lại nếu âm so với mức 0 thì sẽ dễ ra min dice hơn."*
// *"Ví dụ range 1-10: có 45 Sanity thì 45% dễ roll ra 10 hơn; -45 Sanity thì 45%
//  dễ roll ra min dice là 1 hơn."*
// *"Hãy làm nó cho cả lệnh -rolldice và -skill đều xài được."*
//
// CÁCH LÀM: |Sanity|% cơ hội roll THẲNG ra max (Sanity dương) hoặc min (Sanity âm);
// phần còn lại roll đều như cũ. Nghĩa là 45 Sanity = 45% chắc chắn ra max, 55% roll
// bình thường (vẫn có thể ra max) — nên xác suất ra max THỰC TẾ cao hơn 45%, đúng
// chữ "dễ ra max HƠN" chứ không phải "đúng 45% ra max".
//
// ⚠️ Đặt trong `r()` — điểm chặn DUY NHẤT của mọi lần roll dice trong repo. Vá ở
//    từng lệnh là `-rolldice` và `-skill` lệch nhau ngay (lớp lỗi 8).
// ⚠️ KHÔNG đụng Emotion Coin: nó đọc `rawResult` (trước Dice Up/Down) và vẫn tính
//    đúng vì bias chỉ đổi GIÁ TRỊ roll, không đổi min/max.
let sanityBiasActive = 0;

/** setSanityBias — Sanity hiện tại của người roll (âm/dương so với mốc 0). */
function setSanityBias(sanity) {
  sanityBiasActive = Number.isFinite(sanity) ? sanity : 0;
}

/** rRaw — roll KHÔNG chịu BẤT KỲ tác động nào lên dice.
 *
 *  Fragaria 14/08 (Scales of Judgement): *"không bị ảnh hưởng bởi bất kỳ tác động
 *  đến Dice nào, VD: Dice Up, Max Dice, ..."* — và xác nhận **miễn nhiễm cả Sanity
 *  bias**. Nên KHÔNG dùng `r()`: nó cộng `diceModifierActive` và áp `applySanityBias`.
 *  Cũng KHÔNG đẩy vào `emotionTracker` — dice này không phải dice chiến đấu bình
 *  thường, tính Emotion Coin theo nó là sai.
 */
function rRaw(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clearSanityBias() {
  sanityBiasActive = 0;
}

/** Trả về giá trị dice đã áp bias, hoặc null nếu bias không kích. */
function applySanityBias(min, max) {
  if (!sanityBiasActive || min === max) return null;
  // Trần 100% — |Sanity| > 100 thì luôn kích (hiện ENCOUNTER_SANITY_MAX = 45 nên
  // chưa chạm, nhưng không để số > 100 làm hỏng phép so sánh).
  const chance = Math.min(100, Math.abs(sanityBiasActive));
  if (Math.random() * 100 >= chance) return null;
  return sanityBiasActive > 0 ? max : min;
}

function setDiceModifier(delta) {
  diceModifierActive = delta;
}

function clearDiceModifier() {
  diceModifierActive = 0;
}

function computeEmotionDelta(min, max, result) {
  if (min === max) return 0; // dice cố định 1 giá trị — không tính
  if (result === max) return 1;
  if (result === min) return -1;
  return 0;
}

function startEmotionTracking() {
  emotionTracker = [];
}

/** @returns {Array<{min:number,max:number,result:number,delta:number}>} */
function stopEmotionTracking() {
  const rolls = emotionTracker ?? [];
  emotionTracker = null;
  return rolls;
}

/** cadDice — GIÁ TRỊ DICE của một mặt Caduceus, ĐÃ ăn mọi buff/debuff dice.
 *
 *  ❗❗ BUG ĐÃ SỬA (Fragaria: "có vẻ Dice Up hay mọi loại buff khác không được áp
 *  vào Furioso khiến Dmg của nó bị tụt thê thảm").
 *  GỐC: `diceModifierActive` (Dice Up/Down, Mang, Freeble, Tremor Chain…) CHỈ
 *  được cộng bên trong `r()`. Toàn bộ họ Caduceus (9 Critical + 3 Furioso) lấy
 *  thẳng `CADUCEUS_FACES[i].dmg` — KHÔNG đi qua `r()` ⇒ mọi buff dice trượt sạch,
 *  suốt từ lúc bộ vũ khí này ra đời. Đây cũng chính là lý do Clash của chúng hỏng
 *  (xem `extractRolledDiceValues` ở index.js) — cùng một gốc "không qua r()".
 *  Fragaria xác nhận Base Dmg mỗi mặt TRỞ THÀNH Dice Value khi dùng Critical,
 *  nên buff dice phải cộng vào đây.
 *  KHÔNG dùng cho M1 Caduceus — luật: M1 không ăn Dice Up (xem HAND-OFF).
 *  Emotion Coin vẫn KHÔNG tính: mặt Caduceus là dice CỐ ĐỊNH (min = max).
 */
function cadDice(baseDmg) {
  if (forceMinDiceActive) return Math.max(1, baseDmg);
  return Math.max(1, Math.round((baseDmg + diceModifierActive) * 100) / 100);
}

function r(min, max) {
  let result;
  if (forceMinDiceActive) {
    result = min;
  } else if (forceMaxDiceActive) {
    result = Math.max(1, max + diceModifierActive);
  } else {
    // Sanity bias — xem comment ở `setSanityBias`. Áp TRƯỚC khi cộng Dice Up/Down
    // để bias tác động lên DICE GỐC (đúng "dễ ra max/min của dice đó hơn"), rồi
    // Dice Up/Down vẫn cộng thêm lên trên như mọi lần roll khác.
    const biased = applySanityBias(min, max);
    const raw = biased !== null ? biased : Math.floor(Math.random() * (max - min + 1)) + min;
    result = Math.max(1, raw + diceModifierActive);
  }
  if (emotionTracker) {
    // Emotion Coin tính theo kết quả GỐC (trước Dice Up/Down) để giữ đúng ý nghĩa
    // "roll đúng max/min của DICE GỐC" — Dice Up/Down là buff cộng thêm bên ngoài,
    // không phải bản chất của dice đó.
    const rawResult = forceMinDiceActive ? min : (forceMaxDiceActive ? max : result - diceModifierActive);
    emotionTracker.push({ min, max, result: rawResult, delta: computeEmotionDelta(min, max, rawResult) });
  }
  return result;
}

const SKILLS = {
  "fare-thee well": {
    name: "Fare-Thee Well",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "0.8x",
    roll() {
      const d1 = r(6,7), d2 = r(7,8), d3 = r(10,15);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Bleed:1513762688226955285>Bleed ở turn kế và nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Bleed:1513762688226955285>Bleed ở turn kế và nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D3} *Nếu bản thân có trên 10 <:Poise:1513762945715142736>Poise, Dice 3 nhận 5 <:DiceUp:1513767795681398894>Dice Up*`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — gây 4 <:Bleed:1513762688226955285>Bleed ở turn kế và nhận 4 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "purify": {
    name: "Purify",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,16), d2 = r(8,12), d3 = r(12,16);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — gây 2 <:Nails:1513768423124111482>Nails`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — gây 2 <:Nails:1513768423124111482>Nails`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — gây 3 <:Nails:1513768423124111482>Nails và 1 <:Paralyze:1513763316479295548>Paralyze`,
        `${D3} Gây 1 <:Gaze:1513768454967001179>Gaze — nếu địch có trên 7 <:Nails:1513768423124111482>Nails sẽ mất toàn bộ stack vượt quá 7`,
      ];
    },
  },
  "kicking": {
    name: "Kicking",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,6), d3 = r(6,7);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế; nếu ở **Middle Syndicate** thêm 2 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },
  "extract fuel": {
    name: "Extract Fuel", selfLightRestore: 2,
    // Task yêu cầu trực tiếp: "extract fuel không hồi hp khi dùng, hồi light
    // vào turn sau thay vì lúc dùng" — GAP THẬT: CẢ 2 hiệu ứng (hồi Light VÀ
    // hồi HP, mô tả rõ trong text) CHƯA TỪNG được code hoá. Light dùng field
    // cấu trúc selfLightRestore (giống pattern chung, xem resolve-pending-
    // action.js) — HP heal PHỤ THUỘC dice roll (7→10, 12→20, giữa→15), KHÔNG
    // cố định nên cần hàm riêng nhận base dmg value (parse lại từ dmgStr lúc
    // resolve — CHÍNH LÀ d1 vì roll() dùng d1 làm damage TRỰC TIẾP).
    selfHealByBaseDmg: (d1) => (d1 <= 7 ? 10 : d1 >= 12 ? 20 : 15),
    cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,12);
      // heal phụ thuộc endpoint của range r(7,12): min=7→10HP, max=12→20HP, giữa→15HP.
      // Nếu range thay đổi, cần cập nhật cả 3 nhánh này theo.
      let heal = d1 === 7 ? "hồi 10 HP" : d1 === 12 ? "hồi 20 HP" : "hồi 15 HP";
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — hồi lại 2 <:Light:1513786082502770719>Light (${heal})`,
      ];
    },
  },
  "stamp of vengeance": {
    name: "Stamp of Vengeance",
    cost: "4 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(16,24);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] [AOE 3 người] — gây 5 <:Bleed:1513762688226955285>Bleed ở turn kế, 2 <:Fix_Bind:1513768025881317457>Bind và nhận 2 **Middle Nursefather Tattoos** với mỗi địch đánh trúng`,
      ];
    },
  },
  "complete and total extermination": {
    name: "Complete and Total Extermination",
    cost: "5 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,25);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Undodgeable] — gây 4 <:Paralyze:1513763316479295548>Paralyze, <:TremorBurst:1513802464632246352>Tremor Burst, 10 <:Fragile:1513763336167100536>Fragile và 2 <:VengeanceMark:1513768136023740436>Vengeance Mark`,
      ];
    },
  },
  "following the flow": {
    name: "Following the Flow",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(7,9), d3 = r(8,10);
      return [
        `${D1} *Nếu địch có ≥4 <:Fix_Bind:1513768025881317457>Bind, mọi Dice của skill này add thêm 1 <:Fix_Burn:1513762753691652177>Burn*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Fix_Burn:1513762753691652177>Burn và 2 <:Fix_Bind:1513768025881317457>Bind`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "silence": {
    name: "Silence",
    cost: "5 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(5,7), d3 = r(7,10), d4 = r(8,12);
      return [
        `${D1} *Khi dùng: +1 <:DiceUp:1513767795681398894>Dice Up turn này và sau ứng với mỗi nhánh Skill Tree Wrath đã kích hoạt [Max: 4]*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Fix_Bind:1513768025881317457>Bind và +1 <:Fix_Burn:1513762753691652177>Burn ứng với mỗi <:Fix_Bind:1513768025881317457>Bind trên địch`,
      ];
    },
  },
  "waltz in black": {
    name: "Waltz In Black",
    cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,14);
      return [
        `${D1} *Nếu turn trước địch dính Waltz In White: skill này thành 3x Dice Multiplier và [Unevadeable]*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break]`,
      ];
    },
  },
  "waltz in white": {
    name: "Waltz In White",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(13,24);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unevadeable] [Unblockable]`,
      ];
    },
  },
  "light attack": {
    name: "Light Attack", selfLightRestore: 2,
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unparriable] [Unblockable] — hồi 2 <:Light:1513786082502770719>Light sau khi trúng`,
      ];
    },
  },
  "set fire": {
    name: "Set Fire", tags: "Burn",
    cost: "2 <:Light:1513786082502770719>Light", cd: "6 Turn", diceMul: "—",
    roll() {
      return [
        `*Không có Dice — page chỉ tự áp buff lên vũ khí bản thân*`,
        `Đốt cháy vũ khí của bạn trong 3 Turn, khiến cho đòn đánh thường (M1) tự động áp 1/2/4 <:Fix_Burn:1513762753691652177>Burn [Light/Medium/Heavy] lên kẻ địch mỗi lần trúng.`,
      ];
    },
  },
  "slash series": {
    name: "Slash Series",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(3,5), d3 = r(5,7);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — nhận 2 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "execute prescript": {
    name: "Execute Prescript",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(4,8);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Rupture:1513762812722155682>Rupture; nếu trong Index Syndicate & Deck Singleton thì +4 <:DiceUp:1513767795681398894>Dice Up`,
      ];
    },
  },
  "will of the city": {
    name: "Will of The City",
    cost: "1 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — hồi 1 <:Light:1513786082502770719>Light`,
      ];
    },
    // counterEffect — đánh dấu đây LÀ page-counter (dùng qua hệ thống rtparry
    // khi bị tấn công): thắng minigame phản xạ → counter thành công, gây dmg
    // dice NGAY + hiệu ứng phụ này lên bản thân người dùng counter.
    counterEffect: { light: 1 },
  },
  "dodge and strike": {
    name: "Dodge and Strike",
    cost: "1 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,16);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash]`,
      ];
    },
    counterEffect: {},
  },
  "soulburn": {
    name: "Soulburn",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "2x",
    roll() {
      const d1 = r(3,6), d2 = r(3,6), d3 = r(5,9);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 4 <:Fix_Burn:1513762753691652177>Burn và 1 <:Fragile:1513763336167100536>Fragile; tự gắn lên bản thân 1 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 6 <:Fix_Burn:1513762753691652177>Burn và 2 <:Fragile:1513763336167100536>Fragile; tự gắn lên bản thân 1 <:Fix_Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 10 <:Fix_Burn:1513762753691652177>Burn và 2 <:Fragile:1513763336167100536>Fragile; tự gắn lên bản thân 2 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "inferno burst": {
    name: "Inferno Burst",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(9,12), d2 = r(11,13);
      return [
        `${D1} *Nếu địch có sẵn 10 <:Fix_Burn:1513762753691652177>Burn: tăng lượng <:Fix_Burn:1513762753691652177>Burn mỗi Hit thêm 3 <:Fix_Burn:1513762753691652177>Burn*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Fix_Burn:1513762753691652177>Burn; tự gắn lên bản thân 2 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 6 <:Fix_Burn:1513762753691652177>Burn; tự gắn lên bản thân 4 <:Fix_Burn:1513762753691652177>Burn; kích Burning Sensation`,
      ];
    },
  },
  "celestial fire": {
    name: "Celestial Fire",
    cost: "6 <:Light:1513786082502770719>Light", cd: "7 Turn", diceMul: "—",
    roll() {
      return [
        `*Không có Dice — page chỉ tự áp hiệu ứng lên bản thân/đối phương*`,
        `Tự gắn lên bản thân 20 <:Fix_Burn:1513762753691652177>Burn, kích hoạt **Burning Sensation** trên người đối phương`,
        `Khả năng gắn <:Fix_Burn:1513762753691652177>Burn tăng lên 1,5x (kéo dài 2 Turn)`,
        `*Nếu bản thân có sẵn 10 <:Fix_Burn:1513762753691652177>Burn (không phải từ chính Page này): kích hoạt thêm 1 lần **Burning Sensation** nữa*`,
      ];
    },
  },
  "light dash": {
    name: "Light Dash", tags: "Light",
    // reactiveOnly — Task yêu cầu trực tiếp: "light dash/fleetfoot steps sử dụng
    // tùy ý được ở moves (nên xóa ra ở moves), đáng lẽ phải chỉ được dùng ở
    // reactive defense". Page này KHÔNG gây dmg, tác dụng duy nhất là né 1 đòn —
    // dùng chủ động lúc tới lượt mình là vô nghĩa (không có đòn nào để né).
    // buildMovesOptions (encounter-panels.js) lọc bỏ mọi skill có cờ này; nút
    // thật nằm ở prompt Reactive Defense (reactive-defense.js).
    reactiveOnly: true,
    // Fragaria: "Thêm tag unclashable cho pounce, follow-up, light dash,
    // fleetfoot steps và borrowed eyes" — `unclashable` là CỜ DỮ LIỆU (bộ chọn
    // Clash của người chơi LẪN AI đều lọc theo nó), còn tag [Unclashable] viết
    // trong dòng roll() là phần NGƯỜI CHƠI ĐỌC + để parser phòng thủ bắt được.
    unclashable: true,
    cost: "0 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "—",
    roll() {
      return [
        `*Không có Dice — page chỉ tự áp hiệu ứng lên bản thân*`,
        `[Unclashable] Lướt tới vị trí kẻ thù đồng thời hồi cho bản thân 2 <:Light:1513786082502770719>Light và né một đòn tấn công của kẻ địch (không thể né Undodgeable)`,
      ];
    },
  },
  "take this kid": {
    name: "Take this, Kid",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,16), d2 = r(16,24);
      return [
        `${D1} *Nếu địch có Bleed: gắn 1 <:Hemorrhage:1513762688226955285>Hemorrhage*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "learn again kid": {
    name: "Learn again, Kid",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(8,12), d2 = r(8,12), d3 = r(10,14), d4 = r(14,20);
      return [
        `${D1} *Nếu địch có <:Bleed:1513762688226955285>Bleed: gắn 1 <:Hemorrhage:1513762688226955285>Hemorrhage*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "catch breath": {
    name: "Catch Breath",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,15);
      return [
        `${D1} *Khi dưới 50% HP: <:Dice1:1508173590078558369>Dice 1 nhận 4 <:DiceUp:1513767795681398894>Dice Up*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — nhận 6 <:Poise:1513762945715142736>Poise; khi dưới 50% HP thêm 2 <:Poise:1513762945715142736>Poise và 4 <:Fix_Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "onrush": {
    name: "Onrush",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    // ❗ KHÔI PHỤC REUSE (Fragaria 12/08): "Desc ghi là Reuse khi có ≥6 Light,
    // thực tế lần reuse đó sẽ tốn thêm 3 Light nữa… lần reuse sẽ là TÙY CHỌN như
    // Mook Workshop hoặc Thrust."
    // ⚠️ Trước đó Onrush KHÔNG có tí máy móc reuse nào — một phiên cũ đã gỡ sạch
    // theo câu "Onrush không có khả năng reuse nữa". Nay dựng lại bằng đúng
    // `reuseSpec` (xem REUSE_SPEC_CONTRACT ở cuối file) để chi phí Light được
    // TRỪ THẬT — đây chính là lớp bug "reuse gần như miễn phí" đã ghi ở đó.
    reuseChoiceVariants: true,   // hiện dropdown hỏi ý người chơi (như Mook/Thrust)
    maxUses: 2,                  // 1 lần gốc + tối đa 1 lần Reuse
    reuseSpec: {
      mode: "repeat",            // roll() sinh 1 dice mỗi lần gọi ⇒ gọi lặp rồi ghép
      resource: "light",
      // "Reuse khi có ≥6 Light": 3 Light đòn gốc + 3 Light lần reuse = 6.
      maxReuse: (light) => ((light ?? 0) >= 6 ? 1 : 0),
      // netCost THAY THẾ hoàn toàn `cost` (xem skill-verification.js: lightCost =
      // reuseInfo.netCost) ⇒ phải gồm CẢ đòn gốc: 3 + 3×số lần reuse.
      netCost: (n) => 3 + 3 * n,
      repeatArgs: (i) => [i > 0],
    },
    roll(isReuse = false) {
      const d1 = r(14,26);
      // Hai hiệu ứng (giảm 40 Stamina địch + nhận 1 Imitation) đi qua parser
      // side-effect của dòng dice, nên lần Reuse cũng được hưởng — đúng nghĩa
      // "dùng lại nguyên đòn".
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash]${isReuse ? " *(Reuse)*" : ""} — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 1 <:Imitation:1513769425063514173>Imitation, giảm 40 Stamina địch`,
      ];
    },
  },
  "overthrow": {
    name: "Overthrow",
    cost: "5 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,4), d2 = r(2,4), d3 = r(5,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:Poise:1513762945715142736>Poise; nếu có trên 5 <:Poise:1513762945715142736>Poise thêm 2 <:DiceUp:1513767795681398894>Dice Up`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D3} *Nếu có ≥5 <:Poise:1513762945715142736>Poise: chuyển 5 <:Poise:1513762945715142736>Poise → 8 <:DiceUp:1513767795681398894>Dice Up cho Dice 3; nếu kết liễu được địch thêm 3 <:DiceUp:1513767795681398894>Dice Up turn sau*`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unparriable] [Guard Break] — gây 10 <:Bleed:1513762688226955285>Bleed ở turn kế, 5 <:Paralyze:1513763316479295548>Paralyze, nhận 5 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "shadowcloud shattercleaver": {
    name: "Shadowcloud Shattercleaver",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,5), d2 = r(2,5), d3 = r(8,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:DefenseUp:1513767487894716497>Defense Up; nếu địch có trên 6 <:Bleed:1513762688226955285>Bleed thêm 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — gây 5 <:Bleed:1513762688226955285>Bleed ở turn kế`,
      ];
    },
  },
  "punting": {
    name: "Punting",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,6);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 2 <:Poise:1513762945715142736>Poise và 1 **Middle Nursefather Tattoos**`,
      ];
    },
  },
  "punching": {
    name: "Punching",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(5,7), d3 = r(6,8);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Paralyze:1513763316479295548>Paralyze nếu ở trong **Middle Syndicate**`,
      ];
    },
  },
  "furioso": {
    name: "Furioso",
    cost: "A Prayer For Loving Sorrow", cd: "—", diceMul: "2.5x",
    // ── FURIOSO REWORK (Fragaria xác nhận trực tiếp) ────────────────────────────
    // BỎ [Unclashable] — giờ Furioso CLASH ĐƯỢC, và clash bằng **TỔNG roll của cả
    // 9 dice gộp lại** (không phải dice đầu như skill thường) → xem
    // `clashUsesTotalDice` bên dưới.
    // 3 TAG MỚI:
    //   • [Unbreakable Dice] — THUA clash vẫn TIẾN HÀNH sử dụng, chỉ còn 50% dmg
    //     gốc (thay vì bị huỷ hoàn toàn như mọi skill khác).
    //   • [Uncounterable] — không thể bị page-counter ngắt.
    //   • [Unfocused Volley] — MỖI DICE nảy sang 1 kẻ địch NGẪU NHIÊN trên sân;
    //     riêng dice ĐẦU chắc chắn trúng target được aim.
    // Tag khai ở DÒNG HEADER = áp cho CẢ page (parsePerHitBypass đọc được — xem
    // index.js), nên không phải lặp ở từng dòng dice nữa.
    clashUsesTotalDice: true,
    unbreakableDiceMul: 0.5,
    unfocusedVolley: true,
    roll() {
      const d1=r(12,21), d2=r(11,20), d3=r(16,25), d4=r(15,21),
            d5=r(17,26), d6=r(14,23), d7=r(17,26), d8=r(29,38), d9=r(17,26);
      return [
        `**[Undodgeable] [Unblockable] [Unparriable] [Uncounterable] [Unbreakable Dice] [Unfocused Volley]**`,
        `*⚔️ Clash bằng TỔNG cả 9 dice · thua clash vẫn dùng với 50% dmg · mỗi dice nảy ngẫu nhiên sang kẻ địch khác (dice 1 luôn trúng mục tiêu được nhắm)*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [100% Crit] — nhận 6 <:Poise:1513762945715142736>Poise`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Tremor:1513762737388257380>Tremor`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Rupture:1513762812722155682>Rupture`,
        `${D5} **${d5}** [<:Pierce:1513768511179329556>Pierce] — gây 5 <:Bleed:1513762688226955285>Bleed`,
        // Dice 6 và 8 là "50% Slash / 50% Blunt" — CHIA ĐÔI thành 2 hit (xác nhận
        // trực tiếp: "dice ra 20 → 2 Hit: 10 Slash + 10 Blunt"). Status phụ CHỈ
        // ghi ở 1 trong 2 nửa, nếu không sẽ bị áp GẤP ĐÔI.
        `${D6} **${half(d6)}** [<:Slash:1513768633434640517>Slash] — *(nửa Slash)* gây 3 <:Fragile:1513763336167100536>Fragile, 3 <:Fix_Bind:1513768025881317457>Bind và <:TremorBurst:1513802464632246352>Tremor Burst`,
        `${D6} **${half(d6)}** [<:Blunt:1513768529718022254>Blunt] — *(nửa Blunt)*`,
        `${D7} **${d7}** [<:Blunt:1513768529718022254>Blunt] — gây 10 <:Tremor:1513762737388257380>Tremor`,
        `${D8} **${half(d8)}** [<:Slash:1513768633434640517>Slash] — *(nửa Slash)* gây 2 <:Sinking:1513762793436741652>Sinking`,
        `${D8} **${half(d8)}** [<:Blunt:1513768529718022254>Blunt] — *(nửa Blunt)* gây 3 <:Rupture:1513762812722155682>Rupture`,
        `${D9} **${d9}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Rupture:1513762812722155682>Rupture; nhận 3 <:DiceUp:1513767795681398894>Dice Up (áp TRƯỚC khi gây dmg, kéo dài hết turn)`,
      ];
    },

  },

// NEW SKILLS BLOCK - insert before closing }; of SKILLS

  // ── <:Sinking:1513762793436741652>Sinking skills ──
  "weight of knowledge": {
    name: "Weight of Knowledge", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,4),d2=r(3,5),d3=r(3,5),d4=r(3,6);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice4:1508176464367845600> *Nếu địch có trên 8 <:Sinking:1513762793436741652>Sinking: nhận 15 **Shield HP***`,
      ];
    },
  },
  "illuminate thy vacuity": {
    name: "Illuminate Thy Vacuity", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,4),d2=r(2,4),d3=r(2,4),d4=r(2,4),d5=r(3,6);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice5:1508176500438990968> **${d5}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 2 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice5:1508176500438990968> *Nếu địch có trên 6 <:Sinking:1513762793436741652>Sinking: nhận 25 **Shield HP***`,
      ];
    },
  },
  "studious dedication": {
    name: "Studious Dedication", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(5,8),d2=r(5,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "scorch knowledge": {
    name: "Scorch Knowledge", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,4),d2=r(4,8),d3=r(13,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Sinking:1513762793436741652>Sinking`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — gây 5 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },

  // ── <:Bleed:1513762688226955285>Bleed skills ──
  "sanguine painting": {
    name: "Sanguine Painting", cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "0.66x",
    roll() {
      const rolls = [r(4,9), r(4,9)];
      const lines = [
        `*Chém 2 nhát, mỗi nhát gây 2 <:Bleed:1513762688226955285>Bleed*`,
        `<:Dice1:1508173590078558369> Nhát 1: **${rolls[0]}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice2:1508173623691710625> Nhát 2: **${rolls[1]}** [<:Pierce:1513768511179329556>Pierce]`,
      ];
      // Nếu địch trên 6 Bleed: thêm 2 lần với +5 dice
      const bonus1=r(9,14), bonus2=r(9,14);
      lines.push(`*Nếu địch có trên 6 <:Bleed:1513762688226955285>Bleed: thêm 2 nhát với +5 Dice, mỗi nhát gây 2 <:Bleed:1513762688226955285>Bleed*`);
      lines.push(`<:Dice1:1508173590078558369> Nhát bonus 1: **${bonus1}** [<:Pierce:1513768511179329556>Pierce]`);
      lines.push(`<:Dice2:1508173623691710625> Nhát bonus 2: **${bonus2}** [<:Pierce:1513768511179329556>Pierce]`);
      return lines;
    },
  },
  "hematic coloring": {
    name: "Hematic Coloring", cost: "5 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "(1~4): 0.5x / (5): 1x",
    roll() {
      const EFFECTS = [
        `<:Fix_Burn:1513762753691652177>Burn`, `<:Tremor:1513762737388257380>Tremor`,
        `<:Rupture:1513762812722155682>Rupture`, `<:Sinking:1513762793436741652>Sinking`, `<:Bleed:1513762688226955285>Bleed`
      ];
      function pickEffects() {
        const pool = [...EFFECTS];
        const picked = [];
        for (let i = 0; i < 3; i++) {
          const idx = Math.floor(Math.random() * pool.length);
          picked.push(pool.splice(idx, 1)[0]);
        }
        return picked.join(" ");
      }
      const ranges = [[3,6],[6,9],[9,12],[12,15],[15,18]];
      const diceEmoji = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,
        `<:Dice3:1508173643518050395>`,`<:Dice4:1508176464367845600>`,`<:Dice5:1508176500438990968>`
      ];
      const lines = [`*Dice 1~4: mỗi lần gây 3 Effects ngẫu nhiên. Dice 5: đòn kết thúc 1x*`];
      for (let i = 0; i < 5; i++) {
        const val = r(ranges[i][0], ranges[i][1]);
        if (i < 4) {
          lines.push(`${diceEmoji[i]} **${val}** [<:Pierce:1513768511179329556>Pierce] — ${pickEffects()}`);
        } else {
          lines.push(`${diceEmoji[i]} **${val}** [<:Pierce:1513768511179329556>Pierce] *(đòn kết thúc)*`);
        }
      }
      return lines;
    },
  },
  "sanguine pointilism": {
    name: "Sanguine Pointilism", cost: "—", cd: "2 Turn", diceMul: "1x",
    needsReuse: true,
    promptArg: {
      label: "% Reuse",
      parse: (s) => parseInt(s, 10),
      validate: (v) => !isNaN(v) && v >= 0 && v <= 100,
      errorMsg:
        "❓ **Sanguine Pointilism** cần nhập % Reuse.\n" +
        "> Cú pháp: `-skill sanguine pointilism <% reuse>`\n" +
        "> VD: `-skill sanguine pointilism 60` (mặc định 40%, +20% mỗi 5 Bleed trên địch)",
      buildHeader: (v, s) => `[Reuse: ${v}%] [CD: ${s.cd}] [Dice Mul: ${s.diceMul}]`,
    },
    roll(reusePct = 40) {
      const D1 = `<:Dice1:1508173590078558369>`;
      const D2 = `<:Dice2:1508173623691710625>`;
      const D3 = `<:Dice3:1508173643518050395>`;
      const REUSE_EMOJIS = [D2, D3, `<:Dice4:1508176464367845600>`];
      const d1 = 14;
      const lines = [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed 2 <:Fix_Burn:1513762753691652177>Burn 2 <:Tremor:1513762737388257380>Tremor 2 <:Sinking:1513762793436741652>Sinking 2 <:Rupture:1513762812722155682>Rupture`,
      ];
      for (let i = 1; i <= 2; i++) {
        const triggered = Math.random() * 100 < reusePct;
        const dEmoji = REUSE_EMOJIS[i - 1] ?? REUSE_EMOJIS[REUSE_EMOJIS.length - 1];
        if (triggered) {
          lines.push(`${dEmoji} ↩️ Reuse ${i} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed 2 <:Fix_Burn:1513762753691652177>Burn 2 <:Tremor:1513762737388257380>Tremor 2 <:Sinking:1513762793436741652>Sinking 2 <:Rupture:1513762812722155682>Rupture *(${reusePct}% → ✅)*`);
        } else {
          lines.push(`${dEmoji} ↩️ Reuse ${i} dừng tại đây *(${reusePct}% → ❌)*`);
          break;
        }
      }
      return lines;
    },
  },

  // ── <:Fix_Burn:1513762753691652177>Burn skills ──
  "perfected death fist": {
    name: "Perfected Death Fist", cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,6),d2=r(6,9),d3=r(9,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> *Nếu địch có trên 8 <:Fix_Burn:1513762753691652177>Burn: gắn thêm 3 <:Fix_Burn:1513762753691652177>Burn*`,
        `<:Dice3:1508173643518050395> *Nếu địch có trên 6 <:Fix_Burn:1513762753691652177>Burn: +5 <:DiceUp:1513767795681398894>Dice Up cho bản thân*`,
      ];
    },
  },
  "raging storm": {
    name: "Raging Storm", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    // [Khuếch tán N mục tiêu] — KHÁC AOE (Fragaria chốt trực tiếp): mục tiêu
    // CHÍNH chịu 100% dmg, các mục tiêu CÒN LẠI chỉ chịu 50%. AOE thì mọi mục
    // tiêu đều 100%. Tag này TRƯỚC ĐÂY chỉ là chữ trong text, không có mã nào
    // đọc → khuếch tán chạy y hệt AOE.
    spreadTargets: 3, spreadFalloffPct: 0.5,
    roll() {
      const d1=r(5,9),d2=r(10,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — gây 4 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — gây 8 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "fiery waltz": {
    name: "Fiery Waltz", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(9,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 5 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "red kick": {
    name: "Red Kick", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,5),d2=r(8,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> *Tấn công cộng thêm (số <:Fix_Burn:1513762753691652177>Burn trên địch ÷ 3) dice*`,
      ];
    },
  },
  "flowing flame": {
    name: "Flowing Flame", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(8,14);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gắn 4 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice1:1508173590078558369> *Trên 30 Sanity: gắn 6 <:Fix_Burn:1513762753691652177>Burn | Trên 45 Sanity: gắn 8 <:Fix_Burn:1513762753691652177>Burn*`,
      ];
    },
  },
  "fleet edge": {
    name: "Fleet Edge", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,6),d2=r(4,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> *Nếu địch có trên 10 <:Fix_Burn:1513762753691652177>Burn: gắn thêm 3 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>*`,
      ];
    },
  },
  "flow of the sword": {
    name: "Flow of the Sword", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,5),d2=r(6,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },

  // ── <:Poise:1513762945715142736>Poise / <:Bleed:1513762688226955285>Bleed mixed ──
  "extreme edge": {
    name: "Extreme Edge", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    // variants — Fragaria yêu cầu trực tiếp: "nên thêm nút để chọn biến thể".
    // 3 tình huống LOẠI TRỪ nhau, mỗi cái 1 dải dice + tag khác hẳn. Trước đây
    // roll() in cả 3 dòng nên parser hoặc lấy nhầm cả 3 (thành 3 hit) hoặc bỏ
    // qua — không cách nào đúng. Giờ player chọn ĐÚNG 1 qua nút, roll() chỉ trả
    // dòng của biến thể đó.
    // Cấu trúc chung (dùng lại được cho mọi skill kiểu "tuỳ tình huống"):
    //   variants: [{ key, label, emoji }]  — key phải KHÔNG chứa ":" hay "|"
    //   roll(variantKey)                   — mặc định = variants[0].key
    variants: [
      { key: "ground", label: "Mặt đất", emoji: "⬇️" },
      { key: "air", label: "Trên không", emoji: "🕊️" },
      { key: "low", label: "Dưới 33% HP", emoji: "🩸" },
    ],
    roll(variantKey = "ground") {
      if (variantKey === "air") {
        const air = r(4, 7);
        return [
          `*🕊️ **Trên không***`,
          `<:Dice1:1508173590078558369> **${air}** [<:Slash:1513768633434640517>Slash] — gây 5 <:DefenseDown:1513767463337066576>Defense Down`,
        ];
      }
      if (variantKey === "low") {
        const low = r(17, 30);
        return [
          `*🩸 **Dưới 33% HP***`,
          `<:Dice1:1508173590078558369> **${low}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Undodgeable] [AOE] — gây 8 <:Bleed:1513762688226955285>Bleed và 5 <:DefenseDown:1513767463337066576>Defense Down`,
        ];
      }
      const normal = r(7, 8);
      return [
        `*⬇️ **Mặt đất***`,
        `<:Dice1:1508173590078558369> **${normal}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Knockback] — gây 5 <:Bleed:1513762688226955285>Bleed và 2 <:DefenseDown:1513767463337066576>Defense Down`,
      ];
    },
  },
  "flying sword": {
    name: "Flying Sword", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(4,8),d2=r(3,9),dAir=r(6,12);
      return [
        `*Nhận 6 <:Poise:1513762945715142736>Poise*`,
        `**Mặt đất:**`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `**Trên không:** *Nhận 6 <:Poise:1513762945715142736>Poise*`,
        `<:Dice1:1508173590078558369> **${dAir}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Airborne] — gây 5 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
      ];
    },
  },
  "boundary of death": {
    name: "Boundary of Death", tags: "Poise",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const roll4 = r(1,4);
      if (roll4 === 4) {
        const dmg = r(47,57);
        return [
          `*Page độc quyền của **Shi Association** — chỉ sử dụng được khi dùng Outfit **Shi Association** và đang ở trong **Shi Association***`,
          `${D1} **${roll4}→${dmg}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Undodgeable] — Roll đúng 4: đổi dice thành **[47~57]**, gây **${dmg} True Damage** và nhận lại 4 <:Light:1513786082502770719>Light`,
        ];
      } else {
        return [
          `*Page độc quyền của **Shi Association** — chỉ sử dụng được khi dùng Outfit **Shi Association** và đang ở trong **Shi Association***`,
          `${D1} **${roll4}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Undodgeable] — Gây **${roll4} True Damage** *(Roll đúng 4 để kích hoạt dạng mạnh: đổi dice thành [47~57])*`,
        ];
      }
    },
  },

  // ── Misc skills ──
  "xuất lực tối đa": {
    name: "Xuất Lực Tối Đa", cost: "1 <:Light:1513786082502770719>Light + 20 Cursed Energy", cd: "0 Turn", diceMul: "1x",
    needsBlackFlash: true,
    promptArg: {
      label: "% Hắc Thiểm",
      parse: (s) => parseFloat(s),
      validate: (v) => !isNaN(v) && v >= 0 && v <= 100,
      errorMsg:
        "❓ **Xuất Lực Tối Đa** có thể nhập % Hắc Thiểm (mặc định 5%).\n" +
        "> Cú pháp: `-skill xuất lực tối đa [%]`\n" +
        "> VD: `-skill xltd` | `-skill xltd 20` | `-skill xltd 0.5`",
      buildHeader: (v, s) => `[${s.cost}] [CD: ${s.cd}] [Hắc Thiểm: ${v}%]`,
    },
    embedColor: 0x1a1a2e,
    roll(blackFlashPct = 5) {
      const d1=r(13,17);
      const isBlackFlash = Math.random() * 100 < blackFlashPct;
      if (isBlackFlash) {
        return [
          `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break]`,
          `⚫ **HẮC THIỂM!** Dice Multiplier → **2.5x** *(tỷ lệ: ${blackFlashPct}%)*`,
        ];
      }
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break]`,
        `*(${blackFlashPct}% HẮC Thiểm → không kích hoạt)*`,
      ];
    },
  },
  "level slash": {
    name: "Level Slash", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(8,10),d2=r(9,11);
      return [
        `*Khi trong E.G.O mà kết liễu địch: nhận 5 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 1 <:Imitation:1513769425063514173>Imitation`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 1 <:Imitation:1513769425063514173>Imitation`,
      ];
    },
    // GAP ĐÃ SỬA (Fragaria báo trực tiếp: "spear/level slash không cho imitation")
    // — TRƯỚC ĐÂY chỉ "upstanding slash" được code hoá ở resolve-pending-action.js,
    // 2 page này ghi "nhận 1 Imitation" trong text nhưng KHÔNG có logic nào cả.
    // Dùng diceEffects (cơ chế CÓ SẴN, gate bằng hitEvadedOrParried[i] — chỉ cộng
    // khi dice đó THẬT SỰ trúng, không cộng khi bị né/parry).
    diceEffects: [{ imitation: 1 }, { imitation: 1 }],
  },
  "spear": {
    name: "Spear", cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1=r(4,5),d2=r(5,6),d3=r(6,7);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 1 <:Imitation:1513769425063514173>Imitation`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 1 <:Imitation:1513769425063514173>Imitation`,
      ];
    },
    // Xem comment ở "level slash". LƯU Ý: Dice 2 KHÔNG cho Imitation (đọc kỹ text
    // gốc — chỉ Dice 1 và Dice 3 có), nên phần tử giữa là null.
    diceEffects: [{ imitation: 1 }, null, { imitation: 1 }],
  },
  "focus spirit": {
    name: "Focus Spirit", cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1=r(10,20);
      const turns = d1 === 20 ? 3 : d1 >= 15 ? 2 : 1;
      return [
        `<:Dice1:1508173590078558369> **${d1}** [không bị ảnh hưởng bởi buff dice]`,
        `→ Nhận 2 <:DiceUp:1513767795681398894>Dice Up tồn tại **${turns} Turn**`,
      ];
    },
  },

  // ── Weapon criticals ──
  "dimensional rift dagger": {
    name: "Dimensional Rift", cost: "—", cd: "2 Turn", diceMul: "1x",
    weaponOf: "WARP Corp. Dagger",
    roll() {
      const hasCharge = Math.random() < 0.5; // placeholder
      const dNormal=r(6,12), dCharged=r(16,24);
      return [
        `*Tiêu thụ 15 <:Charge:1513762867558613033>Charge nếu đủ → đổi Dice 1 thành [16~24] và gây 6 <:Rupture:1513762812722155682>Rupture*`,
        `<:Dice1:1508173590078558369> **${dNormal}** [<:Pierce:1513768511179329556>Pierce] *(thường)* / **${dCharged}** [<:Pierce:1513768511179329556>Pierce] *(có 15 Charge)* — gây 3 <:Rupture:1513762812722155682>Rupture và nhận 4 <:Charge:1513762867558613033>Charge`,
      ];
    },
  },

  // ── Charge skills ──
  "charge shield": {
    name: "Charge Shield", cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1=r(5,15);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 2 <:Rupture:1513762812722155682>Rupture, nhận 5 <:ChargeBarrier:1513768302973812887> Charge Barrier`,
        `*Nếu ≥10 <:Charge:1513762867558613033>Charge: tiêu thụ toàn bộ Charge → đổi thành Shield HP tương đương*`,
      ];
    },
  },
  "leap": {
    name: "Leap", cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1=r(4,8),d2=r(8,12),d3=r(12,16);
      return [
        `*Nếu ≥10 <:Charge:1513762867558613033>Charge: +5 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — nhận 3 <:Charge:1513762867558613033>Charge và gây 2 <:Fragile:1513763336167100536>Fragile`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — nhận 3 <:Charge:1513762867558613033>Charge và gây 2 <:Fragile:1513763336167100536>Fragile`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 4 <:Fragile:1513763336167100536>Fragile`,
      ];
    },
  },
  "overcharged ripple": {
    name: "Overcharged Ripple", cost: "4 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(5,7),d2=r(6,8),d3=r(7,9),d4=r(8,10);
      return [
        `*Nếu ≥10 <:Charge:1513762867558613033>Charge: Dice Multiplier → 1.5x*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — nhận 1 <:Charge:1513762867558613033>Charge`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — nhận 1 <:Charge:1513762867558613033>Charge`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — nhận 1 <:Charge:1513762867558613033>Charge`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — nhận 4 <:Charge:1513762867558613033>Charge`,
      ];
    },
  },

  // ── <:Poise:1513762945715142736>Poise (Blade Lineage) ──
  "moon-splitting draw": {
    name: "Moon-Splitting Draw", cost: "4 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1=r(15,25);
      return [
        `*Nếu bản thân có trên 15 <:Poise:1513762945715142736>Poise: +5 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — gây 3 <:Paralyze:1513763316479295548>Paralyze, nhận 5 <:Poise:1513762945715142736>Poise, mất 5 HP và nhận 3 <:Light:1513786082502770719>Light`,
        `*Nếu địch parry thành công hay không dính dmg: không hồi <:Light:1513786082502770719>Light*`,
      ];
    },
  },
  "red plum blossom scatter": {
    name: "Red Plum Blossom Scatter", cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1.6x",
    roll() {
      const d1=r(5,12),d2=r(4,7);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 2 <:Red_Plum_Blossom:1513768345521094668> và nhận <:DiceUp:1513767795681398894>Dice Up bằng (Poise ÷ 3)`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] [Undodgeable] — gây 4 <:Red_Plum_Blossom:1513768345521094668>`,
      ];
    },
  },
  "yield my flesh": {
    name: "Yield My Flesh", cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    // ⚠️ FACTION lock, KHÔNG phải outfit lock (Fragaria: "những page như Unlock,
    // Yield My Flesh là FACTION lock, trong code đang để là outfit lock khá sai").
    // Trước đây điều kiện chỉ nằm ở CHỮ mô tả — không dòng code nào chặn cả.
    requiresFaction: "Blade Lineage",
    roll() {
      const d1=r(3,6),d2=r(6,12);
      return [
        `*Skill đặc biệt của **Blade Lineage** — yêu cầu FACTION Blade Lineage (không phải outfit)*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — Né 1 đòn đánh thường hoặc clash`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — Nếu địch không đánh để né/clash: chém và nhận 2 <:Light:1513786082502770719>Light`,
      ];
    },
    // counterEffect ĐẶC BIỆT (xác nhận trực tiếp: "nếu counter thành công ->
    // ngắt đòn kẻ địch rồi sử dụng To Claim Their Bones gây sát thương. Nếu
    // clash thua -> ăn hết đòn của kẻ địch rồi sau đó sử dụng To Claim Their
    // Bones") — KHÁC MỌI page-counter khác: mở khoá "To Claim Their Bones" làm
    // hành động tiếp theo BẤT KỂ THẮNG HAY THUA minigame (alwaysUnlocks) — chỉ
    // khác là dmg đòn tấn công gốc có bị ngắt (thắng) hay ăn đủ (thua).
    // noDirectDamage: dice1 không tự gây dmg (chỉ là "né/clash" trigger).
    counterEffect: { unlocksSkillKey: "to claim their bones", noDirectDamage: true, alwaysUnlocks: true },
  },
  "to claim their bones": {
    name: "To Claim Their Bones", cost: "0 <:Light:1513786082502770719>Light", cd: "Khi Yield My Flesh kích hoạt", diceMul: "1x",
    roll() {
      const d1=r(3,4),d2=r(4,5),d3=r(5,6),d4=r(6,7);
      return [
        `*[Unblockable] — Chỉ dùng được sau khi Yield My Flesh phản công hoặc clash thua*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed và 5 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },


  // ── <:Rupture:1513762812722155682>Rupture (Seven Association) ──
  "dissect target": {
    name: "Dissect Target",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(4,6), d3 = r(5,7);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 3 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "swash": {
    name: "Swash",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(6,9), d3 = r(9,11);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 5 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 6 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "profiling": {
    name: "Profiling",
    cost: "4 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,10), d2 = r(7,11), d3 = r(13,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Rupture:1513762812722155682>Rupture`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },

  // ── Protection (Udjat) ──
  "sand split": {
    name: "Sand Split",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,13), d2 = r(7,9);
      return [
        `<:Dice1:1508173590078558369> *Nếu có ≥4 Protection: nhận 3 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 2 Protection`,
      ];
    },
  },
  "furusiyya": {
    name: "Furūsiyya",
    cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — ngắt 1 đòn đánh thường của địch, nhận 2 Protection`,
      ];
    },
    counterEffect: { protection: 2 },
  },
  "jamadhar": {
    name: "Jamadhar",
    cost: "4 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,9), d2 = r(7,8), d3 = r(5,9), d4 = r(8,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 1 Protection`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 1 Protection`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — nhận 1 Protection; nếu có ≥5 Protection dùng tiếp Dice 4`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Slash:1513768633434640517>Slash] [Guard Break]`,
      ];
    },
  },
  "mirage incision": {
    name: "Mirage Incision",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,4), d2 = r(2,6), d3 = r(2,6), d4 = r(7,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — nhận 1 Protection và gây 1 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Slash:1513768633434640517>Slash] [Guard Break]`,
      ];
    },
  },
  "khopesh swordplay": {
    name: "Khopesh Swordplay",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,15), d2 = r(4,6);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 2 <:Tremor:1513762737388257380>Tremor (nếu có ≥5 Protection: gây 5 <:Tremor:1513762737388257380>Tremor)`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] — nhận Protection = (Tremor+1)÷6 [Max: 3]`,
      ];
    },
  },

  // ── Defense (Zwei) ──
  "blade whirl": {
    name: "Blade Whirl",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "0.5x",
    // [Khuếch tán N mục tiêu] — KHÁC AOE (Fragaria chốt trực tiếp): mục tiêu
    // CHÍNH chịu 100% dmg, các mục tiêu CÒN LẠI chỉ chịu 50%. AOE thì mọi mục
    // tiêu đều 100%. Tag này TRƯỚC ĐÂY chỉ là chữ trong text, không có mã nào
    // đọc → khuếch tán chạy y hệt AOE.
    spreadTargets: 3, spreadFalloffPct: 0.5,
    roll() {
      const d1 = r(4,7), d2 = r(4,8), d3 = r(4,9), d4 = r(9,14);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — gây 5 <:DefenseDown:1513767463337066576>Defense Down; nếu có trên 10 <:DefenseUp:1513767487894716497>Defense Up: nhận 10 Protection`,
      ];
    },
  },
  "client protection": {
    name: "Client Protection",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,8), d3 = r(5,9);
      return [
        `*Nếu có trên 10 <:DefenseUp:1513767487894716497>Defense Up: +3 <:DiceUp:1513767795681398894>Dice Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận 2 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 6 <:DefenseDown:1513767463337066576>Defense Down`,
      ];
    },
  },
  "standoff": {
    name: "Standoff",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,10), d2 = r(4,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — nhận 3 <:DefenseUp:1513767487894716497>Defense Up`,
        `<:Dice2:1508173590078558369> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận 3 <:DefenseUp:1513767487894716497>Defense Up`,
      ];
    },
  },
  "law and order": {
    name: "Law and Order",
    cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,9), d3 = r(8,14);
      return [
        `*Chặn 1 đòn đánh thường của địch — nhận 5 <:DefenseUp:1513767487894716497>Defense Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
      ];
    },
    counterEffect: { defenseUp: 5 },
  },

  // ── <:Tremor:1513762737388257380>Tremor (Augury) ──
  "augury crusher": {
    name: "Augury Crusher",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "0.75x",
    roll() {
      const d1 = r(7,16), d2 = r(7,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE 4 người] — dập chân gây rung chấn, đẩy địch về phía sau`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [AOE 4 người] — vô số cột sát, mỗi lần trúng gây 5 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "augury infusion": {
    name: "Augury Infusion",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(13,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  // (ĐÃ XOÁ bản "augury kick" TRÙNG KEY ở đây — có HAI entry cùng key
  // "augury kick" trong cùng object literal, nên theo luật JS bản khai báo SAU
  // ghi đè hoàn toàn bản này. Bản này là CODE CHẾT: sửa nó không có tác dụng
  // gì. Bản còn sống nằm gần "stob" — đã tự động hoá Dice Up ở đó.)
  // "Singularity" — CATEGORY MỚI (xác nhận trực tiếp): "1 loại equipment riêng
  // biệt chỉ có 1 slot duy nhất, KHÔNG tính slot với accessory/outfit/weapon".
  // "Borrowed Eyes" (Singularity item CỦA Eye Gouger) cho thêm 1 PAGE KHÔNG TỐN
  // SLOT PAGE THƯỜNG, cùng tên "Borrowed Eyes" (giống pattern "Tanglecleaver
  // Reload" — page đặc biệt không tốn slot — xem reactive-defense.js). Ở ĐÂY
  // CHỈ định nghĩa SKILL/PAGE — hệ thống EQUIP Singularity CHO PLAYER (slot
  // riêng, cách sở hữu...) CHƯA XÂY — Eye Gouger (mob) dùng trực tiếp qua
  // quest-data.js's skills[] KHÔNG cần qua cơ chế equip nào cả.
  "borrowed eyes": {
    name: "Borrowed Eyes", tags: "Singularity",
    cost: "0 <:Light:1513786082502770719>Light", cd: "6 Turn", diceMul: "1x",
    // Dice CHỈ để đếm charge né, KHÔNG gây dmg — khai rõ để AI không dùng đi clash
    // và mọi nơi khác nhận diện đúng bản chất utility.
    noDirectDamage: true,
    // Fragaria: "chặn cho Borrowed Eyes không bị ảnh hưởng bởi Dice Up,
    // Singularity rất mạnh nên việc có Dice Up ảnh hưởng tăng thêm charge Evade
    // sẽ mất cân bằng game." Dice của page này KHÔNG phải sát thương — nó LÀ số
    // charge né, nên mọi buff dice phải trượt qua nó. Đọc ở skill-verification.js.
    ignoreDiceModifier: true,
    // Fragaria: "Thêm tag unclashable cho pounce, follow-up, light dash,
    // fleetfoot steps và borrowed eyes" — `unclashable` là CỜ DỮ LIỆU (bộ chọn
    // Clash của người chơi LẪN AI đều lọc theo nó), còn tag [Unclashable] viết
    // trong dòng roll() là phần NGƯỜI CHƠI ĐỌC + để parser phòng thủ bắt được.
    unclashable: true,
    roll() {
      const d1 = r(5, 10);
      return [
        // Dice này KHÔNG GÂY DMG — chỉ dùng để quyết định SỐ CHARGE NÉ.
        // Xử lý thật ở resolve-pending-action.js (`p.skillKey === "borrowed eyes"`):
        // zero toàn bộ dmg rồi cộng đúng d1 charge né.
        `<:Dice1:1508173590078558369> **${d1}** [Unclashable] — Dice này KHÔNG gây dmg. Nhận buff **Borrowed Eye**: tự động nhận **${d1}** charge né cho các đòn kế tiếp [Không né được Undodgeable]`,
      ];
    },
  },
  "celestial sight": {
    name: "Celestial Sight",
    // ❗ Fragaria 12/08: "Celestial Sight là page counter nên CD 4 Turn mới đúng
    // (ngoại trừ Tanglecleaver Reload là 1 Turn)", và "có người bảo xài nó trong
    // encounter bot nhưng KHÔNG HIỆN RA" — vì thiếu `counterEffect`, panel Moves
    // và bộ chọn page-counter đều không nhận ra nó là counter.
    counterEffect: {},
    cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — né 1 đòn thường của địch, phản công gây 6 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },

  // ── <:Tremor:1513762737388257380>Tremor (L'Heure du Loup) ──
  "lupine onslaught": {
    name: "Lupine Onslaught",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(3,6), d3 = r(4,7), d4 = r(4,8);
      return [
        `*Nếu địch có trên 5 <:Tremor:1513762737388257380>Tremor: **[Airborne]***`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [On Hit] — gây 1 <:Paralyze:1513763316479295548>Paralyze`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [On Hit] — gây 1 <:Paralyze:1513763316479295548>Paralyze`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [On Hit] — gây 1 <:Paralyze:1513763316479295548>Paralyze`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [On Hit] — gây 1 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },
  "kick and stomps": {
    name: "Kick And Stomps",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,10), d2 = r(6,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Paralyze:1513763316479295548>Paralyze`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 2 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "rapacious assault": {
    name: "Rapacious Assault",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,9), d2 = r(10,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Paralyze:1513763316479295548>Paralyze và 3 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Airborne] — gây 1 <:Paralyze:1513763316479295548>Paralyze và 3 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "pitch-black pulverizer": {
    name: "Pitch-Black Pulverizer",
    cost: "5 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,27);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] — lao vào địch, gây 5 <:Tremor:1513762737388257380>Tremor`,
        `→ Sau đó gây <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },

  // ── <:Bleed:1513762688226955285>Bleed (Kurokumo) ──
  "cloud cutter": {
    name: "Cloud Cutter",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    // BUG ĐÃ SỬA (Fragaria: "phần reuse chưa hoạt động").
    // TRƯỚC ĐÂY dòng "Reuse 1 lần nếu có trên 2 Light" chỉ là CHỮ — roll() không
    // hề nhận Light nên KHÔNG BAO GIỜ reuse, dmgStr luôn đúng 2 dice.
    // Reuse phải cộng DICE nên bắt buộc phải biết Light NGAY LÚC ROLL (khác các
    // hiệu ứng hậu-kỳ như Tremor Burst — cái đó xử lý sau khi đã đánh được).
    // Fragaria chọn HƯỚNG 1 (bot tự quyết, không hỏi) → đọc thẳng Light của
    // combatant qua rollArgs ở skill-verification.js. `light = 0` mặc định để
    // lệnh `-skill cloud cutter` đứng riêng vẫn chạy như cũ (không reuse).
    roll(light = 0) {
      const line = (emoji, v) =>
        `${emoji} **${v}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`;
      const lines = [line("<:Dice1:1508173590078558369>", r(1,5)), line("<:Dice2:1508173623691710625>", r(1,5))];
      if (light > 2) {
        lines.push(`↩️ **Reuse 1** *(có ${light} <:Light:1513786082502770719>Light > 2)*`);
        lines.push(line("<:Dice1:1508173590078558369>", r(1,5)));
        lines.push(line("<:Dice2:1508173623691710625>", r(1,5)));
      } else {
        lines.push(`*Không Reuse — cần TRÊN 2 <:Light:1513786082502770719>Light (đang có ${light})*`);
      }
      return lines;
    },
  },
  "sky clearing cut": {
    name: "Sky Clearing Cut",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(5,9), d3 = r(6,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed; nếu địch có trên 10 <:Bleed:1513762688226955285>Bleed: dmg ×1.3`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed; nếu địch có trên 10 <:Bleed:1513762688226955285>Bleed: dmg ×1.3`,
      ];
    },
  },
  "dark cloud cleaver": {
    name: "Dark Cloud Cleaver",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(7,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 4 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "sober up": {
    name: "Sober Up",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,7);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 6 <:Bleed:1513762688226955285>Bleed turn kế`,
      ];
    },
  },
  "shadowcloud kick": {
    name: "Shadowcloud Kick",
    cost: "1 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(6,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed; nếu địch có trên 7 <:Bleed:1513762688226955285>Bleed: nhận 3 <:DiceUp:1513767795681398894>Dice Up`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash]; nếu địch có trên 7 <:Bleed:1513762688226955285>Bleed: địch nhận 2 <:DiceDown:1513767826257874964>Dice Down`,
      ];
    },
  },
  "silent mist": {
    name: "Silent Mist",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 4 <:Bleed:1513762688226955285>Bleed và nhận 3 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },

  // ── Rupture/Nails (Smiling Faces) ──
  "somber procuration": {
    name: "Somber Procuration",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(4,6), d3 = r(2,4);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — đạp địch ra xa, gây 5 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "trash disposal": {
    name: "Trash Disposal",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const MAX_REUSE = 6;
      const DICE_EMOJIS = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,`<:Dice3:1508173643518050395>`,
        `<:Dice4:1508176464367845600>`,`<:Dice5:1508176500438990968>`,
        `<:Dice5:1508176500438990968>`,`<:Dice5:1508176500438990968>`,
      ];
      const lines = [];
      let stopped = false;
      for (let i = 0; i <= MAX_REUSE; i++) {
        const val = r(4,6);
        const isMin = val === 4;
        const dEmoji = DICE_EMOJIS[i] ?? DICE_EMOJIS[DICE_EMOJIS.length - 1];
        const label = i === 0 ? "" : ` ↩️ Reuse ${i}`;
        if (i === 0) {
          lines.push(`${dEmoji}${label} **${val}** [<:Slash:1513768633434640517>Slash] — đâm vào địch, gắn 5 <:Fragile:1513763336167100536>Fragile${isMin ? " *(Min — dừng)*" : ""}`);
        } else {
          lines.push(`${dEmoji}${label} **${val}** [<:Slash:1513768633434640517>Slash] — đâm, hồi 3 HP${isMin ? " *(Min — dừng)*" : i === MAX_REUSE ? " *(hết Reuse)*" : ""}`);
        }
        if (isMin) { stopped = true; break; }
      }
      return lines;
    },
  },
  "cackle": {
    name: "Cackle",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(8,14);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Nails:1513768423124111482>Nails`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 3 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },

  // ── Index ──
  "unlock": {
    name: "Unlock",
    cost: "0 <:Light:1513786082502770719>Light", cd: "0 Turn", diceMul: "1x",
    // ⚠️ ĐÍNH CHÍNH (Fragaria): "Unlock là page riêng của **The Index Syndicate**
    // chứ KHÔNG PHẢI Blade Lineage. Gate rất sai nặng." Lượt trước tôi tự suy từ
    // việc nó nằm cạnh Yield My Flesh trong file — SAI. Không được đoán faction
    // của page theo vị trí trong file; phải hỏi.
    requiresFaction: "The Index Syndicate",
    // BUG ĐÃ SỬA (Fragaria báo trực tiếp: "unlock và castigation hoạt động không
    // đúng"). TRƯỚC ĐÂY stage được chọn NGẪU NHIÊN (`Math.random()*3+1`) — hoàn
    // toàn trái mô tả của chính page: Unlock-2 ghi rõ "(cần Unlock Blade - 1)",
    // Unlock-3 ghi "(cần Unlock Blade - 2)". Nghĩa là đây là chuỗi TÍCH LUỸ
    // 1→2→3, không phải xổ số: dùng lần đầu phải ra Unlock-1, và có thể nhảy
    // thẳng ra Unlock-3 ngay lần dùng đầu tiên (sai hoàn toàn về sức mạnh).
    // Giờ stage do CALLER truyền vào từ state thật trên combatant
    // (`unlockBladeStage`, xem skill-verification.js + resolve-pending-action.js).
    // Mặc định 1 để `-skill unlock` xem trước ngoài encounter vẫn chạy được.
    roll(stage = 1) {
      stage = Math.min(3, Math.max(1, parseInt(stage, 10) || 1));
      if (stage === 1) {
        const d1 = r(2,4);
        return [
          `**<:Unlock:1528452595859849406>Unlock - 1** *(không có Unlock Blade)*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — trúng: nhận **Unlock Blade - 1**`,
        ];
      } else if (stage === 2) {
        const d1 = r(3,6), d2 = r(3,6);
        return [
          `**<:Unlock:1528452595859849406>Unlock - 2** *(cần Unlock Blade - 1)*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận **Unlock Blade - 2**`,
        ];
      } else {
        const d1 = r(6,11), d2 = r(6,11);
        return [
          `**<:Unlock:1528452595859849406>Unlock - 3** *(cần Unlock Blade - 2)*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận **Unlocked Blade**`,
        ];
      }
    },
  },

  // ── Misc ──
  "blade flourish": {
    name: "Blade Flourish",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(5,8), d3 = r(6,9);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — nhận 3 <:DiceUp:1513767795681398894>Dice Up đến hết turn này`,
      ];
    },
    diceEffects: [null, null, { diceUp: 3 }],
  },

  // ── EGO Pages (TETH) ──
  "beak": {
    name: "Beak",
    tags: "Ego Pages <:TETH:1449759432119419070>",
    cost: "4 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,14), d2 = r(7,10);
      return [
        `*Trừ 2 <:Light:1513786082502770719>Light và 20 Sanity để sử dụng cho pages kế tiếp*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce]`,
      ];
    },
  },
  "punishing beak": {
    name: "Punishing Beak",
    tags: "Corrosion Pages <:TETH:1449759432119419070>",
    cost: "6 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15,20);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 6 <:Bleed:1513762688226955285>Bleed và hồi 10 Stamina`,
      ];
    },
  },

  // ── EGO Pages (HE) ──
  "lamp": {
    name: "Lamp",
    tags: "Ego Pages <:HE:1449759447152070796>",
    cost: "3 <:Light:1513786082502770719>Light & 5 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE] — khiến toàn bộ pages kẻ địch sắp dùng bị trừ 3 Dice và giảm 1 nửa buff địch vào turn sau`,
      ];
    },
  },
  "eyes lamp": {
    name: "Eyes Lamp",
    tags: "Corrosion Pages <:HE:1449759447152070796>",
    cost: "8 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,15);
      return [
        `*[AOE] — Phải là page cuối cùng được dùng cuối turn để kích hoạt*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — giải trừ toàn bộ pages của toàn bộ nhưng không hoàn trả thứ gì`,
      ];
    },
  },

  // ── EGO Pages (WAW) ──
  "justitia": {
    name: "Justitia",
    tags: "Ego Pages <:WAW:1449759461001527518>",
    cost: "3 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15,25);
      return [
        `*[After Use] Sau khi dùng: tăng 1 <:Light:1513786082502770719>Light, lần tiếp theo +5% HP damage*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — chém gây thêm 5% Max HP địch (Giới hạn 100 Dmg hoặc 150 khi dùng cùng Justitia)`,
      ];
    },
  },
  "the justice scale": {
    name: "The Justice Scale",
    tags: "Corrosion Pages <:WAW:1449759461001527518>",
    cost: "6 <:Light:1513786082502770719>Light & 25 <:Sanity:1538272293132963930>Sanity", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,50);
      return [
        `*[Clash] Nếu địch clash: địch bị trừ 5 Dice*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — chém gây 7% Max HP địch (Giới hạn 150 Dmg hoặc 200 khi dùng cùng Justitia); Heal = 15% dmg gây ra`,
      ];
    },
  },

  // ── EGO Pages (ALEPH) ──
  "twillight": {
    name: "Twillight",
    tags: "Ego Pages <:ALEPH:1449759474268242021>",
    cost: "5 <:Light:1513786082502770719>Light & 25 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      return [
        `<:Dice1:1508173590078558369> Giảm 0.2 Res cho toàn bộ trong 3 turn. Khi chết sẽ kích hoạt Apocalypse với sát thương Blunt`,
        `*[Sau khi dùng] Biến thành Apocalypse ở lần dùng kế tiếp*`,
      ];
    },
  },
"apocalypse": {
    name: "Apocalypse",
    cost: "5 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "—", diceMul: "1.5x",
promptArg: {
  label: "Dưới 50% HP?",
  parse: (s) => {
    const v = s.toLowerCase().trim();
    if (v === "yes" || v === "y" || v === "1" || v === "true") return "yes";
    return "no"; // mặc định no khi không nhập hoặc nhập sai
  },
  validate: (v) => true,
  errorMsg: "", // không dùng nữa vì luôn pass
  buildHeader: (v, s) => `[${s.cost}] [CD: ${s.cd}] [Dice Mul: ${s.diceMul}]${v === "yes" ? " *(Dưới 50% HP: Dice x2)*" : ""}`,
},
roll(v = "no") {
  const lowHp = v === "yes";
  const d1 = r(25,35);
  return [
    `*[Before Use] Nếu bản thân dưới 50% HP: nhân đôi Dice*`,
    `*[Before Use] Nếu chết trước khi kích hoạt: kích hoạt lại 1 đòn không có hiệu ứng sát thương chuẩn*`,
    `<:Dice1:1508173590078558369> **${lowHp ? d1*2 : d1}** [<:Blunt:1513768529718022254>Blunt] [True Damage]${lowHp ? " *(Dưới 50% HP: Dice x2)*" : ""} — nếu địch dưới 50% gây thêm 50% damage`,
  ];
},
},

  // ── Book of The Keter ──
  // ── Book of Gebura (nằm trong sub-menu của Book of Library) ──────────────
  // ── Book of The Birds ────────────────────────────────────────────────────
  // ── CLASS CARD: ARCHER (Fragaria 14/08) ──────────────────────────────────
  // ⚠️ Fragaria chốt: **CHƯA làm vũ khí** "Class Card: Archer". Bốn Critical dưới
  // đây là để GM/người chơi chạy kiểu NARRATIVE trước — mô tả đúng luật, chưa nối
  // vào máy hiệu ứng (Projection / Holy Shield / chuỗi liên tiếp…).
  // Đừng tưởng chúng là dead code rồi đi xoá.
  "quick swap": {
    name: "Quick Swap", weaponOf: "Class Card: Archer", tags: "Weapon",
    cost: "", cd: "1 Turn", diceMul: "1x",
    roll() {
      return [
        `*Type: None — KHÔNG có Dice, đây là hiệu ứng thuần tuý.*`,
        `Chuyển **Class Card: Archer** sang 1 vũ khí khác trong Passive **Projection**`,
        `*(Kanshou & Bakuya — Medium/<:Slash:1513768633434640517>Slash/12 · Archer's Bow — Light/<:Pierce:1513768511179329556>Pierce/5 · Rho Aias — Heavy/<:Blunt:1513768529718022254>Blunt/0)*`,
        `Một turn dùng tối đa **2 lần** trước khi vào CD.`,
      ];
    },
  },
  "kanshou & bakuya overedge": {
    name: "Kanshou & Bakuya Overedge", weaponOf: "Class Card: Archer", tags: "Weapon",
    cost: "", cd: "4 Turn", diceMul: "1x",
    roll() {
      return [
        `*Chỉ kích hoạt được khi đang dùng **Kanshou & Bakuya** làm vũ khí chính.*`,
        `Người dùng nhận 2 <:Fix_Haste:1513768004222062632>Haste`,
        `Rồi nhận 3 <:DiceUp:1513767795681398894>Dice Up và 3 Attack Power Up **đến hết turn sau**`,
        `*Effect hết NGAY LẬP TỨC nếu dùng **Quick Swap** đổi sang vũ khí khác.*`,
      ];
    },
  },
  "fake spiral spear - caladbolg ii": {
    name: "Fake Spiral Spear - Caladbolg II", weaponOf: "Class Card: Archer", tags: "Weapon",
    cost: `2 <:Light:1513786082502770719>Light`, cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10), d2 = r(15,25);
      return [
        `*Chỉ kích hoạt được khi đang dùng **Archer's Bow** làm vũ khí chính.*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — bắn một mũi tên xoáy vào 1 đối thủ`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [AOE] [Unblockable] [Undodgeable] — rồi gây ra một vụ nổ`,
        `Rồi nhận 5 <:DiceUp:1513767795681398894>Dice Up`,
        `*Có thể kích hoạt lại, tối đa **5 lần**, nhưng phải LIÊN TIẾP nhau.*`,
        `*Sau khi kết thúc chuỗi, MỌI <:DiceUp:1513767795681398894>Dice Up nhận từ Critical này sẽ biến mất.*`,
      ];
    },
  },
  "the seven rings that cover the burning heavens": {
    name: "The Seven Rings that Cover the Burning Heavens",
    weaponOf: "Class Card: Archer", tags: "Weapon",
    cost: "", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(20,50);
      return [
        `*Chỉ kích hoạt được khi đang dùng **Rho Aias** làm vũ khí chính.*`,
        `<:Dice1:1508173590078558369> **${d1}%** — Party nhận **Holy Shield** bằng **${d1}%** tổng Max HP của cả party`,
        `*Holy Shield là Shield HP dùng CHUNG toàn đội (mọi Dmg nhận vào tính Res 1.0x).*`,
        `*Mỗi 100 Holy Shield mất trong 1 turn gây 20 True Dmg lên chính người dùng.*`,
        `*Không vượt quá 100% Max HP toàn đội. Mất sạch khi Rho Aias không còn là vũ khí đang dùng.*`,
      ];
    },
  },

  "scales of judgement": {
    name: "Scales of Judgement", bookOf: "Book of The Birds",
    cost: `3 <:Light:1513786082502770719>Light`, cd: "5 Turn", diceMul: "1x",
    roll() {
      // ⚠️ `rRaw` chứ KHÔNG phải `r`: Fragaria xác nhận dice này miễn nhiễm MỌI
      // tác động lên dice (Dice Up, Max Dice…) VÀ cả Sanity bias.
      const d1 = rRaw(0, 100);
      const under = d1 < 50;
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Undodgeable] [AOE] *(dice này KHÔNG chịu bất kỳ tác động nào — Dice Up, Max Dice, Sanity…)*`,
        under
          ? `→ Roll **dưới 50** ⇒ **HỒI MÁU cho kẻ thù** bằng đúng lượng dice roll ra: **${d1}** HP`
          : `→ Roll **từ 50 trở lên** ⇒ gây cho kẻ thù **50 True Dmg**`,
      ];
    },
  },
  // Critical của Beak — hệ đạn dùng CHUNG với ammo sẵn có của repo.
  "shot": {
    name: "Shot", weaponOf: "Beak", tags: "Weapon",
    cost: `[Tiêu hao 3 viên đạn — nếu chưa nạp thì tự động nạp 10 viên]`, cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,4), d2 = r(5,6), d3 = r(3,6);
      return [
        `<:Dice1:1508173590078558369> **${d1 + 5}** [<:Pierce:1513768511179329556>Pierce] — bắn kẻ thù, Dmg = số Dice (${d1}) **+5**`,
        `<:Dice2:1508173623691710625> **${d2 + 5}** [<:Pierce:1513768511179329556>Pierce] — bắn kẻ thù, Dmg = số Dice (${d2}) **+5**`,
        `<:Dice3:1508173643518050395> **${d3 + 5}** [<:Pierce:1513768511179329556>Pierce] — bắn kẻ thù, Dmg = số Dice (${d3}) **+5**`,
      ];
    },
  },
  "tilted scale": {
    name: "Tilted Scale", weaponOf: "Justitia", tags: "Weapon",
    cost: "", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(21,41);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Undodgeable] — Treo cổ kẻ thù, **huỷ toàn bộ dice** đối thủ dùng trong turn này`,
        `*Nếu đối thủ đang bị Stagger: gây thêm **50% Dmg**.*`,
      ];
    },
  },
  "allure": {
    name: "Allure", weaponOf: "Lamp", tags: "Weapon",
    cost: "", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(29,37);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Tấn công 3 mục tiêu] [Unblockable] [Undodgeable] — tạo vùng sáng gây 6 <:Fix_Burn:1513762753691652177>Burn`,
        `*Thu hút tất cả kẻ thù dính phải trong turn sau.*`,
      ];
    },
  },

  "shell": {
    name: "Shell", bookOf: "Book of Gebura",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:Fix_ALEPH:1449759474268242021>",
    // ⚠️ CD LÀ CHUỖI FONT LỖI **CỐ Ý** (Fragaria xác nhận 14/08): page dùng ĐÚNG
    // MỘT LẦN, hiệu lực kéo dài hết encounter, và sau đó KHÔNG dùng lại được.
    // Chuỗi này không parse ra số turn nào nên `parseSkillCooldownTurns` trả 0 —
    // phần "không dùng lại được" do luật 1-lần/encounter đảm nhiệm, không phải CD.
    cost: `85 <:Sanity:1538272293132963930>Sanity`, cd: "I-lôVÉ-ỹÒu", diceMul: "1x",
    oncePerEncounter: true,
    roll() {
      return [
        `*Type: None — KHÔNG có Dice, đây là hiệu ứng thuần tuý.*`,
        `Khi sử dụng, bản thân **KHÔNG THỂ bị trừ Stamina** bởi bất kỳ tác động nào từ bên ngoài *[kéo dài đến hết encounter]*`,
        `*[VD: <:Tremor:1513762737388257380>Tremor, skill trừ trực tiếp Stamina]*`,
        `*[Dùng 1 lần mỗi encounter — sau đó page không dùng lại được]*`,
      ];
    },
  },
  "prey": {
    name: "Prey", bookOf: "Book of Gebura",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:Fix_WAW:1449759461001527518>",
    cost: `3 <:Light:1513786082502770719>Light & 40 <:Sanity:1538272293132963930>Sanity`, cd: "??? Turn", diceMul: "1x",
    oncePerEncounter: true,
    roll() {
      return [
        `*Type: None — KHÔNG có Dice, đây là hiệu ứng thuần tuý.*`,
        `Chọn một kẻ thù để **đánh dấu**. Khi tấn công kẻ thù đó, sát thương gây ra bằng **sát thương gốc + 6**`,
        `Nếu là M1: mỗi 1 Stamina mà M1 tiêu thụ sẽ **+0,3 Dmg**`,
        `*[Dấu ấn kéo dài cho đến khi kẻ địch chết]* *[1 lần mỗi encounter]*`,
      ];
    },
  },

  // ── Dawn Book ────────────────────────────────────────────────────────────
  // ── BOOK OF M.A.D — Critical (Fragaria 14/08) ────────────────────────────
  "inferno abyss": {
    name: "Inferno Abyss", weaponOf: "Magician SWorld of M.A.D", tags: "Weapon",
    cost: "", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(5,7), d3 = r(7,10);
      return [
        `*Tung 3 đòn liên tiếp.*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] [AOE] [Undodgeable] — gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `*Đánh trúng CẢ 3 đòn ⇒ gây thêm 5 <:Fix_Burn:1513762753691652177>Burn cho đối phương.*`,
      ];
    },
  },
  "not learning?": {
    name: "Not Learning?", weaponOf: "Mythical SWorld of M.A.D", tags: "Weapon",
    cost: "", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,20);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] — ngay lập tức bổ xuống`,
        `*Nếu đối phương ĐANG có <:Bleed:1513762688226955285>Bleed: ngay lập tức nhận **<:Hemorrhage:1513762688226955285>Hemorrhage** và áp thêm 5 <:Bleed:1513762688226955285>Bleed nữa.*`,
      ];
    },
  },
  "measured execution": {
    name: "Measured Execution", weaponOf: "Nebula-Stitched Grips", tags: "Weapon",
    cost: "", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,6), d2 = r(5,6), d3 = r(8,12);
      return [
        `*Tung 3 đòn liên tiếp.*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce]`,
        `*Đánh trúng CẢ 3 đòn ⇒ gây 5 <:Bleed:1513762688226955285>Bleed cho đối phương.*`,
      ];
    },
  },
  "good bye~": {
    name: "Good bye~", weaponOf: "Wonder Gun of M.A.D", tags: "Weapon",
    cost: "", cd: "3 Turn *(tính SAU khi hết thời gian hiệu lực)*", diceMul: "1x",
    roll() {
      return [
        `*Type: None — KHÔNG có Dice, đây là hiệu ứng thuần tuý.* [Undodgeable] [Unguardable]`,
        `Gắn 1 **Daydream** lên đối phương: mỗi hành động của họ **-2 Stamina**, kéo dài **3 Turn**`,
        `*Nếu đối phương có TRÊN 10 <:Tremor:1513762737388257380>Tremor: nâng thành **-5 Stamina** và kéo dài **5 Turn**.*`,
      ];
    },
  },
  "riding the wave": {
    name: "Riding the Wave", weaponOf: "Anchorly Tale of M.A.D", tags: "Weapon",
    cost: "", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,13), d2 = r(12,19);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — nhảy lên né 2 đòn *(trừ [Undodgeable])*, nhận 1 <:DefenseUp:1513767487894716497>Def Up`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — nhận 2 <:DefenseUp:1513767487894716497>Def Up`,
        `*Hồi lại **5% máu** tích trong **Bless of Deep Sea** mỗi đòn TRÚNG.*`,
        `*Nếu CHƯA có **Bless of Deep Sea** ⇒ nhận **Bless of Deep Sea**.*`,
      ];
    },
  },
  // ── BOOK OF M.A.D — Page ─────────────────────────────────────────────────
  "got your back": {
    name: "Got Your Back", bookOf: "Book of M.A.D.", tags: "Bleed",
    cost: `4 <:Light:1513786082502770719>Light`, cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `*Tung 1 nhát chém thẳng xuống.*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — *[On Hit]* gây 3 <:Bleed:1513762688226955285>Bleed + 1 <:Hemorrhage:1513762688226955285>Hemorrhage`,
        `*Có thể LẶP LẠI đòn này với 1 <:Light:1513786082502770719>Light mỗi lần; sát thương LUÔN là **6** ở những lần lặp.*`,
        `*[On Hit] mỗi lần lặp gây 2 <:Bleed:1513762688226955285>Bleed.*`,
      ];
    },
  },
  "the sea i belong to": {
    name: "The Sea I Belong To", bookOf: "Book of M.A.D.",
    cost: `2 <:Light:1513786082502770719>Light`, cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,9), d2 = r(6,10);
      return [
        `*Húc vào tường rồi kéo kẻ địch lại.*`,
        `*Nếu CHƯA có **Bless of Deep Sea** ⇒ nhận **Bless of Deep Sea** ở turn sau.*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — *[On Hit]* hồi 2% HP trong **Bless of Deep Sea**`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] *(Undodgeable NẾU trúng hit trước)* — *[On Hit]* hồi 3% HP trong **Bless of Deep Sea**`,
      ];
    },
  },

  "butterfly slash": {
    name: "Butterfly Slash", bookOf: "Dawn Book", tags: "Burn, Tremor, Slash",
    cost: `2 <:Light:1513786082502770719>Light`, cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(4,9), d3 = r(5,9);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Fix_Burn:1513762753691652177>Burn và 2 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "sunset blade": {
    name: "Sunset Blade", bookOf: "Dawn Book", tags: "Burn, Tremor",
    cost: `3 <:Light:1513786082502770719>Light`, cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,9), d2 = r(9,12), d3 = r(12,15);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Tremor:1513762737388257380>Tremor và 1 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },

  "crack of dawn": {
    name: "Crack of Dawn", bookOf: "Dawn Book", tags: "Burn, Tremor, Protection",
    cost: `4 <:Light:1513786082502770719>Light`, cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,16), d2 = r(1,5);
      return [
        `*[Before Use]* Khi xài, cho **hai đồng minh** của bản thân 2 <:Protection:1528452299834261545>Protection vào turn sau`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 5 <:Fix_Burn:1513762753691652177>Burn và 2 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — sau khi Clash THUA, cho bản thân Shield = Dice × 5`,
      ];
    },
  },
  "flash of sunup": {
    name: "Flash of Sunup", bookOf: "Dawn Book", tags: "Burn, Light",
    cost: `1 <:Light:1513786082502770719>Light`, cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,9), d2 = r(7,9);
      return [
        `*[On Use]* Hồi cho bản thân 2 <:Light:1513786082502770719>Light`,
        `*[Clash Win]* Hồi cho bản thân 2 <:Light:1513786082502770719>Light`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Fix_Burn:1513762753691652177>Burn và 1 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Fix_Burn:1513762753691652177>Burn và 2 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },

  "fervent beats": {
    name: "Fervent Beats",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "0 <:Light:1513786082502770719>Light", cd: "??? Turn", diceMul: "1x",
    roll() {
      return [
        `*Type: ??? — KHÔNG có Dice, đây là hiệu ứng thuần tuý.*`,
        `☠️ **Khi sử dụng, người dùng CHẮC CHẮN CHẾT sau 3 Turn** — không bị ảnh hưởng bởi bất kỳ lý do gì khác, kể cả vật phẩm bất tử.`,
        `Đổi lại: nhận NGAY 10 Dice Up, 10 Defense Up, 10 Protection, 10 Haste — tồn tại cho tới lúc bản thân chết.`,
      ];
    },
  },

  // ── Book of The Hod ──
  "look of the day": {
    name: "Look of the Day",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "4 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn [từ lúc hết buff]", diceMul: "1x",
    roll() {
      return [
        `*Type: ??? — KHÔNG có Dice, đây là hiệu ứng thuần tuý.*`,
        `Trong 3 turn kế tiếp: TẤT CẢ skill của bản thân được +2 Max Dice và -2 Min Dice.`,
      ];
    },
  },

  // ── Book of The Netzach ──
  "echoes from the beyond": {
    name: "Echoes from the Beyond",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "2 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10, 20);
      return [
        `*Type: ??? — KHÔNG có Dice sát thương, đây là hiệu ứng thuần tuý.*`,
        `<:Dice1:1508173590078558369> **${d1}** Stamina — TẤT CẢ đồng minh nhận lại số Stamina này. TẤT CẢ kẻ thù bị trừ số Stamina bằng số đồng minh đã hồi.`,
      ];
    },
  },
  "the finale": {
    name: "The Finale",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ALEPH:1449759474268242021>",
    cost: "3 <:Light:1513786082502770719>Light & 50 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      return [
        `*Type: ??? — KHÔNG có Dice, đây là hiệu ứng thuần tuý.*`,
        `Kích hoạt: nhận 1 stack **Orchestra**.`,
        `Khi có **Orchestra** VÀ gây Stagger được bất kỳ 1 kẻ địch nào: TẤT CẢ kẻ địch bị trừ [1~6] Light, mất stack **Orchestra**.`,
        `*CD chỉ bắt đầu tính TỪ LÚC mất stack Orchestra (không phải từ lúc kích hoạt).*`,
      ];
    },
  },

  // ── Book of The Yesod ──
  "violence": {
    name: "Violence",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "3 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn [từ lúc hết buff]", diceMul: "1x",
    roll() {
      return [
        `*Type: ??? — KHÔNG có Dice, đây là hiệu ứng thuần tuý.*`,
        `Trong 3 turn kế tiếp: TẤT CẢ skill của bản thân có Min Dice LUÔN LÀ 1, Max Dice +4.`,
      ];
    },
  },

  // ── Book of The Malkuth ──
  "display of affection": {
    name: "Display of Affection",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "5 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn [từ lúc hết buff]", diceMul: "1x",
    roll() {
      return [
        `*Type: ??? — KHÔNG có Dice, đây là hiệu ứng thuần tuý.*`,
        `Nhận 4 Dice Up trong 3 turn.`,
      ];
    },
  },

  // ── Book of The Chesed ──
  "torn off wisdom": {
    name: "Torn Off Wisdom",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(1, 4);
      return [
        `Type: None`,
        `<:Dice1:1508173590078558369> **${d1}** — hồi Light cho turn sau tương ứng với số dice gieo ra (KHÔNG bị ảnh hưởng bởi Dice Up).`,
      ];
    },
  },
  "harvest": {
    name: "Harvest",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15, 25);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — +2 Dice Up cho MỖI đồng minh còn sống trên sân.`,
      ];
    },
  },
  "logging": {
    name: "Logging",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "5 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7, 11), d2 = r(6, 10), d3 = r(6, 9), d4 = 6;
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — nếu Clash THẮNG với Dice này, Dice cuối nhận +10 Dice Up.`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Unblockable]`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 10 Bleed vào turn kế.`,
      ];
    },
  },
  "the homing instinct": {
    name: "The Homing Instinct",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "5 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8, 18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE] [Undodgeable] — nếu TRÚNG: hồi 2 Light cho TOÀN BỘ đồng minh trong turn.`,
      ];
    },
  },
  "faded memories": {
    name: "Faded Memories",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "5 <:Light:1513786082502770719>Light & 30 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5, 10), d2 = r(5, 9);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE] [Undodgeable] — nếu TRÚNG: hồi 20 Stamina cho TOÀN BỘ đồng minh.`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [AOE] [Undodgeable] — nếu TRÚNG: hồi 20 Stamina cho TOÀN BỘ đồng minh.`,
      ];
    },
  },
  "false throne": {
    name: "False Throne",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ALEPH:1449759474268242021>",
    cost: "7 <:Light:1513786082502770719>Light & 40 <:Sanity:1538272293132963930>Sanity", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6, 10), d2 = r(5, 9);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE] [Undodgeable] [Unblockable]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [AOE] [Undodgeable] [Unblockable] — sau khi dùng: hồi sinh TOÀN BỘ đồng minh đã chết trong trận này trong 1 Turn (4 Light, mọi Buff trừ Emotion Level bị reset).`,
      ];
    },
  },

  // ── Sinking (Fused Blade) ──
  "greatsword rend": {
    name: "Greatsword Rend",
    tags: "Sinking",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 5 <:Sinking:1513762793436741652>Sinking. Nếu đang dùng **Fused Blade of Ruined Mirror Worlds**: nhận 1 **Coffin**`,
      ];
    },
  },
  "beheading": {
    name: "Beheading",
    tags: "Sinking",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    needsReuse: false,
    hasDullahanRoll: true,
    roll(forceDullahan) {
      const hasDullahan = forceDullahan !== undefined ? forceDullahan : Math.random() < 0.5;
      if (hasDullahan) {
        const d1 = r(8,13), d2 = r(13,16);
        return [
          `*[Dullahan active]*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 1 <:Sinking:1513762793436741652>Sinking. Nếu đang dùng Fused Blade: nhận 3 **Coffin**`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Sinking:1513762793436741652>Sinking`,
        ];
      }
      const d1 = r(3,6), d2 = r(4,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Sinking:1513762793436741652>Sinking. Nếu đang dùng Fused Blade: nhận 1 **Coffin**`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "smackdown": {
    name: "Smackdown",
    tags: "Sinking",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,4), d2 = r(4,6), d3 = r(8,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Sinking:1513762793436741652>Sinking. Nếu đang dùng Fused Blade: nhận 1 **Coffin**`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây Bleed = (số Sinking trên địch ÷ 2) ở turn kế`,
      ];
    },
  },
  "memorial procession": {
    name: "Memorial Procession",
    tags: "Sinking",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    hasDullahanRoll: true,
    roll(forceDullahan) {
      const hasDullahan = forceDullahan !== undefined ? forceDullahan : Math.random() < 0.5;
      if (hasDullahan) {
        const d1 = r(5,10), d2 = r(10,20), d3 = r(14,20);
        return [
          `*[Dullahan active]*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [AOE] — Nếu đang dùng Fused Blade: nhận 3 **Coffin**`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [AOE]`,
          `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] [AOE] — gây 8 <:Sinking:1513762793436741652>Sinking`,
        ];
      }
      const d1 = r(4,8), d2 = r(5,9), d3 = r(11,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — Nếu đang dùng Fused Blade: nhận 1 **Coffin**`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] [AOE] — gây 8 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },

  // ── Smoke skills ──
  "inhale": {
    name: "Inhale",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** — nhận ${d1} <:Smoke:1513778039610282015>Smoke (1 mỗi Dice); nhận thêm 1 <:Paralyze:1513763316479295548>Paralyze sau khi dùng`,
      ];
    },
  },
  "exhale smoke": {
    name: "Exhale Smoke",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 4 <:Smoke:1513778039610282015>Smoke lên địch; với mỗi <:Smoke:1513778039610282015>Smoke trên địch Dice +1`,
      ];
    },
  },
  "loss of senses": {
    name: "Loss of Senses",
    cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,11);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Counter] [Undodgeable] — né 1 đòn đánh thường; phản công gây 2 lần sát thương, mỗi lần gây 2 <:Smoke:1513778039610282015>Smoke; rồi gây 1 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
    counterEffect: { customHitMultiplier: 2, smokePerHit: 2, paralyzeAfter: 1 },
  },

  // ── Misc combat skills non status ──
  "y-you only live once": {
    name: "Y-you Only Live Once",
    cost: "1 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(1,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [Fixed Dmg] [Guard Break] [AOE 5 mục tiêu] — đánh văng toàn bộ địch, gây dmg và áp 2 <:Paralyze:1513763316479295548>Paralyze cho turn sau`,
      ];
    },
  },
  "crush": {
    name: "Crush",
    tags: "Tremor",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(3,6);
      return [
        `*Dặm đất, gây dmg 2 lần, mỗi hit áp 2 <:Tremor:1513762737388257380>Tremor*`,
        `<:Dice1:1508173590078558369> Nhát 1: **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice1:1508173590078558369> Nhát 2: **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "you're too slow": {
    name: "You're Too Slow",
    tags: "Bleed",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,23);
      return [
        `*Né 1 đòn của địch, đánh dấu chúng, hồi 1 <:Light:1513786082502770719>Light; turn sau kích hoạt lại 1 lần*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — đâm sau lưng địch, gây 3 <:Bleed:1513762688226955285>Bleed cho turn sau`,
      ];
    },
    // "turn sau kích hoạt lại 1 lần" (persist qua round tiếp theo) CHƯA tự
    // động hoá — GM tạm tự theo dõi phần lặp lại này.
    counterEffect: { light: 1 },
  },

  // ── Coin Trick / Pistol / Summary ──
  "coin trick": {
    name: "Coin Trick",
    tags: "Rupture",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [AOE 5 mục tiêu] — tiêu 1 Ahn, búng đồng xu gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "pistol draw": {
    name: "Pistol Draw",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,8), d2 = r(6,8), d3 = r(6,8);
      return [
        `*Yêu cầu 1 viên đạn (không tiêu). Bắn 3 đường đạn [AOE 2 mục tiêu]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce]`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce]`,
      ];
    },
  },
  "summary judgement": {
    name: "Summary Judgement",
    tags: "Tremor/Burn",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,9), d2 = r(10,15);
      return [
        `*Yêu cầu tối thiểu 1 viên đạn (không tiêu)*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — dậm chân, gây 6 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — rút súng bắn rồi giật lùi, áp 4 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },

  // ── Haste (Fencing) ──
  "contre attaque": {
    name: "Contre Attaque",
    tags: "Haste",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(3,5), d3 = r(7,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — nhận 6 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Fix_Haste:1513768004222062632>Haste`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — nhận 4 <:Fix_Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "engagement": {
    name: "Engagement",
    tags: "Haste",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(5,10), d3 = r(6,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "balestra fente": {
    name: "Balestra Fente",
    tags: "Haste",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "Dice1: 1x / Dice2: 0.5x",
    roll() {
      const d1 = r(5,8), d2 = r(7,11);
      const hasPoise = Math.random() < 0.5;
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — chọt nhiều đòn`,
        `<:Dice2:1508173623691710625> **${d2}${hasPoise ? "+4 DiceUp" : ""}** [<:Pierce:1513768511179329556>Pierce]${hasPoise ? " *(≥8 Poise: nhận 4 <:DiceUp:1513767795681398894>Dice Up)*" : ""}`,
      ];
    },
  },

  // ── Burn/Haste (Viriscent) ──
  "scorching incision": {
    name: "Scorching Incision",
    tags: "Burn",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,6), d3 = r(4,6);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Fix_Burn:1513762753691652177>Burn và gắn 1 <:Fix_Bind:1513768025881317457>Bind với mỗi 2 <:Fix_Burn:1513762753691652177>Burn trên địch [Max: 6]`,
      ];
    },
  },

  // ── Abnormality Pages (TETH) ──
  "fourth match flame": {
    name: "Fourth Match Flame",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "4 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,40);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [AOE] — chém đường lửa gây 5 <:Fix_Burn:1513762753691652177>Burn lên kẻ thù ở turn sau`,
      ];
    },
  },
  "today's expression": {
    name: "Today's Expression",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "3 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,30), d2 = r(6,9), d3 = r(5,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** — giảm Stamina địch bằng số dice [chỉ giảm Stamina, không gây dmg]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nếu địch Stagger: dmg = dice + 10`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash]`,
      ];
    },
  },
  "regret": {
    name: "Regret",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "5 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,8), d2 = r(6,8), d3 = r(9,19);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — đập búa, giảm 20 Stamina địch`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — đập búa, giảm 20 Stamina địch`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — đập búa, giảm 60 Stamina địch`,
      ];
    },
  },
  "fragments from somewhere": {
    name: "Fragments from Somewhere",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "3 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(4,7), d3 = r(4,7);
      return [
        `*Khi dùng: toàn bộ skill địch turn này bị giảm 5 Dice*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây nốt nhạc, giảm 10 Stamina địch`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây nốt nhạc, giảm 10 Stamina địch`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây nốt nhạc, giảm 10 Stamina địch`,
      ];
    },
  },
  "wrist cutter": {
    name: "Wrist Cutter",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "5 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(19,27);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] [AOE] — tạo vũng máu, khiến địch mất toàn bộ buff trên người`,
      ];
    },
  },
  "aspiration": {
    name: "Aspiration",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "5 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(24,39);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — đấm vào mặt địch. Bản thân mất 1/2 HP; toàn bộ đồng minh (không kể bản thân) nhận 3 <:DiceUp:1513767795681398894>Dice Up trong 1 Turn`,
      ];
    },
  },
  "red eyes": {
    name: "Red Eyes",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "4 <:Light:1513786082502770719>Light & 15 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,25), d2 = r(5,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — nhảy lên chém xuống, gây 3 <:Fix_Bind:1513768025881317457>Bind và 3 Feeble`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — chém địch`,
      ];
    },
  },
  "marionette": {
    name: "Marionette",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ZAYIN:1449759413966606398>",
    cost: "1 <:Light:1513786082502770719>Light & 10 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(19,27);
      return [
        `*Khi dùng: turn sau mọi skill của bản thân tốn thêm 1 <:Light:1513786082502770719>Light*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — dmg = dice + 5`,
      ];
    },
  },

  // ── Abnormality Pages (ZAYIN) ──
  "wingbeat": {
    name: "Wingbeat",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ZAYIN:1449759413966606398>",
    cost: "3 <:Light:1513786082502770719>Light & 10 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    needsReuse: true,
    roll() {
      const DICE_EMOJIS = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,
        `<:Dice3:1508173643518050395>`,`<:Dice4:1508176464367845600>`,`<:Dice5:1508176500438990968>`,
        `<:Dice5:1508176500438990968>`,`<:Dice5:1508176500438990968>`,
      ];
      const MAX_REUSE = 5;
      const lastD2 = r(6,8);
      const lines = [];
      let reuseStopped = false;
      for (let i = 0; i <= MAX_REUSE; i++) {
        const val = r(3,8);
        const isMin = val === 3;
        const dEmoji = DICE_EMOJIS[i] ?? DICE_EMOJIS[DICE_EMOJIS.length - 1];
        const label = i === 0 ? "" : ` ↩️ Reuse ${i}`;
        lines.push(`${dEmoji}${label} **${val}** [<:Pierce:1513768511179329556>Pierce] — lao đến đâm, hồi 3 HP${isMin ? " *(Min — dừng)*" : ""}`);
        if (isMin) { reuseStopped = true; break; }
      }
      if (!reuseStopped) lines.push(`*(Đã hết 5 lần Reuse)*`);
      lines.push(`<:Dice2:1508173623691710625> **${lastD2}** [<:Pierce:1513768511179329556>Pierce] — lao đến đâm địch`);
      return lines;
    },
  },

  // ── Abnormality Pages (HE) ──
  "the forgotten": {
    name: "The Forgotten",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,25);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — nếu clash thắng: hủy skill tiếp theo của địch`,
      ];
    },
  },
  "grinder mk. 5-2": {
    name: "Grinder Mk. 5-2",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,7), d2 = r(3,8), d3 = r(4,9);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — chọt toàn bộ địch, gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — chọt toàn bộ địch, gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — chọt toàn bộ địch, gây 2 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "harmony": {
    name: "Harmony",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "5 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    needsReuse: true,
    roll() {
      const DICE_EMOJIS = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,`<:Dice3:1508173643518050395>`,
      ];
      const MINS = [4, 3, 4];
      const RANGES = [[4,7],[3,6],[4,8]];
      const MAX_REUSE = 2;
      const lines = [
        `*Mỗi lần tấn công thành công: 1 đồng minh ngẫu nhiên mất 3 Stamina*`,
        `*Mỗi 2 lần tấn công thành công: 1 đồng minh nhận 1 <:DiceUp:1513767795681398894>Dice Up*`,
        `*Nếu có thể kết liễu địch: toàn bộ đồng minh nhận 2 <:DiceUp:1513767795681398894>Dice Up*`,
      ];
      for (let di = 0; di < 3; di++) {
        const [mn, mx] = RANGES[di];
        const min = MINS[di];
        const dEmoji = DICE_EMOJIS[di];
        const val = r(mn, mx);
        const isMin = val === min;
        lines.push(`${dEmoji} **${val}** [<:Blunt:1513768529718022254>Blunt] — cưa địch${isMin ? " *(Min — dừng)*" : ""}`);
        if (!isMin) {
          for (let re = 1; re <= MAX_REUSE; re++) {
            const rval = r(mn, mx);
            const rMin = rval === min;
            lines.push(`${dEmoji} ↩️ Reuse ${re} **${rval}** [<:Blunt:1513768529718022254>Blunt] — cưa địch${rMin ? " *(Min — dừng)*" : re === MAX_REUSE ? " *(hết Reuse)*" : ""}`);
            if (rMin) break;
          }
        }
      }
      return lines;
    },
  },
  "solemn lament": {
    name: "Solemn Lament",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "6 Turn", diceMul: "1x",
    needsReuse: true,

    promptArg: {
    parse: (s) => parseInt(s, 10),
    validate: (n) => Number.isInteger(n) && n >= 0,
    errorMsg: "❌ Nhập số người đã chết (≥ 0).\n> VD: `-skill solemn lament 3`",
    buildHeader: (deadCount, skill) =>
      `[${skill.cost}] [CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}] — **${deadCount} người đã chết**`,
  },

    roll(deadCount = 0) {
      const MAX_REUSE = deadCount * 8;
      const DICE_EMOJIS = [
        `<:Dice1:1508173590078558369>`,`<:Dice2:1508173623691710625>`,`<:Dice3:1508173643518050395>`,
        `<:Dice4:1508176464367845600>`,`<:Dice5:1508176500438990968>`,
      ];
      const getDEmoji = (i) => DICE_EMOJIS[Math.min(i, DICE_EMOJIS.length - 1)];
      const lines = [];
      if (deadCount === 0) {
        const d1 = r(1,6);
        lines.push(`${getDEmoji(0)} **${d1}** [<:Blunt:1513768529718022254>Blunt] — bắn vào mặt địch, giảm Stamina địch = ${d1 + 3}`);
        lines.push(`*(Chưa có ai chết — không có Reuse)*`);
        return lines;
      }

      // Roll tất cả hits trước
      const hits = [];
      for (let i = 0; i <= MAX_REUSE; i++) {
        const val = r(1,6);
        hits.push({ val, staminaDmg: val + 3 });
      }
      const totalStamina = hits.reduce((s, h) => s + h.staminaDmg, 0);
      const totalDmg = hits.reduce((s, h) => s + h.val, 0);
      const minHit = Math.min(...hits.map(h => h.val));
      const maxHit = Math.max(...hits.map(h => h.val));

      lines.push(`*(${deadCount} mạng đã ngã → ${MAX_REUSE} lần Reuse)*`);

      // Hiện 3 hit đầu, gộp phần còn lại
      // ❗❗ BUG ĐÃ SỬA (user Libur: *"Solemn Lament — dù có hơn 9 mạng nhưng nó
      // chỉ Reuse có 2 thôi"*).
      // GỐC: trước đây chỉ in 3 dòng dice rồi GỘP phần còn lại thành một dòng văn
      // xuôi cho gọn. Nhưng `autoBuildDmgStrFromSkillRoll` CHỈ đọc **dòng dice** —
      // dòng gộp không khớp mẫu nên toàn bộ hit còn lại BIẾN MẤT khỏi `dmgStr`.
      // Đo: deadCount 9 → roll đúng 73 hit nhưng dmgStr chỉ có **1 hit**. Người
      // chơi thấy tổng kết "73 hit" mà sát thương thật chỉ 1 hit.
      // ⇒ Mỗi hit PHẢI có dòng dice riêng — nguồn sự thật DUY NHẤT của dmg.
      //   Discord chặn 4096 ký tự/embed nên vẫn phải cắt khi quá dài, nhưng cắt là
      //   MẤT dmg ⇒ chốt trần theo SỐ HIT và NÓI RÕ khi bị cắt, không nuốt im lặng.
      const MAX_DICE_LINES = 60;
      const shownCount = Math.min(hits.length, MAX_DICE_LINES);
      for (let i = 0; i < shownCount; i++) {
        const { val, staminaDmg } = hits[i];
        const label = i === 0 ? "" : ` — Reuse ${i}`;
        const tail = i === hits.length - 1 ? " *(hết Reuse)*" : "";
        lines.push(`${getDEmoji(i)}${label} **${val}** [<:Blunt:1513768529718022254>Blunt] — giảm Stamina địch = ${staminaDmg}${tail}`);
      }
      if (hits.length > MAX_DICE_LINES) {
        lines.push(`⚠️ *Còn **${hits.length - MAX_DICE_LINES}** hit KHÔNG hiện được (giới hạn ký tự Discord) — chia nhỏ deadCount để không mất sát thương.*`);
      }

      // Summary
      lines.push(`\n📊 **Tổng kết** (${hits.length} hit)`);
      lines.push(`> <:Blunt:1513768529718022254> Tổng DMG: **${totalDmg}** | Min: ${minHit} / Max: ${maxHit} / TB: ${(totalDmg / hits.length).toFixed(1)}`);
      lines.push(`> <:TremorBurst:1513802464632246352> Tổng Stamina giảm: **${totalStamina}**`);

      return lines;
    },
  },
  "magic bullet": {
    name: "Magic Bullet",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "1 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "???", diceMul: "1x",
    roll() {
      const d1 = r(4,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — bắn viên đạn vào địch`,
        `*Sau khi dùng: mở lãnh địa Der Freischütz, dùng được skill của hắn trong 3 Turn tiếp theo [1 lần/Encounter]*`,
        `*(Dùng: \`-skill flooding bullets\`, \`-skill magic bullet df\`, \`-skill inevitable bullet\`)*`,
      ];
    },
  },
  "flooding bullets": {
    name: "Flooding Bullets",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796> (Der Freischütz)",
    cost: "5 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(4,8), d2 = r(4,8), d3 = r(4,8);
      return [
        `*[AOE] — Lượng dmg = số dice x2*`,
        `<:Dice1:1508173590078558369> **${d1*2}** [<:Pierce:1513768511179329556>Pierce] — 3 vòng tròn ma thuật bắn vào tất cả địch`,
        `<:Dice2:1508173623691710625> **${d2*2}** [<:Pierce:1513768511179329556>Pierce] — 3 vòng tròn ma thuật bắn vào tất cả địch`,
        `<:Dice3:1508173643518050395> **${d3*2}** [<:Pierce:1513768511179329556>Pierce] — 3 vòng tròn ma thuật bắn vào tất cả địch, giảm 6 Stamina`,
      ];
    },
  },
  "magic bullet df": {
    name: "Magic Bullet (Der Freischütz)",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796> (Der Freischütz)",
    cost: "0 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — rút súng bắn địch; hồi 1 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "inevitable bullet": {
    name: "Inevitable Bullet",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796> (Der Freischütz)",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,9), d2 = r(5,9);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — 2 vòng tròn ma thuật bắn xuyên tất cả địch`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — 2 vòng tròn ma thuật bắn xuyên tất cả địch`,
      ];
    },
  },
  "our galaxy": {
    name: "Our Galaxy",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,8), d2 = r(3,8), d3 = r(3,6);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — thả thiên thạch, hồi ${d1} HP`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — thả thiên thạch, hồi ${d2} HP`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — thả thiên thạch, hồi ${d3} HP`,
      ];
    },
  },
  "pleasure": {
    name: "Pleasure",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "5 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const turnBonus = r(1,5);
      const d1 = r(5,15);
      const d2 = r(2,5), d3 = r(2,5), d4 = r(2,5);
      return [
        `<:Dice1:1508173590078558369> **${(d1 + turnBonus) * 2}** [<:Blunt:1513768529718022254>Blunt] — (dice + ${turnBonus} turn bonus) x2`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "laetitia": {
    name: "Laetitia",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,18);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE] — triệu hồi trái tim khổng lồ phát nổ; địch dính dmg bị hoãn 1 hành động`,
      ];
    },
  },
  "sanguine desire": {
    name: "Sanguine Desire",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "4 <:Light:1513786082502770719>Light & 20 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,10), d2 = r(3,9), d3 = r(4,6);
      const hasBleed = Math.random() < 0.5;
      return [
        `*Khi dùng: <:Bleed:1513762688226955285>Bleed tồn tại thêm 1 turn*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt]`,
        // Fragaria sửa mô tả (nguyên văn):
        //   cũ: "gây sát thương BẰNG SỐ DICE roll ra + Bleed nhân 2"
        //   mới: "Lao vào đập kẻ thù, SỐ DICE sẽ bằng số roll ra + Bleed nhân 2"
        // Khác biệt là ở CHỖ nhân đôi: nhân vào chính GIÁ TRỊ DICE (nên nó tham
        // gia clash, Dice Up, Res… như một dice bình thường), KHÔNG phải nhân
        // dmg sau cùng. Code vốn đã nhân đúng vào dice (`d3*2`) — chỉ chữ mô tả
        // sai. Sửa chữ cho khớp để không ai đọc rồi "sửa" code theo nghĩa cũ.
        `<:Dice3:1508173643518050395> **${hasBleed ? d3 * 2 : d3}** [<:Blunt:1513768529718022254>Blunt] — Lao vào đập kẻ thù, số Dice sẽ bằng số roll ra${hasBleed ? " ×2 *(địch có <:Bleed:1513762688226955285>Bleed)*" : " *(địch không có <:Bleed:1513762688226955285>Bleed)*"}`,
      ];
    },
  },

  // ── NOTHING THERE — Weekly Boss (data Fragaria đưa nguyên văn) ──────────
  // 5 page dưới đây CHỈ boss dùng; không rơi vào kho page người chơi.
  // ❗ Fragaria (12/08): "Sửa TOÀN BỘ đòn của Nothing There thành Unclashable."
  // Tag [Unclashable] viết vào TỪNG DÒNG DICE — `parsePerHitBypass` đọc theo dòng,
  // nên ghi ở dòng header là các hit sau sót. Hệ quả: nút Clash không hiện ở
  // prompt phòng thủ (reactive-defense.js kiểm `thisGroupBypass.unclashable`),
  // và AI cũng không clash lại được (cùng bộ cờ).
  // Attack Pattern (xem `attackPattern` trong quest-data.js):
  //   Turn 1: Jump Attack · Triple Swing · Swing
  //   Turn 2: Running Attack · Jump Attack · Triple Swing
  //   Turn 3: HELP · Triple Swing · Goodbye
  //   Turn 4: lặp lại từ Turn 1
  "nt swing": {
    name: "Swing", tags: "Nothing There", bossOnly: true,
    unclashable: true,
    cost: "—", cd: "—", diceMul: "1x",
    roll() {
      return [`${D1} **50** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Unclashable] — Vung 1 đòn`];
    },
  },
  "nt triple swing": {
    name: "Triple Swing", tags: "Nothing There", bossOnly: true,
    unclashable: true,
    cost: "—", cd: "—", diceMul: "1x",
    roll() {
      // 3 đòn LIÊN TỤC, mỗi đòn 30 — viết thành 3 dice riêng để hệ thống chia
      // nhóm phòng thủ đúng (mỗi hit là 1 nhóm với vũ khí heavy).
      return [
        `${D1} **30** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Unclashable] — Vung đòn 1/3`,
        `${D2} **30** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Unclashable] — Vung đòn 2/3`,
        `${D3} **30** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Unclashable] — Vung đòn 3/3`,
      ];
    },
  },
  "nt jump attack": {
    name: "Jump Attack", tags: "Nothing There", bossOnly: true,
    unclashable: true,
    cost: "—", cd: "—", diceMul: "1x",
    roll() {
      return [`${D1} **100** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Undodgeable] [Unclashable] — Nhảy vụt lên rồi bổ xuống`];
    },
  },
  "nt running attack": {
    name: "Running Attack", tags: "Nothing There", bossOnly: true,
    unclashable: true,
    cost: "—", cd: "—", diceMul: "1x",
    roll() {
      // Fragaria bổ sung số chính thức: "Chạy lại rồi vung chùy vào kẻ địch gây
      // 80 Dmg Blunt [Unblockable]". (Trước đó tôi để tạm 50 = bằng Swing.)
      return [`${D1} **80** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Unclashable] — Chạy lại rồi vung chùy vào kẻ địch`];
    },
  },
  "nt help": {
    name: "HELP", tags: "Nothing There", bossOnly: true,
    unclashable: true,
    cost: "—", cd: "—", diceMul: "1x",
    roll() {
      // "Hú một cái khiến 1 TRONG 10 ĐÒN tiếp theo sắp vung sẽ trở thành
      // [Unblockable, Undodgeable, Unparriable]. Sau đó liên tục tung 10 đòn
      // mỗi đòn 10 Dmg Blunt [Unblockable]."
      // → Chọn NGẪU NHIÊN 1 trong 10 hit để gắn thêm 2 tag chặn phòng thủ.
      const cursedIdx = Math.floor(Math.random() * 10);
      const lines = [`*Nothing There hú lên — đòn thứ **${cursedIdx + 1}** không thể chặn/né/parry*`];
      for (let i = 0; i < 10; i++) {
        const tags = i === cursedIdx
          ? "[Unblockable] [Undodgeable] [Unparriable] [Unclashable]"
          : "[Unblockable] [Unclashable]";
        lines.push(`${i === 0 ? D1 : D2} **10** [<:Blunt:1513768529718022254>Blunt] ${tags} — đòn ${i + 1}/10`);
      }
      return lines;
    },
  },
  "nt goodbye": {
    name: "Goodbye", tags: "Nothing There", bossOnly: true,
    unclashable: true,
    cost: "—", cd: "—", diceMul: "1x",
    roll() {
      return [`${D1} **200** [<:Slash:1513768633434640517>Slash] [Unblockable] [Undodgeable] [Unclashable] [AOE] [True] — Biến một cánh tay thành lưỡi hái rồi vung vào kẻ địch`];
    },
  },

  // ── Abnormality Pages (WAW) ──
  "hornet": {
    name: "Hornet",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "2 <:Light:1513786082502770719>Light & 30 <:Sanity:1538272293132963930>Sanity", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,32);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — lao đến đâm xuyên địch, gây 5 <:Fragile:1513763336167100536>Fragile`,
      ];
    },
  },
  "green stem": {
    name: "Green Stem",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "5 <:Light:1513786082502770719>Light & 30 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(3,9), d2 = r(3,9), d3 = r(3,10);
      return [
        `*[AOE] — Lượng dmg = số dice x2*`,
        `<:Dice1:1508173590078558369> **${d1*2}** [<:Blunt:1513768529718022254>Blunt] — gây dmg lên tất cả địch`,
        `<:Dice2:1508173623691710625> **${d2*2}** [<:Blunt:1513768529718022254>Blunt] — gây dmg lên tất cả địch`,
        `<:Dice3:1508173643518050395> **${d3*2}** [<:Blunt:1513768529718022254>Blunt] — gây dmg lên tất cả địch`,
      ];
    },
  },
  "faint aroma": {
    name: "Faint Aroma",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "5 <:Light:1513786082502770719>Light & 30 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(3,7), d2 = r(3,7), d3 = r(3,7);
      const stagger = Math.random() < 0.4;
      return [
        `*[AOE] — Lượng dmg = số dice x2; +10 dmg nếu địch Stagger*`,
        `<:Dice1:1508173590078558369> **${stagger ? d1*2+10 : d1*2}** [<:Slash:1513768633434640517>Slash]${stagger ? " *(Stagger +10)*" : ""}`,
        `<:Dice2:1508173623691710625> **${stagger ? d2*2+10 : d2*2}** [<:Slash:1513768633434640517>Slash]${stagger ? " *(Stagger +10)*" : ""}`,
        `<:Dice3:1508173643518050395> **${stagger ? d3*2+10 : d3*2}** [<:Slash:1513768633434640517>Slash]${stagger ? " *(Stagger +10)*" : ""}`,
      ];
    },
  },
  "black swan": {
    name: "Black Swan",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "5 <:Light:1513786082502770719>Light & 30 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(9,18);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gầm lên, gây dmg`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gầm lên, gây dmg; địch dính trừ 2 <:Light:1513786082502770719>Light`,
      ];
    },
  },

  // ── Abnormality Pages (ALEPH) ──
  "da capo": {
    name: "Da Capo",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ALEPH:1449759474268242021>",
    cost: "5 <:Light:1513786082502770719>Light & 40 <:Sanity:1538272293132963930>Sanity", cd: "4 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(4,8), d2 = r(4,9), d3 = r(5,9);
      return [
        `*[AOE] — Lượng dmg = số dice x2*`,
        `<:Dice1:1508173590078558369> **${d1*2}** [<:Blunt:1513768529718022254>Blunt] — Màn một: khiến tất cả địch mất 3 <:Light:1513786082502770719>Light`,
        `<:Dice2:1508173623691710625> **${d2*2}** [<:Blunt:1513768529718022254>Blunt] — Màn hai: tất cả địch nhận 10 <:Fix_Bind:1513768025881317457>Bind`,
        `<:Dice3:1508173643518050395> **${d3*2}** [<:Blunt:1513768529718022254>Blunt] — Màn cuối: tất cả địch nhận 2 Feeble`,
      ];
    },
  },

  // ── Frost Splinter (HE Tier — xác nhận trực tiếp) ──
  "frost splinter": {
    name: "Frost Splinter",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:HE:1449759447152070796>",
    cost: "6 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,12), d2 = r(8,13);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Fix_Bind:1513768025881317457>Bind và 1 Feeble trong 1 Turn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Fix_Bind:1513768025881317457>Bind và 1 Feeble trong 1 Turn`,
      ];
    },
  },

  // ── MY HAIR COUPOOOOOOONS! / Nursefather ──
  "my hair coupooooooons": {
    name: "MY HAIR COUPOOOOOOONS!",
    tags: "Tremor",
    cost: "5 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(18,32);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AoE] [Guard Break] — <:TremorBurst:1513802464632246352>Tremor Burst và 7 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },
  "proof of loyalty": {
    name: "Proof of Loyalty",
    tags: "Bleed",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(8,11);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — lùi rồi đấm xuống mặt đất, gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
      ];
    },
  },
  "just a vengeance": {
    name: "Just A Vengeance",
    tags: "Bleed",
    cost: "4 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(4,6), d3 = r(5,7), d4 = r(12,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — gây 2 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đạp địch ra xa, gây 2 <:Fix_Bind:1513768025881317457>Bind`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [AoE 2 người] — gây 3 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },

  // ── Fairy (Degraded) skills ──
  "degraded fairy": {
    name: "Degraded Fairy",
    tags: "Fairy <:Fairy:1513782007602216960>",
    // BUFF (bảng Fragaria đưa trực tiếp): Cost 2 → **0 Light**. Dice/CD/hiệu ứng
    // giữ nguyên như bảng.
    cost: "0 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(4,8);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Triệu hồi gai đâm kẻ thù gây 2 <:Fairy:1513782007602216960>Fairy`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Triệu hồi gai đâm kẻ thù gây 2 <:Fairy:1513782007602216960>Fairy`,
        `${D2} Nhận 1 <:Light:1513786082502770719>Light nếu đánh dính kẻ thù`,
      ];
    },
  },
  "degraded pillar": {
    name: "Degraded Pillar",
    tags: "Fairy <:Fairy:1513782007602216960>",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    // BUFF (bảng Fragaria đưa trực tiếp): từ 1 dice [7~11] gây 4 Fairy →
    // **2 dice**: [8~12] và [7~11], mỗi dice 3 Fairy. Dice 1 [Undodgeable],
    // dice 2 [Undodgeable][Guard Break] — Guard Break CHỈ ở dice 2 theo bảng.
    roll() {
      const d1 = r(8,12), d2 = r(7,11);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — Triệu hồi cây cột đập mặt kẻ thù, gây 3 <:Fairy:1513782007602216960>Fairy`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Guard Break] — Cây cột phát nổ gây sát thương lên kẻ thù, gây 3 <:Fairy:1513782007602216960>Fairy`,
      ];
    },
  },
  "degraded lock": {
    name: "Degraded Lock",
    tags: "Fairy <:Fairy:1513782007602216960>",
    cost: "4 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,20);
      return [
        `${D1} **${d1}** [Undodgeable] — Xích kẻ thù lại gây 5 <:Fairy:1513782007602216960>Fairy và 1 **Chained** <:chained:1513782041307643984>Chained`,
      ];
    },
  },
  // Alias "ds"/"degradedshockwave" đã có sẵn từ trước nhưng key này chưa tồn tại —
  // trước đây bị fuzzy-match nhầm sang "degraded fairy". Giờ điền đúng skill thật.
  "degraded shockwave": {
    name: "Degraded Shockwave",
    tags: "Fairy <:Fairy:1513782007602216960>",
    cost: "5 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "0.66x",
    roll() {
      const d1 = r(5,10), d2 = r(10,20), d3 = r(15,30);
      return [
        `**[<:Blunt:1513768529718022254>Blunt] [AOE] [Uncancellable] [Guard Break]**`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Giật điện, gây 6 <:Tremor:1513762737388257380>Tremor`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Giật điện, gây 6 <:Tremor:1513762737388257380>Tremor`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — Giật điện, gây 6 <:Tremor:1513762737388257380>Tremor, sau đó gây <:TremorBurst:1513802464632246352>Tremor Burst`,
        `${D3} *Nếu trước khi gây <:TremorBurst:1513802464632246352>Tremor Burst, kẻ địch có trên 10 <:Tremor:1513762737388257380>Tremor: gắn 6 <:Fairy:1513782007602216960>Fairy và gây 4 <:DiceDown:1513767826257874964>Dice Down cho kẻ địch*`,
      ];
    },
  },

  // ══════════════ Weapon Criticals ══════════════
  "patrolling": {
    name: "Patrolling", weaponOf: "Zweihander", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(7,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Chém kẻ địch, nhận 3 <:DefenseUp:1513767487894716497>Defense Up`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đâm kẻ địch, nhận 4 <:DefenseUp:1513767487894716497>Defense Up và gây 5 <:DefenseDown:1513767463337066576>Defense Down`,
      ];
    },
  },
  "bayonet combat": {
    name: "Bayonet Combat", weaponOf: "Soldato Rifle", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(5,7), d3 = r(4,7);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Chém xuống bằng lưỡi súng, gây 2 <:Tremor:1513762737388257380>Tremor`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Chém lên, gây 2 <:Tremor:1513762737388257380>Tremor`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Lùi lại đâm, gây 2 <:Tremor:1513762737388257380>Tremor và nhận 1 viên đạn`,
      ];
    },
  },
  "shock round": {
    name: "Shock Round", weaponOf: "Soldato Rifle", tags: "Weapon",
    cost: "Tiêu 5 viên đạn", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(9,17);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Chém ngang bằng lưỡi súng, gây 4 <:Tremor:1513762737388257380>Tremor`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Đạn nổ thổi bay kẻ địch, gây 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "sharp cuts": {
    name: "Sharp Cuts", weaponOf: "Blade Lineage Hwando", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(4,8);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 3 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "thundercleaver": {
    name: "Thundercleaver", weaponOf: "Kurokumo Katana", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "0.5x",
    roll() {
      const d1 = r(5,9), d2 = r(5,13), d3 = r(5,17);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "upstanding slash": {
    name: "Upstanding Slash", weaponOf: "Mimicry Blade", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    // Fragaria: "Upstanding Slash phải share chung CD với cả 2 Great Split —
    // đúng hơn là CẢ 3 share chung CD với nhau là 2 Turn."
    cdGroup: "mimicry blade strike",
    roll() {
      const d1 = r(6,10), d2 = r(9,15);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Chém ngang, gây 3 <:Bleed:1513762688226955285>Bleed (turn kế) và nhận 1 Imitation`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Chém dọc theo sau, gây 3 <:Bleed:1513762688226955285>Bleed (turn kế) và nhận 1 Imitation`,
      ];
    },
  },
  "great split vertical": {
    name: "Great Split: Vertical", weaponOf: "Mimicry Blade", tags: "Weapon",
    cost: "Tiêu 5 Imitation", cd: "2 Turn", diceMul: "2x",
    // Fragaria: "Upstanding Slash phải share chung CD với cả 2 Great Split —
    // đúng hơn là CẢ 3 share chung CD với nhau là 2 Turn."
    cdGroup: "mimicry blade strike",
    roll() {
      const d1 = r(15,26);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Unblockable]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Bổ dọc kẻ địch từ trên xuống, cắt đôi người chúng`,
      ];
    },
  },
  // ── E.G.O PAGE của "Manifested E.G.O: Red Mist" (ego.js key `redmist`) ──────
  // KHÔNG phải "E.G.O Page" theo nghĩa slot ZAYIN/TETH/HE/WAW/ALEPH (thứ đó có
  // tag <:The_Library:...> và equip vào `equippedEgoPages`). Đây là page RIÊNG
  // của một Manifested E.G.O: chỉ hiện trong dropdown Moves khi người chơi ĐANG
  // bật Manifest, lọc qua `egoSkillKeysFor(combatant)` (ego.js). Cùng khuôn với
  // Falco Berigora / Wedjat (Hoshino) — nên dùng `weaponOf` + tags "Weapon".
  "reaching hand": {
    name: "Reaching Hand", weaponOf: "Manifested E.G.O: Red Mist", tags: "Weapon",
    cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    // mimicryFormOnUse — dùng page này thì Mimicry chuyển sang dạng LƯỠI HÁI
    // ("Biến Mimicry trở thành một cây lưỡi hái"). Đọc ở resolve-pending-action.js.
    mimicryFormOnUse: "scythe",
    roll() {
      const d1 = r(12, 20);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Undodgeable] — Biến Mimicry trở thành một cây lưỡi hái sau đó bổ dọc kẻ địch, gây 4 <:Bleed:1513762688226955285>Bleed, nhận 4 <:Imitation:1513769425063514173>Imitation và hồi 45 HP`,
      ];
    },
  },
  "dense flesh": {
    name: "Dense Flesh", weaponOf: "Manifested E.G.O: Red Mist", tags: "Weapon",
    cost: "6 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1.5x",
    mimicryFormOnUse: "scythe",
    roll() {
      const d1 = r(8, 14), d2 = r(8, 14), d3 = r(8, 14);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Undodgeable] — Biến Mimicry trở thành một cây lưỡi hái sau đó lướt lên cắt ngang kẻ địch bằng 3 lần xoay, gây 2 <:Bleed:1513762688226955285>Bleed`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Undodgeable] — gây 2 <:Bleed:1513762688226955285>Bleed, gắn 1 <:Hemorrhage:1513762688226955285>Hemorrhage`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Undodgeable] — gây 2 <:Bleed:1513762688226955285>Bleed, nhận 2 <:Imitation:1513769425063514173>Imitation và hồi 70 HP`,
      ];
    },
  },
  // ══ ORACLE DEVICE [CADUCEUS] — 9 Critical (3 bậc × 3 type) + 3 Furioso ══════
  // roll(ctx) nhận MỘT object: { karmic, unlock, procuration }.
  // `deriveAutoPromptArg` (skill-verification.js) tự bơm từ combatant — người chơi
  // KHÔNG phải gõ Karmic bằng tay như bản `-caduceus` cũ.
  //
  // Base dmg của mỗi mặt TRỞ THÀNH **Dice Value** khi dùng Critical (Fragaria:
  // "M1 thì không có Dice Value, nhưng khi dùng Critical thì Base Dmg của mỗi loại
  // vũ khí của Caduceus sẽ trở thành Dice Value nhằm phục vụ bonus từ sanity và clash").
  "caduceus crit1 blunt": {
    name: "Slam Down with Weight, Topple the Body", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit1",
    caduceusCrit: { tier: 1, rolls: 2, bonusPct: 30, type: "Blunt" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 2 Dice Caduceus theo type **Blunt** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 2; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Blunt")
          : CADUCEUS_FACES.filter(d => d.type !== "Blunt");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Blunt";
        // Ra đúng type ⇒ bonus 30% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+30DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+30DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "caduceus crit1 pierce": {
    name: "Lay Vertical The End, Insert Up to the Wick", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit1",
    caduceusCrit: { tier: 1, rolls: 2, bonusPct: 30, type: "Pierce" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 2 Dice Caduceus theo type **Pierce** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 2; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Pierce")
          : CADUCEUS_FACES.filter(d => d.type !== "Pierce");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Pierce";
        // Ra đúng type ⇒ bonus 30% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+30DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+30DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "caduceus crit1 slash": {
    name: "Lay the Blade on its Side, Slice Like a Severed Breath", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit1",
    caduceusCrit: { tier: 1, rolls: 2, bonusPct: 30, type: "Slash" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 2 Dice Caduceus theo type **Slash** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 2; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Slash")
          : CADUCEUS_FACES.filter(d => d.type !== "Slash");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Slash";
        // Ra đúng type ⇒ bonus 30% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+30DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+30DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "caduceus crit2 blunt": {
    name: "Swing to Fell, Have it Meet the Ground", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Guard Break",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit2",
    caduceusCrit: { tier: 2, rolls: 3, bonusPct: 40, type: "Blunt" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 3 Dice Caduceus theo type **Blunt** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 3; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Blunt")
          : CADUCEUS_FACES.filter(d => d.type !== "Blunt");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Blunt";
        // Ra đúng type ⇒ bonus 40% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+40DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+40DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} [Guard Break] — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "caduceus crit2 pierce": {
    name: "Aim Toward a Point, Let it Echo Within", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Guard Break",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit2",
    caduceusCrit: { tier: 2, rolls: 3, bonusPct: 40, type: "Pierce" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 3 Dice Caduceus theo type **Pierce** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 3; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Pierce")
          : CADUCEUS_FACES.filter(d => d.type !== "Pierce");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Pierce";
        // Ra đúng type ⇒ bonus 40% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+40DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+40DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} [Guard Break] — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "caduceus crit2 slash": {
    name: "Carve at a Low Slant, Peel What Remains", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Guard Break",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit2",
    caduceusCrit: { tier: 2, rolls: 3, bonusPct: 40, type: "Slash" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 3 Dice Caduceus theo type **Slash** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 3; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Slash")
          : CADUCEUS_FACES.filter(d => d.type !== "Slash");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Slash";
        // Ra đúng type ⇒ bonus 40% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+40DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+40DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} [Guard Break] — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "caduceus crit3 blunt": {
    name: "Destroy the Sound, Crush Flat the Thought", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Guard Break, Undodgeable",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit3",
    caduceusCrit: { tier: 3, rolls: 4, bonusPct: 50, type: "Blunt" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 4 Dice Caduceus theo type **Blunt** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 4; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Blunt")
          : CADUCEUS_FACES.filter(d => d.type !== "Blunt");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Blunt";
        // Ra đúng type ⇒ bonus 50% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+50DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+50DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} [Guard Break] [Undodgeable] — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "caduceus crit3 pierce": {
    name: "Stab the Silence's Heart, Penetrate the Memory", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Guard Break, Undodgeable",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit3",
    caduceusCrit: { tier: 3, rolls: 4, bonusPct: 50, type: "Pierce" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 4 Dice Caduceus theo type **Pierce** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 4; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Pierce")
          : CADUCEUS_FACES.filter(d => d.type !== "Pierce");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Pierce";
        // Ra đúng type ⇒ bonus 50% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+50DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+50DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} [Guard Break] [Undodgeable] — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "caduceus crit3 slash": {
    name: "With Tempered Secret, Cut the Form", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Guard Break, Undodgeable",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    // cdGroup — Fragaria: "toàn bộ các crit đều có CD riêng biệt trong khi đáng lẽ
    // Crit 1 Pierce/Blunt/Slash SHARE CHUNG CD với nhau… khi Critical CD xong thì
    // chỉ được chọn 1 trong 3 loại dmg type thôi."
    // Dùng cơ chế `cdGroup` có sẵn (Atelier Logic) — cdKeyFor() quy về CÙNG ô đếm.
    cdGroup: "caduceus crit3",
    caduceusCrit: { tier: 3, rolls: 4, bonusPct: 50, type: "Slash" },
    roll(ctx = {}) {
      const karmic = Math.max(0, Number(ctx.karmic) || 0);
      // "mặc định 75% ra đúng type vũ khí, giảm khi có Karmic: (75 − Karmic/2)%"
      const chance = Math.max(0, 75 - karmic / 2);
      const lines = [`*Roll 4 Dice Caduceus theo type **Slash** — tỉ lệ ra đúng type **${chance.toFixed(1)}%**${karmic > 0 ? ` (Karmic ${karmic} → −${(karmic / 2).toFixed(1)}%)` : ""}*`];
      let total = 0;
      for (let i = 0; i < 4; i++) {
        const pool = (Math.random() * 100 < chance)
          ? CADUCEUS_FACES.filter(d => d.type === "Slash")
          : CADUCEUS_FACES.filter(d => d.type !== "Slash");
        const d = pool[Math.floor(Math.random() * pool.length)];
        const match = d.type === "Slash";
        // Ra đúng type ⇒ bonus 50% Dmg cho RIÊNG dice đó.
        // ❗ Fragaria 12/08: "Critical Caduceus đúng type được tính SẴN dmg bonus,
        // thế có tính bão hoà chưa? Nếu parse thẳng 50% là 45 dice rồi tiếp tục
        // với dmg bonus 100% ở sau nữa thì sẽ ra kết quả TO HƠN thực tế."
        // Fragaria ĐÚNG: bonus đúng type nhân THẲNG vào dice value ⇒ (a) không
        // qua `saturateBonusPct`, (b) còn bị %Bonus của người chơi nhân TIẾP.
        // NAY dice giữ giá trị GỐC, bonus ghi thành tag `+50DB%` để vào ĐÚNG
        // pool Dmg Bonus và chịu bão hoà chung với mọi nguồn khác.
        const val = cadDice(d.dmg);
        const matchTag = match ? "+50DB%" : "";
        total += val;
        // ❗ Fragaria: "khi Crit cũng CHƯA XỬ LÝ Poise ở dmg parse của encounter".
        // Mặt Caduceus nào cũng có hiệu ứng riêng — Furioso đã có, Crit thì quên.
        // Ghi vào dòng dice để `autoExtractDiceSideEffects` tự áp (cùng đường với
        // mọi page khác), thay vì code riêng cho Caduceus.
        lines.push(`${DICE_EMOJI_N[i]} **${val}**${matchTag} [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} [Guard Break] [Undodgeable] — *${d.name}*${match ? " ✅" : " ❌"}`);
      }
      // ⚠️ Fragaria: "3 Critical vẫn sử dụng Dice Value ĐẦU TIÊN để clash, CHỈ
      // RIÊNG Furioso xài tổng 9 Dice." Nên KHÔNG khai `clashUsesTotalDice` ở các
      // Crit này, và không ghi "tổng dùng cho clash" nữa (gây hiểu nhầm).
      lines.push(`*Clash bằng **Dice đầu tiên**. Tổng dmg ${Math.round(total * 100) / 100}*`);
      return lines;
    },
  },
  "furioso replica": {
    name: "Furioso Replica", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Unfocused Volley, Unevadeable, Unblockable, Unparriable, Uncounterable",
    cost: "—", cd: "—", diceMul: "1x",
    // Gate: ĐỦ 9 Procuration [Hermes] VÀ Unlock - I. Kiểm ở nơi dựng panel
    // (encounter-panels.js) — thiếu 1 trong 2 thì option không hiện.
    // CHỈ Furioso clash bằng TỔNG 9 Dice (3 Critical thường dùng dice đầu).
    clashUsesTotalDice: true,
    caduceusFurioso: { unlock: 1, bleed: 3, bind: 1, fragile: 1 },
    roll() {
      // 9 Dice: 1–8 roll như Will of Hermes (KHÔNG tốn Stamina), Dice 9 CHẮC CHẮN
      // là lưỡi hái. Base dmg của mặt tương ứng chính là Dice Value.
      const lines = [];
      let total = 0, totalClashBase = 0;
      for (let i = 0; i < 9; i++) {
        const d = (i === 8) ? CADUCEUS_FACES[8] : CADUCEUS_FACES[Math.floor(Math.random() * 9)];
        // Dice Value = base dmg của mặt + mọi buff/debuff dice (xem cadDice).
        const val = cadDice(d.dmg);
        total += val;
        // ❗ Fragaria: "toàn bộ mọi Dice Up sẽ KHÔNG thể áp dụng vào khi Clash mà
        // chỉ dice GỐC; chỉ có Clash Power Up và Clash Power Boost mới tăng dice
        // khi clash." ⇒ cộng riêng TỔNG DICE GỐC (chưa ăn buff) để in ra ở dòng
        // "Clash bằng TỔNG 9 Dice" — con số HIỆN RA phải đúng con số ĐEM ĐI SO.
        totalClashBase += d.dmg;
        // Fragaria: "toàn bộ 9 dice của Furioso đều ĐƯỢC HIỆU ỨNG — ví dụ rìu
        // được 2 Poise, lưỡi hái chắc chắn crit." Ghi thẳng vào dòng dice để
        // parser chung (extractNonDmgStrEffects / autoBuildDmgStr) tự áp.
        lines.push(`${DICE_EMOJI_N[i]} **${val}** [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} — *${d.name}*${i === 8 ? "" : ""}`);
      }
      lines.push(`*Clash bằng TỔNG 9 Dice: **${Math.round(totalClashBase * 100) / 100}*** [Unfocused Volley] [Unevadeable] [Unblockable] [Unparriable] [Uncounterable]`);
      lines.push(`*Turn SAU khi đòn này kết thúc, gây: <:Bleed:1513762688226955285>Bleed ×3 · <:Fix_Bind:1513768025881317457>Bind ×1 · <:Fix_Fragile:1513763336167100536>Fragile ×1*`);
      return lines;
    },
  },
  "furioso crescendo": {
    name: "Furioso [Crescendo]", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Unfocused Volley, Unevadeable, Unblockable, Unparriable, Uncounterable",
    cost: "—", cd: "—", diceMul: "1,25x",
    // Gate: ĐỦ 9 Procuration [Hermes] VÀ Unlock - II. Kiểm ở nơi dựng panel
    // (encounter-panels.js) — thiếu 1 trong 2 thì option không hiện.
    // CHỈ Furioso clash bằng TỔNG 9 Dice (3 Critical thường dùng dice đầu).
    clashUsesTotalDice: true,
    caduceusFurioso: { unlock: 2, bleed: 4, bind: 2, fragile: 2 },
    roll() {
      // 9 Dice: 1–8 roll như Will of Hermes (KHÔNG tốn Stamina), Dice 9 CHẮC CHẮN
      // là lưỡi hái. Base dmg của mặt tương ứng chính là Dice Value.
      const lines = [];
      let total = 0, totalClashBase = 0;
      for (let i = 0; i < 9; i++) {
        const d = (i === 8) ? CADUCEUS_FACES[8] : CADUCEUS_FACES[Math.floor(Math.random() * 9)];
        // Dice Value = base dmg của mặt + mọi buff/debuff dice (xem cadDice).
        const val = cadDice(d.dmg);
        total += val;
        // ❗ Fragaria: "toàn bộ mọi Dice Up sẽ KHÔNG thể áp dụng vào khi Clash mà
        // chỉ dice GỐC; chỉ có Clash Power Up và Clash Power Boost mới tăng dice
        // khi clash." ⇒ cộng riêng TỔNG DICE GỐC (chưa ăn buff) để in ra ở dòng
        // "Clash bằng TỔNG 9 Dice" — con số HIỆN RA phải đúng con số ĐEM ĐI SO.
        totalClashBase += d.dmg;
        // Fragaria: "toàn bộ 9 dice của Furioso đều ĐƯỢC HIỆU ỨNG — ví dụ rìu
        // được 2 Poise, lưỡi hái chắc chắn crit." Ghi thẳng vào dòng dice để
        // parser chung (extractNonDmgStrEffects / autoBuildDmgStr) tự áp.
        lines.push(`${DICE_EMOJI_N[i]} **${val}** [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} — *${d.name}*${i === 8 ? "" : ""}`);
      }
      lines.push(`*Clash bằng TỔNG 9 Dice: **${Math.round(totalClashBase * 100) / 100}*** [Unfocused Volley] [Unevadeable] [Unblockable] [Unparriable] [Uncounterable]`);
      lines.push(`*Turn SAU khi đòn này kết thúc, gây: <:Bleed:1513762688226955285>Bleed ×4 · <:Fix_Bind:1513768025881317457>Bind ×2 · <:Fix_Fragile:1513763336167100536>Fragile ×2*`);
      return lines;
    },
  },
  "furioso lacrimosa crescendo": {
    name: "Furioso [Lacrimosa-Crescendo]", weaponOf: "Oracle Device [Caduceus]", tags: "Weapon, Unfocused Volley, Unevadeable, Unblockable, Unparriable, Uncounterable",
    cost: "—", cd: "—", diceMul: "1,5x",
    // Gate: ĐỦ 9 Procuration [Hermes] VÀ Unlock - III. Kiểm ở nơi dựng panel
    // (encounter-panels.js) — thiếu 1 trong 2 thì option không hiện.
    // CHỈ Furioso clash bằng TỔNG 9 Dice (3 Critical thường dùng dice đầu).
    clashUsesTotalDice: true,
    caduceusFurioso: { unlock: 3, bleed: 5, bind: 3, fragile: 3 },
    roll() {
      // 9 Dice: 1–8 roll như Will of Hermes (KHÔNG tốn Stamina), Dice 9 CHẮC CHẮN
      // là lưỡi hái. Base dmg của mặt tương ứng chính là Dice Value.
      const lines = [];
      let total = 0, totalClashBase = 0;
      for (let i = 0; i < 9; i++) {
        const d = (i === 8) ? CADUCEUS_FACES[8] : CADUCEUS_FACES[Math.floor(Math.random() * 9)];
        // Dice Value = base dmg của mặt + mọi buff/debuff dice (xem cadDice).
        const val = cadDice(d.dmg);
        total += val;
        // ❗ Fragaria: "toàn bộ mọi Dice Up sẽ KHÔNG thể áp dụng vào khi Clash mà
        // chỉ dice GỐC; chỉ có Clash Power Up và Clash Power Boost mới tăng dice
        // khi clash." ⇒ cộng riêng TỔNG DICE GỐC (chưa ăn buff) để in ra ở dòng
        // "Clash bằng TỔNG 9 Dice" — con số HIỆN RA phải đúng con số ĐEM ĐI SO.
        totalClashBase += d.dmg;
        // Fragaria: "toàn bộ 9 dice của Furioso đều ĐƯỢC HIỆU ỨNG — ví dụ rìu
        // được 2 Poise, lưỡi hái chắc chắn crit." Ghi thẳng vào dòng dice để
        // parser chung (extractNonDmgStrEffects / autoBuildDmgStr) tự áp.
        lines.push(`${DICE_EMOJI_N[i]} **${val}** [${TYPE_EMOJI_CAD[d.type]}${d.type}]${CADUCEUS_FACE_FX[d.n] ?? ""} — *${d.name}*${i === 8 ? "" : ""}`);
      }
      lines.push(`*Clash bằng TỔNG 9 Dice: **${Math.round(totalClashBase * 100) / 100}*** [Unfocused Volley] [Unevadeable] [Unblockable] [Unparriable] [Uncounterable]`);
      lines.push(`*Turn SAU khi đòn này kết thúc, gây: <:Bleed:1513762688226955285>Bleed ×5 · <:Fix_Bind:1513768025881317457>Bind ×3 · <:Fix_Fragile:1513763336167100536>Fragile ×3*`);
      return lines;
    },
  },
  "great split horizontal": {
    name: "Great Split: Horizontal", weaponOf: "Mimicry Blade", tags: "Weapon",
    cost: "Tiêu 5 Imitation, cần bản thân dưới 30% HP", cd: "2 Turn", diceMul: "3x",
    // Fragaria: "Upstanding Slash phải share chung CD với cả 2 Great Split —
    // đúng hơn là CẢ 3 share chung CD với nhau là 2 Turn."
    cdGroup: "mimicry blade strike",
    roll() {
      const d1 = r(32,43);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Unblockable] [Undodgeable] [AOE 4 người]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [AOE 4 người] — Vung Mimicry theo chiều ngang cắt đôi kẻ địch`,
      ];
    },
  },
  "excruciating study": {
    name: "Excruciating Study", weaponOf: "Dieci Association Kata", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "0.5x",
    roll() {
      const d1 = r(4,7), d2 = r(4,7), d3 = r(7,10), d4 = r(10,13);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — đập vào mặt kẻ thù, gây 4 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — đập vào mặt kẻ thù`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — đập vào mặt kẻ thù`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] — đập vào mặt kẻ thù, gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "unveil": {
    name: "Unveil", weaponOf: "Dieci Association Key", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "0.8x",
    roll() {
      const d1 = r(4,4), d2 = r(4,8), d3 = r(4,12), d4 = r(4,16);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đập vào mặt kẻ thù, gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đập vào mặt kẻ thù, gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đập vào mặt kẻ thù, gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đập vào mặt kẻ thù, gây 1 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "scorching desperation": {
    name: "Scorching Desperation", weaponOf: "The Crying Children", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,18);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Tạo một cái cánh hất vào mặt kẻ thù, gây 7 <:Fix_Burn:1513762753691652177>Burn; bản thân giảm 15 Sanity`,
      ];
    },
  },
  "resonate": {
    name: "Resonate", weaponOf: "Reverberation Scythe", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(4,8);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Xoay lưỡi hái một vòng; nếu kẻ địch có số <:Tremor:1513762737388257380>Tremor bằng số Dice này thì sẽ Stagger ngay`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Xoay lưỡi hái một vòng nữa`,
      ];
    },
  },
  "magic impact": {
    name: "Magic Impact", weaponOf: "Yesterday's Promise", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,20);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Tạo một cánh tay ma thuật đục vào mặt kẻ thù`,
      ];
    },
  },
  "beatdown": {
    name: "Beatdown", weaponOf: "L'Heure du Loup", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(17,35);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Unclashable] — Đạp vào mặt kẻ thù, gây 4 <:Paralyze:1513763316479295548>Paralyze và 2 lần <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "overbreath": {
    name: "Overbreath", weaponOf: "Shi Association Katana", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,28);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt về phía kẻ thù, gây 2 <:Bleed:1513762688226955285>Bleed và nhận 6 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "forming storm": {
    name: "Forming Storm", weaponOf: "Liu Guan Dao", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,20);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Guard Break] [AOE 3 người] — Đập trường đao xuống tạo vùng lửa lớn, gắn 5 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "violent flame": {
    name: "Violent Flame", weaponOf: "Liu Martial Arts", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,8), d2 = r(6,16);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Đấm vào mặt kẻ thù, gây 3 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Đấm vào mặt kẻ thù, gây 6 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "dimensional rift": {
    name: "Dimensional Rift", weaponOf: "WARP Corp. Dagger", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const hasCharge = Math.random() < 0.5; // placeholder cho ≥15 Charge
      const d1 = hasCharge ? r(16,24) : r(6,12);
      return [
        hasCharge
          ? `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — *(≥15 Charge: tiêu 15 Charge)* Dice 1 đổi thành [16~24], gây 6 <:Rupture:1513762812722155682>Rupture`
          : `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Nhảy vọt không gian rồi cắt đứt kẻ địch, gây 3 <:Rupture:1513762812722155682>Rupture và nhận 4 Charge`,
      ];
    },
  },
  "dimensional rift gauntlets": {
    name: "Dimensional Rift", weaponOf: "WARP Corp. Gauntlets", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const hasCharge = Math.random() < 0.5; // placeholder cho ≥15 Charge
      const d1 = hasCharge ? r(12,16) + 5 : r(12,16);
      return [
        hasCharge
          ? `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — *(≥15 Charge: +5 <:DiceUp:1513767795681398894>Dice Up)* Túm kẻ địch, dao không gian cắt đứt chúng, gây 3 <:Rupture:1513762812722155682>Rupture và nhận 3 Charge`
          : `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Túm kẻ địch, dao không gian cắt đứt chúng, gây 3 <:Rupture:1513762812722155682>Rupture và nhận 3 Charge`,
      ];
    },
  },
  "the udjat": {
    name: "The Udjat", weaponOf: "Udjat Khopesh", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,12), d2 = r(5,7), d3 = r(5,8);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Nhảy lên đâm xuống, nhận 2 Protection`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Vung kiếm ngang, nhận 1 Protection`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Tiếp tục vung ngang`,
      ];
    },
  },
  "moulinet": {
    name: "Moulinet", weaponOf: "Seven Association Longsword", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(7,10), d3 = r(12,14);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Chém ngang, gây 1 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Vung kiếm lên, gây 1 <:Rupture:1513762812722155682>Rupture`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Các động tác tạo hình số 7 rồi nổ tung, gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "unyielding strike": {
    name: "Unyielding Strike", weaponOf: "Augury Spear", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x (2x nếu kích <:TremorBurst:1513802464632246352>Tremor Burst)",
    roll() {
      const d1 = r(6,16);
      return [
        `*[Nếu địch ≥5 <:Tremor:1513762737388257380>Tremor trước khi gây dmg: thêm 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst kẻ địch]*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Lướt lên cường hóa tay rồi đấm kẻ địch, gây 5 <:Tremor:1513762737388257380>Tremor và nhận 1 Trigram`,
      ];
    },
  },
  "true trigram formation": {
    name: "True Trigram Formation", weaponOf: "Augury Spear", tags: "Weapon",
    cost: "Cần đủ 4 Trigram", cd: "—", diceMul: "1x (2x nếu kích <:TremorBurst:1513802464632246352>Tremor Burst)",
    roll() {
      const d1 = r(8,14), d2 = r(9,18);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — Đâm ngọn giáo về phía trước, gây 4 <:Tremor:1513762737388257380>Tremor. Tiêu toàn bộ Trigram; nếu địch ≥5 <:Tremor:1513762737388257380>Tremor sẽ <:TremorBurst:1513802464632246352>Tremor Burst`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Ngọn giáo biến thành vô số lưỡi nhọn đâm kẻ địch, gây 3 <:Paralyze:1513763316479295548>Paralyze. Nếu địch ≥7 <:Tremor:1513762737388257380>Tremor: nhận Shield HP bằng <:Tremor:1513762737388257380>Tremor trên người chúng`,
      ];
    },
  },
  "eliminate": {
    name: "Eliminate", weaponOf: "Index Longsword", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    // Fragaria: "khi có Unlocked Blade thì dùng Eliminate sẽ TỰ ĐỘNG biến thành
    // Castigation, điều đó đồng nghĩa cả 2 SHARE CHUNG CD."
    // ⇒ cùng `cdGroup` (cdKeyFor quy về một ô đếm), và panel chỉ hiện MỘT trong
    // hai (xem encounter-panels.js) thay vì bày cả hai như trước.
    cdGroup: "index longsword strike",
    roll() {
      const d1 = r(6,12);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém ngang kẻ địch, gây 4 <:Rupture:1513762812722155682>Rupture. Nếu có **Unlocked Blade**: dùng tiếp Castigation`,
      ];
    },
  },
  "castigation": {
    name: "Castigation", weaponOf: "Index Longsword", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    // Fragaria: "khi có Unlocked Blade thì dùng Eliminate sẽ TỰ ĐỘNG biến thành
    // Castigation, điều đó đồng nghĩa cả 2 SHARE CHUNG CD."
    // ⇒ cùng `cdGroup` (cdKeyFor quy về một ô đếm), và panel chỉ hiện MỘT trong
    // hai (xem encounter-panels.js) thay vì bày cả hai như trước.
    cdGroup: "index longsword strike",
    roll() {
      const d1 = r(4,10), d2 = r(4,10), d3 = r(4,10), d4 = r(1,4);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Lao lên chém kẻ địch, gây 2 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Lướt quanh chém liên tục`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Kết thúc bằng một đòn chém ngang`,
        `${D4} **${d4 * 7}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — *(Dice ${d4} + bonus Dice×6)* sau đó xóa stack **Unlocked Blade**`,
      ];
    },
    // BUG ĐÃ SỬA (Fragaria: "castigation hoạt động không đúng") — dòng Dice 4 ghi
    // "Gây thêm bonus dmg = Dice x6" nhưng dmgStr tự dựng CHỈ lấy đúng con số
    // dice gốc, phần bonus ×6 KHÔNG BAO GIỜ được cộng (parser chỉ đọc `**N**`).
    // Sửa ngay tại nguồn: in ra con số ĐÃ GỒM bonus (d4 + d4×6 = d4×7) nên
    // dmgStr tự khớp, không cần luật riêng ở nơi khác. Số dice gốc vẫn hiện
    // trong ngoặc để người chơi kiểm chứng được.
    clearsUnlockedBlade: true,
  },
  "decapitation": {
    name: "Decapitation", weaponOf: "Index Cleaver", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15,22);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Bắn xích kéo kẻ địch lại gần rồi trảm đầu, gây 4 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "requiem": {
    name: "Requiem", weaponOf: "Fused Blade of Ruined Mirror Worlds", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,12), d2 = r(12,18);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Undodgeable] — Gây 2 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] [Undodgeable] — Gây 5 <:Sinking:1513762793436741652>Sinking, nhận 1 **Coffin**. +1 <:DiceUp:1513767795681398894>Dice Up cho mỗi Coffin (Max 10) và +1 <:DiceUp:1513767795681398894>Dice Up cho mỗi <:Sinking:1513762793436741652>Sinking trên địch (Max 8)`,
      ];
    },
  },
  "lament mourn and despair": {
    name: "Lament, Mourn and Despair", weaponOf: "Fused Blade of Ruined Mirror Worlds", tags: "Weapon",
    cost: "Chỉ dùng khi có Dullahan", cd: "2 Turn", diceMul: "1x (Dice âm)",
    roll() {
      const d1 = r(12,24), d2 = r(24,27);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] [AOE] — Gây 3 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] [AOE] — Gây 1 <:Sinking:1513762793436741652>Sinking, nhận 1 **Coffin**. +1 <:DiceUp:1513767795681398894>Dice Up/Coffin (Max 10), +1 <:DiceUp:1513767795681398894>Dice Up/<:Sinking:1513762793436741652>Sinking trên địch (Max 8), +3 <:DiceUp:1513767795681398894>Dice Up/Dullahan (Max 9)`,
        `*[Turn End sau khi dùng] mất hết stack Dullahan*`,
      ];
    },
  },
  "promised suffering": {
    name: "Promised Suffering", weaponOf: "Chains of Loyalty", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(6,8), d3 = r(7,10);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Túm kẻ địch quật ngã, gây 1 Fragile`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Tiếp tục, gây 1 Fragile`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — Đá thẳng vào mặt kết liễu, gây 2 Fragile và 1 <:VengeanceMark:1513768136023740436>Vengeance Mark. Nếu địch ≥3 <:VengeanceMark:1513768136023740436>Vengeance Mark: +2 Fragile/hit và +5% Dmg/<:VengeanceMark:1513768136023740436>Vengeance Mark`,
      ];
    },
  },
  "murche defensive": {
    name: "Murche Defensive", weaponOf: "Cinq Rapier", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,12), d2 = r(3,14);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Đâm kẻ thù, nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đâm kẻ thù, nhận 4 <:Fix_Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "viriscent pyrojade violet": {
    name: "Viriscent Pyrojade Violet", weaponOf: "Viriscent Pyrojade Ring", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,8), d2 = r(2,4), d3 = r(10,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — Đấm vào mặt kẻ thù, nhận 5 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — Đấm vào mặt kẻ thù, gây 4 <:Fix_Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — Đấm vào mặt kẻ thù, gây 4 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "durandal": {
    name: "Durandal", weaponOf: "Durandal", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(5,8), d3 = r(6,9);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — Chém kẻ địch một nhát`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Theo sau một nhát nữa`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Trảm xuống một đường, nhận 3 <:DiceUp:1513767795681398894>Dice Up đến hết turn`,
      ];
    },
    // diceEffects — GAP ĐÃ SỬA (xác nhận trực tiếp: "dice up của blade flourish
    // với durandal không áp dụng") — cấu trúc hoá hiệu ứng phụ TỪNG dice (thay
    // vì chỉ nằm trong TEXT mô tả, không tự động hoá được). Index khớp 1-1 với
    // vị trí trong mảng roll() TRẢ VỀ (0-based) — CHỈ áp dụng nếu dice đó THẬT
    // SỰ trúng (không bị né/chặn hoàn toàn, xem perHitMult trong index.js).
    diceEffects: [null, null, { diceUp: 3 }],
  },
  "mook workshop": {
    name: "Mook Workshop", weaponOf: "Mook Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    // maxUses: 3 = 1 lần gốc + tối đa 2 lần reuse (đúng theo mô tả "max 2 lần").
    // Lệnh -skill sẽ tự clamp số lần roll theo field này thay vì SKILL_MAX_ROLLS chung.
    maxUses: 3,
    // Fragaria chốt: "Mook Workshop, Thrust sẽ hỏi ý người chơi muốn reuse hay
    // không, còn lại là tự reuse". Mook khác Thrust ở chỗ roll() CHỈ sinh 1 dice
    // mỗi lần gọi → phải gọi LẶP (mode "repeat"), không như Thrust tự sinh cả chuỗi.
    reuseChoiceVariants: true,
    reuseSpec: {
      mode: "repeat",              // gọi roll(isReuse) nhiều lần rồi ghép dice
      resource: "light",
      // maxUses 3 = 1 gốc + tối đa 2 Reuse; mỗi Reuse tốn 1 Light nên còn bị
      // chặn thêm bởi số Light thật đang có.
      maxReuse: (light) => Math.min(2, Math.max(0, light ?? 0)),
      netCost: (n) => n,           // reuse tốn 1 Light/lần; +1 Light của đòn gốc
                                   // do parser selfLight lo (chỉ dòng gốc mới có)
      repeatArgs: (i) => [i > 0],  // roll(false) cho gốc, roll(true) cho reuse
    },
    // isReuse = true cho lần roll thứ 2 trở đi (do -skill mook workshop <n> gọi).
    // Theo mô tả: reuse mất hiệu ứng "nhận 1 Light" nhưng vẫn gây dmg 2 hit + Rupture như cũ.
    roll(isReuse = false) {
      const d1 = r(10,19);
      const lightText = isReuse ? "" : " và nhận 1 <:Light:1513786082502770719>Light";
      const reuseTag = isReuse ? " *(Reuse — tốn 1 <:Light:1513786082502770719>Light, không nhận Light)*" : "";
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Rút kiếm cắt không gian nơi kẻ địch đứng, gây dmg 2 hit${lightText} và gây 4 <:Rupture:1513762812722155682>Rupture${reuseTag}`,
      ];
    },
  },
  "slay all": {
    name: "Slay All", weaponOf: "Mook Workshop", tags: "Weapon",
    cost: "Cần kẻ địch Airborne", cd: "2 Turn", diceMul: "2x", 
    roll() {
      const d1 = r(10,19);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [AOE 5 người] — Rút kiếm cắt đứt toàn bộ không gian xung quanh, gây dmg 6 hit`,
      ];
    },
  },
  "crystal atelier": {
    name: "Crystal Atelier", weaponOf: "Crystal Atelier", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,11), d2 = r(7,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [AOE 2 người] — Đâm hai thanh kiếm vào kẻ địch, gây 2 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] [AOE 2 người] — Trảm ngang người chúng, gây 2 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "zelkova workshop": {
    name: "Zelkova Workshop", weaponOf: "Zelkova Workshop", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,9), d2 = r(8,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Dùng rìu chặt đứt kẻ địch, gây 4 <:Bleed:1513762688226955285>Bleed (turn sau) và 3 <:Fix_Bind:1513768025881317457>Bind`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Dùng chùy kết liễu, gây 6 <:Tremor:1513762737388257380>Tremor, 3 <:Fragile:1513763336167100536>Fragile và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "atelier logic shotgun": {
    name: "Atelier Logic: Shotgun", weaponOf: "Atelier Logic", tags: "Weapon",
    // BUG ĐÃ SỬA (Fragaria: "Critical của Atelier Logic Shotgun và Atelier Logic
    // Pistols phải SHARE CHUNG cd, hai cái CD riêng lẻ là sai với ý định thiết
    // kế và logic"). Cùng MỘT khẩu súng, bấm Critical là ĐỔI FORM — nên bắn
    // Shotgun rồi bắn tiếp Pistols ngay turn sau là né cooldown.
    // `cdGroup` hoạt động y hệt `pityGroup` của banner gacha: khai cùng nhóm thì
    // dùng CHUNG một ô đếm. Skill KHÔNG khai giữ nguyên hành vi cũ.
    cdGroup: "atelier logic",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,14);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Bóp cò Shotgun bắn kẻ địch, gây 3 <:Rupture:1513762812722155682>Rupture, sau đó đổi qua dạng Pistols`,
      ];
    },
  },
  "atelier logic pistols": {
    name: "Atelier Logic: Pistols", weaponOf: "Atelier Logic", tags: "Weapon",
    // BUG ĐÃ SỬA (Fragaria: "Critical của Atelier Logic Shotgun và Atelier Logic
    // Pistols phải SHARE CHUNG cd, hai cái CD riêng lẻ là sai với ý định thiết
    // kế và logic"). Cùng MỘT khẩu súng, bấm Critical là ĐỔI FORM — nên bắn
    // Shotgun rồi bắn tiếp Pistols ngay turn sau là né cooldown.
    // `cdGroup` hoạt động y hệt `pityGroup` của banner gacha: khai cùng nhóm thì
    // dùng CHUNG một ô đếm. Skill KHÔNG khai giữ nguyên hành vi cũ.
    cdGroup: "atelier logic",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,9), d2 = r(7,10);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — Dùng Pistol bên trái bắn kẻ địch, gây 2 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — Kết thúc bằng Pistol bên phải, gây 2 <:Fix_Burn:1513762753691652177>Burn, đổi về dạng Shotgun`,
      ];
    },
  },
  "old boys workshop": {
    name: "Old Boys Workshop", weaponOf: "Old Boys Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,4), d2 = r(5,7), d3 = r(7,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Đập búa xuống, gây 1 <:Tremor:1513762737388257380>Tremor`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Thêm 1 nhát búa, gây 1 <:Tremor:1513762737388257380>Tremor`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Tụ lực giáng đòn cuối, gây 5 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "wheels industry": {
    name: "Wheel's Industry", weaponOf: "Wheel's Industry", tags: "Weapon",
    // Fragaria xác nhận trực tiếp: "CD critical của Wheel Industry chưa thành 3
    // turn sửa nó thành CD 3 turn".
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,24);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Guard Break] [AOE 3 người] — Lao lên bổ xuống kẻ địch, gây 10 <:Tremor:1513762737388257380>Tremor`,
        // Tremor Burst CÓ ĐIỀU KIỆN nên KHÔNG viết trên dòng dice: parser
        // (extractAutoStatusTags) sẽ auto-gắn vào dmgStr bất kể điều kiện.
        // Điều kiện thật xử lý ở resolve-pending-action.js.
        `*Nếu địch có ≥20 <:Tremor:1513762737388257380>Tremor sau đòn này: gây thêm <:TremorBurst:1513802464632246352>Tremor Burst*`,
      ];
    },
  },
  "allas workshop": {
    name: "Allas Workshop", weaponOf: "Allas Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,18);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — Dùng ngọn thương đâm xuyên kẻ địch trong chớp mắt, nhận 6 <:Poise:1513762945715142736>Poise. **Chắc chắn Crit**`,
      ];
    },
  },
  "ranga workshop": {
    name: "Ranga Workshop", weaponOf: "Ranga Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,7), d2 = r(3,7), d3 = r(4,10);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Lao lên chém kẻ địch bằng dao, gây 3 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Dùng vuốt nhọn cấu xé, gây 3 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] — Kết liễu bằng một cú vung, gây 2 <:Bleed:1513762688226955285>Bleed (turn sau). Nếu có >5 stack Realization: kích toàn bộ <:Bleed:1513762688226955285>Bleed hiện tại trên địch (không giảm count)`,
      ];
    },
  },
  "open wound": {
    name: "Open Wound", weaponOf: "Sharp Greatsword", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,4), d2 = r(3,6);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 4 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Gây 4 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "fallstar slayer": {
    name: "Fallstar Slayer [落星一殺]", weaponOf: "Moonlit Azure Blade", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,9);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Undodgeable]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém kẻ địch rồi tra kiếm, cắt đứt không gian. +1 <:DiceUp:1513767795681398894>Dice Up cho mỗi <:Poise:1513762945715142736>Poise trên người (Max 19)`,
        `*[Sau đó] tiêu toàn bộ <:Poise:1513762945715142736>Poise, tăng base dmg cho Dice 1 = (tổng <:Poise:1513762945715142736>Poise tiêu thụ) x3*`,
      ];
    },
  },
  "chop up": {
    name: "Chop Up", weaponOf: "Bug Arm", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(6,16);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Vung cánh tay bọ đâm vào tim kẻ địch`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Tiếp tục vung bổ chúng ra`,
      ];
    },
  },
  "sabre slash": {
    name: "Sabre Slash", weaponOf: "Family Heir Sabre", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "remise": {
    name: "Remise", weaponOf: "Family Heir Sabre", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 2 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "nightmare hunt": {
    name: "Nightmare Hunt", weaponOf: "Family Heir Sabre", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(10,13), d3 = r(13,16), d4 = r(13,16);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Sinking:1513762793436741652>Sinking. Nếu địch ≥10 <:Sinking:1513762793436741652>Sinking: tiêu hết và +3 <:DiceUp:1513767795681398894>Dice Up cho bản thân turn này và sau`,
      ];
    },
  },
  "grappling": {
    name: "Grappling", weaponOf: "Brawler", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    // BUG ĐÃ SỬA (Fragaria: "khi xài mấy weap không kích crit-2 khi đủ condition
    // ... Brawler"). Brawler KHÔNG có Critical thứ 2 riêng — Grappling là BIẾN
    // THỂ dice của chính nó, nên dùng cơ chế `variants` (như Extreme Edge) chứ
    // không phải bảng EXTRA_CRITICALS.
    // Luật (xác nhận trực tiếp): "là target đang Airborne, sau khi dùng xong kẻ
    // địch sẽ thoát khỏi Airborne và nhận 10 Dmg".
    // Biến thể được CHỌN TỰ ĐỘNG theo trạng thái địch (xem deriveAutoVariant ở
    // skill-verification.js) — người chơi không phải tự bấm chọn.
    // Phần "thoát Airborne + 10 Dmg" xử lý ở resolve-pending-action.js.
    variants: [
      { key: "normal", label: "Địch KHÔNG Airborne", emoji: "👊" },
      { key: "airborne", label: "Địch đang Airborne (Hakuda)", emoji: "🪁" },
    ],
    roll(variantKey = "normal") {
      if (variantKey === "airborne") {
        const dAir = r(14, 30);
        return [
          `*🪁 [Hakuda] Địch đang **Airborne** — sau đòn này địch rơi xuống, nhận thêm 10 Dmg.*`,
          `${D1} **${dAir}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Quật ngã kẻ địch, gây 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst, nhận 1 <:Light:1513786082502770719>Light`,
        ];
      }
      const d1 = r(7,15);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Quật ngã kẻ địch, gây 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst, nhận 1 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "tactical suppression": {
    name: "Tactical Suppression", weaponOf: "Eye Of Horus", tags: "Weapon",
    // KHÔNG có Dice — đây là kích hoạt trạng thái (khiêu khích + Shield HP kéo dài
    // 2 turn), không phải 1 đòn sát thương đơn thuần. KHÔNG TỰ ĐỘNG HOÁ (Shield HP/
    // Tremor Reverb/Charge Shield không nằm trong 7 status effect hệ thống track
    // được) — GM/player tự quản lý bằng tay khi dùng, hệ thống chỉ hiện lại đúng
    // mô tả gốc để tra cứu.
    cost: "—", cd: "3 Turn sau khi hết Shield HP", diceMul: "1x",
    roll() {
      return [
        `*[KHÔNG có Dice — kích hoạt trạng thái, không phải đòn sát thương]*`,
        `Khiêu khích toàn bộ kẻ địch, bản thân nhận 50 HP Shield × Số lượng người trên sân trong 2 Turn. Heal lại lượng máu = Lượng HP Shield hao hụt sau 2 turn.`,
        `— Nếu **Block** trong trạng thái này: húc vào 1 kẻ địch, kích hoạt Tremor Burst + Tremor Reverb lên kẻ địch.`,
        `— Nếu đánh thường trong trạng thái này: tiêu thụ toàn bộ Charge thành Charge Shield lên bản thân.`,
      ];
    },
  },
  "falco berigora": {
    name: "Falco Berigora", weaponOf: "Manifested E.G.O (Hoshino)", tags: "Weapon",
    cost: "?? Light", cd: "3 Turn", diceMul: "1x",
    // promptArg — hỏi người chơi bỏ RA BAO NHIÊU Light (dmg = 30 × số đó).
    // KHÔNG để bot tự quyết: đây là chi phí người chơi tự cân, giống Thrust.
    promptArg: {
      label: "Bỏ ra bao nhiêu Light?",
      // Trần lấy từ Light hiện có — deriveAutoPromptArg tự điền, người chơi chọn lại được.
      options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
    roll(lightSpent = 0) {
      const spent = Math.max(0, Math.floor(Number(lightSpent) || 0));
      const dmg = 30 * spent;
      return [
        // Dòng dice THẬT — parser tự dựng dmgStr từ đây.
        spent > 0
          ? `${D1} **${dmg}** [<:Pierce:1513768511179329556>Pierce] — dồn một viên cầu rồi bắn thẳng tới kẻ địch (30 × ${spent} Light bỏ ra)`
          : `${D1} *Không bỏ Light nào — đòn này không gây sát thương.*`,
        // ĐIỀU KIỆN — viết KHÔNG có động từ liền số để parser không tự áp
        // (bài học: bỏ sót thì GM gõ tay được, áp NHẦM thì phá cân bằng âm thầm).
        // Xử lý THẬT ở resolve-pending-action.js theo Sanity lúc đánh.
        `*Nếu Sanity ≤ -40: đối thủ chịu thêm 2 <:Paralyze:1513762878546051112>Paralyze*`,
        `*Nếu kẻ địch có <:Bleed:1513762688226955285>Bleed: tiêu hết Bleed, chuyển thành 2 Erosion*`,
      ];
    },
  },
  "wedjat": {
    name: "Wedjat", weaponOf: "Manifested E.G.O (Hoshino)", tags: "Weapon",
    cost: "— (chưa rõ Light cost)", cd: "1 Turn", diceMul: "1x",
    roll() {
      return [
        `${D1} Bắn 1 đòn Repeat Ammo [AOE/True Dmg], gây 5 Blind và 2 Bleed.`,
        `Nhận 100 HP Shield với TỪNG mục tiêu dính đòn.`,
        `*(Blind: khiến đòn đánh thường tiếp theo bị trượt)*`,
      ];
    },
  },
  "augury kick": {
    name: "Augury Kick", tags: "Tremor",
    cost: "4 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,9), d2 = r(18,26);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Đá thẳng đối thủ trước mặt lên trời, gây 8 <:Tremor:1513762737388257380>Tremor.`,
        // Điều kiện ">20 Tremor" KHÔNG viết trên dòng dice (parser auto-gắn bất
        // kể điều kiện) — xử lý thật ở resolve-pending-action.js. Disclaimer cũ
        // "GM/player tự áp, không tự động track" ĐÃ BỎ vì giờ tự động thật.
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unparriable][Undodgeable] — Nhảy lên đá thêm 1 phát khiến hắn đập mặt xuống đất, gây <:TremorBurst:1513802464632246352>Tremor Burst.`,
        `*Nếu địch có >20 <:Tremor:1513762737388257380>Tremor sau đòn này: bản thân nhận +2 <:DiceUp:1513767795681398894>Dice Up trong 2 Turn kế tiếp*`,
      ];
    },
  },
  "stob": {
    name: "Stob", weaponOf: "Dolch", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,9), d2 = r(11,15);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Đâm vào bụng kẻ địch, gây 4 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đâm tiếp, gây 4 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "thrust": {
    name: "Thrust",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    needsReuse: true,
    // Fragaria chốt trực tiếp: "Reuse hãy làm theo hướng 1 (bot tự quyết). TUY
    // NHIÊN có 1 số trường hợp như page Thrust sẽ HỎI Ý NGƯỜI CHƠI muốn reuse
    // hay không." → Thrust là ngoại lệ vì mỗi lần Reuse TIÊU Light thật của
    // người chơi (net −1/lần) — đó là quyết định tài nguyên, không phải xác
    // suất, nên bot không được quyết hộ.
    // Dùng cơ chế `variants` có sẵn (cùng đường với Extreme Edge / Re-Load):
    // dropdown hiện trước khi roll. Số lần chọn được KẸP lại theo Light thật
    // trong roll() nên chọn quá tay cũng không hỏng.
    reuseChoiceVariants: true,
    // reuseSpec — 1 NGUỒN SỰ THẬT cho: (a) số Reuse tối đa theo tài nguyên thật,
    // (b) Light thật sự bị trừ, (c) lọc dropdown chỉ hiện lựa chọn KHẢ THI.
    // Xem REUSE_SPEC_CONTRACT ở cuối file để biết ý nghĩa từng field.
    reuseSpec: {
      mode: "arg",                 // roll() tự sinh cả chuỗi reuse trong 1 lần gọi
      resource: "light",
      maxReuse: (light) => Math.min(9, Math.max(0, (light ?? 0) - 2)),
      netCost: (n) => n + 1,       // mỗi lần dùng net −1 Light (tốn 2, nhận 1)
      // roll() in "Nhận 1 Light" ở MỌI dòng → parser selfLight sẽ cộng lại
      // (n+1) Light, thành ra net = 0. netCost ở trên đã tính net rồi nên phải
      // TẮT nhánh parser để không cộng bù hai lần.
      suppressSelfLight: true,
    },
    promptArg: {
      label: "Light hiện tại",
      parse: (s) => parseInt(s.trim(), 10),
      validate: (v) => !isNaN(v) && v >= 2,
      errorMsg:
        "❓ **Thrust** cần nhập số Light hiện tại (tối thiểu 2).\n" +
        "> Cú pháp: `-skill thrust <light>`\n" +
        "> VD: `-skill thrust 4` → tự tính được Reuse tối đa (cap **9 lần**)\n" +
        "> *Mỗi lần dùng net −1 <:Light:1513786082502770719>Light. Reuse được khi còn ≥2, tối đa 9 lần dù dư Light*",
      buildHeader: (v, s) => {
        // Cap 9 lần Reuse theo spec gốc ("Có thể Reuse tối đa tới 9 lần") — trước đây
        // không có cap, light dư bao nhiêu là reuse hết bấy nhiêu (sai so với mô tả).
        const reuseTimes = Math.min(9, Math.max(0, v - 2));
        const finalLight = v - (reuseTimes + 1);
        return reuseTimes === 0
          ? `[Light: ${v}→${finalLight}] [Không đủ để Reuse] [CD: ${s.cd}]`
          : `[Reuse: ${reuseTimes} lần${reuseTimes === 9 ? " (đã chạm cap)" : ""}] [Light: ${v}→${finalLight}] [Dice Up lần cuối: +${reuseTimes * 5} <:DiceUp:1513767795681398894>] [CD: ${s.cd}]`;
      },
    },
    roll(light = 4, reuseChoice = "max") {
      // Cap 9 lần Reuse theo spec gốc, dù light dư nhiều hơn mức cần cho 9 lần.
      const maxReuse = Math.min(9, Math.max(0, light - 2));
      // reuseChoice do NGƯỜI CHƠI chọn (variants ở trên). Luôn KẸP theo Light
      // thật: chọn 9 mà chỉ đủ 3 thì ra 3, không bao giờ tiêu quá số Light có.
      // "max"/không chọn → giữ nguyên hành vi cũ (reuse hết mức).
      const wanted = (reuseChoice === "max" || reuseChoice === undefined || reuseChoice === null)
        ? maxReuse
        : Math.max(0, parseInt(reuseChoice, 10) || 0);
      const reuseTimes = Math.min(maxReuse, wanted);
      const DICE_EMOJIS = [D1, D2, D3, D4, D5];
      const getEmoji = (i) => DICE_EMOJIS[Math.min(i, DICE_EMOJIS.length - 1)];
      const L = "<:Light:1513786082502770719>Light";
      const DU = "<:DiceUp:1513767795681398894>";
      const PIERCE = "[<:Pierce:1513768511179329556>Pierce]";

      const lines = [];
      let curLight = light;

      // ── Đòn gốc ─────────────────────────────────────────────────────────────
      const d0 = r(3, 5);
      curLight = curLight - 2 + 1; // tốn 2, nhận 1
      lines.push(
        `${D1} **${d0}** ${PIERCE} [Guard Break] — Nhận 1 ${L} *(còn **${curLight}** ${L})*` +
        (reuseTimes > 0 ? ` | +5 ${DU} Dice Up cho Reuse tiếp theo` : "")
      );

      // ── Các lần Reuse ────────────────────────────────────────────────────────
      for (let i = 1; i <= reuseTimes; i++) {
        const diceUp = i * 5;
        const base = r(3, 5);
        const total = base + diceUp;
        const emoji = getEmoji(i);
        const isLast = i === reuseTimes;
        curLight = curLight - 2 + 1;

        lines.push(
          `${emoji} ↩️ **Reuse ${i}** — **${total}** (${base} +${diceUp} ${DU}) ${PIERCE} [Guard Break] — Nhận 1 ${L} *(còn **${curLight}** ${L})*` +
          (!isLast ? ` | +${(i + 1) * 5} ${DU} Dice Up cho Reuse tiếp theo` : "")
        );
      }

      // ── Tổng kết ─────────────────────────────────────────────────────────────
      lines.push(
        `📊 *Light còn lại: **${curLight}** ${L}` +
        (reuseTimes > 0 ? ` | Dice Up lần cuối: **+${reuseTimes * 5}**` : "") +
        `*`
      );

      return lines;
    },
  },
  "slice": {
    name: "Slice", weaponOf: "Scythe of Sorrow", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(10,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên xoay lưỡi hái cắt mọi thứ`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Tiếp tục cắt, gắn 6 <:Sinking:1513762793436741652>Sinking (turn sau)`,
      ];
    },
  },
  "breakam slash": {
    name: "Breakam Slash", weaponOf: "Breakam Zeztzer", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "2x",
    // [Khuếch tán N mục tiêu] — KHÁC AOE (Fragaria chốt trực tiếp): mục tiêu
    // CHÍNH chịu 100% dmg, các mục tiêu CÒN LẠI chỉ chịu 50%. AOE thì mọi mục
    // tiêu đều 100%. Tag này TRƯỚC ĐÂY chỉ là chữ trong text, không có mã nào
    // đọc → khuếch tán chạy y hệt AOE.
    spreadTargets: 3, spreadFalloffPct: 0.5,
    roll() {
      const d1 = r(8,20);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Phủ thanh kiếm năng lượng xanh rồi chém ngang cắt đứt kẻ địch`,
      ];
    },
  },
  "breakam bullet": {
    name: "Breakam Bullet", weaponOf: "Breakam Zeztzer: Gun Mode", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "2x",
    roll() {
      const d1 = r(10,17);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unevadeable] [Guard Break] [AOE 3 người] — Tụ lực bắn một đường đạn cực mạnh vào đối phương`,
      ];
    },
  },
  "backflip & shoot": {
    name: "Backflip & Shoot", weaponOf: "Double Handgun", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,9), d2 = r(7,10);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Nhảy lùi ra sau bắn kẻ địch`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Bắn tiếp lần thứ hai`,
      ];
    },
  },
  "blinkstep": {
    name: "Blinkstep", weaponOf: "Mao Branch Sword", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,13);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém kẻ địch hai lần liên tiếp, gây 3 <:Rupture:1513762812722155682>Rupture. Nếu ≥5 <:Fix_Haste:1513768004222062632>Haste: tái sử dụng skill này một lần nữa`,
      ];
    },
  },
  "jack of all trades": {
    name: "Jack of All Trades", weaponOf: "Thiên Cỏ Vạn", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,8), d2 = r(3,5), d3 = r(22,35), d4 = r(10,17);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Cung Void`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Dù-Khiên`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — Đại Kiếm`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] — Trường Thương`,
      ];
    },
  },
  "beam of nihil": {
    name: "Beam Of Nihil", weaponOf: "Manifested E.G.O: Nihil", tags: "Weapon",
    cost: "5 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(24,40);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] [Unparriable] [AOE 2 người] — Tạo tia sáng năng lượng hư vô bắn vào kẻ địch. Nhận 7 <:Fix_Haste:1513768004222062632>Haste và gây 14 <:Bleed:1513762688226955285>Bleed, 8 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "abyssial life": {
    name: "Abyssial Life", weaponOf: "Manifested E.G.O: Nihil", tags: "Weapon",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,5);
      return [
        `${D1} **${d1}** — Nhận số stack **Nihil** tương ứng. Mỗi Nihil: +10% Dmg, +2% Hút máu (Max 5, mất khi end turn)`,
      ];
    },
  },
  "meaningless struggle": {
    name: "Meaningless Struggle (Phản Kháng Vô Nghĩa)", weaponOf: "Void-Scythe: Nihilism", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,18), d2 = r(21,30);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Uplift] — Hất tung vũ khí địch, áp 6 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Trúng đích, áp 2 Freeble (giảm 4 Dice mọi kỹ năng turn sau)`,
      ];
    },
  },
  "trailing blade": {
    // Bản cập nhật mới nhất theo spec người dùng cung cấp — đè lên bản cũ (cũ chỉ có
    // flavor "cắt mọi thứ"/"tiếp tục xoay", không có hiệu ứng Poise/Spectro Frazzle).
    name: "Trailing Blade", weaponOf: "Ages of Harvest [Peach Blossom]", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10), d2 = r(3,12), d3 = r(8,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Điều khiển thanh kiếm xoay một vòng tròn xung quanh bản thân, cắt mọi thứ, nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Tiếp tục xoay, nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — Tiếp tục xoay, nhận 3 <:Poise:1513762945715142736>Poise và gây 2 **Spectro Frazzle**`,
      ];
    },
  },
  "overpower": {
    name: "Overpower", weaponOf: "Fixer's Blade", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,15);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Đâm vào bụng kẻ địch rồi nhanh chóng vung bổ xuống, áp 4 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "life taker": {
    name: "Life Taker", weaponOf: "Havoc Scythe", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(17,26);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Vung lưỡi hái hút sinh lực kẻ địch, gây 5 Havoc Bane và hồi máu = 50% Dmg gây ra`,
      ];
    },
  },
  "instant of annihilation": {
    name: "Instant of Annihilation", weaponOf: "Manifested E.G.O (Havoc)", tags: "Weapon",
    cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,12), d2 = r(10,13);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Sải cánh bay lại gần kẻ địch rồi quật bằng cánh`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Tạo ngọn thương Havoc đâm chúng, gây 10 Havoc Bane`,
      ];
    },
  },
  "deadening abyss": {
    name: "Deadening Abyss", weaponOf: "Manifested E.G.O (Havoc)", tags: "Weapon",
    cost: "5 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(21,30);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] [AOE 3 người] — Nổ năng lượng phía trước. +2 <:DiceUp:1513767795681398894>Dice Up cho mỗi Havoc Bane trên kẻ địch, sau đó tiêu toàn bộ`,
      ];
    },
  },
  "solemn lament for the living": {
    name: "Solemn Lament for the Living", weaponOf: "Solemn Lament Pistols", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,8), d2 = r(10,15);
      return [
        `*[Mỗi Dice có thể tốn 5 viên đạn <:The_Living_The_Departed:1528452731147391137>The Living and The Departed để +1 <:DiceUp:1513767795681398894>Dice Up/Dice và +1 <:Sinking:1513762793436741652>Sinking mỗi viên]*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Bắn liên tục vào kẻ địch`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Lao tới bắn phát cuối, gây 3 <:Sinking:1513762793436741652>Sinking. Tùy theo <:Sinking:1513762793436741652>Sinking trên địch: 0 → -2 <:DiceDown:1513767826257874964>Dice Down | 1-19 → 6 <:Fix_Bind:1513768025881317457>Bind | ≥20 → 6 Fragile`,
      ];
    },
  },
  "kaen jujizan": {
    name: "Kaen Jūjizan", weaponOf: "Kaenken Rekka", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x (2x nếu địch >10 <:Fix_Burn:1513762753691652177>Burn)",
    // [Khuếch tán N mục tiêu] — KHÁC AOE (Fragaria chốt trực tiếp): mục tiêu
    // CHÍNH chịu 100% dmg, các mục tiêu CÒN LẠI chỉ chịu 50%. AOE thì mọi mục
    // tiêu đều 100%. Tag này TRƯỚC ĐÂY chỉ là chữ trong text, không có mã nào
    // đọc → khuếch tán chạy y hệt AOE.
    spreadTargets: 3, spreadFalloffPct: 0.5,
    roll() {
      const d1 = r(6,20);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém kẻ địch, triệu hồi rồng lửa cuốn vòng rồi tung chuỗi chém, gây 6 <:Fix_Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "crash hissatsu giri": {
    name: "Crash Hissatsu Giri", weaponOf: "Kaenken Rekka", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1.75x",
    roll() {
      const d1 = r(24,32);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [True DMG] [Guard Break] [Chỉ dùng khi ở Primitive Dragon] — Triệu hồi Void Talon, kéo kẻ địch lại gần rồi tung một đòn chém`,
      ];
    },
  },
  "shinra banshozan": {
    name: "Shinra Banshozan", weaponOf: "Kaenken Rekka", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1.75x",
    roll() {
      const d1 = r(24,32);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Elemental Dragon] — Tích tụ toàn bộ nguyên tố vào kiếm rồi chém kẻ địch, gây 7 Hex`,
      ];
    },
  },
  "barrage": {
    name: "Barrage", weaponOf: "Star Platinum", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,15);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
      ];
    },
  },
  "punishment": {
    name: "Punishment", weaponOf: "Beak Mace", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,30);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Cây chùy biến thành vô số xúc tu nuốt chửng kẻ địch, gây 6 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "piercing": {
    name: "Piercing", weaponOf: "Sharp Spear", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,12);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt đâm xuyên người kẻ địch, gây 9 <:Bleed:1513762688226955285>Bleed (turn sau)`,
      ];
    },
  },
  "mighty critical finish": {
    name: "Mighty Critical Finish", weaponOf: "Gashacon Breaker", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,19);
      return [
        `${D1} **${d1}** [Blunt/Slash] — Phủ năng lượng vào vũ khí rồi tấn công. Chắc chắn crit; dmg type đổi theo dạng vũ khí đang dùng`,
      ];
    },
  },
  "mighty critical strike": {
    name: "Mighty Critical Strike", weaponOf: "Gamer Driver", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10), d2 = r(10,18);
      return [
        `**[<:Blunt:1513768529718022254>Blunt] — Chắc chắn crit**`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Nhảy vào đá kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Liên tục đá rồi kết thúc bằng một đòn đá mạnh`,
      ];
    },
  },
  "mighty double critical strike": {
    name: "Mighty Double Critical Strike", weaponOf: "Gamer Driver", tags: "Weapon",
    cost: "Chỉ khi ở Level 20", cd: "2 Turn", diceMul: "2x",
    roll() {
      const d1 = r(5,10), d2 = r(10,18);
      return [
        `**[<:Blunt:1513768529718022254>Blunt] — Chắc chắn crit**`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Cùng bản thể còn lại nhảy vào đá kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — Cả hai liên tục đá rồi kết thúc bằng một đòn đá mạnh`,
      ];
    },
  },

  // ── Lævateinn ──
  "laevateinn": {
    name: "Lævateinn", tags: "Weapon",
    weaponType: "??? → Heavy → Medium → Light",
    weaponDmg: "??? → 30 [Blunt] → 35 [Blunt] → 20 [Slash] → 13 [Slash]",
    passive: [
      `**Rule Violation** — Mỗi 1 Turn: hai đòn tấn công đầu tiên bạn chịu từ kẻ thù phản 1/2 Dmg về cho chúng (Type: <:Blunt:1513768529718022254>Blunt; <:Slash:1513768633434640517>Slash từ Seal 2+). Mỗi đòn gây cho chúng 5 <:Fragile:1513763336167100536>Fragile và 1 <:VengeanceMark:1513768136023740436>Vengeance Mark. +10 Minimum Dice từ Follow Up Attack [Follow Up / Pounce]`,
      `**Sealed Sword [Lævateinn]** — Khởi đầu là Heavy Weapon với 30 Base Dmg [<:Blunt:1513768529718022254>Blunt]. Mỗi khi dùng 1 Page của **Middle Syndicate**: nhận 1 Stack **Rising Fever**. Mọi Bonus Dmg <:Blunt:1513768529718022254>Blunt % chuyển sang Dmg Type tương ứng với đòn gây ra. Mỗi khi mở khoá một lớp phong ấn: thi triển ngay 1 đòn tấn công với số Dice bằng tổng lượng stack **Rising Fever** hiện có. Khi mở khoá phong ấn cuối: nhận hiệu ứng **Ridiculous Grit** duy trì đến hết Encounter.\n` +
      `> — **10 Rising Fever** → Seal 1: Base Dmg 35 [<:Blunt:1513768529718022254>Blunt], +50% Dmg. Mọi đòn đánh áp 1 <:Bleed:1513762688226955285>Bleed + 1 <:Fix_Burn:1513762753691652177>Burn\n` +
      `> — **20 Rising Fever** → Seal 2: Medium Weapon, Base Dmg 20 [<:Slash:1513768633434640517>Slash], +100% Dmg. Mọi đòn đánh áp 2 <:Bleed:1513762688226955285>Bleed + 2 <:Fix_Burn:1513762753691652177>Burn\n` +
      `> — **30 Rising Fever** → Seal 3: Light Weapon, Base Dmg 13 [<:Slash:1513768633434640517>Slash], +200% Dmg. Mọi đòn đánh áp 4 <:Bleed:1513762688226955285>Bleed + 4 <:Fix_Burn:1513762753691652177>Burn. Toàn bộ đồng minh lẫn kẻ thù chịu 20 <:Fix_Burn:1513762753691652177>Burn vào đầu mỗi turn`,
      `**Time to Revenge** — Nếu mục tiêu có từ 3 / 6 / 9 <:VengeanceMark:1513768136023740436>Vengeance Mark: tăng số lượng stack **Rising Fever** có thể nhận thêm 1 / 2 / 3. (Tối đa 2 lần mỗi turn)`,
    ].join("\n"),
    cost: "—", cd: "—", diceMul: "—",
    roll() { return [`*(Đây là passive/weapon entry — dùng tên skill cụ thể để roll)*`]; },
  },
  "stomping": {
    name: "Stomping", weaponOf: "Lævateinn", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,13), d2 = r(10,15);
      return [
        `*+5% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Dặm đất, gây 5 <:Fragile:1513763336167100536>Fragile`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — Đá vào kẻ địch, gây 5 <:Fragile:1513763336167100536>Fragile và 1 <:VengeanceMark:1513768136023740436>Vengeance Mark. Cho bản thân 1 Stack **Rising Fever**`,
      ];
    },
  },
  "ill gut you like a fish": {
    name: "I'll Gut You Like a Fish", weaponOf: "Lævateinn [Seal 1+]", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(12,13), d3 = r(11,12);
      return [
        `*+5% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Đá kẻ địch lên trời, gây 5 <:Fragile:1513763336167100536>Fragile`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Chém chúng bằng thanh kiếm, gây 5 <:Fragile:1513763336167100536>Fragile`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Cắt ngay lập tức, gây 5 <:Fragile:1513763336167100536>Fragile và 1 <:VengeanceMark:1513768136023740436>Vengeance Mark. Cho bản thân 1 Stack **Rising Fever**`,
      ];
    },
  },
  "dont let somethin like this break you": {
    name: "Don't Let Somethin' Like This Break You!", weaponOf: "Lævateinn [Seal 1+]", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,12), d2 = r(12,13), d3 = r(11,15);
      return [
        `*+5% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Bổ cự kiếm vào kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Quẹt ngang ngay lập tức`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Vung lên, gây 1 <:VengeanceMark:1513768136023740436>Vengeance Mark. Cho bản thân 2 Stack **Rising Fever**`,
      ];
    },
  },
  "gut stab laevateinn": {
    name: "Gut Stab [Lævateinn]", weaponOf: "Lævateinn [Seal 2+]", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(12,13), d3 = r(7,7), d4 = r(8,8), d5 = r(10,13);
      return [
        `*+5% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch* [Unblockable]`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Đá kẻ địch lên trời`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] — Quẹt ngang ngay lập tức`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Đâm thanh kiếm vào kẻ địch`,
        `${D4} **${d4}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Tiếp tục đâm liên tục`,
        `${D5} **${d5}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Rút ra rồi kết thúc bằng một đòn đâm, gây 1 <:VengeanceMark:1513768136023740436>Vengeance Mark. Cho bản thân 2 Stack **Rising Fever**`,
      ];
    },
  },
  "stamp of vengeance maximum": {
    name: "Stamp of Vengeance [Maximum]", weaponOf: "Lævateinn", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8,12), d2 = r(7,8), d3 = r(13,15), d4 = r(16,24);
      return [
        `*+10% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] — Đá kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] — Ngay sau đó là một cú đá lên`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] — Lấy đà thêm một cú nữa`,
        `${D4} **${d4}** [<:Blunt:1513768529718022254>Blunt] [Unevadeable] [Guard Break] — Nhảy lên trời rồi chốt hạ bằng một đòn chẻ bằng chân. Cho bản thân **3 Stack Rising Fever**`,
      ];
    },
  },
  "complete and total extermination laevateinn": {
    name: "Complete and Total Extermination [Lævateinn]", weaponOf: "Lævateinn [Seal 3]", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,12), d2 = r(12,13), d3 = r(13,15), d4 = r(18,24), d5 = r(30,35);
      return [
        `*+10% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `*Skill này luôn dùng Dice cuối để clash; nếu clash thua, kẻ địch nhận 30% Dmg gốc*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unevadeable] [Guard Break] — Bổ kiếm vào kẻ địch`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unevadeable] [Guard Break] — Quẹt ngang ngay lập tức`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Unevadeable] [Guard Break] — Vung lên, gây 1 <:VengeanceMark:1513768136023740436>Vengeance Mark`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] [Unevadeable] [Guard Break] — Vung xuống một cú mạnh`,
        `${D5} **${d5}** [<:Pierce:1513768511179329556>Pierce] [Unevadeable] [Guard Break] — Ném thanh kiếm găm vào lồng ngực rồi nhảy vào đá xuyên qua kẻ địch, kết liễu chúng`,
      ];
    },
  },
  "good girl your sacrifice for the family wont be forgotten": {
    name: "Good Girl. Your Sacrifice for the Family Won't Be Forgotten.", weaponOf: "Lævateinn [Seal 3]", tags: "Weapon",
    cost: "Chỉ dùng khi đồng minh dưới 20% HP (50% nếu từ Middle)", cd: "—", diceMul: "1x",
    roll() {
      const d1 = r(18,24);
      return [
        `*+10% Dmg cho skill này với mỗi <:VengeanceMark:1513768136023740436>Vengeance Mark có trên kẻ địch*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unclashable] [Undodgeable] [Unparriable] [Unblockable] — Khi đồng đội chuẩn bị chết, cắt cả hai ra, giết chết đồng minh và gây sát thương lên kẻ địch. Nhận 1 hiệu ứng **Revenge For My Family** duy trì 2 turn; nếu kích hoạt đủ 3 lần sẽ duy trì đến hết Encounter. Nếu đồng minh thuộc Middle Syndicate: kích hoạt vĩnh viễn`,
      ];
    },
  },

  // ══════════════ Poise / Slash ══════════════
  "draw of the sword": {
    name: "Draw of The Sword",
    tags: "Poise",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,3), d2 = r(2,4);
      return [
        `*On Use — ngay khi sử dụng: nhận 2 <:Poise:1513762945715142736>Poise [<:Slash:1513768633434640517>Slash]*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — nhận 2 <:Poise:1513762945715142736>Poise; tiêu thụ 6 <:Poise:1513762945715142736>Poise để nhận 2 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "acupuncture": {
    name: "Acupuncture",
    tags: "Poise",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,3), d2 = r(6,12), d3 = r(2,6);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — nhận 3 <:Poise:1513762945715142736>Poise và gây 1 <:Paralyze:1513763316479295548>Paralyze`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — nhận 2 <:Poise:1513762945715142736>Poise; nếu bạn có ≥8 <:Poise:1513762945715142736>Poise nhận thêm 1 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "deep cuts": {
    name: "Deep Cuts",
    tags: "Poise/Haste",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(8,10), d3 = r(9,12);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — chém ngang cắt kẻ địch, nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — chém ngang cắt kẻ địch, nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — sau đó đâm sâu, nhận 4 <:Fix_Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "preemptive strike": {
    name: "Preemptive Strike",
    tags: "Rupture",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1.1x",
    roll() {
      const d1 = r(7,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — chém dọc xuống, gây 4 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "opportunistic slash": {
    name: "Opportunistic Slash",
    tags: "Haste",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "2x",
    roll() {
      const d1 = r(5,12);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — lướt qua người kẻ địch rồi chém, nhận 3 <:Fix_Haste:1513768004222062632>Haste và gây 3 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },
  "focused strikes": {
    name: "Focused Strikes",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,8), d2 = r(5,8), d3 = r(8,12);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — chém ngang kẻ địch`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — chém ngang một lần nữa`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Guard Break] — kết thúc bằng một cú đâm tới`,
      ];
    },
  },
  "mutilate": {
    name: "Mutilate",
    cost: "3 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "3x",
    roll() {
      const isProc = Math.random() < 0.2;
      const d1 = isProc ? 30 : r(1,5);
      return [
        isProc
          ? `*🔥 20% kích hoạt — Dice 1 trở thành [30~30]! [AOE 3 người]*`
          : `*20% cơ hội đổi Dice 1 thành [30~30] [AOE 3 người]*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — lao tới chém kẻ địch liên tục${isProc ? " [AOE 3 người]" : ""}`,
      ];
    },
  },

  // ══════════════ Haste / Movement ══════════════
  "fleet footsteps": {
    name: "Fleet Footsteps",
    tags: "Haste",
    reactiveOnly: true, // xem comment ở "light dash" — cùng lý do (né 1 đòn + 2 Haste)
    // Fragaria: "Thêm tag unclashable cho pounce, follow-up, light dash,
    // fleetfoot steps và borrowed eyes" — `unclashable` là CỜ DỮ LIỆU (bộ chọn
    // Clash của người chơi LẪN AI đều lọc theo nó), còn tag [Unclashable] viết
    // trong dòng roll() là phần NGƯỜI CHƠI ĐỌC + để parser phòng thủ bắt được.
    unclashable: true,

    cost: "0 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,10);
      return [
        `${D1} **${d1}** [Unclashable] — dịch chuyển lại gần kẻ địch, né 1 đòn tấn công (không thể né Undodgeable), sau đó nhận 2 <:Fix_Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "charge and cover": {
    name: "Charge and Cover",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,7);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] — nhảy vụt lên đâm kẻ địch rồi lùi lại, né 1 đòn tấn công (không thể né Undodgeable) trong lúc gây Dmg`,
      ];
    },
  },

  // ══════════════ Blunt / Fragile / Tremor ══════════════
  "alleyway counter": {
    name: "Alleyway Counter",
    tags: "Fragile",
    // BUG ĐÃ SỬA (Fragaria: "Alleyway Counter đang là page thường có thể sử dụng
    // được ở Moves thay vì được xét là counter ở reactive defense").
    // Text ghi rõ "NGẮT và counter một đòn của kẻ địch" — đó là hành vi phản ứng,
    // không phải đòn chủ động. Thiếu `counterEffect` nên nó vừa lọt vào dropdown
    // Moves (isReactiveOnlyPage trả false) vừa KHÔNG hiện nút counter lúc bị đánh.
    // Khai `counterEffect` là sửa CẢ HAI cùng lúc: encounter-panels.js loại nó
    // khỏi Moves, reactive-defense.js đưa nó vào danh sách nút Counter.
    // `{}` = counter chuẩn: thắng thì ngắt đòn + gây dmg phản (dice + 5 Fragile
    // do parser tự gắn), không có hiệu ứng phụ đặc biệt.
    counterEffect: {},
    cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,15);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — ngắt và counter một đòn của kẻ địch, gây 5 <:Fragile:1513763336167100536>Fragile`,
      ];
    },
  },
  "right hook": {
    name: "Right Hook",
    tags: "Tremor",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,13);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — tung một cú móc hàm bằng tay phải, gây 4 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
  "sky kick": {
    name: "Sky Kick",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,8);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — đá kẻ địch lên trời gây 1 **[Airborne]**`,
      ];
    },
  },
  "drop kick": {
    name: "Drop Kick",
    tags: "Fragile",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,15);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — lao vào Drop Kick kẻ địch, gây 5 <:Fragile:1513763336167100536>Fragile`,
      ];
    },
  },
  "backstreets scramble": {
    name: "Backstreets Scramble",
    tags: "Fragile",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,5), d2 = r(6,10), d3 = r(7,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — móc hàm kẻ địch`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — móc hàm một lần nữa, đánh bay kẻ địch lên trời`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — nhảy lên đập chúng xuống, gây 5 <:Fragile:1513763336167100536>Fragile`,
      ];
    },
  },
  "stylish sweeps": {
    name: "Stylish Sweeps",
    tags: "Sinking",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,6), d2 = r(6,7), d3 = r(7,8);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — đá kẻ địch, gây 3 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unblockable] — đá kẻ địch, gây 3 <:Sinking:1513762793436741652>Sinking`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đá kẻ địch, gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "shocking blow": {
    name: "Shocking Blow",
    tags: "Fragile",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — đấm móc kẻ địch, gây 5 <:Fragile:1513763336167100536>Fragile và 1 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },

  // ══════════════ Support / Pierce ══════════════
  "onslaught command": {
    name: "Onslaught Command",
    cost: "2 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,16);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — gia tăng 4 <:DiceUp:1513767795681398894>Dice Up trong 2 Turn cho toàn bộ đồng đội`,
      ];
    },
  },

  // ══════════════ Paint Over ══════════════
  "paint over": {
    name: "Paint Over",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10), d2 = r(5,10);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gắn 2 <:Bleed:1513762688226955285>Bleed`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — gắn 2 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },

  // ══════════════ Mighty Attack ══════════════
  "mighty attack": {
    name: "Mighty Attack",
    cost: "3 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,8), d2 = r(6,8);
      return [
        `*Khi sử dụng: nhận 2 <:Attack_Power_Up:1375189059978133676>Attack Power Up và 2 <:Unopposed_Attack_Boost:1375796883351666738>Unopposed Attack Boost cho đến hết turn*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — lao vào đá kẻ địch, gây 2 <:Smoke:1513778039610282015>Smoke`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — kết thúc bằng một cú đấm, gây 2 <:Smoke:1513778039610282015>Smoke`,
      ];
    },
  },

  // ══════════════ Weapon Criticals — Solemn Lament Pistols ══════════════
  "celebration for the departed": {
    name: "Celebration for the Departed", weaponOf: "Solemn Lament Pistols", tags: "Weapon",
    cost: "Tối thiểu 2 đạn", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8), d2 = r(8,12);
      return [
        `*+1 Clash Power với mỗi viên đạn <:The_Living_The_Departed:1528452731147391137>The Living & The Departed; áp 2 <:Sinking:1513762793436741652>Sinking khi Clash thắng; +1 <:DiceUp:1513767795681398894>Dice Up với mỗi 5 **Butterfly** kẻ địch có*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây **Butterfly**`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây **Butterfly**`,
      ];
    },
  },
    "the solemn lament for the living": {
    name: "Solemn Lament for the Living", weaponOf: "Solemn Lament Pistols", tags: "Weapon",
    cost: "Tối thiểu 2 đạn", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,10), d2 = r(10,16);
      return [
        `*+1 Clash Power với mỗi viên đạn <:The_Living_The_Departed:1528452731147391137>The Living & The Departed; áp 3 <:Sinking:1513762793436741652>Sinking khi Clash thắng; +1 <:DiceUp:1513767795681398894>Dice Up với mỗi 5 **Butterfly** kẻ địch có*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây **Butterfly**`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây **Butterfly**`,
      ];
    },
  },
  "goodbye now a sorrow in you": {
    name: "Goodbye Now, a Sorrow In You", weaponOf: "Solemn Lament Pistols", tags: "Weapon",
    cost: "Tối thiểu 4 đạn", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(7,10), d3 = r(10,13), d4 = r(13,16);
      return [
        `*+1 Clash Power với mỗi viên đạn <:The_Living_The_Departed:1528452731147391137>The Living & The Departed; áp 5 <:Sinking:1513762793436741652>Sinking khi Clash thắng; +1 <:DiceUp:1513767795681398894>Dice Up với mỗi 5 **Butterfly** kẻ địch có*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — gây **Butterfly**`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây **Butterfly**`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — gây **Butterfly**`,
        `${D4} **${d4}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — +4% Dmg với mỗi 1 Count **Butterfly** kẻ địch có; xả toàn bộ đạn ở Dice này`,
      ];
    },
  },

  // ══════════════ Weapon Criticals — Devil Sword Dante ══════════════
  "overdrive": {
    name: "Overdrive", weaponOf: "Devil Sword Dante", tags: "Weapon",
    cost: "—", cd: "1 Turn sau khi tích xong", diceMul: "1.5x",
    // chargeSpec — cơ chế TÍCH TỤ (Fragaria mô tả trực tiếp): "khi bấm skill sẽ
    // tính là BẮT ĐẦU TÍCH (charge khởi đầu là 0), có thể bấm thêm một lần nữa
    // để phóng ra theo số turn đã tích. Đang tích mà bị Stagger hay bị đánh sẽ
    // KHÔNG mất." Xem CHARGE_SPEC_CONTRACT ở cuối file.
    chargeSpec: { maxTurns: 3, effect: "reuse" },
    roll(chargeTurns = 0) {
      const n = Math.max(0, Math.min(3, chargeTurns | 0));
      const lines = [`*Đã tích **${n}**/3 Turn — mỗi turn tích thêm 1 Reuse*`];
      for (let i = 0; i <= n; i++) {
        lines.push(`${i === 0 ? D1 : D2} ${i > 0 ? `↩️ **Reuse ${i}** — ` : ""}**${r(10,16)}** [<:Slash:1513768633434640517>Slash] [Unblockable] — phóng kiếm khí từ năng lượng quỷ tích tụ`);
      }
      return lines;
    },
  },
  "judgement": {
    name: "Judgement", weaponOf: "Devil Sword Dante", tags: "Weapon",
    cost: "— [Chỉ khi ở Sin Devil Trigger]", cd: "—", diceMul: "10x",
    roll() {
      return [
        `*Chỉ khả dụng khi đang ở trạng thái **Sin Devil Trigger** [AOE tất cả]*`,
        `${D1} **30** [<:Slash:1513768633434640517>Slash] [Unblockable] [Undodgeable] [Unparriable] [Unclashable] — tích tụ năng lượng rồi chém kẻ địch liên tục, kết thúc bằng một vụ nổ`,
      ];
    },
  },

  // ══════════════ Weapon Criticals — Ebony & Ivory ══════════════
  "charge shot": {
    name: "Charge Shot", weaponOf: "Ebony & Ivory", tags: "Weapon",
    cost: "—", cd: "1 Turn sau khi tích xong", diceMul: "1x",
    // Cùng cơ chế tích tụ với Overdrive, khác EFFECT: mỗi turn +10 Dice thay vì
    // +1 Reuse. Xem CHARGE_SPEC_CONTRACT.
    chargeSpec: { maxTurns: 3, effect: "dice", perTurn: 10 },
    roll(chargeTurns = 0) {
      const n = Math.max(0, Math.min(3, chargeTurns | 0));
      const bonus = n * 10;
      const base = r(20,23);
      return [
        `*Đã tích **${n}**/3 Turn — mỗi turn tích thêm +10 Dice*`,
        `${D1} **${base + bonus}**${bonus > 0 ? ` (${base} +${bonus})` : ""} [<:Pierce:1513768511179329556>Pierce] [Guard Break] — bắn viên đạn chứa năng lượng quỷ tích tụ`,
      ];
    },
  },
  "jackpot": {
    name: "Jackpot", weaponOf: "Ebony & Ivory", tags: "Weapon",
    cost: "— [Chỉ khi dùng Charge Shot với Gunslinger Style]", cd: "—", diceMul: "2x",
    // chargeSpec — tích tụ tới 7 Turn (khác 3 Turn của Overdrive/Charge Shot).
    // effect "instakill": mỗi turn tích thêm 1/7 cơ hội chạm mốc 7.77%; đủ 7 turn
    // mới có đúng 7.77%. Chưa đủ 7 turn thì KHÔNG có cửa insta-kill.
    chargeSpec: { maxTurns: 7, effect: "instakill" },
    roll(chargedTurns = 7) {
      const turns = Math.max(0, Math.min(7, Math.floor(Number(chargedTurns) || 0)));
      // CHỈ đủ 7 turn mới quay 7.77% — tích thiếu thì viên đạn vẫn bắn nhưng
      // không có cửa insta-kill (nếu không thì "tích tụ 7 Turn" thành vô nghĩa).
      const isInstakill = turns >= 7 && Math.random() < 0.0777;
      return [
        turns >= 7
          ? `*Đã tích đủ 7 Turn — 7.77% cơ hội insta-kill kẻ địch*`
          : `*Mới tích ${turns}/7 Turn — CHƯA đủ để có cửa insta-kill*`,
        isInstakill ? `*💀 7.77% kích hoạt — INSTA-KILL!*` : ``,
        `${D1} **77** [<:Pierce:1513768511179329556>Pierce] [Guard Break] [Undodgeable] [Unparriable] [Unclashable] — bắn viên đạn quỷ tích tụ ${turns} turn${isInstakill ? " — **INSTA-KILL**" : ""}`,
      ].filter(Boolean);
    },
  },

  // ══════════════ Manifested E.G.O — Weapon Skills (KHÔNG phải EGO Page 5-slot,
  // xem comment isEgoSkill trong index.js — đây là skill CỦA vũ khí manifested,
  // không phải page từ Book of Library nên không equip vào 5 slot Tier) ══════════════
  "crescent divinity": {
    name: "Crescent Divinity", weaponOf: "Manifested E.G.O", tags: "Weapon",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,13);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — lướt xuyên qua người kẻ địch trong khi trên không, nhận 25 Forte`,
      ];
    },
  },
  "purge of light": {
    name: "Purge of Light", weaponOf: "Manifested E.G.O", tags: "Weapon",
    cost: "5 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(21,30);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE tất cả] [Unevadeable] [Guard Break] — tạo trường năng lượng cộng hưởng gây sát thương toàn bộ kẻ địch; đòn **Illuminous Epiphany** kế tiếp nhận 90% Dmg Up`,
      ];
    },
  },

  // ══════════════ Weapon Criticals — N Corp. E.G.O Gear: Soft Goldcasted Heart ══════════════
  "contemptuous thing": {
    name: "Contemptuous Thing", weaponOf: "Soft Goldcasted Heart", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,7), d2 = r(7,11);
      return [
        `*+1 Clash Power với mỗi Gaze/Contempt trên kẻ địch; +1 <:DiceUp:1513767795681398894>Dice Up với mỗi 10 <:Bleed:1513762688226955285>Bleed+<:Tremor:1513762737388257380>Tremor cộng lại*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Tremor:1513762737388257380>Tremor và 1 <:Bleed:1513762688226955285>Bleed`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 1 **Gaze**`,
      ];
    },
  },
  "be awed": {
    name: "Be Awed", weaponOf: "Soft Goldcasted Heart", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,10), d2 = r(10,16);
      return [
        `*+1 Clash Power với mỗi Gaze/Contempt trên kẻ địch; +1 <:DiceUp:1513767795681398894>Dice Up với mỗi 10 <:Bleed:1513762688226955285>Bleed+<:Tremor:1513762737388257380>Tremor cộng lại*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Tremor:1513762737388257380>Tremor và 2 <:Bleed:1513762688226955285>Bleed`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 2 **Gaze**, 1 <:Tremor:1513762737388257380>Tremor và 1 <:Bleed:1513762688226955285>Bleed; nếu địch có ≥3 <:Tremor:1513762737388257380>Tremor thì <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "awe, contempt": {
    name: "Awe, Contempt", weaponOf: "Soft Goldcasted Heart", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,9), d2 = r(9,13), d3 = r(13,17);
      return [
        `*+1 Clash Power với mỗi Gaze/Contempt; +1 <:DiceUp:1513767795681398894>Dice Up và 5% Dmg Up với mỗi 8 <:Bleed:1513762688226955285>Bleed+<:Tremor:1513762737388257380>Tremor cộng lại; nếu địch có Gaze: +2 <:Bleed:1513762688226955285>Bleed và <:Tremor:1513762737388257380>Tremor mỗi Dice*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — gây 2 <:Tremor:1513762737388257380>Tremor và 2 <:Bleed:1513762688226955285>Bleed`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — gây 1 <:Tremor:1513762737388257380>Tremor và 1 <:Bleed:1513762688226955285>Bleed`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — gây thêm 10% Dmg với mỗi 1 Gaze trên kẻ địch, áp **Tremor-Hemorrhage** rồi <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "cascading gaze of awe underneath contempt": {
    name: "Cascading Gaze of Awe Underneath Contempt", weaponOf: "Soft Goldcasted Heart", tags: "Weapon",
    cost: "— [Dùng Awe, Contempt khi tất cả địch có 7 Gaze hoặc 1 Contempt]", cd: "—", diceMul: "1x",
    roll() {
      const d1 = r(14,28);
      return [
        `*[AOE 3 người] +1 Clash Power với mỗi Gaze/Contempt; +1 <:DiceUp:1513767795681398894>Dice Up và 5% Dmg Up với mỗi 8 <:Bleed:1513762688226955285>Bleed+<:Tremor:1513762737388257380>Tremor; nếu địch có Gaze: +10% Dmg với mỗi 1 Gaze; +200% Dmg Up nếu chỉ có 1 mục tiêu*`,
        `${D1} Sau khi đòn kết thúc: tiêu thụ toàn bộ **Gaze** và **Contempt** trên kẻ địch trúng phải`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] [Undodgeable] — gây thêm 235% Dmg nếu địch có **Contempt**; gây 4 <:Tremor:1513762737388257380>Tremor và 4 <:Bleed:1513762688226955285>Bleed; áp **Tremor-Hemorrhage** rồi <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  // ────────────────────────────────────────────────────────────────────────
  // HANA ASSOCIATION BOOK (Fragaria 14/08)
  // ⚠️ Emoji trong text gốc Fragaria gửi là ID của SERVER KHÁC
  // (Slash `1255876…`, Light `1322102…`). Đã đổi hết sang ID chuẩn của codebase.
  // ────────────────────────────────────────────────────────────────────────
  "forward march": {
    name: "Forward March", bookOf: "Hana Association Book",
    cost: "0 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(2,5);
      return [
        `*[On Use]* Hồi 1 <:Light:1513786082502770719>Light`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — Lao lên chém vào mặt kẻ thù`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — Lao đến chém kẻ thù một nhát`,
      ];
    },
  },
  "godspeed": {
    name: "GodSpeed", bookOf: "Hana Association Book",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,8), d2 = r(3,7);
      return [
        // ⚠️ TÁCH LÀM 2 DÒNG: `extractNonDmgStrEffects` BỎ QUA nguyên dòng nào có
        // chữ "nếu" (dòng điều kiện). Gộp chung thì vế Haste vô điều kiện cũng bị
        // nuốt luôn và page mất hẳn hiệu ứng chính.
        `*[On Use]* Nhận 1 <:Fix_Haste:1513768004222062632>Haste turn sau`,
        `*[On Use]* Nếu Speed bản thân **trên 7** khi dùng page này thì nhận thêm 1 <:DiceUp:1513767795681398894>Dice Up`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — Đấm kẻ thù`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đấm kẻ thù`,
      ];
    },
  },
  "confrontation": {
    name: "Confrontation", bookOf: "Hana Association Book",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(5,8), d3 = r(3,7);
      return [
        `*[On Use]* Cho **tất cả đồng minh** 1 <:Protection:1528452299834261545>Protection trong turn sau`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — Tấn công kẻ thù`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — Tấn công kẻ thù, bản thân hồi 5 Stamina`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — Tấn công kẻ thù`,
      ];
    },
  },
  // ────────────────────────────────────────────────────────────────────────
  // R CORP BOOK (Fragaria 14/08)
  // ────────────────────────────────────────────────────────────────────────
  "graze the grass": {
    name: "Graze the Grass", bookOf: "R Corp Book", tags: "Charge",
    cost: "0 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,7), d2 = r(3,4);
      return [
        `*[On Use]* Hồi 1 <:Light:1513786082502770719>Light và nhận 3 <:Charge:1513762867558613033>Charge`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — Đấm vào mặt kẻ thù`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đấm vào mặt kẻ thù`,
      ];
    },
  },
  "quick suppression": {
    name: "Quick Suppression", bookOf: "R Corp Book", tags: "Charge",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,8), d2 = r(4,8), d3 = r(3,8);
      return [
        `*[On Use]* Nhận 5 <:Charge:1513762867558613033>Charge`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — Đấm vào mặt kẻ thù`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — Đấm vào mặt kẻ thù, gây 2 <:Bleed:1513762688226955285>Bleed`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — Đấm vào mặt kẻ thù, gây 1 <:Bleed:1513762688226955285>Bleed`,
      ];
    },
  },
  "concentration": {
    name: "Concentration", bookOf: "R Corp Book", tags: "Charge",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(4,8), d3 = r(4,6);
      return [
        `*[On Use]* Nhận 8 <:Charge:1513762867558613033>Charge`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — Đấm vào mặt kẻ thù`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — Đấm vào mặt kẻ thù`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] — Đấm vào mặt kẻ thù`,
      ];
    },
  },
  "bulky impact": {
    name: "Bulky Impact", bookOf: "R Corp Book", tags: "Charge",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,7), d2 = r(6,12);
      return [
        `*[On Use]* Nhận 5 <:Charge:1513762867558613033>Charge`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — Táng vào mặt kẻ thù`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — Táng vào mặt kẻ thù`,
      ];
    },
  },
  "rhino ram": {
    name: "Rhino Ram", bookOf: "R Corp Book", tags: "Charge",
    cost: "4 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,25);
      return [
        `*[On Use]* Nhận 3 <:Protection:1528452299834261545>Protection ở turn sau`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] — Nhận 8 <:Charge:1513762867558613033>Charge`,
      ];
    },
  },
  // Page ĐẶC BIỆT: không tốn slot, tự có khi mặc "Reindeer R Corp Outfit".
  "mind whip": {
    name: "Mind Whip", bookOf: "R Corp Book", tags: "Charge",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,23);
      return [
        `*[Page đặc biệt — không tốn slot, tự có khi dùng **Reindeer R Corp Outfit**]*`,
        `*[On Use]* Bản thân bị trừ 4 Stamina`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] — Dùng 3 <:Charge:1513762867558613033>Charge để gây 10 <:Tremor:1513762737388257380>Tremor`,
      ];
    },
  },
};

// ─── SKILL_ALIASES ────────────────────────────────────────────────────────────
// Khai báo trước toàn bộ Object.assign bên dưới — nếu SKILL_ALIASES chưa tồn tại
// thì Object.assign sẽ throw ReferenceError. Không được dời hay split block này.
const SKILL_ALIASES = {
  "faretheewell": "fare-thee well",
  "fareewell": "fare-thee well",
  "farewell": "fare-thee well",
  "justagvengeance": "just a vengeance",
  "jav": "just a vengeance",
  "extractfuel": "extract fuel",
  "stampofvengeance": "stamp of vengeance",
  "sov": "stamp of vengeance",
  "cate": "complete and total extermination",
  "c&te": "complete and total extermination",
  "completete": "complete and total extermination",
  "followingtheflow": "following the flow",
  "ftf": "following the flow",
  "wib": "waltz in black",
  "waltzblack": "waltz in black",
  "wiw": "waltz in white",
  "waltzwhite": "waltz in white",
  "lightattack": "light attack",
  "slashseries": "slash series",
  "executeprescript": "execute prescript",
  "ep": "execute prescript",
  "willofthecity": "will of the city",
  "wotc": "will of the city",
  "dodgeandstrike": "dodge and strike",
  "das": "dodge and strike",
  "soulburn": "soulburn",
  "infernoburst": "inferno burst",
  "ib": "inferno burst",
  "takethiskid": "take this kid",
  "ttk": "take this kid",
  "learnagainkid": "learn again kid",
  "learnakaink": "learn again kid",
  "lak": "learn again kid",
  "catchbreath": "catch breath",
  "cb": "catch breath",
  "shadowcloudshattercleaver": "shadowcloud shattercleaver",
  "scs": "shadowcloud shattercleaver",
  "furioso": "furioso",
  "weightofknowledge": "weight of knowledge",
  "wok": "weight of knowledge",
  "illuminatethyvacuity": "illuminate thy vacuity",
  "itv": "illuminate thy vacuity",
  "studiousdedication": "studious dedication",
  "sd": "studious dedication",
  "scorchknowledge": "scorch knowledge",
  "sk": "scorch knowledge",
  "excruiciatingstudy": "excruciating study",
  "excruiatingstudy": "excruciating study",
  "es": "excruciating study",
  "sanguinepainting": "sanguine painting",
  "sp": "sanguine painting",
  "hematiccoloring": "hematic coloring",
  "hc": "hematic coloring",
  "sanguinepointilism": "sanguine pointilism",
  "pointilism": "sanguine pointilism",
  "perfecteddeathfist": "perfected death fist",
  "pdf": "perfected death fist",
  "ragingstorm": "raging storm",
  "rs": "raging storm",
  "fierywaltz": "fiery waltz",
  "fw": "fiery waltz",
  "redkick": "red kick",
  "rk": "red kick",
  "flowingflame": "flowing flame",
  "ff": "flowing flame",
  "fleetedge": "fleet edge",
  "fe": "fleet edge",
  "flowofthesword": "flow of the sword",
  "fots": "flow of the sword",
  "violentflame": "violent flame",
  "vf": "violent flame",
  "formingstorm": "forming storm",
  "fs": "forming storm",
  "extremeedge": "extreme edge",
  "ee": "extreme edge",
  "flyingsword": "flying sword",
  "fsd": "flying sword",
  "boundaryofdeath": "boundary of death",
  "bod": "boundary of death",
  "overbreath": "overbreath",
  "ob": "overbreath",
  "xuatluctoida": "xuất lực tối đa",
  "xltd": "xuất lực tối đa",
  "levelslash": "level slash",
  "ls": "level slash",
  "focusspirit": "focus spirit",
  "fsp": "focus spirit",
  "upstandingslash": "upstanding slash",
  "us": "upstanding slash",
  "greatsplitvertical": "great split vertical",
  "gsv": "great split vertical",
  "greatsplithorizontal": "great split horizontal",
  "gsh": "great split horizontal",
  "reachinghand": "reaching hand",
  "rhand": "reaching hand",
  "denseflesh": "dense flesh",
  "dflesh": "dense flesh",
  "dimensionalriftdagger": "dimensional rift dagger",
  "drd": "dimensional rift dagger",
  "dimensionalriftgauntlets": "dimensional rift gauntlets",
  "drg": "dimensional rift gauntlets",
  "sharpcuts": "sharp cuts",
  "sc": "sharp cuts",
  "chargeshield": "charge shield",
  "cs": "charge shield",
  "overchargedripple": "overcharged ripple",
  "ocr": "overcharged ripple",
  "moonspittingdraw": "moon-splitting draw",
  "moonsplittingdraw": "moon-splitting draw",
  "msd": "moon-splitting draw",
  "redplumblossomscatter": "red plum blossom scatter",
  "rpbs": "red plum blossom scatter",
  "yieldmyflesh": "yield my flesh",
  "ymf": "yield my flesh",
  "toclaimtheirbones": "to claim their bones",
  "tctb": "to claim their bones",
  // New skills
  "dissecttarget": "dissect target",
  "dt": "dissect target",
  "sandsplit": "sand split",
  "mirageincision": "mirage incision",
  "mi": "mirage incision",
  "khopeshswordplay": "khopesh swordplay",
  "ks": "khopesh swordplay",
  "bladewhirl": "blade whirl",
  "bw": "blade whirl",
  "clientprotection": "client protection",
  "cp": "client protection",
  "lawandorder": "law and order",
  "lao": "law and order",
  "augurycrusher": "augury crusher",
  "auginfusion": "augury infusion",
  "ai": "augury infusion",
  "augurykick": "augury kick",
  "ak": "augury kick",
  "celestialsight": "celestial sight",
  "lupineonslaught": "lupine onslaught",
  "lo": "lupine onslaught",
  "kickandstomps": "kick and stomps",
  "kas": "kick and stomps",
  "rapaciousassault": "rapacious assault",
  "ra": "rapacious assault",
  "pitchblackpulverizer": "pitch-black pulverizer",
  "pbp": "pitch-black pulverizer",
  "cloudcutter": "cloud cutter",
  "cc": "cloud cutter",
  "skyclearingcut": "sky clearing cut",
  "scc": "sky clearing cut",
  "darkcloudcleaver": "dark cloud cleaver",
  "dcc": "dark cloud cleaver",
  "soberup": "sober up",
  "shadowcloudkick": "shadowcloud kick",
  "sck": "shadowcloud kick",
  "silentmist": "silent mist",
  "somberprocuration": "somber procuration",
  "spro": "somber procuration",
  "trashdisposal": "trash disposal",
  "td": "trash disposal",
  "bladeflourish": "blade flourish",
  "bf": "blade flourish",
  // Degraded Fairy skills
  "degradedfairy": "degraded fairy",
  "dfa": "degraded fairy",          // "df" cũ đổi sang "dfa" để tránh nhầm với magic bullet df
  "degradedpillar": "degraded pillar",
  "dp": "degraded pillar",
  "degradedlock": "degraded lock",
  "dl": "degraded lock",
  "degradedshockwave": "degraded shockwave",
  "ds": "degraded shockwave",
  "apocalypse": "apocalypse",
  "apo": "apocalypse",
  // Magic Bullet Der Freischütz aliases — "df" được dành riêng cho skill này
  "df": "magic bullet df",
  "mdf": "magic bullet df",
  "mbdf": "magic bullet df",
  "magicbulletdf": "magic bullet df",
  // Lævateinn
  "lævateinn": "laevateinn",
  "la": "laevateinn",
  "lapassive": "laevateinn",
  "stomping": "stomping",
  "illgutyoulikeafish": "ill gut you like a fish",
  "ilgutfish": "ill gut you like a fish",
  "igylaf": "ill gut you like a fish",
  "dontletthisbreakme": "dont let somethin like this break you",
  "dontletbreakyou": "dont let somethin like this break you",
  "dlbky": "dont let somethin like this break you",
  "gutstablaevateinn": "gut stab laevateinn",
  "gutstabla": "gut stab laevateinn",
  "gsla": "gut stab laevateinn",
  "stampmaximum": "stamp of vengeance maximum",
  "sovm": "stamp of vengeance maximum",
  "stampmaxlaevateinn": "stamp of vengeance maximum",
  "catelaevateinn": "complete and total extermination laevateinn",
  "catela": "complete and total extermination laevateinn",
  "goodgirl": "good girl your sacrifice for the family wont be forgotten",
  "yoursacrifice": "good girl your sacrifice for the family wont be forgotten",
};

// ══════════════════════════════════════════════════════════════════════════════
// ── NEW SKILLS (thêm vào đây khi có skill mới) ─────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── Weapon Criticals (mới) ──
Object.assign(SKILLS, {

  // ── Illusory Land of Great Void ──
  "whirlwind": {
    name: "Whirlwind", weaponOf: "Illusory Land of Great Void", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,10), d2 = r(10,14);
      return [
        `*Nếu turn trước không nhận sát thương: cả 2 Dice của Critical đều nhận 2 <:DiceUp:1513767795681398894>Dice Up*`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** — Gây 2 <:Sinking:1513762793436741652>Sinking và 2 <:Rupture:1513762812722155682>Rupture [<:Slash:1513768633434640517>Slash]`,
      ];
    },
  },

  // ── Lucent Historia ──
  "designant.": {
    name: "Designant.", weaponOf: "Lucent Historia", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    // needsAllyTarget — skill này CHỈ ĐỊNH một đồng đội (hoặc chính mình).
    // BUG ĐÃ SỬA (Fragaria: "Designant không cho chỉ định mà mặc định cho bản
    // thân"). Gốc: Designant không có dice sát thương ⇒ đi nhánh `!autoDmgStr`
    // trong interaction-handlers.js, nhánh đó dựng pendingAction với
    // `targets: []` và KHÔNG hỏi target bao giờ. Xuống resolve-pending-action.js
    // thì `(p.targets ?? [])[0]?.targetId ?? p.attackerId` luôn rơi vào vế sau
    // ⇒ vĩnh viễn tự chỉ định mình.
    // Cờ này bật một bước chọn ĐỒNG ĐỘI (dropdown `encallytarget:`) trước khi
    // resolve. Đặt trên DATA thay vì hard-code tên skill trong handler để skill
    // sau này cùng kiểu chỉ cần khai 1 dòng.
    needsAllyTarget: true,
    allyTargetPrompt: "Chọn người được **Designant.** chỉ định (có thể chọn chính mình):",
    roll() {
      return [
        `*Bản thân và tất cả đồng đội nhận 30 Shield HP, rồi chỉ định một đồng đội hoặc chính bản thân.*`,
        // Fragaria cập nhật số: 50% → **20%** Max HP của người dùng.
        `*Người được chỉ định sẽ nhận <:shield:1449582220481134705>Shield HP bằng **20% Max HP của người dùng** và 1 <:DiceUp:1513767795681398894>Dice Up đến hết turn.*`,
      ];
    },
  },
  "astral quantization": {
    name: "Astral Quantization", weaponOf: "Lucent Historia", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1x",
    // Cùng lỗi với Designant.: skill không có dice sát thương ⇒ không bao giờ
    // được hỏi target ⇒ luôn tự chỉ định mình (mà mình thường không có Shield HP
    // nên còn báo "không chỉ định được"). Xem needsAllyTarget ở Designant.
    needsAllyTarget: true,
    allyTargetPrompt: "Chọn đồng đội (phải ĐANG CÓ Shield HP) để **Astral Quantization** lấy % sát thương của họ:",
    roll() {
      // BUG ĐÃ SỬA (Fragaria: "Text gốc là 1-30 dice nhưng lại ra được 41").
      // Luật: "roll dice [1-30]" — code cũ để r(1, 50), lệch hẳn 20 điểm trần.
      const dice = r(1, 30);
      return [
        `*Chỉ định một đồng đội có Shield HP. Cuối turn, gây sát thương lên một đối thủ bằng **${dice}%** DMG mà đồng đội đó đã gây ra trong turn này.*`,
        `[<:Slash:1513768633434640517>Slash]`,
      ];
    },
  },

  // ── РАСКО́Л ──
  "slay": {
    name: "Slay", weaponOf: "РАСКО́Л", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,8), d2 = r(8,10), d3 = r(10,12), d4 = r(12,14);
      return [
        `*Nếu bản thân dưới 0 Sanity: toàn bộ Dice nhận +1 <:DiceUp:1513767795681398894>Dice Up*`,
        `*Nếu kẻ địch có ≥6 <:Bleed:1513762688226955285>Bleed: toàn bộ Dice nhận 20% Dmg Up*`,
        `${D1} **${d1}** — Gây 1 <:Bleed:1513762688226955285>Bleed (turn kế) [<:Slash:1513768633434640517>Slash]`,
        `${D2} **${d2}** — Gây 1 <:Bleed:1513762688226955285>Bleed (turn kế) [<:Slash:1513768633434640517>Slash]`,
        `${D3} **${d3}** — Gây 1 <:Bleed:1513762688226955285>Bleed (turn kế) [<:Slash:1513768633434640517>Slash]`,
        `${D4} **${d4}** — Gây 1 <:Bleed:1513762688226955285>Bleed (turn kế) [<:Slash:1513768633434640517>Slash]`,
      ];
    },
  },

  // ── Nyoibo ──
  "one inch punch": {
    name: "One Inch Punch", weaponOf: "Nyoibo [Tay không]", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,17);
      return [
        `${D1} **${d1}** — Chắc chắn Crit [<:Blunt:1513768529718022254>Blunt] [Guard Break]`,
      ];
    },
  },
  "power pole extend": {
    name: "Power Pole: Extend", weaponOf: "Nyoibo [Gậy]", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "2x",
    roll() {
      const d2 = r(11,13);
      return [
        `${D2} **${d2}** — Phóng dài gậy như ý rồi càn quét kẻ địch [<:Blunt:1513768529718022254>Blunt] [AOE]`,
      ];
    },
  },

  // ── WALPURGISNACHT ──
  "drilling stab": {
    name: "Drilling Stab", weaponOf: "WALPURGISNACHT", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,9), d2 = r(11,13);
      return [
        `${D1} **${d1}** — Gây 10 <:Fragile:1513763336167100536>Fragile và 1 <:Paralyze:1513763316479295548>Paralyze [<:Pierce:1513768511179329556>Pierce]`,
        `${D2} **${d2}** — Gây 2 <:DiceDown:1513767826257874964>Dice Down [<:Pierce:1513768511179329556>Pierce]`,
      ];
    },
  },

  // ── EGO Pages (ZAYIN) ──
  "crow's eye view": {
    name: "Crow's Eye View", tags: "E.G.O Page <:limbus:1010616548114833468> <:ZAYIN:1449759413966606398>",
    cost: "3 <:Light:1513786082502770719>Light, 10 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,24);
      return [
        `<:Dice1:1508173590078558369> **${d1}** — Gây 2 <:DiceDown:1513767826257874964>Dice Down, 2 <:Fix_Bind:1513768025881317457>Bind và toàn bộ đồng minh nhận 3 <:Fix_Haste:1513768004222062632>Haste turn kế [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable]`,
        `*[After Use] E.G.O Passive **Silence**: khi bị tấn công turn kế sẽ nhận 3 <:Fix_Bind:1513768025881317457>Bind và tăng 20% Dmg Up*`,
        `*__Utter to me what you think the ideal is.__*`,
      ];
    },
  },
  "la sangre de sancho": {
    name: "La Sangre De Sancho", tags: "E.G.O Page <:limbus:1010616548114833468> <:ZAYIN:1449759413966606398>",
    cost: "3 <:Light:1513786082502770719>Light, 10 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,26);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Gây 8 <:Bleed:1513762688226955285>Bleed và hồi HP bằng 50% Damage gây ra`,
        `*[After Use] E.G.O Passive **Immoderate Passion**: mỗi khi tấn công kẻ địch có <:Bleed:1513762688226955285>Bleed, hồi 3 HP*`,
        `*__Gallop on, Rocinante! Justice shall prevail!__*`,
      ];
    },
  },
  "representation emitter": {
    name: "Representation Emitter", tags: "E.G.O Page <:limbus:1010616548114833468> <:ZAYIN:1449759413966606398>",
    cost: "3 <:Light:1513786082502770719>Light, 10 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(19,23);
      return [
        `<:Dice1:1508173590078558369> **${d1}** — Đập cán chổi xuống mặt đất tạo xung chấn, sau đó hồi 12 Sanity cho 4 đồng minh có Sanity thấp nhất [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [AOE 3 người]`,
        `*[After Use] E.G.O Passive **Ennui**: nếu kẻ địch bị Stagger, 3 đồng minh có Sanity thấp nhất hồi 20 Sanity*`,
        `*__Faust knows all outcomes.__*`,
      ];
    },
  },
  "land of illusion": {
    name: "Land of Illusion", tags: "E.G.O Page <:limbus:1010616548114833468> <:ZAYIN:1449759413966606398>",
    cost: "3 <:Light:1513786082502770719>Light, 10 <:Sanity:1538272293132963930>Sanity", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15,25);
      return [
        `<:Dice1:1508173590078558369> **${d1}** — Gây 5 <:Sinking:1513762793436741652>Sinking, bản thân hồi 15 Sanity và đồng đội hồi 5 Sanity [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [AOE 3 người]`,
        `*[After Use] E.G.O Passive **Ripple**: mỗi đầu turn, hồi 5 Sanity cho đồng đội ngẫu nhiên có Sanity thấp nhất*`,
        `*__Let's visit the world of wonders.__*`,
      ];
    },
  },

  // ── Heat Skills ──
  "dragon choke impact": {
    name: "Dragon Choke Impact", tags: "Heat",
    cost: "3 Heat Gauge", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(65,78), d2 = r(70,80), d3 = r(75,80);
      return [
        `${D1} **${d1}** — Tung combo đấm liên tiếp vào bụng và ngực đối thủ, gây 12 <:Tremor:1513762737388257380>Tremor [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** — Kết thúc bằng cú quật mạnh xuống đất, gây 10 <:Fragile:1513763336167100536>Fragile [<:Blunt:1513768529718022254>Blunt]`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] — *(chỉ khi Heat Gauge ≥4)* gây <:TremorBurst:1513802464632246352>Tremor Burst (đối thủ không thể tấn công trong 1 turn kế)`,
      ];
    },
  },
  "arm lock": {
    name: "Arm Lock", tags: "Heat",
    cost: "1 Heat Gauge", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(22,28);
      return [
        `${D1} **${d1}** — Khóa vai đối thủ, gây 6 <:Tremor:1513762737388257380>Tremor và **[Grab]** [<:Blunt:1513768529718022254>Blunt] [Unblockable]`,
      ];
    },
  },
  "inverted cross arm wrench": {
    name: "Inverted Cross Arm Wrench", tags: "Heat",
    cost: "2 Heat Gauge", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(40,55);
      return [
        `${D1} **${d1}** — Khóa tay theo thế Jiu-Jitsu, gây 8 <:Tremor:1513762737388257380>Tremor và **[Grab]** [<:Blunt:1513768529718022254>Blunt] [Unblockable]`,
      ];
    },
  },
  "knee break": {
    name: "Knee Break", tags: "Heat",
    cost: "1 Heat Gauge", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(20,23);
      return [
        `${D1} **${d1}** — Bẻ gối đối thủ, gây 6 <:Tremor:1513762737388257380>Tremor [<:Blunt:1513768529718022254>Blunt]`,
        `*Nếu đối thủ bị **[Grab]**: gây <:TremorBurst:1513802464632246352>Tremor Burst và Dice 1 trở thành 2x Dice Mul*`,
      ];
    },
  },
  "true reverse drop": {
    name: "True Reverse Drop", tags: "Heat",
    cost: "2 Heat Gauge", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(15,17);
      return [
        `${D1} **${d1}** — Tóm lấy đối thủ từ phía trước, xoay người và quật ngửa xuống đất. Gây **[Grab]** cho turn này và turn sau, và gây 10 <:Fragile:1513763336167100536>Fragile [<:Blunt:1513768529718022254>Blunt]`,
      ];
    },
  },
  "crippling crossface": {
    name: "Crippling Crossface", tags: "Heat",
    cost: "2 Heat Gauge", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(42,56);
      return [
        `${D1} **${d1}** — Khóa tay + cổ, gây 10 <:Fragile:1513763336167100536>Fragile và **[Grab]** [<:Blunt:1513768529718022254>Blunt] [Unblockable]`,
      ];
    },
  },
  "midline triple thrust": {
    name: "Midline Triple Thrust", tags: "Heat",
    cost: "2 Heat Gauge", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(62,76);
      return [
        `${D1} **${d1}** — Ba cú đâm karate liên tiếp vào bụng, ngực, mặt. Gây tổng cộng 12 <:Tremor:1513762737388257380>Tremor và 10 <:Fragile:1513763336167100536>Fragile [<:Pierce:1513768511179329556>Pierce] [Guard Break] [Undodgeable]`,
      ];
    },
  },
  "lightning back kick": {
    name: "Lightning Back Kick", tags: "Heat",
    cost: "2 Heat Gauge", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(44,59);
      return [
        `${D1} **${d1}** — Đá ngược bụng đối thủ, gây 8 <:Tremor:1513762737388257380>Tremor [<:Blunt:1513768529718022254>Blunt] [Undodgeable]`,
        `*Nếu Heat ≥3: thêm 6 <:Tremor:1513762737388257380>Tremor và x1.5 Dice Mul*`,
      ];
    },
  },
  "aiki mugen throw": {
    name: "Aiki Mugen Throw", tags: "Heat",
    cost: "3 Heat Gauge", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(65,78), d2 = r(70,80);
      return [
        `${D1} **${d1}** — Loạt đòn ném Aiki-nage liên tiếp, gây 12 <:Tremor:1513762737388257380>Tremor và **[Grab]** [<:Blunt:1513768529718022254>Blunt] [Unblockable]`,
        `${D2} **${d2}** — Kết thúc bằng cú quật mạnh, gây 10 <:Fragile:1513763336167100536>Fragile [<:Blunt:1513768529718022254>Blunt] [Guard Break]`,
      ];
    },
  },
  "head crash": {
    name: "Head Crash", tags: "Heat",
    cost: "2 Heat Gauge", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(40,55);
      return [
        `${D1} **${d1}** — Đập đầu đối thủ xuống đất, gây 8 <:Tremor:1513762737388257380>Tremor [<:Blunt:1513768529718022254>Blunt]`,
        `*Nếu kẻ địch bị Stagger: thêm 10 <:Fragile:1513763336167100536>Fragile trước khi gây Dmg và 1.5x Dice Mul*`,
      ];
    },
  },
  "mounted punch rush": {
    name: "Mounted Punch Rush", tags: "Heat",
    cost: "3 Heat Gauge", cd: "5 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(65,78), d2 = r(68,80), d3 = r(70,80);
      return [
        `${D1} **${d1}** — Hạ gục đối thủ xuống đất [<:Blunt:1513768529718022254>Blunt]`,
        `${D2} **${d2}** — Loạt đấm liên hoàn, gây 12 <:Tremor:1513762737388257380>Tremor [<:Blunt:1513768529718022254>Blunt]`,
        `${D3} **${d3}** — Tung 1 đấm chí mạng, thêm 8 <:Fragile:1513763336167100536>Fragile và <:TremorBurst:1513802464632246352>Tremor Burst [<:Blunt:1513768529718022254>Blunt]`,
      ];
    },
  },
  "reverse lift up slam": {
    name: "Reverse Lift Up Slam", tags: "Heat",
    cost: "2 Heat Gauge", cd: "4 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(42,55);
      return [
        `${D1} **${d1}** — Nhấc đối thủ lên rồi quật mạnh xuống lưng. Gây 10 <:Tremor:1513762737388257380>Tremor và **[Grab]** [<:Blunt:1513768529718022254>Blunt]`,
      ];
    },
  },

  // ── Follow-Up Skills (kích hoạt sau đòn đánh thứ 4 mỗi turn) ──
  "follow-up": {
    name: "Follow-Up",
    cost: "-", cd: "—", diceMul: "1x",
    incompatibleWith: ["pounce"],
    // Fragaria: "Thêm tag unclashable cho pounce, follow-up, light dash,
    // fleetfoot steps và borrowed eyes" — `unclashable` là CỜ DỮ LIỆU (bộ chọn
    // Clash của người chơi LẪN AI đều lọc theo nó), còn tag [Unclashable] viết
    // trong dòng roll() là phần NGƯỜI CHƠI ĐỌC + để parser phòng thủ bắt được.
    unclashable: true,
    keywords: ["follow-up", "airborne", "blunt", "4th hit"],
    roll() {
      const d1 = r(10, 14);
      return [
        `*Kích hoạt sau đòn đánh thứ 4 mỗi turn — Không thể tồn tại chung với **Pounce***`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unclashable] — gây 1 **[Airborne]**`,
      ];
    },
  },
  "pounce": {
    name: "Pounce",
    cost: "-", cd: "—", diceMul: "1x",
    incompatibleWith: ["follow-up"],
    // Fragaria: "Thêm tag unclashable cho pounce, follow-up, light dash,
    // fleetfoot steps và borrowed eyes" — `unclashable` là CỜ DỮ LIỆU (bộ chọn
    // Clash của người chơi LẪN AI đều lọc theo nó), còn tag [Unclashable] viết
    // trong dòng roll() là phần NGƯỜI CHƠI ĐỌC + để parser phòng thủ bắt được.
    unclashable: true,
    keywords: ["pounce", "blunt", "4th hit"],
    roll() {
      const d1 = r(8, 30);
      return [
        `*Kích hoạt sau đòn đánh thứ 4 mỗi turn — Không thể tồn tại chung với **Follow-Up***`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Unclashable]`,
      ];
    },
  },

  // ── Weapon Criticals ──
  "for justice": {
    name: "For Justice!!!",
    weaponOf: "Sueño Imposible",
    weaponType: "Medium", weaponDmg: "12 <:Pierce:1513768511179329556>Pierce",
    passive: "**Big Wound** — Khi kẻ địch trên 10 <:Bleed:1513762688226955285>Bleed: gây x1 cho Res dưới 1; nếu Res trên 1 tăng thêm 0,2 Res",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,6), d2 = r(6,9), d3 = r(9,12);
      return [
        `*Khi full Stamina: toàn bộ Dice của skill nhận được 2 <:DiceUp:1513767795681398894>Dice Up*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 1 <:Bleed:1513762688226955285>Bleed vào turn kế`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed vào turn kế`,
        `${D3} **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed vào turn kế`,
      ];
    },
  },
  // ── Blade Lineage Hwando ──
  "blade lineage hwando": {
    name: "Blade Lineage Hwando", tags: "Weapon",
    weaponType: "Medium", weaponDmg: "13 <:Slash:1513768633434640517>Slash",
    passive: "**Poised** — Khi <:Poise:1513762945715142736>Poise ≥ 10: tiêu thụ một nửa <:Poise:1513762945715142736>Poise hiện có, cộng vào base dmg của đòn một lượng bằng số <:Poise:1513762945715142736>Poise đã tiêu thụ × 2",
    cost: "—", cd: "—", diceMul: "—",
    roll() { return [`*(Đây là passive/weapon entry — dùng tên skill cụ thể để roll)*`]; },
  },
  "striker's stance": {
    name: "Striker's Stance",
    weaponOf: "Blade Lineage Hwando",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6, 13);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Nhận 5 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "heel turn": {
    name: "Heel Turn",
    weaponOf: "Blade Lineage Hwando",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7, 9), d2 = r(9, 11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Nhận 3 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Nhận 3 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },
  "flank thrust": {
    name: "Flank Thrust",
    weaponOf: "Blade Lineage Hwando",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(8, 10), d2 = r(10, 12), d3 = r(12, 14);
      return [
        `*3 Dice của đòn này được tăng thêm 0.7x Crit Mul*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — Nhận 2 <:Poise:1513762945715142736>Poise`,
      ];
    },
  },

  // Halberd VOGEL
  "ravaging cut": {
    name: "Ravaging Cut",
    weaponOf: "Halberd VOGEL",
    weaponType: "Heavy", weaponDmg: "25",
    passive: "**Break the Shell** — Sau khi có một đồng minh Stagger hoặc chết: nhận 10% damage (max 3 lần)",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,8), d2 = r(8,11), d3 = r(11,14);
      return [
        `${D1} *Khi skill này clash thắng: nhận được 1 <:DiceUp:1513767795681398894>Dice Up cho toàn bộ Dice*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gắn 2 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gắn 2 <:Rupture:1513762812722155682>Rupture`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — gắn 2 <:Rupture:1513762812722155682>Rupture`,
      ];
    },
  },

  // ── Scorch Propellant Round line (Savage Double/Triple Slash, Blasting Shatterslash, Tanglecleaver Flurry) ──
  "savage double slash": {
    name: "Savage Double Slash", tags: "Burn/Tremor",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(2,4), d2 = r(3,5);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up. Nhận được 5 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** sau khi sử dụng`,
      ];
    },
  },
  "savage triple slash": {
    name: "Savage Triple Slash", tags: "Burn/Tremor",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(1,5), d2 = r(3,8), d3 = r(3,9);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — Gây 2 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn, <:Tremor:1513762737388257380>Tremor và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up. Nhận được 5 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** sau khi sử dụng`,
      ];
    },
  },
  "blasting shatterslash": {
    name: "Blasting Shatterslash", tags: "Burn/Tremor",
    cost: "4 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,8), d3 = r(8,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm <:Fix_Burn:1513762753691652177>Burn tương ứng với số <:Tremor:1513762737388257380>Tremor trên người địch và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up`,
      ];
    },
  },
  "tanglecleaver flurry": {
    name: "Tanglecleaver Flurry", tags: "Burn/Tremor",
    cost: "5 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(5,7), d3 = r(5,5);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn và tăng 5 <:DiceUp:1513767795681398894>Dice Up`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm 2 <:Fix_Burn:1513762753691652177>Burn và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Gây 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst *(nếu có trên hoặc bằng 15 Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round**)*. Tiêu toàn bộ Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** để gây thêm <:Fix_Burn:1513762753691652177>Burn tương ứng với số <:Tremor:1513762737388257380>Tremor trên người địch và tăng thêm 3 <:DiceUp:1513767795681398894>Dice Up tương ứng với mỗi Stack **<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round** được xả`,
      ];
    },
  },

  // ── Tiantui Star's Blade [天退星刀] ──
  "tiantui star's blade": {
    name: "Tiantui Star's Blade [天退星刀]", tags: "Weapon",
    weaponType: "Medium", weaponDmg: "14 [<:Slash:1513768633434640517>Slash]",
    passive: "**Reloading Tiantui Star's Blade** — Khi sử dụng <:Fix_Shin:1507591140180754588>Shin và dùng **Tiantui Star's Blade Reload**, bạn nhận được và chuyển hóa toàn bộ **<:Tigermark_Round:1528452815838777394>Tigermark Round** hiện có qua **<:Savage_Tigermark_Round:1528452850248843304>Savage Tigermark Round**",
    cost: "—", cd: "—", diceMul: "—",
    roll() { return [`*(Đây là passive/weapon entry — dùng tên Critical cụ thể để roll, VD: "tiantui triple slash blast" hoặc "tiantui savage tigerslayer flurry")*`]; },
  },
  "triple slash blast": {
    name: "Triple Slash Blast [爆]",
    weaponOf: "Tiantui Star's Blade [天退星刀]", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1.75x",
    roll() {
      const d1 = r(10,15);
      return [
        `${D1} *Tiêu thụ toàn bộ **<:Tigermark_Round:1528452815838777394>Tigermark Round** có trên người — mỗi 1 Round tiêu thụ gây thêm 1 <:Fix_Burn:1513762753691652177>Burn và 1 <:Tremor:1513762737388257380>Tremor tương ứng. Nếu có trên hoặc bằng 6 **<:Tigermark_Round:1528452815838777394>Tigermark Round**: gây thêm <:TremorBurst:1513802464632246352>Tremor Burst*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Khuỵu người xuống, rồi kích hoạt đạn của thanh kiếm tạo lực đẩy sau đó lao tới chặt kẻ địch`,
      ];
    },
  },
  "savage tigerslayer flurry": {
    name: "Savage Tigerslayer's Perfected Flurry of Blades [超絕猛虎殺擊亂斬]",
    weaponOf: "Tiantui Star's Blade [天退星刀]", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "2.25x",
    roll() {
      const d1 = r(5,7), d2 = r(5,7), d3 = r(10,13), d4 = r(8,9), d5 = r(5,7), d6 = r(20,21);
      return [
        `*Điều kiện: dùng ngay sau **Triple Slash Blast [爆]** và có ít nhất 10 **<:Savage_Tigermark_Round:1528452850248843304>Savage Tigermark Round** trên người*`,
        `${D1} *Tiêu thụ toàn bộ **<:Savage_Tigermark_Round:1528452850248843304>Savage Tigermark Round** có trên người — mỗi 1 Round tiêu thụ gây thêm 1 <:Fix_Burn:1513762753691652177>Burn, 1 <:Tremor:1513762737388257380>Tremor tương ứng vào Dice cuối*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Khuỵu người xuống, rồi kích hoạt đạn của thanh kiếm tạo lực đẩy sau đó lao tới chặt kẻ địch, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Fix_Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Sau đó tiếp tục chém, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Fix_Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Vận lực lấy đà lùi phía sau một chút rồi chém ngang, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Fix_Burn:1513762753691652177>Burn`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Sau đó bổ dọc xuống, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Fix_Burn:1513762753691652177>Burn`,
        `${D5} **${d5}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Rồi vung ngang, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Fix_Burn:1513762753691652177>Burn`,
        `${D6} **${d6}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] [AOE 4 người] — Khuỵu gối xuống vận lực, nổ ga lần cuối nữa rồi nhảy bổ lên bổ thanh kiếm xuống kẻ địch, gây 6 <:Tremor:1513762737388257380>Tremor, <:Fix_Burn:1513762753691652177>Burn và <:TremorBurst:1513802464632246352>Tremor Burst 2 lần`,
      ];
    },
  },
  "tanglecleaver reload": {
    name: "Tanglecleaver Reload",
    weaponOf: "Tiantui Star's Blade [天退星刀]", tags: "Weapon",
    // CD 4 Turn → 1 Turn (Fragaria chốt trực tiếp, lô 12/08).
    cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,10);
      return [
        `*Chỉ sử dụng được khi dùng vũ khí **Tiantui Star's Blade [天退星刀]** và Outfit **The Thumb Capo IIII***`,
        `${D1} **${d1}** — Ngắt một đòn của kẻ địch thông qua \`-rtparry\`, sau đó nạp **<:Tigermark_Round:1528452815838777394>Tigermark Round** vào **Tiantui Star's Blade [天退星刀]** tương ứng với số dice gieo ra *(nếu \`-rtparry\` thất bại thì vẫn nạp đạn được)*`,
      ];
    },
    // counterEffect — GAP ĐÃ SỬA (xác nhận trực tiếp: "Tanglecleaver Reload là
    // page counter nhé, hãy đọc description kỹ") — "Ngắt một đòn của kẻ địch
    // thông qua -rtparry" khớp CHÍNH XÁC mẫu page-counter (không phải hit:
    // skill thông thường). alwaysUnlocks: nạp Tigermark Round DÙ THẮNG HAY
    // THUA minigame (xác nhận trực tiếp: "nếu -rtparry thất bại thì vẫn nạp
    // đạn được"). noDirectDamage: dice không tự gây dmg phản công (chỉ là
    // "ngắt đòn" + nạp đạn). loadsTigermarkRound: field ĐẶC BIỆT riêng cho
    // page này — xử lý ở counterContext handler (index.js), không dùng
    // unlocksSkillKey/light/protection có sẵn vì hiệu ứng hoàn toàn khác.
    counterEffect: { alwaysUnlocks: true, noDirectDamage: true, loadsTigermarkRound: true },
  },
  "re-load": {
    name: "Re-Load",
    weaponOf: "Soldato Rifle", tags: "Weapon",
    cost: "2 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      return [
        `*Chỉ sử dụng được khi sử dụng vũ khí lẫn outfit của **The Thumb Syndicate***`,
        `${D1} Nạp một nửa số đạn tối đa của vũ khí. Số đạn nạp được từ Page này có thể tùy chọn giữa đạn thường, **Frost Ammo** và **Incendiary Ammo** tùy ý`,
      ];
    },
    // customLoad — GAP ĐÃ SỬA: field ĐẶC BIỆT riêng (không phải counterEffect,
    // vì đây không phải page-counter) — xử lý ở resolveOnePendingAction
    // (index.js) qua p.skillKey === "re-load". Nạp bulletStack = floor(8/2)=4,
    // KHÔNG tiêu inventory (khác hẳn lệnh -encounter reload có sẵn), loại đạn
    // chọn qua param type: (thường/frost/incendiary, tái dùng KNOWN_KEYS "type"
    // đã có sẵn). "Thumb Soldato" outfit: đồng minh Thumb nhận 1/2 số nạp
    // (làm tròn lên) — xử lý cùng chỗ.
    customLoad: { field: "bulletStack", max: 8, half: true },
    // GAP ĐÃ SỬA (Fragaria: "Page Re-load chưa cho chọn nạp đạn giữa đạn thường
    // hoặc frost hoặc incendiary; chỉ tự động nạp đạn thường").
    // Logic nạp ĐÃ hỗ trợ `p.loadType` từ lâu (resolve-pending-action.js), nhưng
    // UI KHÔNG BAO GIỜ cho chọn — chỉ lệnh text cũ có param `loadtype:`, còn
    // dropdown Moves thì không, nên luôn rơi về mặc định "ammo".
    // Dùng LẠI cơ chế `variants` (như Extreme Edge): người chơi bấm page → hiện
    // dropdown chọn loại → variantKey được map sang `loadType` ở
    // interaction-handlers.js. Không cần cơ chế UI mới.
    variants: [
      { key: "ammo", label: "Đạn thường", emoji: "🔫" },
      { key: "frost", label: "Frost Ammo", emoji: "❄️" },
      { key: "incendiary", label: "Incendiary Ammo", emoji: "🔥" },
    ],
  },
  "ignite weaponry": {
    name: "Ignite Weaponry", tags: "Burn",
    cost: "1 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      return [
        `*Nếu sử dụng outfit của **Liu Association** và gia nhập office của **Liu Association** sẽ tự động sử dụng được page này*`,
        `${D1} Đốt cháy vũ khí của bạn trong 2 Turn, khiến cho đòn đánh thường sẽ áp 1/2/4 [Light/Medium/Heavy] **Burn** lên kẻ địch`,
      ];
    },
    // igniteWeapon — GAP ĐÃ SỬA: field ĐẶC BIỆT riêng (không phải counterEffect,
    // không phải hit: gây dmg trực tiếp) — xử lý ở resolveOnePendingAction
    // (index.js) qua p.skillKey === "ignite weaponry". Bật weaponIgnitedTurnsLeft
    // = 2, mỗi M1 trong lúc đó tự áp Burn theo weaponWeight (1/2/4).
    igniteWeapon: { turns: 2, burnByWeight: { light: 1, medium: 2, heavy: 4 } },
  },

  // ── Serum K (Singularity) ──
  // ❗ Fragaria 12/08 bổ sung: ngoài hồi HP + giải 3 Debuff, Serum K còn
  // "chữa MỌI chấn thương của bản thân". Cờ `serumKHealInjuries` để
  // resolve-pending-action biết phải làm — KHÔNG viết riêng nhánh Caduceus-style.
  // ⚠️ Sizzling Wound VẪN không chữa được (chấn thương VĨNH VIỄN — xem
  // isPermanentInjury ở misc-helpers.js). Đây là luật đã chốt từ lô trước và
  // Serum K không phải ngoại lệ, vì "chỉ GM gõ lệnh mới gỡ được".
  "serum k": {
    name: "Serum K", tags: "Singularity",
    serumKHealInjuries: true,
    cost: "3 <:Light:1513786082502770719>Light", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,16);
      const heal = d1 * 2 + 25;
      return [
        `${D1} **${d1}** — Hồi phục **${heal} HP** (= số dice × 2 + 25), giải 3 Debuff bất kỳ của bản thân và chữa mọi chấn thương của bản thân`,
      ];
    },
  },

  // ── Ages of Harvest [Peach Blossom] ──
  "ages of harvest": {
    name: "Ages of Harvest [Peach Blossom]", tags: "Weapon",
    weaponType: "Light", weaponDmg: "1.7 [<:Slash:1513768633434640517>Slash]",
    passive: [
      `**Phi kiếm** — Đòn đánh thường chỉ tốn 1 Stamina thay vì 5 *(cần đánh thường trúng 20 lần để được 1 <:Light:1513786082502770719>Light)*`,
      `**Divine Blessing** — Khi sử dụng kỹ năng từ Tacet Mark, đòn khạc luôn gây 1x Res lên kẻ địch nếu nó đang dưới 1x Res`,
    ].join("\n"),
    cost: "—", cd: "—", diceMul: "—",
    roll() { return [`*(Đây là passive/weapon entry — dùng tên Critical cụ thể để roll, VD: "trailing blade")*`]; },
  },

  // ── Fused Blade of Ruined Mirror Worlds ──
  // Weapon entry cho passive "Dullahan" — đã được nhiều skill khác (Beheading, Smackdown,
  // v.v.) tham chiếu qua flavor text "Nếu đang dùng Fused Blade: nhận X Coffin" từ trước,
  // nhưng chưa từng có entry chính thức. Critical thật (Requiem, Lament Mourn and Despair)
  // đã tồn tại sẵn — chỉ update thêm tag [Unblockable]/[Undodgeable]/[Guard Break] còn thiếu.
  "fused blade of ruined mirror worlds": {
    name: "Fused Blade of Ruined Mirror Worlds", tags: "Weapon",
    weaponType: "Heavy", weaponDmg: "28 [<:Slash:1513768633434640517>Slash]",
    passive: `**Dullahan** — Parry thành công khiến bạn đánh thường lên kẻ địch. Vào turn kế sau khi Parry, nhận 1 Stack **Dullahan**. Khi có **Dullahan**: nhận 30% Dmg gây ra và giảm 15% Dmg Reduction; đồng thời mỗi turn end mất (15 − số **Coffin** hiện có) Sanity. Khi dưới -15 Sanity, mỗi turn end nhận thêm 1 Stack **Dullahan**`,
    cost: "—", cd: "—", diceMul: "—",
    roll() { return [`*(Đây là passive/weapon entry — dùng tên Critical cụ thể để roll, VD: "requiem" hoặc "lament mourn and despair")*`]; },
  },

  // ── Vengeance Retaliation ──
  // Dice2 (khi CÓ nhận sát thương) KHÔNG có base — giá trị THUẦN từ công thức
  // ceil(%HP mất × 2.5), tối đa 50 (tại mốc 20% HP, chính chủ xác nhận). Dice1 [2~4]
  // chỉ dùng khi KHÔNG có sát thương nào (hpLossPct = 0). Hiệu ứng nền (5 Fragile,
  // 6 Bleed, 3 Paralyze) áp dụng CẢ 2 nhánh; Dice2 cộng thêm 7 Fragile + 2 Paralyze
  // (gộp thành 12 Fragile / 5 Paralyze cho gọn, Bleed giữ 6 vì không có bonus riêng).
  "vengeance retaliation": {
    name: "Vengeance Retaliation",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    promptArg: {
      label: "% HP đã mất",
      parse: (s) => parseFloat(s),
      validate: (v) => !isNaN(v) && v >= 0 && v <= 100,
      errorMsg:
        "❓ **Vengeance Retaliation** cần nhập % HP đã mất kể từ lần dùng skill trước (0 nếu không mất gì).\n" +
        "> Cú pháp: `-skill vengeance retaliation <%>`\n" +
        "> VD: `-skill vr 0` (không mất dmg) | `-skill vr 15` (mất 15% HP)",
      buildHeader: (v, s) => `[${s.cost}] [CD: ${s.cd}] [HP mất: ${v}%]`,
    },
    roll(hpLossPct = 0) {
      const intro =
        `*Lượt kế tiếp sẽ vào trạng thái khi nhận càng nhiều sát thương, sát thương đầu ra càng cao ` +
        `(Mỗi 1% Mất tăng thêm 2.5 Dice Value cho Dice 2, làm tròn lên nếu lẻ) (Max: 20% Hp). ` +
        `Lượt tiếp theo: Tụ lực vào nắm đấm tấn công kẻ địch.*`;
      if (hpLossPct <= 0) {
        const d1 = r(2, 4);
        return [
          intro,
          `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] — Không có sát thương nào — gây 5 <:Fragile:1513763336167100536>Fragile, 6 <:Bleed:1513762688226955285>Bleed và 3 <:Paralyze:1513763316479295548>Paralyze turn kế`,
        ];
      }
      const cappedPct = Math.min(hpLossPct, 20);
      const d2 = Math.ceil(cappedPct * 2.5);
      return [
        intro,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] — HP mất ${cappedPct}%${hpLossPct > 20 ? " *(vượt mốc, tính tối đa 20%)*" : ""} — gây 12 <:Fragile:1513763336167100536>Fragile, 6 <:Bleed:1513762688226955285>Bleed và 5 <:Paralyze:1513763316479295548>Paralyze turn kế`,
      ];
    },
  },
});

// ── Aliases mới (thêm vào đây khi có alias mới) ──
Object.assign(SKILL_ALIASES, {
  // ── Class Card: Archer — alias ngắn (Fragaria 14/08) ──────────────────────
  // Tên đầy đủ dài 46 ký tự; `customId` dạng `...:<key>` chạm ~92/100 ký tự — SÁT
  // trần cứng 100 của Discord. Alias ngắn để GM gõ nhanh VÀ để chỗ nào dựng
  // customId từ key cũng có đường an toàn.
  "seven rings": "the seven rings that cover the burning heavens",
  "the seven rings": "the seven rings that cover the burning heavens",
  "caladbolg": "fake spiral spear - caladbolg ii",
  "caladbolg ii": "fake spiral spear - caladbolg ii",
  "kanshou": "kanshou & bakuya overedge",
  "bakuya": "kanshou & bakuya overedge",
  // ⚠️ KHÔNG thêm alias "kanshou and bakuya overedge": repo không có đường chuẩn
  // hoá "and" → "&" nên alias đó không bao giờ ăn (đã thử, resolveSkillKey → null).
  // Alias chết còn tệ hơn không có: người sau tưởng nó chạy. Dùng "kanshou"/"bakuya"/"overedge".
  "overedge": "kanshou & bakuya overedge",
  // Illusory Land of Great Void
  "whirlwind": "whirlwind",
  // Vengeance Retaliation
  "vr": "vengeance retaliation",
  "vengeanceretaliation": "vengeance retaliation",
  // Lucent Historia
  "designant": "designant.",
  "astralquantization": "astral quantization",
  "aq": "astral quantization",
  // РАСКО́Л
  "slay": "slay",
  "raskol": "slay",
  // Nyoibo
  "oneinchpunch": "one inch punch",
  "oip": "one inch punch",
  "powerpolextend": "power pole extend",
  "ppe": "power pole extend",
  "powerpole": "power pole extend",
  // WALPURGISNACHT
  "drillingstab": "drilling stab",
  "ds2": "drilling stab",
  "walpurgis": "drilling stab",
  // EGO Pages ZAYIN
  "crowseyeview": "crow's eye view",
  "cev": "crow's eye view",
  "lasangre": "la sangre de sancho",
  "sancho": "la sangre de sancho",
  "lsds": "la sangre de sancho",
  "repemitter": "representation emitter",
  "re": "representation emitter",
  "landofillusion": "land of illusion",
  "loi": "land of illusion",
  // Heat skills
  "dragonchoke": "dragon choke impact",
  "dci": "dragon choke impact",
  "armlock": "arm lock",
  "al": "arm lock",
  "invertedcross": "inverted cross arm wrench",
  "icaw": "inverted cross arm wrench",
  "kneebreak": "knee break",
  "kb": "knee break",
  "truereversedrop": "true reverse drop",
  "trd": "true reverse drop",
  "cripplingcrossface": "crippling crossface",
  "ccf": "crippling crossface",
  "midlinetriplethrust": "midline triple thrust",
  "mtt": "midline triple thrust",
  "lightningbackkick": "lightning back kick",
  "lbk": "lightning back kick",
  "aikimugenthrow": "aiki mugen throw",
  "amt": "aiki mugen throw",
  "headcrash": "head crash",
  "hc2": "head crash",
  "mountedpunchrush": "mounted punch rush",
  "mpr": "mounted punch rush",
  "reverseliftupslam": "reverse lift up slam",
  "rlus": "reverse lift up slam",
  // Sueño Imposible
  "forjustice": "for justice",
  "fj": "for justice",
  "sueñoimposible": "for justice",
  "suenoimposible": "for justice",
  "sueno": "for justice",
  // Passive Skills
  "followup": "follow-up",
  "fu": "follow-up",
  // Halberd VOGEL
  "ravagingcut": "ravaging cut",
  "rc": "ravaging cut",
  "halberdvogel": "ravaging cut",
  "vogel": "ravaging cut",
  // Blade Lineage Hwando
  "strikersstance": "striker's stance",
  "ss2": "striker's stance",
  "hwandoss": "striker's stance",
  "heelturn": "heel turn",
  "ht2": "heel turn",
  "hwandoht": "heel turn",
  "flankthrust": "flank thrust",
  "ft2": "flank thrust",
  "hwandoft": "flank thrust",
  "hwando": "striker's stance",
});

// ─── findSkill (giữ nguyên logic, chuyển từ index.js sang đây) ───────────────
function findSkill(raw) {
  // BUG THẬT ĐÃ SỬA (phát hiện qua crash thật khi test tự động hoá batch 4):
  // trước đây raw.toLowerCase() KHÔNG an toàn với null/undefined — crash ngay
  // khi findWeaponAnywhere() được gọi với weaponName của ENEMY (enemy không có
  // field này, luôn undefined) — VD trong Payback automation mới. findWeapon()
  // đã an toàn từ trước (raw ?? ""), findSkill() lại thiếu — giờ đồng bộ.
  const key = (raw ?? "").toLowerCase().trim();
  // 1. Tra SKILLS trực tiếp với key gốc (giữ nguyên space/dash)
  if (SKILLS[key]) return SKILLS[key];
  // 2. Tra alias: strip toàn bộ space, dash, dấu phẩy để map về canonical key.
  //    replace(/[\s\-,]/g) đã xóa hết space rồi nên không cần replace(/\s+/g, " ") thêm
  //    (thao tác thứ hai đó không bao giờ có tác dụng và chỉ gây hiểu nhầm về intent).
  // BUG NGHIÊM TRỌNG ĐÃ SỬA (phát hiện qua test tự động hoá batch 4): TRƯỚC ĐÂY
  // chỉ strip space/dash/comma — bất kỳ Critical nào có DẤU HAI CHẤM trong tên
  // hiển thị (VD "Great Split: Vertical", "Atelier Logic: Shotgun") đều KHÔNG
  // BAO GIỜ tìm ra được khi chọn từ dropdown (dropdown dùng skill.name TRỰC TIẾP,
  // có dấu ":", làm value) — vì alias thật (VD "greatsplitvertical") không có
  // dấu ":", nên aliasLookup (giữ nguyên dấu ":") không bao giờ khớp. Thêm ":"
  // vào regex strip để khớp đúng.
  const aliasLookup = key.replace(/[\s\-,:]/g, "");
  const aliasKey = SKILL_ALIASES[aliasLookup];
  if (aliasKey && SKILLS[aliasKey]) return SKILLS[aliasKey];
  // 2b. BUG ĐÃ SỬA (Fragaria: "Atelier Logic vẫn chưa bắn crit được để đổi dạng").
  // Bước 2 ở trên CHỈ cứu được skill có sẵn entry trong SKILL_ALIASES. Skill có
  // dấu ":" trong tên hiển thị mà KHÔNG có alias thì vẫn trượt hết mọi bước:
  //   name "Atelier Logic: Shotgun" → key "atelier logic: shotgun"
  //   nhưng key thật trong SKILLS là "atelier logic shotgun" (KHÔNG dấu ":")
  // Bước 3 (partial match) cũng trượt vì `keyStripped` vẫn còn dấu ":" ở cuối.
  // Hệ quả: dropdown dùng skill.name làm value → findSkill trả null → Critical
  // KHÔNG BAO GIỜ bắn được (Great Split thoát nạn chỉ vì tình cờ CÓ alias).
  // Giờ bỏ dấu ":" rồi tra THẲNG SKILLS — tổng quát cho mọi skill tương lai.
  const keyNoColon = key.replace(/:/g, "").replace(/\s+/g, " ").trim();
  if (keyNoColon !== key && SKILLS[keyNoColon]) return SKILLS[keyNoColon];
  // 2c. BUG ĐÃ SỬA (phát hiện khi làm resolveSkillKey — dò 324 skill).
  // Bước 2b chỉ bỏ dấu ":". Còn DẤU NHÁY và DẤU CÂU thì vẫn trượt hết:
  //   • name "Wheel's Industry" → key thật `wheels industry` → findSkill trả
  //     NULL → Critical của Wheel's Industry KHÔNG BAO GIỜ bắn được từ dropdown
  //     (dropdown dùng skill.name làm value). Đúng cùng họ bug với Atelier Logic.
  //   • name "For Justice!!!" còn TỆ HƠN NULL: nó rơi xuống bước 3 (partial
  //     match), `keyStripped` = "for", rồi `k.includes("for")` khớp NHẦM
  //     "the forgotten" → trả về SAI SKILL HOÀN TOÀN mà không báo lỗi gì.
  // SỬA: chuẩn hoá CẢ HAI PHÍA (bỏ dấu tiếng Latin mở rộng + mọi ký tự không
  // phải chữ/số/space, gộp space) rồi so KHỚP CHÍNH XÁC. Đặt TRƯỚC bước 3 để
  // tên đầy đủ luôn thắng partial match mù quáng.
  const punctNorm = (str) => str
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/gi, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const keyPunctNorm = punctNorm(key);
  if (keyPunctNorm) {
    for (const [k, v] of Object.entries(SKILLS)) {
      if (punctNorm(k) === keyPunctNorm) return v;
    }
    for (const [, v] of Object.entries(SKILLS)) {
      if (v.name && punctNorm(v.name) === keyPunctNorm) return v;
    }
  }
  // 3. Fallback: tìm partial match trong SKILLS keys
  const keyStripped = key.replace(/\s+\S+$/, "").trim();
  for (const [k, v] of Object.entries(SKILLS)) {
    if (k.includes(key) || (keyStripped && k.includes(keyStripped) && keyStripped.length >= 3)) return v;
  }
  // 4. GAP ĐÃ SỬA (phát hiện qua test tự động hoá page-counter: "Furūsiyya"
  // không tìm ra được) — 1 số skill.name có ký tự Latin mở rộng (ū, æ...) mà
  // KEY trong SKILLS lại dùng chữ cái ASCII thường (VD name "Furūsiyya" nhưng
  // key "furusiyya") — .toLowerCase() KHÔNG tự bỏ dấu these — cần Unicode
  // normalize (NFD tách dấu ra khỏi chữ cái gốc rồi strip) làm fallback CUỐI
  // cùng, sau khi 3 bước tra cứu gốc đã thử hết (tránh phá các trường hợp
  // dùng chung tên hiển thị nhưng key CỐ Ý khác nhau, VD "Dimensional Rift
  // Dagger"/"Dimensional Rift Gauntlets" đều trỏ tên "Dimensional Rift").
  const keyNormalized = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (keyNormalized !== key && SKILLS[keyNormalized]) return SKILLS[keyNormalized];
  return null;
}

// ─── findByKeyword — dùng cho lệnh `-skill list <keyword>` ──────────────────
// Tìm tất cả skill có keyword xuất hiện trong: name, tags, keywords[], passive,
// hoặc trong nội dung roll() (emoji name được strip để match text thuần).
// half — chia đôi giá trị 1 dice thành 2 hit (dùng cho dice kiểu "50% loại A /
// 50% loại B", xác nhận trực tiếp: "dice ra 20 → 2 Hit: 10 Slash + 10 Blunt").
// Giữ TỔNG chính xác với số lẻ (23 → 11.5 mỗi bên) — damage-calc.js parse được
// số thập phân. Bỏ ".0" thừa cho số chẵn để hiển thị gọn.
function half(v) {
  const h = v / 2;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

function findByKeyword(keyword) {
  const kw = keyword.toLowerCase().trim();
  const results = [];

  for (const [, skill] of Object.entries(SKILLS)) {
    // 1. Kiểm tra name
    if (skill.name.toLowerCase().includes(kw)) { results.push(skill); continue; }

    // 2. Kiểm tra tags field
    if (skill.tags && skill.tags.toLowerCase().includes(kw)) { results.push(skill); continue; }

    // 3. Kiểm tra keywords[] (field tùy chọn)
    if (Array.isArray(skill.keywords) && skill.keywords.some(k => k.toLowerCase().includes(kw))) {
      results.push(skill); continue;
    }

    // 4. Kiểm tra passive description
    if (skill.passive && skill.passive.toLowerCase().includes(kw)) { results.push(skill); continue; }

    // 5. Kiểm tra nội dung roll() — strip Discord emoji code thành tên emoji
    try {
      const rollText = skill.roll()
        .join(" ")
        .replace(/<:([^:]+):\d+>/g, "$1") // <:Sinking:123> → Sinking
        .toLowerCase();
      if (rollText.includes(kw)) { results.push(skill); continue; }
    } catch (_) {
      // skill.roll() cần arg đặc biệt (có promptArg) → search errorMsg thay thế
      if (skill.promptArg?.errorMsg?.toLowerCase().includes(kw)) { results.push(skill); continue; }
    }
  }

  return results;
}

// autoBuildDmgStrFromSkillRoll — GAP ĐÃ SỬA (xác nhận trực tiếp: "Bot tự roll
// Durandal, tự cho vào phần modal Dmg ra dmg đầu cuối lên kẻ địch") — best-effort
// TỰ ĐỘNG dựng dmgStr TỪ kết quả roll() thật của 1 skill, dùng để pre-fill Modal
// (KHÔNG PHẢI thay thế hoàn toàn việc GM/player tự kiểm tra — vẫn SỬA ĐƯỢC trước
// khi gửi).
//
// GIỚI HẠN THẬT (đã kiểm tra cụ thể với nhiều skill, KHÔNG PHẢI lý thuyết):
// - Durandal có 3 dice RIÊNG, tag KHÁC NHAU mỗi dice (dice1 [Unblockable], dice3
//   [Guard Break] + "nhận 3 Dice Up") — dmgStr KHÔNG CÓ CÁCH biểu diễn "tag riêng
//   theo từng dice" (chỉ có tag CHUNG cho toàn bộ action) — nên hàm này CHỈ ghép
//   đúng số+type của từng dice, CÒN tag phòng thủ/hiệu ứng phụ được liệt kê riêng
//   trong `warnings` để hiển thị cho GM/player TỰ THÊM TAY (KHÔNG tự động áp,
//   tránh trường hợp Guard Break bị "quên" mất vì gộp nhầm).
// - Tactical Suppression (Eye Of Horus) HOÀN TOÀN không có dice (kích hoạt trạng
//   thái, không phải đòn sát thương) — hàm này trả `dmgStr: null` cho trường hợp
//   đó, KHÔNG cố bịa ra số.
// - Grappling có điều kiện "Hakuda" (dice đổi range nếu vừa dùng skill Airborne
//   trước đó) — hệ thống KHÔNG track được điều kiện này, nên số dice trả về LUÔN
//   là range gốc — warnings sẽ nhắc GM tự kiểm tra nếu skill có ghi chú dạng này.
//
// @returns { dmgStr: string|null, warnings: string[], skillRollEmbed }
// ══════════════════════════════════════════════════════════════════════════
// autoExtractDiceSideEffects — GAP HỆ THỐNG RỘNG ĐÃ SỬA (Fragaria yêu cầu trực
// tiếp: "có thể còn rất nhiều page vẫn chưa gây debuff hoặc nhận buff đúng nữa
// nên check lại 1 lượt và làm hết").
//
// VẤN ĐỀ: quét toàn bộ 324 skill cho thấy ~130 skill mô tả hiệu ứng phụ trong
// text roll() (Dice Up, Fragile, Paralyze, Bind, Haste, Protection, Defense Up,
// Nails, Smoke, Imitation, Hemorrhage, Freeble...) nhưng KHÔNG có logic nào áp
// dụng. Trước đây mỗi cái phải hardcode riêng từng skill trong
// resolve-pending-action.js — sót là chuyện đương nhiên (Level Slash/Spear là
// ví dụ Fragaria bắt được, còn hàng chục cái khác chưa ai để ý).
//
// GIẢI PHÁP: parse TỰ ĐỘNG từ chính text mô tả, sinh ra mảng diceEffects giống
// hệt định dạng viết tay — resolve-pending-action.js áp dụng y như nhau (gate
// bằng hitEvadedOrParried: dice bị né/parry thì KHÔNG dính hiệu ứng).
//
// KHÔNG bao gồm 7 status đã đi qua dmgStr (Bleed/Burn/Rupture/Sinking/Tremor/
// Poise/Charge) — chúng được calcMathCore xử lý rồi, thêm ở đây là ÁP 2 LẦN.
//
// XÁC ĐỊNH HƯỚNG (self hay target) theo thứ tự ưu tiên:
//   1. Có dấu hiệu TARGET rõ ràng ngay trước số ("gây", "gắn", "địch nhận",
//      "kẻ địch/kẻ thù/chúng/mục tiêu ... nhận") → áp lên TARGET
//   2. Có "nhận"/"hồi"/"tự" → áp lên BẢN THÂN
//   3. Không rõ → theo bản chất status (debuff→target, buff→self)
// Skill viết tay diceEffects thì GIỮ NGUYÊN bản viết tay, không đụng tới.
const DICE_SIDE_EFFECT_MAP = {
  // key hiển thị trong text → { field, defaultSide }
  "Dice Up":        { field: "diceUp", side: "self" },
  "DiceUp":         { field: "diceUp", side: "self" },
  "Dice Down":      { field: "diceDown", side: "target" },
  "DiceDown":       { field: "diceDown", side: "target" },
  "Fragile":        { field: "fragile", side: "target" },
  "Paralyze":       { field: "paralyze", side: "target" },
  "Bind":           { field: "bind", side: "target" },
  "Nails":          { field: "nails", side: "target" },
  "Smoke":          { field: "smoke", side: "target" },
  "Freeble":        { field: "freeble", side: "target" },
  "Hemorrhage":     { field: "hemorrhage", side: "target" },
  "Defense Down":   { field: "defenseDown", side: "target" },
  // Airborne (GAP ĐÃ SỬA — Fragaria: "Airborne cũng chưa được implement"):
  // "hất tung — kẻ địch bị hất tung nhận 10 Dmg vào End Turn. Biến mất sau End
  // Turn hoặc sau bị dính đòn có condition Airborne". Field `airborne` đã tồn
  // tại sẵn trong combatant-factory.js và đã hiện ở encounter-display.js, nhưng
  // KHÔNG có logic nào gán/tiêu thụ nó — chỉ là text mô tả suông.
  // Dùng số (1) thay boolean để đi chung cơ chế diceEffects; xử lý ở
  // resolve-pending-action.js (ép về true) và turn-advance.js (gây 10 dmg + xoá).
  "Airborne":       { field: "airborne", side: "target" },
  "DefenseDown":    { field: "defenseDown", side: "target" },
  "Haste":          { field: "haste", side: "self" },
  "Protection":     { field: "protection", side: "self" },
  "Defense Up":     { field: "defenseUp", side: "self" },
  "DefenseUp":      { field: "defenseUp", side: "self" },
  "Imitation":      { field: "imitation", side: "self" },
  "Regen":          { field: "regen", side: "self" },
  // ❗❗ GAP HỆ THỐNG ĐÃ SỬA (Fragaria: "khi Crit cũng chưa xử lý Poise ở dmg
  // parse của encounter; điều này cũng là minh chứng cho thấy hiện tại encounter
  // chỉ lấy dmg thuần, Dice Up và Dmg Bonus, ngoài ra còn THIẾU RẤT NHIỀU THỨ").
  // Bảng này TRƯỚC ĐÂY thiếu hẳn các status CỐT LÕI — nên MỌI page ghi hiệu ứng
  // theo từng dice (không riêng Caduceus) đều mất sạch phần đó.
  "Poise":          { field: "poise", side: "self" },
  "Sinking":        { field: "sinking", side: "target" },
  "Rupture":        { field: "rupture", side: "target" },
  "Bleed":          { field: "bleed", side: "target" },
  "Burn":           { field: "burn", side: "target" },
  "Tremor":         { field: "tremor", side: "target" },
  "Charge":         { field: "charge", side: "self" },
  "Light":          { field: "light", side: "self" },
  "Blind":          { field: "blind", side: "target" },
};
// Đặt tên DÀI trước tên NGẮN cùng tiền tố ("Defense Down" trước "Defense Up"
// không quan trọng, nhưng "DiceUp" vs "Dice Up" thì có) — sort theo độ dài giảm.
const DICE_SIDE_EFFECT_NAMES = Object.keys(DICE_SIDE_EFFECT_MAP).sort((a, b) => b.length - a.length);

/** extractDmgTakenGrants — đọc các dòng dice dạng
 *    "địch nhận thêm 5% Dmg turn này"            → mọi loại
 *    "địch nhận thêm 10% Dmg từ Blunt turn này"  → chỉ Blunt
 *
 *  ❗ Fragaria chốt 12/08: đây CŨNG LÀ DmgTaken. Trước đây 4 mặt Caduceus (4/6/7/8)
 *  chỉ IN RA CHỮ — không field nào lưu, không nơi nào đọc, tức CHƯA TỪNG chạy.
 *  (`constants.js` có `effect: "foe:takeDmgType:10"` nhưng cũng không ai đọc.)
 *  Trả `{ all, byType: { B, P, S } }` — cộng dồn qua mọi dice của đòn.
 */
function extractDmgTakenGrants(lines) {
  const out = { all: 0, byType: { B: 0, P: 0, S: 0 } };
  const TYPE_KEY = { blunt: "B", pierce: "P", slash: "S" };
  for (const line of lines ?? []) {
    if (!/^<:Dice\d+:/.test(line)) continue;
    // "nhận thêm N% Dmg" + (tuỳ chọn) "từ <Type>"
    const re = /nh[ậa]n\s*th[êe]m\s*(\d+(?:\.\d+)?)\s*%\s*Dmg(?:\s*t[ừu]\s*(?:<:[^:>]+:\d+>)?\s*(Blunt|Pierce|Slash))?/gi;
    let m;
    while ((m = re.exec(line)) !== null) {
      // Chỉ nhận khi chủ ngữ là ĐỊCH — "bản thân +10% Dmg turn sau" (mặt 3) là
      // DmgBonus của NGƯỜI DÙNG, không được rơi vào đây.
      const ctx = line.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
      if (!/(địch|kẻ thù|kẻ địch|chúng|mục tiêu)[^.]*$/.test(ctx)) continue;
      const amount = parseFloat(m[1]);
      if (!(amount > 0)) continue;
      const t = m[2] ? TYPE_KEY[m[2].toLowerCase()] : null;
      if (t) out.byType[t] += amount; else out.all += amount;
    }
  }
  return (out.all > 0 || out.byType.B > 0 || out.byType.P > 0 || out.byType.S > 0) ? out : null;
}

function autoExtractDiceSideEffects(lines) {
  const effects = [];
  for (const line of lines) {
    if (!/^<:Dice\d+:/.test(line)) continue;
    if (!/\[<:(?:Slash|Blunt|Pierce):\d+>(?:Slash|Blunt|Pierce)\]/.test(line)) continue;
    if (!/\*\*(-?[\d.]+)\*\*/.test(line)) continue;
    const eff = {};
    for (const name of DICE_SIDE_EFFECT_NAMES) {
      const { field, side } = DICE_SIDE_EFFECT_MAP[name];
      if (eff[field] !== undefined || eff[field + "__t"] !== undefined) continue;
      const namePat = name.replace(/\s+/g, "\\s*");
      // Bắt "N <:Emoji:id>Tên" HOẶC "N Tên" (một số dòng không kèm emoji)
      // `[*\[\]]*` — cho phép markdown/ngoặc chen giữa số và tên status (VD
      // "gây 1 **[Airborne]**", "nhận 2 **Poise**") — trước đây pattern chỉ chấp
      // nhận khoảng trắng + emoji nên mọi status viết đậm/đóng ngoặc đều trượt.
      const re = new RegExp(`(\\d+)\\s*[*\\[\\]]*\\s*(?:<:[^:>]+:\\d+>)?\\s*[*\\[\\]]*\\s*${namePat}(?![A-Za-z])`, "i");
      const m = line.match(re);
      if (!m) continue;
      const amount = parseInt(m[1], 10);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      // Ngữ cảnh 40 ký tự trước con số — đủ để bắt động từ/chủ ngữ.
      const ctx = line.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
      let resolvedSide;
      if (/(gây|gắn|áp)\s*$|(?:địch|kẻ thù|kẻ địch|chúng|mục tiêu)[^.]*$/.test(ctx)) resolvedSide = "target";
      else if (/(nhận|hồi|tự)[^.]*$/.test(ctx)) resolvedSide = "self";
      else resolvedSide = side;
      // "giảm/trừ/tiêu/mất" = chiều ÂM — KHÔNG tự áp (hướng không chắc chắn,
      // để GM tự chỉnh, giống nguyên tắc đã dùng cho Poise/Charge consume).
      if (/(giảm|trừ|tiêu|mất|xoá|xóa)[^.]*$/.test(ctx)) continue;
      if (resolvedSide === "target") eff[field + "__t"] = amount;
      else eff[field] = amount;
    }
    effects.push(Object.keys(eff).length > 0 ? eff : null);
  }
  return effects.some(Boolean) ? effects : null;
}

/** extractNonDmgStrEffects — TÁCH RIÊNG những hiệu ứng KHÔNG thể đi qua dmgStr.
 *
 *  BUG HỆ THỐNG ĐÃ SỬA (Fragaria: "Page Onrush không giảm stamina như text ghi,
 *  có vẻ còn nhiều page cũng thế không hoạt động đúng như effect").
 *
 *  BỐI CẢNH: `damageRegex` (damage-calc.js) CHỈ hiểu Sinking/Rupture/Poise/
 *  Charge/Burn/Bleed/Tremor/TremorBurst/Living/Departed/Crit. Mọi hiệu ứng khác
 *  viết trong roll() chỉ là CHỮ — không có đường nào chạy. Rà 324 skill thì có
 *  hàng chục page rơi vào cảnh này, nổi bật:
 *    • Fragile / Paralyze  → Vengeance Retaliation ghi "12 Fragile, 5 Paralyze"
 *                            mà CHƯA TỪNG áp được cái nào.
 *    • giảm N Stamina địch → Onrush, Regret, Fragments from Somewhere,
 *                            Flooding Bullets.
 *    • nhận N Imitation / N Light / hồi N HP cho bản thân.
 *
 *  VÌ SAO KHÔNG NHÉT VÀO damageRegex: đó là khúc mỏng manh nhất của codebase
 *  (mỗi tag phải xuyên qua sumSignedTag → dmgValues → preview → apply, 4 tầng).
 *  Fragile/Paralyze KHÔNG tham gia công thức dmg nên không cần đi đường đó —
 *  đọc thẳng từ text đã roll rồi áp ở resolve-pending-action.js là đủ và an toàn.
 *
 *  QUY TẮC ĐỌC: chỉ nhận dạng "<số> <Tên>" (emoji đứng giữa cũng được, vì text
 *  hay viết `5 <:Fragile:...>Fragile`). Dòng có chữ "Nếu"/"nếu" ở đầu là hiệu
 *  ứng CÓ ĐIỀU KIỆN → BỎ QUA (điều kiện thật phải xử lý bằng code riêng, đúng
 *  gotcha đã ghi trong HANDOFF: parser auto-gắn bất kể điều kiện).
 *  @returns {{fragile:number, paralyze:number, drainStamina:number, selfImitation:number, selfLight:number, healHp:number}}
 */
function extractNonDmgStrEffects(lines) {
  const out = { fragile: 0, paralyze: 0, airborne: 0, hemorrhage: 0, drainStamina: 0, selfImitation: 0, selfLight: 0, selfHaste: 0, healHp: 0, selfDiceUp: 0, selfDiceUpTurns: 0, blind: 0, selfShieldPerTarget: 0, selfCharge: 0, selfProtection: 0, allyProtection: 0 };
  const stripEmoji = (t) => t.replace(/<a?:[^:>]+:\d+>/g, "");
  for (const raw of lines ?? []) {
    const line = stripEmoji(String(raw));
    // Bỏ dòng điều kiện — "*Nếu địch có ≥20 Tremor: ...*"
    if (/(^|[*_\s(])n[eế]u\s/i.test(line)) continue;
    const sum = (re) => {
      let m, total = 0;
      const r2 = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      while ((m = r2.exec(line)) !== null) total += parseInt(m[1], 10) || 0;
      return total;
    };
    out.fragile      += sum(/(\d+)\s*Fragile/i);
    // Hemorrhage — PHẢI có nguồn INFLICT riêng thì mới bắt đầu có (Fragaria:
    // "cần phải inflict Hemorrhage TRƯỚC thì mới bắt đầu có Hemorrhage chứ
    // không phải cứ inflict Bleed là có; Bleed chỉ là thứ để TĂNG TIẾN lvl").
    // Bắt cả "gắn 1 Hemorrhage" lẫn "gây 2 Hemorrhage".
    out.hemorrhage   += sum(/(?:g[âaăằ]y|g[ắa]n|áp)\s*(\d+)\s*<?[^>\s]*>?\s*Hemorrhage/i);
    out.paralyze     += sum(/(\d+)\s*Paralyze/i);
    // "giảm 40 Stamina địch" / "-40 Stamina của địch" — BẮT BUỘC có chữ "địch"
    // để không nhầm với chi phí Stamina của CHÍNH MÌNH.
    out.drainStamina += sum(/gi[ảa]m\s*(\d+)\s*Stamina\s*(?:c[ủu]a\s*)?[đd][ị i]ch/i);
    out.selfImitation += sum(/nh[ậa]n\s*(\d+)\s*Imitation/i);
    // "hồi lại N Light" / "hồi N Light" cũng phải bắt — Fragaria: "Extract Fuel
    // có vẻ không hồi light sau khi sử dụng". Text của nó ghi "hồi lại 2 Light"
    // chứ không phải "nhận 2 Light" nên regex cũ trượt sạch.
    out.selfLight     += sum(/(?:nh[ậa]n|h[ồo]i(?:\s*l[ạa]i)?)\s*(\d+)\s*<?[^>\s]*>?\s*Light/i);
    out.healHp        += sum(/h[ồo]i(?:\s*ph[ụu]c)?\s*(\d+)\s*(?:HP|M[áa]u)/i);
    // Haste — BẮT BUỘC động từ "nhận" NGAY trước số (cùng nguyên tắc gainOnly của
    // Poise/Charge trong AUTO_STATUS_TAGS). Cố ý BỎ SÓT các dạng mập mờ hơn:
    //   • Catch Breath "khi dưới 50% HP thêm 2 Poise và 4 Haste" → CÓ ĐIỀU KIỆN
    //     nằm giữa dòng dice, không được áp mù.
    //   • Fervent Beats "nhận NGAY 10 Dice Up, 10 Defense Up, ... 10 Haste" → số
    //     không đứng liền sau "nhận" nên không khớp.
    // Bỏ sót thì GM gõ tay được; áp NHẦM thì phá cân bằng âm thầm — chọn bỏ sót.
    out.selfHaste     += sum(/nh[ậa]n\s*(\d+)\s*Haste/i);
    // ── Fragaria 14/08: Hana Association Book + R Corp Book ────────────────
    // Luật đã xác nhận:
    //  • Protection: −5% dmg nhận/stack (max 20), hết sau 2 turn.
    //  • Haste: +1 Speed/stack (max 20), mất sạch sau end turn của turn được cộng.
    //  • Bind: −1 Speed/stack (max 20), cùng cách hết như Haste.
    // Cả ba ĐÃ CÓ logic sẵn trong repo (turn-advance + misc-helpers + combat-utils)
    // — chỉ thiếu đường ĐỌC TỪ TEXT page, nên bổ sung tại parser CHUNG này thay vì
    // vá riêng từng page (lớp lỗi 8).
    out.selfCharge    += sum(/nh[aậ]n\s*(\d+)\s*<?[^>\s]*>?\s*Charge/i);
    // "Cho TẤT CẢ ĐỒNG MINH N Protection" — phải bắt TRƯỚC mẫu self, nếu không
    // "cho tất cả đồng minh 1 Protection" sẽ bị mẫu self nuốt mất.
    {
      const mAlly = /cho\s*\*{0,2}t[aấ]t\s*c[aả]\s*[dđ][oồ]ng\s*minh\*{0,2}\s*(\d+)\s*<?[^>\s]*>?\s*Protection/i.exec(line);
      if (mAlly) out.allyProtection += parseInt(mAlly[1], 10) || 0;
      else out.selfProtection += sum(/nh[aậ]n\s*(\d+)\s*<?[^>\s]*>?\s*Protection/i);
    }
    // Blind (Wedjat) — "gây 5 Blind": mỗi stack làm 1 đòn ĐÁNH THƯỜNG kế trượt.
    out.blind         += sum(/(?:g[âa]y|g[ắa]n|áp)\s*(\d+)\s*(?:<[^>]*>)?\s*Blind/i);
    // Shield NHẬN THEO TỪNG MỤC TIÊU dính đòn (Wedjat: "Nhận 100 HP Shield với
    // TỪNG mục tiêu dính đòn") — khác selfShield thường ở chỗ nhân theo số target.
    {
      const m = line.match(/nh[ậa]n\s*(\d+)\s*HP\s*Shield\s*v[ớo]i\s*T[ỪU]NG\s*m[ụu]c\s*ti[êe]u/i);
      if (m) out.selfShieldPerTarget += parseInt(m[1], 10);
    }
    // Dice Up TỰ NHẬN có thời hạn — VD Focus Spirit: "Nhận 2 Dice Up tồn tại 2 Turn".
    // GAP ĐÃ SỬA (Fragaria: "Page Focus Spirit không cho dice up"): parser TRƯỚC ĐÂY
    // không có field `selfDiceUp` nào cả, nên dòng đó chỉ là chữ. Page thuần buff
    // (dmgStr = null) đi thẳng nhánh "không có dice sát thương" và không áp gì hết.
    // ⚠️ Bắt CẢ thời hạn: Dice Up bị reset về 0 mỗi turn ở advanceCombatantTurn,
    // nên "tồn tại N Turn" phải lưu thành bonus BỀN rồi cộng lại mỗi turn
    // (khuôn auguryKickDiceUpBonus). Không có "Turn" thì coi như chỉ turn này.
    {
      const m = line.match(/nh[ậa]n\s*(\d+)\s*(?:<[^>]*>)?\s*Dice\s*Up/i);
      if (m) {
        out.selfDiceUp += parseInt(m[1], 10);
        const mt = line.match(/t[ồo]n\s*t[ạa]i\s*\*{0,2}(\d+)\s*Turn/i);
        out.selfDiceUpTurns = Math.max(out.selfDiceUpTurns, mt ? parseInt(mt[1], 10) : 1);
      }
    }
    // Airborne — debuff LÊN ĐỊCH ("đá kẻ địch lên trời gây 1 [Airborne]").
    // Cho phép markdown xen giữa: text thật là "gây 1 **[Airborne]**".
    out.airborne      += sum(/g[âaăằ]y\s*(\d+)\s*[*\[\s]*Airborne/i);
    // Fragaria: "[Airborne] đã tự động chưa? … nếu chưa thì hãy tự động hoá, và
    // một số skill ghi [Uptilt] — Uptilt và Airborne LÀ MỘT, sửa về Airborne."
    // Dạng TAG trần `[Airborne]` (không kèm số) = 1 stack cho dice đó.
    if (/\[Airborne\]/i.test(line) && !/g[âaăằ]y\s*\d+\s*[*\[\s]*Airborne/i.test(line)) out.airborne += 1;
  }
  return out;
}

/** CHARGE_SPEC_CONTRACT — hợp đồng của field `chargeSpec` (cơ chế TÍCH TỤ).
 *
 *  Luật do Fragaria mô tả trực tiếp:
 *    "khi bấm skill, sẽ tính là BẮT ĐẦU TÍCH (charge khởi đầu là 0), có thể bấm
 *     thêm một lần nữa để phóng ra theo số turn đã tích"
 *    "đang tích mà bị Stagger hay bị đánh tôi nghĩ sẽ KHÔNG mất"
 *
 *  → Máy trạng thái 2 nhịp trên combatant:
 *    · Bấm lần 1  : `chargingSkillKey = <key>`, `chargingTurns = 0` — KHÔNG roll,
 *                   KHÔNG tốn CD, KHÔNG tạo pendingAction.
 *    · Mỗi đầu turn: `chargingTurns += 1`, kẹp tại `maxTurns` (turn-advance.js).
 *    · Bấm lần 2  : PHÓNG — roll(chargingTurns), xong mới bắt đầu CD, xoá state.
 *    · Stagger/bị đánh: KHÔNG đụng tới state (đúng yêu cầu). Chỉ có chính lần
 *      phóng mới xoá.
 *
 *  effect: "reuse" → mỗi turn tích thêm 1 dice reuse (Overdrive)
 *          "dice"  → mỗi turn +`perTurn` vào giá trị dice (Charge Shot)
 */

/** REUSE_SPEC_CONTRACT — hợp đồng của field `reuseSpec` trên skill.
 *
 *  Fragaria chốt trực tiếp: "Mook Workshop, Thrust sẽ HỎI Ý người chơi muốn reuse
 *  hay không, còn lại là TỰ reuse" — và cảnh báo tiếp: "player có thể nhập tùy ý,
 *  ví dụ nhập 9 lần reuse dù chỉ đang có 4 Light".
 *
 *  BUG NẶNG ĐÃ SỬA nhờ cảnh báo đó: chi phí Light của các lần Reuse **CHƯA BAO
 *  GIỜ ĐƯỢC TRỪ**. `lightCost` (skill-verification.js) chỉ lấy từ `skill.cost`
 *  = chi phí ĐÒN GỐC. Thrust reuse 4 lần → 5 dice, text tự ghi "Light 6 → 1",
 *  nhưng thực tế chỉ bị trừ **2** Light. Reuse gần như MIỄN PHÍ.
 *
 *  reuseSpec là 1 NGUỒN SỰ THẬT cho cả 3 tầng, để không lệch nhau:
 *    • maxReuse(resourceNow) → trần thật theo tài nguyên đang có
 *      · dùng để LỌC dropdown (chỉ hiện lựa chọn khả thi)
 *      · dùng để KẸP lại lần nữa ở server (phòng người chơi gửi customId tay)
 *      · dùng để tính chi phí
 *    • netCost(reuseTimes) → số Light THẬT bị trừ (đã tính cả phần hồi lại)
 *    • mode "arg"    → roll(res, choice) tự sinh cả chuỗi reuse trong 1 lần gọi
 *      mode "repeat" → roll() chỉ sinh 1 lần, phải gọi LẶP rồi ghép dice
 *    • repeatArgs(i) → tham số cho lần gọi thứ i (chỉ dùng ở mode "repeat")
 *    • suppressSelfLight → roll() có in "nhận N Light" nhưng netCost ĐÃ tính rồi,
 *      phải tắt nhánh parser để không cộng bù hai lần.
 *
 *  KHÔNG BAO GIỜ tin con số người chơi gửi lên — luôn `Math.min(maxReuse, wanted)`.
 */
/** applySideEffectSuppression — tắt những nhánh parser mà reuseSpec đã tự tính,
 *  tránh cộng bù HAI LẦN (xem `suppressSelfLight` trong REUSE_SPEC_CONTRACT). */
function applySideEffectSuppression(skill, sfx) {
  if (skill?.reuseSpec?.suppressSelfLight) sfx.selfLight = 0;
  return sfx;
}

function resolveReuseTimes(skill, resourceNow, wantedRaw) {
  const spec = skill?.reuseSpec;
  if (!spec) return { reuseTimes: 0, maxReuse: 0, netCost: 0 };
  const maxReuse = Math.max(0, spec.maxReuse(resourceNow) | 0);
  const wanted = (wantedRaw === "max" || wantedRaw === undefined || wantedRaw === null || wantedRaw === "")
    ? maxReuse
    : Math.max(0, parseInt(wantedRaw, 10) || 0);
  const reuseTimes = Math.min(maxReuse, wanted);
  return { reuseTimes, maxReuse, netCost: Math.max(0, spec.netCost(reuseTimes) | 0) };
}

/** buildReuseVariants — dropdown ĐỘNG: chỉ liệt kê số lần Reuse người chơi THẬT
 *  SỰ đủ tài nguyên để chọn. Chặn ngay ở tầng UI thay vì để họ chọn 9 rồi âm
 *  thầm bị kẹp về 2 (người chơi tưởng mình reuse 9 lần). */
function buildReuseVariants(skill, resourceNow) {
  const spec = skill?.reuseSpec;
  if (!spec) return null;
  const maxReuse = Math.max(0, spec.maxReuse(resourceNow) | 0);
  const unit = spec.resource === "light" ? "<:Light:1513786082502770719>Light" : spec.resource;
  const opts = [{ key: "0", label: `Không Reuse (chỉ đòn gốc)`, emoji: "⏹️" }];
  for (let n = 1; n <= maxReuse; n++) {
    opts.push({ key: String(n), label: `Reuse ${n} lần — tổng −${spec.netCost(n)} ${unit === "light" ? "Light" : "Light"}`, emoji: "🔁" });
  }
  return opts;
}

/** extractDmgTakenGrantOfLine — grant "%Dmg Taken" của MỘT dòng dice.
 *  Trả `{ all, byType:{B,P,S} }` hoặc null. Chỉ nhận khi chủ ngữ là ĐỊCH —
 *  "bản thân +10% Dmg turn sau" là DmgBonus của người dùng, không được lọt vào.
 */
function extractDmgTakenGrantOfLine(line) {
  const g = extractDmgTakenGrants([line]);
  return g;
}

function autoBuildDmgStrFromSkillRoll(skill, { forceMinDice = false, forceMaxDice = false, diceModifier = 0, rollArgs = [], repeatTimes = 1 } = {}) {
  // ❗ BUG ĐÃ SỬA (Fragaria: "không thấy áp luôn cả Dice Multiplier của Dice").
  // `skill.diceMul` TRƯỚC ĐÂY chỉ được IN RA trong embed (skill-verification.js
  // dòng ~508) mà KHÔNG nhân vào giá trị dice nào cả — mọi page có Dice Mul
  // 1.5x/2x/2.5x đều đánh như 1x.
  // Đọc dạng "1,25x" / "1.5x" / "2x" (dữ liệu dùng cả dấu phẩy lẫn dấu chấm).
  const diceMulNum = (() => {
    const raw = String(skill?.diceMul ?? "1").replace(",", ".").replace(/x/gi, "").trim();
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : 1;
  })();
  startEmotionTracking();
  if (forceMinDice) startForceMinDice();
  else if (forceMaxDice) startForceMaxDice();
  if (diceModifier !== 0) setDiceModifier(diceModifier);
  // rollArgs — cho skill CÓ TRẠNG THÁI cần đọc từ combatant (VD Unlock: stage
  // 1/2/3 theo số stack Unlock Blade đang có). Mặc định rỗng → roll() dùng giá
  // trị mặc định của chính nó, mọi skill cũ không đổi hành vi.
  // repeatTimes > 1 — mode "repeat" của reuseSpec: roll() chỉ sinh 1 dice mỗi
  // lần gọi (VD Mook Workshop) nên phải gọi LẶP rồi ghép, khác mode "arg" (Thrust
  // tự sinh cả chuỗi trong 1 lần gọi).
  let lines;
  if (repeatTimes > 1 && skill.reuseSpec?.mode === "repeat") {
    lines = [];
    for (let i = 0; i < repeatTimes; i++) {
      const args = skill.reuseSpec.repeatArgs ? skill.reuseSpec.repeatArgs(i) : rollArgs;
      lines.push(...skill.roll(...args));
    }
  } else {
    lines = skill.roll(...rollArgs);
  }
  if (forceMinDice) stopForceMinDice();
  else if (forceMaxDice) stopForceMaxDice();
  if (diceModifier !== 0) clearDiceModifier();
  const tracked = stopEmotionTracking();
  const totalEmotionDelta = tracked.reduce((sum, t) => sum + t.delta, 0);
  // ❗ Fragaria (12/08): "Energetic x2 hiệu quả NHẬN Emotion Coin — 1 số user bảo
  // nó x2 CẢ phần trừ khi bị Min Dice, trong khi đáng lẽ chỉ x2 phần nhận khi Max".
  // Users ĐÚNG. Trước đây chỉ có TỔNG NET đi tới `applyEmotionDelta`, mà nhân đôi
  // tổng net thì phần âm cũng bị nhân đôi theo: 3 Max + 1 Min = net +2 → ×2 = +4,
  // trong khi luật đúng là 3×2 − 1 = +5. Nay trả thêm phần DƯƠNG để nơi áp dụng
  // biết tách hai chiều.
  const totalEmotionPlus = tracked.reduce((sum, t) => sum + Math.max(0, t.delta), 0);

  const warnings = [];
  const diceTypeByLine = []; // { result, type, statusTags } theo ĐÚNG thứ tự tracked[]
  const TYPE_MAP = { Slash: "S", Blunt: "B", Pierce: "P" };
  // Task yêu cầu trực tiếp (repro cụ thể: "Soldato Rifle Critical Shock Round
  // hoàn toàn không áp Tremor/Tremor Burst" + "Index Longsword Critical không
  // áp Rupture được") — GAP HỆ THỐNG RỘNG phát hiện: TRƯỚC ĐÂY dmgStr auto-build
  // CHỈ lấy damage+type (VD "17B"), CÒN Tremor/Rupture/Bleed/Sinking/Burn nhắc
  // tới trong text roll() hoàn toàn KHÔNG được tự gắn vào dmgStr — chỉ CẢNH BÁO
  // suông "tự gõ tay" (xem warnings bên dưới, dòng cũ vẫn giữ để phòng trường
  // hợp parse thiếu). Giờ tự parse TỪNG DÒNG DICE để tìm "N <:Emoji:ID>TênStatus"
  // (khớp ĐÚNG cú pháp damage-calc.js hỗ trợ: +NRupture/+NSinking/+NBleed/+NBurn/
  // +NTremor/+NTremorBurst) rồi GẮN TRỰC TIẾP vào ĐÚNG dice đó (không phải gộp
  // chung cho cả dmgStr — mỗi dice có thể có status KHÁC NHAU, xem ví dụ Shock
  // Round: Dice 1 chỉ +4Tremor, Dice 2 mới có +3Tremor+TremorBurst).
  //
  // CHỈ auto-tag Tremor/TremorBurst/Rupture/Sinking/Bleed/Burn (áp lên TARGET,
  // luôn CỘNG dương khi roll() mô tả bằng "gây X Y") — KHÔNG auto-tag Poise/
  // Charge (thường là CỦA BẢN THÂN attacker, hướng +/- không rõ ràng từ text) —
  // 2 loại đó vẫn giữ cảnh báo cũ, GM/player tự gõ tay nếu cần.
  // THỨ TỰ QUAN TRỌNG: "Tremor Burst" PHẢI match TRƯỚC "Tremor" (tiền tố trùng —
  // giống hệt vấn đề đã ghi trong damage-calc.js's parser).
  const AUTO_STATUS_TAGS = [
    { name: "Tremor Burst", tag: "TremorBurst", needsCount: false },
    { name: "Tremor", tag: "Tremor", needsCount: true },
    { name: "Rupture", tag: "Rupture", needsCount: true },
    { name: "Sinking", tag: "Sinking", needsCount: true },
    { name: "Bleed", tag: "Bleed", needsCount: true },
    { name: "Burn", tag: "Burn", needsCount: true },
    // GAP ĐÃ SỬA (quét toàn bộ 324 skill: Poise xuất hiện ở 23 skill, Charge ở
    // 6 — CHƯA BAO GIỜ vào dmgStr). damage-calc.js ĐÃ hỗ trợ sẵn cú pháp
    // "+NPoise"/"+NCharge" (xem damageRegex + sumSignedTag) và resolve-pending-
    // action.js ĐÃ ghi ngược finalPoiseStacks/finalCharge về attacker — nghĩa là
    // chỉ thiếu đúng khâu tự gắn tag này.
    // gainOnly=true: BẮT BUỘC có động từ "nhận/hồi" ngay trước số. Lý do: Poise/
    // Charge là status CỦA BẢN THÂN và text có CẢ chiều tiêu thụ ("tiêu 5 Poise",
    // "giảm 1 nửa Charge") — match mù sẽ CỘNG nhầm đúng chỗ đáng lẽ phải TRỪ.
    // Chiều tiêu thụ vẫn để GM tự gõ "-NPoise" (đã hỗ trợ sẵn), an toàn hơn đoán.
    { name: "Poise", tag: "Poise", needsCount: true, gainOnly: true },
    { name: "Charge", tag: "Charge", needsCount: true, gainOnly: true },
  ];
  function extractAutoStatusTags(line) {
    let remaining = line;
    let suffix = "";
    for (const { name, tag, needsCount, gainOnly } of AUTO_STATUS_TAGS) {
      const namePat = name.replace(/\s/g, "\\s*");
      // gainOnly → động từ "nhận"/"hồi" phải nằm NGAY trước số (cho phép đệm
      // "nhận thêm"). KHÔNG dùng lookbehind — đưa động từ vào chính pattern.
      const re = gainOnly
        ? new RegExp(`(?:nhận|hồi)(?:\\s+thêm)?\\s+(\\d+)\\s*<:[^:>]+:\\d+>${namePat}`, "i")
        : needsCount
          ? new RegExp(`(\\d+)\\s*<:[^:>]+:\\d+>${namePat}`, "i")
          : new RegExp(`<:[^:>]+:\\d+>${namePat}`, "i");
      const m = remaining.match(re);
      if (m) {
        suffix += needsCount ? `+${m[1]}${tag}` : `+${tag}`;
        remaining = remaining.replace(m[0], ""); // tránh khớp lại "Tremor" bên trong "Tremor Burst" đã tiêu thụ
      }
    }
    return suffix;
  }
  // BUG LỚP (ĐÃ SỬA TRIỆT ĐỂ — thay cho fix trackedIdx cũ): cách căn index cũ
  // (`tracked[trackedIdx]`, chỉ tăng khi có typeMatch) VỠ ở 32 skill. Nguyên
  // nhân: MỌI dòng dice gọi r() đều tiêu thụ 1 phần tử tracked[], nhưng dòng
  // KHÔNG có tag type (VD Somber Procuration Dice3, Today's Expression Dice1
  // "chỉ giảm Stamina", Dragon Choke Impact Dice3 điều kiện) bị `continue` bỏ
  // qua mà KHÔNG tăng trackedIdx → mọi dice SAU đó đọc NHẦM sang giá trị của
  // dice trước → dmg sai hoàn toàn (hoặc rỗng nếu vượt length).
  //
  // Cách mới KHÔNG dùng tracked[] để lấy giá trị nữa: đọc THẲNG con số đã IN RA
  // trong chính dòng đó (`**N**`). Con số này do r() trả về và đã bao gồm SẴN
  // mọi modifier (forceMinDice/diceModifier — xem r()), nên tương đương hoàn
  // toàn tracked[i].result mà MIỄN NHIỄM với lệch index: dòng thiếu tag/dòng
  // điều kiện/dòng in 2 giá trị đều không thể làm hỏng các dòng khác.
  // tracked[] giờ CHỈ còn dùng cho emotion delta (không liên quan dmg).
  for (const line of lines) {
    // Chỉ những dòng BẮT ĐẦU bằng emoji DiceN mới là 1 dice THẬT — các dòng khác
    // (ghi chú điều kiện, mô tả hiệu ứng phụ, biến thể loại trừ...) không tính.
    if (!/^<:Dice\d+:/.test(line)) continue;
    const typeMatch = line.match(/\[<:(?:Slash|Blunt|Pierce):\d+>(Slash|Blunt|Pierce)\]/);
    if (!typeMatch) continue; // dice KHÔNG gây dmg (VD "chỉ giảm Stamina, không gây dmg") — bỏ qua AN TOÀN
    const valueMatch = line.match(/\*\*(-?[\d.]+)\*\*/); // giá trị ĐẦU TIÊN in ra trên dòng
    if (!valueMatch) continue; // dòng dice thuần mô tả, không có số
    // ❗ Fragaria chốt 12/08 (nguyên văn): "42DiceB + 42+10%DiceB + 42+20%DiceB
    // + 42+30%DiceB — do đòn đầu là đòn SAU KHI DÙNG rồi mới khiến kẻ địch nhận
    // thêm dmg nên ĐÒN SAU mới có +10%."
    // ⇒ mỗi dòng dice "địch nhận thêm X% Dmg" áp cho các dice ĐỨNG SAU nó trong
    // CÙNG đòn, CỘNG DỒN. Ghi lại grant của TỪNG dòng để cộng dồn ở bước dựng
    // dmgStr bên dưới (không cộng ngay ở đây vì dice này chưa được hưởng).
    diceTypeByLine.push({ result: parseFloat(valueMatch[1]), type: TYPE_MAP[typeMatch[1]],
      statusTags: extractAutoStatusTags(line), dtGrant: extractDmgTakenGrantOfLine(line),
      // Tag `+NDB%` viết NGAY SAU giá trị in đậm (Caduceus Critical đúng type) —
      // phải đưa vào dmgStr thì nó mới đi qua `saturateBonusPct`, thay vì nhân
      // thẳng vào dice như trước.
      dbTag: (line.match(/\*\*-?[\d.]+\*\*\+([\d.]+)DB%/) ?? [])[1] ?? null });
  }

  // Tag phòng thủ/hiệu ứng phụ — CHỈ liệt kê để GM tự thêm tay, KHÔNG tự áp (xem
  // giải thích đầy đủ ở comment hàm).
  const bypassTagPattern = /\[(Unblockable|Undodgeable|Unevadeable|Unparriable|Guard Break|Unclashable)\]/gi;
  const foundTags = new Set();
  for (const line of lines) {
    let m;
    while ((m = bypassTagPattern.exec(line)) !== null) foundTags.add(m[1]);
  }
  if (foundTags.size > 0) {
    warnings.push(`Skill có tag: ${[...foundTags].join(", ")} — dmgStr KHÔNG tự thêm được (áp theo TỪNG dice riêng), tự gõ thêm vào ô "tags" khi confirm nếu cần.`);
  }
  if (/Dice Up|Poise|Light/i.test(lines.join(" ")) && diceTypeByLine.length > 0) {
    warnings.push(`Skill có ghi chú hiệu ứng phụ (Dice Up/Poise/Light — không tự áp được, hướng +/- không rõ từ text) — xem embed roll bên dưới để tự áp dụng.`);
  }

  if (diceTypeByLine.length === 0) {
    return { dmgStr: null, warnings, tracked, totalEmotionDelta, totalEmotionPlus, lines, sideEffects: applySideEffectSuppression(skill, extractNonDmgStrEffects(lines)) };
  }
  // Áp DICE MULTIPLIER vào giá trị dice thật (làm tròn 2 số để không ra rác thập phân).
  // ❗❗ BUG NẶNG ĐÃ SỬA (Fragaria 12/08: "dmg của Furioso thực tế lên mục tiêu
  // 1.5x Res là tận hơn 1k+ ở /math, còn ở encounter bot chỉ 400~600").
  // GỐC: dmgStr auto-build ra `33P` — THIẾU marker **Dice**. Trong damage-calc,
  // `%SanityBonus` CHỈ áp cho hit có `isDice` (`33DiceP`). Encounter VẪN truyền
  // `sanityBonusPct: getEffectiveSanityForDiceBonus(player)` đàng hoàng, nhưng
  // không hit nào nhận được ⇒ toàn bộ bonus Sanity bốc hơi im lặng.
  // Người chơi 45 Sanity mất trắng +45% Dmg mỗi hit — đúng khoảng chênh mà
  // Fragaria đo giữa /math (họ tự gõ `26DiceB`) và encounter.
  // Mọi dice của skill page ĐỀU là Dice thật, nên gắn marker cho TẤT CẢ.
  // Cộng dồn %DmgTaken từ các dice ĐỨNG TRƯỚC (xem comment ở diceTypeByLine.push).
  // Dùng hậu tố `DT%` để nó vào ĐÚNG pool DmgTaken (bão hoà riêng), không phải
  // pool Dmg Bonus như cú pháp `+N%` trần.
  let dtRunAll = 0;
  const dtRunByType = { B: 0, P: 0, S: 0 };
  const dmgStr = diceTypeByLine
    .map(d => {
      const dtForThis = Math.round((dtRunAll + (dtRunByType[d.type] ?? 0)) * 100) / 100;
      if (d.dtGrant) {   // grant của CHÍNH dice này chỉ có hiệu lực từ dice KẾ TIẾP
        dtRunAll += d.dtGrant.all ?? 0;
        for (const k of ["B", "P", "S"]) dtRunByType[k] += d.dtGrant.byType?.[k] ?? 0;
      }
      const val = Math.round(d.result * diceMulNum * 100) / 100;
      const dbPart = d.dbTag ? `+${d.dbTag}DB%` : "";
      return `${val}${dbPart}${dtForThis > 0 ? `+${dtForThis}DT%` : ""}Dice${d.type}${d.statusTags ?? ""}`;
    })
    .join(" + ");
  return { dmgStr, warnings, tracked, totalEmotionDelta, totalEmotionPlus, lines, sideEffects: applySideEffectSuppression(skill, extractNonDmgStrEffects(lines)) };
}


/** applyIndulgenceToDmgStr — cộng `bonus` count vào MỌI dice có inflict Sinking.
 *
 *  ❗❗ BUG TÁI PHÁT — SỬA LẠI CHO ĐÚNG CHỖ (Fragaria lần 2, 12/08: "Indulgence in
 *  the Prescript vẫn chưa hoạt động, vẫn chỉ áp 2 Sinking ở đòn stiletto thay vì 4").
 *  LẦN SỬA TRƯỚC đặt phần cộng ở `resolve-pending-action.js` — cộng vào
 *  `target.sinking` LÚC RESOLVE. Nó CÓ chạy, nhưng SAI TẦNG:
 *    • Cộng 1 lần cho CẢ ĐÒN, trong khi luật là "mỗi dice có áp Sinking + 2 count"
 *      (Illuminate Thy Vacuity 5 dice × 1 Sinking phải thành 5 × 3).
 *    • `dmgStr` — thứ người chơi ĐỌC trong Action Log — vẫn in "+2Sinking", nên
 *      con số hiện ra KHÁC con số áp thật. Đúng lớp lỗi "hai nguồn sự thật".
 *  Nay cộng THẲNG vào dmgStr lúc dựng đòn: hiển thị và tính toán là MỘT.
 *  `calcMathCore` đọc "+NSinking" (thiếu số = 1) nên chỉ cần viết lại con số.
 */
function applyIndulgenceToDmgStr(dmgStr, bonus) {
  if (!dmgStr || !(bonus > 0)) return dmgStr;
  return String(dmgStr).replace(/\+(\d+)?Sinking/gi, (_m, n) => `+${(parseInt(n ?? "1", 10) || 1) + bonus}Sinking`);
}

/** resolveSkillKey — trả về ĐÚNG KEY trong object SKILLS cho một chuỗi người
 *  chơi gõ (hoặc value dropdown). Đây là thứ mọi handler tự động hoá so sánh
 *  (`p.skillKey === "wheels industry"`), KHÔNG PHẢI tên hiển thị.
 *
 *  VÌ SAO KHÔNG DÙNG `skill.name.toLowerCase()`: có **31 skill** mà tên hiển thị
 *  KHÁC key — `wheels industry` ↔ "Wheel's Industry", `atelier logic pistols` ↔
 *  "Atelier Logic: Pistols", `great split vertical` ↔ "Great Split: Vertical",
 *  `furusiyya` ↔ "Furūsiyya", `for justice` ↔ "For Justice!!!"… Suy từ name sẽ
 *  phá vỡ đúng những handler đang chạy tốt.
 *
 *  CÁCH LÀM: tái dùng `findSkill` (đã xử lý alias + dấu ":" + space/dash) rồi
 *  dò ngược ra key theo THAM CHIẾU object — chính xác tuyệt đối, kể cả 2 skill
 *  trùng tên hiển thị nhưng khác key (VD "Dimensional Rift" có bản dagger và
 *  bản gauntlets). Trả null nếu không tìm ra skill nào. */
/** cdKeyFor — ô đếm cooldown THẬT của một skillKey.
 *
 *  Skill khai `cdGroup` thì dùng CHUNG ô đếm với mọi skill cùng nhóm (Fragaria:
 *  2 Critical của Atelier Logic phải share CD vì chúng là cùng một khẩu súng,
 *  bấm Critical chỉ là đổi form). Skill không khai → giữ nguyên hành vi cũ,
 *  đúng cách `pityGroup` làm với banner gacha.
 *
 *  ⚠️ MỌI chỗ đọc/ghi `skillCooldowns[...]` PHẢI đi qua hàm này, nếu không sẽ
 *  có chỗ ghi vào ô nhóm còn chỗ khác đọc ô riêng → CD hiện 0 dù đang cooldown.
 */
/** findOwnedPageKey — tìm KEY THẬT của một page trong kho `data.pages`.
 *
 *  BUG ĐÃ SỬA (Fragaria: "bug moon splitting draw không equip được dù đã có,
 *  1 số page cũng bị như vậy, có khả năng là nhiều page nữa").
 *
 *  NGUYÊN NHÂN GỐC: kho `data.pages` được GHI bằng chuỗi khai trong
 *  `book-system.js` (BOOK_GRANTS), nhưng lúc equip lại TRA bằng `skill.name`.
 *  Hai chuỗi này lệch nhau ở **5 page** — dò cả 173 tên page trong sách:
 *    "Moon Splitting Draw"              ≠ "Moon-Splitting Draw"      (dấu gạch)
 *    "Complete and Total Extermination!" ≠ "Complete and Total Extermination" (dấu !)
 *    "Waltz in White" / "Waltz in Black" ≠ "Waltz In White/Black"     (hoa/thường)
 *    "My Hair Coupon"                   ≠ "MY HAIR COUPOOOOOOONS!"
 *  → đọc sách xong kho có page, mà equip vẫn báo "chưa sở hữu".
 *
 *  Sửa chuỗi trong sách là CHƯA ĐỦ: dữ liệu người chơi ĐANG lưu key cũ, sửa
 *  BOOK_GRANTS sẽ làm họ mất sạch page đã học. Nên tra theo ĐỊNH DANH SKILL:
 *  thử key chuẩn trước (nhanh), không có thì quét kho và so bằng `findSkill`.
 *  Trả về key thật (để còn trừ/xoá đúng ô) hoặc null.
 */
function findOwnedPageKey(pagesObj, skillOrName) {
  if (!pagesObj) return null;
  const skill = typeof skillOrName === "string" ? findSkill(skillOrName) : skillOrName;
  if (!skill) return null;
  if ((pagesObj[skill.name] ?? 0) > 0) return skill.name;
  for (const k of Object.keys(pagesObj)) {
    if ((pagesObj[k] ?? 0) <= 0) continue;
    if (findSkill(k) === skill) return k;
  }
  return null;
}

function cdKeyFor(skillKeyOrName) {
  if (!skillKeyOrName) return skillKeyOrName;
  const key = String(skillKeyOrName).trim().toLowerCase();
  const sk = SKILLS[key] ?? findSkill(key);
  return sk?.cdGroup ?? key;
}

function resolveSkillKey(raw) {
  const skill = findSkill(raw);
  if (!skill) return null;
  const direct = (raw ?? "").toLowerCase().trim();
  if (SKILLS[direct] === skill) return direct; // đường nhanh, giữ đúng key khi gõ chuẩn
  for (const k of Object.keys(SKILLS)) {
    if (SKILLS[k] === skill) return k;
  }
  return null;
}

module.exports = {
  extractDmgTakenGrants,
  setSanityBias, clearSanityBias, rRaw,
  applyIndulgenceToDmgStr, SKILLS, SKILL_ALIASES, findSkill, resolveSkillKey, cdKeyFor, findOwnedPageKey, extractNonDmgStrEffects, resolveReuseTimes, buildReuseVariants, findByKeyword, autoExtractDiceSideEffects, r, computeEmotionDelta, startEmotionTracking, stopEmotionTracking, startForceMinDice, stopForceMinDice, startForceMaxDice, stopForceMaxDice, setDiceModifier, clearDiceModifier, autoBuildDmgStrFromSkillRoll, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10 };
