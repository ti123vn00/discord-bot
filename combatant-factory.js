// combatant-factory.js
// Hàm createCombatant (tạo data structure gốc cho MỌI combatant — player/enemy —
// khi join/addenemy) — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp tục tách
// đi". HOÀN TOÀN TỰ CHỨA về mặt LOGIC (chỉ 1 object literal rất lớn, không gọi
// hàm phức tạp nào) — chỉ cần 3 dependency đơn giản, tất cả đã định nghĩa TRƯỚC
// vị trí gốc trong index.js.
//
// normalizeWeaponWeight GIỮ NGUYÊN trong index.js (dùng độc lập ở nơi khác ngoài
// createCombatant, trong PREFIX COMMANDS) — inject vào thay vì tách theo.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ ENCOUNTER_DEFAULT_MAX_STAMINA, ENCOUNTER_DEFAULT_MAX_LIGHT, ENCOUNTER_SANITY_MAX, normalizeWeaponWeight }) {

  function createCombatant({ name, maxHp, maxStamina = ENCOUNTER_DEFAULT_MAX_STAMINA, maxLight = ENCOUNTER_DEFAULT_MAX_LIGHT, weaponWeight = "medium", weaponBaseDamage = null, weaponType = null, weaponName = null, weaponCriticalKey = null, resistance = null, speedRangeMin = 3, speedRangeMax = 6 }) {
    return {
      name,
      maxHp, currentHp: maxHp,
      maxStamina, currentStamina: maxStamina,
      maxSanity: ENCOUNTER_SANITY_MAX, currentSanity: 0,
      // baseMaxLight: giá trị GỐC, KHÔNG đổi — maxLight (effective) = baseMaxLight +
      // bonus từ Emotion Level đang active (xem EMOTION_LEVEL_TABLE.maxLightBonus),
      // tính lại mỗi khi Level thay đổi (lên/hết hạn) — xem applyEmotionDelta/
      // advanceCombatantTurn. Tách riêng để KHÔNG mất giá trị gốc khi Level hết hạn.
      baseMaxLight: maxLight, maxLight, currentLight: 0,
      weaponWeight: normalizeWeaponWeight(weaponWeight),
      // weaponBaseDamage/weaponType/weaponName — CHỈ dùng để TỰ ĐỘNG TÍNH dmgStr cho
      // nút "Đánh thường (M1)" qua dropdown/Modal (hỏi "đánh mấy lần" thay vì bắt gõ
      // tay cả công thức), VÀ để check passive vũ khí ĐẶC THÙ theo TÊN (VD Eye Of
      // Horus's "Foreclosure Task Force President") — KHÔNG ảnh hưởng gì tới lệnh
      // text -encounter attack (vẫn luôn cho gõ tay dmgStr tuỳ ý như cũ). null nếu
      // player chưa equip vũ khí nào rõ ràng (enemy luôn null — GM dùng lệnh text,
      // không cần field này).
      // weaponCriticalKey — GAP ĐÃ SỬA (xác nhận trực tiếp: "không có dropdown để sử
      // dụng critical của vũ khí") — tên skill Critical của vũ khí đã equip (dùng
      // findSkill() để tra roll thật), lấy từ weapon.criticalSkillKey nếu có field
      // RIÊNG (VD Brawler → "grappling", Eye Of Horus → "tactical suppression"),
      // fallback dùng CHÍNH TÊN vũ khí nếu KHÔNG có field (đúng quy ước game: nhiều
      // vũ khí có Critical TRÙNG TÊN, VD Durandal → Critical "Durandal"). null nếu
      // vũ khí THỰC SỰ không có Critical nào (VD Patron Librarian Baton) — check qua
      // findSkill() lúc build dropdown, không tự giả định.
      weaponBaseDamage, weaponType, weaponName, weaponCriticalKey,
      // m1CountThisTurnByTarget — đếm số lần đánh thường (M1) lên TỪNG target riêng
      // biệt TRONG TURN HIỆN TẠI (key = targetId, value = count) — dùng cho passive
      // "Foreclosure Task Force President" (Eye Of Horus) leo thang theo số lần đánh
      // lên CÙNG 1 đối tượng. Reset TOÀN BỘ mỗi endturn (xem advanceCombatantTurn).
      m1CountThisTurnByTarget: {},
      resistance: resistance ?? { B: 1, P: 1, S: 1 },
      // 7 status effect — LƯU Ý quan trọng về AI mang gì: Poise/Charge là "trên bản
      // thân" (self) — combatant này tự mang, áp dụng khi NÓ là người TẤN CÔNG.
      // Sinking/Rupture/Burn/Bleed/Tremor là "trên người địch" (enemy) — combatant này
      // mang khi NÓ là người BỊ TẤN CÔNG (target). Khi build calcOpts cho 1 action, phải
      // lấy poiseInit/chargeInit từ COMBATANT TẤN CÔNG, còn sinkingInit/ruptureInit/
      // burnInit/bleedInit/tremorInit từ COMBATANT BỊ TẤN CÔNG.
      sinking: 0, rupture: 0, poise: 0, charge: 0, burn: 0, bleed: 0, tremor: 0,
      staggered: false, staggerTurnsLeft: 0,
      panic: false, panicTurnsLeft: 0,
      // staminaUsedThisTurn: để tính Light gain ("đánh đủ 20 sta M1 trong turn → +1
      // Light turn sau") — reset về 0 mỗi lần endturn.
      staminaUsedThisTurn: 0,
      // Emotion Level — buff TẠM THỜI (xem comment đầy đủ ở EMOTION_LEVEL_TABLE phía
      // trên), KHÔNG cộng dồn vĩnh viễn. emotionLevel=0 nghĩa là KHÔNG có level active.
      // emotionLevelTurnsLeft: số turn còn lại của level ĐANG active (Infinity nếu đã
      // mở khóa Light Body — "kéo dài tới hết encounter"). emotionLevelCooldownLeft:
      // số turn còn lại của CD SAU KHI 1 level hết hạn (trong CD thì KHÔNG lên lại
      // được dù coin đủ, dù về 0).
      emotionLevel: 0, emotionCoin: 0, emotionLevelTurnsLeft: 0, emotionLevelCooldownLeft: 0,
      // unlockedPerks: COPY từ profile (data.unlockedSkillTree) lúc -encounter join —
      // KHÔNG tự khai trực tiếp ở đây nữa (đã chuyển sang -unlockskilltree, lưu vĩnh
      // viễn trên profile thay vì tạm trong encounter — xem comment ở lệnh đó).
      unlockedPerks: [],
      // buffs/debuffs: list TỰ DO (text do GM/player khai, KHÔNG tự tính/tự hết hạn) —
      // vì hiệu ứng buff quá đa dạng giữa các skill, không có cách tự động hoá an toàn.
      // Mỗi entry: { text, addedAt }. Xem -encounter buff/debuff/unbuff.
      buffs: [], debuffs: [],
      // skillCooldowns: { skillKey: số turn còn lại }. Set khi attack/hit có skill:
      // reference VÀ skill đó có cd (cooldown) > 0 theo skills.js — decrement mỗi
      // endturn, xoá khi về 0. Dùng để CHẶN spam lại skill đang cooldown.
      skillCooldowns: {},
      // ── Skill Tree tracking (xem PERK_DEFS) — các field dưới đây CHỈ phục vụ phần
      // perk TỰ ĐỘNG hoá được (dựa trên HP%/Sanity/Stamina/Poise/Charge/Rupture/Bleed/
      // Tremor/Stagger/crit/Emotion Level/M1 — hệ thống ĐÃ CÓ). Perk phụ thuộc Guard/
      // Evade/Parry/Clash/E.G.O/Shin (hệ thống CHƯA CÓ) chỉ nằm trong unlockedPerks
      // dạng ghi chú, GM tự áp dụng tay — KHÔNG có field riêng nào ở đây cho chúng.
      attacksThisTurn: 0, lastTurnAttackCount: 0, // Battle Ignition
      followUpUsedThisTurn: false, // Follow-Up/Pounce — CHUNG 1 cờ vì 2 perk loại trừ nhau + đều chỉ 1 lần/turn
      bleedFirstHitUsedThisTurn: false, // Craving Synergy/Thirst/Break the Dams — "đòn đánh ĐẦU TIÊN mỗi turn"
      breakTheDamsCdLeft: 0, // CD 3 turn riêng cho Break the Dams
      m1AttackCount: 0, // tổng M1 đã đánh (không reset theo turn) — cho Overbearing/Blessed Sparks "mỗi đòn thứ 2"
      poiseReductionPending: 0, // Smoke Overload — số Poise ĐÁNG LẼ bị giảm do crit, dồn lại chờ end turn mới trừ thật
      overchargedTurnsLeft: 0, overchargedDiceUpBonus: 0, overchargedDmgBonusPct: 0, // Overcharged Vessel
      // Manifested E.G.O — Duration = Emotion Level hiện tại × 3 turn (Lv1=3, Lv2=6,
      // suy ra Lv3=9/Lv4=12/Lv5=15 theo cùng quy luật — chỉ Lv1/2 được xác nhận trực
      // tiếp). CD 5 turn SAU KHI hết hiệu lực. -30 Sanity lúc kích hoạt. Active: +3
      // Dice Up (chỉ hiển thị, không tự áp vào roll skill — như mọi nguồn Dice Up
      // khác) + 30% Dmg M1+skill bản thân gây ra.
      manifestedEGO: false, manifestedEGOTurnsLeft: 0, manifestedEGOCooldownLeft: 0, firstManifestEGOUsed: false,
      // Chấn thương — nhận dmg >30% Max HP trong 1 đòn → roll 10% nặng/40% nhẹ/50%
      // không gì. injuries: list các chấn thương ĐANG có (có thể nhiều, KHÔNG tự hết
      // — chỉ GM xoá tay nếu chữa lành, xem -encounter healinjury). daseStacks riêng
      // (Choáng) vì cộng dồn nhiều stack mới phát huy tác dụng, khác các chấn thương
      // khác (chỉ cần CÓ là đủ).
      injuries: [], dazedStacks: 0, lastStaggerWas2Turn: false,
      // Táo (item consumable): -1 Dmg/hit nhận vào tới hết turn hiện tại — reset ở
      // advanceCombatantTurn.
      appleDmgReductionActive: false,
      // Set Fire (Page): 3 turn tự áp Burn theo weaponWeight lên target khi M1 trúng
      // — đếm ngược mỗi endturn (KHÁC appleDmgReductionActive vốn hết NGAY cuối turn
      // hiện tại — Set Fire kéo dài NHIỀU turn nên cần counter, không phải boolean).
      setFireTurnsLeft: 0,
      // ── 50-STATUS TRACKING — NHÓM 1 (quy luật đơn giản: stack + decay rõ ràng theo
      // turn) — theo yêu cầu trực tiếp: "50 status đó cũng phải tự động tracking để
      // cho giống 1 game đấy". Đây là ĐỢT ĐẦU TIÊN (status có cơ chế RÕ RÀNG NHẤT,
      // không phụ thuộc phức tạp vào hệ thống khác) — CÒN NHIỀU status phức tạp hơn
      // (6 biến thể Tremor, Gaze[Awe]/Contempt cycling, Index's Prescript, Airborne,
      // Time Moratorium, Fairy...) SẼ LÀM Ở ĐỢT SAU, không nhồi hết 1 lần để đảm bảo
      // chất lượng/test kỹ từng cái.
      fragile: 0, // +1%/stack dmg NHẬN vào, max 25, hết sau endturn
      attackPowerUp: 0, // +1 dmg/stack cho MỌI dmg gây ra, max 10, hết sau endturn
      attackPowerDown: 0, // -1 dmg/stack cho MỌI dmg gây ra, max 10, hết sau endturn
      defenseUp: 0, // +1%/stack giảm dmg của Block, max 20, hết sau endturn
      defenseDown: 0, // -5%/stack giảm dmg của Block, max 20, hết sau endturn
      clashAttackBoost: 0, // +1 điểm Clash/stack, max 8, hết sau endturn
      unopposedAttackBoost: 0, // +15% dmg nếu không bị Clash, +30% thêm nếu địch Stagger, max 5, hết sau endturn
      protection: 0, protectionTurnsLeft: 0, // -5%/stack dmg nhận vào, max 20, hết sau 2 turn (KHÁC — 2 turn, không phải 1)
      regen: 0, // 1 stack = 1 HP hồi — CHỈ mất khi ĐÃ hồi (không tự decay theo turn)
      chargeShieldStack: 0, // -10%/stack dmg nhận vào, max 20 — mất SAU MỖI LẦN bị tấn công (không theo turn)
      // ── Speed/Turn Order (update mới) — mỗi Outfit có 1 Range Speed riêng (VD 3~6),
      // roll trong range đó mỗi turn để quyết định thứ tự hành động. Haste/Bind là 2
      // status MỚI ảnh hưởng Speed (+1 Speed/Haste, -1 Speed/Bind) — chỉnh tay qua
      // -encounter haste/bind (KHÔNG qua dmgStr tag như 7 status cũ, vì chưa rõ luật
      // gain/consume chi tiết đủ để tích hợp sâu vào calcMathCore như Poise/Sinking...).
      speedRangeMin: speedRangeMin, speedRangeMax: speedRangeMax,
      haste: 0, bind: 0,
      currentSpeed: null, // null = chưa roll turn này — set bởi -encounter rollspeed
      // Guard/Evade — hành động phòng thủ CHUNG (không cần skill cụ thể), dùng TỰ DO
      // bao nhiêu lần cũng được (chỉ giới hạn bởi Stamina) — 1 charge chặn ĐƯỢC SỐ HIT
      // theo vũ khí của BÊN TẤN CÔNG M1 (Light=4 hit/charge, Medium=2, Heavy=1 — đúng
      // luật thật, xem WEAPON_DEFENSE_HITS). Ưu tiên Evade trước nếu có cả 2.
      guardCharges: 0, evadeCharges: 0,
      // parryRolls: mỗi lần dùng -encounter parry sẽ roll d20 NGAY và đẩy vào đây — 1
      // phần tử = 1 lần parry sẵn sàng, KHÔNG phải số nguyên đơn giản như guard/evade
      // (vì mỗi lần parry có kết quả roll RIÊNG, ăn/thua phụ thuộc so với roll của bên
      // tấn công lúc CONFIRM, không phải lúc declare).
      parryRolls: [],
      // Shin/Mang — hi sinh 25 Sanity/turn (CHẶN nếu Sanity hiện tại ≤ -10) để nhận
      // Shin (-0.2x mọi Res BẢN THÂN — dễ ăn dmg hơn) + Mang (+10%/+10% mỗi vòng kích
      // hoạt liên tiếp Dmg M1+skill TRONG TURN, gây True Dmg — Res mục tiêu < 1x bị
      // ép về 1x). shinMangRounds KHÔNG tự reset (giả định "vòng" = số lần kích hoạt
      // liên tiếp tự track, không tự suy ra "liên tiếp" qua nhiều turn — GM tự theo
      // dõi nếu cần đúng nghĩa "liên tiếp không gián đoạn").
      shinMangActive: false, shinMangRounds: 0, shinMangUsedThisTurn: false,
      // ── Consumable Item (luật: "1 trận chỉ có thể mang 4 item hồi phục vào, và
      // mỗi turn chỉ được sử dụng một lần"). consumablesLoadout: list tên item ĐÃ
      // MANG vào trận (tối đa 4, khai qua -encounter additem, trừ THẬT khi dùng qua
      // -encounter useitem — chưa trừ lúc mang vào, chỉ "đăng ký" sẽ dùng). Hiệu ứng
      // hồi phục CỤ THỂ (hồi bao nhiêu HP) KHÔNG được luật định nghĩa rõ — GM tự
      // quyết định/narrate lúc dùng, hệ thống chỉ enforce đúng giới hạn 4 mang + 1
      // dùng/turn + trừ thật khỏi inventory profile.
      consumablesLoadout: [], usedItemThisTurn: false,
      // Voracity (Desire, [30 Points]): thắng Clash +2 Light — CHỈ 1 lần/turn.
      voracityUsedThisTurn: false,
      // Tip-Toe Around (Wrath, [25 Points]): cờ chờ — Parry thành công → đòn tấn
      // công KẾ TIẾP +10% Dmg (tiêu thụ ở computeAttackerPerkContext).
      tipToeBonusPending: false,
    };
  }

  return { createCombatant };
};
