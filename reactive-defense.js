// reactive-defense.js
// Toàn bộ luồng "Reactive Defense" — tự động gửi prompt Guard/Evade/Parry
// ngay khi bị tấn công, xử lý kết thúc turn, thông báo turn hiện tại, các
// prompt phụ (Clash bên thứ 3, Your Shield, Dullahan Parry Counter) — TÁCH
// khỏi index.js theo yêu cầu trực tiếp: "tách nhỏ file index.js ra các file
// js khác" (code đã lên tới 11k+ dòng).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào) — chỉ bọc trong
// factory function nhận dependency từ index.js (giống pattern các module đã
// tách trước đó).

module.exports = function ({ extractDefenseBypassTags, getPlayerDataWithSlot, savePlayerData, applyHpLoss, applyShieldLoss, healHpCapped, grantShieldHp, appendActionLog, cdKeyFor, ActionRowBuilder, ButtonBuilder, ButtonStyle, POISE_MAX, WEAPON_DEFENSE_HITS, advanceCombatantTurn, advanceToNextTurnHolder, aiHooks, finalizeQuestOutcome, buildBossActionPanel, buildEncounterActionPanel, buildEncounterBoardEmbed, calcMathCore, checkStaggerPanic, client, combatantResStr, computeDefenseOptions, deleteEncounter, determineTurnOrder, encounterKey, findSkill, getEncounter, hasPerk, log, parsePerHitBypass, parseSkillCost, resolveCombatant, resolveOnePendingAction, saveEncounter, validateAndRerollPrescript, validateAndRerollPrescriptRound, withLock }) {

/** finalizeReactiveChoice — sau khi ĐÃ áp dụng 1 lựa chọn phòng thủ (guard/evade/
 *  parry/none, hoặc guardHitSelections/evadeHitSelections cho chọn hit cụ thể)
 *  lên target — tiếp tục luồng CHUNG: đánh dấu đã phản hồi, resolve NGAY nếu mọi
 *  target trong AOE đã xong, hoặc chờ tiếp nếu còn ai chưa bấm. TÁCH ra dùng
 *  chung cho CẢ encreactivedef (Parry/Không phòng thủ, áp dụng ngay) LẪN
 *  encreactivehits MỚI (Guard/Evade chọn hit cụ thể) — tránh trùng lặp logic. */
async function finalizeReactiveChoice(channelId, encounter, p, targetId, choiceNote, interactionUserMention) {
  const targetResolved = resolveCombatant(encounter, targetId);
  checkStaggerPanic(targetResolved.combatant);
  p.reactedTargetIds = p.reactedTargetIds ?? [];
  p.reactedTargetIds.push(targetId);
  const allTargetIds = p.targets.map(tg => tg.targetId);
  const allReacted = allTargetIds.every(tid => p.reactedTargetIds.includes(tid));
  let resultText, stillWaitingFor = null;
  if (allReacted) {
    const lines = await resolveOnePendingAction(encounter, p);
    encounter.pendingActions = (encounter.pendingActions ?? []).filter(pa => pa.id !== p.id);
    resultText = `${interactionUserMention} chọn **${choiceNote}**\n${lines.join("\n")}`;
  } else {
    resultText = `${interactionUserMention} chọn **${choiceNote}** — đang chờ ${allTargetIds.length - p.reactedTargetIds.length} người khác trong đòn AOE này.`;
    stillWaitingFor = allTargetIds.length - p.reactedTargetIds.length;
  }
  // ❗❗ BUG TÁI PHÁT LẦN 3 — NAY GOM VỀ MỘT CHỖ (Fragaria: "Furioso Replica sau
  // khi xài vẫn không thấy thông báo đổi BGM và gửi file lên, mà phải
  // -encounter status mới thấy").
  // GỐC lần này: `finalizeReactiveChoice` LÀ nơi đòn thật sự resolve, nhưng nó
  // có TỚI 6 nơi gọi (nút phòng thủ per-hit · Your Shield · Clash · rtparry ·
  // AI tự phòng thủ · AI clash/counter early-return). Lần trước tôi đi vá TỪNG
  // nơi ⇒ sót đúng nhánh AI clash/counter và nhánh Clash của người chơi.
  // NAY: chính hàm này lấy cờ BGM và TRẢ RA cho caller — thêm đường gọi mới sau
  // này cũng tự có, không thể sót nữa. Lấy TRƯỚC saveEncounter để cờ đã bị xoá
  // được ghi xuống Redis (không phát lại lần 2 sau restart).
  // ❗❗❗ BỌC try/catch — BÀI HỌC ĐẮT NHẤT CỦA LÔ NÀY (Fragaria: "Bị kẹt Furioso
  // ở encounter pending, tôi nghĩ lý do không ra BGM là đây" — ĐÚNG).
  // CHUỖI NHÂN QUẢ ĐẦY ĐỦ:
  //   `takePendingBgmFiles` ném ReferenceError (AttachmentBuilder ngoài scope)
  //   → ném NGAY TẠI ĐÂY, TRƯỚC `saveEncounter`
  //   → cả lượt phòng thủ abort, pendingAction KHÔNG bao giờ resolve
  //   → đòn Furioso treo ở `-encounter pending`, và vì không resolve nên cũng
  //     KHÔNG có BGM ⇒ đúng cái triệu chứng đã báo 3 lần.
  //   Chỉ Furioso dính, vì chỉ nó mới đặt cờ `bgmAnnounceNow` để hàm kia chạm
  //   tới nhánh có `AttachmentBuilder` — khớp chính xác "chỉ kẹt Furioso".
  // LỖ HỔNG THIẾT KẾ: BGM là thứ TRANG TRÍ, không được phép nằm trên đường
  // sống-chết của việc resolve đòn đánh. Nay hỏng BGM thì chỉ mất BGM.
  let bgm = { files: [], name: null };
  try {
    bgm = aiHooks.takePendingBgmFiles?.(encounter) ?? bgm;
  } catch (err) {
    log("error", "finalizeReactiveChoice-bgm", "system", err.message);
  }
  await saveEncounter(channelId, encounter);
  // PAYBACK — đòn phản do `resolveOnePendingAction` vừa sinh ra cần được gửi
  // prompt phòng thủ. Đặt ở ĐÂY (trong hàm) chứ không ở 6 nơi gọi — đúng bài
  // học BGM §K: thứ gì mọi caller đều cần thì cho HÀM ĐÓ lo, thêm caller mới
  // sau này tự có. Fire-and-forget vì `drainAwaitingPrompts` tự lấy lock riêng,
  // mà lúc này caller có thể còn đang giữ lock (withLock KHÔNG re-entrant).
  // PHẢI đứng SAU saveEncounter: drain đọc encounter TƯƠI từ Redis.
  drainAwaitingPrompts(channelId).catch(() => {});
  // Stage 5 (quest system) — encounter._deleteAfterSave được resolveOnePendingAction
  // đánh dấu khi quest vừa kết thúc (thắng/thua) — XOÁ NGAY SAU KHI save (thứ tự
  // quan trọng: save trước để giữ lại state cuối cùng — HP/reward đã áp — rồi mới
  // xoá, tránh save-sau-xoá vô tình tạo lại encounter đã kết thúc).
  if (encounter._deleteAfterSave) {
    await deleteEncounter(channelId).catch((err) => log("error", "reactivedef-deleteEncounter", "system", err.message));
    return { resultText, stillWaitingFor, bgm };
  }
  // Stage 4 hook — nếu đòn VỪA resolve xong (allReacted) do 1 enemy aiControlled
  // TỰ tấn công (attackerType "enemy"), báo cho AI biết để tự cân nhắc hành động
  // TIẾP THEO (skill/M1 khác) hay pass lượt — attemptOneMobAction chỉ thử ĐÚNG 1
  // hành động mỗi lần gọi (xem comment đầy đủ ở enemy-ai.js's maybeRunAiTurn) vì
  // phải đợi CHÍNH đòn này resolve xong (hasUnresolvedTargetPending) mới thử
  // tiếp được — đây CHÍNH LÀ điểm "resolve xong" đó.
  if (allReacted && p.attackerType === "enemy" && encounter.enemies[p.attackerId]?.aiControlled) {
    aiHooks.maybeRunAiTurn(channelId).catch(() => {});
  }
  return { resultText, stillWaitingFor, bgm };
}

/** sendReactiveDefensePrompt — Yu-Gi-Oh Chain-style: khi A tấn công B, gửi NGAY
 *  1 message với nút phòng thủ cho B (xác nhận trực tiếp: "khi bị tấn công thì
 *  mới hiện ra hành động phòng thủ... check coi đủ sta để làm hành động đó
 *  không"). Dùng customId (KHÔNG dùng collector) — pendingAction vẫn nằm trong
 *  Redis nên nút vẫn hoạt động dù bot restart giữa chừng (đợi "vô thời hạn" một
 *  cách AN TOÀN, không cần giữ 1 Promise treo trong bộ nhớ process).
 *  targetUserId=null nghĩa là target là ENEMY (GM bấm thay) — vẫn gửi prompt
 *  nhưng filter cho phép GM/admin bấm thay vì đúng targetUserId. */
/** announceCurrentTurn — Turn Order Enforcement UX (xác nhận trực tiếp): "lúc
 *  xong endturn thì encounter nên tự cập nhật lại để player bấm tiếp" — TỰ ĐỘNG
 *  gửi dropdown hành động cho ĐÚNG người/enemy đang tới lượt, thay vì bắt họ tự
 *  gõ `-encounter status` lại để lấy dropdown mới mỗi lần. Player → gửi trong
 *  kênh encounter (mention họ). Enemy → route tới gmChannelId nếu đã link (GM
 *  điều khiển thay), cùng logic routing với sendReactiveDefensePrompt. Không
 *  throw gì cả — lỗi gửi message không nên làm hỏng flow chính (fire-and-forget). */
/** performEndTurn — TÁCH từ thân lệnh text `-encounter endturn` (giữ NGUYÊN 100%
 *  logic không đổi 1 dòng nào) — dùng LẠI được cho CẢ lệnh text LẪN nút bấm UI
 *  mới "🔄 Kết thúc Turn" (xem announceCurrentTurn/handler customId "encendturn:").
 *  Throw Error nếu không hợp lệ (không có quyền, còn pending action...) — CALLER
 *  tự bắt và hiển thị theo cách phù hợp (reply text hay update embed nút bấm). */
async function performEndTurn(channelId, userId, isAdmin) {
  let resultInfo;
  await withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    if (!isAdmin && userId !== encounter.gmId) throw new Error("Chỉ GM (hoặc admin) mới được kết thúc turn.");
    if ((encounter.pendingActions ?? []).length > 0) throw new Error(`Còn ${encounter.pendingActions.length} action chưa xử lý — dùng \`-encounter pending\` để confirm/reject hết trước khi qua turn.`);
    const anyEnemyStaggered = Object.values(encounter.enemies).some(e => e.staggered);
    // Dòng thông báo phát sinh trong lúc kết thúc turn (VD Astral Quantization
    // cần người buff chọn mục tiêu) — gộp vào shroudedNotes ở cuối.
    const endLines = [];
    const shroudedNotes = [];
    if (anyEnemyStaggered) {
      for (const pid of Object.keys(encounter.players)) {
        const pl = encounter.players[pid];
        if (hasPerk(pl, "Shrouded Power")) {
          pl.poise = Math.min(POISE_MAX, pl.poise + 4);
          shroudedNotes.push(`<@${pid}> +4 Poise (Shrouded Power)`);
        }
      }
    }
    // ⚠️ THỨ TỰ BẮT BUỘC: 2 khối dưới phải chạy TRƯỚC vòng advanceCombatantTurn.
    // advanceCombatantTurn RESET `dmgDealtThisTurn` và `shieldLostThisTurn` về 0 —
    // đặt sau nó thì Astral Quantization và Swan Song LUÔN ra 0. (Tôi đã chèn
    // nhầm xuống dưới đúng 1 lần, test t-player-gear.js bắt được.)
    // ── ASTRAL QUANTIZATION — bắn dmg TRÌ HOÃN ────────────────────────────
    // Fragaria đính chính: *"turn đó nếu đồng đội đánh 3 kẻ địch mỗi kẻ 100 dmg
    // và Astral Quantization gieo ra 30 thì TOÀN BỘ 3 kẻ đó sẽ chịu thêm 30 dmg
    // vào end turn"*.
    // → % tính RIÊNG cho TỪNG kẻ địch, trên dmg mà đồng đội gây cho CHÍNH kẻ đó,
    //   và đánh TẤT CẢ kẻ địch đã bị đồng đội đánh — KHÔNG phải 1 mục tiêu, cũng
    //   không phải % của TỔNG dmg (bản đầu của tôi sai cả hai).
    // Chạy TRƯỚC advanceCombatantTurn (reset bộ đếm) và trước Swan Song — dmg này
    // có thể phá khiên, phải tính vào lượng khiên mất để Swan Song hồi đúng.
    if ((encounter.pendingAstralQuantization ?? []).length > 0) {
      // ❗❗ LUẬT ĐÃ ĐỔI (Fragaria 12/08 đưa lại nguyên văn card):
      //   "Chỉ định một đồng đội có Shield HP, và roll dice [1-30]. Cuối turn,
      //    gây sát thương lên MỘT đối thủ bằng TỔNG [kết quả dice]% DMG mà đồng
      //    đội được chỉ định đã gây ra trong turn này."
      //   "…ở cuối Turn Order trước khi kết thúc sẽ cho NGƯỜI BUFF Astral
      //    Quantization (không phải người nhận buff) chỉ định nó."
      // ⚠️ ĐIỀU NÀY THAY THẾ luật cũ tôi đang chạy ("mỗi kẻ địch đã bị đồng đội
      //    đánh đều chịu % dmg RIÊNG của chính nó"). Hai luật MÂU THUẪN nhau —
      //    tôi theo bản MỚI vì Fragaria vừa chốt lại kèm nguyên văn card.
      // Số tiền dmg phải CHỐT TẠI ĐÂY (trước advanceCombatantTurn reset
      // `dmgDealtThisTurn`), còn việc CHỌN mục tiêu thì hỏi người buff.
      encounter.pendingAstralChoice = encounter.pendingAstralChoice ?? [];
      for (const aq of encounter.pendingAstralQuantization) {
        const ally = encounter.players?.[aq.allyId];
        const totalDealt = Object.values(ally?.dmgDealtByTargetThisTurn ?? {})
          .reduce((sum, v) => sum + (Number(v) || 0), 0);
        const amount = Math.round(totalDealt * (aq.pct / 100) * 1000) / 1000;
        const foesAlive = Object.entries(encounter.enemies ?? {})
          .filter(([, e]) => (e?.currentHp ?? 0) > 0).map(([k]) => k);
        if (!(amount > 0) || foesAlive.length === 0) {
          appendActionLog(encounter,
            `🌌 **Astral Quantization** (<@${aq.userId}>) — <@${aq.allyId}> không gây dmg nào trong turn này, không có gì để bắn.`);
          continue;
        }
        if (foesAlive.length === 1) {
          // Chỉ 1 mục tiêu ⇒ không cần hỏi, bắn luôn (đỡ 1 nhịp chờ vô nghĩa).
          const foe = encounter.enemies[foesAlive[0]];
          const absorbed = applyShieldLoss(foe, Math.min(foe.shieldHp ?? 0, amount));
          applyHpLoss(foe, amount - absorbed);
          appendActionLog(encounter,
            `🌌 **Astral Quantization** (<@${aq.userId}>) — **${aq.pct}%** tổng dmg của <@${aq.allyId}> (${totalDealt.toFixed(1)}) → **${foe.name}** chịu **${amount}**.`);
          continue;
        }
        // Nhiều mục tiêu ⇒ để NGƯỜI BUFF chọn. Lưu lại, UI bắn dropdown ở
        // interaction-handlers.js (`astraltarget:`).
        encounter.pendingAstralChoice.push({
          userId: aq.userId, allyId: aq.allyId, pct: aq.pct, amount,
          totalDealt: Math.round(totalDealt * 1000) / 1000,
        });
        endLines.push(`🌌 <@${aq.userId}> — **Astral Quantization** đã sẵn sàng (**${amount}** dmg = ${aq.pct}% tổng dmg của <@${aq.allyId}>). Chọn mục tiêu bên dưới.`);
      }
      encounter.pendingAstralQuantization = [];
      if (endLines.length > 0) shroudedNotes.push(...endLines);
    }
    // ── SWAN SONG (Lucent Historia) ──────────────────────────────────────
    // "CUỐI TURN, bản thân và đồng đội hồi phục một lượng HP bằng **20% lượng
    // Shield HP ĐÃ MẤT trong turn này**."
    // Chạy TRƯỚC advanceCombatantTurn ở dưới — hàm đó reset `shieldLostThisTurn`
    // về 0, tính sau là luôn hồi 0.
    // Mỗi người hồi theo khiên CHÍNH MÌNH mất (không phải tổng cả đội) — đọc
    // đúng chữ "bản thân VÀ đồng đội hồi ... 20% lượng Shield HP đã mất".
    {
      const hasSwanSong = Object.values(encounter.players ?? {})
        .some(pl => pl.weaponName === "Lucent Historia" && (pl.currentHp ?? 0) > 0);
      if (hasSwanSong) {
        const healed = [];
        for (const [pid, pl] of Object.entries(encounter.players ?? {})) {
          const lost = pl.shieldLostThisTurn ?? 0;
          if (lost <= 0 || (pl.currentHp ?? 0) <= 0) continue;
          const got = healHpCapped(pl, Math.round(lost * 0.2 * 1000) / 1000);
          if (got > 0) healed.push(`<@${pid}> +${got} HP`);
        }
        if (healed.length > 0) {
          appendActionLog(encounter, `🦢 **Swan Song** — hồi 20% Shield đã mất: ${healed.join(", ")}`);
        }
      }
    }

    // ── LƯỚI AN TOÀN: aura "Day One of My New Life" ────────────────────────
    // Fragaria: "giảm res của Compassion và Day One CHƯA HOẠT ĐỘNG trong trận".
    // GỐC: cờ `dayOneAuraActive` CHỈ được đặt ở hook bắt đầu trận của party-board.
    // Ai vào trận bằng đường khác (`-encounter join`, thêm giữa trận, revive…)
    // thì cờ không bao giờ được đặt ⇒ aura mất hẳn.
    // Tính LẠI mỗi vòng turn: ai còn sống mà đội nón thì cả đội có aura, người
    // đội nón rời sân/chết thì aura tự tắt — đúng luật "khi bạn còn trên sân".
    {
      const alive = Object.values(encounter.players ?? {});
      const auraOn = alive.some(c => c.hasDayOneAura && (c.currentHp ?? 0) > 0);
      for (const c of alive) c.dayOneAuraActive = auraOn;
      // Lone Fixer (Dawn Office - Yuna) cần biết còn bao nhiêu người sống. Bơm vào
      // đây — cùng chỗ, cùng nhịp với aura Day One, để hai thứ không lệch vòng.
      const aliveCount = alive.filter(c => (c.currentHp ?? 0) > 0).length;
      for (const c of alive) c._alivePlayerCount = aliveCount;
    }
    for (const ekey of Object.keys(encounter.enemies)) advanceCombatantTurn(encounter.enemies[ekey]);
    for (const pid of Object.keys(encounter.players)) advanceCombatantTurn(encounter.players[pid]);

    // ── GOM CÁC "NOTE" SỰ KIỆN ────────────────────────────────────────────────
    // ❗ 7 cờ ghi chú (shinRienNote, maskBrokenNote, manifestEndNote,
    // compassionSyncNote, theStrongestPenaltyNote, deathFlavor,
    // accessoryDupWarning) TRƯỚC ĐÂY được GHI mà **KHÔNG NƠI NÀO ĐỌC** ⇒ người
    // chơi không hề biết Shin - Rien đã kích hoạt, mặt nạ đã vỡ, Manifest đã hết,
    // hay bị phạt Stamina. Đúng lớp lỗi "ghi-mà-không-đọc" đã dính nhiều lần.
    // Gom tại ĐÂY — mốc kết thúc turn, chạy cho mọi combatant, một chỗ duy nhất.
    // ── ĐỒNG BỘ HP VỀ PROFILE ────────────────────────────────────────────────
    // ❗ BUG ĐÃ SỬA (Fragaria: "đang 150 HP, được heal lên 165 nhờ Emotion Level 1
    // thì khi hết encounter LẠI LƯU 150").
    // GỐC: HP chỉ được sync ở nhánh **BỊ ĐÁNH** (resolve-pending-action) — mọi
    // nguồn HỒI (Emotion Level, healHpCapped, Perfect Cube, Regen, page heal…)
    // KHÔNG có đường nào ghi ngược về profile.
    // Nay sync ở mốc KẾT THÚC TURN — chạy cho MỌI người chơi, bắt được mọi nguồn
    // thay đổi HP bất kể đến từ đâu.
    for (const [pid, c] of Object.entries(encounter.players ?? {})) {
      try {
        const { data: hpD, slot: hpS } = await getPlayerDataWithSlot(pid);
        // `compassionPhantomHp` là máu ẢO chỉ tồn tại trong trận — trừ ra trước
        // khi lưu, nếu không profile sẽ phình Max HP sau mỗi trận.
        const realHp = Math.max(0, Math.round((c.currentHp ?? 0) * 100) / 100);
        if (hpD.currentHp !== realHp) {
          hpD.currentHp = realHp;
          hpD.hpLastResetCheck = Date.now();
          await savePlayerData(pid, hpD, hpS);
        }
      } catch { /* sync HP lỗi không được chặn việc kết thúc turn */ }
    }
    for (const [pid, c] of Object.entries(encounter.players ?? {})) {
      for (const key of ["shinRienNote", "maskBrokenNote", "manifestEndNote",
                         "compassionSyncNote", "theStrongestPenaltyNote", "accessoryDupWarning"]) {
        if (c[key]) { shroudedNotes.push(`<@${pid}> ${String(c[key]).trim()}`); c[key] = null; }
      }
      if ((c.shinRienBlockedDmg ?? 0) > 0) {
        shroudedNotes.push(`<@${pid}> 🩸 **Shin - Rien** đã chặn **${Math.round(c.shinRienBlockedDmg)}** dmg trong turn này.`);
      }
    }
    for (const [ekey, c] of Object.entries(encounter.enemies ?? {})) {
      for (const key of ["manifestEndNote", "staggerForcedNote"]) {
        if (c[key]) { shroudedNotes.push(`**${c.name ?? ekey}** ${String(c[key]).trim()}`); c[key] = null; }
      }
    }
    // Sắc lệnh (Index) — chấm + roll lại theo VÒNG TURN ORDER, không theo lượt
    // riêng từng người (xem validateAndRerollPrescriptRound trong combat-utils.js).
    const roundPrescriptNotes = validateAndRerollPrescriptRound(encounter);
    if (roundPrescriptNotes.length > 0) {
      encounter.pendingPrescriptNotes = (encounter.pendingPrescriptNotes ?? []).concat(roundPrescriptNotes);
    }
    // "You're Too Slow" — ĐỔI LUỒNG (Fragaria yêu cầu: đánh dấu → hiện option ở
    // Moves → tự bấm để đâm → LÚC ĐÓ mới vào CD). Bản cũ tự bắn lại ở turn kế
    // (youreTooSlowPending) đã bỏ — xem express-routes.js.
    // Dấu (youreTooSlowMark) KHÔNG tự xoá theo turn: người chơi giữ quyền chọn
    // thời điểm đâm. Chỉ xoá khi đâm xong, hoặc khi mục tiêu đã gục (dọn ở đây
    // để dropdown Moves không hiện option trỏ vào xác chết).
    for (const c of [...Object.values(encounter.enemies), ...Object.values(encounter.players)]) {
      if (!c.youreTooSlowMark) continue;
      const markedResolved = resolveCombatant(encounter, c.youreTooSlowMark.markedTargetId);
      if (!markedResolved || markedResolved.combatant.currentHp <= 0) c.youreTooSlowMark = null;
    }
    encounter.turnNumber = (encounter.turnNumber ?? 1) + 1;
    let prescriptNotes = [];
    if (Object.keys(encounter.enemies).length + Object.keys(encounter.players).length > 0) {
      determineTurnOrder(encounter);
      // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — "-encounter
      // endturn" (round-level, roll Speed MỚI cho vòng mới) cũng cần khởi tạo
      // prescriptRoll/prescriptTargetId cho người ĐẦU TIÊN của vòng mới, giống
      // hệt rollspeed (không đi qua advanceToNextTurnHolder nên cần gọi riêng).
      prescriptNotes = validateAndRerollPrescript(encounter, null, encounter.turnOrder[0] ?? null);
    }
    // Task yêu cầu trực tiếp: "prescript chỉ tổng kết khi turnorder end chứ
    // không phải endturn của player" — gộp TẤT CẢ prescriptNotes đã tích luỹ từ
    // các lần pass/endmyturn CÁ NHÂN trong suốt round VỪA XONG (encounter.
    // pendingPrescriptNotes — xem combat-utils.js's advanceToNextTurnHolder)
    // vào ĐÂY, hiện 1 lần DUY NHẤT ở tổng kết round-end thật, rồi clear để
    // round tiếp theo tích luỹ mới từ đầu.
    const accumulatedPrescriptNotes = encounter.pendingPrescriptNotes ?? [];
    encounter.pendingPrescriptNotes = [];
    prescriptNotes = [...accumulatedPrescriptNotes, ...prescriptNotes];
    // BUG ĐÃ SỬA (Fragaria báo trực tiếp: "sau khi gm dùng turn end order thì
    // contract không thể tự động end encounter được") — check thắng/thua CHỈ
    // từng chạy bên trong resolveOnePendingAction, nên mọi đường kết thúc KHÁC
    // đều bị bỏ sót: GM bấm kết thúc turn thủ công, hoặc mob/player cuối cùng
    // chết vì DoT tick (Bleed/Burn/Rupture) trong advanceCombatantTurn NGAY Ở
    // TRÊN — chứ không phải vì một đòn đánh. Giờ check ở đây luôn, dùng CHUNG
    // hàm finalizeQuestOutcome với resolveOnePendingAction (không copy logic).
    // Đặt SAU advanceCombatantTurn/determineTurnOrder để đọc đúng HP sau DoT.
    const questEndLines = await finalizeQuestOutcome(encounter);
    await saveEncounter(channelId, encounter);
    if (encounter._deleteAfterSave) {
      // Thứ tự BẮT BUỘC: save trước (giữ state cuối — HP/reward đã áp) rồi mới
      // xoá, tránh save-sau-xoá vô tình tạo lại encounter đã kết thúc.
      const endChannel = await client.channels.fetch(channelId).catch(() => null);
      if (endChannel && questEndLines.length > 0) {
        await endChannel.send({ embeds: [{ title: "🏁 Contract kết thúc", description: questEndLines.join("\n"), color: 0xf1c40f }] }).catch(() => {});
      }
      await deleteEncounter(channelId).catch((err) => log("error", "endturn-deleteEncounter", "system", err.message));
      resultInfo = { encounter, shroudedNotes, prescriptNotes, questEndLines, questEnded: true };
      return;
    }
    announceCurrentTurn(channelId, encounter, true).catch(() => {});
    resultInfo = { encounter, shroudedNotes, prescriptNotes, questEndLines, questEnded: false };
  });
  return resultInfo;
}

async function announceCurrentTurn(channelId, encounter, forceNewMessage = false) {
  try {
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "có cách nào để nó tự động update vào
    // tin nhắn cũ không") — THAY VÌ gửi tin nhắn MỚI mỗi lần 1 người xong lượt
    // (gây trôi chat với trận 4-5 người), giờ EDIT LẠI đúng 1 tin nhắn board
    // duy nhất (encounter.boardMessageId) — chỉ gửi mới khi CHƯA có, hoặc edit
    // thất bại (tin nhắn bị xoá/quá cũ...).
    // GAP ĐÃ SỬA THÊM (xác nhận trực tiếp: "Chỗ kết thúc turn order này nên
    // update ra encounter status để tiện theo dõi" — vì edit-in-place không
    // "nhảy xuống cuối chat", board bị trôi lên trên khi có tin nhắn khác chen
    // vào giữa) — forceNewMessage=true (CHỈ dùng ở performEndTurn, mốc hết 1
    // vòng round — không phải mọi lần chuyển turn bình thường, để không quay
    // lại tình trạng spam đã sửa trước đó) LUÔN gửi tin nhắn MỚI (nhảy xuống
    // cuối chat), rồi các lần edit-in-place SAU đó nhắm vào đúng tin nhắn MỚI
    // này (boardMessageId cập nhật lại).
    const mainChannel = await client.channels.fetch(channelId).catch(() => null);
    if (mainChannel) {
      const boardPayload = buildEncounterBoardEmbed(encounter, channelId);
      let edited = false;
      if (!forceNewMessage && encounter.boardMessageId) {
        const oldMsg = await mainChannel.messages.fetch(encounter.boardMessageId).catch(() => null);
        if (oldMsg) {
          await oldMsg.edit({ embeds: [boardPayload.embed], components: boardPayload.components }).catch(() => {});
          edited = true;
        }
      }
      if (!edited) {
        const newMsg = await mainChannel.send({ embeds: [boardPayload.embed], components: boardPayload.components }).catch(() => null);
        if (newMsg) {
          // Lưu lại ID tin nhắn mới — dùng withLock để tránh ghi đè mất
          // trạng thái mới hơn nếu có hành động khác xảy ra đồng thời.
          await withLock(encounterKey(channelId), async () => {
            const fresh = await getEncounter(channelId);
            if (fresh) { fresh.boardMessageId = newMsg.id; await saveEncounter(channelId, fresh); }
          }).catch(() => {});
        }
      }
    }
    const order = encounter.turnOrder ?? [];
    const entry = order[encounter.currentTurnIndex ?? 0];
    if (!entry) {
      // Quest system (-contract) — yêu cầu trực tiếp: "mục đích của nó là hoàn
      // toàn tự động hóa cho player farm... GM không phải lúc nào cũng có mặt
      // được" — TỰ ĐỘNG gọi performEndTurn (không chờ bấm nút thủ công) khi hết
      // 1 vòng turnOrder, CHỈ áp dụng cho encounter.isQuest (encounter GM thường
      // vẫn giữ nguyên hành vi cũ — cần bấm nút, vì GM có mặt điều khiển thật).
      //
      // ĐIỀU KIỆN CHÍNH XÁC (xác nhận trực tiếp): CHỈ tự end turn khi (1) TẤT
      // CẢ combatant đã hành động xong lượt của mình (currentTurnIndex vượt
      // quá cuối turnOrder — chính là "!entry" ở check phía trên, xảy ra khi
      // MỌI người — cả AI lẫn người thật — đã tự pass/kết thúc lượt) VÀ (2)
      // KHÔNG còn pendingActions nào tồn dư (VD: AOE nhắm nhiều người, 1 vài
      // người vẫn CHƯA phản hồi Guard/Evade/Parry dù đã qua lượt họ) — check
      // TƯỜNG MINH (2) ở đây TRƯỚC khi gọi, thay vì chỉ dựa vào performEndTurn
      // tự throw rồi catch ngầm — rõ ràng hơn cho người đọc code sau này, dù
      // hành vi thực tế giống hệt (performEndTurn vẫn tự check lại 1 lần nữa,
      // an toàn kép).
      if (encounter.isQuest && (encounter.pendingActions ?? []).length === 0) {
        try {
          await performEndTurn(channelId, encounter.gmId, true);
          aiHooks.maybeRunAiTurn(channelId).catch(() => {});
        } catch {
          // Trường hợp hiếm (race condition — pendingAction MỚI vừa được tạo
          // ngay giữa lúc check (2) và lúc gọi performEndTurn thật) — bỏ qua
          // lần này, hook sẽ tự trigger lại khi action đó resolve xong.
        }
        return;
      }
      // Quest CÒN pendingAction tồn dư (chưa đủ điều kiện tự end turn) — KHÔNG
      // làm gì cả (không gửi nút thủ công cho quest, vì không có GM thật để bấm)
      // — hook sẽ tự re-check lại điều kiện này ngay khi pendingAction đó
      // resolve xong (finalizeReactiveChoice's hook → maybeRunAiTurn →
      // announceCurrentTurn nếu cần).
      if (encounter.isQuest) return;
      // Turn Order Enforcement UX (xác nhận trực tiếp): "không có nút end turn
      // các thứ như 1 game rpg thực thụ" — hết 1 vòng turnOrder, thay vì im lặng
      // (bắt GM tự nhớ gõ lệnh text), gửi NGAY 1 nút bấm rõ ràng cho GM.
      const targetChannelId = encounter.gmChannelId || channelId;
      const channel = await client.channels.fetch(targetChannelId).catch(() => null);
      if (!channel) return;
      await channel.send({
        content: `<@${encounter.gmId}>`,
        embeds: [{ title: "🔄 Hết 1 vòng Turn Order!", description: "Mọi người đã hành động xong — bấm để kết thúc turn (hồi Stamina, đếm ngược status, roll lại Speed):", color: 0x9b59b6 }],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`encendturn:${channelId}:${encounter.gmId}`).setLabel("🔄 Kết thúc Turn").setStyle(ButtonStyle.Success),
        )],
      }).catch(() => {});
      return;
    }
    // BUG NGHIÊM TRỌNG ĐÃ SỬA (Fragaria báo trực tiếp: "khi có player bị Stagger
    // thì Contract bị treo") — LẦN 2 của lớp bug Stagger, KHÁC chỗ với lần trước
    // (lần trước là thiếu hook AI ở nhánh auto-resolve; lần này là con trỏ lượt).
    //
    // NGUYÊN NHÂN GỐC: `advanceToNextTurnHolder` CÓ bỏ qua người đang Stagger,
    // nhưng nó chỉ chạy LÚC ADVANCE. Người chơi hoàn toàn có thể bị Stagger SAU
    // khi con trỏ đã dừng ở họ (VD: mob đánh họ, họ Guard, Stamina về 0 → Stagger
    // — tất cả xảy ra trong lượt của MOB, trước khi tới lượt họ).
    // Khi đó `announceCurrentTurn` vẫn gửi panel hành động cho họ, nhưng MỌI lựa
    // chọn đều bị chặn ("Bạn đang bị Stagger") trừ "Kết thúc lượt". Với Contract
    // (isQuest) — nơi thiết kế là KHÔNG có GM và phải tự động hoàn toàn — không
    // ai bấm hộ, nên trận đứng im vĩnh viễn.
    //
    // SỬA: người giữ lượt hiện tại mà đã gục HOẶC đang Stagger thì TỰ ĐỘNG nhảy
    // qua ngay tại đây, rồi gọi lại chính mình để announce người kế tiếp. Vòng
    // lặp KHÔNG thể vô hạn: advanceToNextTurnHolder luôn tăng currentTurnIndex,
    // chạm cuối turnOrder thì `!entry` ở trên xử lý (tự end-turn cho quest).
    const entryCombatant = entry.type === "enemy" ? encounter.enemies[entry.id] : encounter.players[entry.id];
    if (entryCombatant && (entryCombatant.currentHp <= 0 || entryCombatant.staggered)) {
      const reason = entryCombatant.currentHp <= 0 ? "đã gục" : "đang Stagger";
      const label = entry.type === "enemy" ? `**${entryCombatant.name}**` : `<@${entry.id}>`;
      let advancedEnc = null;
      await withLock(encounterKey(channelId), async () => {
        const fresh = await getEncounter(channelId);
        if (!fresh) return;
        // Đọc LẠI trong lock — trạng thái có thể đã đổi giữa lúc check ngoài lock.
        const freshEntry = (fresh.turnOrder ?? [])[fresh.currentTurnIndex ?? 0];
        if (!freshEntry || freshEntry.id !== entry.id) return; // ai đó đã advance rồi
        const c = freshEntry.type === "enemy" ? fresh.enemies[freshEntry.id] : fresh.players[freshEntry.id];
        if (!c || (c.currentHp > 0 && !c.staggered)) return; // đã hồi phục, không cần nhảy
        advanceToNextTurnHolder(fresh);
        await saveEncounter(channelId, fresh);
        advancedEnc = fresh;
      });
      if (advancedEnc) {
        const chSkip = await client.channels.fetch(channelId).catch(() => null);
        if (chSkip) await chSkip.send({ content: `⏭️ ${label} ${reason} — tự động bỏ qua lượt.` }).catch(() => {});
        announceCurrentTurn(channelId, advancedEnc, true).catch(() => {});
      }
      return;
    }
    if (entry.type === "player") {
      const player = encounter.players[entry.id];
      if (!player || player.currentHp <= 0) return;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) return;
      await channel.send({
        content: `<@${entry.id}>`,
        embeds: [{ title: "🎲 Tới lượt bạn!", description: `Speed **${entry.speed}** — chọn hành động:`, color: 0x3498db }],
        components: buildEncounterActionPanel(channelId, player, entry.id),
      }).catch(() => {});
    } else {
      const enemy = encounter.enemies[entry.id];
      if (!enemy || enemy.currentHp <= 0) return;
      // BUG THẬT phát hiện qua test thật (Fragaria báo trực tiếp kèm ảnh chụp
      // màn hình) — nhánh này trước đây LUÔN gửi panel "Điều khiển <tên>..." +
      // ping GM cho MỌI lượt enemy, KHÔNG kiểm tra enemy.aiControlled — khiến
      // host của party board (tự động thành encounter.gmId) vẫn thấy và bấm
      // điều khiển thủ công được mob lẽ ra phải 100% tự động (Stage 3-4). AI đã
      // tự xử lý lượt này qua maybeRunAiTurn (hook riêng, xem message-create-
      // handler.js/party-board.js/enemy-ai.js) — không cần và không nên gửi
      // panel thủ công nữa, tránh vừa gây hiểu lầm vừa có thể xung đột (2 nguồn
      // cùng hành động cho 1 turn).
      if (enemy.aiControlled) return;
      const targetChannelId = encounter.gmChannelId || channelId;
      const channel = await client.channels.fetch(targetChannelId).catch(() => null);
      if (!channel) return;
      await channel.send({
        content: `<@${encounter.gmId}>`,
        embeds: [{ title: `🎲 Tới lượt ${enemy.name}!`, description: `Speed **${entry.speed}** — chọn hành động:`, color: 0xe74c3c }],
        components: buildBossActionPanel(channelId, entry.id, encounter.gmId),
      }).catch(() => {});
    }
  } catch (err) {
    log("error", "announceCurrentTurn", "system", err.message);
  }
}

// GAP ĐÃ SỬA (tách thành hàm dùng chung — REDESIGN per-hit vẫn cần logic
// Clash-hộ-bên-thứ-3 y hệt Eye Of Horus fixedBurst flow, tránh trùng lặp code).
async function sendThirdPartyClashPrompts(encounter, channelId, channel, p, t, attacker, isM1Type) {
  const targetResolved = resolveCombatant(encounter, t.targetId);
  if (!targetResolved) return;
  const allCombatantEntries = [
    ...Object.keys(encounter.enemies).map(k => ({ id: k, combatant: encounter.enemies[k], type: "enemy" })),
    ...Object.keys(encounter.players).map(k => ({ id: k, combatant: encounter.players[k], type: "player" })),
  ];
  for (const entry of allCombatantEntries) {
    if (entry.id === p.attackerId || entry.id === t.targetId) continue;
    // GAP ĐÃ SỬA (xác nhận trực tiếp): "bug có thể clash hộ cho kẻ địch" —
    // trước đây KHÔNG check phe, nên bất kỳ ai (kể cả phe ĐỊCH của target,
    // tức đồng minh của attacker) speed cao hơn đều được mời Clash-hộ. Chỉ
    // ĐỒNG MINH THẬT của target (cùng type với target) mới được mời.
    if (entry.type !== t.targetType) continue;
    if ((entry.combatant.currentSpeed ?? -Infinity) <= (attacker.combatant.currentSpeed ?? Infinity)) continue;
    const isThirdPartyEnemy = entry.type === "enemy";
    let thirdPartyChannel = channel;
    let thirdPartyMention = `<@${entry.id}>`;
    if (isThirdPartyEnemy && encounter.gmChannelId) {
      const gmCh = await client.channels.fetch(encounter.gmChannelId).catch(() => null);
      if (gmCh) { thirdPartyChannel = gmCh; thirdPartyMention = `GM (${entry.combatant.name})`; }
    }
    await thirdPartyChannel.send({
      content: thirdPartyMention,
      embeds: [{
        title: "⚔️ Có thể Clash để đỡ hộ!",
        description: `${attacker.label} tấn công ${targetResolved.label} bằng \`${p.dmgStr}\` — bạn (${entry.combatant.name ?? entry.id}) có Speed cao hơn, có thể Clash THAY cho ${targetResolved.label}. Nếu thắng, đòn này bị ngắt hoàn toàn — ${targetResolved.label} không ăn dmg.`,
        color: 0x3498db,
      }],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${p.id}:${t.targetId}:clash:${entry.id}`)
          .setLabel(`⚔️ Clash thay cho ${targetResolved.label}${unbreakableNote}`)
          .setStyle(ButtonStyle.Primary),
        // "hãy thêm lựa chọn không clash, tức là nút hủy" (xác nhận trực
        // tiếp, theo tester) — không làm gì cả, chỉ ẩn prompt này đi.
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${p.id}:${t.targetId}:clashdecline:${entry.id}`)
          .setLabel(`❌ Không Clash`)
          .setStyle(ButtonStyle.Secondary),
      )],
    }).catch(() => {});
  }
}

// GAP ĐÃ SỬA (dự án tự động hoá weapon passive còn lại — xác nhận trực tiếp:
// "Your Shield: block đòn thay cho một đồng đội DUY NHẤT trong turn... giống
// Clash-hộ nhưng dùng Guard (không cần speed cao hơn, không cần roll)") — tái
// dùng CHÍNH XÁC pattern third-party-intervention của Clash-hộ, chỉ đổi điều
// kiện (weaponName==="Zweihander" + chưa dùng trong turn này, KHÔNG cần so
// speed) và cơ chế áp dụng (Guard — tiêu Stamina + giảm % dmg, không cần roll
// dice như Clash).
async function sendYourShieldPrompts(encounter, channelId, channel, p, t, attacker) {
  const targetResolved = resolveCombatant(encounter, t.targetId);
  if (!targetResolved) return;
  const allCombatantEntries = [
    ...Object.keys(encounter.enemies).map(k => ({ id: k, combatant: encounter.enemies[k], type: "enemy" })),
    ...Object.keys(encounter.players).map(k => ({ id: k, combatant: encounter.players[k], type: "player" })),
  ];
  for (const entry of allCombatantEntries) {
    if (entry.id === p.attackerId || entry.id === t.targetId) continue;
    if (entry.combatant.weaponName !== "Zweihander") continue;
    if (entry.combatant.yourShieldUsedThisTurn) continue;
    const isThirdPartyEnemy = entry.type === "enemy";
    let thirdPartyChannel = channel;
    let thirdPartyMention = `<@${entry.id}>`;
    if (isThirdPartyEnemy && encounter.gmChannelId) {
      const gmCh = await client.channels.fetch(encounter.gmChannelId).catch(() => null);
      if (gmCh) { thirdPartyChannel = gmCh; thirdPartyMention = `GM (${entry.combatant.name})`; }
    }
    await thirdPartyChannel.send({
      content: thirdPartyMention,
      embeds: [{
        title: "🛡️ Your Shield — Có thể block hộ!",
        description: `${attacker.label} tấn công ${targetResolved.label} bằng \`${p.dmgStr}\` — bạn (${entry.combatant.name ?? entry.id}) có "Your Shield", có thể Guard THAY cho ${targetResolved.label} (chỉ 1 lần/turn, tiêu Stamina của chính bạn).`,
        color: 0x9b59b6,
      }],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${p.id}:${t.targetId}:yourshield:${entry.id}`)
          .setLabel(`🛡️ Your Shield — Guard thay cho ${targetResolved.label}`)
          .setStyle(ButtonStyle.Primary),
      )],
    }).catch(() => {});
  }
}

// "Dullahan" (Fused Blade of Ruined Mirror Worlds passive) — GAP ĐÃ SỬA (xác
// nhận trực tiếp: "Parry của bạn khi sử dụng sẽ khiến bạn đánh thường lên
// người kẻ địch") — MỖI LẦN chọn Parry (bất kể thắng/thua — "khi sử dụng",
// không phải "khi thành công"), tự động gây 1 đòn M1 lên attacker, dùng đúng
// weaponBaseDamage/weaponType của target (người Parry, chủ nhân Fused Blade).
function applyDullahanParryCounter(target, attackerCombatant) {
  if (target.weaponName !== "Fused Blade of Ruined Mirror Worlds") return null;
  if (!Number.isFinite(target.weaponBaseDamage)) return null;
  const typeChar = { Slash: "S", Blunt: "B", Pierce: "P" }[target.weaponType] ?? "S";
  const resStr = combatantResStr(attackerCombatant);
  const preview = calcMathCore({ dmgStr: `${target.weaponBaseDamage}${typeChar}`, resStr, poiseInit: target.poise, chargeInit: target.charge });
  applyHpLoss(attackerCombatant, preview.totalDmg); // đếm vào hpLostThisTurn (Hana)
  return preview.totalDmg;
}

/** commitAutoSkippedTargets — PHA KHOÁ chạy TRƯỚC khi gửi bất kỳ prompt nào.
 *
 *  BUG NGHIÊM TRỌNG ĐÃ SỬA — "AI kẹt sau player Stagger" LẦN 3 (Fragaria gửi
 *  ảnh chẩn đoán: `pendingActions còn lại: 1 ⚠️ (đòn chưa resolve — dấu hiệu
 *  treo)`). Lần 1 là thiếu hook maybeRunAiTurn, lần 2 là con trỏ lượt. Lần này
 *  là LOST UPDATE do THIẾU LOCK — hoàn toàn khác 2 lần trước.
 *
 *  NGUYÊN NHÂN GỐC: `sendReactiveDefensePrompt` được gọi FIRE-AND-FORGET và
 *  chạy HOÀN TOÀN NGOÀI `withLock(encounterKey)`. Nó làm nguyên chuỗi
 *  read-modify-write không nguyên tử:
 *      getEncounter → sửa p.reactedTargetIds → resolveOnePendingAction → saveEncounter
 *  Trong khi đó `enemy-ai.js` ngay sau `doEnemyAttack` chạy SONG SONG:
 *      withLock(...) { const enc3 = await getEncounter(...);
 *                      mob.staminaUsedThisTurn += ...; await saveEncounter(enc3); }
 *  Nếu `enc3` được đọc TRƯỚC khi prompt kịp save, cú save của AI GHI ĐÈ toàn bộ
 *  → pendingAction vừa resolve xong bị HỒI SINH, HP đã trừ bị hoàn lại.
 *
 *  VÌ SAO CHỈ LỘ KHI CÓ STAGGER: target Stagger là nhánh AUTO-RESOLVE TỨC THÌ
 *  (không gửi prompt, không chờ ai bấm) nên nó rơi đúng vào cửa sổ đua vài chục
 *  ms của AI. Người thật bấm nút mất mấy giây nên không bao giờ đụng.
 *
 *  HẬU QUẢ DÂY CHUYỀN: pendingAction sống lại → `announceCurrentTurn` có gate
 *  `if (isQuest && pendingActions.length === 0)` nên KHÔNG BAO GIỜ tự kết thúc
 *  turn order; AI thì đứng đợi hook `finalizeReactiveChoice` mà hook đó đã bắn
 *  rồi → treo vĩnh viễn, GM phải gmpanel end tay.
 *
 *  LỖI PHỤ CÙNG HỌ (cũng sửa ở đây): với AOE vừa có người Stagger vừa có người
 *  bình thường, `p.reactedTargetIds.push(...)` của người Stagger TRƯỚC ĐÂY chỉ
 *  nằm trong RAM — `saveEncounter` chỉ được gọi ở nhánh "tất cả đều auto-skip".
 *  Người bình thường bấm nút sau đó đọc Redis tươi → thiếu dấu → `allReacted`
 *  mãi mãi false → chờ một người chưa từng được hỏi.
 *
 *  CÁCH SỬA: tách riêng phần ĐỘNG VÀO DỮ LIỆU ra thành pha này, chạy TRONG
 *  lock (đọc tươi → đánh dấu → LƯU → nếu đủ thì resolve luôn cũng trong lock).
 *  Phần gửi prompt (I/O Discord, chậm) vẫn nằm NGOÀI lock như cũ để không giữ
 *  lock qua round-trip mạng.
 *  @returns {Promise<{resolved: boolean, lines?: string[], deleteAfterSave?: boolean, attackerIsAi?: boolean}>}
 */
async function commitAutoSkippedTargets(channelId, pendingId) {
  return withLock(encounterKey(channelId), async () => {
    const encounter = await getEncounter(channelId);
    if (!encounter) return { resolved: false };
    const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
    if (!p) return { resolved: false };
    p.reactedTargetIds = p.reactedTargetIds ?? [];
    let changed = false;
    for (const t of p.targets ?? []) {
      const tr = resolveCombatant(encounter, t.targetId);
      if (!tr) continue;
      if (p.reactedTargetIds.includes(t.targetId)) continue;
      // 3 điều kiện auto-skip — PHẢI khớp từng chữ với vòng lặp gửi prompt bên
      // dưới, nếu lệch thì có người vừa bị đánh dấu vừa được hỏi (hoặc ngược lại).
      const zeroDmg = (t.preview?.totalDmg ?? 0) <= 0;
      const staggered = !!tr.combatant.staggered;
      const ironHorusPreGuard = tr.combatant.hasIronHorus
        && tr.combatant.ironHorusGuardActiveThisTurn
        && (tr.combatant.guardCharges ?? 0) > 0;
      // ── BORROWED EYES: NÉ TỰ ĐỘNG, BỎ QUA reactive defense ─────────────────
      // Fragaria: "roll ra 8 thì cho player 8 charge né tự động — nên BỎ QUA
      // reactive defense, khiến họ TỰ ĐỘNG né những đòn có thể né được cho đến
      // khi hết free charge (dĩ nhiên không né được Undodgeable — đòn
      // Undodgeable VẪN phải hiện reactive defense ra)."
      //
      // ❗❗ BUG NẶNG ĐÃ SỬA (Fragaria: *"Borrowed Eye khiến cho player không thể
      // hành động phòng thủ những nhóm M1... M1 x70 đòn khiến player chết luôn
      // vì không phòng thủ được"*).
      // GỐC: bản cũ né `use = min(charge, tổng số hit)` hit ĐẦU rồi **đánh dấu
      // target là ĐÃ PHẢN HỒI XONG** (`reactedTargetIds.push`). Với đòn 70 hit
      // và 8 charge, nó né 8 hit rồi tuyên bố "không cần phòng thủ" cho **62 hit
      // còn lại** ⇒ cả đòn tự resolve, người chơi KHÔNG hề được hỏi, ăn trọn
      // 337 dmg và chết. Charge né ít hơn số hit đã biến passive phòng thủ
      // thành án tử.
      // ⇒ Đây là lớp lỗi "cơ chế phụ trợ chiếm quyền của đường chính": một tính
      //   năng hỗ trợ được phép TRẢ LỜI HỘ, nhưng chỉ cho phần nó thật sự trả
      //   nổi — phần còn lại phải trả về cho người chơi.
      //
      // NAY: né theo TỪNG NHÓM TRỌN VẸN (một nhóm = một quyết định phòng thủ,
      // không thể né nửa nhóm), ghi vào `perHitChoices` đúng khuôn Chain-Dashes,
      // và CHỈ auto-skip khi phủ được HẾT mọi nhóm. Không phủ hết thì prompt vẫn
      // được gửi, và vòng hỏi tự nhảy tới nhóm đầu tiên còn `null`.
      let borrowedAuto = false;
      if ((tr.combatant.borrowedEyeCharges ?? 0) > 0 && !zeroDmg && !staggered) {
        const bypassTags = extractDefenseBypassTags
          ? extractDefenseBypassTags(p.skillRollEmbed?.description ?? "", p.tags ?? "")
          : {};
        if (!bypassTags.blockEvade) {
          // ⚠️ PHẢI tính hitsPerCharge/groupCount Y HỆT vòng gửi prompt bên dưới
          // — lệch một chữ là hai bên chia nhóm khác nhau, người chơi bị hỏi
          // nhầm nhóm hoặc nhóm đã né lại bị hỏi lại.
          const bAttacker = resolveCombatant(encounter, p.attackerId);
          const bIsM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
          const bWeight = bAttacker?.combatant?.weaponWeight ?? "medium";
          const bHitCount = Math.max(1, t.preview?.dmgValues?.length ?? 1);
          const bHitsPerCharge = p.isEyeOfHorusFixedBurst ? 9 : (bIsM1Type ? (WEAPON_DEFENSE_HITS[bWeight] ?? 1) : 1);
          const bGroupCount = Math.ceil(bHitCount / bHitsPerCharge);
          t.perHitBypass = t.perHitBypass ?? parsePerHitBypass(p.skillRollEmbed?.description, p.tags, bGroupCount);
          t.perHitChoices = t.perHitChoices ?? new Array(bGroupCount).fill(null);

          let covered = 0;
          for (let gi = 0; gi < bGroupCount; gi++) {
            if (t.perHitChoices[gi] !== null) continue;
            // Nhóm mang tag chặn né thì Borrowed Eyes bó tay — để người chơi tự
            // quyết (tag phòng thủ có 2 CẤP: header và từng dòng dice).
            if (t.perHitBypass?.[gi]?.blockEvade) continue;
            const hitsInGroup = Math.min(bHitsPerCharge, bHitCount - gi * bHitsPerCharge);
            // ❗ BUG ĐÃ SỬA (Fragaria 14/08, kèm ảnh: *"Borrowed Eye chỉ né được 3
            // group hit"* — 9 charge mà chỉ phủ 2 nhóm).
            // GỐC: tôi tiêu charge theo SỐ HIT (`-= hitsInGroup`). Nhưng đơn vị
            // charge né của repo là **NHÓM**, không phải hit — Evade thường tiêu
            // `ceil(số hit đã chọn / hitsPerCharge)`, tức ĐÚNG 1 charge mỗi nhóm
            // (resolve-pending-action ~dòng 492). Vũ khí light 4 hit/nhóm nên
            // 9 charge ra 2 nhóm thay vì 9.
            // ⇒ Lớp lỗi: dùng SAI ĐƠN VỊ so với hệ có sẵn. Passive ghi "9 charge
            //   né" thì phải né được 9 lần phòng thủ, y như 9 charge Evade thường.
            if ((tr.combatant.borrowedEyeCharges ?? 0) < 1) break;
            tr.combatant.borrowedEyeCharges -= 1;
            const idxs = [];
            for (let i2 = 0; i2 < hitsInGroup; i2++) idxs.push(gi * bHitsPerCharge + i2 + 1);
            tr.combatant.evadeHitSelections = tr.combatant.evadeHitSelections ?? [];
            tr.combatant.evadeHitSelections.push(...idxs);
            // ❗ BUG ĐÃ SỬA (lần trước): chỉ set `evadeHitSelections` mà giữ
            // `evadeCharges` nguyên (thường = 0) ⇒ resolve thấy 0 charge nên
            // KHÔNG né gì — đúng triệu chứng "Borrowed Eyes vẫn không tự né".
            // Cấp ĐÚNG 1 charge/nhóm, khớp số resolve tiêu
            // (`ceil(hits đã chọn / hitsPerCharge)`), không cấp thừa.
            tr.combatant.evadeCharges = (tr.combatant.evadeCharges ?? 0) + 1;
            tr.combatant.borrowedEyesFreeEvade = true; // đánh dấu để KHÔNG trừ Stamina
            t.perHitChoices[gi] = `💨 Evade (Borrowed Eyes, 0 Sta)`;
            covered++;
          }
          if (covered > 0) {
            const totalEvaded = covered * bHitsPerCharge;
            t.borrowedEyesAutoNote = `👁️ **Borrowed Eyes** — tự động né **${covered}** nhóm (~${Math.min(totalEvaded, bHitCount)} hit, còn ${tr.combatant.borrowedEyeCharges} charge)`;
            changed = true;
          }
          // CHỈ coi là "đã phản hồi xong" khi KHÔNG còn nhóm nào chưa quyết —
          // còn nhóm nào thì người chơi PHẢI được hỏi.
          borrowedAuto = !t.perHitChoices.some(c => c === null);
        }
      }
      if (zeroDmg || staggered || ironHorusPreGuard || borrowedAuto) {
        p.reactedTargetIds.push(t.targetId);
        changed = true;
      }
    }
    const allTargetIds = (p.targets ?? []).map(tg => tg.targetId);
    const allReacted = allTargetIds.length > 0 && allTargetIds.every(tid => p.reactedTargetIds.includes(tid));
    if (!allReacted) {
      // CHỐT QUAN TRỌNG: phải LƯU cả khi chưa resolve — đây chính là lỗi phụ
      // khiến AOE hỗn hợp treo (dấu auto-skip mất khi người khác bấm nút).
      if (changed) await saveEncounter(channelId, encounter);
      return { resolved: false };
    }
    const lines = await resolveOnePendingAction(encounter, p);
    encounter.pendingActions = (encounter.pendingActions ?? []).filter(pa => pa.id !== pendingId);
    await saveEncounter(channelId, encounter);
    // ⚠️ KHÔNG drain ở đây — ta đang ở TRONG `withLock` của chính hàm này, mà
    // `withLock` KHÔNG re-entrant ⇒ tự chặn mình. Caller
    // (`sendReactiveDefensePrompt`) drain sau khi thoát lock.
    return {
      resolved: true,
      lines,
      deleteAfterSave: !!encounter._deleteAfterSave,
      attackerIsAi: p.attackerType === "enemy" && !!encounter.enemies?.[p.attackerId]?.aiControlled,
    };
  });
}

async function sendReactiveDefensePrompt(channelId, pendingId) {
  try {
    // PHA 1 (CÓ KHOÁ) — đánh dấu + lưu người bị auto-skip, resolve nếu đủ.
    const autoSkip = await commitAutoSkippedTargets(channelId, pendingId);
    if (autoSkip.resolved) {
      // Payback vừa sinh ra trong lúc auto-resolve — drain SAU khi đã thoát lock
      // của commitAutoSkippedTargets (withLock KHÔNG re-entrant).
      drainAwaitingPrompts(channelId).catch(() => {});
      const resultChannel = await client.channels.fetch(channelId).catch(() => null);
      if (resultChannel) {
        await resultChannel.send({ embeds: [{ title: "⚔️ Đã xử lý (không cần phòng thủ)", description: (autoSkip.lines ?? []).join("\n"), color: 0x95a5a6 }] }).catch(() => {});
      }
      if (autoSkip.deleteAfterSave) {
        await deleteEncounter(channelId).catch((err) => log("error", "autoresolve-deleteEncounter", "system", err.message));
        return;
      }
      // Hook AI: mob đang đợi đúng callback này để thử hành động tiếp (xem
      // hasUnresolvedTargetPending trong enemy-ai.js). Thiếu nó = mob treo.
      if (autoSkip.attackerIsAi) aiHooks.maybeRunAiTurn(channelId).catch(() => {});
      const encAfterAutoSkip = await getEncounter(channelId);
      if (encAfterAutoSkip) announceCurrentTurn(channelId, encAfterAutoSkip, true).catch(() => {});
      return;
    }
    // PHA 2 (KHÔNG KHOÁ) — gửi prompt cho những người CÒN LẠI. I/O Discord chậm
    // nên cố tình không giữ lock ở đây; mọi thay đổi dữ liệu thật đã xong ở pha 1.
    const encounter = await getEncounter(channelId);
    if (!encounter) return;
    const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
    if (!p) return; // đã bị xử lý/xoá trước đó (VD GM lỡ tay confirm cả loạt)
    const attacker = resolveCombatant(encounter, p.attackerId);
    if (!attacker) return;
    const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
    const attackerWeapon = attacker.combatant.weaponWeight ?? "medium";
    const bypass = p.defenseBypass ?? {};

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    // AOE nhiều target — MỖI target 1 prompt riêng (mỗi người tự quyết định
    // phòng thủ của mình, độc lập với người khác).
    p.reactedTargetIds = p.reactedTargetIds ?? [];
    // Hàng đợi target do AI điều khiển — chạy TUẦN TỰ sau vòng lặp (xem lý do
    // ở nhánh `target.aiControlled` bên dưới).
    const aiDefenseQueue = [];
    for (const t of p.targets) {
      const targetResolved = resolveCombatant(encounter, t.targetId);
      if (!targetResolved) continue;
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 số đòn của boss không dmg nhưng hiệu
      // ứng... không tốn stamina") — nếu đòn KHÔNG gây dmg thật (0) cho target
      // này, KHÔNG bắt họ tốn Stamina Guard/Evade một thứ chẳng gây gì — tự động
      // coi như "đã phản hồi" (bỏ qua chọn phòng thủ), không gửi prompt.
      if ((t.preview?.totalDmg ?? 0) <= 0) {
        if (!p.reactedTargetIds.includes(t.targetId)) p.reactedTargetIds.push(t.targetId);
        continue;
      }
      // "Stagger" — GAP ĐÃ SỬA (xác nhận trực tiếp): "bị stagger, không thể sử
      // dụng reactive defense hay hành động tiếp được nữa" — trước đây HOÀN
      // TOÀN không có check này, người đang Stagger vẫn được hỏi Guard/Evade/
      // Parry bình thường (khiến trông như Stagger "không có tác dụng gì" dù
      // counter thời lượng vẫn đúng). Giờ tự động coi như "không phòng thủ"
      // (ăn đủ dmg), không gửi prompt nào cả.
      if (targetResolved.combatant.staggered) {
        if (!p.reactedTargetIds.includes(t.targetId)) p.reactedTargetIds.push(t.targetId);
        continue;
      }
      // GAP ĐÃ SỬA (xác nhận trực tiếp): "bấm Guard 1 lần trong turn thì cứ mặc
      // định là guard sẵn trong turn đó do charge Guard của nó không thể bị
      // giảm được nên phải khóa lại nút guard" — Iron Horus đã Guard 1 lần rồi
      // (ironHorusGuardActiveThisTurn=true, guardCharges vẫn còn nguyên vì
      // KHÔNG BAO GIỜ tụt) → tự động áp dụng Guard NGAY, không hỏi lại/không
      // tốn thêm Sta — resolveOnePendingAction's nhánh Iron Horus (dòng dưới)
      // đã tự che 100% khi thấy guardCharges > 0, không cần set gì thêm ở đây.
      if (targetResolved.combatant.hasIronHorus && targetResolved.combatant.ironHorusGuardActiveThisTurn && (targetResolved.combatant.guardCharges ?? 0) > 0) {
        if (!p.reactedTargetIds.includes(t.targetId)) p.reactedTargetIds.push(t.targetId);
        continue;
      }
      const target = targetResolved.combatant;
      // Stage 3 — Enemy AI (enemy-ai.js): mob đánh dấu aiControlled tự quyết
      // định Guard/Evade/Parry/Không phòng thủ theo luật riêng, KHÔNG gửi UI
      // Discord nào cả — resolveAiDefenseForTarget tự lock/loop/finalize toàn
      // bộ nhóm hit còn lại cho target này trong 1 lần, độc lập với vòng lặp
      // đang chạy ở đây (không cần đợi round-trip Discord như người thật).
      if (target.aiControlled) {
        // ❗❗ BUG ĐÃ SỬA (Fragaria 14/08, kèm ảnh: *"đòn AOE như degraded shockwave
        // khiến AI kẹt encounter ở contract rescue nơi có quá nhiều rats"*).
        // GỐC: gọi FIRE-AND-FORGET ngay trong vòng lặp ⇒ với đòn AOE 9 con Rats là
        // **9 lời gọi CHẠY SONG SONG**, mà hàm đó lấy `withLock(encounterKey)` trên
        // CÙNG một encounter. `withLock` mặc định chỉ thử 3×200ms rồi NÉM; phần lớn
        // lời gọi ném, bị `.catch(() => {})` nuốt sạch ⇒ những target đó KHÔNG BAO
        // GIỜ resolve ⇒ pendingAction kẹt vĩnh viễn, phải Force-confirm khẩn cấp.
        // Càng nhiều target càng chắc chắn hỏng — đúng "quá nhiều rats".
        // ⇒ Gom lại, chạy TUẦN TỰ sau vòng lặp: chúng sửa cùng một encounter nên
        //   vốn KHÔNG song song được. Vẫn fire-and-forget CẢ CHUỖI để không chặn
        //   việc gửi prompt cho người chơi thật.
        aiDefenseQueue.push(t.targetId);
        continue;
      }
      const hitCount = Math.max(1, t.preview?.dmgValues?.length ?? 1);

      // GAP ĐÃ SỬA (xác nhận trực tiếp: "Durandal crit có 3 hit... lúc hiện
      // responsive guard thì phần guard bị chặn lại, chỉ còn parry và evade...
      // hiện cơ chế chỉ cho phép 1 hành động thủ duy nhất trong khi đáng lẽ có
      // thể... hit 1 né, hit 2 guard, hit 3 né/parry") — REDESIGN LỚN: bỏ hẳn
      // ghép nhóm theo weapon weight (WEAPON_DEFENSE_HITS) cho luồng hỏi —
      // giờ hỏi TỪNG HIT MỘT. GAP ĐÃ SỬA THÊM (xác nhận trực tiếp: "20 hit của
      // light weapon thì tính sao? Không lẽ hỏi liên tục 20 lần, tôi nghĩ nên
      // nhóm 4 lần m1 của light weapon thành 1") — per-hit CHỈ áp dụng cho
      // skill/Critical/Page (isM1Type=false — mỗi dòng dice roll() CÓ THỂ có
      // tag khác nhau, VD Durandal). M1 (isM1Type=true, bao gồm CẢ Eye Of Horus
      // fixedBurst — vẫn là kind "attack") GIỮ NGUYÊN ghép nhóm theo weapon
      // weight cũ — mọi hit M1 cùng vũ khí LUÔN cùng tag, hỏi riêng từng hit
      // chỉ tổ rườm rà vô ích (20 hit Light weapon = 20 lần hỏi, quá tệ).
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "guard/evade/parry m1 không như tôi bảo
      // bạn... medium weapon đánh 6 hit, thì hãy group lại... group nó lại
      // thành 3 lần hỏi người dùng để họ tự ý chọn đỡ hit nào thì dỡ hoặc né
      // giữa chừng chứ không phải 1 lần là bắt guard thì guard cả 3, né thì
      // né cả 3") — REDESIGN THỐNG NHẤT: bỏ hẳn nhánh M1 riêng (dùng
      // dropdown-chọn-nhóm cũ, chỉ cho phép 1 loại phòng thủ áp dụng cho toàn
      // bộ) — giờ M1/Skill/Critical/Eye Of Horus DÙNG CHUNG 1 hệ thống
      // group-based looping: groupSize = hitsPerCharge (Skill/Critical=1 —
      // hành vi CŨ không đổi; M1=theo weapon weight, VD medium=2; Eye Of Horus
      // fixedBurst=9 — tự động thành ĐÚNG 1 nhóm vì 9 hit/9-hit-per-charge=1,
      // không cần tách riêng nữa). Mỗi NHÓM hỏi riêng, lặp tự động, mỗi nhóm
      // chọn ĐỘC LẬP (mix Guard/Evade/Parry/Không phòng thủ tuỳ ý giữa các
      // nhóm) — đúng tinh thần "group 3 lần hỏi, không phải 1 lần áp cho cả 3".
      const hitsPerCharge = p.isEyeOfHorusFixedBurst ? 9 : (isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeapon] ?? 1) : 1);
      const groupCount = Math.ceil(hitCount / hitsPerCharge);
      t.perHitBypass = t.perHitBypass ?? parsePerHitBypass(p.skillRollEmbed?.description, p.tags, groupCount);
      t.perHitChoices = t.perHitChoices ?? new Array(groupCount).fill(null);
      const currentGroupIdx = t.perHitChoices.findIndex(c => c === null);
      if (currentGroupIdx === -1) {
        // Tất cả nhóm đã có quyết định — coi target này đã phản hồi xong,
        // resolveOnePendingAction sẽ tự đọc t.perHitChoices để tính dmg.
        if (!p.reactedTargetIds.includes(t.targetId)) p.reactedTargetIds.push(t.targetId);
        continue;
      }
      const thisGroupBypass = t.perHitBypass[currentGroupIdx];
      // Nhóm CUỐI có thể có ÍT hit hơn hitsPerCharge (VD 6 hit/nhóm 4-hit Light
      // → nhóm cuối chỉ còn 2 hit) — dùng đúng số hit THẬT của nhóm này để tính
      // cost chính xác (không phải LUÔN hitsPerCharge).
      const hitsInThisGroup = Math.min(hitsPerCharge, hitCount - currentGroupIdx * hitsPerCharge);
      const opts = computeDefenseOptions(target, attackerWeapon, hitsInThisGroup, isM1Type, thisGroupBypass, p.isEyeOfHorusFixedBurst ?? false);

      // isFirstUndecidedGroup — CHỈ còn dùng cho CLASH.
      // BUG ĐÃ SỬA (Fragaria báo trực tiếp: "light dash và fleet footstep, page
      // counter bị biến mất sau khi qua group hit mới, group hit đầu vẫn thấy
      // nhưng sau khi qua group hit mới của cùng 1 instance thì biến mất").
      // NGUYÊN NHÂN GỐC: cờ này = false ngay khi BẤT KỲ nhóm nào đã chọn xong,
      // và nó gate CẢ 3 thứ (Counter / Dash / Clash). Nhưng chỉ CLASH mới thật
      // sự phải quyết định trước toàn bộ đòn (so dice TRƯỚC khi đòn diễn ra —
      // clash ở nhóm giữa chừng thì mâu thuẫn với nhóm đã Guard xong).
      // Counter (ngắt đòn) và Light Dash / Fleet Footsteps (né 1 nhóm hit) hoàn
      // toàn hợp lệ ở nhóm bất kỳ — người chơi Guard nhóm 1 rồi Counter nhóm 2
      // là chiến thuật bình thường, không mâu thuẫn gì.
      const isFirstUndecidedGroup = !t.perHitChoices.some(c => c !== null);
      const availableCounterPages = [];
      // [Uncounterable] (Furioso rework) — đòn có tag này KHÔNG thể bị page-counter
      // ngắt, nên không hiện nút counter nào cả.
      if (!thisGroupBypass.uncounterable) {
        const addedCounterKeys = new Set();
        for (const pageName of (target.unlockedPagesSnapshot ?? [])) {
          const pageSkill = findSkill(pageName);
          if (!pageSkill || !pageSkill.counterEffect) continue;
          const pageKey = pageName.trim().toLowerCase();
          if (addedCounterKeys.has(pageKey)) continue;
          if ((target.skillCooldowns?.[cdKeyFor ? cdKeyFor(pageKey) : pageKey] ?? 0) > 0) continue;
          // BUG ĐÃ SỬA (Fragaria, kèm ảnh: "You're Too Slow bị bug xài liên tục 2
          // lần ở reactive defense được, có vẻ là không đếm CD").
          // Đúng là không đếm — nhưng CỐ Ý: counter thành công thì
          // express-routes.js XOÁ CD vừa set, vì "CD chỉ tính SAU khi đâm xong"
          // (đòn đâm nằm ở dropdown Moves, nhánh ytsfollowup). Hệ quả không lường
          // trước: trong lúc DẤU còn treo (đã counter, chưa đâm), skill vừa không
          // có CD vừa không có gì chặn → nhóm hit kế tiếp lại hiện nút counter,
          // bấm được vô hạn.
          // → Chặn bằng chính cái DẤU: còn dấu chưa tiêu thì không counter lại.
          if (pageKey === "you're too slow" && target.youreTooSlowMark?.markedTargetId) continue;
          const cost = parseSkillCost(pageSkill.cost);
          if ((target.currentLight ?? 0) < (cost.light ?? 0)) continue;
          addedCounterKeys.add(pageKey);
          availableCounterPages.push({ key: pageKey, name: pageSkill.name, lightCost: cost.light ?? 0 });
        }
        // "Tanglecleaver Reload" (Tiantui Star's Blade + Thumb Capo IIII, Page
        // không tốn slot) — xác nhận trực tiếp: "5 page đặc biệt không tốn
        // slot page bình thường và chỉ mở khóa khi đúng faction và outfit, vũ
        // khí đang mặc" — không phụ thuộc unlockedPagesSnapshot.
        if (target.weaponName === "Tiantui Star's Blade [天退星刀]" && target.equippedOutfit === "Thumb Capo IIII" && !addedCounterKeys.has("tanglecleaver reload")) {
          const reloadSkill = findSkill("Tanglecleaver Reload");
          if (reloadSkill && (target.skillCooldowns?.["tanglecleaver reload"] ?? 0) <= 0) {
            const reloadCost = parseSkillCost(reloadSkill.cost);
            if ((target.currentLight ?? 0) >= (reloadCost.light ?? 0)) {
              addedCounterKeys.add("tanglecleaver reload");
              availableCounterPages.push({ key: "tanglecleaver reload", name: reloadSkill.name, lightCost: reloadCost.light ?? 0 });
            }
          }
        }
      }
      // GAP ĐÃ SỬA (Fragaria báo trực tiếp: "light dash và fleetfoot steps vẫn
      // chưa thấy nút bấm ở reactive defense"). 2 page này CHỈ có nghĩa khi ĐANG
      // BỊ ĐÁNH (tác dụng là "né 1 đòn"), nhưng trước đây chỉ bấm được ở dropdown
      // Moves lúc tới lượt mình — tức đúng lúc KHÔNG có đòn nào để né. Giờ đã bị
      // gỡ khỏi Moves (cờ reactiveOnly, xem encounter-panels.js) và xuất hiện ở
      // ĐÂY thay thế.
      // Điều kiện y hệt counter page: đã mở khoá + không cooldown + đủ Light.
      // Thêm: KHÔNG hiện nếu nhóm hit này Undodgeable (đúng mô tả gốc của cả 2
      // page: "không thể né Undodgeable") — hiện nút rồi báo lỗi khi bấm thì tệ.
      const availableDashPages = [];
      if (!thisGroupBypass.blockEvade) {
        const REACTIVE_DASH_KEYS = ["light dash", "fleet footsteps"];
        const ownedLower = new Set([
          ...(target.unlockedPagesSnapshot ?? []),
          ...(target.unlockedEgoPagesSnapshot ?? []),
        ].filter(Boolean).map(n => n.trim().toLowerCase()));
        for (const dashKey of REACTIVE_DASH_KEYS) {
          if (!ownedLower.has(dashKey)) continue;
          const dashSkill = findSkill(dashKey);
          if (!dashSkill) continue;
          if ((target.skillCooldowns?.[dashKey] ?? 0) > 0) continue;
          const dCost = parseSkillCost(dashSkill.cost);
          if ((target.currentLight ?? 0) < (dCost.light ?? 0)) continue;
          availableDashPages.push({ key: dashKey, name: dashSkill.name, lightCost: dCost.light ?? 0 });
        }
      }

      // Clash chỉ dùng được khi Speed CAO HƠN người tấn công (hoà cũng không được).
      // `canClash` VỐN ĐÃ có check này; `canClashGeneral` thì KHÔNG — đó là lỗ hổng
      // thật ở đường player (nút clash "chung" vẫn hiện cho người chậm hơn).
      // Tách ra biến riêng để 2 nhánh dùng CHUNG một nguồn sự thật, khỏi lệch nhau.
      // (Biến attacker ở scope này tên là `attacker`, KHÔNG phải `attackerResolved`.)
      const clashSpeedOk = (target.currentSpeed ?? -Infinity) > (attacker.combatant.currentSpeed ?? Infinity);
      // Furioso: [Unbreakable Dice] — báo trước cho người phòng thủ biết thắng
      // clash cũng KHÔNG huỷ được đòn, chỉ giảm còn 50% dmg. Nếu không báo, họ sẽ
      // tưởng clash thắng là an toàn rồi bất ngờ ăn nguyên nửa đòn.
      const unbreakableNote = thisGroupBypass.unbreakableDice
        ? " ⚠️ *(Unbreakable Dice — thắng clash chỉ giảm còn 50% dmg, KHÔNG huỷ được đòn)*" : "";
      const canClash = clashSpeedOk && isFirstUndecidedGroup && !isM1Type && !thisGroupBypass.unclashable;
      const canClashGeneral = canClash;

      const isEnemyTarget = targetResolved.type === "enemy";
      let sendChannel = channel;
      let mentionText = `<@${t.targetId}>`;
      if (isEnemyTarget) {
        mentionText = `<@${encounter.gmId}>`;
        if (encounter.gmChannelId) {
          const gmChannel = await client.channels.fetch(encounter.gmChannelId).catch(() => null);
          if (gmChannel) sendChannel = gmChannel;
        }
      }

      // groupIdx (currentGroupIdx) LUÔN có mặt trong customId — vị trí CUỐI
      // cùng, giữ nguyên format cũ cho counter/clash.
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:guard:${currentGroupIdx}`)
          .setLabel(`🛡️ Guard (-${opts.guard.cost} Sta)`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!opts.guard.available),
        // ── ZWEI ASSOCIATION — BLOCK GIÙM ĐỒNG MINH ──────────────────────────
        // Fragaria: "phải để cho người mang outfit này bấm reactive defense CHO
        // ĐỒNG MINH được (chỉ mỗi Block); khi bấm thì HỌ sẽ là người chịu đòn
        // thay; và chỉ block giùm được cho 1 người mỗi 1 turn."
        // Nút chỉ hiện khi trong party CÓ người mặc Zwei, KHÁC người đang bị đánh,
        // và chưa khoá vào người khác trong turn này.
        ...((() => {
          const zwei = Object.entries(encounter.players ?? {}).find(([pid, pl]) =>
            pl?.hasZweiAssociation && (pl.currentHp ?? 0) > 0 && !pl.staggered && pid !== t.targetId
            && (!pl.zweiProtectingId || pl.zweiProtectingId === t.targetId));
          if (!zwei) return [];
          return [new ButtonBuilder()
            .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:zweiblock:${currentGroupIdx}`)
            .setLabel(`🛡️ Zwei: Block giùm (${zwei[1].name ?? "đồng minh"})`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)];
        })()),
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:evade:${currentGroupIdx}`)
          .setLabel(`💨 Evade (-${opts.evade.cost} Sta)`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!opts.evade.available),
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:parry:${currentGroupIdx}`)
          .setLabel(`🗡️ Parry`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!opts.parry.available),
        new ButtonBuilder()
          .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:none:${currentGroupIdx}`)
          .setLabel(`❌ Không phòng thủ`)
          .setStyle(ButtonStyle.Danger),
      );

      const counterRows = [];
      for (let i = 0; i < availableCounterPages.length; i += 5) {
        const chunk = availableCounterPages.slice(i, i + 5);
        counterRows.push(new ActionRowBuilder().addComponents(
          ...chunk.map(cp => new ButtonBuilder()
            // BUG ĐÃ SỬA (Fragaria: "khi thắng hay thua rtparry của You're Too
            // Slow đều tính là ăn sạch cả toàn bộ group hit"). MỌI nút phòng thủ
            // khác đều mang `:${currentGroupIdx}` ở cuối — RIÊNG nút Counter thì
            // KHÔNG, nên counterContext không hề biết đang counter NHÓM NÀO, và
            // đường rtparry buộc phải finalize cả pendingAction. Thêm groupIdx
            // vào ô thứ 7 (choice="counter" nên ô này trống, không đụng dash).
            .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:counter:${cp.key}:${currentGroupIdx}`)
            .setLabel(`⚔️ ${cp.name} (Counter)`)
            .setStyle(ButtonStyle.Success)),
        ));
      }
      if (availableDashPages.length > 0) {
        // customId có THÊM 1 segment thứ 7 (skillKey) so với format cũ — handler
        // encreactivedef đã đọc được (xem interaction-handlers.js). groupIdx vẫn
        // ở đúng vị trí 6 như mọi choice khác, không phá format cũ.
        counterRows.push(new ActionRowBuilder().addComponents(
          ...availableDashPages.slice(0, 5).map(dp => new ButtonBuilder()
            .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:dash:${currentGroupIdx}:${dp.key}`)
            .setLabel(`💨 ${dp.name}${dp.lightCost > 0 ? ` (-${dp.lightCost} Light)` : ""}`)
            .setStyle(ButtonStyle.Success)),
        ));
      }
      if (canClash) {
        counterRows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:clash:${t.targetId}`)
            .setLabel(`⚔️ Clash (Speed cao hơn)`)
            .setStyle(ButtonStyle.Primary),
        ));
      }

      // ══ DMG CÒN LẠI — TÍNH ĐỦ CẢ GUARD, PARRY, COUNTER ═══════════════════
      // Fragaria: "1 group hit 4 đòn tổng 20 dmg thì khi né 1 đòn nên show còn
      // lại 15 dmg để player dễ tính" → sau đó: "hiện luôn cả số dmg còn lại sau
      // khi guard hay parry hay counter gì đi, làm thì làm cho đủ vào".
      //
      // TRƯỚC ĐÂY prompt in `t.preview.totalDmg` = tổng dmg CẢ ĐÒN lúc chưa ai
      // phòng thủ gì. Sang nhóm 2, 3… con số đó ĐỨNG YÊN dù đã phòng thủ mấy
      // nhóm rồi → vô dụng để quyết định. Bản sửa đầu của tôi mới trừ Evade/Parry
      // và CỐ Ý bỏ Guard — thiếu, vì Guard mới là thứ dùng nhiều nhất.
      //
      // BA LOẠI PHÒNG THỦ, BA CÁCH TÍNH KHÁC HẲN NHAU (đọc từ resolve-pending-action.js,
      // KHÔNG đoán):
      //   • Evade / Counter thắng → `perHitMult = 0`, CHẮC CHẮN, né trọn hit.
      //   • Guard              → `perHitMult = 1 - guardReductionPct`, TẤT ĐỊNH.
      //       guardReductionPct = (Fortified Resolve ? 0.99 : 0.9)
      //                           + (defenseUp*1 - defenseDown*5)/100
      //                           × 0.5 nếu ATTACKER mặc Blade Lineage và có ≥10 Poise
      //   • Parry              → XÁC SUẤT: defRoll vs d20 của attacker. Thắng thì
      //       né trọn, THUA thì ăn FULL + mất 30/40 Sta.
      // → Parry KHÔNG được tính như đã né chắc (bản trước của tôi tính vậy là
      //   HỨA LỐ). Hiện riêng thành "nếu Parry thắng" để người chơi tự cân nhắc.
      const perHitDmg = t.preview?.dmgValues ?? [];
      const totalRaw = t.preview?.totalDmg ?? 0;
      // dmgValues là mảng OBJECT do damage-calc.js sinh, KHÔNG phải mảng số.
      // `.finalDmg` = dmg thật sau Res/DR/crit (thứ ta cần). `.value` chỉ là số
      // dice THÔ — dùng nhầm sẽ ra số nhỏ hơn thực tế rất nhiều.
      // Fallback theo tỉ lệ `.value` khi encounter cũ (lưu trước bản này) chưa
      // có finalDmg, để không hiện 0 cho người đang chơi dở.
      const rawSum = perHitDmg.reduce((a, v) => a + (typeof v === "number" ? v : (v?.value ?? 0)), 0);
      const dmgAt = (h1) => {
        const v = perHitDmg[h1 - 1];
        if (typeof v === "number") return v;
        if (typeof v?.finalDmg === "number") return v.finalDmg;
        const raw = v?.value ?? 0;
        return rawSum > 0 ? (t.preview?.totalDmg ?? 0) * (raw / rawSum) : 0;
      };

      // Guard % — sao nguyên công thức của resolve-pending-action.js. Lệch công
      // thức ở đây là báo sai số cho người chơi, nên nếu bên kia đổi thì SỬA CẢ HAI.
      const baseGuardPct = hasPerk(target, "Fortified Resolve") ? 0.99 : 0.9;
      const defenseUpDownPct = ((target.defenseUp ?? 0) * 1 - (target.defenseDown ?? 0) * 5) / 100;
      const guardPctBase = Math.min(1, Math.max(0, baseGuardPct + defenseUpDownPct));
      const guardPct = (attacker.combatant.equippedOutfit === "Blade Lineage" && (attacker.combatant.poise ?? 0) >= 10)
        ? guardPctBase * 0.5
        : guardPctBase;

      const evadeSet = new Set(target.evadeHitSelections ?? []);   // Counter thắng cũng đẩy vào đây
      const guardSet = new Set(target.guardHitSelections ?? []);

      // ── PARRY: tính CẢ trường hợp THẮNG lẫn THUA ─────────────────────────
      // Fragaria: "nếu thế thì hãy tính cả trường hợp phần parry thất bại là được mà?"
      // Làm được, vì `parryRolls` ĐÃ được roll ngay lúc người chơi bấm Parry
      // (interaction-handlers.js) chứ không phải lúc resolve — nên tại thời điểm
      // dựng prompt ta BIẾT chính xác defRoll. Attacker roll d20 đều 1..20 nên
      //   P(thắng) = P(atkRoll ≤ defRoll) = clamp(defRoll, 0, 20) / 20.
      //
      // GHÉP ROLL VỚI HIT THEO ĐÚNG resolve-pending-action.js: MỘT roll quyết
      // định cho CẢ CỤM `hitsPerCharge` hit (Fragaria xác nhận: "1 charge parry
      // vẫn hoạt động như evade và guard là chặn được 1 group hit m1").
      // Công thức chunk phải khớp bên resolve — lệch là báo sai số.
      const parrySelected = (target.parryHitSelections ?? []).filter(h => h >= 1 && h <= hitCount);
      const parryRolls = target.parryRolls ?? [];
      const parryAttempts = [];   // { hits: [...], dmg, winPct }
      let parryNoRollDmg = 0;     // cụm đã chọn Parry nhưng HẾT roll (không nên xảy ra)
      for (let ci = 0, ri = 0; ci < parrySelected.length; ci += hitsPerCharge, ri++) {
        const chunk = parrySelected.slice(ci, ci + hitsPerCharge)
          .filter(h => !evadeSet.has(h) && !guardSet.has(h)); // lựa chọn khác đã phủ hit này
        if (chunk.length === 0) continue;
        const chunkDmg = chunk.reduce((a, h) => a + dmgAt(h), 0);
        if (ri < parryRolls.length) {
          parryAttempts.push({ hits: chunk, dmg: chunkDmg, winPct: Math.min(1, Math.max(0, (parryRolls[ri] ?? 0) / 20)) });
        } else {
          parryNoRollDmg += chunkDmg;
        }
      }
      const parryHitPct = new Map();  // hit → winPct, để tính dmg riêng của nhóm đang hỏi
      for (const a of parryAttempts) for (const h of a.hits) parryHitPct.set(h, a.winPct);
      const parryHitCount = parryAttempts.reduce((a, x) => a + x.hits.length, 0);

      let avoidedSure = 0, guardSaved = 0;
      for (let h = 1; h <= hitCount; h++) {
        const d = dmgAt(h);
        if (evadeSet.has(h)) { avoidedSure += d; continue; }
        if (guardSet.has(h)) { guardSaved += d * guardPct; continue; }
      }
      // "Còn lại" = tổng gốc − né chắc − phần Guard giảm. Hit đang chờ Parry vẫn
      // nằm NGUYÊN trong con số này (chưa biết thắng thua) — đó CHÍNH LÀ trường
      // hợp thua hết, nên nó cũng là cận TRÊN.
      const remainingDmg = Math.max(0, totalRaw - avoidedSure - guardSaved);
      const parryMaxSave = parryAttempts.reduce((a, x) => a + x.dmg, 0);
      const remainingIfParryWins = Math.max(0, remainingDmg - parryMaxSave);
      const remainingIfParryLoses = remainingDmg;
      // Kỳ vọng — con số đáng tin nhất để so với 2 lựa chọn khác.
      const parryExpectedSave = parryAttempts.reduce((a, x) => a + x.dmg * x.winPct, 0);
      const remainingExpected = Math.max(0, remainingDmg - parryExpectedSave);
      // Thua thì mất Stamina: 30 nếu có Mastered Breaths, 40 mặc định; GẤP ĐÔI
      // khi đang "Gãy tay" (sao nguyên từ resolve-pending-action.js).
      const parryFailBase = hasPerk(target, "Mastered Breaths") ? 30 : 40;
      const parryFailCost = (target.injuries ?? []).includes("Gãy tay") ? parryFailBase * 2 : parryFailBase;
      const parryStaWorst = parryAttempts.length * parryFailCost;
      const parryAvgWinPct = parryAttempts.length > 0
        ? Math.round((parryAttempts.reduce((a, x) => a + x.winPct, 0) / parryAttempts.length) * 100)
        : 0;

      // Dmg của RIÊNG nhóm đang hỏi — thứ người chơi thực sự cân nhắc lúc này.
      // groupStartHit (0-based) dùng CÙNG công thức với realHitIndices ở
      // interaction-handlers.js — lệch là báo sai nhóm.
      const groupStartHit = currentGroupIdx * hitsPerCharge;
      let thisGroupDmg = 0;
      for (let h = groupStartHit + 1; h <= Math.min(groupStartHit + hitsInThisGroup, hitCount); h++) {
        if (evadeSet.has(h)) continue;
        // Nhóm đang hỏi: Guard trừ tất định; Parry trừ theo KỲ VỌNG (đã biết
        // defRoll nên ước lượng được, sát thực tế hơn là bỏ qua hẳn).
        const pPct = parryHitPct.get(h);
        const mult = guardSet.has(h) ? (1 - guardPct) : (pPct !== undefined ? (1 - pPct) : 1);
        thisGroupDmg += dmgAt(h) * mult;
      }
      const dmgPreview = remainingDmg.toFixed(1); // 1 số lẻ — đang hiện nhiều con số cùng lúc, 3 số lẻ chỉ gây rối
      const tagNote = [thisGroupBypass.blockGuard && "Unblockable", thisGroupBypass.blockEvade && "Undodgeable", thisGroupBypass.blockParry && "Unparriable", thisGroupBypass.guardBreak && "Guard Break"].filter(Boolean);
      const groupHitRangeStart = currentGroupIdx * hitsPerCharge + 1;
      const groupHitRangeEnd = groupHitRangeStart + hitsInThisGroup - 1;
      const hitRangeLabel = hitsInThisGroup > 1 ? `Hit ${groupHitRangeStart}-${groupHitRangeEnd}` : `Hit ${groupHitRangeStart}`;
      await sendChannel.send({
        content: mentionText,
        embeds: [{
          title: `⚔️ Đang bị tấn công! — ${hitRangeLabel}/${hitCount} (Nhóm ${currentGroupIdx + 1}/${groupCount})`,
          description: (() => {
            // Chỉ hiện dòng nào CÓ SỐ — không thì chỉ là nhiễu.
            const rows = [`${attacker.label} tấn công ${targetResolved.label} với \`${p.dmgStr}\``];
            rows.push(`> 💥 **Nhóm này**: ~**${thisGroupDmg.toFixed(1)}** dmg`);
            const saved = [];
            if (avoidedSure > 0) saved.push(`💨 né trọn **${avoidedSure.toFixed(1)}**`);
            if (guardSaved > 0) saved.push(`🛡️ Guard chặn **${guardSaved.toFixed(1)}** *(giảm ${Math.round(guardPct * 100)}%)*`);
            if (saved.length > 0) {
              rows.push(`> ${saved.join(" · ")}`);
              rows.push(`> 📊 Còn lại cả đòn: **${dmgPreview}** / ${totalRaw.toFixed(1)} gốc`);
            } else {
              rows.push(`> 📊 Cả đòn nếu không phòng thủ gì: **${dmgPreview}**`);
            }
            // Parry là XÁC SUẤT — hiện ĐỦ cả 3 mốc (thắng hết / kỳ vọng / thua
            // hết) kèm giá phải trả khi thua, thay vì chỉ nói "nếu thắng".
            if (parryAttempts.length > 0) {
              rows.push(`> 🗡️ **Parry ${parryAttempts.length} roll / ${parryHitCount} hit** (~${parryAvgWinPct}% mỗi roll) — thắng hết: **${remainingIfParryWins.toFixed(1)}** · kỳ vọng: **${remainingExpected.toFixed(1)}** · thua hết: **${remainingIfParryLoses.toFixed(1)}** *(+${parryStaWorst} Sta)*`);
            }
            // Lưới an toàn: về nguyên tắc số roll luôn đủ (1 roll/charge, 1 charge
            // phủ 1 cụm). Nếu vẫn lệch thì phải nói ra chứ không nuốt im lặng.
            if (parryNoRollDmg > 0) {
              rows.push(`> ⚠️ Có hit đã chọn Parry nhưng **hết roll** — ăn full **${parryNoRollDmg.toFixed(1)}**, không có lần thử nào`);
            }
            if (tagNote.length > 0) rows.push(`> ⚠️ Nhóm này có tag: ${tagNote.join(", ")}`);
            rows.push(`> ${isEnemyTarget ? "Enemy" : "Bạn"} có **${target.currentStamina} Stamina**. Chọn phòng thủ cho nhóm hit này:`);
            return rows.join("\n");
          })(),
          color: 0xe67e22,
        }],
        components: [row, ...counterRows],
      }).catch(() => {});

      if (canClashGeneral) {
        await sendThirdPartyClashPrompts(encounter, channelId, channel, p, t, attacker, isM1Type);
      }
      await sendYourShieldPrompts(encounter, channelId, channel, p, t, attacker);
      continue;

    }

    // Chạy TUẦN TỰ các target do AI điều khiển — xem lý do đầy đủ ở nhánh
    // `target.aiControlled` phía trên (AOE nhiều mob làm kẹt encounter).
    // Fire-and-forget CẢ CHUỖI, không phải từng cái.
    if (aiDefenseQueue.length > 0) {
      (async () => {
        for (const tid of aiDefenseQueue) {
          await aiHooks.resolveAiDefenseForTarget(channelId, pendingId, tid).catch(() => {});
        }
      })().catch(() => {});
    }
    // Lưới an toàn: nếu tới đây mà MỌI target đã được đánh dấu (VD nhánh AI
    // resolveAiDefenseForTarget vừa đánh dấu xong trong lúc ta đang gửi prompt),
    // resolve nốt — nhưng PHẢI đi qua commitAutoSkippedTargets để thao tác nằm
    // TRONG lock. TRƯỚC ĐÂY khối này tự resolve + saveEncounter NGOÀI lock, đó
    // chính là chỗ bị AI ghi đè làm sống lại pendingAction (xem comment đầy đủ
    // ở commitAutoSkippedTargets).
    const allTargetIds = p.targets.map(tg => tg.targetId);
    if (allTargetIds.length > 0 && allTargetIds.every(tid => p.reactedTargetIds.includes(tid))) {
      const late = await commitAutoSkippedTargets(channelId, pendingId);
      if (late.resolved) {
        drainAwaitingPrompts(channelId).catch(() => {});
        const resultChannel = await client.channels.fetch(channelId).catch(() => null);
        if (resultChannel) {
          await resultChannel.send({ embeds: [{ title: "⚔️ Đã xử lý (không cần phòng thủ)", description: (late.lines ?? []).join("\n"), color: 0x95a5a6 }] }).catch(() => {});
        }
        if (late.deleteAfterSave) {
          await deleteEncounter(channelId).catch((err) => log("error", "autoresolve-deleteEncounter", "system", err.message));
          return;
        }
        if (late.attackerIsAi) aiHooks.maybeRunAiTurn(channelId).catch(() => {});
        const encAfterLate = await getEncounter(channelId);
        if (encAfterLate) announceCurrentTurn(channelId, encAfterLate, true).catch(() => {});
      }
    }
  } catch (err) {
    log("error", "sendReactiveDefensePrompt", "system", err.message);
  }
}

/** drainAwaitingPrompts — gửi prompt cho MỌI pendingAction được SINH RA TRONG
 *  lúc resolve (hiện tại: Payback của Chains of Loyalty).
 *
 *  VÌ SAO PHẢI TÁCH RA MỘT HÀM RIÊNG, không gọi thẳng trong resolve:
 *  `resolveOnePendingAction` KHÔNG tự `saveEncounter` — caller mới save. Mà
 *  `sendReactiveDefensePrompt` đọc encounter TƯƠI từ Redis. Gọi ngay trong
 *  resolve là nó đọc bản CŨ, không thấy action vừa tạo, rồi `return` im lặng —
 *  đúng kiểu hỏng-mà-không-báo mà bug BGM đã dạy (§U).
 *
 *  VÌ SAO KHÔNG VÁ TỪNG NƠI GỌI: `resolveOnePendingAction` có **6 caller**.
 *  Lớp lỗi 8 ("vá từng nơi gọi thay vì sửa ở hàm được gọi") đã làm BGM sót đúng
 *  2 nhánh qua 3 lần sửa. Nên phần TẠO nằm gọn trong resolve, phần GỬI gom vào
 *  ĐÚNG hàm này, và có test cấu trúc khoá việc mọi caller phải gọi nó.
 *
 *  Hàm KHÔNG BAO GIỜ ném: prompt là lớp trình bày, hỏng nó không được kéo theo
 *  logic trận (lớp lỗi 12 — bài học `AttachmentBuilder` làm kẹt `pendingAction`).
 */
async function drainAwaitingPrompts(channelId) {
  try {
    // Pha 1 — CÓ KHOÁ: đọc tươi, gỡ cờ, lưu. Gỡ cờ TRƯỚC khi gửi để hai luồng
    // song song không cùng gửi một prompt hai lần (read-modify-write phải nằm
    // trong lock — đúng bài học lost-update của bug Stagger).
    let ids = [];
    // `retries: 8` — hàm này được gọi FIRE-AND-FORGET ngay sau `saveEncounter`,
    // nên caller RẤT có thể còn đang giữ lock encounter (`withLock` KHÔNG
    // re-entrant). Mặc định 3×200ms là quá ngắn và sẽ ném "đang xử lý lệnh
    // khác" — đúng lỗi đã làm `-daily` không hoàn thành quest.
    await withLock(encounterKey(channelId), async () => {
      const enc = await getEncounter(channelId);
      if (!enc) return;
      const waiting = (enc.pendingActions ?? []).filter(pa => pa.awaitingPrompt);
      if (waiting.length === 0) return;
      for (const pa of waiting) { pa.awaitingPrompt = false; ids.push(pa.id); }
      await saveEncounter(channelId, enc);
    }, { retries: 8 });
    // Pha 2 — KHÔNG KHOÁ: I/O Discord chậm, và `sendReactiveDefensePrompt` tự
    // lấy lock của riêng nó ở pha 1 của nó (`withLock` KHÔNG re-entrant — gọi
    // trong lock là tự chặn mình).
    for (const id of ids) await sendReactiveDefensePrompt(channelId, id);
  } catch (err) {
    log("error", "drainAwaitingPrompts", "system", err.message);
  }
}

  return { finalizeReactiveChoice, performEndTurn, announceCurrentTurn, sendThirdPartyClashPrompts, sendYourShieldPrompts, applyDullahanParryCounter, sendReactiveDefensePrompt, drainAwaitingPrompts };
};
