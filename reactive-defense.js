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

module.exports = function ({ ActionRowBuilder, ButtonBuilder, ButtonStyle, POISE_MAX, WEAPON_DEFENSE_HITS, advanceCombatantTurn, advanceToNextTurnHolder, buildBossActionPanel, buildEncounterActionPanel, buildEncounterBoardEmbed, calcMathCore, checkStaggerPanic, client, combatantResStr, computeDefenseOptions, determineTurnOrder, encounterKey, findSkill, getEncounter, hasPerk, log, parsePerHitBypass, parseSkillCost, resolveCombatant, resolveOnePendingAction, saveEncounter, validateAndRerollPrescript, withLock }) {

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
  await saveEncounter(channelId, encounter);
  return { resultText, stillWaitingFor };
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
    for (const ekey of Object.keys(encounter.enemies)) advanceCombatantTurn(encounter.enemies[ekey]);
    for (const pid of Object.keys(encounter.players)) advanceCombatantTurn(encounter.players[pid]);
    // "You're Too Slow": "turn sau kích hoạt lại 1 lần" — TỰ ĐỘNG gây lại dmg
    // (không cần rtparry lần 2) lên target đã đánh dấu từ round trước, nếu
    // target đó vẫn còn sống trong encounter.
    for (const c of [...Object.values(encounter.enemies), ...Object.values(encounter.players)]) {
      if (!c.youreTooSlowPending) continue;
      const markedResolved = resolveCombatant(encounter, c.youreTooSlowPending.markedTargetId);
      if (markedResolved && markedResolved.combatant.currentHp > 0) {
        const resStr = combatantResStr(markedResolved.combatant);
        const preview = calcMathCore({ dmgStr: c.youreTooSlowPending.dmgStr, resStr, poiseInit: c.poise, chargeInit: c.charge });
        markedResolved.combatant.currentHp = Math.max(0, markedResolved.combatant.currentHp - preview.totalDmg);
      }
      c.youreTooSlowPending = null;
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
    await saveEncounter(channelId, encounter);
    announceCurrentTurn(channelId, encounter, true).catch(() => {});
    resultInfo = { encounter, shroudedNotes, prescriptNotes };
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
      const boardEmbed = buildEncounterBoardEmbed(encounter);
      let edited = false;
      if (!forceNewMessage && encounter.boardMessageId) {
        const oldMsg = await mainChannel.messages.fetch(encounter.boardMessageId).catch(() => null);
        if (oldMsg) {
          await oldMsg.edit({ embeds: [boardEmbed] }).catch(() => {});
          edited = true;
        }
      }
      if (!edited) {
        const newMsg = await mainChannel.send({ embeds: [boardEmbed] }).catch(() => null);
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
          .setLabel(`⚔️ Clash thay cho ${targetResolved.label}`)
          .setStyle(ButtonStyle.Primary),
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
  attackerCombatant.currentHp = Math.max(0, attackerCombatant.currentHp - preview.totalDmg);
  return preview.totalDmg;
}

async function sendReactiveDefensePrompt(channelId, pendingId) {
  try {
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
      const opts = computeDefenseOptions(target, attackerWeapon, hitsInThisGroup, isM1Type, thisGroupBypass, false);

      // Counter/Clash — CHỈ hiện ở nhóm ĐẦU TIÊN chưa quyết định (ảnh hưởng
      // TOÀN BỘ đòn, không phải riêng 1 nhóm — cho phép chọn ở nhóm giữa chừng
      // sẽ mâu thuẫn với các nhóm đã quyết định trước đó).
      const isFirstUndecidedGroup = !t.perHitChoices.some(c => c !== null);
      const availableCounterPages = [];
      if (isFirstUndecidedGroup) {
        const addedCounterKeys = new Set();
        for (const pageName of (target.unlockedPagesSnapshot ?? [])) {
          const pageSkill = findSkill(pageName);
          if (!pageSkill || !pageSkill.counterEffect) continue;
          const pageKey = pageName.trim().toLowerCase();
          if (addedCounterKeys.has(pageKey)) continue;
          if ((target.skillCooldowns?.[pageKey] ?? 0) > 0) continue;
          const cost = parseSkillCost(pageSkill.cost);
          if ((target.currentLight ?? 0) < (cost.light ?? 0)) continue;
          addedCounterKeys.add(pageKey);
          availableCounterPages.push({ key: pageKey, name: pageSkill.name, lightCost: cost.light ?? 0 });
        }
      }
      const canClash = isFirstUndecidedGroup && !isM1Type && !thisGroupBypass.unclashable
        && (target.currentSpeed ?? -Infinity) > (attacker.combatant.currentSpeed ?? Infinity);
      const canClashGeneral = isFirstUndecidedGroup && !isM1Type && !thisGroupBypass.unclashable;

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
            .setCustomId(`encreactivedef:${channelId}:${pendingId}:${t.targetId}:counter:${cp.key}`)
            .setLabel(`⚔️ ${cp.name} (Counter)`)
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

      const dmgPreview = t.preview?.totalDmg?.toFixed(3) ?? "?";
      const tagNote = [thisGroupBypass.blockGuard && "Unblockable", thisGroupBypass.blockEvade && "Undodgeable", thisGroupBypass.blockParry && "Unparriable"].filter(Boolean);
      const groupHitRangeStart = currentGroupIdx * hitsPerCharge + 1;
      const groupHitRangeEnd = groupHitRangeStart + hitsInThisGroup - 1;
      const hitRangeLabel = hitsInThisGroup > 1 ? `Hit ${groupHitRangeStart}-${groupHitRangeEnd}` : `Hit ${groupHitRangeStart}`;
      await sendChannel.send({
        content: mentionText,
        embeds: [{
          title: `⚔️ Đang bị tấn công! — ${hitRangeLabel}/${hitCount} (Nhóm ${currentGroupIdx + 1}/${groupCount})`,
          description: `${attacker.label} tấn công ${targetResolved.label} với \`${p.dmgStr}\` (dự kiến **${dmgPreview}** dmg tổng nếu không phòng thủ)${tagNote.length > 0 ? `\n> Nhóm này có tag: ${tagNote.join(", ")}` : ""}\n> ${isEnemyTarget ? "Enemy" : "Bạn"} có **${target.currentStamina} Stamina**. Chọn phòng thủ cho nhóm hit này:`,
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
    // Nếu MỌI target trong đòn đều dmg=0 (toàn bộ bị auto-skip ở trên, không ai
    // được gửi prompt nào) — không còn ai để chờ, resolve NGAY thay vì để pending
    // treo vô thời hạn không ai bấm gì cả.
    const allTargetIds = p.targets.map(tg => tg.targetId);
    if (allTargetIds.length > 0 && allTargetIds.every(tid => p.reactedTargetIds.includes(tid))) {
      const lines = await resolveOnePendingAction(encounter, p);
      encounter.pendingActions = (encounter.pendingActions ?? []).filter(pa => pa.id !== pendingId);
      await saveEncounter(channelId, encounter);
      const resultChannel = await client.channels.fetch(channelId).catch(() => null);
      if (resultChannel) {
        await resultChannel.send({ embeds: [{ title: "⚔️ Đã xử lý (không gây dmg)", description: lines.join("\n"), color: 0x95a5a6 }] }).catch(() => {});
      }
    }
  } catch (err) {
    log("error", "sendReactiveDefensePrompt", "system", err.message);
  }
}

  return { finalizeReactiveChoice, performEndTurn, announceCurrentTurn, sendThirdPartyClashPrompts, sendYourShieldPrompts, applyDullahanParryCounter, sendReactiveDefensePrompt };
};
