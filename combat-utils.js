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

module.exports = function ({ hasPerk, getPlayerDataWithSlot, savePlayerData, calcGrade, CHARGE_MAX, ENCOUNTER_SANITY_MAX }) {

  /** rollSpeedValue — roll trong Range Speed của combatant, cộng Haste trừ Bind
   *  ("1 Haste +1 Speed, 1 Bind -1 Speed" theo update mới). */
  function rollSpeedValue(combatant) {
    const base = combatant.speedRangeMin + Math.floor(Math.random() * (combatant.speedRangeMax - combatant.speedRangeMin + 1));
    return base + (combatant.haste ?? 0) - (combatant.bind ?? 0);
  }
  
  /**
   * determineTurnOrder — roll Speed cho TẤT CẢ combatant, sắp xếp giảm dần quyết
   * định thứ tự hành động. Khi bằng Speed:
   *   - CÙNG PHE (player-player hoặc enemy-enemy) → KHÔNG tự roll lại — đánh dấu
   *     "tiedWith" để GM/player tự thoả thuận ai trước (giữ thứ tự hiện tại làm
   *     fallback nếu không ai lên tiếng).
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
  
    entries.sort((a, b) => b.combatant.currentSpeed - a.combatant.currentSpeed);
    const order = entries.map((e, i) => ({
      id: e.id, type: e.type, speed: e.combatant.currentSpeed,
      tiedWith: entries.filter((o, j) => j !== i && o.combatant.currentSpeed === e.combatant.currentSpeed).map(o => o.id),
    }));
    encounter.turnOrder = order;
    return order;
  }
  
  /** buildTurnOrderText — hiện danh sách thứ tự turn đã roll, kèm cảnh báo hoà cùng phe. */
  function buildTurnOrderText(encounter) {
    const order = encounter.turnOrder ?? [];
    if (order.length === 0) return "Chưa roll Speed — dùng `-encounter rollspeed`.";
    return order.map((e, i) => {
      const label = e.type === "enemy" ? `**${encounter.enemies[e.id]?.name ?? e.id}**` : `<@${e.id}>`;
      const tieNote = e.tiedWith.length > 0 ? ` ⚖️ *(hoà Speed — tự thoả thuận thứ tự với ${e.tiedWith.length} người khác cùng phe)*` : "";
      return `**#${i + 1}** ${label} — Speed **${e.speed}**${tieNote}`;
    }).join("\n");
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
      return `${Math.max(0, r.B - totalReduction)}xB ${Math.max(0, r.P - totalReduction)}xP ${Math.max(0, r.S - totalReduction)}xS`;
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
      combatant.staggerTurnsLeft = isThisStagger2Turn ? 2 : 1;
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
