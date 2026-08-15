// combat-utils.js
// Nhóm hàm tiện ích combat dùng chung (Speed/Turn Order, Resistance display,
// Parry/Evade success perks, Injury/Death penalty, Action Log, Stagger/Panic
// check) — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp tục tách hàm ra
// thành file riêng". Dùng pattern dependency-injection GIỐNG player-actions.js/
// skill-tree.js/book-system.js (factory function nhận dependency làm tham số,
// tránh circular require với index.js).
//
// applyDeathPenalty là hàm DUY NHẤT trong nhóm này cần Redis (getPlayerDataWithSlot/
// savePlayerData) + calcGrade — các hàm còn lại đều THUẦN (không I/O), chỉ thao
// tác trực tiếp trên combatant/encounter object đã có sẵn.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ CADUCEUS_DICE, PRESCRIPT_RULES_PROSELYTE, PRESCRIPT_DICE_PROSELYTE, CADUCEUS_STAMINA_PER_CHARGE, WEAPON_DEFENSE_HITS_CU, UNLOCK_THRESHOLDS, PRESCRIPT_DICE_PER_TURN, PRESCRIPT_RULES, KARMIC_PER_FAILURE, KARMIC_MAX, hasPerk, getPlayerDataWithSlot, savePlayerData, calcGrade, CHARGE_MAX, ENCOUNTER_SANITY_MAX, findWeaponAnywhere }) {

  // Trần của Indulgence in Prescript — Fragaria chốt: max cap 1, hết sau end turn.
  // Khai MỘT chỗ để 2 nơi cộng (Singleton ở đây + Prescript ở interaction-handlers)
  // không bao giờ lệch nhau.
  const INDULGENCE_MAX = 1;

  /** rollSpeedValue — roll trong Range Speed của combatant, cộng Haste trừ Bind
   *  ("1 Haste +1 Speed, 1 Bind -1 Speed" theo update mới). */
  function rollSpeedValue(combatant) {
    const base = combatant.speedRangeMin + Math.floor(Math.random() * (combatant.speedRangeMax - combatant.speedRangeMin + 1));
    return base + (combatant.haste ?? 0) - (combatant.bind ?? 0);
  }
  
  /**
   * determineTurnOrder — roll Speed cho TẤT CẢ combatant, sắp xếp giảm dần quyết
   * định thứ tự hành động. Khi bằng Speed:
   *   - CÙNG PHE (player-player hoặc enemy-enemy) → GAP ĐÃ SỬA (xác nhận trực
   *     tiếp): "kể cả player với player với nhau cũng nên random luôn, không
   *     nên cho tự chọn nữa vì dễ confuse" — KHÔNG tự roll lại Speed, nhưng
   *     entries.sort() bên dưới TỰ RANDOM thứ tự (Math.random() tie-break),
   *     không còn "tự thoả thuận" thủ công nữa — "tiedWith" chỉ còn dùng để
   *     HIỂN THỊ cho biết ai đang hoà Speed với ai (buildTurnOrderText).
   *   - KHÁC PHE (có cả player VÀ enemy cùng Speed) → reroll NGAY giữa các bên đang
   *     tie cho tới khi hết tie (lặp, chặn tối đa 20 lần phòng hờ — gần như không
   *     thể chạm trần này với range hữu hạn của dice thật).
   * Lưu kết quả vào encounter.turnOrder để dùng cho hiển thị/tham chiếu Clash sau này.
   */
  function determineTurnOrder(encounter) {
    const entries = [];
    for (const ekey of Object.keys(encounter.enemies)) {
      const c = encounter.enemies[ekey];
      c.currentSpeed = rollSpeedValue(c);
      entries.push({ id: ekey, type: "enemy", combatant: c });
    }
    for (const pid of Object.keys(encounter.players)) {
      const c = encounter.players[pid];
      c.currentSpeed = rollSpeedValue(c);
      entries.push({ id: pid, type: "player", combatant: c });
    }
  
    let guard = 0;
    while (guard++ < 20) {
      const bySpeed = new Map();
      for (const e of entries) {
        const list = bySpeed.get(e.combatant.currentSpeed) ?? [];
        list.push(e);
        bySpeed.set(e.combatant.currentSpeed, list);
      }
      let rerolled = false;
      for (const group of bySpeed.values()) {
        if (group.length < 2) continue;
        if (new Set(group.map(e => e.type)).size > 1) {
          for (const e of group) e.combatant.currentSpeed = rollSpeedValue(e.combatant);
          rerolled = true;
        }
      }
      if (!rerolled) break;
    }
  
    // "roll ra bằng speed" — GAP ĐÃ SỬA (xác nhận trực tiếp): "hãy thêm trường
    // hợp nếu roll ra bằng speed thì random người đi trước hoặc sau" — trước
    // đây chỉ REROLL khi speed bằng nhau KHÁC PHE (dòng trên); CÙNG phe bằng
    // speed thì Array.sort() (stable từ ES2019) giữ NGUYÊN thứ tự push ban đầu
    // (enemies trước, rồi players theo Object.keys() — không hề random). Random
    // hoá tie-break: cùng speed thì Math.random() quyết định ai trước/sau.
    entries.sort((a, b) => b.combatant.currentSpeed - a.combatant.currentSpeed || Math.random() - 0.5);
    const order = entries.map((e, i) => ({
      id: e.id, type: e.type, speed: e.combatant.currentSpeed,
      tiedWith: entries.filter((o, j) => j !== i && o.combatant.currentSpeed === e.combatant.currentSpeed).map(o => o.id),
    }));
    encounter.turnOrder = order;
    // Turn Order Enforcement (xác nhận trực tiếp): "CHỈ đúng lượt mới được M1/
    // skill — sai lượt thì bị chặn, chỉ phòng thủ phản ứng được thôi" — mỗi lần
    // roll Speed MỚI (turn mới hoặc lần đầu), reset về người ĐẦU TIÊN trong thứ
    // tự vừa roll.
    // GAP ĐÃ SỬA (phát hiện qua rà soát): nếu người Ở VỊ TRÍ ĐẦU TIÊN đã đang
    // Stagger/chết SẴN TỪ round trước (VD dính Stagger cuối round cũ, vẫn còn
    // hiệu lực khi round mới bắt đầu) — set thẳng currentTurnIndex=0 sẽ trỏ vào
    // họ mà KHÔNG skip (advanceToNextTurnHolder chỉ skip khi tìm người TIẾP
    // THEO, không áp dụng cho vị trí khởi đầu này) — announceCurrentTurn sẽ mời
    // 1 người sắp bị chặn ngay khi thử hành động. Sửa: set -1 rồi advance ngay
    // (tái dùng ĐÚNG logic "tìm người hợp lệ" đã có, không viết lại).
    encounter.currentTurnIndex = -1;
    advanceToNextTurnHolder(encounter);
    return order;
  }

  /** insertIntoTurnOrderMidRound — GAP ĐÃ SỬA (phát hiện qua rà soát): "-encounter
   *  join"/"addenemy" trước đây HOÀN TOÀN không đụng tới turnOrder — nghĩa là ai
   *  tham gia hoặc được thêm vào GIỮA 1 round (sau khi đã rollspeed) sẽ KHÔNG BAO
   *  GIỜ được thêm vào turnOrder hiện tại, bị Turn Order Enforcement chặn hành
   *  động cho tới khi CẢ round kết thúc (có thể rất lâu). Sửa: roll Speed cho
   *  combatant mới (cùng cách determineTurnOrder làm — gán vào currentSpeed),
   *  chèn NGAY SAU currentTurnIndex (không so sánh Speed với các entry CÒN LẠI
   *  để giữ đơn giản/an toàn — không làm xô lệch currentTurnIndex của những
   *  người đã hành động TRƯỚC đó). Không làm gì nếu turnOrder rỗng (chưa từng
   *  rollspeed — combatant sẽ tự nhiên có mặt ở lần rollspeed đầu tiên). */
  function insertIntoTurnOrderMidRound(encounter, id, type, combatant) {
    const order = encounter.turnOrder ?? [];
    if (order.length === 0) return; // chưa rollspeed lần nào — không cần chèn
    if (order.some(e => e.id === id)) return; // đã có sẵn (VD rejoin), tránh trùng
    combatant.currentSpeed = rollSpeedValue(combatant);
    const insertIdx = (encounter.currentTurnIndex ?? 0) + 1;
    order.splice(insertIdx, 0, { id, type, speed: combatant.currentSpeed, tiedWith: [] });
  }

  /** isCurrentTurnHolder — Turn Order Enforcement: kiểm tra id (playerId hoặc
   *  enemyKey) có ĐÚNG là người/enemy đang tới lượt hay không. Trả về true LUÔN
   *  nếu chưa từng roll Speed (turnOrder rỗng) — không ép buộc turn order nếu GM
   *  chưa dùng tính năng này, giữ tương thích ngược hoàn toàn. */
  function isCurrentTurnHolder(encounter, id) {
    const order = encounter.turnOrder ?? [];
    // BUG ĐÃ SỬA (xác nhận trực tiếp): "khi nào -encounter rollspeed thì encounter
    // mới thật sự bắt đầu, trước đó thì khóa mọi hành động của mọi mob lẫn player
    // lại... cứ khi có player encounter join vào thì họ hành động được ngay luôn,
    // trong khi vẫn chưa roll gì" — TRƯỚC ĐÂY order rỗng (chưa rollspeed) →
    // return true CHO BẤT KỲ AI (nghĩa là "luôn đúng lượt", ai cũng hành động
    // được ngay) — HOÀN TOÀN NGƯỢC LẠI ý muốn. Giờ order rỗng → false (KHÓA
    // TẤT CẢ, không ai coi là "đúng lượt" cho tới khi GM chạy rollspeed).
    if (order.length === 0) return false;
    const idx = encounter.currentTurnIndex ?? 0;
    return order[idx]?.id === id;
  }

  /** hasEncounterStarted — true khi đã có turnOrder (đã rollspeed ít nhất 1 lần)
   *  — dùng để phân biệt thông báo lỗi "Encounter chưa bắt đầu" (rõ ràng hơn,
   *  trỏ đúng hướng khắc phục) với "Chưa tới lượt bạn" (đã bắt đầu, chỉ là
   *  đang là lượt người khác). */
  function hasEncounterStarted(encounter) {
    return (encounter.turnOrder ?? []).length > 0;
  }

  /** advanceToNextTurnHolder — Turn Order Enforcement: chuyển sang người TIẾP
   *  THEO trong turnOrder, TỰ ĐỘNG bỏ qua (không cần "pass" thủ công) người đã
   *  chết (currentHp<=0) hoặc đang Stagger (không thể hành động) — họ vẫn được
   *  liệt kê trong turnOrder cho hiển thị, chỉ không chiếm lượt thật. Trả về
   *  true nếu đã đi hết 1 vòng (tất cả đã hành động/bị skip) — GM nên dùng
   *  `-encounter endturn` khi thấy true. */
  // GAP ĐÃ SỬA (xác nhận trực tiếp: "tự động hóa mọi thứ đừng có nhìn note nữa...
  // quy trình quá phức tạp, cần xử lý tự động để đỡ tốn thời gian... tôi muốn
  // đây là một game thực thụ") — TOÀN BỘ hệ thống Index Proselyte (roll 1-7 mỗi
  // turn, kiểm tra có làm ĐÚNG sắc lệnh hay không dựa trên hành động THẬT đã
  // track — Tấn công/Né/Block/Parry/Clash đều có lệnh thật trong bot) + Will of
  // Prescript (Index Longsword/Cleaver, đánh dấu random 1 địch mỗi turn). Trước
  // đây bị đánh dấu "KHÔNG TỰ ĐỘNG HOÁ" — ĐÃ LỖI THỜI, giờ tự động hoàn toàn.
  /** PRESCRIPT (The Index Oracle's Proxy) — chấm sắc lệnh của vòng vừa qua rồi
   *  gieo sắc lệnh mới.
   *
   *  ⚠️ ĐỔI LUẬT theo bản Fragaria gửi (khác hẳn bản cũ):
   *   • **2 dice mỗi turn**, không phải 1.
   *   • Bảng 1–7 MỚI: 5/6/7 là "đánh bằng vũ khí Blunt/Pierce/Slash", thay cho
   *     block/parry/không-làm-gì của bảng cũ.
   *   • Đủ 3/6/9 Grace ⇒ Unlock I/II/III.
   *   • Mỗi sắc lệnh trượt = 5 Karmic (2 dice ⇒ tối đa 10/turn), trần 100.
   *
   *  ⚠️ "turn" = MỘT VÒNG TURN ORDER. Hàm này chỉ được gọi từ
   *  validateAndRerollPrescriptRound (mốc hết vòng), KHÔNG phải lượt riêng.
   */
  /** prescriptVariantOf — outfit nào thì dùng bảng nào.
   *  Hai outfit CÙNG faction The Index nhưng bảng KHÁC NHAU (xem constants.js). */
  function prescriptVariantOf(c) {
    return c?.hasIndexOraclesProxy ? "proxy" : (c?.hasIndexProselyte ? "proselyte" : null);
  }

  function evaluateOnePrescript(c, roll) {
    const attacked = !!c.prescriptAttacked;
    const evaded = !!c.prescriptEvaded, blocked = !!c.prescriptBlocked, parried = !!c.prescriptParried;
    const defended = evaded || blocked || parried;
    const types = c.prescriptAttackTypes ?? {};
    if (prescriptVariantOf(c) === "proselyte") {
      // Bảng CŨ của Index Proselyte — GIỮ NGUYÊN, KHÔNG dùng bảng mới.
      const mapOld = {
        1: attacked,
        2: evaded,
        3: blocked,
        4: parried,
        5: attacked && defended,
        6: !attacked && !defended && !c.prescriptClashed, // "Không làm gì cả"
        7: !!c.prescriptClashed,
      };
      return !!mapOld[roll];
    }
    const map = {
      1: attacked,
      2: defended,
      3: attacked && defended,
      4: !!c.prescriptClashed,
      5: !!types.Blunt,
      6: !!types.Pierce,
      7: !!types.Slash,
    };
    return !!map[roll];
  }

  /** applyUnlockProgress — quy Grace ra bậc Unlock (3/6/9).
   *  Trả về bậc MỚI đạt được lần đầu (1|2|3) hoặc 0 nếu không đổi. */
  function applyUnlockProgress(c) {
    const th = UNLOCK_THRESHOLDS ?? [3, 6, 9];
    let lvl = 0;
    for (let i = 0; i < th.length; i++) if ((c.graceOfPrescript ?? 0) >= th[i]) lvl = i + 1;
    const before = c.prescriptUnlockLevel ?? 0;
    c.prescriptUnlockLevel = Math.max(before, lvl);
    return c.prescriptUnlockLevel > before ? c.prescriptUnlockLevel : 0;
  }

  function validateAndRerollPrescript(encounter, leavingEntry, enteringEntry) {
    const notes = [];
    const DICE_PER_TURN = PRESCRIPT_DICE_PER_TURN ?? 2;
    if (leavingEntry) {
      const c = leavingEntry.type === "enemy" ? encounter.enemies[leavingEntry.id] : encounter.players[leavingEntry.id];
      const rolls = c?.prescriptRolls;
      if (c && Array.isArray(rolls) && rolls.length > 0) {
        const label = leavingEntry.type === "enemy" ? (encounter.enemies[leavingEntry.id]?.name ?? leavingEntry.id) : `<@${leavingEntry.id}>`;
        let succeeded = 0, failed = 0;
        for (const roll of rolls) {
          if (evaluateOnePrescript(c, roll)) succeeded++; else failed++;
        }
        if (succeeded > 0) {
          // ❗ BUG ĐÃ SỬA (Fragaria: "Grace of Prescript tràn lên VÔ HẠN trong khi
          // max cap là 9"). TRẦN = bậc Unlock cao nhất (UNLOCK_THRESHOLDS cuối =
          // 9) — lấy TỪ ĐÓ chứ không gõ số rời, để không bao giờ lệch nhau.
          // Quan trọng vì Will of Prescript cộng 10%/Grace (Caduceus): không kẹp
          // thì %Dmg tăng vô hạn theo số turn.
          const graceMax = (UNLOCK_THRESHOLDS ?? [3, 6, 9]).slice(-1)[0] ?? 9;
          const graceBefore = c.graceOfPrescript ?? 0;
          c.graceOfPrescript = Math.min(graceMax, graceBefore + succeeded);
          const graceGained = c.graceOfPrescript - graceBefore;
          notes.push(`<:Prescript:1528452494945157281> ${label}: **${succeeded}/${rolls.length}** sắc lệnh THÀNH CÔNG — +${graceGained} Grace of the Prescript (tổng ${c.graceOfPrescript}/${graceMax})${graceGained < succeeded ? " — đã chạm trần" : ""}.`);
          const newLvl = applyUnlockProgress(c);
          if (newLvl > 0) {
            c.prescriptUnlockJustReached = newLvl; // accessory đọc để hồi 10 Sanity 1 lần
            notes.push(`<:Unlock:1528452595859849406> ${label} đạt **Unlock - ${["I", "II", "III"][newLvl - 1]}**!`);
          }
        }
        if (failed > 0) {
          // "Prescript Delivered on a Device" (accessory) — vào Unlock III thì
          // KHÔNG còn nhận Karmic khi trượt sắc lệnh.
          const karmicImmune = c.hasPrescriptDevice && (c.prescriptUnlockLevel ?? 0) >= 3;
          if (karmicImmune) {
            notes.push(`<:Unlock:1528452595859849406> ${label}: trượt ${failed} sắc lệnh nhưng **Prescript Delivered on a Device** (Unlock III) miễn Karmic.`);
          } else {
            c.karmicConsequence = Math.min(KARMIC_MAX ?? 100, (c.karmicConsequence ?? 0) + (KARMIC_PER_FAILURE ?? 5) * failed);
            notes.push(`<:Karmic_Consequence:1532503901687779338> ${label}: trượt **${failed}** sắc lệnh — +${(KARMIC_PER_FAILURE ?? 5) * failed} Karmic Consequence (tổng ${c.karmicConsequence}, nhận thêm ${c.karmicConsequence}% Dmg).`);
          }
        }
        // Ghi lại cho "Undertake Prescript" (accessory): turn TRƯỚC có hoàn thành
        // ít nhất 1 sắc lệnh không.
        c.prescriptSucceededLastTurn = succeeded > 0;
      }
      if (c) {
        c.prescriptRolls = null;
        c.prescriptAttacked = false;
        c.prescriptEvaded = false;
        c.prescriptBlocked = false;
        c.prescriptParried = false;
        c.prescriptClashed = false;
        c.prescriptAttackTypes = {};
      }
    }
    if (enteringEntry) {
      const c = enteringEntry.type === "enemy" ? encounter.enemies[enteringEntry.id] : encounter.players[enteringEntry.id];
      if (c) {
        const label = enteringEntry.type === "enemy" ? (encounter.enemies[enteringEntry.id]?.name ?? enteringEntry.id) : `<@${enteringEntry.id}>`;
        // `hasIndexProselyte` GIỮ LẠI cho dữ liệu cũ; cờ mới là hasIndexOraclesProxy.
        if (c.hasIndexOraclesProxy || c.hasIndexProselyte) {
          // Số dice và bảng nhãn PHỤ THUỘC OUTFIT: Proselyte 1 dice/bảng cũ,
          // Oracle's Proxy 2 dice/bảng mới.
          const variant = prescriptVariantOf(c);
          const nDice = variant === "proselyte" ? (PRESCRIPT_DICE_PROSELYTE ?? 1) : DICE_PER_TURN;
          const rules = (variant === "proselyte" ? PRESCRIPT_RULES_PROSELYTE : PRESCRIPT_RULES) ?? {};
          c.prescriptRolls = Array.from({ length: nDice }, () => Math.floor(Math.random() * 7) + 1);
          c.prescriptVariant = variant; // để encounter-display hiện ĐÚNG bảng nhãn
          const lines = c.prescriptRolls.map(rn => `**#${rn}** — ${rules[rn]?.label ?? "?"}`);
          notes.push(`<:Prescript:1528452494945157281> **Sắc lệnh mới** cho ${label} (${nDice} dice): ${lines.join(" · ")}`);
        }
        const weaponInfo = findWeaponAnywhere(c.weaponName);
        const hasWillOfPrescript = (weaponInfo?.passives ?? []).some(pa => pa.name === "Will of Prescript");
        if (hasWillOfPrescript) {
          if (c.prescriptTargetId && encounter.enemies[c.prescriptTargetId]) {
            delete encounter.enemies[c.prescriptTargetId].markedByPrescriptTargetOf;
          }
          const livingEnemyKeys = Object.keys(encounter.enemies ?? {}).filter(k => (encounter.enemies[k]?.currentHp ?? 0) > 0);
          if (livingEnemyKeys.length > 0) {
            const pick = livingEnemyKeys[Math.floor(Math.random() * livingEnemyKeys.length)];
            c.prescriptTargetId = pick;
            c.prescriptTargetName = encounter.enemies[pick]?.name ?? pick;
            encounter.enemies[pick].markedByPrescriptTargetOf = label;
            notes.push(`<:The_Prescripts_Target:1528452363159998525> **The Prescript Target's - The Index** đánh dấu lên **${c.prescriptTargetName}** (+${10 * (c.graceOfPrescript ?? 0)}% Dmg từ Grace).`);
          }
        }
      }
    }
    return notes;
  }

  /** validateAndRerollPrescriptRound — chấm + roll lại sắc lệnh cho TOÀN BỘ
   *  combatant, đúng MỘT LẦN mỗi vòng turn order.
   *
   *  Gọi từ `performEndTurn` (mốc hết vòng), cùng chỗ với `advanceCombatantTurn`
   *  — nhờ vậy người đang Stagger vẫn được chấm/roll bình thường thay vì bị
   *  vòng lặp tìm-người-kế bỏ qua (xem comment trong advanceToNextTurnHolder).
   *  Chấm HẾT trước rồi mới roll HẾT: nếu xen kẽ, người roll trước có thể ảnh
   *  hưởng kết quả chấm của người sau qua các cờ dùng chung.
   */
  function validateAndRerollPrescriptRound(encounter) {
    const notes = [];
    const entries = (encounter.turnOrder ?? []).filter(e => {
      const c = e.type === "enemy" ? encounter.enemies[e.id] : encounter.players[e.id];
      return c && c.currentHp > 0;
    });
    for (const e of entries) notes.push(...validateAndRerollPrescript(encounter, e, null));
    for (const e of entries) notes.push(...validateAndRerollPrescript(encounter, null, e));
    return notes;
  }

  /** computeDiceModifier — Dice Up/Down NET của một combatant.
   *
   *  BUG GỐC ĐÃ SỬA (Fragaria: "passive của Hana Outfit có vẻ hoạt động không
   *  đúng, player báo là nó không hoạt động").
   *
   *  Hana Association CHỈ có một hiệu ứng duy nhất: "+1 Dice Up với mỗi 10 HP
   *  mất trong turn". Phần CỘNG Dice Up chạy đúng (resolve-pending-action.js,
   *  có ngưỡng 10, không ghi đè nguồn khác). Cái sai nằm ở phần TIÊU THỤ:
   *  `combatant.diceUp` TRƯỚC ĐÂY chỉ được đọc ở ĐÚNG MỘT chỗ —
   *  `skill-verification.js` khi roll dice của SKILL/PAGE. **Đánh thường (M1)
   *  dựng dmgStr thẳng từ `weaponBaseDamage` và KHÔNG đọc diceUp một lần nào.**
   *  → Người chơi mặc Hana, ăn 40 dmg, được +4 Dice Up, rồi đánh thường: con số
   *  y hệt lúc chưa có buff. Nhìn từ ngoài đúng là "outfit không hoạt động".
   *
   *  Không phải lỗi riêng Hana: Dice Down / Freeble / Tremor Chain cũng KHÔNG
   *  ảnh hưởng M1 — debuff giảm dice của địch vô hiệu trước đánh thường.
   *  Nên sửa ở TẦNG CHUNG: tách công thức ra đây, cho CẢ skill LẪN M1 dùng, để
   *  hai đường không bao giờ lệch nhau nữa.
   *
   *  `blackSilenceCritBonus` chỉ áp cho Critical nên nhận qua tham số, không
   *  nhét vào đây.
   */
  function computeDiceModifier(combatant, { blackSilenceCritBonus = 0, foeSpeed = null } = {}) {
    if (!combatant) return 0;
    const tremorChainPenalty = (combatant.tremorChain ?? 0) > 0 ? Math.floor((combatant.tremor ?? 0) / 10) : 0;
    // ── Keypage cấp Dice Up TÍNH ĐỘNG (Fragaria 14/08) ──────────────────────
    // Đặt Ở ĐÂY chứ không ghi vào `combatant.diceUp`: hai keypage này phụ thuộc
    // trạng thái tại THỜI ĐIỂM roll (Speed đối thủ / Emotion Level hiện tại), ghi
    // vào field là nó đọng lại sai sau khi trạng thái đổi.
    let keypageDiceUp = 0;
    // Rabbit's Prowess: mỗi 2 Speed HƠN đối thủ ⇒ +2 Dice Up, TỐI ĐA 5.
    // ⚠️ Trần 5 là trần **Dice Up**, không phải trần số cặp-2-Speed.
    if (combatant.hasRabbitRCorp && Number.isFinite(foeSpeed)) {
      const diff = (combatant.currentSpeed ?? 0) - foeSpeed;
      if (diff >= 2) keypageDiceUp += Math.min(5, Math.floor(diff / 2) * 2);
    }
    // Passion (Dawn Office - Phillip): +2 Dice Up với MỖI Emotion Level.
    if (combatant.hasDawnPhillip) keypageDiceUp += (combatant.emotionLevel ?? 0) * 2;
    return (combatant.diceUp ?? 0) + keypageDiceUp - (combatant.diceDown ?? 0) - (combatant.freeble ?? 0)
      - tremorChainPenalty + blackSilenceCritBonus;
  }

  /** applyHpLoss — trừ HP và ĐẾM vào `hpLostThisTurn` (Hana Association).
   *
   *  GAP ĐÃ SỬA (Fragaria: "passive của Hana Outfit có vẻ hoạt động không đúng,
   *  player báo là nó không hoạt động").
   *
   *  Keypage Hana: "+1 Dice Up với mỗi 10 HP **BẠN MẤT** trong turn" — tức MỌI
   *  nguồn mất HP. Nhưng `hpLostThisTurn` TRƯỚC ĐÂY chỉ được cộng ở ĐÚNG MỘT
   *  chỗ: dòng trừ HP của đòn đánh chính (resolve-pending-action.js). Rà cả repo
   *  thì có **20 chỗ trừ `currentHp`** — 19 chỗ còn lại KHÔNG đếm gì:
   *  dmg phản (counter/Dullahan/thua clash), dmg dội ngược, Bleed tự cắn,
   *  haouSinking, Tremor Burst, Fairy… Người chơi Hana ăn dmg từ mấy nguồn đó
   *  thì không được Dice Up nào — đúng cảnh "outfit không hoạt động".
   *
   *  ⚠️ CỐ Ý KHÔNG áp cho tick cuối turn (Burn/Bleed/Airborne trong
   *  turn-advance.js): Dice Up bị reset NGAY sau đó trong cùng hàm, cộng vào chỉ
   *  để xoá đi — vô nghĩa và gây hiểu nhầm khi đọc log.
   *
   *  Dùng hàm này thay cho `c.currentHp = Math.max(0, c.currentHp - n)` ở MỌI
   *  chỗ mất HP TRONG vòng đấu.
   */
  function applyHpLoss(combatant, amount, { skipShield = false, countHana = true, source = null } = {}) {
    if (!combatant || !(amount > 0)) return 0;
    // ── SHIELD HP HẤP THỤ TRƯỚC — BUG NẶNG ĐÃ SỬA ────────────────────────────
    // Fragaria: "You're too slow của Eye Gouger sử dụng XUYÊN QUA Shield HP.
    // Shield HP của game là dùng để THAY THẾ cho HP, nên không thể có chuyện bị
    // xuyên được, kể cả status effect như Bleed hay Burn cũng đều tiêu Shield HP
    // trước rồi mới qua HP."
    //
    // GỐC BUG: applyHpLoss là choke point DUY NHẤT của mất HP, nhưng nó trừ
    // THẲNG `currentHp` mà KHÔNG hề đụng `shieldHp`. Khiên chỉ được hấp thụ ở
    // ĐÚNG MỘT chỗ — nhánh dmg chính trong resolve-pending-action.js. Nghĩa là
    // TOÀN BỘ nguồn dmg còn lại đều xuyên khiên: You're Too Slow, dmg phản
    // (Renegade/Dullahan/thua clash), Astral Quantization, Tremor Burst, và cả
    // tick Bleed/Burn/haouSinking ở turn-advance.js.
    //
    // Sửa TẠI ĐÂY thay vì vá từng nguồn: thêm khiên vào đúng choke point thì mọi
    // nguồn tự đúng, kể cả nguồn thêm mới sau này.
    //
    // `skipShield: true` — DÀNH RIÊNG cho nhánh dmg chính, nơi đã gọi
    // applyShieldLoss TRƯỚC đó (Renegade cần biết khiên lúc BỊ ĐÁNH nên phải
    // hấp thụ tách riêng). Không có cờ này thì chỗ đó sẽ trừ khiên HAI LẦN.
    if (!skipShield && (combatant.shieldHp ?? 0) > 0) {
      const absorbed = applyShieldLoss(combatant, Math.min(combatant.shieldHp, amount));
      amount -= absorbed;
      if (!(amount > 0)) return 0;
    }
    // Shin - Rien — "khi nhận sát thương vượt ngưỡng NỬA Max HP, bạn NGỪNG NHẬN
    // DMG ở turn này". Chặn tại choke point nên mọi nguồn (đòn đánh, Bleed, phản,
    // Astral…) đều dừng, không phải vá từng nơi.
    // ❗ BUG ĐÃ SỬA (Fragaria: "Shin - Rien chưa gatekeep đúng mốc HP — Eye Gouger
    // dồn 57 hit M1 gồm 15 group hit thì chết luôn").
    // GỐC: điều kiện cũ đòi `hpLostThisTurn` ĐÃ vượt nửa Max HP TRƯỚC khi chặn.
    // Nhưng `hpLostThisTurn` chỉ cộng lên SAU khi trừ HP xong — nên với một chuỗi
    // 57 hit, HP về 0 từ giữa chừng mà ngưỡng vẫn chưa "đã vượt" ở đúng hit làm
    // chết. Phải chặn ngay tại hit LÀM VƯỢT ngưỡng: cắt phần dmg vượt quá.
    // ❗ BUG ĐÃ SỬA (Fragaria: "player start trận với 20% HP thì bị đánh vẫn KHÔNG
    // KÍCH"). Điều kiện cũ đòi **MẤT** ≥50% Max HP trong turn — người đang ở 20%
    // HP thì chết trước khi mất nổi 50% ⇒ không bao giờ kích hoạt được.
    // Luật đúng: *"khi trúng đòn vượt ngưỡng NỬA THANH HP"* = HP **tụt xuống
    // dưới vạch giữa thanh máu**. Ai đã ở dưới vạch đó thì đòn TIẾP THEO kích ngay.
    // ❗❗ BUG NẶNG ĐÃ SỬA (Fragaria: "Shin - Rien khiến người dùng sau khi kích
    // hoạt bị gate MÃI ở mức 50% HP thay vì hết sau turn nó được kích hoạt ⇒ BẤT
    // TỬ VĨNH VIỄN").
    // GỐC: điều kiện chỉ có `hasIndexOraclesProxy && hpNow <= halfBar` — mà mọi
    // người chơi mặc outfit này, một khi đã tụt dưới nửa thanh máu thì KHÔNG BAO
    // GIỜ lên lại được ⇒ nhánh "chặn TOÀN BỘ dmg" đúng nghĩa chạy mãi mãi, mọi
    // turn, cả phần còn lại của Encounter.
    // LUẬT ĐÚNG: miễn dmg CHỈ trong **turn kích hoạt**. Cuối turn đó
    // `advanceCombatantTurn` bật `shinRienActive` (tháo mặt nạ, vào Shin tới hết
    // Encounter) — đó chính là MỐC KẾT THÚC của phần miễn dmg, và cũng là cờ
    // "đã dùng, không kích lại" (Shin - Rien chỉ xảy ra 1 lần mỗi Encounter).
    if (combatant.hasIndexOraclesProxy && !combatant.shinRienActive && (combatant.maxHp ?? 0) > 0) {
      const halfBar = (combatant.maxHp ?? 0) * 0.5;
      const hpNow = combatant.currentHp ?? 0;
      // Đã ở dưới vạch giữa ⇒ chặn TOÀN BỘ dmg còn lại của turn.
      if (hpNow <= halfBar) {
        combatant.shinRienTriggered = true;
        combatant.shinRienBlockedDmg = (combatant.shinRienBlockedDmg ?? 0) + amount;
        return 0;
      }
      // Đòn này làm TỤT QUA vạch ⇒ cho ăn đúng phần tới vạch, chặn phần dư.
      if (hpNow - amount < halfBar) {
        combatant.shinRienTriggered = true;
        combatant.shinRienBlockedDmg = (combatant.shinRienBlockedDmg ?? 0) + (amount - (hpNow - halfBar));
        amount = hpNow - halfBar;
        if (!(amount > 0)) return 0;
      }
    }
    if (false) {
      const cap = 0;
      const already = combatant.hpLostThisTurn ?? 0;
      if (already >= cap) {
        combatant.shinRienBlockedDmg = (combatant.shinRienBlockedDmg ?? 0) + amount;
        return 0;
      }
      if (already + amount > cap) {
        // Cho ăn ĐÚNG phần còn thiếu tới ngưỡng, chặn phần dư.
        combatant.shinRienBlockedDmg = (combatant.shinRienBlockedDmg ?? 0) + (already + amount - cap);
        amount = cap - already;
        if (!(amount > 0)) return 0;
      }
    }
    const before = combatant.currentHp ?? 0;
    // Wound-Casing Mask — "Dmg từ Burn và Bleed sẽ KHÔNG THỂ GIẾT được bạn".
    // Kẹp sàn ở 1 HP thay vì 0 khi nguồn dmg là Burn/Bleed (nguồn khác vẫn giết
    // được bình thường). `source` do nơi gọi truyền vào.
    const burnBleedImmuneDeath = combatant.hasWoundCasingMask && (source === "burn" || source === "bleed");
    if (burnBleedImmuneDeath) {
      combatant.currentHp = Math.max(1, before - amount);
    } else {
      combatant.currentHp = Math.max(0, before - amount);
    }
    const lost = before - combatant.currentHp;
    if (lost <= 0) return 0;
    // ── R CORP OUTFIT (Fragaria 14/08) ─────────────────────────────────────
    // *"Với mỗi 10% HP mất TRONG TURN ORDER đó sẽ nhận X ở turn sau [Max 2 lần]"*
    // Khác Hana ở hai chỗ: Hana đếm mỗi **10 HP tuyệt đối**, R Corp đếm mỗi
    // **10% Max HP**; và R Corp có TRẦN 2 lần/turn.
    // Dùng chung `hpLostThisTurn` (nguồn sự thật duy nhất) — đếm ngưỡng TRƯỚC/SAU
    // y hệt Hana để không cộng lặp khi một turn có nhiều đòn.
    const rcorpKind = combatant.hasRhinoRCorp ? "protection"
      : combatant.hasRabbitRCorp ? "haste"
      : combatant.hasReindeerRCorp ? "diceUp" : null;
    if (rcorpKind) {
      const step = Math.max(1, (combatant.maxHp ?? 100) * 0.1);
      const before10 = Math.floor((combatant.hpLostThisTurn ?? 0) / step);
      combatant.hpLostThisTurn = (combatant.hpLostThisTurn ?? 0) + lost;
      const after10 = Math.floor(combatant.hpLostThisTurn / step);
      const usedBefore = combatant.rcorpProcsThisTurn ?? 0;
      // Trần 2 LẦN mỗi turn — đếm số lần proc, không phải số stack.
      const gained = Math.max(0, Math.min(2 - usedBefore, after10 - before10));
      if (gained > 0) {
        combatant.rcorpProcsThisTurn = usedBefore + gained;
        // "ở TURN SAU" ⇒ dồn vào hàng chờ, turn-advance cấp đầu turn kế.
        combatant.rcorpPendingNextTurn = combatant.rcorpPendingNextTurn ?? { protection: 0, haste: 0, diceUp: 0 };
        const per = rcorpKind === "haste" ? 3 : 2;   // Rabbit 3 Haste, Rhino/Reindeer 2
        combatant.rcorpPendingNextTurn[rcorpKind] += gained * per;
      }
    }
    if (combatant.hasHanaAssociation && countHana) {
      const thresholdBefore = Math.floor((combatant.hpLostThisTurn ?? 0) / 10);
      combatant.hpLostThisTurn = (combatant.hpLostThisTurn ?? 0) + lost;
      const thresholdAfter = Math.floor(combatant.hpLostThisTurn / 10);
      if (thresholdAfter > thresholdBefore) {
        combatant.diceUp = (combatant.diceUp ?? 0) + (thresholdAfter - thresholdBefore);
      }
    } else if (rcorpKind) {
      // hpLostThisTurn đã cộng ở khối R Corp phía trên — KHÔNG cộng lần hai.
    } else {
      combatant.hpLostThisTurn = (combatant.hpLostThisTurn ?? 0) + lost;
    }
    return lost;
  }

  /** grantShieldHp — NGUỒN DUY NHẤT cấp Shield HP.
   *
   *  Gom lại vì 4 món đồ mới của Fragaria (Wanderer's Teatime Clothes, Lucent
   *  Historia, Memories: Compassion, Day One of My New Life) đều tác động vào
   *  CÙNG một đại lượng "hiệu suất tạo khiên" — nếu mỗi chỗ tự `shieldHp += n`
   *  thì bonus sẽ áp chỗ có chỗ không, y như bài học `applyHpLoss`/Hana.
   *
   *  Thứ tự nhân (quan trọng — đổi thứ tự là ra số khác):
   *    1. `shieldEfficiencyPct` của NGƯỜI CẤP (Day One of My New Life:
   *       16% + 2%/tầng tinh luyện).
   *    2. ×2 nếu người NHẬN là ĐỒNG ĐỘI đang dưới 30% HP (Memories: Compassion,
   *       chỉ khi người cấp dùng Lucent Historia) — nhân SAU hiệu suất, vì đây
   *       là "hiệu quả nhận" chứ không phải hiệu suất tạo.
   *
   *  Cũng đếm `shieldLostThisTurn` ở nơi TRỪ (xem applyShieldLoss) để Swan Song
   *  của Lucent Historia hồi đúng 20% lượng khiên ĐÃ MẤT trong turn.
   *
   *  @param granter combatant cấp khiên (null = nguồn hệ thống, không có bonus)
   *  @returns số Shield THỰC SỰ được cộng
   */
  function grantShieldHp(receiver, amount, granter = null, opts = {}) {
    if (!receiver || !(amount > 0)) return 0;
    let final = amount;
    const effPct = granter?.shieldEfficiencyPct ?? 0;
    if (effPct !== 0) final *= (1 + effPct / 100);
    // Memories: Compassion — "gia tăng x2 hiệu quả nhận Shield cho ĐỒNG ĐỘI khi
    // họ dưới 30% HP". Chỉ áp cho đồng đội (không phải chính người cấp) và chỉ
    // khi người cấp đang dùng Lucent Historia.
    if (opts.isAlly && granter?.hasMemoriesCompassion && granter?.weaponName === "Lucent Historia") {
      const maxHp = receiver.maxHp > 0 ? receiver.maxHp : 1;
      if ((receiver.currentHp ?? 0) / maxHp < 0.3) final *= 2;
    }
    final = Math.round(final * 1000) / 1000;
    receiver.shieldHp = (receiver.shieldHp ?? 0) + final;
    // Memories: Compassion — "đồng đội nhận được Shield sẽ giảm 0,2x mọi
    // resistance cho bản thân". Cờ đọc ở combatantResStr.
    if (opts.isAlly && granter?.hasMemoriesCompassion && granter?.weaponName === "Lucent Historia") {
      receiver.compassionResPenalty = true;
    }
    return final;
  }

  /** healHpCapped — hồi HP, tôn trọng TRẦN HỒI riêng của combatant.
   *
   *  "Memories: Compassion": *"Gia tăng 100 Max HP, nhưng bạn sẽ KHÔNG BAO GIỜ
   *  đạt được hay heal lên ngưỡng máu 100 thêm này"*.
   *  → `maxHp` ĐÃ cộng 100 (để hiển thị và tính % đúng), nhưng mọi nguồn hồi
   *  máu phải kẹp theo `healCapHp` (= maxHp GỐC) chứ không phải `maxHp`.
   *  Combatant không khai `healCapHp` thì kẹp theo maxHp như cũ.
   *
   *  ⚠️ Dmg vẫn trừ vào HP bình thường tới tận 0 — 100 máu ảo CHỈ chặn HỒI,
   *  không chặn mất. Nghĩa là ai đội Compassion thực chất có "trần mềm" thấp
   *  hơn maxHp hiển thị.
   */
  /** syncCompassionPhantomHp — BẬT/TẮT 100 máu ảo của "Memories: Compassion"
   *  theo vũ khí ĐANG CẦM, gọi lại bao nhiêu lần cũng ra cùng kết quả.
   *
   *  Fragaria chốt: *"+100 Max HP, cũng như các passive còn lại của Compassion CHỈ
   *  hoạt động khi người dùng đang XÀI LUCENT HISTORIA TRONG LOADOUT — nếu họ đổi
   *  qua cái khác mà nó hoạt động thì đã sai về logic rồi."*
   *
   *  VÌ SAO PHẢI CÓ HÀM RIÊNG: 2 hiệu ứng kia (x2 Shield, −0.2x Res) kiểm
   *  `weaponName` NGAY LÚC DÙNG nên tự đúng khi đổi vũ khí giữa trận. Riêng
   *  +100 Max HP là CHỈ SỐ, trước đây cộng MỘT LẦN lúc join ⇒ đổi vũ khí xong
   *  vẫn giữ máu ảo. Phải đồng bộ lại mỗi khi vũ khí đổi.
   *
   *  Gọi ở: player-join-builder (lúc vào trận), advanceCombatantTurn (lưới an
   *  toàn mỗi vòng turn — bắt được MỌI đường đổi vũ khí kể cả đường thêm sau
   *  này), và ngay tại các chỗ đổi vũ khí (Mimicry: Synchronization).
   *
   *  @returns dòng ghi chú nếu trạng thái ĐỔI, "" nếu không đổi gì.
   */
  function syncCompassionPhantomHp(combatant) {
    // ── Shi Association (outfit) — CÙNG CƠ CHẾ, khác con số ──────────────────
    // Fragaria: "Outfit Shi Association cũng có 60 HP máu ảo y hệt 100 máu ảo của
    // Compassion; hai thứ dùng CHUNG logic."
    // Keypage: "nhận thêm 60 Max HP, tuy nhiên HP KHÔNG THỂ VƯỢT QUÁ mốc 60 Max HP
    // được cho thêm đó" ⇒ đúng khuôn `healCapHp` (hồi chỉ tới maxHp GỐC).
    // Gate theo OUTFIT đang mặc, y như Compassion gate theo vũ khí.
    if (combatant?.hasShiAssociation) {
      const onShi = combatant.equippedOutfitName === "Shi Association" || combatant.hasShiAssociation === true;
      const isOnShi = (combatant.shiPhantomHp ?? 0) > 0;
      if (onShi && !isOnShi) {
        combatant.maxHp = (combatant.maxHp ?? 0) + 60;
        combatant.shiPhantomHp = 60;
        combatant.healCapHp = combatant.maxHp - 60;
      } else if (!onShi && isOnShi) {
        const ph = combatant.shiPhantomHp ?? 60;
        combatant.maxHp = Math.max(1, (combatant.maxHp ?? 0) - ph);
        combatant.shiPhantomHp = 0;
        combatant.healCapHp = undefined;
        combatant.currentHp = Math.min(combatant.currentHp ?? 0, combatant.maxHp);
      } else if (onShi) {
        // Tính LẠI trần mỗi lần (maxHp có thể đổi giữa chừng do chữa injury…).
        combatant.healCapHp = combatant.maxHp - (combatant.shiPhantomHp ?? 60);
      }
    }
    if (!combatant?.hasMemoriesCompassion) return "";
    const shouldBeOn = combatant.weaponName === "Lucent Historia";
    const isOn = (combatant.compassionPhantomHp ?? 0) > 0;
    if (shouldBeOn) {
      if (!isOn) {
        combatant.maxHp = (combatant.maxHp ?? 0) + 100;
        combatant.compassionPhantomHp = 100;
      }
      // Tính LẠI mỗi lần thay vì lưu cứng lúc bật: maxHp có thể đổi giữa chừng
      // (chữa injury, buff Max HP…) — lưu cứng sẽ khiến trần hồi lệch dần.
      combatant.healCapHp = combatant.maxHp - combatant.compassionPhantomHp;
      return isOn ? "" : ` 💗[Memories: Compassion BẬT — +100 Max HP ảo (không hồi tới được)]`;
    }
    if (!isOn) return "";
    // TẮT: trừ ĐÚNG phần đã cộng, rồi kẹp currentHp cho khỏi vượt trần mới.
    const phantom = combatant.compassionPhantomHp ?? 100;
    combatant.maxHp = Math.max(1, (combatant.maxHp ?? 0) - phantom);
    combatant.compassionPhantomHp = 0;
    combatant.healCapHp = undefined; // hết máu ảo ⇒ hồi tới maxHp như người thường
    combatant.currentHp = Math.min(combatant.currentHp ?? 0, combatant.maxHp);
    return ` 💔[Memories: Compassion TẮT — không cầm Lucent Historia, mất ${phantom} Max HP ảo]`;
  }

  function healHpCapped(combatant, amount) {
    if (!combatant || !(amount > 0)) return 0;
    const cap = Number.isFinite(combatant.healCapHp) ? combatant.healCapHp : (combatant.maxHp ?? 0);
    const before = combatant.currentHp ?? 0;
    if (before >= cap) return 0;
    combatant.currentHp = Math.min(cap, before + amount);
    return Math.round((combatant.currentHp - before) * 1000) / 1000;
  }

  /** applyShieldLoss — trừ Shield HP và ĐẾM vào `shieldLostThisTurn`.
   *  Swan Song (Lucent Historia) hồi 20% lượng khiên MẤT trong turn, nên mọi chỗ
   *  trừ khiên phải đi qua đây — trừ tay ở 1 chỗ là Swan Song hụt đúng chỗ đó. */
  function applyShieldLoss(combatant, amount) {
    if (!combatant || !(amount > 0)) return 0;
    const before = combatant.shieldHp ?? 0;
    combatant.shieldHp = Math.max(0, before - amount);
    const lost = before - combatant.shieldHp;
    if (lost > 0) combatant.shieldLostThisTurn = (combatant.shieldLostThisTurn ?? 0) + lost;
    return lost;
  }

  function advanceToNextTurnHolder(encounter) {
    const order = encounter.turnOrder ?? [];
    if (order.length === 0) return { wrapped: false, prescriptNotes: [] };
    const leavingEntry = order[encounter.currentTurnIndex ?? 0] ?? null;
    let idx = (encounter.currentTurnIndex ?? 0) + 1;
    while (idx < order.length) {
      const entry = order[idx];
      const c = entry.type === "enemy" ? encounter.enemies[entry.id] : encounter.players[entry.id];
      if (c && c.currentHp > 0 && !c.staggered) break; // tìm người TIẾP THEO còn khả năng hành động
      idx++; // bỏ qua người đã chết/đang Stagger, không chiếm lượt
    }
    encounter.currentTurnIndex = idx;
    const wrapped = idx >= order.length; // true = đã hết 1 vòng turnOrder
    const enteringEntry = wrapped ? null : order[idx];
    // BUG THIẾT KẾ ĐÃ SỬA (Fragaria: "mấy cái prescript/sắc lệnh của outfit Index
    // cũng đang đếm theo turn NGƯỜI NHẬN thay vì TURNORDER, điều khá sai thiết
    // kế game").
    //
    // TRƯỚC ĐÂY sắc lệnh được CHẤM khi lượt riêng của người đó kết thúc và
    // ROLL LẠI khi lượt riêng của họ bắt đầu — tức mỗi người 1 sắc lệnh MỖI
    // LƯỢT CỦA CHÍNH HỌ, lệch hẳn khỏi nhịp vòng turn order.
    // Tệ hơn: vòng lặp ngay trên BỎ QUA người đang Stagger/đã chết
    // (`if (c && c.currentHp > 0 && !c.staggered) break`) → người bị Stagger
    // KHÔNG BAO GIỜ là leavingEntry lẫn enteringEntry ⇒ sắc lệnh của họ
    // **treo vĩnh viễn**: không được chấm, không được roll mới, và
    // Grace/Karmic đứng im cho tới khi hết Stagger.
    //
    // SỬA: bỏ hẳn khỏi đây, chuyển sang `validateAndRerollPrescriptRound()`
    // chạy MỘT LẦN cho MỌI combatant ở mốc kết thúc vòng (performEndTurn) —
    // cùng chỗ với `advanceCombatantTurn`, tức đúng nhịp turn order.
    const prescriptNotes = [];
    // Task yêu cầu trực tiếp: "sửa lại prescript chỉ tổng kết khi turnorder end
    // chứ không phải endturn của player" — TRƯỚC ĐÂY prescriptNotes hiện NGAY
    // trong reply của TỪNG lần pass/endmyturn cá nhân (ồn ào, rải rác) — giờ
    // GOM vào encounter.pendingPrescriptNotes (persist), CHỈ hiện tổng hợp 1 lần
    // ở performEndTurn (round-end thật) rồi mới clear. Vẫn TRẢ VỀ prescriptNotes
    // như cũ (không đổi signature, tránh phá vỡ nơi khác đang dùng) — chỉ là
    // các handler pass/endmyturn giờ KHÔNG hiện nó ra reply nữa (xem các file
    // message-create-handler.js/interaction-handlers.js).
    if (prescriptNotes.length > 0) {
      encounter.pendingPrescriptNotes = (encounter.pendingPrescriptNotes ?? []).concat(prescriptNotes);
    }
    return { wrapped, prescriptNotes };
  }
  
  /** buildTurnOrderText — hiện danh sách thứ tự turn đã roll, kèm cảnh báo hoà cùng phe.
   *  Turn Order Enforcement: đánh dấu 👉 người/enemy ĐANG tới lượt (currentTurnIndex). */
  function buildTurnOrderText(encounter) {
    const order = encounter.turnOrder ?? [];
    if (order.length === 0) return "Chưa roll Speed — dùng `-encounter rollspeed`.";
    const curIdx = encounter.currentTurnIndex ?? 0;
    // GAP ĐÃ SỬA (Fragaria báo trực tiếp: "những người đã chết trong encounter
    // thì nên bị clear ra khỏi thứ tự turn display"). TRƯỚC ĐÂY map NGUYÊN
    // turnOrder, kể cả combatant đã 0 HP — advanceToNextTurnHolder VỐN ĐÃ tự bỏ
    // qua họ khi chạy lượt, nên bảng hiển thị lệch hẳn với hành vi thật (người
    // xem tưởng xác chết vẫn còn lượt, và số thứ tự #N đếm cả người chết).
    // KHÔNG xoá khỏi encounter.turnOrder thật — chỉ ẩn ở khâu HIỂN THỊ: currentTurnIndex
    // là index vào MẢNG GỐC, xoá phần tử sẽ làm lệch con trỏ lượt của cả hệ thống.
    // Vì vậy: lọc trước, nhưng so sánh 👉 bằng index GỐC (idx), còn số #N đánh lại
    // theo danh sách người còn sống.
    const alive = order
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => {
        const c = e.type === "enemy" ? encounter.enemies[e.id] : encounter.players[e.id];
        return c && c.currentHp > 0;
      });
    if (alive.length === 0) return "Không còn ai sống trong turn order.";
    const hiddenCount = order.length - alive.length;
    // BUG HIỂN THỊ ĐÃ SỬA (Fragaria: "encounter nhiều người quá là nó bị mất xén
    // thông tin như này", kèm ảnh 5 con Rats).
    // TRƯỚC ĐÂY label chỉ lấy `name` → **cả 5 con đều hiện đúng chữ "Rats"**,
    // không cách nào biết "#4 Rats" là rats1 hay rats4. Trong khi khối chi tiết
    // bên dưới lại ghi "Rats (rats4)" — hai phần KHÔNG khớp nhau được, người
    // chơi không biết con đang Stagger là con nào trong thứ tự turn.
    // → Chỉ thêm key khi tên bị TRÙNG (1 con Rats duy nhất thì "(rats1)" là rác).
    const enemyNameCount = {};
    for (const { e } of alive) {
      if (e.type !== "enemy") continue;
      const nm = encounter.enemies[e.id]?.name ?? e.id;
      enemyNameCount[nm] = (enemyNameCount[nm] ?? 0) + 1;
    }
    const lines = alive.map(({ e, idx }, i) => {
      let label;
      if (e.type === "enemy") {
        const nm = encounter.enemies[e.id]?.name ?? e.id;
        label = enemyNameCount[nm] > 1 ? `**${nm}** \`${e.id}\`` : `**${nm}**`;
      } else {
        label = `<@${e.id}>`;
      }
      // Ghi chú hoà Speed rút gọn: bản cũ dài 60 ký tự và LẶP trên MỌI dòng bị
      // hoà (ảnh của Fragaria có 3 dòng y hệt nhau) — chiếm hết chiều cao màn
      // hình mobile mà không thêm thông tin gì.
      const tieNote = e.tiedWith.length > 0 ? ` ⚖️` : "";
      const turnMarker = idx === curIdx ? " 👉 **(đang tới lượt)**" : "";
      // Stagger: vẫn HIỆN (khác người chết — họ còn trong trận, chỉ mất lượt này)
      // nhưng đánh dấu rõ để không ai thắc mắc "sao bị bỏ lượt".
      const staggerNote = (e.type === "enemy" ? encounter.enemies[e.id] : encounter.players[e.id])?.staggered ? " 💫 **Stagger — bỏ lượt**" : "";
      return `**#${i + 1}** ${label} — Speed **${e.speed}**${tieNote}${staggerNote}${turnMarker}`;
    });
    if (alive.some(({ e }) => e.tiedWith.length > 0)) lines.push(`*⚖️ = hoà Speed, thứ tự đã random tự động*`);
    if (hiddenCount > 0) lines.push(`*(đã ẩn ${hiddenCount} người/enemy đã gục)*`);
    return lines.join("\n");
  }
  
  /** Đổi { B, P, S } resistance object thành resStr cho calcMathCore — Stagger thì
   *  ĐÈ TOÀN BỘ về 2x bất kể resistance gốc, đúng luật "Khi bị Stagger Resistance set 2x". */
  /** clampRes — GIỚI HẠN CHUNG của mọi unit: Res thấp nhất **0.5x**, cao nhất **2x**.
   *  Fragaria: "đây là giới hạn chung của mọi unit/player trong game, chỉ một số
   *  trường hợp có passive ĐẶC BIỆT ghi rõ mới bypass được."
   *  ⇒ passive muốn bypass phải tự khai `resCapBypass = true` trên combatant. */
  const RES_MIN = 0.5, RES_MAX = 2;
  function clampRes(v, combatant) {
    const n = Math.max(0, Number(v) || 0);
    if (combatant?.resCapBypass) return Math.round(n * 10) / 10;
    return Math.round(Math.min(RES_MAX, Math.max(RES_MIN, n)) * 10) / 10;
  }

  function combatantResStr(combatant, opts = {}) {
    // Fragaria: "theo logic thì Panic sẽ hoạt động NHƯ STAGGER nhưng KHÔNG giảm
    // Res và chỉ kéo dài 1 turn (thay vì 2 + 1 từ Choáng)."
    // ⇒ Panic KHÔNG chạm vào Res ở đây; nó chỉ chặn hành động (xem nơi kiểm
    //   `staggered || panic` khi act).
    if (combatant.staggered) return "2xB 2xP 2xS";
    const r = combatant.resistance;
    // Shin (đang active): -0,2x mọi Res BẢN THÂN khi combatant này là bên BỊ TẤN
    // CÔNG (defender) — dễ ăn dmg hơn, đánh đổi lấy Mang +Dmg. Defensive Light (Shin,
    // [10 Points]): CỘNG THÊM -0,1x mỗi 10 Shin Level hiện có (mặc định Shin Level =
    // 10 theo luật "khởi điểm 10 Shin Lvl" — không có cơ chế nào khác cho biết nó
    // tăng/giảm, nên coi là hằng số 10 trừ khi có thêm thông tin).
    if (combatant.shinMangActive) {
      const shinLevel = combatant.shinLevel ?? 10;
      const extraReduction = hasPerk(combatant, "Defensive Light") ? Math.floor(shinLevel / 10) * 0.1 : 0;
      // ❗ MANG TRIỆT TIÊU BỚT RES-DEBUFF CỦA SHIN (Fragaria 14/08, rework).
      // *"Nếu bản thân có Lvl 1 Mang và kẻ địch có Shin lvl 50 + Shin skill tree
      //  (giảm 0,7x all res) thì Mang làm giảm bớt nó đi còn 0,6x. Nếu bản thân có
      //  Lvl 3 Mang thì còn 0,4x."*
      // ⇒ Mang Lvl N triệt tiêu ĐÚNG N × 0,1. (Ví dụ Lvl 5 → 0,2x ở lượt trước
      //   cũng khớp: 0,7 − 0,5 = 0,2.)
      // Đây là "triệt tiêu LẪN NHAU": Mang của người đánh làm địch bớt yếu đi, tức
      // người đánh tự giảm sát thương của mình — nên KHÔNG bao giờ đẩy mức trừ
      // xuống ÂM (Math.max 0), Mang cao không biến thành buff Res cho địch.
      const mangCancel = Math.max(0, (opts.counterMangLevel ?? 0)) * 0.1;
      const totalReduction = Math.max(0, 0.2 + extraReduction - mangCancel);
      // round1 — làm tròn 1 chữ số thập phân. BẮT BUỘC: phép trừ số thực JS cho ra
      // rác kiểu `1 - 0.7 = 0.30000000000000004`, lọt thẳng vào resStr rồi hiển thị
      // cho người chơi (và phải parse lại ở trueDmgResStr/damage-calc).
      const round1 = (v) => clampRes(v, combatant);
      // ❗ BUG ĐÃ SỬA (Fragaria: "giảm res của Memories Compassion và Day One of
      // My New Life KHÔNG CÒN HOẠT ĐỘNG"). Nhánh Shin này TRẢ VỀ SỚM nên toàn bộ
      // phần Res penalty của 2 accessory ở dưới BỊ BỎ QUA — hễ bật Shin là 2 món
      // đó mất tác dụng. Cộng luôn tại đây thay vì để rơi xuống dưới.
      let shinExtra = 0;
      if (combatant.compassionResPenalty) shinExtra += 0.2;
      if (combatant.dayOneAuraActive) shinExtra += 0.1;
      const tot = totalReduction + shinExtra;
      return `${round1(r.B - tot)}xB ${round1(r.P - tot)}xP ${round1(r.S - tot)}xS`;
    }
    // ── Res penalty từ 2 accessory MỚI (Fragaria) ────────────────────────
    // Gộp CHUNG ở đây thay vì rải mỗi chỗ một kiểu — Res là 1 con số, tính rời
    // rạc sẽ ra kết quả khác nhau tuỳ đường gọi.
    //   • Memories: Compassion — "đồng đội NHẬN được Shield sẽ giảm 0,2x mọi
    //     Res cho bản thân" (cờ đặt lúc cấp khiên, xem grantShieldHp).
    //   • Day One of My New Life — "-0,1x Res của TOÀN BỘ đồng đội khi bạn còn
    //     trên sân", **KHÔNG STACK** nếu nhiều người cùng có → cờ là boolean,
    //     cộng đúng 1 lần dù cả party đội nón.
    let extraResPenalty = 0;
    if (combatant.compassionResPenalty) extraResPenalty += 0.2;
    if (combatant.dayOneAuraActive) extraResPenalty += 0.1;
    if (extraResPenalty > 0) {
      const round1b = (v) => clampRes(v, combatant);
      return `${round1b(r.B - extraResPenalty)}xB ${round1b(r.P - extraResPenalty)}xP ${round1b(r.S - extraResPenalty)}xS`;
    }
    // Kẹp cả nhánh KHÔNG có penalty — cap 0.5x/2x là luật CHUNG, không phải hệ quả
    // của riêng accessory nào.
    return `${clampRes(r.B, combatant)}xB ${clampRes(r.P, combatant)}xP ${clampRes(r.S, combatant)}xS`;
  }
  
  /** trueDmgResStr — dùng khi BÊN TẤN CÔNG có Mang active: ép Res của TARGET tối
   *  thiểu 1x cho mọi loại dmg (nếu target có Res < 1x ở loại đó, coi như đúng 1x —
   *  "True Dmg" — không khuếch đại nếu Res target ĐÃ ≥1x, chỉ neutralize phần KHÁNG
   *  dưới 1x). Gọi THAY combatantResStr(target) khi attacker.shinMangActive — đã bao
   *  gồm luôn phần Shin của TARGET (nếu target cũng có Shin active, áp dụng giảm 0.2x
   *  TRƯỚC rồi mới clamp min 1x, đúng thứ tự "Res hiệu lực sau Shin" mới là Res thật
   *  để so sánh với True Dmg). */
  function trueDmgResStr(target) {
    const base = combatantResStr(target); // đã áp Shin/Stagger của target nếu có
    const matches = [...base.matchAll(/([\d.]+)x([BPS])/g)];
    return matches.map(([, val, type]) => `${Math.max(1, parseFloat(val))}x${type}`).join(" ");
  }

  /** haouRuptureResStr — Haou Rupture (50-Status Nhóm 2, xác nhận trực tiếp):
   *  "bằng 1 lần đòn đánh xuyên qua resistance của địch (luôn luôn là 1.5x Res)
   *  nếu nó dưới 1.5x" — CÙNG pattern trueDmgResStr nhưng floor 1.5x thay vì 1x.
   *  Trả về cả `applied` (có ít nhất 1 loại Res thực sự bị ép lên không) để caller
   *  biết có nên trừ 1 stack hay không ("Mỗi lần địch chịu 1 đòn tấn công sẽ trừ 1
   *  stack NẾU resistance thấp hơn 1.5x Res" — chỉ tiêu khi thực sự có tác dụng). */
  function haouRuptureResStr(target) {
    const base = combatantResStr(target);
    const matches = [...base.matchAll(/([\d.]+)x([BPS])/g)];
    let applied = false;
    const resStr = matches.map(([, val, type]) => {
      const num = parseFloat(val);
      if (num < 1.5) applied = true;
      return `${Math.max(1.5, num)}x${type}`;
    }).join(" ");
    return { resStr, applied };
  }
  
  /** Kiểm tra + set Stagger (Stamina=0) / Panic (Sanity=-45) sau khi 1 combatant vừa
   *  bị trừ Stamina/Sanity — gọi MỖI LẦN sau khi thay đổi 2 giá trị này. Không tự bỏ
   *  qua nếu đã đang stagger/panic (idempotent — set lại staggerTurnsLeft=1 chỉ nếu
   *  CHƯA staggered, tránh việc bị trừ Stamina=0 nhiều lần liên tục lại reset đếm ngược). */
  /** applyParrySuccessPerks — gọi MỖI lần Parry thành công (cả đường M1-mix lẫn
   *  Page/skill 1-charge) — xử lý các perk kích hoạt từ Parry thành công:
   *  - Charge Up (Envy, [5 Points]): +10 Charge.
   *  - Tip-Toe Around (Wrath, [25 Points]): đòn tấn công KẾ TIẾP của combatant này
   *    được +10% Dmg — set cờ chờ tiêu thụ ở computeAttackerPerkContext lúc tấn
   *    công lần sau.
   *  - Electrifying Vendetta (Envy, [30 Points]): ≥15 Charge → gây 10 Dmg THẲNG (raw,
   *    không qua Res) lên người tấn công gốc. Phần "ngắt đòn đánh tiếp theo của
   *    chúng" mang tính tường thuật/phụ thuộc bàn chơi cụ thể — KHÔNG tự động hoá
   *    được (không có khái niệm "khoá hành động tiếp theo" trong hệ thống hiện tại),
   *    GM tự xử lý phần đó.
   *  @param attackerCombatant — người VỪA bị parry (để áp Electrifying Vendetta lên).
   */
  function applyParrySuccessPerks(combatant, attackerCombatant) {
    if (hasPerk(combatant, "Charge Up")) {
      combatant.charge = Math.min(CHARGE_MAX, (combatant.charge ?? 0) + 10);
    }
    if (hasPerk(combatant, "Tip-Toe Around")) {
      combatant.tipToeBonusPending = true;
    }
    let vendettaNote = "";
    if (hasPerk(combatant, "Electrifying Vendetta") && (combatant.charge ?? 0) >= 15 && attackerCombatant) {
      applyHpLoss(attackerCombatant, 10);
      vendettaNote = " ⚡-10 HP (Electrifying Vendetta — phần 'ngắt đòn tiếp theo' GM tự xử lý)";
    }
    // "The Middle Little/Big Sibling" (outfit) — GAP MỚI (xác nhận trực tiếp):
    // "Khi parry... nhận light thành công" — user LÀM RÕ đây KHÔNG phải nhận
    // Light thật, mà là "parry thành công → +1 Stack Enhancement Tattoos"
    // (phần "M1 nhận light" xử lý riêng ở resolve-pending-action.js, theo
    // accumulator 20 Stamina — xem comment tương ứng). Reset lại 2 Turn mỗi
    // lần kích hoạt (không cộng dồn thời hạn, chỉ cộng dồn SỐ stack).
    if (combatant.equippedOutfit === "The Middle Little Sibling" || combatant.equippedOutfit === "The Middle Big Sibling") {
      combatant.enhancementTattoosStack = (combatant.enhancementTattoosStack ?? 0) + 1;
      combatant.enhancementTattoosTurnsLeft = 2;
      vendettaNote += ` 💉[Enhancement Tattoos +1 (tổng ${combatant.enhancementTattoosStack})]`;
    }
    return vendettaNote;
  }
  
  /** applyEvadeSuccessPerks — Short Circuit Trip (Envy, [35 Points]): ≥15 Charge →
   *  Evade thành công gây 10 Dmg raw lên người tấn công gốc (tương tự Electrifying
   *  Vendetta nhưng cho Evade) — phần "ngắt đòn tiếp theo" cũng không tự động hoá
   *  được, GM tự xử lý. */
  function applyEvadeSuccessPerks(combatant, attackerCombatant) {
    if (hasPerk(combatant, "Short Circuit Trip") && (combatant.charge ?? 0) >= 15 && attackerCombatant) {
      applyHpLoss(attackerCombatant, 10);
      return " ⚡-10 HP (Short Circuit Trip — phần 'ngắt đòn tiếp theo' GM tự xử lý)";
    }
    return "";
  }
  
  /**
   * appendActionLog — ghi 1 entry vào encounter.actionLog — dùng CHUNG cho MỌI loại
   * hành động: cả M1/Page/skill (đã ghi riêng trong confirmAll handler) LẪN các hành
   * động TỨC THỜI không qua hàng chờ confirm (Guard/Evade/Parry/Clash/Shin-Mang/
   * Manifest E.G.O/Follow-Up/Overcharge/additem/useitem) — BUG ĐÃ SỬA: trước đây CHỈ
   * confirmAll ghi log, khiến log có LỖ HỔNG LỚN (không thấy Guard/Parry/Clash nào cả,
   * dù đây là hành động RẤT phổ biến trong lối chơi thật). PHẢI gọi TRƯỚC
   * saveEncounter tương ứng (không tự save bên trong hàm này — gộp chung 1 lần ghi
   * Redis với thay đổi khác của cùng action, tránh 2 lần ghi cho 1 hành động).
   * @param type "instant" cho các hành động tức thời (hiện icon 🔹 khác ✅/❌ confirm/
   *  reject để phân biệt trực quan trong -encounter log).
   */
  /**
   * restoreInjuryMaxHp — khi 1 chấn thương bị CHỮA KHỎI, nếu chấn thương đó có gây
   * giảm Max HP (Gãy Xương -30, Vết thương lớn -100), khôi phục lại đúng số đó vào
   * maxHp — BUG ĐÃ SỬA: trước đây -encounter healinjury chỉ xoá TÊN khỏi danh sách,
   * KHÔNG hề trả lại maxHp đã mất, khiến "chữa khỏi" trên danh nghĩa nhưng vẫn chịu
   * hình phạt vĩnh viễn. Dùng CHUNG cho mọi đường chữa injury (GM lệnh tay, K-Corp
   * Ampule, chữa bằng Ahn ngoài encounter).
   * @param obj combatant (live, có field maxHp) HOẶC profileData (không có maxHp cố
   *  định — chỉ áp dụng cho combatant; với profileData chỉ cần xoá khỏi mảng
   *  injuries, maxHp NGOÀI encounter luôn tính lại từ Grade trừ injuries hiện có lúc
   *  join, không cần "khôi phục" gì thêm).
   * @param removedInjuryText text ĐÃ XOÁ khỏi injuries[] (dùng match tên gốc).
   */
  function restoreInjuryMaxHp(combatant, removedInjuryText) {
    if (!combatant || typeof combatant.maxHp !== "number") return;
    if (removedInjuryText.startsWith("Gãy Xương")) {
      combatant.maxHp += 30;
      combatant.currentHp = Math.min(combatant.currentHp, combatant.maxHp);
    } else if (removedInjuryText.startsWith("Vết thương lớn")) {
      combatant.maxHp += 100;
      combatant.currentHp = Math.min(combatant.currentHp, combatant.maxHp);
    }
  }
  
  /**
   * applyDeathPenalty — Death Penalty (hoặc Permanent Death nếu encounter.permadeath)
   * cho 1 player VỪA CHẾT (currentHp=0). Dùng CHUNG cho MỌI nguồn gây chết (combat
   * damage bình thường, VÀ hiệu ứng đặc biệt như K-Corp Ampule dùng 2 lần liên tiếp
   * trong 1 encounter — xác nhận trực tiếp từ GM: "gây chết ngay lập tức").
   * - Encounter THƯỜNG: mất 50% Ahn + 50% EXP của MỐC HIỆN TẠI (không tụt grade).
   * - Encounter PERMADEATH: set permanentlyDead=true, chặn join encounter mới cho
   *   tới khi hồi sinh qua Rewound Time.
   * @returns deathNote string để hiển thị.
   */
  async function applyDeathPenalty(encounter, playerId) {
    const { data: profileData, slot } = await getPlayerDataWithSlot(playerId);
    if (encounter.permadeath) {
      profileData.permanentlyDead = true;
      await savePlayerData(playerId, profileData, slot);
      return ` ☠️**PERMANENT DEATH** (encounter permadeath) — không thể tham gia encounter khác cho tới khi hồi sinh qua Rewound Time (\`-rewoundtime @user\`)`;
    } else {
      const { expInCurrentGrade } = calcGrade(profileData.exp ?? 0);
      const ahnLost = Math.floor((profileData.ahn ?? 0) * 0.5);
      const expLost = Math.floor(expInCurrentGrade * 0.5);
      profileData.ahn = Math.max(0, (profileData.ahn ?? 0) - ahnLost);
      profileData.exp = Math.max(0, (profileData.exp ?? 0) - expLost);
      await savePlayerData(playerId, profileData, slot);
      return ` ☠️**TỬ VONG** — mất ${ahnLost} Ahn + ${expLost} EXP (profile, không tụt grade)`;
    }
  }
  
  function appendActionLog(encounter, lines, type = "instant") {
    if (!lines) return;
    const arr = Array.isArray(lines) ? lines.filter(Boolean) : [lines];
    if (arr.length === 0) return;
    encounter.actionLog = encounter.actionLog ?? [];
    encounter.actionLog.push({
      turn: encounter.turnNumber ?? 1,
      type,
      lines: arr,
      timestamp: Date.now(),
    });
    if (encounter.actionLog.length > 100) {
      encounter.actionLog = encounter.actionLog.slice(encounter.actionLog.length - 100);
    }
  }
  
  /** getActionLogIcon — icon hiển thị cho 1 entry trong actionLog theo đúng 3 loại:
   *  "confirm" (M1/Page/skill đã GM xác nhận), "reject" (đã bị từ chối), "instant"
   *  (hành động tức thời như Guard/Evade/Parry/Clash/buff/... — không qua hàng chờ
   *  confirm nên KHÔNG có khái niệm "reject" cho loại này). BUG ĐÃ SỬA: trước đây
   *  dùng ternary 2 nhánh (entry.type === "confirm" ? "✅" : "❌") — coi MỌI entry
   *  KHÔNG PHẢI "confirm" là "❌ reject", khiến toàn bộ hành động instant (vốn luôn
   *  thành công nếu không throw error) hiện sai thành "đã bị từ chối". */
  function getActionLogIcon(type) {
    if (type === "confirm") return "✅";
    if (type === "reject") return "❌";
    return "🔹";
  }
  
  // ── MANIFESTED E.G.O: RED MIST — bật/tắt trạng thái ────────────────────────
  // Gom vào ĐÂY vì có tới 3 nơi cần tắt Manifest: hết Duration (turn-advance.js),
  // bị Stagger (checkStaggerPanic ngay dưới), và có thể thêm nguồn khác sau này.
  // Mỗi nơi tự trả chỉ số/vũ khí thì chắc chắn có nơi sót — đúng bài học
  // applyHpLoss (19/20 chỗ trừ HP không được đếm).

  const MIMICRY_SYNC_FORMS = {
    sword:  { label: "Kiếm",     weight: "medium", type: "Slash", baseDamage: 28 },
    scythe: { label: "Lưỡi hái", weight: "heavy",  type: "Slash", baseDamage: 56 },
  };

  /** applyMimicryForm — ghi chỉ số của dạng đang chọn lên combatant.
   *  Ghi THẲNG weaponBaseDamage/Type/Weight (đúng pattern Atelier Logic 2 form)
   *  để M1, chi phí Stamina, WEAPON_DEFENSE_HITS và Parry counter-dmg tự đúng
   *  theo dạng mà không phải sửa từng nơi. */
  function applyMimicryForm(combatant, form) {
    const f = MIMICRY_SYNC_FORMS[form] ?? MIMICRY_SYNC_FORMS.sword;
    combatant.mimicryForm = MIMICRY_SYNC_FORMS[form] ? form : "sword";
    combatant.weaponBaseDamage = f.baseDamage;
    combatant.weaponType = f.type;
    combatant.weaponWeight = f.weight;
    return f;
  }

  /** applyMimicSynchronization — "The Mimic": Mimicry Blade → Mimicry: Synchronization.
   *  CHỈ khi đang cầm ĐÚNG Mimicry Blade. Lưu chỉ số gốc để revert nguyên trạng.
   *  @returns dòng mô tả để append vào log, hoặc "" nếu không đủ điều kiện. */
  function applyMimicSynchronization(combatant) {
    if (combatant.mimicSyncActive) return "";
    if (combatant.weaponName !== "Mimicry Blade") return "";
    combatant.mimicryOriginalWeaponName = combatant.weaponName;
    combatant.mimicryOriginalBaseDamage = combatant.weaponBaseDamage;
    combatant.mimicryOriginalWeaponType = combatant.weaponType;
    combatant.mimicryOriginalWeaponWeight = combatant.weaponWeight;
    combatant.mimicSyncActive = true;
    combatant.weaponName = "Mimicry: Synchronization";
    syncCompassionPhantomHp(combatant); // đổi vũ khí ⇒ Compassion phải theo kịp
    applyMimicryForm(combatant, "sword");
    return ` 🗡️**The Mimic** — Mimicry Blade → **Mimicry: Synchronization** (dạng Kiếm 28/Slash/Medium · đổi sang Lưỡi hái 56/Slash/Heavy ở panel Special).`;
  }

  /** revertMimicSynchronization — trả về ĐÚNG vũ khí gốc.
   *  Fragaria chốt: "khi hết Manifested E.G.O đều tự động quay về Mimicry Blade,
   *  vì đây là một passive TẠM THỜI biến đổi vũ khí hiện tại". */
  function revertMimicSynchronization(combatant) {
    if (!combatant.mimicSyncActive) return "";
    combatant.weaponName = combatant.mimicryOriginalWeaponName ?? "Mimicry Blade";
    syncCompassionPhantomHp(combatant); // đổi vũ khí ⇒ Compassion phải theo kịp
    combatant.weaponBaseDamage = combatant.mimicryOriginalBaseDamage ?? 14;
    combatant.weaponType = combatant.mimicryOriginalWeaponType ?? "Slash";
    combatant.weaponWeight = combatant.mimicryOriginalWeaponWeight ?? "medium";
    combatant.mimicSyncActive = false;
    combatant.mimicryForm = "sword";
    combatant.mimicryOriginalWeaponName = null;
    return ` 🗡️Mimicry trở lại **${combatant.weaponName}**.`;
  }

  /** endManifestedEgoState — TẮT Manifest + trả lại MỌI thứ đã cấp.
   *  @param forcedByStagger true = bị Stagger cắt ngang ⇒ dính Shattered E.G.O.
   *  ⚠️ KHÔNG đụng `manifestedEGOTurnsLeft` ở nhánh hết-hạn (turn-advance đã tự
   *     đếm về 0); nhánh Stagger thì phải ép về 0, nếu không turn sau nó vẫn
   *     tưởng còn hiệu lực và bật lại buff. */
  function endManifestedEgoState(combatant, { forcedByStagger = false } = {}) {
    if (!combatant.manifestedEGO) return "";
    const notes = [];
    combatant.manifestedEGO = false;
    combatant.manifestedEGOTurnsLeft = 0;
    combatant.manifestedEGOCooldownLeft = 5;
    if (combatant.theStrongestActive) {
      // Trừ ĐÚNG phần đã cộng (không trừ cứng 100) — nguồn khác có thể đã đổi
      // maxStamina giữa chừng.
      const bonus = combatant.theStrongestMaxStaminaBonus ?? 0;
      if (bonus > 0) {
        combatant.maxStamina = Math.max(1, (combatant.maxStamina ?? 0) - bonus);
        combatant.currentStamina = Math.min(combatant.currentStamina ?? 0, combatant.maxStamina);
      }
      combatant.theStrongestMaxStaminaBonus = 0;
      combatant.theStrongestActive = false;
      notes.push(`Max Stamina −${bonus}`);
    }
    const mimicNote = revertMimicSynchronization(combatant);
    if (forcedByStagger) {
      combatant.shatteredEgoTurnsLeft = 3;
      notes.push("**Shattered E.G.O** 3 Turn (dmg −1/2, mọi Dice ra Min Dice)");
    }
    return `😈 **Hết Manifest E.G.O**${forcedByStagger ? " (bị Stagger cắt ngang)" : ""} — ${notes.join(" · ") || "trở lại bình thường"}.${mimicNote}`;
  }

  /** hitsPerDefenseCharge — 1 charge phòng thủ (Guard/Evade/Parry/Counter/Dash)
   *  chặn được BAO NHIÊU hit của đòn đánh thường này.
   *
   *  Vũ khí thường: theo WEIGHT (light 4 / medium 2 / heavy 1) — không đổi.
   *
   *  **Oracle Device [Caduceus]** khác hẳn: mỗi lần M1 nó roll ra một vũ khí
   *  khác nhau nên WEIGHT vô nghĩa. Fragaria chốt: *"charge defense cho M1 của
   *  Caduceus dựa vào STAMINA tiêu thụ của từng dice — lưỡi hái 20 Stamina tiêu
   *  1 charge, còn rìu 5 Stamina thì 4 đòn rìu mới cần 1 charge."*
   *  ⇒ 20 Stamina = 1 charge ⇒ hits/charge = 20 / (Stamina của mặt dice đó).
   *
   *  @param staminaPerHit Stamina của mặt Caduceus đang dùng (chỉ khi là Caduceus).
   */
  function hitsPerDefenseCharge(weaponWeight, { caduceusStaminaPerHit = 0 } = {}) {
    if (caduceusStaminaPerHit > 0) {
      const per = CADUCEUS_STAMINA_PER_CHARGE ?? 20;
      return Math.max(1, Math.round(per / caduceusStaminaPerHit));
    }
    return (WEAPON_DEFENSE_HITS_CU ?? { light: 4, medium: 2, heavy: 1 })[weaponWeight ?? "medium"] ?? 1;
  }

  function checkStaggerPanic(combatant) {
    if (combatant.currentStamina <= 0 && !combatant.staggered) {
      // "Reactive" (Composition Tool) — GAP ĐÃ SỬA: "Cho khả năng kháng Stagger
      // hai lần mỗi encounter". Chặn TRƯỚC khi set staggered, và hồi 1 điểm
      // Stamina để không rơi lại vào đúng điều kiện này ngay lần check kế tiếp
      // (Stamina vẫn ≤0 thì mọi checkStaggerPanic sau đều tiêu tiếp 1 lượt kháng
      // — hết sạch trong cùng 1 đòn, vô nghĩa).
      if ((combatant.reactiveStaggerResistLeft ?? 0) > 0) {
        combatant.reactiveStaggerResistLeft -= 1;
        combatant.currentStamina = Math.max(1, combatant.currentStamina);
        combatant.reactiveStaggerResistedNote = `🧩 Reactive (Composition Tool) chặn Stagger — còn ${combatant.reactiveStaggerResistLeft} lần trong encounter này.`;
        return;
      }
      combatant.staggered = true;
      // Choáng (luật xác nhận trực tiếp từ GM: "game không có status Choáng riêng,
      // chỉ có Stagger" — Choáng KHÔNG PHẢI 1 chấn thương random độc lập như Gãy tay/
      // Gãy chân/Gãy Xương, mà là COUNTER tự động +1 MỖI LẦN bị Stagger, không liên
      // quan gì tới roll injury 30% dmg) — BUG ĐÃ SỬA: trước đây "Choáng" nằm CHUNG
      // MINOR_INJURIES, bị roll random 40% cùng 3 cái kia thay vì tự động trigger ở
      // đây.
      // Thứ tự QUAN TRỌNG: "Sau 2 stack sẽ tăng lần stagger TIẾP THEO từ 1→2 turn" —
      // nghĩa là phải ĐÃ CÓ ĐỦ 2 stack TỪ TRƯỚC (không tính lần này) thì LẦN KẾ TIẾP
      // (lần Stagger thứ 3 trở đi) mới kéo dài 2 turn — Stagger lần 1 (stacks hiện=0)
      // và lần 2 (stacks hiện=1) đều VẪN 1 turn, chỉ từ lần 3 (stacks hiện=2) mới 2
      // turn. Do đó CHECK trước bằng giá trị HIỆN CÓ, rồi MỚI tăng dazedStacks sau.
      const isThisStagger2Turn = (combatant.dazedStacks ?? 0) >= 2;
      // BUG ĐÃ SỬA (xác nhận trực tiếp): "nếu turn 1 stagger thì turn 2 cũng sẽ
      // bị stagger" — TRƯỚC ĐÂY staggerTurnsLeft=1 khiến advanceCombatantTurn
      // (gọi lúc turn HIỆN TẠI — turn vừa trigger Stagger — kết thúc) trừ NGAY
      // về 0 và tắt Stagger TRƯỚC KHI turn kế tiếp bắt đầu — tức là Stagger chỉ
      // "tồn tại" trong chính turn nó trigger, không hề kéo dài qua turn sau như
      // luật. Giờ +1 cho cả 2 mức (1→2, 2→3) — vẫn giữ nguyên tỉ lệ ngắn/dài
      // tương đối giữa 2 loại Stagger, chỉ sửa đúng số tuyệt đối để "1-turn
      // Stagger" nghĩa là kéo dài qua ĐÚNG 1 turn kế tiếp (không phải 0 turn).
      combatant.staggerTurnsLeft = isThisStagger2Turn ? 3 : 2;
      // lastStaggerWas2Turn — cờ RIÊNG lưu ĐÚNG loại của LẦN STAGGER NÀY (1 hay 2
      // turn), đọc lại lúc Stagger này KẾT THÚC ở advanceCombatantTurn để quyết định
      // cleanse — KHÔNG dùng dazedStacks lúc đó (giá trị đã bị +1 ngay dòng dưới đây,
      // không còn phản ánh đúng "lúc trigger" nữa — BUG ĐÃ SỬA: trước đây
      // advanceCombatantTurn tự đọc dazedStacks HIỆN TẠI lúc Stagger kết thúc, nhưng
      // giá trị đó đã bị tăng lên 2 ngay SAU Stagger lần 2 (dù lần 2 đó vẫn CHỈ 1
      // turn) — khiến cleanse trigger NGAY sau lần 2 (1-turn), trước cả khi lần Stagger
      // 2-turn THẬT (lần 3) từng xảy ra — phá vỡ hoàn toàn chu kỳ "1,1,2-cleanse",
      // verify thực tế ra toàn 1-turn liên tục thay vì đúng pattern).
      combatant.lastStaggerWas2Turn = isThisStagger2Turn;
      combatant.dazedStacks = (combatant.dazedStacks ?? 0) + 1;
      combatant.currentStamina = 0;
      // "The Strongest" (Manifested E.G.O: Red Mist): "Nếu bạn bị Stagger ở
      // trong trạng thái Manifested E.G.O, LẬP TỨC kết thúc trạng thái và bản
      // thân nhận phải debuff Shattered E.G.O".
      // Đặt ở ĐÂY vì checkStaggerPanic là choke point DUY NHẤT của Stagger —
      // mọi nguồn (Stamina ≤0, forceStagger, Resonate…) đều đi qua đây, nên
      // không có đường nào Stagger mà thoát được luật này.
      // Gate bằng CỜ `theStrongestActive` chứ không tra ego.js: combat-utils
      // không (và không nên) biết gì về Manifested E.G.O nào có passive nào.
      // ── WOUND-CASING MASK ───────────────────────────────────────────────
      // "Nếu bị Stagger… thì mặt nạ sẽ bị vỡ ra" NHƯNG cũng "bạn MIỄN NHIỄM với
      // hiệu ứng Stagger". Đọc gộp: cú Stagger KHÔNG làm bạn Stagger, nhưng nó
      // LÀM VỠ mặt nạ. Đó là cách duy nhất để hai vế cùng đúng.
      // ⚠️ Cần Fragaria xác nhận nếu ý là khác.
      if (combatant.woundCasingMaskIntact) {
        combatant.woundCasingMaskIntact = false;
        combatant.sizzlingWound = true;
        combatant.maskBrokenNote = "🎭 **Wound-Casing Mask VỠ** — vết thương cũ quay lại: **Sizzling Wound** hoạt động tới hết Encounter.";
      }
      if (combatant.hasWoundCasingMask) {
        // Miễn nhiễm Stagger — huỷ luôn cú Stagger vừa đặt ở trên.
        combatant.staggered = false;
        combatant.dazedStacks = Math.max(0, (combatant.dazedStacks ?? 1) - 1);
        // return TRẦN — checkStaggerPanic KHÔNG có biến `notes` (nó không trả về
        // gì). `return notes` ở đây sẽ là ReferenceError ngay lúc ai đó Stagger.
        return;
      }
      if (combatant.theStrongestActive && combatant.manifestedEGO) {
        combatant.staggerForcedNote = endManifestedEgoState(combatant, { forcedByStagger: true });
      }
      // Cleanse: SAU KHI lần Stagger 2-turn này THỰC SỰ KẾT THÚC, dazedStacks reset về
      // 0 (chu kỳ 1,1,2-cleanse lặp lại) — xem advanceCombatantTurn, không reset ở
      // đây vì Stagger vừa MỚI BẮT ĐẦU, chưa kết thúc.
    }
    // Negative Thoughts (Gloom, [30 Points]): "Chỉ bị Panic ở +45 Sanity" — đảo
    // NGƯỢC chiều ngưỡng Panic hoàn toàn (thay vì -45). Các phần KHÁC của perk này
    // (đảo dice bonus từ Sanity, nguồn hồi Sanity thành giảm, thắng/thua Clash) PHỤ
    // THUỘC Clash hoặc đụng quá sâu vào core calcMathCore — để GM tự áp dụng tay,
    // CHỈ phần ngưỡng Panic này được code (đủ contained, không rủi ro cho player khác).
    if (hasPerk(combatant, "Negative Thoughts")) {
      if (combatant.currentSanity >= ENCOUNTER_SANITY_MAX && !combatant.panic) {
        combatant.panic = true;
        combatant.panicTurnsLeft = 1;
        combatant.currentSanity = ENCOUNTER_SANITY_MAX;
      }
    } else if (combatant.currentSanity <= -ENCOUNTER_SANITY_MAX && !combatant.panic) {
      combatant.panic = true;
      combatant.panicTurnsLeft = 1;
      combatant.currentSanity = -ENCOUNTER_SANITY_MAX;
    }
  }

  /** applyFuriosoUseCosts — CHI PHÍ + hệ quả của việc DÙNG một biến thể Furioso.
   *
   *  ⚠️ NGUỒN SỰ THẬT DUY NHẤT cho 2 đường: đòn tấn công thật
   *  (resolve-pending-action.js) VÀ Clash (interaction-handlers.js). Fragaria
   *  yêu cầu Furioso clash được — nhưng nếu đường Clash không trả giá thì thành
   *  exploit: Furioso `cost: "—"`, `cd: "—"` nên đường Clash (vốn chỉ trừ Light
   *  + CD) sẽ cho xài MIỄN PHÍ, lặp vô hạn. Đúng lỗi #12 trong HAND-OFF
   *  ("thêm lựa chọn cho người chơi mà QUÊN tính chi phí").
   *
   *  KHÔNG bao gồm phần hàng đợi Bleed/Bind/Fragile lên MỤC TIÊU — đó là hiệu
   *  ứng của đòn TRÚNG, không phải chi phí; Clash không trúng ai nên không áp.
   *  @returns {string[]} các dòng ghi chú để nơi gọi tự nối vào output.
   */
  function applyFuriosoUseCosts(user, skill) {
    if (!user || !skill?.caduceusFurioso) return [];
    const notes = [];
    // Đã vỡ mặt nạ từ trước + dùng Furioso ⇒ Saikai2.
    if (user.sizzlingWound && !user.woundCasingMaskIntact) {
      user.saikai2TurnsLeft = 2;
      user.lastFuriosoName = skill.name;
      user.bgmAnnounceNow = "Saikai2.mp3";
      user.bgmAnnounceLabel = `BGM **${skill.name}** (kéo dài 2 Turn)`;
      notes.push(` 🎵[BGM → **Saikai2.mp3** (${skill.name}, 2 Turn)]`);
    }
    // Còn mặt nạ ⇒ ghi đè Saikai1 (turn này + turn kế) RỒI mới làm vỡ — đặt sau
    // khi vỡ thì điều kiện "vẫn còn mặt nạ" không bao giờ đúng.
    if (user.woundCasingMaskIntact) {
      user.saikai1TurnsLeft = 2;
      user.lastFuriosoName = skill.name;
      user.bgmAnnounceNow = "Saikai1.mp3";
      user.bgmAnnounceLabel = `BGM **${skill.name}** (kéo dài 2 Turn)`;
      user.woundCasingMaskIntact = false;
      user.sizzlingWound = true;
      notes.push(` 🎭[**Wound-Casing Mask VỠ** vì dùng Furioso — Sizzling Wound quay lại tới hết Encounter]`);
      notes.push(` 🎵[BGM → **Saikai1.mp3** (turn này + turn kế), sau đó **Saikai2.mp3**]`);
    }
    // Singleton — "dùng biến thể Furioso bất kỳ cho 1 stack Indulgence in Prescript".
    if (user.singleton && user.hasIndexOraclesProxy) {
      // ❗ TRẦN = 1 (Fragaria chốt 12/08: "max cap của Indulgence là 1, và nó sẽ
      // hết sau khi end turn"). Hiệu ứng là +2 count PHẲNG khi có stack — không
      // nhân theo số stack — nên để nó cộng dồn chỉ tạo con số vô nghĩa trên UI.
      // Reset cuối turn nằm ở turn-advance.js.
      user.indulgenceInPrescript = Math.min(INDULGENCE_MAX, (user.indulgenceInPrescript ?? 0) + 1);
      notes.push(` 📜[+1 **Indulgence in Prescript** — đòn có áp Sinking sẽ inflict thêm 2 count]`);
    }
    // "Sau khi sử dụng Furioso thì reset toàn bộ Procuration [Hermes] về 0."
    user.procurationHermes = [];
    // Fragaria: khoá cửa nạp lại Procuration cho tới HẾT TURN — nếu không,
    // chính đòn Furioso này roll ra mặt Caduceus và nạp đầy lại ngay ⇒ loop vô
    // hạn. Đọc ở resolve-pending-action.js, reset ở advanceCombatantTurn.
    user.furiosoUsedThisTurn = true;
    return notes;
  }


  // ── TRẦN "N lần/turn" CỦA TỪNG MẶT CADUCEUS ─────────────────────────────────
  // Fragaria 14/08 chốt rõ: *"hiệu ứng của DICE NÀY 1 turn chỉ áp được max 2 lần,
  // chứ không phải toàn bộ dice hiệu ứng chỉ kích 2 lần mỗi turn — mà là RIÊNG
  // BIỆT TỪNG DICE; chỉ MỘT SỐ dice mới max 2 lần/turn thôi."*
  // Và: *"không riêng gì M1 mà cả Critical nữa."*
  //
  // ❗ TRƯỚC ĐÂY trần chỉ tồn tại ở nhánh M1 (`interaction-handlers.js`) với tập
  // mặt HARDCODE `{3,4,6,7,8}` và số `2`. Critical đi NHÁNH SONG SONG hoàn toàn
  // khác (skills.js roll() ghi chữ → `autoExtractDiceSideEffects` /
  // `extractDmgTakenGrants` đọc chữ rồi áp) nên KHÔNG hề bị chặn — lớp lỗi 3.
  //
  // NAY: trần đọc THẲNG từ `desc` trong constants.js ("(2 lần/turn)"). Data là
  // nguồn sự thật duy nhất — sửa desc là luật đổi theo, không phải nhớ sửa 2 nơi.
  // Bộ đếm `caduceusFaceUses` DÙNG CHUNG giữa M1 và Critical: cùng một mặt dice
  // trong cùng một turn thì chung hạn mức, bất kể ra từ đường nào.

  /** Trần của một mặt (đọc từ desc). null = KHÔNG giới hạn. */
  function caduceusFaceLimit(faceN) {
    const face = (CADUCEUS_DICE ?? []).find(d => d.n === faceN);
    const m = /\((\d+)\s*l[aầ]n\s*\/\s*turn\)/i.exec(String(face?.desc ?? ""));
    return m ? parseInt(m[1], 10) : null;
  }

  /** Xin 1 lượt dùng cho mặt `faceN`. true = được phép áp, false = đã đủ hạn mức. */
  function consumeCaduceusFaceUse(combatant, faceN) {
    if (!combatant) return false;
    const limit = caduceusFaceLimit(faceN);
    if (limit === null) return true;                 // mặt không giới hạn
    combatant.caduceusFaceUses = combatant.caduceusFaceUses ?? {};
    const used = combatant.caduceusFaceUses[faceN] ?? 0;
    if (used >= limit) return false;
    combatant.caduceusFaceUses[faceN] = used + 1;
    return true;
  }

  /** Map tên mặt → số mặt. Tên 9 mặt là DUY NHẤT (t-caduceus-cap kiểm chứng). */
  function caduceusFaceByName(line) {
    for (const d of CADUCEUS_DICE ?? []) {
      if (String(line).includes(d.name)) return d.n;
    }
    return null;
  }

  /** Lọc dòng dice của Critical Caduceus: mặt đã hết hạn mức thì GỠ phần mô tả
   *  hiệu ứng, để hai parser (`autoExtractDiceSideEffects`, `extractDmgTakenGrants`)
   *  không còn thấy gì mà áp. Chặn ở ĐÂY vì đó là chỗ DUY NHẤT cả hai cùng đọc —
   *  vá riêng từng parser là lặp lại đúng lớp lỗi 8.
   *  Giữ nguyên phần dmg/type/tên để người chơi vẫn thấy mình roll ra gì. */
  function capCaduceusCriticalLines(lines, combatant) {
    if (!combatant) return lines;
    return (lines ?? []).map((line) => {
      if (!/^<:Dice\d+:/.test(String(line))) return line;
      const faceN = caduceusFaceByName(line);
      if (faceN === null) return line;
      if (caduceusFaceLimit(faceN) === null) return line;   // mặt không giới hạn
      if (consumeCaduceusFaceUse(combatant, faceN)) return line;
      // Hết hạn mức turn này — PHẢI CẮT HẲN phần mô tả hiệu ứng, không chỉ ghi
      // chú thêm. Hai parser đọc CHỮ trong dòng; còn chữ là còn áp.
      // Cấu trúc dòng roll(): `<:DiceN:…>**giá trị**[tag] [<:Type:…>Type]<mô tả
      // hiệu ứng> — *tên mặt*`. Giữ phần đầu tới `]` cuối cùng của khối type, và
      // giữ ` — *tên*` để người chơi vẫn thấy mình roll ra mặt nào.
      const raw = String(line);
      const mType = /\[<:(?:Slash|Blunt|Pierce):\d+>(?:Slash|Blunt|Pierce)\]/.exec(raw);
      const mName = /\s+—\s+\*/.exec(raw);
      if (!mType || !mName || mName.index <= mType.index) return raw;   // dòng lạ: để nguyên, thà bỏ sót còn hơn cắt bậy
      const head = raw.slice(0, mType.index + mType[0].length);
      const tail = raw.slice(mName.index);
      return `${head}${tail} *(mặt này đã đủ ${caduceusFaceLimit(faceN)} lần trong turn — hiệu ứng không áp)*`;
    });
  }


  /** applyBorrowedEyesCharges — cấp charge né của Borrowed Eyes.
   *
   *  ❗ TÁCH RA DÙNG CHUNG (14/08). Trước đây logic này chỉ nằm trong
   *  `resolve-pending-action.js`, tức chỉ chạy khi có `pendingAction` — mà AI thì
   *  không tạo được (page không có tag loại dmg ⇒ `dmgStr = null` ⇒ cả khối tấn
   *  công của enemy-ai bị bỏ qua). Nếu chép logic sang enemy-ai là hai nhánh song
   *  song rồi lệch nhau — đúng lớp lỗi 3/8. Nên để MỘT hàm, hai nơi cùng gọi.
   *
   *  Lấy số TỪ DÒNG DICE trong embed roll — nguồn duy nhất, đúng bằng con số
   *  người chơi vừa nhìn thấy, không roll lại.
   *  `borrowedEyeCharges` là phép GÁN (không cộng dồn) — dùng lại khi còn charge
   *  sẽ ghi đè mất số cũ, nên nơi gọi phải tự chặn.
   */
  function applyBorrowedEyesCharges(combatant, rollDescription, fallbackDmgStr = "") {
    let diceVal = 0;
    for (const line of String(rollDescription ?? "").split("\n")) {
      if (!/^<:Dice\d+:/.test(line)) continue;
      const m = line.match(/\*\*(\d+(?:[.,]\d+)?)\*\*/);
      if (m) { diceVal = Math.round(parseFloat(m[1].replace(",", "."))); break; }
    }
    if (diceVal <= 0) diceVal = Math.round(parseFloat(String(fallbackDmgStr ?? "0").match(/(\d+(?:\.\d+)?)/)?.[1] ?? "0")) || 0;
    if (diceVal <= 0) return { charges: 0, note: "" };
    combatant.evadeCharges = (combatant.evadeCharges ?? 0) + diceVal;
    combatant.borrowedEyeCharges = diceVal;
    return {
      charges: diceVal,
      note: ` <:Eye:1513769425063514173>[Borrowed Eye: +${diceVal} charge né (tổng ${combatant.evadeCharges})]`,
    };
  }

  return {
    applyBorrowedEyesCharges,
    caduceusFaceLimit,
    consumeCaduceusFaceUse,
    capCaduceusCriticalLines,
    applyFuriosoUseCosts,
    rollSpeedValue,
    determineTurnOrder,
    isCurrentTurnHolder,
    validateAndRerollPrescript,
    validateAndRerollPrescriptRound,
    computeDiceModifier,
    applyHpLoss,
    grantShieldHp,
    applyShieldLoss,
    healHpCapped,
    hasEncounterStarted,
    insertIntoTurnOrderMidRound,
    advanceToNextTurnHolder,
    buildTurnOrderText,
    combatantResStr,
    trueDmgResStr,
    haouRuptureResStr,
    applyParrySuccessPerks,
    applyEvadeSuccessPerks,
    restoreInjuryMaxHp,
    applyDeathPenalty,
    appendActionLog,
    getActionLogIcon,
    checkStaggerPanic,
    syncCompassionPhantomHp,
    applyUnlockProgress,
    hitsPerDefenseCharge,
    applyMimicryForm,
    applyMimicSynchronization,
    revertMimicSynchronization,
    endManifestedEgoState,
    MIMICRY_SYNC_FORMS,
  };
};
