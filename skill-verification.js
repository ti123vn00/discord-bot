// skill-verification.js
// 6 hàm xử lý verify/roll skill cho encounter (parseSkillCooldownTurns,
// parseSkillCost, extractDefenseBypassTags, mergeDefenseBypassTags, forceStagger,
// resolveSkillVerification) — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp
// tục tách hàm ra thành file riêng".
//
// LƯU Ý QUAN TRỌNG VỀ VỊ TRÍ ĐẶT REQUIRE (bài học tích lũy từ 2 lần tách trước):
// resolveSkillVerification cần client/isEgoSkill/buildSkillRollResult — CẢ 3 ĐỀU
// là const/function ĐỊNH NGHĨA SAU vị trí extraction gốc trong index.js. NHƯNG
// khác 2 lần trước (nơi TDZ gây lỗi thật), lần này AN TOÀN vì: doPlayerAttack/
// doPlayerHit/doEnemyAttack (gọi resolveSkillVerification bên trong thân hàm của
// CHÚNG) là function declaration — code bên trong CHỈ chạy lúc được INVOKE
// (runtime, sau khi toàn bộ module đã load xong), KHÔNG PHẢI lúc parse module.
// Do đó dòng require gọi factory này ĐẶT SAU buildSkillRollResult (vị trí xa
// nhất trong 3 dependency) trong index.js — đã verify kỹ KHÔNG có lệnh gọi nào
// ở TOP-LEVEL (ngoài thân hàm) tới 6 hàm này trước vị trí đó.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ applyIndulgenceToDmgStr, findSkill, resolveSkillKey, cdKeyFor, computeDiceModifier, resolveReuseTimes, hasPerk, isEgoSkill, buildSkillRollResult, client, ENCOUNTER_SANITY_MAX, r, combatantResStr, autoBuildDmgStrFromSkillRoll, annotateLinesWithEmotion, findWeaponAnywhere, getEncounter }) {

  function parseSkillCooldownTurns(cdStr) {
    const m = (cdStr ?? "").match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  
  /**
   * resolveSkillVerification — xử lý 2 cách GM verify dmgStr người chơi tự gõ:
   *   1. skill: <tên skill> — bot TỰ ROLL skill đó NGAY (dùng buildSkillRollResult có
   *      sẵn, CHẠY THẬT calcMathCore/RNG, không phải tham chiếu tĩnh) → dice value THẬT
   *      không thể gian lận, + tự tính Emotion Coin delta luôn (tái dùng side-channel
   *      startEmotionTracking đã có sẵn cho -skill thường) + enforce/set cooldown.
   *      HẠN CHẾ: skill có promptArg (cần input riêng, VD: Thrust cần Light hiện tại)
   *      CHƯA hỗ trợ qua đường này — phải dùng -skill riêng rồi dán ref: thay vào đó,
   *      vì promptArg cần GM/player tự nhập số bổ sung không có trong attack/hit.
   *   2. ref: <message link hoặc ID> — fetch lại message ĐÃ roll trước đó (qua -skill
   *      riêng), hiện snippet + link nhảy tới cho GM tự xem, KHÔNG tự verify được gì
   *      (chỉ là tiện cho GM, không suy ra được Emotion Coin/cooldown từ đây).
   * Cả 2 đều OPTIONAL và ĐỘC LẬP — có thể dùng 1, cả 2, hoặc không cái nào (lúc đó GM
   * chỉ dựa vào dmgStr suông, như trước).
   * @returns { skillRollEmbed, skillKey, cooldownTurns, emotionDelta, refSnippet, refLink }
   * @throws Error nếu skill không tìm thấy/đang cooldown/cần promptArg, hoặc ref: sai định dạng/không fetch được
   */
  /**
   * extractDefenseBypassTags — đọc text (description của embed roll skill, hoặc
   * chuỗi tags: gõ tay) tìm các tag ảnh hưởng phòng thủ — XÁC NHẬN CHÍNH XÁC nghĩa
   * từng tag trực tiếp từ GM:
   *   [Undodgeable]/[Unevadeable] — Evade KHÔNG cản được, Guard/Parry vẫn được.
   *   [Unblockable] — Guard KHÔNG cản được, Evade/Parry vẫn được.
   *   [Unparriable] — Parry KHÔNG cản được, Guard/Evade vẫn được.
   *   [Guard Break] — KHÁC HẲN [Unblockable]: Guard VẪN cản được đòn này (giảm dmg
   *     bình thường), nhưng SAU KHI Guard xong thì bên Guard bị STAGGER NGAY LẬP TỨC
   *     (set staggered=true + Res 2x ngay, không cần đợi Stamina về 0) — Evade/Parry
   *     vẫn hoạt động bình thường, không bị ảnh hưởng gì bởi Guard Break (chỉ áp dụng
   *     khi NẠN NHÂN CHỌN GUARD cụ thể).
   *   [Unclashable] — không thể Clash (dùng ở -encounter clash, KHÔNG liên quan
   *     Guard/Evade/Parry).
   */
  /**
   * parseSkillCost — đọc field `cost` của 1 skill (skills.js), trích ra Light/
   * Sanity cost NẾU match được pattern rõ ràng ("N Light", "N Light & M Sanity",
   * "N Light, M Sanity"...) — CHỦ ĐỘNG bỏ qua mọi dạng cost KHÁC (Heat Gauge, "Tiêu
   * N viên đạn", "Cần đủ N Trigram", điều kiện đặc biệt như "Chỉ dùng khi có
   * Dullahan"...) vì những resource đó KHÔNG map vào field nào của Combatant —
   * GIỮ NGUYÊN hành vi cũ (GM/player tự note tay) cho các trường hợp này, tránh
   * trừ nhầm hoặc trừ sai resource không tồn tại. Trả về { light, sanity } — null
   * cho phần không match được (nghĩa là "không tự động trừ phần đó").
   */
  function parseSkillCost(costStr) {
    const t = costStr ?? "";
    let light = null, sanity = null;
    const lightMatch = t.match(/(\d+)\s*(?:<:Light:\d+>)?Light/i);
    if (lightMatch) light = parseInt(lightMatch[1], 10);
    const sanityMatch = t.match(/(\d+)\s*Sanity/i);
    if (sanityMatch) sanity = parseInt(sanityMatch[1], 10);
    return { light, sanity };
  }
  
  function extractDefenseBypassTags(text) {
    const t = text ?? "";
    return {
      blockEvade: /\[Undodgeable\]/i.test(t) || /\[Unevadeable\]/i.test(t),
      blockGuard: /\[Unblockable\]/i.test(t),
      blockParry: /\[Unparriable\]/i.test(t),
      guardBreak: /\[Guard Break\]/i.test(t),
      unclashable: /\[Unclashable\]/i.test(t),
      // Airborne (xác nhận trực tiếp): "biến mất... sau bị dính đòn có condition
      // Airborne" — 1 tag riêng trên ĐÒN TẤN CÔNG (giống Unblockable...), KHÔNG
      // phải status trên combatant nào — đòn có tag này sẽ tắt airborne của target.
      airborneCondition: /\[Airborne\]/i.test(t),
      // ── 3 TAG MỚI cho Furioso rework (Fragaria xác nhận trực tiếp) ──
      // uncounterable  — page-counter KHÔNG ngắt được đòn này.
      // unbreakableDice — THUA clash vẫn tiến hành sử dụng, chỉ còn 50% dmg gốc
      //                   (thay vì bị huỷ hoàn toàn như skill thường).
      // unfocusedVolley — MỖI dice nảy sang 1 kẻ địch ngẫu nhiên; dice ĐẦU luôn
      //                   trúng target được aim.
      uncounterable: /\[Uncounterable\]/i.test(t),
      unbreakableDice: /\[Unbreakable Dice\]/i.test(t),
      unfocusedVolley: /\[Unfocused Volley\]/i.test(t),
    };
  }
  
  /** mergeDefenseBypassTags — gộp tag tự phát hiện từ skillRollEmbed VỚI tag gõ tay
   *  (tags: param, dạng "undodgeable,guardbreak") — gõ tay CHỈ THÊM, không thể tắt
   *  tag đã tự phát hiện từ skill thật. */
  function mergeDefenseBypassTags(autoTags, manualTagsRaw) {
    const manual = (manualTagsRaw ?? "").toLowerCase();
    return {
      blockEvade: autoTags.blockEvade || manual.includes("undodgeable") || manual.includes("unevadeable"),
      blockGuard: autoTags.blockGuard || manual.includes("unblockable"),
      blockParry: autoTags.blockParry || manual.includes("unparriable"),
      guardBreak: autoTags.guardBreak || manual.includes("guard break") || manual.includes("guardbreak"),
      unclashable: autoTags.unclashable || manual.includes("unclashable"),
      airborneCondition: autoTags.airborneCondition || manual.includes("airborne"),
    };
  }
  
  /** forceStagger — set Stagger NGAY LẬP TỨC bất kể Stamina hiện tại (dùng cho Guard
   *  Break — Guard xong vẫn bị Stagger ngay, không phải đợi Stamina về 0 như Stagger
   *  thường). Tôn trọng Choáng (2+ stack → 2 turn thay vì 1), KHÔNG set lại nếu đã
   *  đang Stagger (giữ idempotent giống checkStaggerPanic).
   *  GAP ĐÃ SỬA (xác nhận trực tiếp qua log thật: "123" tỉnh Stagger ngay sau
   *  đúng 1 lần endturn thay vì kéo dài qua 2 turn) — công thức TRƯỚC ĐÂY lệch
   *  đúng 1 đơn vị so với checkStaggerPanic (combat-utils.js): dùng 1/2 thay vì
   *  2/3 — sửa lại cho KHỚP CHÍNH XÁC công thức gốc. */
  function forceStagger(combatant) {
    if (!combatant.staggered) {
      combatant.staggered = true;
      combatant.staggerTurnsLeft = (combatant.dazedStacks ?? 0) >= 2 ? 3 : 2;
    }
  }
  
  /** @param variantKey — biến thể của skill có field `variants` (VD Extreme Edge:
   *  "ground"/"air"/"low"). null = dùng biến thể ĐẦU TIÊN (mặc định). Skill không
   *  có variants thì tham số này bị bỏ qua hoàn toàn. */
  /** deriveAutoPromptArg — suy giá trị promptArg TỪ STATE encounter thay vì bắt
   *  người chơi nhập tay (xem comment đầy đủ ở nơi gọi).
   *  @returns số/giá trị để truyền vào roll(), hoặc `null` nếu KHÔNG suy được
   *           (khi đó giữ nguyên hành vi cũ: chặn + hướng dẫn dùng `-skill`).
   *  KHÔNG đoán bừa: chỉ trả giá trị cho skill đã đối chiếu đúng ngữ nghĩa
   *  promptArg trong skills.js. Skill promptArg MỚI sẽ tự rơi vào nhánh null. */
  function deriveAutoPromptArg(skillKey, attacker, encounter, refTarget) {
    // Caduceus Critical — bơm Karmic/Unlock TỪ COMBATANT. Bản `-caduceus` cũ bắt
    // GM gõ Karmic bằng tay ở tham số thứ 3; sai số là chuyện chắc chắn xảy ra.
    if (/^caduceus crit[123] /.test(skillKey)) {
      return {
        karmic: attacker?.karmicConsequence ?? 0,
        unlock: attacker?.prescriptUnlockLevel ?? 0,
        procuration: (attacker?.procurationHermes ?? []).length,
      };
    }
    switch (skillKey) {
      case "vengeance retaliation": {
        // "% HP đã mất kể từ lần dùng skill TRƯỚC (0 nếu không mất gì)".
        // Mốc so sánh lưu ở `vengeanceRetaliationHpMark`; lần đầu chưa có mốc
        // thì lấy HP hiện tại làm mốc → 0% (đúng nghĩa "chưa mất gì kể từ lần
        // trước"). Cập nhật mốc NGAY tại đây để lần sau tính từ điểm này.
        const maxHp = attacker.maxHp > 0 ? attacker.maxHp : 1;
        const mark = attacker.vengeanceRetaliationHpMark ?? attacker.currentHp ?? maxHp;
        const lostPct = Math.max(0, Math.min(100, ((mark - (attacker.currentHp ?? 0)) / maxHp) * 100));
        attacker.vengeanceRetaliationHpMark = attacker.currentHp ?? 0;
        return Math.round(lostPct * 100) / 100;
      }
      case "thrust":
        // "Light hiện tại (tối thiểu 2)" — đọc thẳng, không cần hỏi.
        return attacker.currentLight ?? 0;
      case "apocalypse":
        // "Dưới 50% HP?" — boolean suy từ HP thật.
        return (attacker.maxHp > 0) && (attacker.currentHp < attacker.maxHp * 0.5);
      case "solemn lament": {
        // "Số người đã chết" — đếm combatant 0 HP trên sân. Không có encounter
        // (VD gọi ngoài trận) thì không suy được → null, giữ luồng cũ.
        if (!encounter) return null;
        const dead = [...Object.values(encounter.players ?? {}), ...Object.values(encounter.enemies ?? {})]
          .filter(c => (c?.currentHp ?? 1) <= 0).length;
        return dead;
      }
      case "sanguine pointilism": {
        // "% Reuse — mặc định 40%, +20% mỗi 5 Bleed trên địch". Cần biết target
        // để đọc Bleed; không có target thì dùng mặc định 40 (vẫn chạy được,
        // không chặn người chơi vì lý do kỹ thuật).
        const bleed = refTarget?.bleed ?? 0;
        return Math.min(100, 40 + Math.floor(bleed / 5) * 20);
      }
      default:
        // "xuất lực tối đa" (% Hắc Thiểm) và mọi promptArg mới — do NGƯỜI CHƠI
        // tự quyết, không phải state → không được đoán hộ.
        return null;
    }
  }

  async function resolveSkillVerification(channelId, attacker, skillNameRaw, refRaw, isCritical = false, variantKey = null) {
    let skillRollEmbed = null, skillKey = null, cooldownTurns = 0, emotionDelta = 0, busyAsTribbieNote = "", autoDmgStr = null, autoWarnings = [], autoSideEffects = null, reuseTimesResolved = 0;
    let refSnippet = null, refLink = null;
    let lightCost = 0, sanityCost = 0;
    // effectiveBulletType/effectiveBulletCount — GAP ĐÃ SỬA (lỗi scope): khai
    // báo Ở ĐÂY (top-level hàm), KHÔNG PHẢI bên trong khối "if (skillNameRaw...)"
    // bên dưới — nếu không, return { ... } ở cuối hàm (ngoài khối if đó) sẽ
    // không truy cập được biến, throw "effectiveBulletType is not defined".
    let effectiveBulletType = null, effectiveBulletCount = 0;
    // isOwnCriticalBypassed — KHAI BÁO Ở NGOÀI (không phải const trong block if)
    // vì cần dùng lại ở return cuối hàm (đã sửa lỗi scope thật: "isOwnCriticalBypassed
    // is not defined" — const trước đây chỉ tồn tại TRONG block if, không thoát
    // ra được tới return nằm NGOÀI block đó).
    let isOwnCriticalBypassed = false;
  
    if (skillNameRaw && skillNameRaw.trim()) {
      const skill = findSkill(skillNameRaw.trim());
      if (!skill) throw new Error(`Không tìm thấy skill "${skillNameRaw}" — dùng \`-skill list\` để xem danh sách.`);
      // ── promptArg TỰ SUY TỪ STATE (BUG ĐÃ SỬA — Fragaria: "Vengeance
      // Retaliation chưa automate, có thể cũng còn nhiều skill khác tương tự") ──
      // TRƯỚC ĐÂY mọi skill có `promptArg` đều bị CHẶN THẲNG khỏi encounter, bắt
      // người chơi chạy `-skill ...` riêng rồi dán link vào `ref:` — cực kỳ bất
      // tiện và phá luồng "thuần button".
      // Nhưng rà lại cả 6 skill dạng này thì con số cần nhập ĐỀU đã có sẵn trong
      // state encounter — bot tự tính được, không cần hỏi:
      //   • vengeance retaliation → % HP đã mất kể từ lần dùng TRƯỚC (tự track)
      //   • thrust                → Light hiện tại
      //   • apocalypse            → có đang dưới 50% HP không
      //   • solemn lament         → số người đã chết trên sân
      //   • sanguine pointilism   → % Reuse (40% + 20% mỗi 5 Bleed trên target)
      //   • xuất lực tối đa       → % Hắc Thiểm (KHÔNG suy được — do người chơi
      //     tự quyết, không phải state) → vẫn chặn, giữ luồng `-skill` + ref:
      const encounterForAuto = await getEncounter(channelId).catch(() => null);
      // refTarget cho Sanguine Pointilism — lấy enemy còn sống ĐẦU TIÊN làm mốc
      // đọc Bleed (skill AOE-ish, không có target cụ thể lúc verify; target thật
      // được chọn Ở BƯỚC SAU). Không có enemy nào thì để undefined → dùng 40%.
      const refTargetCombatant = encounterForAuto
        ? Object.values(encounterForAuto.enemies ?? {}).find(e => (e?.currentHp ?? 0) > 0)
        : null;
      // ══ BUG HỆ THỐNG #1 ĐÃ SỬA — skillKey GÁN SAU KHI ĐÃ DÙNG ══════════
      // Fragaria: "Vengeance Retaliation chưa hoạt động".
      // NGUYÊN NHÂN GỐC: `deriveAutoPromptArg(skillKey, ...)` TRƯỚC ĐÂY được gọi
      // Ở TRÊN dòng `skillKey = ...`, tức lúc đó skillKey VẪN CÒN `null`.
      // `switch (null)` rơi thẳng vào `default:` → trả null → điều kiện ngay bên
      // dưới `autoPromptArg === null` luôn đúng → THROW "cần input do người chơi
      // tự quyết" cho MỌI skill có promptArg. Toàn bộ cơ chế auto-suy promptArg
      // (viết ra chính vì Fragaria yêu cầu) CHƯA BAO GIỜ chạy được một lần nào:
      // vengeance retaliation, thrust, apocalypse, solemn lament, sanguine
      // pointilism đều bị chặn khỏi encounter. Cùng họ lỗi scope/thứ tự đã ghi
      // trong HANDOFF (khai báo sau khi dùng).
      //
      // ══ BUG HỆ THỐNG #2 ĐÃ SỬA — skillKey KHÔNG chuẩn hoá qua alias ═════
      // Fragaria: "Onrush chưa tự động hoá phần giảm stamina (cũng có thể nhiều
      // page tương tự chưa tự động hoá nốt)".
      // NGUYÊN NHÂN GỐC: `skillKey = skillNameRaw.trim().toLowerCase()` giữ
      // NGUYÊN chuỗi người chơi gõ. `findSkill()` CÓ resolve alias (vr →
      // vengeance retaliation, aq → astral quantization, ds2 → drilling stab...)
      // nhưng kết quả đó bị VỨT ĐI. Hệ quả dây chuyền:
      //   • MỌI handler tự động hoá đều so `p.skillKey === "<key chuẩn>"`
      //     (onrush, wheels industry, atelier logic pistols, castigation,
      //     augury kick, tactical suppression...) → gõ alias là TRƯỢT SẠCH,
      //     page trông như "chưa được tự động hoá" dù code có sẵn.
      //   • CD lưu theo skillKey → dùng alias xong dùng tên đầy đủ = HAI ô CD
      //     riêng biệt → né cooldown hoàn toàn (exploit).
      //   • `skill.promptArg` + `deriveAutoPromptArg` cũng so theo key chuẩn.
      // SỬA: lấy key chuẩn TỪ CHÍNH object skill đã resolve (`skill.name`), có
      // fallback về chuỗi gõ nếu skill thiếu name. Đặt TRƯỚC mọi chỗ dùng.
      // Dùng resolveSkillKey (skills.js) — KHÔNG suy từ skill.name: có 31 skill
      // mà tên hiển thị khác key ("Wheel's Industry" ↔ `wheels industry`,
      // "Atelier Logic: Pistols" ↔ `atelier logic pistols`…), suy từ name sẽ phá
      // đúng những handler đang chạy tốt.
      skillKey = resolveSkillKey(skillNameRaw) ?? skillNameRaw.trim().toLowerCase();
      const autoPromptArg = skill.promptArg ? deriveAutoPromptArg(skillKey, attacker, encounterForAuto, refTargetCombatant) : null;
      if (skill.promptArg && autoPromptArg === null) {
        throw new Error(`Skill "${skill.name}" cần input do người chơi tự quyết — chưa roll trực tiếp qua encounter được. Dùng \`-skill ${skillNameRaw}\` riêng rồi dán link message đó vào ref: thay vào đó.`);
      }
      const existingCd = attacker.skillCooldowns?.[cdKeyFor(skillKey)] ?? 0;
      // orlandoFuriosoBypass — GAP ĐÃ SỬA (xác nhận trực tiếp, dự án tự động hoá
      // toàn bộ weapon/outfit): "Orlando Furioso" — swap vũ khí xong, Critical
      // NGAY SAU đó miễn CD (dùng 1 lần) — chỉ áp dụng cho ĐÚNG Critical của vũ
      // khí hiện tại (không phải bất kỳ skill nào), tránh miễn CD nhầm skill khác.
      const currentWeapon = findWeaponAnywhere(attacker.weaponName);
      isOwnCriticalBypassed = attacker.orlandoFuriosoBypass && currentWeapon?.criticalSkillKey === skillKey;
      if (existingCd > 0 && !isOwnCriticalBypassed) throw new Error(`Skill "${skill.name}" đang cooldown — còn ${existingCd} turn nữa.`);
      // "Tactical Suppression" — CD "3 Turn SAU KHI HẾT Shield HP" không dùng
      // skillCooldowns thông thường (bắt đầu ngay lúc dùng) — check riêng.
      if (skillKey === "tactical suppression" && attacker.tacticalSuppressionCdPending) {
        throw new Error(`Skill "${skill.name}" đang cooldown (còn ${attacker.tacticalSuppressionCdTurnsLeft} turn kể từ khi Shield HP hết) — chưa thể dùng lại.`);
      }
      if (skillKey === "tactical suppression" && attacker.tacticalSuppressionActive) {
        throw new Error(`Skill "${skill.name}" đang hoạt động (còn ${attacker.tacticalSuppressionTurnsLeft} turn) — không thể dùng lại khi đang active.`);
      }
      // Task yêu cầu trực tiếp: "page unlock bị bug không có CD trong khi đáng
      // lẽ dù nó có là cd 0 turn nhưng có description là 1 turn chỉ dùng được 1
      // lần" — CD=0 khiến existingCd check ở trên KHÔNG BAO GIỜ chặn được (0 > 0
      // luôn false) — cần check RIÊNG, giống hệt pattern "tactical suppression"
      // trên: 1 flag riêng, reset mỗi turn (xem turn-advance.js).
      // Castigation (Index Longsword) — BUG ĐÃ SỬA: page này chỉ được dùng khi
      // ĐANG có **Unlocked Blade** (Eliminate ghi rõ "Nếu có Unlocked Blade:
      // dùng tiếp Castigation"), nhưng trước đây KHÔNG có điều kiện nào cả —
      // bấm lúc nào cũng được, và cũng chẳng xoá stack sau khi dùng. Chặn ở đây
      // cùng pattern với Great Split (cần đủ 5 Imitation).
      if (skillKey === "castigation" && (attacker.unlockBladeStage ?? 0) < 3) {
        throw new Error(`Skill "${skill.name}" cần **Unlocked Blade** mới dùng được — hãy dùng Unlock đủ 3 lần (hiện đang ở stage ${attacker.unlockBladeStage ?? 0}/3).`);
      }
      if (skillKey === "unlock" && attacker.unlockUsedThisTurn) {
        throw new Error(`Skill "${skill.name}" đã dùng trong turn này rồi — chỉ được dùng 1 lần/turn (dù CD 0 Turn, vẫn giới hạn theo description).`);
      }
      // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 4) — "Great
      // Split" (Mimicry Blade) yêu cầu ĐỦ 5 Imitation mới dùng được (đây là điều
      // kiện BẮT BUỘC để roll, không chỉ là hiệu ứng phụ — chặn NGAY trước khi
      // roll, giống cách CD chặn). BUG ĐÃ SỬA: skillKey giữ NGUYÊN dấu ":" (từ
      // skillNameRaw "Great Split: Vertical" → "great split: vertical"), không
      // strip như alias lookup — so sánh cần strip ":" trước để khớp đúng.
      const skillKeyNoColon = skillKey.replace(/:/g, "").trim();
      // ── FACTION LOCK ──────────────────────────────────────────────────────
      // Page khai `requiresFaction` thì CHỈ người thuộc faction đó dùng được.
      // Trước đây điều kiện chỉ nằm ở CHỮ trong mô tả page (VD "yêu cầu Outfit
      // Blade Lineage") — không dòng code nào chặn, và còn ghi sai là OUTFIT.
      // Đặt cơ chế CHUNG ở đây để page mới chỉ cần khai 1 dòng `requiresFaction`.
      if (skill?.requiresFaction) {
        const mine = String(attacker.faction ?? "").trim().toLowerCase();
        const need = String(skill.requiresFaction).trim().toLowerCase();
        if (mine !== need) {
          throw new Error(`**${skill.name}** là page riêng của **${skill.requiresFaction}** — bạn cần thuộc faction đó mới dùng được.` +
            (attacker.faction ? ` (Faction hiện tại: **${attacker.faction}**)` : " (Bạn chưa được gán faction nào — GM dùng `-setplayer @bạn faction: <tên>`)"));
        }
      }
      if ((skillKeyNoColon === "great split vertical" || skillKeyNoColon === "great split horizontal") && (attacker.imitation ?? 0) < 5) {
        throw new Error(`Skill "${skill.name}" cần ít nhất 5 Imitation để dùng — hiện có ${attacker.imitation ?? 0}.`);
      }
      // "Shock Round" (Soldato Rifle) — GAP ĐÃ SỬA (xác nhận trực tiếp, sau đó
      // đổi điều kiện thành 5 viên đạn): field "cost: Tiêu 2 viên đạn" TRƯỚC ĐÂY
      // chỉ là text mô tả, KHÔNG có logic thật nào enforce (parseSkillCost chỉ
      // nhận diện Light/Sanity, không phải "viên đạn") — thêm điều kiện BẮT
      // BUỘC + trừ thật, giống hệt pattern Great Split ở trên. Critical này
      // HOÀN TOÀN riêng biệt, KHÔNG liên quan Bayonet Combat (Soldato Rifle có
      // 2 Critical: 1 bình thường + 1 có điều kiện đạn).
      if (skillKey === "shock round" && (attacker.bulletStack ?? 0) < 5) {
        throw new Error(`Skill "${skill.name}" cần ít nhất 5 viên đạn (Soldato Rifle) để dùng — hiện có ${attacker.bulletStack ?? 0}/8.`);
      }
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "Critical Shock Round cũng không thấy áp
      // 10 Burn, thậm chí còn chả áp burn nào") — trước đây TIÊU 5 viên đạn
      // nhưng KHÔNG hề lưu lại loại đạn (effectiveBulletType) hay số lượng
      // (effectiveBulletCount) — logic Frost/Incendiary chỉ tồn tại ở doPlayerAttack
      // (M1), Shock Round (Critical, qua doPlayerHit) hoàn toàn không đi qua đó.
      // Lưu lại đây để resolve-pending-action.js áp ĐÚNG hiệu ứng nhân theo SỐ
      // VIÊN thật đã tiêu (5, không phải +1/+2 cố định như M1 chỉ tiêu 1 viên).
      if (skillKey === "shock round") {
        effectiveBulletType = attacker.bulletStackType;
        effectiveBulletCount = 5;
        attacker.bulletStack -= 5;
        if (attacker.bulletStack === 0) attacker.bulletStackType = null;
      }
      // Light/Sanity cost — đọc từ field cost của skill (xem parseSkillCost — CHỈ
      // match được pattern Light/Sanity rõ ràng, bỏ qua Heat Gauge/custom resource
      // khác). Tap Of The Light (Gloom, [10 Points]): giảm 1 NỬA Sanity Cost từ
      // E.G.O Page — chỉ áp khi skill này LÀ E.G.O (isEgoSkill), floor() để có lợi
      // cho player. CHECK ĐỦ TÀI NGUYÊN TRƯỚC KHI ROLL DICE — tránh tình huống roll
      // xong (tốn thời gian/RNG) mới phát hiện không đủ Light/Sanity.
      const parsedCost = parseSkillCost(skill.cost);
      lightCost = parsedCost.light ?? 0;
      // ══ REUSE CÓ TÍNH PHÍ (Thrust / Mook Workshop) ═══════════════════════
      // BUG NẶNG ĐÃ SỬA (Fragaria cảnh báo: "check kỹ Mook Workshop lẫn Thrust,
      // player có thể nhập tùy ý ví dụ nhập 9 lần reuse dù chỉ đang có 4 Light").
      // Đúng là có bug, và còn nặng hơn: `lightCost` TRƯỚC ĐÂY chỉ lấy từ
      // `skill.cost` = chi phí ĐÒN GỐC. Thrust reuse 4 lần cho ra 5 dice, text
      // tự in "Light 6 → 1", nhưng thực tế **chỉ bị trừ 2 Light** — reuse gần
      // như MIỄN PHÍ. Giờ `reuseSpec.netCost()` quyết định số Light thật bị trừ,
      // GHI ĐÈ giá trị parse từ `skill.cost`.
      // Số lần reuse LUÔN bị kẹp theo Light thật (resolveReuseTimes) nên gửi
      // customId tay với "9" vẫn không vượt được trần.
      if (skill.reuseSpec) {
        const reuseInfo = resolveReuseTimes(skill, attacker.currentLight ?? 0, variantKey);
        reuseTimesResolved = reuseInfo.reuseTimes;
        lightCost = reuseInfo.netCost;
      }
      sanityCost = parsedCost.sanity ?? 0;
      if (sanityCost > 0 && isEgoSkill(skill) && hasPerk(attacker, "Tap Of The Light")) {
        sanityCost = Math.floor(sanityCost / 2);
      }
      // BlackSilence/Struggling (xác nhận trực tiếp): "giảm mọi Light Cost của
      // Page đi 1 (Không thể giảm thành 0)" — floor tại 1 nếu vốn có cost >0.
      if (attacker.blackSilence && lightCost > 1) lightCost -= 1;
      // Chains (xác nhận trực tiếp): "skill tiếp theo của kẻ thù tăng 1 Light để
      // sử dụng (1 Turn)" — cộng thêm NGAY vào lightCost trước khi check đủ/không
      // đủ, tiêu thụ (chains=false) NGAY sau khi skill roll thành công (dùng xong
      // 1 skill là hết hiệu lực, dù còn turn hay không).
      const hasChains = attacker.chains === true;
      if (hasChains) lightCost += 1;
      if (lightCost > 0 && attacker.currentLight < lightCost) {
        throw new Error(`Không đủ Light cho "${skill.name}" — cần ${lightCost}${hasChains ? " (đã +1 do Chains)" : ""}, hiện có ${attacker.currentLight}.`);
      }
      if (sanityCost > 0 && attacker.currentSanity - sanityCost < -ENCOUNTER_SANITY_MAX) {
        throw new Error(`Sanity không đủ cho "${skill.name}" — cần ${sanityCost}, hiện tại ${attacker.currentSanity} (sẽ vượt mốc Panic -${ENCOUNTER_SANITY_MAX}).`);
      }
      // Paralyze (xác nhận trực tiếp): "khi trên người kẻ thù có 1 paralyze sẽ
      // khiến cho 1 skill của kẻ thù sử dụng sẽ 100% Min Dice, sau khi sử dụng
      // skill Min Dice sẽ giảm 1 count Paralyze" — nhất quán với cooldown/Light/
      // Sanity ở trên (đều trừ/áp dụng NGAY lúc declare, không đợi confirm, theo
      // đúng thiết kế gốc của hàm này — roll skill là RNG thật, không thể "hoãn").
      // Shattered E.G.O ("The Strongest" — Manifested E.G.O: Red Mist, sau khi
      // bị Stagger trong lúc Manifest): "mọi Dice bạn gieo đều CHẮC CHẮN ra Min
      // Dice trong 3 Turn". Dùng CHUNG đường forceMinDice với Paralyze — nhưng
      // KHÔNG tiêu `paralyze` (Shattered đếm turn riêng ở turn-advance.js).
      const hasShatteredEgo = (attacker.shatteredEgoTurnsLeft ?? 0) > 0;
      const hasParalyze = (attacker.paralyze ?? 0) > 0;
      // "The Strongest": toàn bộ Dice ra Max Dice trong suốt Manifest.
      // Cờ `theStrongestActive` do encounter-actions.js bật lúc Manifest và
      // turn-advance.js tắt lúc hết — KHÔNG suy lại từ ego.js ở đây để không
      // phải kéo thêm dependency vào skill-verification (module này vốn không
      // biết gì về E.G.O).
      const wantMaxDice = attacker.theStrongestActive === true && !hasParalyze && !hasShatteredEgo;
      // Freeble (xác nhận trực tiếp): "giảm số dice bằng số count của MỌI skill
      // trong turn của kẻ địch" — trừ trực tiếp vào diceModifier (cùng cơ chế với
      // Dice Up/Down, r() đã tự clamp không dưới 1 — xem comment ở skills.js).
      // Tremor Chain (xác nhận trực tiếp): "giảm 1 điểm Dice với mỗi 10 Tremor có
      // trên bản thân" — LIÊN TỤC, dựa trên Tremor HIỆN TẠI của CHÍNH người đang
      // roll skill (không phải target).
      // Công thức đã TÁCH sang combat-utils.js's computeDiceModifier để M1 dùng
      // CHUNG — trước đây chỉ đường skill này biết tới diceUp (xem comment đầy
      // đủ ở đó: chính là lý do Hana Association trông như không hoạt động).
      // BlackSilence/Struggling (xác nhận trực tiếp): "+4 Dice Up cho Critical của
      // vũ khí" — CHỈ áp khi đây là Critical (isCritical=true), không áp cho Page
      // thường.
      const blackSilenceCritBonus = isCritical && attacker.blackSilence ? 4 : 0;
      // ❗ Fragaria: "chặn cho Borrowed Eyes không bị ảnh hưởng bởi Dice Up —
      // Singularity rất mạnh nên để Dice Up tăng thêm charge Evade sẽ mất cân
      // bằng game." Skill khai `ignoreDiceModifier` (skills.js) ⇒ ÉP về 0.
      // Chặn ở ĐÂY (nơi roll) chứ không phải lúc đọc charge: dice HIỆN cho người
      // chơi và số charge THẬT phải là MỘT con số, không được lệch nhau.
      const diceModifier = skill.ignoreDiceModifier ? 0 : computeDiceModifier(attacker, { blackSilenceCritBonus });
      // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận qua ảnh chụp thật của user, LẦN 2 — lần
      // đầu chỉ sửa cho Critical, giờ áp dụng luôn cho Page thường): "dù Blade
      // Flourish đã roll sẵn... nhưng vẫn bắt tôi nhập dmg... tôi có thể thử nhập
      // 50x3B" — TRƯỚC ĐÂY chỉ Critical (isCritical=true) mới tính autoDmgStr,
      // Page thường (isCritical=false) luôn gọi buildSkillRollResult (KHÔNG BAO
      // GIỜ trả về dmgStr tự động) — nghĩa là dù roll thật đã hiện (Blade
      // Flourish: 5,6,7 Slash), CON SỐ DAMAGE THẬT vẫn lấy từ Modal field người
      // chơi tự gõ, HOÀN TOÀN không liên quan tới roll — gõ "50x3B" tuỳ ý vẫn
      // được tin theo. Sửa: LUÔN dùng autoBuildDmgStrFromSkillRoll (roll ĐÚNG 1
      // LẦN, dmgStr khớp CHÍNH XÁC dice hiển thị) — không phân biệt Critical hay
      // Page thường nữa, autoDmgStr giờ luôn có giá trị đáng tin cậy để CALLER
      // dùng thay cho input gõ tay. blackSilenceCritBonus vẫn CHỈ áp dụng khi
      // isCritical=true (đây là cơ chế game thật — +4 Dice riêng cho vũ khí
      // Critical — tách biệt khỏi việc "có tin được roll hay không").
      // Unlock (Index Proselyte) — stage LẤY TỪ STATE THẬT, không random nữa
      // (xem comment đầy đủ ở skills.js). Lần dùng kế = stage hiện tại + 1, tối
      // đa 3. Đang ở 3 (Unlocked Blade) thì dùng lại vẫn ra 3 (không tụt về 1).
      const unlockRollArgs = skillKey === "unlock"
        ? [Math.min(3, (attacker.unlockBladeStage ?? 0) + 1)]
        : [];
      // "Cloud Cutter" — BUG ĐÃ SỬA (Fragaria: "phần reuse chưa hoạt động").
      // Text ghi "Reuse 1 lần nếu bản thân đang có TRÊN 2 Light" nhưng roll()
      // trước đây không nhận Light nên KHÔNG BAO GIỜ reuse. Reuse phải cộng DICE
      // nên bắt buộc biết Light NGAY LÚC ROLL (không xử lý hậu kỳ như Tremor
      // Burst được). Fragaria chọn HƯỚNG 1 → bot tự đọc state, không hỏi.
      // Dùng đúng pattern `unlockRollArgs` sẵn có cho "skill cần đọc state".
      const cloudCutterRollArgs = skillKey === "cloud cutter"
        ? [attacker.currentLight ?? 0]
        : [];
      // TÍCH TỤ (chargeSpec) — tới đây nghĩa là người chơi đã bấm LẦN 2 = PHÓNG
      // (lần 1 đã bị chặn ở interaction-handlers.js, không vào tới đây).
      // Đọc số turn đã tích rồi XOÁ state ngay: đã phóng là hết, CD bắt đầu từ
      // lúc này ("CD bắt đầu sau khi phóng" đúng như text skill ghi).
      let chargeRollArgs = [];
      if (skill.chargeSpec && attacker.chargingSkillKey === skillKey) {
        chargeRollArgs = [Math.min(skill.chargeSpec.maxTurns, attacker.chargingTurns ?? 0)];
        attacker.chargingSkillKey = null;
        attacker.chargingTurns = 0;
      } else if (skill.chargeSpec) {
        // Phòng hờ: vào thẳng đây mà chưa từng tích (VD lệnh `-skill` của GM) →
        // coi như tích 0 turn thay vì ném lỗi chặn GM.
        chargeRollArgs = [0];
      }
      // Skill có `variants` (VD Extreme Edge) — truyền biến thể player đã chọn.
      // Validate: key lạ → rơi về biến thể đầu tiên thay vì để roll() nhận rác.
      let promptRollArgs = autoPromptArg !== null ? [autoPromptArg] : [];
      let variantRollArgs = [];
      if (Array.isArray(skill.variants) && skill.variants.length > 0) {
        // Grappling (Brawler) — biến thể TỰ NHẬN DIỆN theo trạng thái địch, KHÔNG
        // hỏi người chơi (khác Extreme Edge: 3 tình huống chỉ người chơi biết).
        // Điều kiện: có bất kỳ enemy còn sống nào đang Airborne.
        let autoVariant = null;
        if (skillKey === "grappling" && encounterForAuto) {
          const anyAirborne = Object.values(encounterForAuto.enemies ?? {})
            .some(e => (e?.currentHp ?? 0) > 0 && e.airborne);
          autoVariant = anyAirborne ? "airborne" : "normal";
        }
        const chosen = autoVariant ?? variantKey;
        const valid = skill.variants.some(v => v.key === chosen);
        variantRollArgs = [valid ? chosen : skill.variants[0].key];
      }
      // GAP ĐÃ SỬA (Fragaria: Thrust phải HỎI Ý người chơi muốn reuse hay không).
      // TRƯỚC ĐÂY promptArg và variants LOẠI TRỪ nhau (`promptRollArgs.length ?
      // promptRollArgs : variantRollArgs`) — skill nào có promptArg thì variants
      // bị vứt đi hoàn toàn. Thrust cần CẢ HAI: Light (auto-suy từ state) VÀ số
      // lần Reuse (người chơi chọn). Giờ GHÉP lại thành [light, reuseChoice] cho
      // skill khai `reuseChoiceVariants`. Mọi skill cũ giữ nguyên hành vi vì
      // chúng chỉ có 1 trong 2.
      // Skill có reuseSpec: truyền SỐ LẦN ĐÃ KẸP (reuseTimesResolved) chứ KHÔNG
      // truyền lựa chọn thô của người chơi — nếu không, roll() lại tự kẹp một
      // lần nữa theo công thức riêng và hai nơi có thể lệch nhau.
      const combinedRollArgs = skill.reuseSpec
        ? [...promptRollArgs, String(reuseTimesResolved)]
        : (promptRollArgs.length ? promptRollArgs : variantRollArgs);
      const autoResult = autoBuildDmgStrFromSkillRoll(skill, {
        forceMinDice: hasParalyze || hasShatteredEgo, forceMaxDice: wantMaxDice, diceModifier,
        rollArgs: unlockRollArgs.length ? unlockRollArgs
          : (chargeRollArgs.length ? chargeRollArgs
            : (cloudCutterRollArgs.length ? cloudCutterRollArgs : combinedRollArgs)),
        // mode "repeat" (Mook Workshop): roll() chỉ sinh 1 dice/lần gọi nên phải
        // gọi (1 gốc + N reuse) lần. mode "arg" (Thrust) tự sinh cả chuỗi → 1 lần.
        repeatTimes: skill.reuseSpec?.mode === "repeat" ? reuseTimesResolved + 1 : 1,
      });
      autoDmgStr = autoResult.dmgStr;
      // ❗ Indulgence in Prescript — "đòn có áp Sinking sẽ inflict thêm 2 count".
      // Cộng NGAY vào dmgStr, TỪNG DICE một (xem giải thích đầy đủ ở
      // `applyIndulgenceToDmgStr` trong skills.js). Đặt ở đây để con số Action
      // Log in ra CHÍNH LÀ con số được áp — lần sửa trước cộng lúc resolve nên
      // log vẫn hiện "+2Sinking" còn thực tế lại khác.
      // GIỮ NGUYÊN ngữ nghĩa cũ: CÓ Indulgence (>0 stack) ⇒ +2 count, KHÔNG nhân
      // theo số stack — đúng như code cũ ở resolve-pending-action.js và đúng chữ
      // hiện trong game "[+1 Indulgence in Prescript — đòn có áp Sinking sẽ
      // inflict thêm 2 count]". ⚠️ Nếu Fragaria muốn 2 stack = +4 count thì đổi
      // số 2 thành `2 * indulgenceInPrescript` — CHỈ ĐÚNG MỘT DÒNG NÀY.
      autoDmgStr = applyIndulgenceToDmgStr(autoDmgStr, (attacker?.indulgenceInPrescript ?? 0) > 0 ? 2 : 0);
      autoWarnings = autoResult.warnings;
      // Hiệu ứng KHÔNG đi qua dmgStr được (Fragile/Paralyze/giảm Stamina địch/
      // nhận Imitation-Light/hồi HP) — xem extractNonDmgStrEffects trong skills.js.
      autoSideEffects = autoResult.sideEffects ?? null;
      const header = skill.weaponOf
        ? `[🗡️ ${skill.weaponOf}] [CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`
        : skill.cost !== "—"
          ? `[${skill.cost}] [CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`
          : `[CD: ${skill.cd}] [Dice Mul: ${skill.diceMul}]`;
      const rollResult = {
        embed: { title: `🎲 ${skill.name}`, color: skill.embedColor ?? 0x5865f2, description: header + "\n\n" + annotateLinesWithEmotion(autoResult.lines, autoResult.tracked) },
        totalEmotionDelta: autoResult.totalEmotionDelta ?? 0,
      };
      if (hasParalyze) attacker.paralyze -= 1;
      if (hasChains) attacker.chains = false;
      // Busy as Tribbie (xác nhận trực tiếp): "mỗi khi sử dụng Page hoặc Critical
      // sẽ làm cho người buff nó tung ra một lần FUA [10~20][Blunt][Undodgeable].
      // Một turn chỉ kích một lần" — GIẢ ĐỊNH FUA nhắm THẲNG vào chính người mang
      // status này (xem comment đầy đủ ở combatant-factory.js). Undodgeable = trừ
      // THẲNG, không qua Guard/Evade/Parry — vẫn nhân đúng Res Blunt của target.
      if (attacker.busyAsTribbie && !attacker.busyAsTribbieTriggeredThisTurn) {
        const fuaRaw = r(10, 20);
        const resMatch = combatantResStr(attacker).match(/([\d.]+)xB/);
        const resB = resMatch ? parseFloat(resMatch[1]) : 1;
        const fuaDmg = Math.round(fuaRaw * resB * 1000) / 1000;
        attacker.currentHp = Math.max(0, attacker.currentHp - fuaDmg); // (skill-verification không có applyHpLoss — xem ghi chú HANDOFF)
        attacker.busyAsTribbieTriggeredThisTurn = true;
        busyAsTribbieNote = ` [💢Busy as Tribbie — FUA ${fuaDmg} dmg]`;
      }
      skillRollEmbed = rollResult.embed;
      emotionDelta = rollResult.totalEmotionDelta ?? 0;
      // orlandoFuriosoBypass — GAP ĐÃ SỬA (xác nhận trực tiếp): nếu ĐÚNG Critical
      // của vũ khí vừa swap qua, CD = 0 (miễn hoàn toàn) — flag trả về để CALLER
      // biết cần tiêu thụ (set false) bypass sau khi commit, không lặp lại lần sau.
      if (isOwnCriticalBypassed) {
        cooldownTurns = 0;
        busyAsTribbieNote += ` ⚡**Orlando Furioso** — Critical miễn CD (vừa swap vũ khí).`;
      } else {
        cooldownTurns = parseSkillCooldownTurns(skill.cd);
      }
    }
  
    if (refRaw && refRaw.trim()) {
      const idMatch = refRaw.trim().match(/(\d{15,20})\s*$/); // lấy ID số ở CUỐI chuỗi — khớp cả link đầy đủ và ID thô
      if (!idMatch) throw new Error(`ref: không hợp lệ — cần message ID hoặc link Discord (VD: dán link "Copy Message Link" của message roll skill).`);
      try {
        const channel = await client.channels.fetch(channelId);
        const fetchedMsg = await channel.messages.fetch(idMatch[1]);
        refLink = fetchedMsg.url ?? `https://discord.com/channels/@me/${channelId}/${idMatch[1]}`;
        const embedDesc = fetchedMsg.embeds?.[0]?.description;
        refSnippet = (embedDesc ?? fetchedMsg.content ?? "(không có nội dung text)").slice(0, 300);
      } catch {
        throw new Error(`Không tìm được message ref: "${refRaw}" — kiểm tra lại link/ID (phải là message trong CHANNEL này).`);
      }
    }
  
    return { skillRollEmbed, skillKey, cooldownTurns, emotionDelta, refSnippet, refLink, lightCost, sanityCost, busyAsTribbieNote, autoDmgStr, autoWarnings, autoSideEffects, orlandoFuriosoBypassConsumed: isOwnCriticalBypassed, effectiveBulletType, effectiveBulletCount };
  }

  return {
    parseSkillCooldownTurns,
    parseSkillCost,
    extractDefenseBypassTags,
    mergeDefenseBypassTags,
    forceStagger,
    resolveSkillVerification,
  };
};
