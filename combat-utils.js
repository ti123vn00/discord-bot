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

module.exports = function ({ hasPerk, getPlayerDataWithSlot, savePlayerData, calcGrade, CHARGE_MAX, ENCOUNTER_SANITY_MAX, findWeaponAnywhere }) {

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
  function validateAndRerollPrescript(encounter, leavingEntry, enteringEntry) {
    const notes = [];
    if (leavingEntry) {
      const c = leavingEntry.type === "enemy" ? encounter.enemies[leavingEntry.id] : encounter.players[leavingEntry.id];
      if (c && c.prescriptRoll !== null && c.prescriptRoll !== undefined) {
        const didNothing = !c.prescriptAttacked && !c.prescriptEvaded && !c.prescriptBlocked && !c.prescriptParried && !c.prescriptClashed;
        const successMap = {
          1: c.prescriptAttacked,
          2: c.prescriptEvaded,
          3: c.prescriptBlocked,
          4: c.prescriptParried,
          5: c.prescriptAttacked && (c.prescriptEvaded || c.prescriptBlocked || c.prescriptParried),
          6: didNothing,
          7: c.prescriptClashed,
        };
        const succeeded = !!successMap[c.prescriptRoll];
        const label = leavingEntry.type === "enemy" ? (encounter.enemies[leavingEntry.id]?.name ?? leavingEntry.id) : `<@${leavingEntry.id}>`;
        if (succeeded) {
          c.graceOfPrescript = (c.graceOfPrescript ?? 0) + 1;
          notes.push(`<:Prescript:1528452494945157281> **Sắc lệnh #${c.prescriptRoll}** của ${label} THÀNH CÔNG — +1 Grace of Prescript (tổng ${c.graceOfPrescript}).`);
        } else {
          c.karmicConsequence = Math.min(100, (c.karmicConsequence ?? 0) + 5);
          notes.push(`<:Karmic_Consequence:1532503901687779338> **Sắc lệnh #${c.prescriptRoll}** của ${label} THẤT BẠI — +5 Karmic Consequence (tổng ${c.karmicConsequence}).`);
        }
        c.prescriptRoll = null;
        c.prescriptAttacked = false;
        c.prescriptEvaded = false;
        c.prescriptBlocked = false;
        c.prescriptParried = false;
        c.prescriptClashed = false;
      }
    }
    if (enteringEntry) {
      const c = enteringEntry.type === "enemy" ? encounter.enemies[enteringEntry.id] : encounter.players[enteringEntry.id];
      if (c) {
        const weaponInfoForOutfit = c.hasIndexProselyte;
        if (weaponInfoForOutfit) {
          c.prescriptRoll = Math.floor(Math.random() * 7) + 1;
          const rollLabels = { 1: "Tấn công 1 lần", 2: "Né 1 lần", 3: "Block 1 lần", 4: "Parry 1 lần", 5: "1 phòng thủ + 1 tấn công", 6: "Không làm gì", 7: "Clash với 1 skill" };
          const label = enteringEntry.type === "enemy" ? (encounter.enemies[enteringEntry.id]?.name ?? enteringEntry.id) : `<@${enteringEntry.id}>`;
          notes.push(`<:Prescript:1528452494945157281> **Sắc lệnh mới** cho ${label}: **#${c.prescriptRoll}** — ${rollLabels[c.prescriptRoll]}.`);
        }
        const weaponInfo = findWeaponAnywhere(c.weaponName);
        const hasWillOfPrescript = (weaponInfo?.passives ?? []).some(pa => pa.name === "Will of Prescript");
        if (hasWillOfPrescript) {
          // Xoá dấu ở mục tiêu CŨ (nếu có, từ lần roll trước đó) trước khi gán
          // mục tiêu MỚI — tránh sót lại "Bị đánh dấu bởi X" trên mục tiêu ĐÃ
          // KHÔNG còn bị đánh dấu nữa.
          if (c.prescriptTargetId && encounter.enemies[c.prescriptTargetId]) {
            delete encounter.enemies[c.prescriptTargetId].markedByPrescriptTargetOf;
          }
          const livingEnemyKeys = Object.keys(encounter.enemies ?? {}).filter(k => (encounter.enemies[k]?.currentHp ?? 0) > 0);
          if (livingEnemyKeys.length > 0) {
            const pick = livingEnemyKeys[Math.floor(Math.random() * livingEnemyKeys.length)];
            c.prescriptTargetId = pick;
            // Task yêu cầu trực tiếp: "cần làm rõ ràng the prescript target trên
            // mục tiêu hơn" — TRƯỚC ĐÂY chỉ lưu ID (không hiện tên rõ ràng ở board
            // status, và mục tiêu BỊ đánh dấu không hề biết mình bị đánh dấu bởi
            // ai) — giờ lưu thêm tên để hiện rõ (marker), VÀ đánh dấu NGƯỢC LẠI
            // trên chính combatant mục tiêu (markedByPrescriptTargetOf — encounter-
            // display.js đọc field này để hiện "Bị đánh dấu bởi X" ngay trên mục
            // tiêu, không cần biết ai đang giữ Will of Prescript).
            const markerLabel = enteringEntry.type === "enemy" ? (encounter.enemies[enteringEntry.id]?.name ?? enteringEntry.id) : `<@${enteringEntry.id}>`;
            c.prescriptTargetName = encounter.enemies[pick]?.name ?? pick;
            encounter.enemies[pick].markedByPrescriptTargetOf = markerLabel;
            notes.push(`<:The_Prescripts_Target:1528452363159998525> **The Prescript Target's - The Index** đánh dấu lên **${c.prescriptTargetName}**.`);
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
  function combatantResStr(combatant) {
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
      const totalReduction = 0.2 + extraReduction;
      // round1 — làm tròn 1 chữ số thập phân. BẮT BUỘC: phép trừ số thực JS cho ra
      // rác kiểu `1 - 0.7 = 0.30000000000000004`, lọt thẳng vào resStr rồi hiển thị
      // cho người chơi (và phải parse lại ở trueDmgResStr/damage-calc).
      const round1 = (v) => Math.round(Math.max(0, v) * 10) / 10;
      return `${round1(r.B - totalReduction)}xB ${round1(r.P - totalReduction)}xP ${round1(r.S - totalReduction)}xS`;
    }
    return `${r.B}xB ${r.P}xP ${r.S}xS`;
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
      attackerCombatant.currentHp = Math.max(0, attackerCombatant.currentHp - 10);
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
      attackerCombatant.currentHp = Math.max(0, attackerCombatant.currentHp - 10);
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

  return {
    rollSpeedValue,
    determineTurnOrder,
    isCurrentTurnHolder,
    validateAndRerollPrescript,
    validateAndRerollPrescriptRound,
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
  };
};
