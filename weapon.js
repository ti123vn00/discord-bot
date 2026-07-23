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
      { name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" },
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
  "patron librarian baton": {
    name: "Patron Librarian Baton",
    weight: "light",
    type: "Blunt",
    baseDamage: 6,
    passives: [],
    // KHÔNG có Critical nào trong skills.js cho vũ khí này (đã rà soát kỹ — chỉ có
    // 9 Page riêng: Alleyway Counter/Thrust/Onslaught Command/Charge and Cover/
    // Focused Strikes/Light Dash/Dodge and Strike/You're too slow/Light attack,
    // không có entry weaponOf:"Patron Librarian Baton" nào) — để trống
    // criticalSkillKey, không bịa ra Critical không tồn tại.
  },
  "brawler": {
    name: "Brawler",
    weight: "light",
    type: "Blunt",
    baseDamage: 5,
    passives: [],
    // Critical "Grappling" ĐÃ CÓ trong skills.js (key "grappling", weaponOf:
    // "Brawler") — roll qua `-skill grappling`. Có passive [Hakuda] gắn liền trong
    // chính text roll của Grappling ("Nếu xài Critical sau khi xài skill có tag
    // Airborne: dice đổi thành [14~30]") — KHÔNG tự động hoá được (phụ thuộc việc
    // "vừa mới xài skill có tag Airborne" trước đó trong cùng turn, hệ thống hiện
    // tại không track tag "Airborne" của lần roll skill gần nhất) — GM tự áp dụng.
    criticalSkillKey: "grappling",
  },
  "eye of horus": {
    name: "Eye Of Horus",
    weight: "heavy",
    type: "Pierce",
    // "3x9" theo mô tả gốc: 1 LẦN BẮN (1 lượt M1) tự động ra 9 hit, mỗi hit 3 dmg
    // (tổng 27 dmg raw/lượt bắn) — baseDamage lưu ở đây là dmg MỖI HIT (3), người
    // dùng nút "Đánh mấy lần" trong encounter nên nhập THEO BỘI SỐ CỦA 9 (VD "9"
    // cho 1 lần bắn trọn vẹn = 27 dmg, "18" cho 2 lần bắn = 54 dmg) — hệ thống
    // KHÔNG tự ép bội số 9, GM/player tự áp đúng quy ước vũ khí này khi nhập.
    baseDamage: 3,
    passives: [
      {
        name: "Foreclosure Task Force President",
        desc:
          "Trong 1 turn khi tấn công 1 đối tượng, nếu đánh thường: 1 lần → bắn thêm 1 Repeat Ammo, gây sát thương chuẩn. " +
          "Dưới hoặc bằng 3 lần → +50% sát thương. Dưới hoặc bằng 6 lần → Base dmg nâng lên 4x9. " +
          "Mỗi lần đánh thường: gắn 2 Tremor + 2 Charge lên bản thân. " +
          "[KHÔNG TỰ ĐỘNG HOÁ — leo thang theo SỐ LẦN đánh thường TRONG 1 TURN lên CÙNG 1 đối tượng, hệ thống hiện không track " +
          "counter dạng này; GM/player tự cộng % dmg + đổi base dmg + gắn Tremor/Charge bằng tay theo đúng mốc.]",
      },
      {
        name: "Ammo: 8",
        desc:
          "[KHÔNG TỰ ĐỘNG HOÁ — không có hệ thống \"đạn\"/reload trong bot, tương tự Light/Stamina/Sanity/Charge. " +
          "GM/player tự đếm 8 lượt bắn rồi tự narrate hết đạn/reload theo ý đồ riêng của bàn chơi.]",
      },
    ],
    // Critical "Tactical Suppression" — có trong skills.js (key "tactical
    // suppression", weaponOf: "Eye Of Horus") — LƯU Ý: bản chất là kích hoạt
    // trạng thái Shield 2-turn phức tạp, KHÔNG phải 1 lần roll dmg đơn thuần — xem
    // đầy đủ comment ở entry skills.js tương ứng.
    criticalSkillKey: "tactical suppression",
  },
  // ── Black Silence (Book of The Black Silence) — TẤT CẢ chia sẻ passive "Orlando
  // Furioso": Critical dùng NGAY không tốn CD khi vũ khí được swap qua giữa trận
  // (-encounter swapweapon) — KHÔNG TỰ ĐỘNG HOÁ (hệ thống không track "vừa mới
  // swap qua lúc nào" để miễn CD lần đầu — GM/player tự áp dụng bằng tay).
  "mook workshop": {
    name: "Mook Workshop", weight: "medium", type: "Slash", baseDamage: 13,
    passives: [{ name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" }],
    criticalSkillKey: "mook workshop",
  },
  "crystal atelier": {
    name: "Crystal Atelier", weight: "medium", type: "Slash", baseDamage: 15,
    passives: [{ name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" }],
    criticalSkillKey: "crystal atelier",
  },
  "zelkova workshop": {
    name: "Zelkova Workshop", weight: "heavy", type: "Blunt", baseDamage: 27,
    passives: [{ name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" }],
    criticalSkillKey: "zelkova workshop",
  },
  "old boys workshop": {
    name: "Old Boys Workshop", weight: "light", type: "Blunt", baseDamage: 6,
    passives: [{ name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" }],
    criticalSkillKey: "old boys workshop",
  },
  "allas workshop": {
    name: "Allas Workshop", weight: "medium", type: "Pierce", baseDamage: 15,
    passives: [{ name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" }],
    criticalSkillKey: "allas workshop",
  },
  "ranga workshop": {
    name: "Ranga Workshop", weight: "light", type: "Pierce", baseDamage: 6,
    passives: [{ name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" }],
    criticalSkillKey: "ranga workshop",
  },
  "fused blade of ruined mirror worlds": {
    name: "Fused Blade of Ruined Mirror Worlds", weight: "heavy", type: "Slash", baseDamage: 28,
    passives: [{
      name: "Dullahan",
      desc: "Parry của bạn khi sử dụng sẽ khiến bạn đánh thường lên người kẻ địch. Vào turn kế sau khi bạn Parry bạn sẽ nhận được 1 Stack Dullahan và giảm bản thân 15 Sanity. Khi có Dullahan bạn nhận được 30% Dmg gây ra và giảm 15% Dmg Reduction; đồng thời mỗi turn end bạn sẽ mất (15 - số Coffin hiện tại trên bản thân) Sanity. Khi dưới -15 Sanity, mỗi turn end bạn sẽ nhận được thêm 1 Stack Dullahan. [KHÔNG TỰ ĐỘNG HOÁ — cơ chế Dullahan/Coffin quá đặc thù, GM/player tự quản lý.]",
    }],
    criticalSkillKey: "requiem",
  },
  "zweihander": {
    name: "Zweihander", weight: "heavy", type: "Slash", baseDamage: 25,
    passives: [{ name: "Your Shield", desc: "Bạn sẽ có khả năng block đòn thay cho một đồng đội duy nhất trong turn. [KHÔNG TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "patrolling",
  },
  "mimicry blade": {
    name: "Mimicry Blade", weight: "medium", type: "Slash", baseDamage: 14,
    passives: [{ name: "The Imitation", mechanicId: "mimicry_imitation", desc: "Mỗi 1 Imitation đã tiêu thụ sẽ gia tăng cho bạn 5% Dmg Bonus [Max: 50%]. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "upstanding slash",
  },
  "augury spear": {
    name: "Augury Spear", weight: "light", type: "Pierce", baseDamage: 6,
    passives: [{ name: "Rotate Trigram", desc: "Vào đầu mỗi turn start bạn nhận được các buff theo thứ tự sau Geon -> Gon -> Gam -> Ri -> lặp lại. [KHÔNG TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "unyielding strike",
  },
  "kurokumo katana": {
    name: "Kurokumo Katana", weight: "medium", type: "Slash", baseDamage: 12,
    passives: [{ name: "Dark Cloud", desc: "Page của Kurokumo Syndicate gây thêm +2 Bleed. [KHÔNG TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "thundercleaver",
  },
  "shi association katana": {
    name: "Shi Association Katana", weight: "medium", type: "Slash", baseDamage: 12,
    passives: [{ name: "Shi", mechanicId: "shi_poise", desc: "4 đòn đánh thường sẽ nhận 4 Poise. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "overbreath",
  },
  "liu martial arts": {
    name: "Liu Martial Arts", weight: "light", type: "Pierce", baseDamage: 5.5,
    passives: [{ name: "Fire", mechanicId: "fire_burn", desc: "2 đòn đánh thường sẽ gắn 1 Burn lên kẻ thù. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "violent flame",
  },
  "liu guan dao": {
    name: "Liu Guan Dao", weight: "medium", type: "Slash", baseDamage: 12,
    passives: [{ name: "Fire", mechanicId: "fire_burn", desc: "2 đòn đánh thường sẽ gắn 1 Burn lên kẻ thù. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "forming storm",
  },
  "dieci association kata": {
    name: "Dieci Association Kata", weight: "light", type: "Blunt", baseDamage: 5,
    passives: [{ name: "Knowledge", mechanicId: "knowledge_sanity", desc: "Mỗi lần sử dụng Critical sẽ hồi cho bản thân 5 Sanity. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "excruciating study",
  },
  "dieci association key": {
    name: "Dieci Association Key", weight: "medium", type: "Blunt", baseDamage: 11,
    passives: [{ name: "Knowledge", mechanicId: "knowledge_sanity", desc: "Mỗi lần sử dụng Critical sẽ hồi cho bản thân 5 Sanity. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "unveil",
  },
  "soldato rifle": {
    name: "Soldato Rifle", weight: "medium", type: "Slash", baseDamage: 12,
    passives: [{ name: "Firing", desc: "Có thể tiêu stack đạn có trong người để đòn đánh thường chuyển qua dmg Pierce và +4 Base Dmg. Vũ khí này có max 8 viên đạn một lượt. [KHÔNG TỰ ĐỘNG HOÁ — hệ thống Ammo không được track.]" }],
    criticalSkillKey: "bayonet combat",
  },
  "atelier logic": {
    name: "Atelier Logic", weight: "heavy", type: "Blunt", baseDamage: 26,
    passives: [{ name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" }, {
      name: "2 dạng vũ khí",
      desc: "Vũ khí có 2 form: Shotgun (Heavy/Blunt/26, metadata mặc định ở đây) và Pistols (Light/Pierce/6.5) — GM/player tự chọn form đang dùng khi tính M1, hệ thống chỉ lưu 1 baseDamage cố định (form Shotgun). Critical Pistols: roll qua `-skill atelier logic pistols` riêng.",
    }],
    criticalSkillKey: "atelier logic shotgun",
  },
  "wheel's industry": {
    name: "Wheel's Industry", weight: "heavy", type: "Blunt", baseDamage: 30,
    passives: [{ name: "Orlando Furioso", mechanicId: "orlando_furioso", desc: "Cho phép sử dụng Critical ngay lập tức mà không tốn CD của vũ khí khi vũ khí này được swap qua. [ĐÃ TỰ ĐỘNG HOÁ — xem orlandoFuriosoBypass trong combatant.]" }],
    criticalSkillKey: "wheels industry",
  },
  "chains of loyalty": {
    name: "Chains of Loyalty", weight: "light", type: "Blunt", baseDamage: 5,
    passives: [{ name: "Payback", mechanicId: "payback_reflect", desc: "Mỗi 1 Turn, đòn tấn công đầu tiên bạn chịu từ kẻ thù sẽ phản 1/2 Dmg về cho chúng với Dmg Type là Blunt. Đồng thời gây cho chúng 5 Fragile và 1 Vengeance Mark. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "promised suffering",
  },
  "seven association longsword": {
    name: "Seven Association Longsword", weight: "medium", type: "Slash", baseDamage: 12,
    passives: [{ name: "Grasping Vulnerabilities", mechanicId: "grasping_vulnerabilities", desc: "Mỗi 2 đòn đánh thường của bạn sẽ gây 1 Rupture lên người kẻ địch. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "moulinet",
  },
  "udjat khopesh": {
    name: "Udjat Khopesh", weight: "medium", type: "Slash", baseDamage: 13,
    passives: [{ name: "The Udjat", desc: "Mỗi 1 Protection bạn có trên người, gia tăng 1% Dmg Bonus. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "the udjat",
  },
  "warp corp. dagger": {
    name: "WARP Corp. Dagger", weight: "light", type: "Pierce", baseDamage: 6,
    passives: [{ name: "Charging", mechanicId: "warp_charging", desc: "Mỗi 4 đòn đánh thường bạn sẽ nhận được 1 Charge. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "dimensional rift dagger",
  },
  "warp corp. gauntlets": {
    name: "WARP Corp. Gauntlets", weight: "light", type: "Blunt", baseDamage: 6.5,
    passives: [{ name: "Charging", mechanicId: "warp_charging", desc: "Mỗi 4 đòn đánh thường bạn sẽ nhận được 1 Charge. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "dimensional rift gauntlets",
  },
  "l'heure du loup": {
    name: "L'Heure du Loup", weight: "light", type: "Blunt", baseDamage: 5,
    passives: [{ name: "Blue Reverberation Ensemble", mechanicId: "blue_reverberation", desc: "4 đòn đánh thường sẽ gắn lên kẻ thù 1 Tremor. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "beatdown",
  },
  "yesterday's promise": {
    name: "Yesterday's Promise", weight: "light", type: "Pierce", baseDamage: 5,
    passives: [{ name: "Blue Reverberation Ensemble", mechanicId: "blue_reverberation", desc: "4 đòn đánh thường sẽ gắn lên kẻ thù 1 Tremor. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "magic impact",
  },
  "reverberation scythe": {
    name: "Reverberation Scythe", weight: "medium", type: "Slash", baseDamage: 10,
    passives: [{ name: "Blue Reverberation Ensemble Leader", mechanicId: "blue_reverberation_leader", desc: "Mỗi lần sử dụng Critical sẽ nhận 5 Sanity đồng thời 3 đòn đánh thường sẽ gắn lên kẻ thù 1 Tremor. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "resonate",
  },
  "the crying children": {
    name: "The Crying Children", weight: "medium", type: "Blunt", baseDamage: 14,
    passives: [{ name: "Philip", desc: "Khi bản thân đạt được Emotional Level 1 sẽ nhận được 2 Dice Up, nếu Emotional Level 2 sẽ nhận được 4 Dice Up. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "scorching desperation",
  },
  "viriscent pyrojade ring": {
    name: "Viriscent Pyrojade Ring", weight: "light", type: "Pierce", baseDamage: 5,
    passives: [{ name: "Speed", mechanicId: "warp_speed_haste", desc: "4 đòn đánh thường sẽ nhận 1 Haste. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "viriscent pyrojade violet",
  },
  "cinq rapier": {
    name: "Cinq Rapier", weight: "light", type: "Pierce", baseDamage: 5,
    passives: [{ name: "Speed", mechanicId: "warp_speed_haste", desc: "4 đòn đánh thường sẽ nhận 1 Haste. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "murche defensive",
  },
  "index cleaver": {
    name: "Index Cleaver", weight: "heavy", type: "Slash", baseDamage: 20,
    passives: [{ name: "Will of Prescript", desc: "Vào đầu mỗi turn bạn sẽ gắn random 1 kẻ địch trên sân hiệu ứng <:The_Prescripts_Target:1528452363159998525>The Prescript Target's - The Index. Ứng với mỗi 1 Grace of the Prescript của bản thân thì bạn sẽ tăng thêm 5% Dmg lên kẻ địch có hiệu ứng đó. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "decapitation",
  },
  "index longsword": {
    name: "Index Longsword", weight: "medium", type: "Slash", baseDamage: 10,
    passives: [{ name: "Will of Prescript", desc: "Vào đầu mỗi turn bạn sẽ gắn random 1 kẻ địch trên sân hiệu ứng <:The_Prescripts_Target:1528452363159998525>The Prescript Target's - The Index. Ứng với mỗi 1 Grace of the Prescript của bản thân thì bạn sẽ tăng thêm 5% Dmg lên kẻ địch có hiệu ứng đó. [ĐÃ TỰ ĐỘNG HOÁ.]" }],
    criticalSkillKey: "eliminate",
  },
  // Pointillist Brush — cũng ĐÃ có Critical "Sanguine Pointilism" sẵn trong
  // skills.js (chỉ thiếu metadata, giống toàn bộ 25 vũ khí phía trên).
  "pointillist brush": {
    name: "Pointillist Brush", weight: "medium", type: "Pierce", baseDamage: 11,
    passives: [{ name: "Art", desc: "Với mỗi 5 Bleed lên kẻ thù khi sử dụng Critical sẽ tăng 20% Reuse [tối đa Reuse 2 lần] [Mặc định có 40% Reuse]. [KHÔNG TỰ ĐỘNG HOÁ — % Reuse ngẫu nhiên cần GM/player tự roll.]" }],
    criticalSkillKey: "sanguine pointilism",
  },
};

/** findWeapon — tra theo key chuẩn hoá hoặc tên hiển thị (case-insensitive), giống
 *  pattern findSkill ở skills.js. */
function findWeapon(raw) {
  // Strip dấu " thừa ở đầu/cuối (item name đôi khi lưu KÈM dấu ngoặc kép do copy từ
  // text có định dạng markdown, VD từ inventory) — để cả 2 cách gõ (có/không ngoặc)
  // đều match đúng.
  const key = (raw ?? "").toLowerCase().trim().replace(/^["']+|["']+$/g, "").trim();
  if (WEAPONS[key]) return WEAPONS[key];
  for (const w of Object.values(WEAPONS)) {
    if (w.name.toLowerCase() === key) return w;
  }
  return null;
}

module.exports = { WEAPONS, findWeapon, WD1, WD2, WD3, WD4, WD5, WD6, WD7, WD8, WD9, SLASH, PIERCE, BLUNT, DICEUP, BLEED, POISE };