// constants.js
// Các giá trị giới hạn được dùng chung giữa index.js (logic + xử lý lệnh)
// và deploy-commands.js (khai báo slash command với Discord).
//
// Mục đích: tránh duplicate magic numbers ở 2 file — nếu sau này cần đổi 1
// giới hạn (VD: tăng SINKING_MAX, tăng số lần mở cache tối đa, thêm profile...)
// thì chỉ cần sửa ở đây, cả slash command validation (Discord) và logic xử lý
// (index.js) sẽ tự động đồng bộ, alr.


// ── CONSUMABLE ITEMS ──────────────────────────────────────────────────────
// Fragaria chốt trực tiếp: "CHỈ có consumable items gồm Táo, Chuối, Dưa hấu,
// Medkit, K-Corp Ampule mới được mang vào loadout — CHẶN toàn bộ còn lại".
// TRƯỚC ĐÂY loadout suy ngược ("mọi item KHÔNG phải accessory") nên Fixer's
// Note, Sealed Book Cache, Chipboard Cache… đều xếp được — vô nghĩa vì
// encounter-actions.js không có nhánh dùng cho chúng.
// Danh sách TƯỜNG MINH, KHÔNG suy ngược: thêm consumable mới thì thêm vào đây.
const CONSUMABLE_ITEMS = ["Táo", "Chuối", "Dưa hấu", "Medkit", "K-Corp Ampule"];
const CONSUMABLE_ITEM_SET = new Set(CONSUMABLE_ITEMS.map(n => n.toLowerCase()));
function isConsumableItem(name) {
  return CONSUMABLE_ITEM_SET.has(String(name ?? "").trim().toLowerCase());
}

module.exports = {
  CONSUMABLE_ITEMS, isConsumableItem,
  // /math: Sanity ban đầu của địch tối thiểu (dùng để tính Sinking khi địch đạt -45)
  SANITY_MIN: -45,

  // /math: Poise stacks tối đa (1 stack = 5% crit)
  POISE_MAX: 99,

  // /math: Sinking counts tối đa của địch
  SINKING_MAX: 99,

  // /math: Rupture counts tối đa của địch
  RUPTURE_MAX: 99,

  // /math: Burn / Tremor / Bleed counts tối đa của địch — cùng mốc 99 như Sinking/Rupture/Poise
  BURN_MAX: 99,
  TREMOR_MAX: 99,
  BLEED_MAX: 99,
  // /math: Charge stacks tối đa (trên bản thân, dùng để kích hoạt vũ khí/skill đặc biệt)
  CHARGE_MAX: 99,

  // Imitation (Mimicry Blade) — Fragaria chốt: "cap của Status Imitation thành
  // 10 Max". TRƯỚC ĐÂY hoàn toàn KHÔNG có cap: 4 nơi đều `imitation += n` trần
  // trụi, và `imitation` cũng không nằm trong STATUS_CAPS_SHARED nên `-encounter
  // setstatus` set bao nhiêu cũng được.
  // ⚠️ CHỈ cap `imitation` (stack ĐANG CÓ, tiêu 5 mỗi lần Great Split).
  // `imitationConsumedTotal` là bộ đếm TÍCH LUỸ cả trận cho Dmg Bonus của
  // "The Imitation" — KHÔNG cap ở 10, nếu không thì cap 50% Dmg Bonus (=10
  // Imitation đã tiêu) sẽ không bao giờ chạm tới được.
  IMITATION_MAX: 10,

  // ── ORACLE DEVICE [CADUCEUS] — 9 mặt của "Will of Hermes" ─────────────────
  // TRƯỚC ĐÂY chỉ tồn tại dạng 9 CHUỖI trong index.js (`PRESCRIPT_TABLE`) nên
  // không code nào đọc được base dmg / type / stamina — lệnh `-caduceus` chỉ in
  // chữ ra cho GM tự tính. Nay là DỮ LIỆU THẬT để đánh trong encounter.
  //
  // `dmg` dùng làm base dmg khi M1, VÀ làm **Dice Value** khi dùng Critical
  // (Fragaria: "M1 thì không có Dice Value, nhưng khi dùng Critical thì Base Dmg
  // của mỗi loại vũ khí của Caduceus sẽ trở thành Dice Value nhằm phục vụ việc
  // bonus từ sanity và clash").
  CADUCEUS_DICE: [
    { n: 1, name: "When hacking through the ribs with a hatchet...",                          dmg: 8,  type: "Blunt",  stamina: 5,  effect: "self:poise:2",        desc: "nhận 2 Poise" },
    { n: 2, name: "When penetrating the lungs with a stiletto...",                            dmg: 8,  type: "Pierce", stamina: 5,  effect: "foe:sinking:2",       desc: "gây 2 Sinking" },
    { n: 3, name: "When cleaving through the shoulder and the skull with a bastard sword...", dmg: 15, type: "Slash",  stamina: 10, effect: "self:dmgUpNextTurn:10", desc: "bản thân +10% Dmg turn sau (2 lần/turn)" },
    { n: 4, name: "When punching 10 or more holes in the torso with a rapier...",             dmg: 15, type: "Pierce", stamina: 10, effect: "foe:takeDmg:5",       desc: "địch nhận thêm 5% Dmg turn này (2 lần/turn)" },
    { n: 5, name: "When caving in the back of the skull with a hammer...",                    dmg: 15, type: "Blunt",  stamina: 10, effect: "foe:drainStamina:50", desc: "giảm 50 Stamina địch" },
    { n: 6, name: "When rending the body with a greatsword...",                               dmg: 24, type: "Slash",  stamina: 20, effect: "foe:takeDmgType:10",  desc: "địch nhận thêm 10% Dmg từ Slash turn này (2 lần/turn)" },
    { n: 7, name: "When boring a 20-inch hole with a lance...",                               dmg: 24, type: "Pierce", stamina: 20, effect: "foe:takeDmgType:10",  desc: "địch nhận thêm 10% Dmg từ Pierce turn này (2 lần/turn)" },
    { n: 8, name: "When ripping the flesh to ten thousand strips with a whip...",             dmg: 24, type: "Blunt",  stamina: 20, effect: "foe:takeDmgType:10",  desc: "địch nhận thêm 10% Dmg từ Blunt turn này (2 lần/turn)" },
    { n: 9, name: "When lacerating through space itself with a scythe, like a certain someone...", dmg: 30, type: "Slash", stamina: 20, effect: "self:alwaysCrit", desc: "100% gây critical dmg" },
  ],

  // 3 bậc Critical thường của Caduceus — số dice roll và bonus khi ra ĐÚNG type.
  // Tên đủ 3 type mỗi bậc, đúng thứ tự Blunt / Pierce / Slash.
  CADUCEUS_CRIT_TIERS: [
    { tier: 1, rolls: 2, bonusPct: 30, cd: 1, tags: [],
      names: { Blunt: "Slam Down with Weight, Topple the Body", Pierce: "Lay Vertical The End, Insert Up to the Wick", Slash: "Lay the Blade on its Side, Slice Like a Severed Breath" } },
    { tier: 2, rolls: 3, bonusPct: 40, cd: 2, tags: ["Guard Break"],
      names: { Blunt: "Swing to Fell, Have it Meet the Ground", Pierce: "Aim Toward a Point, Let it Echo Within", Slash: "Carve at a Low Slant, Peel What Remains" } },
    { tier: 3, rolls: 4, bonusPct: 50, cd: 3, tags: ["Guard Break", "Undodgeable"],
      names: { Blunt: "Destroy the Sound, Crush Flat the Thought", Pierce: "Stab the Silence's Heart, Penetrate the Memory", Slash: "With Tempered Secret, Cut the Form" } },
  ],

  // 3 biến thể Furioso — mở theo Unlock I/II/III, đều cần ĐỦ 9 Procuration.
  CADUCEUS_FURIOSO: [
    { unlock: 1, name: "Furioso Replica",              bleed: 3, bind: 1, fragile: 1, diceMul: 1 },
    { unlock: 2, name: "Furioso [Crescendo]",          bleed: 4, bind: 2, fragile: 2, diceMul: 1.25 },
    { unlock: 3, name: "Furioso [Lacrimosa-Crescendo]", bleed: 5, bind: 3, fragile: 3, diceMul: 1.5 },
  ],

  // ── THE INDEX ORACLE'S PROXY (outfit) ─────────────────────────────────────
  // Sắc lệnh: MỖI TURN gieo **2 dice** 1–7 (bản cũ chỉ 1 dice và bảng khác hẳn).
  // ⚠️ "turn" ở đây = MỘT VÒNG TURN ORDER, không phải lượt riêng của từng người.
  PRESCRIPT_RULES: {
    1: { label: "Tấn công ít nhất một lần" },
    2: { label: "Thực hiện hành động phòng thủ ít nhất một lần" },
    3: { label: "Một hành động phòng thủ VÀ một hành động tấn công trong turn này" },
    4: { label: "Clash với 1 skill của kẻ địch trong turn" },
    5: { label: "Dùng vũ khí Blunt tấn công kẻ địch" },
    6: { label: "Dùng vũ khí Pierce tấn công kẻ địch" },
    7: { label: "Dùng vũ khí Slash tấn công kẻ địch" },
  },
  PRESCRIPT_DICE_PER_TURN: 2,

  // ⚠️ HAI OUTFIT CÙNG FACTION NHƯNG BẢNG SẮC LỆNH KHÁC NHAU — tôi đã lỡ gộp làm
  // một khi viết lại luật cho Oracle's Proxy, khiến **Index Proselyte** bị áp
  // nhầm bảng mới (5/6/7 thành Blunt/Pierce/Slash thay vì Né/Block/Parry).
  //   • Index Proselyte      : **1 dice**, bảng CŨ
  //   • Index Oracle's Proxy : **2 dice**, bảng MỚI (PRESCRIPT_RULES ở trên)
  PRESCRIPT_RULES_PROSELYTE: {
    1: { label: "Tấn công ít nhất một lần" },
    2: { label: "Né ít nhất một lần" },
    3: { label: "Block ít nhất một lần" },
    4: { label: "Parry ít nhất một lần" },
    5: { label: "Một hành động phòng thủ VÀ một hành động tấn công" },
    6: { label: "Không làm gì cả" },
    7: { label: "Clash với 1 skill của kẻ địch" },
  },
  PRESCRIPT_DICE_PROSELYTE: 1,
  KARMIC_PER_FAILURE: 5,
  KARMIC_MAX: 100,
  // Grace cần cho Unlock I / II / III.
  UNLOCK_THRESHOLDS: [3, 6, 9],
  // Protection + Regen mỗi turn khi Singleton, theo bậc Unlock.
  SINGLETON_UNLOCK_PROTECTION: { 1: 5, 2: 10, 3: 20 },
  // Procuration [Hermes] — 1 stack cho MỖI mặt dice dùng LẦN ĐẦU ⇒ trần đúng 9.
  PROCURATION_MAX: 9,
  FURIOSO_KARMIC_COST: 35,

  // Faction/Title — điều kiện của bộ The Index. Dùng `-setplayer faction:`/`title:`.
  FACTION_THE_INDEX: "The Index Syndicate",

  // ── SIZZLING WOUND ────────────────────────────────────────────────────────
  // Injury ĐẶC BIỆT: KHÔNG rơi ngẫu nhiên như MINOR/SEVERE_INJURIES, chỉ GM gán,
  // và VĨNH VIỄN — `-heal injury:` / dropdown chữa trị KHÔNG gỡ được, chỉ GM.
  SIZZLING_WOUND: "Sizzling Wound",
  SIZZLING_WOUND_DESC: "Nhận thêm 50% Dmg từ Burn và Bleed. Vĩnh viễn — chỉ GM gỡ được.",
  SIZZLING_WOUND_BURN_BLEED_MUL: 1.5,

  // Caduceus — 1 charge phòng thủ ứng với BAO NHIÊU Stamina đòn đánh thường.
  // Fragaria: *"charge defense cho M1 của Caduceus dựa vào Stamina tiêu thụ của
  // từng dice: lưỡi hái 20 stamina tiêu 1 charge, rìu 5 stamina thì 4 đòn rìu
  // mới cần 1 charge."* ⇒ 20 Stamina = 1 charge, KHÔNG dùng WEAPON_DEFENSE_HITS
  // theo weight như vũ khí thường (Caduceus đổi weight mỗi lần roll nên bảng
  // theo weight vô nghĩa với nó).
  CADUCEUS_STAMINA_PER_CHARGE: 20,

  // Heal bằng Ahn — Fragaria: "nên nâng heal bằng Ahn mỗi chu kỳ TỐI ĐA 2 LẦN
  // để dễ thở hơn". Đếm bằng CẶP (mốc chu kỳ, số lần) chứ không chỉ mốc thời
  // gian: chỉ lưu mốc thì không phân biệt được "hết lượt" với "sang chu kỳ mới".
  PAID_HEAL_PER_CYCLE: 2,
  // Chấn thương NHẸ tự khỏi khi qua chu kỳ 12h; NẶNG thì phải chữa ở shop.
  INJURY_HEAL_COST_MINOR: 50000,
  INJURY_HEAL_COST_SEVERE: 250000,

  // -encounter setstatus: 5 biến thể Tremor (Everlasting/Fracture/Reverb/Decay/
  // Chain) — max cap dùng CHUNG 99, xác nhận trực tiếp: "các stack tremor này đều
  // có max count là 99".
  TREMOR_VARIANT_MAX: 99,
  // -encounter setstatus: Spectro Frazzle — "Max 10 Count" theo đúng mô tả gốc,
  // KHÁC mốc 99 của 5 biến thể Tremor trên (không dùng chung TREMOR_VARIANT_MAX).
  SPECTRO_FRAZZLE_MAX: 10,

  // -encounter setstatus: Gaze[Awe] / Gaze of Contempt — "Max 7 Count" (đúng mô tả
  // gốc, dùng chung 1 mốc vì cùng giá trị 7).
  GAZE_AWE_MAX: 7,
  // -encounter setstatus: Contempt — "Max 1 Count" (khác Gaze[Awe]/Gaze of
  // Contempt, chỉ 1 stack duy nhất theo đúng mô tả gốc).
  CONTEMPT_MAX: 1,

  // -encounter setstatus: Haou tier (Flame/Bleed/Tremor/Rupture/Sinking) — "Max 99
  // Count" dùng chung cho cả 5, theo đúng mô tả gốc.
  HAOU_MAX: 99,

  // -encounter setstatus: Hemorrhage — "Tối đa 5 stack" theo đúng mô tả gốc.
  HEMORRHAGE_MAX: 5,

  // -encounter reload / -inventory: Ammo (và Frost/Incendiary Ammo) — "chỉ có thể
  // chứa tới 99 là Max ở trong Inventory VÀ mỗi khi vào Encounter" — dùng CHUNG 1
  // mốc cho cả 2 nơi (Inventory persistent + Encounter combat stack).
  AMMO_MAX: 99,

  // /parry: số lần roll tối đa mỗi lệnh
  PARRY_MAX_ROLLS: 30,

  // /randombook, /randomsealedbook, /chipboardcache: số lần mở tối đa mỗi lệnh
  OPEN_COUNT_MAX: 20,

  // /profile: số lượng save profile tối đa cho mỗi user
  MAX_PROFILES: 5,

  // /profile rename: độ dài tên profile tối đa
  PROFILE_NAME_MAX_LENGTH: 20,

  // /math: Butterfly status — The Living và The Departed max stacks
  BUTTERFLY_LIVING_MAX: 15,
  BUTTERFLY_DEPARTED_MAX: 15,

  // /give, /remove, /setplayer (admin): Grade hợp lệ — 1 = MAX (tốt nhất), 9 = MIN
  GRADE_MAX: 1,
  GRADE_MIN: 9,

  // -skill <tên> <số lần>: số lần roll tối đa mỗi lệnh (trừ khi skill tự định nghĩa
  // maxUses riêng thấp hơn, VD: Mook Workshop chỉ cho reuse tối đa 2 lần → maxUses: 3)
  SKILL_MAX_ROLLS: 5,
  // ❌ ĐÃ BỎ `SKILL_DICE_MOD_MAX` (Fragaria 14/08: *"Dice up đâu có giới hạn đâu
  // nhỉ, sao tôi nhập 99 lại chỉ có 20 dice up"*).
  // Trần 20 là TÔI TỰ BỊA khi thêm option — luật game KHÔNG có trần cho Dice
  // Up/Down, và không ai yêu cầu. Nhập 99 mà im lặng cắt còn 20 là sai kép: sai
  // luật, VÀ không báo cho người dùng biết đã bị cắt.
  // ⚠️ Đừng nhầm với `STATUS_CAPS_SHARED.diceup = 99` — đó là trần STACK của
  // status `diceup` trong encounter, chuyện khác hẳn với bậc dice của lệnh roll tay.
  // Số skill tối đa roll trong MỘT lệnh (Discord cho tối đa 10 embed/tin nhắn).
  SKILL_MAX_MULTI: 5,
};
