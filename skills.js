// skills.js — Toàn bộ skill data, tách ra để dễ quản lý
// Được require bởi index.js: const { SKILLS, SKILL_ALIASES, findSkill } = require("./skills");
// ─── SKILL DATA ───────────────────────────────────────────────────────────────
const D1 = "<:Dice1:1508173590078558369>";
const D2 = "<:Dice2:1508173623691710625>";
const D3 = "<:Dice3:1508173643518050395>";
const D4 = "<:Dice4:1508176464367845600>";
const D5 = "<:Dice5:1508176500438990968>";
const D6 = "<:Dice6:1517712655106838638>";
const D7 = "<:Dice7:1517712721796403272>";
const D8 = "<:Dice8:1517712757053591642>";
const D9 = "<:Dice9:1517712785612603462>";
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

// ─── DICE UP/DOWN (Value Power Up/Down) — cộng/trừ trực tiếp vào kết quả roll ──
// "Dice Up: +1 Dice. Biến mất sau End Turn" / "Dice Down: -1 Dice..." (xác nhận
// trực tiếp) — CÙNG side-channel pattern, khác Paralyze ở chỗ đây là CỘNG THÊM
// (không phải ép cứng về 1 giá trị), và KHÔNG clamp vào [min,max] gốc — Dice Up
// có thể đẩy kết quả VƯỢT max bình thường (đúng bản chất buff "tăng dice").
let diceModifierActive = 0;

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

function r(min, max) {
  let result;
  if (forceMinDiceActive) {
    result = min;
  } else {
    result = Math.max(1, Math.floor(Math.random() * (max - min + 1)) + min + diceModifierActive);
  }
  if (emotionTracker) {
    // Emotion Coin tính theo kết quả GỐC (trước Dice Up/Down) để giữ đúng ý nghĩa
    // "roll đúng max/min của DICE GỐC" — Dice Up/Down là buff cộng thêm bên ngoài,
    // không phải bản chất của dice đó.
    const rawResult = forceMinDiceActive ? min : result - diceModifierActive;
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
    name: "Extract Fuel",
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
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] [Undodgeable] [AOE 3 người] — gây 5 <:Bleed:1513762688226955285>Bleed ở turn kế, 2 <:Bind:1513768025881317457>Bind và nhận 2 **Middle Nursefather Tattoos** với mỗi địch đánh trúng`,
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
        `${D1} *Nếu địch có ≥4 <:Bind:1513768025881317457>Bind, mọi Dice của skill này add thêm 1 <:Burn:1513762753691652177>Burn*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — gây 2 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Burn:1513762753691652177>Burn và 2 <:Bind:1513768025881317457>Bind`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Unblockable] — gây 2 <:Burn:1513762753691652177>Burn`,
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
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — gây 3 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Burn:1513762753691652177>Burn`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Bind:1513768025881317457>Bind và +1 <:Burn:1513762753691652177>Burn ứng với mỗi <:Bind:1513768025881317457>Bind trên địch`,
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
    name: "Light Attack",
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
        `Đốt cháy vũ khí của bạn trong 3 Turn, khiến cho đòn đánh thường (M1) tự động áp 1/2/4 <:Burn:1513762753691652177>Burn [Light/Medium/Heavy] lên kẻ địch mỗi lần trúng.`,
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
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Guard Break] — hồi 1 <:Light:1513786082502770719>Light`,
      ];
    },
  },
  "dodge and strike": {
    name: "Dodge and Strike",
    cost: "1 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,16);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash]`,
      ];
    },
  },
  "soulburn": {
    name: "Soulburn",
    cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "2x",
    roll() {
      const d1 = r(3,6), d2 = r(3,6), d3 = r(5,9);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 4 <:Burn:1513762753691652177>Burn và 1 <:Fragile:1513763336167100536>Fragile; tự gắn lên bản thân 1 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 6 <:Burn:1513762753691652177>Burn và 2 <:Fragile:1513763336167100536>Fragile; tự gắn lên bản thân 1 <:Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [AOE tất cả] — gây 10 <:Burn:1513762753691652177>Burn và 2 <:Fragile:1513763336167100536>Fragile; tự gắn lên bản thân 2 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "inferno burst": {
    name: "Inferno Burst",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1.5x",
    roll() {
      const d1 = r(9,12), d2 = r(11,13);
      return [
        `${D1} *Nếu địch có sẵn 10 <:Burn:1513762753691652177>Burn: tăng lượng <:Burn:1513762753691652177>Burn mỗi Hit thêm 3 <:Burn:1513762753691652177>Burn*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Burn:1513762753691652177>Burn; tự gắn lên bản thân 2 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 6 <:Burn:1513762753691652177>Burn; tự gắn lên bản thân 4 <:Burn:1513762753691652177>Burn; kích Burning Sensation`,
      ];
    },
  },
  "celestial fire": {
    name: "Celestial Fire",
    cost: "6 <:Light:1513786082502770719>Light", cd: "7 Turn", diceMul: "—",
    roll() {
      return [
        `*Không có Dice — page chỉ tự áp hiệu ứng lên bản thân/đối phương*`,
        `Tự gắn lên bản thân 20 <:Burn:1513762753691652177>Burn, kích hoạt **Burning Sensation** trên người đối phương`,
        `Khả năng gắn <:Burn:1513762753691652177>Burn tăng lên 1,5x (kéo dài 2 Turn)`,
        `*Nếu bản thân có sẵn 10 <:Burn:1513762753691652177>Burn (không phải từ chính Page này): kích hoạt thêm 1 lần **Burning Sensation** nữa*`,
      ];
    },
  },
  "light dash": {
    name: "Light Dash", tags: "Light",
    cost: "0 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "—",
    roll() {
      return [
        `*Không có Dice — page chỉ tự áp hiệu ứng lên bản thân*`,
        `Lướt tới vị trí kẻ thù đồng thời hồi cho bản thân 2 <:Light:1513786082502770719>Light và né một đòn tấn công của kẻ địch (không thể né Undodgeable)`,
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
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — nhận 6 <:Poise:1513762945715142736>Poise; khi dưới 50% HP thêm 2 <:Poise:1513762945715142736>Poise và 4 <:Haste:1513768004222062632>Haste`,
      ];
    },
  },
  "onrush": {
    name: "Onrush",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,26);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế, nhận 1 <:Imitation:1513769425063514173>Imitation, giảm 40 Stamina địch`,
        `${D1} *Nếu bản thân có ≥6 <:Light:1513786082502770719>Light: dùng thêm 3 <:Light:1513786082502770719>Light để reuse đòn này*`,
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
    roll() {
      const d1=r(12,21), d2=r(11,20), d3=r(16,25), d4=r(15,21),
            d5=r(17,26), d6=r(14,23), d7=r(17,26), d8=r(29,38), d9=r(17,26);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `${D3} **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 2 <:Tremor:1513762737388257380>Tremor`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 1 <:Rupture:1513762812722155682>Rupture`,
        `${D5} **${d5}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 3 <:Bleed:1513762688226955285>Bleed ở turn kế`,
        `${D6} **${d6}** [50% <:Slash:1513768633434640517>Slash/50% <:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 4 <:Fragile:1513763336167100536>Fragile, <:TremorBurst:1513802464632246352>Tremor Burst`,
        `${D7} **${d7}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 10 <:Tremor:1513762737388257380>Tremor`,
        `${D8} **${d8}** [50% <:Slash:1513768633434640517>Slash/50% <:Blunt:1513768529718022254>Blunt] [Undodgeable] [Unblockable] [Unparriable] [Unclashable]`,
        `${D9} **${d9}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] [Unparriable] [Unclashable] — gây 1 <:Rupture:1513762812722155682>Rupture *trước* khi gây Dmg`,
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
        `<:Burn:1513762753691652177>Burn`, `<:Tremor:1513762737388257380>Tremor`,
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
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed 2 <:Burn:1513762753691652177>Burn 2 <:Tremor:1513762737388257380>Tremor 2 <:Sinking:1513762793436741652>Sinking 2 <:Rupture:1513762812722155682>Rupture`,
      ];
      for (let i = 1; i <= 2; i++) {
        const triggered = Math.random() * 100 < reusePct;
        const dEmoji = REUSE_EMOJIS[i - 1] ?? REUSE_EMOJIS[REUSE_EMOJIS.length - 1];
        if (triggered) {
          lines.push(`${dEmoji} ↩️ Reuse ${i} **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Bleed:1513762688226955285>Bleed 2 <:Burn:1513762753691652177>Burn 2 <:Tremor:1513762737388257380>Tremor 2 <:Sinking:1513762793436741652>Sinking 2 <:Rupture:1513762812722155682>Rupture *(${reusePct}% → ✅)*`);
        } else {
          lines.push(`${dEmoji} ↩️ Reuse ${i} dừng tại đây *(${reusePct}% → ❌)*`);
          break;
        }
      }
      return lines;
    },
  },

  // ── <:Burn:1513762753691652177>Burn skills ──
  "perfected death fist": {
    name: "Perfected Death Fist", cost: "3 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,6),d2=r(6,9),d3=r(9,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> *Nếu địch có trên 8 <:Burn:1513762753691652177>Burn: gắn thêm 3 <:Burn:1513762753691652177>Burn*`,
        `<:Dice3:1508173643518050395> *Nếu địch có trên 6 <:Burn:1513762753691652177>Burn: +5 <:DiceUp:1513767795681398894>Dice Up cho bản thân*`,
      ];
    },
  },
  "raging storm": {
    name: "Raging Storm", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(5,9),d2=r(10,16);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — gây 4 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu] — gây 8 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "fiery waltz": {
    name: "Fiery Waltz", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(9,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 5 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "red kick": {
    name: "Red Kick", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(2,5),d2=r(8,13);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> *Tấn công cộng thêm (số <:Burn:1513762753691652177>Burn trên địch ÷ 3) dice*`,
      ];
    },
  },
  "flowing flame": {
    name: "Flowing Flame", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(8,14);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gắn 4 <:Burn:1513762753691652177>Burn`,
        `<:Dice1:1508173590078558369> *Trên 30 Sanity: gắn 6 <:Burn:1513762753691652177>Burn | Trên 45 Sanity: gắn 8 <:Burn:1513762753691652177>Burn*`,
      ];
    },
  },
  "fleet edge": {
    name: "Fleet Edge", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,6),d2=r(4,12);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> *Nếu địch có trên 10 <:Burn:1513762753691652177>Burn: gắn thêm 3 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>*`,
      ];
    },
  },
  "flow of the sword": {
    name: "Flow of the Sword", cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,5),d2=r(6,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 4 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },

  // ── <:Poise:1513762945715142736>Poise / <:Bleed:1513762688226955285>Bleed mixed ──
  "extreme edge": {
    name: "Extreme Edge", cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const normal=r(7,8), air=r(4,7), low=r(17,30);
      return [
        `**Mặt đất:** **${normal}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Knockback] — gây 5 <:Bleed:1513762688226955285>Bleed và 2 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
        `**Trên không:** **${air}** [<:Slash:1513768633434640517>Slash] — gây 5 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
        `**Dưới 33% HP:** **${low}** [<:Slash:1513768633434640517>Slash] [Guard Break] [Undodgeable] [AOE] — gây 8 <:Bleed:1513762688226955285>Bleed và 5 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
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
        `<:Dice1:1508173590078558369> **${dAir}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Uptilt] — gây 5 <:DefenseDown:1513767463337066576>Defense Down <:DefenseDown:1513767463337066576>`,
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
    name: "Yield My Flesh", cost: "2 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1=r(3,6),d2=r(6,12);
      return [
        `*Skill đặc biệt của Blade Lineage — yêu cầu Outfit Blade Lineage*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — Né 4 đòn đánh thường hoặc clash`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — Nếu địch không đánh để né/clash: chém và nhận 2 <:Light:1513786082502770719>Light`,
      ];
    },
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
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,10);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — ngắt 4 đòn đánh thường của địch, nhận 2 Protection`,
      ];
    },
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
        `<:Dice4:1508176464367845600> **${d4}** [Guard Break]`,
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
        `<:Dice4:1508176464367845600> **${d4}** [Guard Break]`,
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
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,5), d2 = r(5,9), d3 = r(8,14);
      return [
        `*Chặn 4 đòn đánh thường của địch — nhận 5 <:DefenseUp:1513767487894716497>Defense Up*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 3 <:DefenseDown:1513767463337066576>Defense Down`,
      ];
    },
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
  "augury kick": {
    name: "Augury Kick",
    cost: "4 <:Light:1513786082502770719>Light", cd: "5 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,9), d2 = r(18,26);
      const hasDiceUp = d2 > 20;
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — đá địch lên trời, gây 8 <:Tremor:1513762737388257380>Tremor`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unparriable] [Undodgeable] — đá xuống, gây <:TremorBurst:1513802464632246352>Tremor Burst`,
        hasDiceUp ? `✨ Trên 20 Tremor: nhận 2 <:DiceUp:1513767795681398894>Dice Up cho 2 Turn kế tiếp` : `*(Cần trên 20 <:Tremor:1513762737388257380>Tremor để nhận <:DiceUp:1513767795681398894>Dice Up)*`,
      ];
    },
  },
  "celestial sight": {
    name: "Celestial Sight",
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — né 4 đòn thường của địch, phản công gây 6 <:Tremor:1513762737388257380>Tremor`,
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
        `*Nếu địch có trên 5 <:Tremor:1513762737388257380>Tremor: **[Uptilt]***`,
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
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [Uptilt] — gây 1 <:Paralyze:1513763316479295548>Paralyze và 3 <:Tremor:1513762737388257380>Tremor`,
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
    roll() {
      const d1 = r(1,5), d2 = r(1,5);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Bleed:1513762688226955285>Bleed và nhận 2 <:Poise:1513762945715142736>Poise`,
        `*Reuse 1 lần nếu bản thân đang có trên 2 <:Light:1513786082502770719>Light*`,
      ];
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
        `<:Dice3:1508173643518050395> **${d3}** — đạp địch ra xa, gây 5 <:Rupture:1513762812722155682>Rupture`,
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
    roll() {
      const stage = Math.floor(Math.random() * 3) + 1;
      if (stage === 1) {
        const d1 = r(2,4);
        return [
          `**Unlock - 1** *(không có Unlock Blade)*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — trúng: nhận **Unlock Blade - 1**`,
        ];
      } else if (stage === 2) {
        const d1 = r(3,6), d2 = r(3,6);
        return [
          `**Unlock - 2** *(cần Unlock Blade - 1)*`,
          `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash]`,
          `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — nhận **Unlock Blade - 2**`,
        ];
      } else {
        const d1 = r(6,11), d2 = r(6,11);
        return [
          `**Unlock - 3** *(cần Unlock Blade - 2)*`,
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
    cost: "4 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "5 Turn", diceMul: "1x",
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
    cost: "6 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
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
    cost: "3 <:Light:1513786082502770719>Light & 5 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "8 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
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
    cost: "3 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
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
    cost: "6 <:Light:1513786082502770719>Light & 25 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 25 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      return [
        `<:Dice1:1508173590078558369> Giảm 0.2 Res cho toàn bộ trong 3 turn. Khi chết sẽ kích hoạt Apocalypse với sát thương Blunt`,
        `*[Sau khi dùng] Biến thành Apocalypse ở lần dùng kế tiếp*`,
      ];
    },
  },
"apocalypse": {
    name: "Apocalypse",
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "—", diceMul: "1.5x",
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
  "fervent beats": {
    name: "Fervent Beats",
    tags: "Abnormalities <:The_Library:1474374220023857192>",
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
    cost: "4 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn [từ lúc hết buff]", diceMul: "1x",
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
    cost: "2 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
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
    cost: "3 <:Light:1513786082502770719>Light & 50 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
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
    cost: "3 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn [từ lúc hết buff]", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "3 Turn [từ lúc hết buff]", diceMul: "1x",
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
    cost: "20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "7 <:Light:1513786082502770719>Light & 40 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6, 10), d2 = r(5, 9);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [AOE] [Undodgeable] [Unblockable]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] [AOE] [Undodgeable] [Unblockable] — sau khi dùng: hồi sinh TOÀN BỘ đồng minh đã chết trong trận này trong 1 Turn (4 Light, mọi Buff trừ Emotion Level bị reset). [KHÔNG TỰ ĐỘNG HOÁ hồi sinh — GM tự thao tác trên board.]`,
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
    cost: "2 <:Light:1513786082502770719>Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,11);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] [Counter] [Undodgeable] — né 4 đòn đánh thường; phản công gây 2 lần sát thương, mỗi lần gây 2 <:Smoke:1513778039610282015>Smoke; rồi gây 1 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
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
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,23);
      return [
        `*Né 1 đòn của địch, đánh dấu chúng, hồi 1 <:Light:1513786082502770719>Light; turn sau kích hoạt lại 1 lần*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Pierce:1513768511179329556>Pierce] — đâm sau lưng địch, gây 3 <:Bleed:1513762688226955285>Bleed cho turn sau`,
      ];
    },
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
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — rút súng bắn rồi giật lùi, áp 4 <:Burn:1513762753691652177>Burn`,
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
        `<:Dice2:1508173623691710625> **${d2}** [<:Pierce:1513768511179329556>Pierce] — nhận 2 <:Haste:1513768004222062632>Haste`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Pierce:1513768511179329556>Pierce] — nhận 4 <:Haste:1513768004222062632>Haste`,
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
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Burn:1513762753691652177>Burn`,
        `<:Dice3:1508173643518050395> **${d3}** [<:Slash:1513768633434640517>Slash] — gây 2 <:Burn:1513762753691652177>Burn và gắn 1 <:Bind:1513768025881317457>Bind với mỗi 2 <:Burn:1513762753691652177>Burn trên địch [Max: 6]`,
      ];
    },
  },

  // ── Abnormality Pages (TETH) ──
  "fourth match flame": {
    name: "Fourth Match Flame",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "4 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,40);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Slash:1513768633434640517>Slash] [AOE] — chém đường lửa gây 5 <:Burn:1513762753691652177>Burn lên kẻ thù ở turn sau`,
      ];
    },
  },
  "today's expression": {
    name: "Today's Expression",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:TETH:1449759432119419070>",
    cost: "3 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "3 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "4 <:Light:1513786082502770719>Light & 15 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,25), d2 = r(5,8);
      return [
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — nhảy lên chém xuống, gây 3 <:Bind:1513768025881317457>Bind và 3 Feeble`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — chém địch`,
      ];
    },
  },
  "marionette": {
    name: "Marionette",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:ZAYIN:1449759413966606398>",
    cost: "1 <:Light:1513786082502770719>Light & 10 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
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
    cost: "3 <:Light:1513786082502770719>Light & 10 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "6 Turn", diceMul: "1x",
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
      const SHOW = 3;
      const showCount = Math.min(SHOW, hits.length);
      for (let i = 0; i < showCount; i++) {
        const { val, staminaDmg } = hits[i];
        const label = i === 0 ? "" : ` ↩️ Reuse ${i}`;
        const tail = i === hits.length - 1 ? " *(hết Reuse)*" : "";
        lines.push(`${getDEmoji(i)}${label} **${val}** [<:Blunt:1513768529718022254>Blunt] — giảm Stamina địch = ${staminaDmg}${tail}`);
      }
      if (hits.length > SHOW) {
        const restStamina = hits.slice(SHOW).reduce((s, h) => s + h.staminaDmg, 0);
        const restDmg = hits.slice(SHOW).reduce((s, h) => s + h.val, 0);
        lines.push(`*↩️ Reuse ${SHOW}–${MAX_REUSE}: [${hits.slice(SHOW).map(h => h.val).join(", ")}] — tổng ${restDmg} DMG, giảm ${restStamina} Stamina (hết Reuse)*`);
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
    cost: "1 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "???", diceMul: "1x",
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
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
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
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
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
    cost: "4 <:Light:1513786082502770719>Light & 20 Sanity 🧠", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,10), d2 = r(3,9), d3 = r(4,6);
      const hasBleed = Math.random() < 0.5;
      return [
        `*Khi dùng: <:Bleed:1513762688226955285>Bleed tồn tại thêm 1 turn*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt]`,
        `<:Dice3:1508173643518050395> **${hasBleed ? d3*2 : d3}** [<:Blunt:1513768529718022254>Blunt]${hasBleed ? " *(địch có Bleed: dmg x2)*" : " *(địch không có Bleed)*"}`,
      ];
    },
  },

  // ── Abnormality Pages (WAW) ──
  "hornet": {
    name: "Hornet",
    tags: "Abnormalities <:The_Library:1474374220023857192> <:WAW:1449759461001527518>",
    cost: "2 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "2 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "3 Turn", diceMul: "1x (dmg = dice x2)",
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
    cost: "5 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "4 Turn", diceMul: "1x (dmg = dice x2)",
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
    cost: "5 <:Light:1513786082502770719>Light & 30 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
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
    cost: "5 <:Light:1513786082502770719>Light & 40 Sanity 🧠", cd: "4 Turn", diceMul: "1x (dmg = dice x2)",
    roll() {
      const d1 = r(4,8), d2 = r(4,9), d3 = r(5,9);
      return [
        `*[AOE] — Lượng dmg = số dice x2*`,
        `<:Dice1:1508173590078558369> **${d1*2}** [<:Blunt:1513768529718022254>Blunt] — Màn một: khiến tất cả địch mất 3 <:Light:1513786082502770719>Light`,
        `<:Dice2:1508173623691710625> **${d2*2}** [<:Blunt:1513768529718022254>Blunt] — Màn hai: tất cả địch nhận 10 <:Bind:1513768025881317457>Bind`,
        `<:Dice3:1508173643518050395> **${d3*2}** [<:Blunt:1513768529718022254>Blunt] — Màn cuối: tất cả địch nhận 2 Feeble`,
      ];
    },
  },

  // ── Frost Splinter (no tier tag) ──
  "frost splinter": {
    name: "Frost Splinter",
    tags: "Abnormalities <:The_Library:1474374220023857192>",
    cost: "6 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,12), d2 = r(8,13);
      return [
        `*[AOE]*`,
        `<:Dice1:1508173590078558369> **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Bind:1513768025881317457>Bind và 1 Feeble trong 1 Turn`,
        `<:Dice2:1508173623691710625> **${d2}** [<:Blunt:1513768529718022254>Blunt] — gây 1 <:Bind:1513768025881317457>Bind và 1 Feeble trong 1 Turn`,
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
        `<:Dice3:1508173643518050395> **${d3}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — đạp địch ra xa, gây 2 <:Bind:1513768025881317457>Bind`,
        `<:Dice4:1508176464367845600> **${d4}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [AoE 2 người] — gây 3 <:Paralyze:1513763316479295548>Paralyze`,
      ];
    },
  },

  // ── Fairy (Degraded) skills ──
  "degraded fairy": {
    name: "Degraded Fairy",
    tags: "Fairy <:Fairy:1513782007602216960>",
    cost: "2 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
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
    roll() {
      const d1 = r(7,11);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Guard Break] — Triệu hồi cây cột đập mặt kẻ thù gây 4 <:Fairy:1513782007602216960>Fairy`,
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
    cost: "Tiêu 2 viên đạn", cd: "1 Turn", diceMul: "1x",
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
    cost: "Tiêu 5 Imitation", cd: "—", diceMul: "2x",
    roll() {
      const d1 = r(15,26);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Unblockable]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Bổ dọc kẻ địch từ trên xuống, cắt đôi người chúng`,
      ];
    },
  },
  "great split horizontal": {
    name: "Great Split: Horizontal", weaponOf: "Mimicry Blade", tags: "Weapon",
    cost: "Tiêu 5 Imitation, cần bản thân dưới 30% HP", cd: "—", diceMul: "3x",
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
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — Tạo một cái cánh hất vào mặt kẻ thù, gây 7 <:Burn:1513762753691652177>Burn; bản thân giảm 15 Sanity`,
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
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] [Guard Break] [AOE 3 người] — Đập trường đao xuống tạo vùng lửa lớn, gắn 5 <:Burn:1513762753691652177>Burn`,
      ];
    },
  },
  "violent flame": {
    name: "Violent Flame", weaponOf: "Liu Martial Arts", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,8), d2 = r(6,16);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Đấm vào mặt kẻ thù, gây 3 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Đấm vào mặt kẻ thù, gây 6 <:Burn:1513762753691652177>Burn`,
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
    roll() {
      const d1 = r(4,10), d2 = r(4,10), d3 = r(4,10), d4 = r(1,4);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Lao lên chém kẻ địch, gây 2 <:Rupture:1513762812722155682>Rupture`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Lướt quanh chém liên tục`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Kết thúc bằng một đòn chém ngang`,
        `${D4} **${d4}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — Gây thêm bonus dmg = Dice x6, sau đó xóa stack **Unlocked Blade**`,
      ];
    },
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
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Đâm kẻ thù, nhận 4 <:Haste:1513768004222062632>Haste`,
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
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — Đấm vào mặt kẻ thù, gây 4 <:Burn:1513762753691652177>Burn`,
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
    // isReuse = true cho lần roll thứ 2 trở đi (do -skill mook workshop <n> gọi).
    // Theo mô tả: reuse mất hiệu ứng "nhận 1 Light" nhưng vẫn gây dmg 2 hit + Rupture như cũ.
    roll(isReuse = false) {
      const d1 = r(10,19);
      const lightText = isReuse ? "" : " và nhận 1 <:Light:1513786082502770719>Light";
      const reuseTag = isReuse ? " *(Reuse — tốn 1 <:Light:1513786082502770719>Light, không nhận Light)*" : "";
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Rút kiếm cắt không gian nơi kẻ địch đứng, gây dmg 2 hit${lightText} và gây 2 <:Rupture:1513762812722155682>Rupture${reuseTag}`,
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
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [AOE 2 người] — Đâm hai thanh kiếm vào kẻ địch`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Guard Break] [AOE 2 người] — Trảm ngang người chúng`,
      ];
    },
  },
  "zelkova workshop": {
    name: "Zelkova Workshop", weaponOf: "Zelkova Workshop", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,9), d2 = r(8,12);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — Dùng rìu chặt đứt kẻ địch, gây 4 <:Bleed:1513762688226955285>Bleed (turn sau)`,
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Guard Break] — Dùng chùy kết liễu, gây 6 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst`,
      ];
    },
  },
  "atelier logic shotgun": {
    name: "Atelier Logic: Shotgun", weaponOf: "Atelier Logic", tags: "Weapon",
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
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,9), d2 = r(7,10);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — Dùng Pistol bên trái bắn kẻ địch`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable] — Kết thúc bằng Pistol bên phải, đổi về dạng Shotgun`,
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
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(12,24);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] [Guard Break] [AOE 3 người] — Lao lên bổ xuống kẻ địch`,
      ];
    },
  },
  "allas workshop": {
    name: "Allas Workshop", weaponOf: "Allas Workshop", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(10,18);
      return [
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Unblockable] — Dùng ngọn thương đâm xuyên kẻ địch trong chớp mắt`,
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
        `${D1} **${d1}** — Gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "remise": {
    name: "Remise", weaponOf: "Family Heir Sabre", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,10);
      return [
        `${D1} **${d1}** — Gây 2 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** — Gây 3 <:Sinking:1513762793436741652>Sinking`,
      ];
    },
  },
  "nightmare hunt": {
    name: "Nightmare Hunt", weaponOf: "Family Heir Sabre", tags: "Weapon",
    cost: "—", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,10), d2 = r(10,13), d3 = r(13,16), d4 = r(13,16);
      return [
        `${D1} **${d1}** — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D2} **${d2}** — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D3} **${d3}** — Gây 1 <:Sinking:1513762793436741652>Sinking`,
        `${D4} **${d4}** — Gây 3 <:Sinking:1513762793436741652>Sinking. Nếu địch ≥10 <:Sinking:1513762793436741652>Sinking: tiêu hết và +3 <:DiceUp:1513767795681398894>Dice Up cho bản thân turn này và sau`,
      ];
    },
  },
  "grappling": {
    name: "Grappling", weaponOf: "Brawler", tags: "Weapon",
    cost: "—", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(7,15);
      return [
        `*[Hakuda] Nếu xài Critical sau khi xài skill có tag Airborne: dice đổi thành [14~30]*`,
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
    name: "Falco Berigora", weaponOf: "Manifested E.G.O (Hoshino)", tags: "Ego Pages",
    // Light: "??" GIỮ NGUYÊN như GM ghi (chưa xác nhận số cụ thể) — KHÔNG tự bịa.
    cost: "?? Light", cd: "3 Turn", diceMul: "1x",
    roll() {
      return [
        `${D1} dồn một viên cầu rồi bắn thẳng tới kẻ địch, gây 30 × Lượng Light bỏ ra [KHÔNG TỰ ĐỘNG TÍNH — GM/player tự nhân theo Light đã dùng].`,
        `${D1} Khi đạt -40 Sanity, áp thêm 2 Paralyze.`,
        `${D1} Nếu kẻ địch có Bleed: tiêu hết Bleed, chuyển thành 2 Erosion (Erosion: +0,1x Res của ĐỐI PHƯƠNG, chỉ áp dụng 1 Turn, áp với chính bản thân — KHÔNG PHẢI status hệ thống track được, GM tự áp).`,
      ];
    },
  },
  "wedjat": {
    name: "Wedjat", weaponOf: "Manifested E.G.O (Hoshino)", tags: "Ego Pages",
    cost: "— (chưa rõ Light cost)", cd: "1 Turn", diceMul: "1x",
    roll() {
      return [
        `${D1} Bắn 1 đòn Repeat Ammo [AOE/True Dmg], gây 5 Blind và 2 Bleed.`,
        `Nhận 100 HP Shield với TỪNG mục tiêu dính đòn.`,
        `*(Blind: khiến đòn đánh thường tiếp theo bị trượt — KHÔNG PHẢI status hệ thống track được, GM tự áp. HP Shield cũng không tự động — GM/player tự quản lý.)*`,
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
        `${D2} **${d2}** [<:Blunt:1513768529718022254>Blunt] [Unparriable][Undodgeable] — Nhảy lên đá thêm 1 phát khiến hắn đập mặt xuống đất, gây Tremor Burst. *(Nếu trên 20 Tremor: +2 Dice Up cho 2 Turn kế tiếp — GM/player tự áp, không tự động track.)*`,
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
    roll(light = 4) {
      // Cap 9 lần Reuse theo spec gốc, dù light dư nhiều hơn mức cần cho 9 lần.
      const reuseTimes = Math.min(9, Math.max(0, light - 2));
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
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém kẻ địch hai lần liên tiếp, gây 3 <:Rupture:1513762812722155682>Rupture. Nếu ≥5 <:Haste:1513768004222062632>Haste: tái sử dụng skill này một lần nữa`,
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
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] [Unparriable] [AOE 2 người] — Tạo tia sáng năng lượng hư vô bắn vào kẻ địch. Nhận 7 <:Haste:1513768004222062632>Haste và gây 14 <:Bleed:1513762688226955285>Bleed, 8 <:Sinking:1513762793436741652>Sinking`,
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
        `*[Mỗi Dice có thể tốn 5 viên đạn The Living and The Departed để +1 <:DiceUp:1513767795681398894>Dice Up/Dice và +1 <:Sinking:1513762793436741652>Sinking mỗi viên]*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] — Bắn liên tục vào kẻ địch`,
        `${D2} **${d2}** [<:Pierce:1513768511179329556>Pierce] — Lao tới bắn phát cuối, gây 3 <:Sinking:1513762793436741652>Sinking. Tùy theo <:Sinking:1513762793436741652>Sinking trên địch: 0 → -2 <:DiceDown:1513767826257874964>Dice Down | 1-19 → 6 <:Bind:1513768025881317457>Bind | ≥20 → 6 Fragile`,
      ];
    },
  },
  "kaen jujizan": {
    name: "Kaen Jūjizan", weaponOf: "Kaenken Rekka", tags: "Weapon",
    cost: "—", cd: "2 Turn", diceMul: "1x (2x nếu địch >10 <:Burn:1513762753691652177>Burn)",
    roll() {
      const d1 = r(6,20);
      return [
        `**[<:Slash:1513768633434640517>Slash] [Khuếch tán 3 mục tiêu]**`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Lướt lên chém kẻ địch, triệu hồi rồng lửa cuốn vòng rồi tung chuỗi chém, gây 6 <:Burn:1513762753691652177>Burn`,
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
      `> — **10 Rising Fever** → Seal 1: Base Dmg 35 [<:Blunt:1513768529718022254>Blunt], +50% Dmg. Mọi đòn đánh áp 1 <:Bleed:1513762688226955285>Bleed + 1 <:Burn:1513762753691652177>Burn\n` +
      `> — **20 Rising Fever** → Seal 2: Medium Weapon, Base Dmg 20 [<:Slash:1513768633434640517>Slash], +100% Dmg. Mọi đòn đánh áp 2 <:Bleed:1513762688226955285>Bleed + 2 <:Burn:1513762753691652177>Burn\n` +
      `> — **30 Rising Fever** → Seal 3: Light Weapon, Base Dmg 13 [<:Slash:1513768633434640517>Slash], +200% Dmg. Mọi đòn đánh áp 4 <:Bleed:1513762688226955285>Bleed + 4 <:Burn:1513762753691652177>Burn. Toàn bộ đồng minh lẫn kẻ thù chịu 20 <:Burn:1513762753691652177>Burn vào đầu mỗi turn`,
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
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — sau đó đâm sâu, nhận 4 <:Haste:1513768004222062632>Haste`,
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
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — lướt qua người kẻ địch rồi chém, nhận 3 <:Haste:1513768004222062632>Haste và gây 3 <:Rupture:1513762812722155682>Rupture`,
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
    cost: "0 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(6,10);
      return [
        `${D1} **${d1}** — dịch chuyển lại gần kẻ địch, né 1 đòn tấn công (không thể né Undodgeable), sau đó nhận 2 <:Haste:1513768004222062632>Haste`,
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
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — đá kẻ địch lên trời gây **[Airborne]**`,
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
        `*+1 Clash Power với mỗi viên đạn The Living & The Departed; áp 2 <:Sinking:1513762793436741652>Sinking khi Clash thắng; +1 <:DiceUp:1513767795681398894>Dice Up với mỗi 5 **Butterfly** kẻ địch có*`,
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
        `*+1 Clash Power với mỗi viên đạn The Living & The Departed; áp 3 <:Sinking:1513762793436741652>Sinking khi Clash thắng; +1 <:DiceUp:1513767795681398894>Dice Up với mỗi 5 **Butterfly** kẻ địch có*`,
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
        `*+1 Clash Power với mỗi viên đạn The Living & The Departed; áp 5 <:Sinking:1513762793436741652>Sinking khi Clash thắng; +1 <:DiceUp:1513767795681398894>Dice Up với mỗi 5 **Butterfly** kẻ địch có*`,
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
    roll() {
      const chargeturns = 1; // default 1 turn charge
      const d1 = r(10,16);
      return [
        `*Tích tụ tối đa 3 Turn — mỗi turn tích thêm 1 Reuse; CD bắt đầu sau khi phóng*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Unblockable] — phóng kiếm khí từ năng lượng quỷ tích tụ`,
      ];
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
    roll() {
      const chargeBonus = 0; // +10 Dice per extra turn charged, shown as note
      const d1 = r(20,23);
      return [
        `*Tích tối thiểu 1 Turn, tối đa 3 Turn — mỗi turn tích thêm +10 Dice*`,
        `${D1} **${d1}** [<:Pierce:1513768511179329556>Pierce] [Guard Break] — bắn viên đạn chứa năng lượng quỷ tích tụ`,
      ];
    },
  },
  "jackpot": {
    name: "Jackpot", weaponOf: "Ebony & Ivory", tags: "Weapon",
    cost: "— [Chỉ khi dùng Charge Shot với Gunslinger Style]", cd: "—", diceMul: "2x",
    roll() {
      const isInstakill = Math.random() < 0.0777;
      return [
        `*Tích tụ 7 Turn — 7.77% cơ hội insta-kill kẻ địch*`,
        isInstakill
          ? `*💀 7.77% kích hoạt — INSTA-KILL!*`
          : ``,
        `${D1} **77** [<:Pierce:1513768511179329556>Pierce] [Guard Break] [Undodgeable] [Unparriable] [Unclashable] — bắn viên đạn quỷ tích tụ 7 turn${isInstakill ? " — **INSTA-KILL**" : ""}`,
      ].filter(Boolean);
    },
  },

  // ══════════════ EGO Pages — Manifested E.G.O ══════════════
  "crescent divinity": {
    name: "Crescent Divinity", weaponOf: "Manifested E.G.O", tags: "EGO Page",
    cost: "1 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,13);
      return [
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] [Undodgeable] — lướt xuyên qua người kẻ địch trong khi trên không, nhận 25 Forte`,
      ];
    },
  },
  "purge of light": {
    name: "Purge of Light", weaponOf: "Manifested E.G.O", tags: "EGO Page",
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
    roll() {
      return [
        `*Bản thân và tất cả đồng đội nhận 30 Shield HP, rồi chỉ định một đồng đội hoặc chính bản thân.*`,
        `*Người được chỉ định sẽ nhận Shield HP bằng 50% Max HP của người dùng và 1 <:DiceUp:1513767795681398894>Dice Up đến hết turn.*`,
      ];
    },
  },
  "astral quantization": {
    name: "Astral Quantization", weaponOf: "Lucent Historia", tags: "Weapon",
    cost: "—", cd: "4 Turn", diceMul: "1x",
    roll() {
      const dice = r(1, 50);
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
    cost: "3 <:Light:1513786082502770719>Light, 10 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(18,24);
      return [
        `<:Dice1:1508173590078558369> **${d1}** — Gây 2 <:DiceDown:1513767826257874964>Dice Down, 2 <:Bind:1513768025881317457>Bind và toàn bộ đồng minh nhận 3 <:Haste:1513768004222062632>Haste turn kế [<:Pierce:1513768511179329556>Pierce] [Undodgeable] [Unblockable]`,
        `*[After Use] E.G.O Passive **Silence**: khi bị tấn công turn kế sẽ nhận 3 <:Bind:1513768025881317457>Bind và tăng 20% Dmg Up*`,
        `*__Utter to me what you think the ideal is.__*`,
      ];
    },
  },
  "la sangre de sancho": {
    name: "La Sangre De Sancho", tags: "E.G.O Page <:limbus:1010616548114833468> <:ZAYIN:1449759413966606398>",
    cost: "3 <:Light:1513786082502770719>Light, 10 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
    roll() {
      const d1 = r(14,26);
      return [
        `${D1} **${d1}** — Gây 8 <:Bleed:1513762688226955285>Bleed và hồi HP bằng 50% Damage gây ra`,
        `*[After Use] E.G.O Passive **Immoderate Passion**: mỗi khi tấn công kẻ địch có <:Bleed:1513762688226955285>Bleed, hồi 3 HP*`,
        `*__Gallop on, Rocinante! Justice shall prevail!__*`,
      ];
    },
  },
  "representation emitter": {
    name: "Representation Emitter", tags: "E.G.O Page <:limbus:1010616548114833468> <:ZAYIN:1449759413966606398>",
    cost: "3 <:Light:1513786082502770719>Light, 10 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
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
    cost: "3 <:Light:1513786082502770719>Light, 10 Sanity 🧠", cd: "3 Turn", diceMul: "1x",
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
        `*Nếu Heat Gauge ≥4: thêm ${D3} **${d3}** — gây <:TremorBurst:1513802464632246352>Tremor Burst (đối thủ không thể tấn công trong 1 turn kế)*`,
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
    keywords: ["follow-up", "airborne", "blunt", "4th hit"],
    roll() {
      const d1 = r(10, 14);
      return [
        `*Kích hoạt sau đòn đánh thứ 4 mỗi turn — Không thể tồn tại chung với **Pounce***`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt] — gây [Airborne]`,
      ];
    },
  },
  "pounce": {
    name: "Pounce",
    cost: "-", cd: "—", diceMul: "1x",
    incompatibleWith: ["follow-up"],
    keywords: ["pounce", "blunt", "4th hit"],
    roll() {
      const d1 = r(8, 30);
      return [
        `*Kích hoạt sau đòn đánh thứ 4 mỗi turn — Không thể tồn tại chung với **Follow-Up***`,
        `${D1} **${d1}** [<:Blunt:1513768529718022254>Blunt]`,
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
        `${D1} **${d1}** — Nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D2} **${d2}** — Nhận 2 <:Poise:1513762945715142736>Poise`,
        `${D3} **${d3}** — Nhận 2 <:Poise:1513762945715142736>Poise`,
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
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up. Nhận được 5 Stack **Scorch Propellant Round** sau khi sử dụng`,
      ];
    },
  },
  "savage triple slash": {
    name: "Savage Triple Slash", tags: "Burn/Tremor",
    cost: "3 <:Light:1513786082502770719>Light", cd: "2 Turn", diceMul: "1x",
    roll() {
      const d1 = r(1,5), d2 = r(3,8), d3 = r(3,9);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] — Gây 2 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn, <:Tremor:1513762737388257380>Tremor và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up. Nhận được 5 Stack **Scorch Propellant Round** sau khi sử dụng`,
      ];
    },
  },
  "blasting shatterslash": {
    name: "Blasting Shatterslash", tags: "Burn/Tremor",
    cost: "4 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(4,6), d2 = r(4,8), d3 = r(8,11);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Tiêu 1 Stack **Scorch Propellant Round** để gây thêm <:Burn:1513762753691652177>Burn tương ứng với số <:Tremor:1513762737388257380>Tremor trên người địch và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up`,
      ];
    },
  },
  "tanglecleaver flurry": {
    name: "Tanglecleaver Flurry", tags: "Burn/Tremor",
    cost: "5 <:Light:1513786082502770719>Light", cd: "4 Turn", diceMul: "1x",
    roll() {
      const d1 = r(5,7), d2 = r(5,7), d3 = r(5,5);
      return [
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn và tăng 5 <:DiceUp:1513767795681398894>Dice Up`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Unblockable] — Gây 3 <:Tremor:1513762737388257380>Tremor. Tiêu 1 Stack **Scorch Propellant Round** để gây thêm 2 <:Burn:1513762753691652177>Burn và tăng thêm 5 <:DiceUp:1513767795681398894>Dice Up`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Gây 3 <:Tremor:1513762737388257380>Tremor và <:TremorBurst:1513802464632246352>Tremor Burst *(nếu có trên hoặc bằng 15 Stack **Scorch Propellant Round**)*. Tiêu toàn bộ Stack **Scorch Propellant Round** để gây thêm <:Burn:1513762753691652177>Burn tương ứng với số <:Tremor:1513762737388257380>Tremor trên người địch và tăng thêm 3 <:DiceUp:1513767795681398894>Dice Up tương ứng với mỗi Stack **Scorch Propellant Round** được xả`,
      ];
    },
  },

  // ── Tiantui Star's Blade [天退星刀] ──
  "tiantui star's blade": {
    name: "Tiantui Star's Blade [天退星刀]", tags: "Weapon",
    weaponType: "Medium", weaponDmg: "14 [<:Slash:1513768633434640517>Slash]",
    passive: "**Reloading Tiantui Star's Blade** — Khi sử dụng <:Shin:1507591140180754588>Shin và dùng **Tiantui Star's Blade Reload**, bạn nhận được và chuyển hóa toàn bộ **Tigermark Round** hiện có qua **Savage Tigermark Round**",
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
        `${D1} *Tiêu thụ toàn bộ **Tigermark Round** có trên người — mỗi 1 Round tiêu thụ gây thêm 1 <:Burn:1513762753691652177>Burn và 1 <:Tremor:1513762737388257380>Tremor tương ứng. Nếu có trên hoặc bằng 6 **Tigermark Round**: gây thêm <:TremorBurst:1513802464632246352>Tremor Burst*`,
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
        `*Điều kiện: dùng ngay sau **Triple Slash Blast [爆]** và có ít nhất 10 **Savage Tigermark Round** trên người*`,
        `${D1} *Tiêu thụ toàn bộ **Savage Tigermark Round** có trên người — mỗi 1 Round tiêu thụ gây thêm 1 <:Burn:1513762753691652177>Burn, 1 <:Tremor:1513762737388257380>Tremor tương ứng vào Dice cuối*`,
        `${D1} **${d1}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Khuỵu người xuống, rồi kích hoạt đạn của thanh kiếm tạo lực đẩy sau đó lao tới chặt kẻ địch, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Burn:1513762753691652177>Burn`,
        `${D2} **${d2}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Sau đó tiếp tục chém, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Burn:1513762753691652177>Burn`,
        `${D3} **${d3}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Vận lực lấy đà lùi phía sau một chút rồi chém ngang, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Burn:1513762753691652177>Burn`,
        `${D4} **${d4}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Sau đó bổ dọc xuống, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Burn:1513762753691652177>Burn`,
        `${D5} **${d5}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] — Rồi vung ngang, gây 1 <:Tremor:1513762737388257380>Tremor, 1 <:Burn:1513762753691652177>Burn`,
        `${D6} **${d6}** [<:Slash:1513768633434640517>Slash] [Undodgeable] [Guard Break] [AOE 4 người] — Khuỵu gối xuống vận lực, nổ ga lần cuối nữa rồi nhảy bổ lên bổ thanh kiếm xuống kẻ địch, gây 6 <:Tremor:1513762737388257380>Tremor, <:Burn:1513762753691652177>Burn và <:TremorBurst:1513802464632246352>Tremor Burst 2 lần`,
      ];
    },
  },
  "tanglecleaver reload": {
    name: "Tanglecleaver Reload",
    weaponOf: "Tiantui Star's Blade [天退星刀]", tags: "Weapon",
    cost: "3 <:Light:1513786082502770719>Light", cd: "1 Turn", diceMul: "1x",
    roll() {
      const d1 = r(3,10);
      return [
        `*Chỉ sử dụng được khi dùng vũ khí **Tiantui Star's Blade [天退星刀]** và Outfit **The Thumb Capo IIII** (Page này không tốn slot)*`,
        `${D1} **${d1}** — Ngắt một đòn của kẻ địch thông qua \`-rtparry\`, sau đó nạp **Tigermark Round** vào **Tiantui Star's Blade [天退星刀]** tương ứng với số dice gieo ra *(nếu \`-rtparry\` thất bại thì vẫn nạp đạn được)*`,
      ];
    },
  },

  // ── Serum K (Singularity) ──
  "serum k": {
    name: "Serum K", tags: "Singularity",
    cost: "3 <:Light:1513786082502770719>Light", cd: "6 Turn", diceMul: "1x",
    roll() {
      const d1 = r(9,16);
      const heal = d1 * 2 + 25;
      return [
        `${D1} **${d1}** — Hồi phục **${heal} HP** (= số dice × 2 + 25) và giải 3 Debuff bất kỳ của bản thân`,
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
  // 3. Fallback: tìm partial match trong SKILLS keys
  const keyStripped = key.replace(/\s+\S+$/, "").trim();
  for (const [k, v] of Object.entries(SKILLS)) {
    if (k.includes(key) || (keyStripped && k.includes(keyStripped) && keyStripped.length >= 3)) return v;
  }
  return null;
}

// ─── findByKeyword — dùng cho lệnh `-skill list <keyword>` ──────────────────
// Tìm tất cả skill có keyword xuất hiện trong: name, tags, keywords[], passive,
// hoặc trong nội dung roll() (emoji name được strip để match text thuần).
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
function autoBuildDmgStrFromSkillRoll(skill, { forceMinDice = false, diceModifier = 0 } = {}) {
  startEmotionTracking();
  if (forceMinDice) startForceMinDice();
  if (diceModifier !== 0) setDiceModifier(diceModifier);
  const lines = skill.roll();
  if (forceMinDice) stopForceMinDice();
  if (diceModifier !== 0) clearDiceModifier();
  const tracked = stopEmotionTracking();
  const totalEmotionDelta = tracked.reduce((sum, t) => sum + t.delta, 0);

  const warnings = [];
  const diceTypeByLine = []; // { result, type } theo ĐÚNG thứ tự tracked[]
  const TYPE_MAP = { Slash: "S", Blunt: "B", Pierce: "P" };
  let trackedIdx = 0;
  for (const line of lines) {
    // Chỉ những dòng BẮT ĐẦU bằng emoji DiceN mới là 1 dice THẬT — các dòng khác
    // (ghi chú điều kiện, mô tả hiệu ứng phụ...) không tính.
    if (!/^<:Dice\d+:/.test(line)) continue;
    const typeMatch = line.match(/\[<:(?:Slash|Blunt|Pierce):\d+>(Slash|Blunt|Pierce)\]/);
    if (typeMatch && tracked[trackedIdx]) {
      diceTypeByLine.push({ result: tracked[trackedIdx].result, type: TYPE_MAP[typeMatch[1]] });
    }
    trackedIdx++;
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
  if (/Dice Up|Poise|Light|Rupture|Bleed|Tremor|Sinking/i.test(lines.join(" ")) && diceTypeByLine.length > 0) {
    warnings.push(`Skill có ghi chú hiệu ứng phụ (Dice Up/Poise/Light/status...) — xem embed roll bên dưới để tự áp dụng, dmgStr chỉ chứa phần sát thương.`);
  }

  if (diceTypeByLine.length === 0) {
    return { dmgStr: null, warnings, tracked, totalEmotionDelta, lines };
  }
  const dmgStr = diceTypeByLine.map(d => `${d.result}${d.type}`).join(" + ");
  return { dmgStr, warnings, tracked, totalEmotionDelta, lines };
}

module.exports = { SKILLS, SKILL_ALIASES, findSkill, findByKeyword, r, computeEmotionDelta, startEmotionTracking, stopEmotionTracking, startForceMinDice, stopForceMinDice, setDiceModifier, clearDiceModifier, autoBuildDmgStrFromSkillRoll, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10 };
