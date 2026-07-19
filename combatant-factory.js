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

  function createCombatant({ name, maxHp, maxStamina = ENCOUNTER_DEFAULT_MAX_STAMINA, maxLight = ENCOUNTER_DEFAULT_MAX_LIGHT, weaponWeight = "medium", weaponBaseDamage = null, weaponType = null, weaponName = null, weaponCriticalKey = null, equippedOutfit = null, resistance = null, speedRangeMin = 3, speedRangeMax = 6 }) {
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
      // equippedOutfit — GAP NGHIÊM TRỌNG ĐÃ SỬA: trước đây createCombatant()
      // KHÔNG nhận tham số này (destructuring silently bỏ qua field lạ) dù
      // index.js CÓ truyền vào lúc join — khiến MỌI check
      // "attacker.combatant.equippedOutfit === ..." (Dark Cloud/Kurokumo
      // Wakashu, Thumb Capo IIII...) LUÔN undefined/false. Phát hiện qua test
      // join THẬT (không phải gán tay state trực tiếp).
      equippedOutfit,
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
      // eyeOfHorusAmmo — GAP ĐÃ SỬA (xác nhận trực tiếp): "Ammo có sẵn của Eye
      // of Horus là 8... về 0 thì không thể M1 trong turn đó nữa mà phải đợi
      // hết turn thì reset về 8... nó không phải là ammo thông thường trong
      // inventory" — pool NỘI TẠI riêng của vũ khí (KHÔNG liên quan gì tới
      // ammo/frostAmmo/incendiaryAmmo reload từ inventory), mỗi volley (9 hit)
      // tốn 1 điểm, reset về 8 mỗi khi hết turn (advanceCombatantTurn).
      eyeOfHorusAmmo: 8,
      // eyeOfHorusReloadPending — GAP ĐÃ SỬA (xác nhận trực tiếp): track "đã chịu
      // 1 turn ở mức 0 ammo chưa" — reset về 8 chỉ xảy ra ở turn-end THỨ 2 kể từ
      // lúc hết ammo, không phải turn-end đầu tiên (xem turn-advance.js).
      eyeOfHorusReloadPending: false,
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "tự động hóa mọi thứ đừng có nhìn note
      // nữa... quy trình quá phức tạp, cần xử lý tự động để đỡ tốn thời gian")
      // — TOÀN BỘ hệ thống Index Proselyte (roll 1-7 đầu turn, track có làm ĐÚNG
      // sắc lệnh không) + Will of Prescript (Index Longsword/Cleaver). Track 5
      // loại hành động RIÊNG BIỆT trong turn hiện tại, reset mỗi khi có roll mới.
      prescriptRoll: null, // 1-7, sắc lệnh của turn HIỆN TẠI (null = chưa có/không có outfit)
      prescriptAttacked: false,
      prescriptEvaded: false,
      prescriptBlocked: false,
      prescriptParried: false,
      prescriptClashed: false,
      graceOfPrescript: 0, // PERSISTENT (không reset theo turn) — dùng cho Will of Prescript's %Dmg
      karmicConsequence: 0, // PERSISTENT, max 100 — +1%Dmg/stack (Index Proselyte tự áp lên bản thân)
      prescriptTargetId: null, // Will of Prescript — enemy đang bị đánh dấu "The Prescript Target's - The Index"
      // bulletStack — GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) —
      // "Firing" (Soldato Rifle) + "Thumb Soldato" (outfit, mỗi đòn đánh thường
      // thứ 4 → +1 đạn). Max 8, tiêu để +4 Base Dmg/hit (usebullet: yes khi M1).
      bulletStack: 0,
      // "Cinq Association": accumulator riêng cho "2 Haste/20 Stamina qua M1".
      cinqAssociationAccumulator: 0,
      // "Dieci Association": Shield HP (resource riêng, KHÔNG phải HP thường) +
      // accumulator cho "2 Sinking + 4 Shield HP mỗi 20 Stamina qua M1".
      shieldHp: 0,
      dieciAssociationAccumulator: 0,
      // GM panel — chỉnh sửa tự do (xác nhận trực tiếp: "toàn bộ tất cả chỉ
      // số... dmg bonus, dmg reduction") — 2 field override thủ công, CỘNG
      // THÊM vào bonusPct/reductionPct tính toán bình thường (không thay thế).
      gmBonusPctOverride: 0,
      gmReductionPctOverride: 0,
      // Note tự do (xác nhận trực tiếp: "1 phần để thêm note lên chỗ status
      // của player hoặc boss/mob phòng trong các status đặc biệt mà chưa kịp
      // implement vào code") — hiển thị trong buildEncounterBoardEmbed.
      gmNote: "",
      // "Your Shield" (Zweihander passive): "khả năng block đòn thay cho MỘT
      // đồng đội DUY NHẤT trong turn" — reset mỗi turn advance (xem
      // turn-advance.js), giống hasIronHorus/diceUp pattern đã có.
      yourShieldUsedThisTurn: false,
      // "Rotate Trigram" (Augury Spear passive) — cycle Geon→Gon→Gam→Ri mỗi
      // turn start (0=Geon, 1=Gon, 2=Gam, 3=Ri), rotateTrigramRiPending chờ
      // áp dụng vào đòn M1 ĐẦU TIÊN sau khi rơi vào "Ri".
      rotateTrigramIndex: 0,
      rotateTrigramRiPending: false,
      // "Dullahan"/"Coffin" (Fused Blade of Ruined Mirror Worlds passive) —
      // xác nhận trực tiếp: Coffin tích từ dùng Smackdown/Memorial
      // Procession/Beheading/Greatsword Rend (khi có trang bị Fused Blade).
      dullahanStacks: 0,
      coffinStacks: 0,
      // "Dark Cloud" (Kurokumo Wakashu OUTFIT passive — KHÁC HOÀN TOÀN "Dark
      // Cloud" của Kurokumo Katana WEAPON, xác nhận trực tiếp: "2 passive khác
      // nhau nhưng cùng tên") — stack từ dùng Page Kurokumo Syndicate, decay
      // 2/turn, 3+ stack +25% Bleed dmg, 6+ stack "nổ" Bleed dmg mỗi 20 Sta
      // tiêu qua M1 (accumulator riêng, không dùng chung staminaUsedThisTurn).
      darkCloudOutfitStacks: 0,
      darkCloudOutfitStaminaAccumulator: 0,
      // "Scorch Propellant Round" (Thumb Syndicate ammo — Savage Double/Triple
      // Slash, Blasting Shatterslash, Tanglecleaver Flurry) — xác nhận trực
      // tiếp: cap 20, "hiện tại chỉ nhận được thông qua sử dụng page chứ
      // không phải nạp từ nguồn ngoài" — bắt đầu từ 0.
      scorchPropellantRound: 0,
      // "Tigermark Round"/"Savage Tigermark Round" (Tiantui Star's Blade
      // weapon) — nạp qua Tanglecleaver Reload, chuyển hoá thành Savage khi
      // dùng Reload lúc đang có Shin (shinMangActive) active.
      tigermarkRound: 0,
      savageTigermarkRound: 0,
      // "Tactical Suppression" (Eye Of Horus Critical) — xác nhận trực tiếp:
      // "50 HP Shield x Số lượng người trên sân trong 2 Turn. Heal lại lượng
      // máu = Lượng HP Shield hao hụt sau 2 turn... Nếu Block trong trạng thái
      // này... Nếu đánh thường trong trạng thái này...". CD "3 Turn SAU KHI
      // HẾT Shield HP" — khác CD thông thường (bắt đầu ngay lúc dùng), cần
      // track riêng (cdPending chỉ bắt đầu đếm khi shieldHp về 0).
      tacticalSuppressionActive: false,
      tacticalSuppressionTurnsLeft: 0,
      tacticalSuppressionShieldGranted: 0,
      tacticalSuppressionCdPending: false,
      tacticalSuppressionCdTurnsLeft: 0,
      dullahanParriedThisTurn: false, // "vào turn KẾ SAU khi Parry" — cần biết đã Parry ở turn TRƯỚC chưa
      // "Zwei Association" — flag chờ áp Tremor thật (xem comment đầy đủ ở
      // resolveOnePendingAction, tránh bị ghi đè bởi t.preview.finalTremor).
      zweiAssociationPendingTremor: false,
      // "Hana Association": track HP mất TRONG turn hiện tại (reset mỗi turn,
      // cùng cơ chế với diceUp) để tính "+1 Dice Up mỗi 10 HP mất".
      hpLostThisTurn: 0,
      // "Light Dash" (Page): lượt né MIỄN PHÍ (0 Sta), tách biệt hoàn toàn với
      // evadeCharges thường (mua bằng Stamina) — xem comment đầy đủ ở nơi dùng.
      lightDashFreeEvadeCharges: 0,
      // "Waltz In White"/"Waltz In Black": track round-based (không phải turn
      // riêng của ai) trên TARGET — xem comment đầy đủ ở attacker-perk-context.js.
      waltzInWhiteHitThisRound: false,
      waltzInWhiteHitLastRound: false,
      // ironHorusGuardActiveThisTurn — GAP ĐÃ SỬA (xác nhận trực tiếp): "bấm
      // Guard 1 lần trong turn thì cứ mặc định là guard sẵn trong turn đó do
      // charge Guard của nó không thể bị giảm được nên phải khóa lại nút guard"
      // — Iron Horus (Abydos's Uniform) vốn đã "che 100%, charge không tụt",
      // nhưng trước đây vẫn bắt bấm Guard + trả 40 Sta MỖI LẦN bị tấn công. Giờ
      // chỉ cần bấm 1 lần (trả 40 Sta 1 lần) — các đòn tấn công SAU trong CÙNG
      // turn tự động Guard miễn phí, không cần hỏi lại.
      ironHorusGuardActiveThisTurn: false,
      // orlandoFuriosoBypass — GAP ĐÃ SỬA (xác nhận trực tiếp, dự án tự động hoá
      // toàn bộ weapon/outfit): "Orlando Furioso" (8 vũ khí Black Silence) — swap
      // qua vũ khí này → Critical NGAY SAU đó miễn phí CD (dùng 1 lần, tiêu ngay
      // sau khi dùng). Trước đây chỉ là text mô tả, không hề tự động — giờ track
      // qua field này, set true lúc equipweapon, tiêu thụ lúc dùng Critical.
      orlandoFuriosoBypass: false,
      // paybackUsedThisTurn — GAP ĐÃ SỬA (dự án tự động hoá, batch 3): "Payback"
      // (Chains of Loyalty) — chỉ đòn tấn công ĐẦU TIÊN mỗi turn mới phản dmg,
      // reset về false mỗi khi hết turn.
      paybackUsedThisTurn: false,
      // imitation/imitationConsumedTotal — GAP ĐÃ SỬA (dự án tự động hoá, batch
      // 4): "The Imitation" (Mimicry Blade) — imitation là stack HIỆN CÓ (nhận
      // từ Upstanding Slash, tiêu bởi Great Split); imitationConsumedTotal là
      // TỔNG đã tiêu (không bao giờ giảm, dùng để tính % Dmg Bonus vĩnh viễn).
      imitation: 0,
      imitationConsumedTotal: 0,
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
    // — 50-STATUS NHÓM 2 (bắt đầu, xác nhận trực tiếp từng cái) —
    // Paralyze: mỗi lần dùng 1 skill (không phải M1) sẽ bị ép 100% Min Dice, SAU
    // đó giảm 1 count — xử lý ở resolveSkillVerification (skill-verification.js).
    paralyze: 0,
    // Dice Up/Down (Value Power Up/Down): "+1/-1 Dice. Biến mất sau End Turn" —
    // cộng/trừ TRỰC TIẾP vào MỌI roll skill (side-channel diceModifier ở skills.js,
    // qua resolveSkillVerification) — reset về 0 mỗi endturn (turn-advance.js).
    diceUp: 0, diceDown: 0,
    // Smoke: "+2,5%/stack sát thương từ ĐÁNH THƯỜNG vào bản thân (Max 15). Sau mỗi
    // 1 turn mất 1 stack" — áp dụng ở doPlayerAttack/doEnemyAttack (M1 only, không
    // phải skill) khi combatant này là TARGET bị M1 đánh — decay -1/turn (KHÔNG
    // reset về 0 như Nhóm 1, chỉ giảm dần).
    smoke: 0,
    // Vengeance Mark: "+5%/stack dmg từ skill của The Middle [Max 10]" — chỉ áp
    // khi hit đến từ 1 skill thuộc "The Middle" (Middle Syndicate Book / The
    // Middle Big Brother Book — xem MIDDLE_SYNDICATE_SKILLS ở skill-tree.js).
    vengeanceMark: 0,
    // Airborne: "hất tung — kẻ địch bị hất tung nhận 10 Dmg vào End Turn. Biến
    // mất sau End Turn hoặc sau bị dính đòn có condition Airborne" — flag đơn
    // giản (không stack).
    airborne: false,
    // Borrowed Time: "2 Haste và 1 Attack Power Up MỖI TURN (max 2 [stack Borrowed
    // Time]) tồn tại 3 turn" — borrowedTime = số stack Borrowed Time (không phải
    // Haste/AtkUp trực tiếp), mỗi turn CÒN active tự cộng thêm 2 Haste + 1
    // AttackPowerUp (xem turn-advance.js).
    borrowedTime: 0, borrowedTimeTurnsLeft: 0,
    // Fairy: "trừ HP = count/3 MỖI Action (Max 30) [biến mất khi hiệu lực đủ 2
    // Turn]" — giả định "mỗi Action" = mỗi lần CHÍNH người mang Fairy hành động
    // (M1/skill) — xử lý ở doPlayerAttack/doPlayerHit/doEnemyAttack khi ATTACKER
    // (không phải target) có Fairy.
    fairy: 0, fairyTurnsLeft: 0,
    // Chains: "skill TIẾP THEO của kẻ thù +1 Light để dùng (1 Turn)" — flag đơn
    // giản, tiêu thụ NGAY khi dùng 1 skill (bất kể còn turn hay không), hoặc hết
    // sau 1 turn nếu chưa dùng skill nào.
    chains: false, chainsTurnsLeft: 0,
    // Sizzling Wound: "+50% Dmg từ Burn và Bleed" — flag đơn giản (không thấy nêu
    // stack/max trong bản mô tả gốc — coi là boolean có/không).
    sizzlingWound: false,
    // Mặt nạ chống nhận thức (PerceptionBlockingMask): "đòn tấn công CUỐI CÙNG ở
    // mỗi turn thành [Undodgeable][Unparriable][Unblockable][Unclashable]" — flag
    // — người chơi tự đánh dấu hành động nào là "cuối turn" qua tham số riêng
    // (lastAction: true) vì hệ thống không tự biết trước thứ tự hành động.
    perceptionBlockingMask: false,
    // BlackSilence (Struggling): "giảm mọi Light Cost của Page đi 1 (không về 0)
    // và +4 Dice Up cho Critical vũ khí" — flag.
    blackSilence: false,
    // Nails: "mỗi đòn kẻ thù NHẬN sẽ nhận thêm Bleed = count Nails, mỗi lần nhận 1
    // đòn giảm 1/3 count Nails" — áp dụng khi combatant này là TARGET bị tấn công.
    nails: 0,
    // Red Plum Blossom: "trên kẻ địch, NGƯỜI TẤN CÔNG +10% Crit và +1 Bleed/Crit
    // lên kẻ địch đó, nếu Crit thì giảm 1 Count" — đặt trên TARGET nhưng ảnh
    // hưởng tới ATTACKER đang tấn công target đó.
    redPlumBlossom: 0,
    // Freeble: "giảm GIÁ TRỊ dice (không phải số lượng dice) = count, của MỌI
    // skill trong turn của kẻ địch [Max 5, mỗi turn trừ 1 nửa, dưới 1 thì hết]
    // [dice không thể dưới 1]" — dùng CHUNG side-channel diceModifier (âm) với
    // Dice Up/Down, nhưng KHÔNG reset theo turn như Dice Down — decay /2 riêng.
    freeble: 0,
    // 6 biến thể Tremor + Spectro Frazzle (50-Status Nhóm 2, xác nhận trực tiếp
    // từng cái từ tài liệu gốc) — 5 cái đầu đặt TRÊN NGƯỜI BỊ Tremor Burst kích
    // hoạt lên (ảnh hưởng tới CHÍNH họ khi bị burst), xử lý trong calcMathCore
    // (damage-calc.js) — xem comment đầy đủ ở đó.
    tremorEverlasting: 0, tremorFracture: 0, tremorReverb: 0, tremorDecay: 0, tremorChain: 0,
    // Scorch/Hemorrhage: "Khi kích hoạt Tremor Burst, gây dmg = (Tremor+Burn hoặc
    // Bleed)/2" — đặt TRÊN NGƯỜI TẤN CÔNG (attacker gây Tremor Burst), không phải
    // target — boolean vì bản mô tả gốc không nêu stack/max.
    tremorScorch: false, tremorHemorrhage: false,
    // Spectro Frazzle: "Unique Tremor, giảm Stamina TRỰC TIẾP không cần Tremor
    // Burst. Mỗi 1 stack giảm 10 Sta + 1 Bind. Nếu địch Stagger/0 Sta thì lưu
    // phần thừa, nhân đôi, giảm khi hồi lại Stamina. Max 10" — ĐẶT TRÊN TARGET
    // (kẻ mang Spectro Frazzle là kẻ BỊ giảm Stamina) — spectroFrazzlePendingLoss
    // lưu phần Sta "nợ" (đã nhân đôi) chờ áp khi combatant hồi Stamina trở lại.
    spectroFrazzle: 0, spectroFrazzlePendingLoss: 0,
    // Gaze[Awe]/Contempt (50-Status Nhóm 2, xác nhận trực tiếp) — GẮN LÊN TARGET
    // bởi 1 attacker CỤ THỂ ("kẻ đã gắn nó") — mutual +10%/-50% dmg CHỈ giữa target
    // và ĐÚNG attacker đó (không áp dụng với ai khác). sourceId lưu định danh
    // (playerId hoặc enemyKey) của người đã gắn.
    gazeAwe: 0, gazeAweSourceId: null,
    contempt: 0, contemptSourceId: null,
    // Gaze of Contempt/Contempt of the Gaze — SELF-buff/debuff, KHÔNG gắn với đối
    // tượng cụ thể nào (khác 2 cái trên) — +7%/stack Dmg Up chung, hoặc -70% dmg
    // nhận+gây khi chuyển hoá.
    gazeOfContempt: 0,
    contemptOfTheGaze: false,
    // Haou tier (50-Status Nhóm 2, xác nhận trực tiếp) — 5 status "siêu cấp",
    // TRÊN TARGET (kẻ bị áp), Max 99 mỗi cái:
    // Flame: x10 dmg count vào end turn, sau đó /2 (floor, về 0 khi <1).
    // Bleed: dmg = count mỗi khi CHÍNH kẻ mang hành động (giống Bleed thường),
    //   NHƯNG max riêng 99 (không chung field "bleed" gốc) + /2 mỗi end turn.
    // Tremor: end turn TỰ ĐỘNG kích Tremor Burst lên CHÍNH mình, -15 Sta/stack,
    //   tiêu hết TOÀN BỘ stack sau đó (không /2 như Tremor thường).
    // Rupture: mỗi đòn NHẬN ép Res về tối thiểu 1.5x (nếu đang <1.5x), -1 stack
    //   MỖI LẦN thực sự áp dụng (res gốc <1.5x).
    // Sinking: mỗi đòn NHẬN lúc Sanity ≤0 → -1 Sanity thêm + bonus dmg = count;
    //   mất sạch stack vào end turn.
    haouFlame: 0, haouBleed: 0, haouTremor: 0, haouRupture: 0, haouSinking: 0,
    // Hemorrhage (xác nhận trực tiếp, KHÁC Tremor-Hemorrhage — status riêng về
    // Bleed scaling) — TRÊN TARGET (kẻ bị áp Bleed liên tục): +1 stack MỖI LẦN
    // nhận Bleed MỚI (max 5), mỗi stack ứng 1 tier (+10%/tier dmg nhận, và Bleed
    // dmg tự gây nhân /3|/2|x1|x1.5|x2 theo tier 1-5). Reset về 0 nếu KHÔNG có
    // Bleed mới trong 1 turn — appliedThisTurn track để biết reset hay không.
    hemorrhage: 0, hemorrhageAppliedThisTurn: false,
    // Burning Sensation (xác nhận trực tiếp): "gây x3 sát thương burn (Có thể mul
    // dmg), giảm 1/2 lượng hồi phục" — flag boolean (không stack, mô tả gốc không
    // nêu số lượng).
    burningSensation: false,
    // Busy as Tribbie (xác nhận trực tiếp): "mỗi khi sử dụng Page hoặc Critical sẽ
    // làm cho người buff nó tung ra một lần FUA [10~20][Blunt][Undodgeable]. Một
    // turn chỉ kích một lần" — GIẢ ĐỊNH (mô tả gốc không nói rõ FUA nhằm vào ai):
    // FUA nhắm THẲNG vào chính người mang status này (source tự động phản công
    // lại) — cách diễn giải đơn giản nhất có thể tự động hoá mà không cần thêm
    // khái niệm "kẻ địch đang giao tranh" (hệ thống hiện không có). sourceId lưu
    // định danh "người buff nó".
    busyAsTribbie: false, busyAsTribbieSourceId: null, busyAsTribbieTriggeredThisTurn: false,
    // Time Moratorium (xác nhận trực tiếp): "khi bị nhận sát thương... KHÔNG NHẬN
    // sát thương trong turn đó mà tích lại, sau 3 turn gây (dmg tích lại) x
    // (Tremor/2)%, giảm 10% dmg nhận vào" — chặn+tích luỹ dmg xử lý ở COMMIT
    // HANDLER (index.js), "nổ" sau 3 turn xử lý ở turn-advance.js.
    timeMoratorium: false, timeMoratoriumAccumulated: 0, timeMoratoriumTurnsLeft: 0,
    // Ammo system (xác nhận trực tiếp) — "Stack dành cho vũ khí có sử dụng đạn.
    // Nhận qua Reload, tiêu hao đạn trong Inventory mỗi khi Reload. Max 99 trong
    // Inventory VÀ mỗi khi vào Encounter." — ammo = đạn thường (encounter-only,
    // reset mỗi encounter). frostAmmo/incendiaryAmmo = đạn đặc biệt riêng, cùng cơ
    // chế Reload từ Inventory. lastAmmoTypeUsed lưu loại đạn VỪA bắn (để Repeat
    // Ammo — "lặp lại viên đạn trước mà không tốn Stack" — biết dùng lại loại nào).
    ammo: 0, frostAmmo: 0, incendiaryAmmo: 0, lastAmmoTypeUsed: null,
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
      // Guard chọn hit cụ thể (xác nhận trực tiếp) — danh sách hit index (1-based)
      // muốn che, thay vì che tuần tự từ đầu — xem performGuardEvade/confirm handler.
      guardHitSelections: [],
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