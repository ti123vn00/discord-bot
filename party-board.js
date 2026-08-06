// party-board.js
// Party Board — "lobby" trước khi vào Quest encounter thật. 1 channel chỉ có 1
// Party Board tồn tại (giống nguyên tắc 1 channel = 1 encounter, xem
// encounter-persistence.js) — dùng key Redis riêng (party:<channelId>), KHÔNG
// đụng tới key encounter:<channelId> cho tới lúc startPartyBoard() convert.
//
// Người chọn contract lúc tạo board = HOST, những người join sau = GUEST. Tối
// đa 3 người/party (bao gồm host). Host có quyền kick/chuyển host/start/cancel
// bất cứ lúc nào.
//
// startPartyBoard() tự tạo 1 encounter THẬT (bypass gate admin-only của
// "-encounter start"/"addenemy" — vì đây là hành động PLAYER-facing, không phải
// GM command) — auto-join TỪNG member bằng buildJoinedCombatant (dùng CHUNG
// logic với "-encounter join" — xem player-join-builder.js), auto-add đủ số mob
// theo contract, rồi tự roll turn order (mirror "-encounter rollspeed", xem
// comment tại chỗ gọi bên dưới).
//
// GHI CHÚ: stage này (Stage 1+2 trong kế hoạch) CHƯA có AI enemy (enemy-ai.js) —
// sau khi start, mob vẫn cần GM/admin điều khiển thủ công qua lệnh có sẵn
// (-encounter enemyattack, GM Panel...) y hệt encounter thường, cho tới khi
// enemy-ai.js được nối vào (Stage 3-4). Encounter tạo ra được đánh dấu
// `isQuest: true` + `questMeta` để các stage sau (AI, reward, death penalty có
// điều kiện) nhận diện và xử lý riêng.

const { CONTRACTS, QUEST_MOBS } = require("./quest-data");

module.exports = function ({
  redis, withTimeout, withLock, withDoubleLock, getEncounter, saveEncounter, createCombatant,
  getPlayerData, buildJoinedCombatant, determineTurnOrder,
  validateAndRerollPrescript, appendActionLog, hasPerk, ADMIN_IDS, aiHooks, pickRandomBgm,
  setUserActiveEncounterChannel, calcGrade, GRADE_MIN, calcInjuryMaxHpPenalty, getEffectiveCurrentHp,
}) {
  const MAX_PARTY_SIZE = 3;

  function partyBoardKey(channelId) {
    return `partyboard:${channelId}`;
  }

  async function getPartyBoard(channelId) {
    const raw = await withTimeout(redis.get(partyBoardKey(channelId)));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  async function savePartyBoard(channelId, data) {
    await withTimeout(redis.set(partyBoardKey(channelId), JSON.stringify(data)));
  }

  async function deletePartyBoard(channelId) {
    await withTimeout(redis.del(partyBoardKey(channelId)));
  }

  /** allMemberIds — helper: host + toàn bộ guest, theo đúng thứ tự join (host
   *  luôn đứng đầu). Dùng nhiều nơi (check full, check đã-trong-party...). */
  function allMemberIds(board) {
    return [board.hostId, ...board.guests.map(g => g.id)];
  }

  async function createPartyBoard(channelId, hostId, hostName, contractKeyRaw) {
    const contractKey = (contractKeyRaw ?? "").trim().toLowerCase();
    const contract = CONTRACTS[contractKey];
    if (!contract) throw new Error(`Không tìm thấy contract "${contractKeyRaw}" — dùng \`-contract\` để xem danh sách.`);
    return withLock(partyBoardKey(channelId), async () => {
      const existingBoard = await getPartyBoard(channelId);
      if (existingBoard) throw new Error(`Channel này đang có 1 Party Board khác (contract **${CONTRACTS[existingBoard.contractKey]?.name ?? existingBoard.contractKey}**, host <@${existingBoard.hostId}>) — dùng \`-contract cancel\` (host) trước, hoặc join board đó.`);
      const existingEncounter = await getEncounter(channelId);
      if (existingEncounter) throw new Error(`Channel này đang có 1 encounter đang chạy (**${existingEncounter.name}**) — không thể tạo Party Board ở đây cho tới khi encounter đó kết thúc.`);
      const board = {
        channelId, contractKey, hostId, hostName, guests: [],
        createdAt: Date.now(),
      };
      await savePartyBoard(channelId, board);
      return board;
    });
  }

  async function joinPartyBoard(channelId, userId, userName) {
    return withLock(partyBoardKey(channelId), async () => {
      const board = await getPartyBoard(channelId);
      if (!board) throw new Error("Channel này chưa có Party Board nào — dùng `-contract` để tạo mới.");
      const members = allMemberIds(board);
      if (members.includes(userId)) throw new Error("Bạn đã ở trong party này rồi.");
      if (members.length >= MAX_PARTY_SIZE) throw new Error(`Party đã đủ ${MAX_PARTY_SIZE} người (tối đa) — không thể join thêm.`);
      board.guests.push({ id: userId, name: userName });
      await savePartyBoard(channelId, board);
      return board;
    });
  }

  async function kickFromPartyBoard(channelId, requesterId, targetId) {
    return withLock(partyBoardKey(channelId), async () => {
      const board = await getPartyBoard(channelId);
      if (!board) throw new Error("Channel này chưa có Party Board nào.");
      if (requesterId !== board.hostId) throw new Error("Chỉ host mới kick được thành viên khác.");
      if (targetId === board.hostId) throw new Error("Không thể tự kick chính mình (dùng huỷ party hoặc chuyển host trước nếu muốn rời).");
      const before = board.guests.length;
      board.guests = board.guests.filter(g => g.id !== targetId);
      if (board.guests.length === before) throw new Error("Người này không ở trong party.");
      await savePartyBoard(channelId, board);
      return board;
    });
  }

  async function transferHost(channelId, requesterId, newHostId) {
    return withLock(partyBoardKey(channelId), async () => {
      const board = await getPartyBoard(channelId);
      if (!board) throw new Error("Channel này chưa có Party Board nào.");
      if (requesterId !== board.hostId) throw new Error("Chỉ host hiện tại mới chuyển quyền host được.");
      const target = board.guests.find(g => g.id === newHostId);
      if (!target) throw new Error("Người này không ở trong party (phải là guest hiện có).");
      const oldHostId = board.hostId;
      const oldHostAsGuest = { id: oldHostId, name: board.hostName ?? "Host cũ" };
      board.guests = board.guests.filter(g => g.id !== newHostId);
      board.guests.push(oldHostAsGuest);
      board.hostId = newHostId;
      await savePartyBoard(channelId, board);
      return board;
    });
  }

  async function cancelPartyBoard(channelId, requesterId) {
    return withLock(partyBoardKey(channelId), async () => {
      const board = await getPartyBoard(channelId);
      if (!board) throw new Error("Channel này chưa có Party Board nào.");
      if (requesterId !== board.hostId) throw new Error("Chỉ host mới huỷ được party.");
      await deletePartyBoard(channelId);
      return board;
    });
  }

  /** leavePartyBoard — guest rời party (tự nguyện). Nếu HOST rời: tự chuyển host
   *  cho guest đầu tiên nếu còn ai đó, ngược lại huỷ luôn party (không còn ai). */
  async function leavePartyBoard(channelId, userId) {
    return withLock(partyBoardKey(channelId), async () => {
      const board = await getPartyBoard(channelId);
      if (!board) throw new Error("Channel này chưa có Party Board nào.");
      if (userId !== board.hostId) {
        const before = board.guests.length;
        board.guests = board.guests.filter(g => g.id !== userId);
        if (board.guests.length === before) throw new Error("Bạn không ở trong party này.");
        await savePartyBoard(channelId, board);
        return { board, disbanded: false };
      }
      if (board.guests.length === 0) {
        await deletePartyBoard(channelId);
        return { board: null, disbanded: true };
      }
      const nextHost = board.guests[0];
      board.guests = board.guests.slice(1);
      board.hostId = nextHost.id;
      await savePartyBoard(channelId, board);
      return { board, disbanded: false };
    });
  }

  /** startPartyBoard — chuyển Party Board thành 1 encounter THẬT. Chỉ host mới
   *  start được. Tự join TỪNG member (dùng buildJoinedCombatant — CHUNG logic
   *  với "-encounter join"), tự spawn đủ mob theo contract.killCount, tự roll
   *  turn order ban đầu (mirror "-encounter rollspeed" — xem comment bên dưới,
   *  bản gốc nằm ở message-create-handler.js's `sub === "rollspeed"`). */
  async function startPartyBoard(channelId, requesterId) {
    // Lock CẢ party board LẪN encounter cùng lúc (withDoubleLock — có sẵn trong
    // index.js, tự sort thứ tự lock để tránh deadlock) — tránh race condition
    // với join/kick/cancel party board HOẶC 1 encounter khác được tạo đồng thời
    // trong lúc đang start (2 key khác nhau nên withLock đơn không đủ an toàn).
    return withDoubleLock(partyBoardKey(channelId), encounterKey_(channelId), async () => {
      const board = await getPartyBoard(channelId);
      if (!board) throw new Error("Channel này chưa có Party Board nào.");
      if (requesterId !== board.hostId) throw new Error("Chỉ host mới start được contract.");
      const contract = CONTRACTS[board.contractKey];
      if (!contract) throw new Error(`Contract "${board.contractKey}" không hợp lệ (data lỗi?).`);
      const mobData = QUEST_MOBS[contract.mobKey];
      if (!mobData) throw new Error(`Mob "${contract.mobKey}" không tìm thấy trong quest-data.js (data lỗi?).`);

      const memberIds = allMemberIds(board);
      // Check Permanent Death cho TỪNG member TRƯỚC khi tạo gì cả (fail sớm,
      // giống nguyên tắc "-encounter join" — tránh tạo encounter dở dang rồi
      // mới phát hiện 1 người không join được).
      const profiles = {};
      for (const id of memberIds) {
        const p = await getPlayerData(id);
        if (p.permanentlyDead) throw new Error(`<@${id}> đang **Permanent Death** — không thể bắt đầu contract cho tới khi được hồi sinh qua Rewound Time.`);
        // Cùng bug fix với "-encounter join" — chặn 0 HP TRƯỚC khi tạo encounter,
        // tránh kẹt (xem comment đầy đủ ở message-create-handler.js's -encounter join).
        const { grade: gradeForHpCheck } = calcGrade(p.exp ?? 0);
        const gradeMaxHpForCheck = Math.max(1, 140 + 20 * (GRADE_MIN - gradeForHpCheck) - calcInjuryMaxHpPenalty(p.injuries ?? []));
        const effHpForCheck = getEffectiveCurrentHp(p, gradeMaxHpForCheck);
        if (effHpForCheck.hp <= 0) throw new Error(`<@${id}> đang có **0 HP** (chưa hồi từ encounter trước) — cần hồi trước (dùng \`-heal hp: <ahn>\` hoặc đợi qua mốc reset) mới bắt đầu contract được.`);
        profiles[id] = p;
      }

      const existingEncounter = await getEncounter(channelId);
      if (existingEncounter) throw new Error(`Channel này đã có 1 encounter khác đang chạy (**${existingEncounter.name}**) — không thể start contract.`);

      const encounter = {
        name: `Contract: ${contract.name}`,
        enemies: {}, players: {},
        gmId: board.hostId, createdAt: Date.now(),
        pendingActions: [], permadeath: false,
        turnNumber: 1, actionLog: [],
        // isQuest/questMeta — đánh dấu để enemy-ai.js (Stage 3-4) và reward/
        // death-penalty logic (Stage 5) nhận diện đây KHÔNG PHẢI encounter GM
        // thường — Death Penalty tự động lúc HP=0 (resolve-pending-action.js)
        // sẽ cần check cờ isQuest này để KHÔNG áp ngay (chỉ áp nếu cả team
        // chết, theo yêu cầu trực tiếp) — CHƯA nối ở stage này.
        isQuest: true,
        // currentBgm — CHUNG quy tắc với "-encounter start" (chọn ngẫu nhiên 1
        // lần lúc tạo, cố định suốt trận — xem comment đầy đủ ở sfx-config.js's
        // pickRandomBgm) — "mọi encounter" bao gồm CẢ encounter tự tạo từ party
        // board, không chỉ encounter GM tạo thủ công.
        currentBgm: pickRandomBgm(),
        questMeta: {
          contractKey: board.contractKey, hostId: board.hostId,
          memberIds, killTarget: contract.killCount, mobKey: contract.mobKey,
          expReward: contract.expReward, ahnReward: contract.ahnReward,
          deadPlayerIds: [],
        },
      };

      const memberStartNotes = [];
      // Auto-join từng member — CHUNG logic với "-encounter join" (kv rỗng, 100%
      // lấy theo profile — party board không hỗ trợ override tay hp/stamina/...).
      for (const id of memberIds) {
        const memberName = id === board.hostId
          ? (board.hostName ?? "Host")
          : (board.guests.find(g => g.id === id)?.name ?? "Player");
        // GAP ĐÃ SỬA (truy từ báo cáo "Perfect Cube có hoạt động đâu?") — đường
        // Party Board VỨT BỎ hoàn toàn `startNotes` mà buildJoinedCombatant trả
        // về, trong khi `-encounter join` có hiện. Nghĩa là bonus khởi điểm
        // (Perfect Cube, Udjat, Here We Go Again, Adrenaline Rush...) vẫn ĐƯỢC
        // ÁP nhưng KHÔNG BÁO GÌ — người chơi vào contract không có cách nào biết
        // accessory/perk của mình có chạy hay không. Gom lại trả cho caller hiển
        // thị (interaction-handlers.js gửi kèm board).
        const joinResult = await buildJoinedCombatant(encounter, id, memberName, profiles[id], {});
        if ((joinResult?.startNotes ?? []).length > 0) {
          memberStartNotes.push(`<@${id}>: ${joinResult.startNotes.join(", ")}`);
        }
        await setUserActiveEncounterChannel(id, channelId).catch(() => {});
      }

      // Spawn đủ mob theo killCount — key dạng "<mobKey>1", "<mobKey>2"...
      for (let i = 1; i <= contract.killCount; i++) {
        const mobKeyInEncounter = `${contract.mobKey}${i}`;
        encounter.enemies[mobKeyInEncounter] = createCombatant({
          name: mobData.name, maxHp: mobData.maxHp,
          maxStamina: mobData.maxStamina, maxLight: mobData.maxLight,
          maxSanity: mobData.maxSanity ?? 0,
          weaponWeight: mobData.weaponWeight, resistance: { ...mobData.resistance },
        });
        const mob = encounter.enemies[mobKeyInEncounter];
        mob.unlockedPagesSnapshot = [...mobData.skills];
        // Field riêng cho AI (enemy-ai.js, Stage 3-4 — CHƯA đọc field này ở stage
        // hiện tại, mob cần GM điều khiển thủ công tạm thời cho tới khi nối AI).
        mob.aiControlled = true;
        mob.m1DmgStr = mobData.m1DmgStr;
        if (mobData.m1DmgStrAlt) mob.m1DmgStrAlt = mobData.m1DmgStrAlt;
        if (mobData.ammoImmune) mob.ammoImmune = true;
        // Cờ "không có Sanity" — PHẢI chuyển sang combatant, nếu không
        // damage-calc/applySanityGain không thấy (chúng đọc combatant, không đọc
        // QUEST_MOBS).
        if (mobData.noSanity) mob.noSanity = true;
        if (mobData.defenseImmune) mob.defenseImmune = true;
        if (mobData.noStaminaCost) mob.noStaminaCost = true;
        if (mobData.noM1) mob.noM1 = true;
        if (mobData.aiSpreadTargets) mob.aiSpreadTargets = true;
        if (Array.isArray(mobData.attackPattern)) {
          mob.attackPattern = mobData.attackPattern;
          mob.bossPatternIdx = 0;
        }
        if (mobData.permanentDiceUp) {
          mob.diceUp = (mob.diceUp ?? 0) + mobData.permanentDiceUp;
          mob.permanentDiceUp = mobData.permanentDiceUp;
        }
      }

      // Roll turn order ban đầu — MIRROR "-encounter rollspeed" (message-create-
      // handler.js's sub === "rollspeed"). COPY phần xử lý ĐẶC BIỆT cho round 1
      // (Light Dash/Rotate Trigram không đi qua advanceCombatantTurn ở round đầu
      // — xem gotcha tương ứng ở rollspeed gốc). Nếu logic rollspeed gốc đổi sau
      // này, NHỚ đồng bộ lại đoạn này (chưa extract thành hàm dùng chung do quy
      // mô nhỏ hơn nhiều so với join, ưu tiên thời gian ở Stage 1-2).
      determineTurnOrder(encounter);
      for (const c of [...Object.values(encounter.enemies), ...Object.values(encounter.players)]) {
        if (hasPerk(c, "Light Dash")) {
          c.currentLight = Math.min(c.maxLight, c.currentLight + 2);
        }
        if (c.weaponName === "Augury Spear") {
          const idx = c.rotateTrigramIndex ?? 0;
          if (idx === 0) c.diceUp = (c.diceUp ?? 0) + 3;
          else if (idx === 1) c.protection = Math.min(20, (c.protection ?? 0) + 7);
          else if (idx === 2) c.currentLight = Math.min(c.maxLight, (c.currentLight ?? 0) + 2);
          else if (idx === 3) c.rotateTrigramRiPending = true;
          c.rotateTrigramIndex = (idx + 1) % 4;
        }
      }
      const prescriptNotesInit = validateAndRerollPrescript(encounter, null, encounter.turnOrder[0] ?? null);
      appendActionLog(encounter, `🎲 Party Board → Encounter — Contract **${contract.name}** bắt đầu.`);

      await saveEncounter(channelId, encounter);
      await deletePartyBoard(channelId);
      return { encounter, contract, prescriptNotesInit, memberStartNotes };
    }).then((result) => {
      // Hook AI (Stage 4) — NGOÀI withDoubleLock ở trên (tránh reentrant lock —
      // AI có thể tự gọi doEnemyAttack, tự lock lại encounterKey này). Trường
      // hợp mob đi ĐẦU TIÊN trong turnOrder mới roll — cần trigger để nó tự
      // hành động ngay, KHÔNG đợi ai gọi rollspeed/pass/endturn nào khác (contract
      // begin tự roll turn order riêng, không đi qua "-encounter rollspeed").
      aiHooks.maybeRunAiTurn(channelId).catch(() => {});
      return result;
    });
  }

  // encounterKey_ — TRÁNH trùng tên với encounterKey đã export ở encounter-
  // persistence.js (không inject hàm đó vào đây để giữ dependency tối thiểu,
  // chỉ cần đúng CHUỖI KEY, format giống hệt "encounter:<channelId>").
  function encounterKey_(channelId) {
    return `encounter:${channelId}`;
  }

  return {
    MAX_PARTY_SIZE,
    partyBoardKey, getPartyBoard, savePartyBoard, deletePartyBoard,
    createPartyBoard, joinPartyBoard, kickFromPartyBoard, transferHost,
    cancelPartyBoard, leavePartyBoard, startPartyBoard, allMemberIds,
  };
};
