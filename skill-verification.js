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

module.exports = function ({ findSkill, hasPerk, isEgoSkill, buildSkillRollResult, client, ENCOUNTER_SANITY_MAX, r, combatantResStr }) {

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
   *  đang Stagger (giữ idempotent giống checkStaggerPanic). */
  function forceStagger(combatant) {
    if (!combatant.staggered) {
      combatant.staggered = true;
      combatant.staggerTurnsLeft = (combatant.dazedStacks ?? 0) >= 2 ? 2 : 1;
    }
  }
  
  async function resolveSkillVerification(channelId, attacker, skillNameRaw, refRaw, isCritical = false) {
    let skillRollEmbed = null, skillKey = null, cooldownTurns = 0, emotionDelta = 0, busyAsTribbieNote = "";
    let refSnippet = null, refLink = null;
    let lightCost = 0, sanityCost = 0;
  
    if (skillNameRaw && skillNameRaw.trim()) {
      const skill = findSkill(skillNameRaw.trim());
      if (!skill) throw new Error(`Không tìm thấy skill "${skillNameRaw}" — dùng \`-skill list\` để xem danh sách.`);
      if (skill.promptArg) throw new Error(`Skill "${skill.name}" cần input đặc biệt (VD: Light hiện tại) — chưa roll trực tiếp qua encounter được. Dùng \`-skill ${skillNameRaw}\` riêng rồi dán link message đó vào ref: thay vào đó.`);
      skillKey = skillNameRaw.trim().toLowerCase();
      const existingCd = attacker.skillCooldowns?.[skillKey] ?? 0;
      if (existingCd > 0) throw new Error(`Skill "${skill.name}" đang cooldown — còn ${existingCd} turn nữa.`);
      // Light/Sanity cost — đọc từ field cost của skill (xem parseSkillCost — CHỈ
      // match được pattern Light/Sanity rõ ràng, bỏ qua Heat Gauge/custom resource
      // khác). Tap Of The Light (Gloom, [10 Points]): giảm 1 NỬA Sanity Cost từ
      // E.G.O Page — chỉ áp khi skill này LÀ E.G.O (isEgoSkill), floor() để có lợi
      // cho player. CHECK ĐỦ TÀI NGUYÊN TRƯỚC KHI ROLL DICE — tránh tình huống roll
      // xong (tốn thời gian/RNG) mới phát hiện không đủ Light/Sanity.
      const parsedCost = parseSkillCost(skill.cost);
      lightCost = parsedCost.light ?? 0;
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
      const hasParalyze = (attacker.paralyze ?? 0) > 0;
      // Freeble (xác nhận trực tiếp): "giảm số dice bằng số count của MỌI skill
      // trong turn của kẻ địch" — trừ trực tiếp vào diceModifier (cùng cơ chế với
      // Dice Up/Down, r() đã tự clamp không dưới 1 — xem comment ở skills.js).
      // Tremor Chain (xác nhận trực tiếp): "giảm 1 điểm Dice với mỗi 10 Tremor có
      // trên bản thân" — LIÊN TỤC, dựa trên Tremor HIỆN TẠI của CHÍNH người đang
      // roll skill (không phải target).
      const tremorChainPenalty = (attacker.tremorChain ?? 0) > 0 ? Math.floor((attacker.tremor ?? 0) / 10) : 0;
      // BlackSilence/Struggling (xác nhận trực tiếp): "+4 Dice Up cho Critical của
      // vũ khí" — CHỈ áp khi đây là Critical (isCritical=true), không áp cho Page
      // thường.
      const blackSilenceCritBonus = isCritical && attacker.blackSilence ? 4 : 0;
      const diceModifier = (attacker.diceUp ?? 0) - (attacker.diceDown ?? 0) - (attacker.freeble ?? 0) - tremorChainPenalty + blackSilenceCritBonus;
      const rollResult = buildSkillRollResult({ skill, rollCount: 1, forceMinDice: hasParalyze, diceModifier });
      if (rollResult.error) throw new Error(rollResult.error);
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
        attacker.currentHp = Math.max(0, attacker.currentHp - fuaDmg);
        attacker.busyAsTribbieTriggeredThisTurn = true;
        busyAsTribbieNote = ` [💢Busy as Tribbie — FUA ${fuaDmg} dmg]`;
      }
      skillRollEmbed = rollResult.embed;
      emotionDelta = rollResult.totalEmotionDelta ?? 0;
      cooldownTurns = parseSkillCooldownTurns(skill.cd);
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
  
    return { skillRollEmbed, skillKey, cooldownTurns, emotionDelta, refSnippet, refLink, lightCost, sanityCost, busyAsTribbieNote };
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
