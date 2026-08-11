// resolve-pending-action.js
// Hàm resolveOnePendingAction — tính toán và áp dụng KẾT QUẢ THẬT của 1 hành
// động chiến đấu (M1/Skill/Critical/Enemy Attack) sau khi tất cả target đã
// phản hồi phòng thủ, bao gồm TOÀN BỘ hook weapon/outfit passive (Coffin,
// Dark Cloud, Tigermark Round, Thumb Capo IIII, Tactical Suppression...) —
// TÁCH khỏi index.js theo yêu cầu trực tiếp: "tách nhỏ file index.js ra các
// file js khác" (code đã lên tới 11k+ dòng).
//
// COPY NGUYÊN VĂN (không sửa 1 dòng logic nào). Dependency list được xác định
// qua PHÂN TÍCH AST CHÍNH XÁC (acorn) — không dựa vào suy đoán thủ công, để
// tránh sai sót ở 1 hàm lớn và phức tạp như thế này.

// SPEED_HASTE_WEAPONS — vũ khí có passive "Speed" (mechanicId `warp_speed_haste`
// trong weapon.js): "4 đòn đánh thường sẽ nhận 1 Haste". Liệt kê tường minh ở
// đây thay vì require weapon.js (tránh thêm dependency mới vào file này) — NHỚ
// cập nhật nếu weapon.js thêm vũ khí có cùng mechanicId.
const SPEED_HASTE_WEAPONS = new Set(["Viriscent Pyrojade Ring", "Cinq Rapier"]);

// RENEGADE_DIVISOR — hệ số chia base dmg khi phản (Lucent Historia).
// Suy TRỰC TIẾP từ 3 ví dụ Fragaria đưa: light 5→5 · medium 10/2 · heavy 20/4.
const RENEGADE_DIVISOR = { light: 1, medium: 2, heavy: 4 };

module.exports = function ({ IMITATION_MAX, hasEgoMechanic, applyHpLoss, applyShieldLoss, healHpCapped, grantShieldHp, BLEED_MAX, BURN_MAX, CHARGE_MAX, ENCOUNTER_SANITY_MAX, HEMORRHAGE_MAX, POISE_MAX, TREMOR_MAX, WEAPON_DEFENSE_HITS, applyDeathPenalty, applyEmotionDelta, applyEvadeSuccessPerks, applyParrySuccessPerks, applySanityGain, calcMathCore, autoExtractDiceSideEffects, checkStaggerPanic, clearUserActiveEncounterChannel, combatantResStr, finalizeQuestOutcome, cdKeyFor, findSkill, findWeaponAnywhere, forceStagger, getPlayerDataWithSlot, hasPerk, incrementKillTaskProgress, resolveCombatant, rollInjury, saturateDR, savePlayerData, appendActionLog }) {

async function resolveOnePendingAction(encounter, p) {
  const resultLines = [];
  // perHitMultForBulletEffect — khai báo Ở ĐÂY (top-level hàm, KHÔNG PHẢI bên
  // trong vòng for (const t of p.targets) bên dưới) — để dùng được ở CẢ bên
  // trong vòng for LẪN các đoạn code SAU KHI vòng for đó đã đóng (VD Blade
  // Lineage keypage 1's trigger, đặt sau chỗ ghi đè poise chung).
  let perHitMultForBulletEffect = null;
  // BUG ĐÃ SỬA (Fragaria báo trực tiếp: "-daily có bug là nhận ahn và sách xong
  // nhưng vẫn không hoàn thành quest").
  //
  // NGUYÊN NHÂN GỐC — TRANH CHẤP LOCK userId, lỗi bị `catch {}` nuốt mất:
  // Khi player hạ con mob CUỐI CÙNG của 1 contract, đúng 1 lần resolve này kích
  // hoạt BA thao tác cùng khoá `withLock(userId)` trên CÙNG 1 người:
  //   (1) incrementKillTaskProgress(attacker) — nhiệm vụ 3 của -daily
  //   (2) grantContractReward(pid)            — phát EXP/Ahn/Random Book
  //   (3) markContractTaskDone(pid)           — nhiệm vụ 2 của -daily
  // (1) TRƯỚC ĐÂY là fire-and-forget (`.catch(() => {})`, KHÔNG await) nên nó
  // vẫn đang GIỮ lock khi finalizeQuestOutcome chạy tới (2) rồi (3).
  // `withLock` mặc định chỉ kiên nhẫn `retries: 3 × retryDelayMs: 200` ≈ 600ms —
  // mà mỗi lần acquireLock là 1 round-trip Upstash từ Render. (3) là thao tác
  // ĐI SAU CÙNG nên chịu tranh chấp nặng nhất, và lỗi của nó bị nuốt bởi
  // `catch { }` trong quest-resolution.js → KHÔNG ai biết nó đã thất bại.
  // → Kết quả ĐÚNG như mô tả: Ahn + sách (bước 2) đã vào tay, nhưng nhiệm vụ
  //   "hoàn thành 1 contract" (bước 3) vẫn ⬜.
  //
  // SỬA: KHÔNG fire-and-forget nữa — gom promise lại rồi `await` HẾT ngay
  // TRƯỚC finalizeQuestOutcome. Lock được nhả sạch trước khi (2)/(3) cần tới,
  // tranh chấp biến mất hoàn toàn thay vì chỉ "hy vọng kịp".
  const dailyKillHookPromises = [];
            const attacker = resolveCombatant(encounter, p.attackerId);
            if (!attacker) { resultLines.push(`⚠️ Bỏ qua 1 action — không tìm thấy attacker ${p.attackerId} (có thể đã rời encounter).`); return resultLines; }

            // ── "The Red Mist" (Manifested E.G.O: Red Mist) ─────────────────
            // "Bạn được hồi máu dựa vào 4% sát thương gây ra."
            // Tính CỜ MỘT LẦN ở đây thay vì gọi hasEgoMechanic() trong vòng lặp
            // hit (chạy tới hàng chục lần mỗi action). Cộng dồn vào
            // redMistHealTotal rồi in MỘT dòng — in mỗi hit sẽ ngập log.
            const redMistLifestealActive = attacker.combatant
              ? hasEgoMechanic(attacker.combatant, "redmist_the_red_mist")
              : false;
            let redMistHealTotal = 0;
            // The Mimic — page nào khai `mimicryFormOnUse` thì tự chuyển dạng
            // Mimicry ("Biến Mimicry trở thành một cây lưỡi hái" nằm ngay trong
            // text của Reaching Hand / Dense Flesh). Chỉ đổi khi ĐANG ở dạng
            // Mimicry: Synchronization — page dùng lúc không Manifest thì thôi.
            {
              const usedSkill = p.skillKey ? findSkill(p.skillKey) : null;
              if (usedSkill?.mimicryFormOnUse && attacker.combatant?.mimicSyncActive
                  && attacker.combatant.mimicryForm !== usedSkill.mimicryFormOnUse) {
                attacker.combatant.mimicryForm = usedSkill.mimicryFormOnUse;
                attacker.combatant.weaponBaseDamage = usedSkill.mimicryFormOnUse === "scythe" ? 56 : 28;
                attacker.combatant.weaponWeight = usedSkill.mimicryFormOnUse === "scythe" ? "heavy" : "medium";
                attacker.combatant.weaponType = "Slash";
                resultLines.push(`🗡️ **Mimicry: Synchronization** → dạng **${usedSkill.mimicryFormOnUse === "scythe" ? "Lưỡi hái" : "Kiếm"}** (theo ${usedSkill.name}).`);
              }
            }

            // Stamina cost (chỉ attack mới có) — trừ 1 LẦN cho action này, KHÔNG
            // nhân theo số target (1 đòn M1 chỉ tốn Stamina 1 lần dù AOE).
            let staminaNote = "";
            // eyeOfHorusAmmo — GAP ĐÃ SỬA (xác nhận trực tiếp, ĐÍNH CHÍNH lần
            // trước): "repeat ammo miễn ammo từ nội tại đó" — TÁCH RIÊNG khỏi
            // điều kiện p.staminaCost bên dưới (vì Repeat có staminaCost=0, sẽ
            // bỏ qua toàn bộ block Stamina), NHƯNG giờ repeat cũng MIỄN pool
            // nội tại này luôn (không trừ gì cả khi isRepeatAmmo=true).
            if (p.isEyeOfHorusFixedBurst && !p.isRepeatAmmo && attacker.type === "player") {
              attacker.combatant.eyeOfHorusAmmo = Math.max(0, (attacker.combatant.eyeOfHorusAmmo ?? 8) - (p.eyeOfHorusVolleyCount ?? 0));
            }
            // GAP ĐÃ SỬA (xác nhận trực tiếp): "khi trigger repeat ammo thì không
            // tốn stamina, và ammo; chỉ duy nhất là light được nhận" — repeat
            // MIỄN Stamina + cả 2 loại Ammo (inventory lẫn nội tại), NHƯNG vẫn
            // +1 Light mỗi lần trigger — đây là thứ DUY NHẤT repeat vẫn tạo ra.
            let eyeOfHorusRepeatLightNote = "";
            let dieciSinkingGain = 0; // "Dieci Association" — lưu số Sinking cần áp THẬT ở cuối hàm (xem comment đầy đủ ở khối shieldHp).
            let darkCloudExplodeGain = 0; // "Dark Cloud" (outfit, 6+ stack) — số lần "nổ" Bleed cần áp THẬT ở cuối hàm, cùng lý do với dieciSinkingGain.
            if (p.isEyeOfHorusFixedBurst && p.isRepeatAmmo && attacker.type === "player") {
              attacker.combatant.currentLight = Math.min(attacker.combatant.maxLight, (attacker.combatant.currentLight ?? 0) + 1);
              eyeOfHorusRepeatLightNote = ` 🔄[Repeat Ammo +1 Light]`;
            }
            if (p.staminaCost && attacker.type === "player") {
              attacker.combatant.currentStamina = Math.max(0, attacker.combatant.currentStamina - p.staminaCost);
              attacker.combatant.staminaUsedThisTurn += p.staminaCost;
              // "Black Suit" (outfit) — GAP MỚI (xác nhận trực tiếp): "Refund
              // 1/5 Stamina khi đánh thường" — CHỈ áp cho M1 (staminaCost chỉ
              // được set khi isM1:true, không phải skill/Critical dùng
              // lightCost/sanityCost khác).
              let blackSuitRefundNote = "";
              if (attacker.combatant.equippedOutfit === "Black Suit") {
                const refundAmount = Math.round(p.staminaCost / 5 * 100) / 100;
                attacker.combatant.currentStamina = Math.min(attacker.combatant.maxStamina, attacker.combatant.currentStamina + refundAmount);
                blackSuitRefundNote = ` 🖤[Black Suit Refund +${refundAmount} Sta]`;
              }
              checkStaggerPanic(attacker.combatant);
              staminaNote = ` (-${p.staminaCost} Sta${blackSuitRefundNote}${attacker.combatant.staggered ? " 💫Stagger!" : ""})`;
              // Regain Mind (Shin, [30 Points]): mỗi 40 Stamina mất do M1 (đánh
              // thường) → +10 Sanity. Tích lũy riêng (KHÔNG dùng chung
              // staminaUsedThisTurn vì cái đó reset mỗi turn còn đây cần tích lũy
              // XUYÊN TURN cho tới khi đủ 40) — 1 action tốn ≥40 Sta (VD M1 nhiều hit
              // vũ khí heavy) có thể cho nhiều lần 10 Sanity cùng lúc.
              if (hasPerk(attacker.combatant, "Regain Mind")) {
                attacker.combatant.regainMindAccumulator = (attacker.combatant.regainMindAccumulator ?? 0) + p.staminaCost;
                const sanityGainCount = Math.floor(attacker.combatant.regainMindAccumulator / 40);
                if (sanityGainCount > 0) {
                  attacker.combatant.regainMindAccumulator -= sanityGainCount * 40;
                  const sanityBeforeRegain = attacker.combatant.currentSanity;
                  applySanityGain(attacker.combatant, sanityGainCount * 10);
                  const actualSanityDelta = attacker.combatant.currentSanity - sanityBeforeRegain;
                  staminaNote += ` 🧠${actualSanityDelta >= 0 ? "+" : ""}${actualSanityDelta} Sanity (Regain Mind)`;
                }
              }
              // "Cinq Association": "Nhận được 2 Haste vào mỗi 20 Stamina tiêu
              // thụ thông qua đánh thường" — CHỈ áp dụng cho M1 (isM1), dùng
              // cùng pattern accumulator với Regain Mind (tích luỹ xuyên turn).
              if (p.isM1 && attacker.combatant.hasCinqAssociation) {
                attacker.combatant.cinqAssociationAccumulator = (attacker.combatant.cinqAssociationAccumulator ?? 0) + p.staminaCost;
                const hasteGainCount = Math.floor(attacker.combatant.cinqAssociationAccumulator / 20);
                if (hasteGainCount > 0) {
                  attacker.combatant.cinqAssociationAccumulator -= hasteGainCount * 20;
                  attacker.combatant.haste = (attacker.combatant.haste ?? 0) + hasteGainCount * 2;
                  staminaNote += ` 🐎+${hasteGainCount * 2} Haste (Cinq Association)`;
                }
              }
              // "Speed" (Viriscent Pyrojade Ring / Cinq Rapier) — GAP ĐÃ SỬA
              // (phát hiện qua audit mechanicId `warp_speed_haste`: có trong
              // weapon.js nhưng KHÔNG một dòng code nào đọc tới). Luật: "4 đòn
              // đánh thường sẽ nhận 1 Haste".
              // Đếm theo LẦN BẤM M1 (không phải số hit) — 1 lần M1 nhiều hit vẫn
              // là 1 "đòn đánh thường", đúng cách các passive M1 khác đang hiểu.
              // Bộ đếm tích luỹ xuyên turn, giữ phần dư sau mỗi lần đủ 4.
              if (p.isM1 && SPEED_HASTE_WEAPONS.has(attacker.combatant.weaponName)) {
                attacker.combatant.speedHasteM1Count = (attacker.combatant.speedHasteM1Count ?? 0) + 1;
                const speedHasteGain = Math.floor(attacker.combatant.speedHasteM1Count / 4);
                if (speedHasteGain > 0) {
                  attacker.combatant.speedHasteM1Count -= speedHasteGain * 4;
                  attacker.combatant.haste = Math.min(20, (attacker.combatant.haste ?? 0) + speedHasteGain);
                  staminaNote += ` 🐎+${speedHasteGain} Haste (Speed — ${attacker.combatant.weaponName})`;
                }
              }
              // "Dieci Association": "Mỗi 20 Stamina tiêu thụ qua đòn đánh thường
              // sẽ áp 2 Sinking lên người kẻ địch và cho bạn 4 Shield HP" — cùng
              // pattern accumulator. BUG ĐÃ SỬA (thứ tự thực thi, cùng loại lỗi
              // với Liu Association): Sinking KHÔNG áp ở đây được vì dòng
              // "target.sinking = t.preview.finalSinking" (GHI ĐÈ, không cộng
              // dồn) chạy SAU trong vòng lặp chính — lưu dieciSinkingGain ra
              // biến ngoài scope, áp THẬT ở cuối hàm (sau vòng lặp target chính).
              if (p.isM1 && attacker.combatant.hasDieciAssociation) {
                attacker.combatant.dieciAssociationAccumulator = (attacker.combatant.dieciAssociationAccumulator ?? 0) + p.staminaCost;
                const dieciGainCount = Math.floor(attacker.combatant.dieciAssociationAccumulator / 20);
                if (dieciGainCount > 0) {
                  attacker.combatant.dieciAssociationAccumulator -= dieciGainCount * 20;
                  attacker.combatant.shieldHp = (attacker.combatant.shieldHp ?? 0) + dieciGainCount * 4;
                  dieciSinkingGain = dieciGainCount * 2;
                  staminaNote += ` 🛡️+${dieciGainCount * 4} Shield HP (Dieci Association)`;
                }
              }
              // "Dark Cloud" (Kurokumo Wakashu outfit, 6+ stack) — xác nhận
              // trực tiếp: "Mỗi 20 stamina tiêu thụ thông qua đánh thường sẽ
              // nổ dmg Bleed trên người kẻ địch" — "nổ" = kích hoạt Bleed gây
              // dmg NGAY (giống cơ chế Bleed thường khi tấn công), KHÔNG tiêu
              // count Bleed của target — cùng pattern accumulator với Dieci
              // Association ở trên (áp THẬT lên target ở cuối hàm).
              if (p.isM1 && attacker.combatant.equippedOutfit === "Kurokumo Wakashu" && (attacker.combatant.darkCloudOutfitStacks ?? 0) >= 6) {
                attacker.combatant.darkCloudOutfitStaminaAccumulator = (attacker.combatant.darkCloudOutfitStaminaAccumulator ?? 0) + p.staminaCost;
                const explodeCount = Math.floor(attacker.combatant.darkCloudOutfitStaminaAccumulator / 20);
                if (explodeCount > 0) {
                  attacker.combatant.darkCloudOutfitStaminaAccumulator -= explodeCount * 20;
                  darkCloudExplodeGain = explodeCount;
                }
              }
            }
            // Light/Sanity cost của Page (verify.lightCost/sanityCost, đã check ĐỦ
            // lúc declare trong resolveSkillVerification — xem comment đầy đủ ở đó,
            // bao gồm Tap Of The Light giảm 1 nửa Sanity Cost cho E.G.O Page) — trừ
            // THẬT ở đây, lúc confirm (cùng nguyên tắc với Stamina M1: reject không
            // làm mất resource oan). Áp dụng cho CẢ player lẫn enemy (enemy cũng có
            // currentLight/currentSanity, GM có thể dùng skill: cho enemy).
            let resourceNote = "";
            if (p.lightCost > 0) {
              attacker.combatant.currentLight = Math.max(0, attacker.combatant.currentLight - p.lightCost);
              resourceNote += ` (-${p.lightCost} <:Light:1513786082502770719>Light)`;
            }
            if (p.sanityCost > 0) {
              attacker.combatant.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, attacker.combatant.currentSanity - p.sanityCost);
              resourceNote += ` (-${p.sanityCost} Sanity)`;
              checkStaggerPanic(attacker.combatant);
            }
            staminaNote += resourceNote;

            const targetDmgLines = [];
            let totalHitsThisAction = 0; // tích luỹ TỔNG hit thật qua mọi target (AOE) trong action này — dùng cho Battle Ignition sau vòng lặp (xem dưới)
            // totalHitsThisActionAny — GAP ĐÃ SỬA (dự án tự động hoá, batch 4):
            // "The Imitation" (Upstanding Slash — 1 Critical, KHÔNG PHẢI M1) cần
            // đếm hit THẬT của CHÍNH Critical này — totalHitsThisAction ở trên chỉ
            // cộng dồn cho M1 (thiết kế có chủ ý cho Battle Ignition), không dùng
            // lại được — cần biến RIÊNG, cộng dồn KHÔNG điều kiện isM1Type.
            let totalHitsThisActionAny = 0;
            // anyHitLandedThisAction — BẮT BUỘC khai báo Ở ĐÂY (ngoài vòng lặp
            // target). `evadedCompletely` là `let` khai báo BÊN TRONG vòng lặp
            // nên KHÔNG đọc được ở khối commit phía sau vòng lặp — đọc bừa sẽ
            // ReferenceError lúc runtime mà `node --check` KHÔNG bắt được (đúng
            // loại lỗi scope đã dính nhiều lần, xem HANDOFF mục Sai Lầm).
            // Ý nghĩa: có ÍT NHẤT 1 target ăn đòn thật (không né/parry sạch).
            let anyHitLandedThisAction = false;
            // Eye Of Horus — tích luỹ riêng (KHÔNG gán trực tiếp attacker.combatant.
            // charge trong vòng lặp) — BUG ĐÃ SỬA: trước đây gán trực tiếp TRONG vòng
            // lặp targets, nhưng dòng "attacker.combatant.charge = firstPreview.
            // finalCharge" (SAU vòng lặp, xử lý Poise/Charge "trên bản thân" từ
            // dmgStr's tag +Charge nếu có) GÁN THẲNG (không cộng dồn) — GHI ĐÈ MẤT
            // HOÀN TOÀN +2 Charge Eye Of Horus vừa cộng mỗi lần đánh — verify bằng
            // test thật phát hiện Tremor tăng đúng nhưng Charge KHÔNG BAO GIỜ tăng dù
            // logic bên trong đúng. Giờ tích luỹ riêng, CỘNG THÊM (không ghi đè) SAU
            // dòng gán finalCharge — xem chỗ dùng biến này bên dưới.
            let eyeOfHorusChargeGainedThisAction = 0;
            const burnBeforeMap = {}; // GAP ĐÃ SỬA — Liu Association cần biết burn
            // TRƯỚC toàn bộ hit, nhưng phải so sánh SAU cả M1-count block (fire_burn
            // chạy SAU khi vòng for (const t of p.targets) đã đóng) — dùng map ngoài
            // scope thay vì biến local burnBeforeHit (đã ra khỏi scope tại đó).
            for (const t of p.targets) {
              const targetResolved = resolveCombatant(encounter, t.targetId);
              if (!targetResolved) { targetDmgLines.push(`⚠️ target ${t.targetId} không còn tồn tại`); continue; }
              const target = targetResolved.combatant;
              const hadRuptureBeforeHit = target.rupture > 0; // Defenseless cần biết TRƯỚC khi finalRupture ghi đè
              const bleedBeforeHit = target.bleed;
              // Providence of the Prescript cần biết Sinking/Rupture TRƯỚC đòn
              // để biết đòn này có THỰC SỰ gây thêm hay không (đã đầy trần thì
              // không tính là "gây ra").
              const sinkingBeforeHit = target.sinking ?? 0;
              const ruptureBeforeHit = target.rupture ?? 0; // Craving Synergy/Thirst/Break the Dams cần biết TRƯỚC khi finalBleed ghi đè
              burnBeforeMap[t.targetId] = target.burn ?? 0;
              let finalDmg = t.preview.totalDmg;
              // Borrowed Eyes: dice CHỈ để đếm charge né, KHÔNG gây dmg.
              if (p.skillKey === "borrowed eyes") finalDmg = 0;
              // [Unbreakable Dice] (Furioso rework) — người phòng thủ THẮNG clash
              // nhưng đòn có tag này thì KHÔNG bị huỷ, chỉ còn 50% dmg gốc. Cờ do
              // interaction-handlers.js đặt lúc xử lý clash thắng (thay vì cộng
              // evadeCharges như đòn thường).
              // "Prescript Delivered on a Device" — vào Unlock III thì MỌI Dice
              // thành Unbreakable Dice: thua clash vẫn gây 50% dmg gốc.
              const unlockIIIUnbreakable = attacker.combatant?.hasPrescriptDevice
                && (attacker.combatant?.prescriptUnlockLevel ?? 0) >= 3;
              if (p.unbreakableDiceHalved || (unlockIIIUnbreakable && p.clashLost)) finalDmg *= 0.5;
              let defenseNote = "";
              let evadedCompletely = false;
              // renegadeLandedHits — số hit THẬT SỰ DÍNH (không bị Evade/Parry).
              // Guard KHÔNG tính là trượt: hit bị Guard vẫn vào, chỉ giảm dmg —
              // đúng như ảnh Fragaria gửi (Guard giảm 99% nhưng dmg vẫn áp).
              // Khai ở ĐÂY (scope vòng lặp target) chứ không trong khối phòng thủ:
              // `hitEvadedOrParried` nằm trong khối lồng, đọc từ ngoài là
              // ReferenceError — đúng lớp lỗi scope đã dính nhiều lần (HANDOFF).
              // null = chưa qua khối phòng thủ ⇒ coi như dính hết.
              let renegadeLandedHits = null;
              // Guard/Evade/Parry — TIÊU THỤ charge SỐNG (đọc trực tiếp target lúc xử
              // lý action này trong batch, KHÔNG dùng giá trị tính sẵn lúc declare).
              // QUAN TRỌNG: 1 charge chặn được SỐ HIT theo vũ khí BÊN TẤN CÔNG — CHỈ
              // áp dụng tỉ lệ này cho đòn ĐÁNH THƯỜNG (M1) — gồm CẢ player tự attack
              // (kind "attack") VÀ GM dùng enemyattack KHÔNG kèm skill: (coi là M1 của
              // enemy, vì enemyattack không tự phân biệt M1 hay skill — chỉ biết chắc
              // là skill khi có verify.skillKey). Còn lại (Page/skill) coi 1 charge =
              // chặn cả action. Thứ tự ưu tiên: Evade (an toàn nhất) → Parry (free
              // nhưng rủi ro) → Guard (giảm 90%, không rủi ro).
              // ĐIỀU CHỈNH LẠI (xác nhận trực tiếp — sửa lại nhận định trước đó
              // về "chỉ tốn 20 stamina né được toàn bộ 3 hit"): WEAPON_DEFENSE_HITS
              // (light=4/medium=2/heavy=1 hit/charge cho M1) KHÔI PHỤC LẠI đúng
              // như thiết kế gốc — chỉ SKILL mới cần strict 1 charge/hit (Blade
              // Flourish 3-hit vẫn cần 3 charge), M1 thường (Rat 2-hit light) vẫn
              // đúng 1 charge chặn hết theo vũ khí. NGOẠI LỆ Eye Of Horus: dù
              // heavy (1 hit/charge thường), nhưng bắn theo "volley" 9-hit — 1
              // charge chặn HẾT 1 volley (9 hit), không phải 1/9.
              const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
              const attackerWeapon = attacker.combatant.weaponWeight ?? "medium";
              const hitsPerCharge = p.isEyeOfHorusFixedBurst ? 9 : (isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeapon] ?? 1) : 1);
              // ── BLIND (Wedjat) — GAP ĐÃ SỬA, trước đây chỉ là chữ ────────
              // "Blind: khiến đòn ĐÁNH THƯỜNG tiếp theo bị trượt". Tiêu 1 stack,
              // ép cả đòn M1 trượt sạch. CHỈ M1 — Page/Critical không dính.
              // Đặt TRƯỚC mọi tính toán dmg để không tốn công tính rồi vứt.
              let blindNote = "";
              if (isM1Type && (attacker.combatant.blind ?? 0) > 0) {
                attacker.combatant.blind -= 1;
                blindNote = ` 🌑[**Blind** — đòn đánh thường TRƯỢT (còn ${attacker.combatant.blind} Blind)]`;
                finalDmg = 0;
                // evadedCompletely = "không trúng gì" ⇒ Bleed/Burn/Rupture… cũng
                // KHÔNG áp. Trượt mà vẫn dính status thì không phải là trượt.
                evadedCompletely = true;
              }
              // Sắc lệnh (The Index Oracle's Proxy) — ghi lại ĐÃ TẤN CÔNG và
              // TYPE vũ khí đã dùng. Sắc lệnh 5/6/7 đòi đúng type Blunt/Pierce/Slash.
              if (attacker.combatant) {
                attacker.combatant.prescriptAttacked = true;
                // ❗ BUG ĐÃ SỬA (Fragaria: "sắc lệnh yêu cầu đánh ra dmg Slash mà
                // xài Dice Blunt/Pierce vẫn được pass").
                // GỐC: lấy `weaponType` — với Caduceus đó là type của MẶT CUỐI
                // vừa roll, không phải type THẬT SỰ đã gây ra. Một đòn Caduceus
                // có thể trộn cả 3 type.
                // ⇒ Đọc TỪ dmgStr đã roll: mỗi hạng `<số><B|P|S>` là một type thật.
                attacker.combatant.prescriptAttackTypes = attacker.combatant.prescriptAttackTypes ?? {};
                const TYPE_OF = { B: "Blunt", P: "Pierce", S: "Slash" };
                let markedAny = false;
                for (const term of String(p.dmgStr ?? "").split("+")) {
                  const m = term.trim().match(/^\d+(?:\.\d+)?\s*x?\d*\s*([BPS])/);
                  if (m) { attacker.combatant.prescriptAttackTypes[TYPE_OF[m[1]]] = true; markedAny = true; }
                }
                // dmgStr không đọc được (skill thuần buff…) thì mới rơi về weaponType.
                if (!markedAny && attacker.combatant.weaponType) {
                  attacker.combatant.prescriptAttackTypes[attacker.combatant.weaponType] = true;
                }
              }
              const hitCount = Math.max(1, t.preview.dmgValues?.length ?? 1);
              if (isM1Type) totalHitsThisAction += hitCount; // chỉ M1 mới tính cho Battle Ignition (Page/skill không tính, đúng comment dưới)
              totalHitsThisActionAny += hitCount;
              // bypass — đọc từ defenseBypass đã lưu lúc declare (tự phát hiện từ
              // [Undodgeable]/[Unblockable]/[Guard Break]/[Unparriable] trong text
              // skill roll thật, gộp với tags: gõ tay nếu có) — loại đúng phòng thủ
              // KHÔNG cản được đòn này, áp dụng CẢ cho M1-mix lẫn Page/skill 1-charge.
              const bypass = p.defenseBypass ?? { blockEvade: false, blockGuard: false, blockParry: false };
              // Airborne (xác nhận trực tiếp): "biến mất... sau bị dính đòn có
              // condition Airborne" — tắt NGAY (không đợi end turn) nếu đòn này có
              // tag [Airborne] VÀ target đang airborne=true. Đặt SỚM (không phụ
              // thuộc finalDmg/evadedCompletely) vì đây là hiệu ứng của TAG, không
              // phải sát thương — nên xảy ra dù đòn có né/chặn hay không.
              if (bypass.airborneCondition && target.airborne) {
                target.airborne = false;
              }
              // Iron Horus (Abydos's Uniform - Lazy Style): Guard giảm 100% dmg
              // (TOÀN BỘ đòn) — ưu tiên CAO NHẤT, ghi đè cả Fortified Resolve (99%)
              // nếu có cả 2, vì "giảm TOÀN BỘ đòn" là mức tối đa tuyệt đối — Defense
              // Up/Down (50-Status) KHÔNG ảnh hưởng nhánh Iron Horus (không thể vượt
              // 100%), CHỈ cộng vào 2 nhánh còn lại, cap tối đa 1 (100%).
              // BUG ĐÃ SỬA (xác nhận trực tiếp, kèm log thật cho thấy nhân vật có
              // CẢ Iron Horus lẫn Fortified Resolve cùng lúc — Guard tốn đúng 40
              // Sta của Iron Horus, nhưng hiện "giảm 100%" thay vì đúng 99% của
              // Fortified Resolve): "đáng lẽ nó chỉ có giảm 99% thôi, tức là vẫn
              // phải nhận tí sát thương" — trước đây hasIronHorus được check TRƯỚC
              // (ưu tiên tuyệt đối 100%), HOÀN TOÀN bỏ qua Fortified Resolve nếu có
              // cả 2 — SAI theo xác nhận mới. Đổi thứ tự: Fortified Resolve (nếu
              // có) LUÔN cap ở 99%, BẤT KỂ có Iron Horus hay không — cơ chế RIÊNG
              // của Iron Horus (chặn TOÀN BỘ hit trong turn, charge KHÔNG tụt) VẪN
              // giữ nguyên (gate ở target.hasIronHorus bên dưới, không đổi), chỉ
              // % dmg giảm thay đổi khi có cả 2.
              // BUG ĐÃ SỬA (hiểu sai HOÀN TOÀN từ đầu, xác nhận trực tiếp kèm
              // nguyên văn passive card): "Iron Horus: Block tốn 40 stamina NHƯNG
              // giảm sát thương TOÀN BỘ ĐÒN" — "toàn bộ đòn" ở đây nói về PHẠM VI
              // (chặn được HẾT các hit trong đòn M1/action đó, nhờ charge KHÔNG
              // TỤT và kéo dài cả turn), KHÔNG PHẢI mức độ giảm dmg. Iron Horus
              // KHÔNG đổi % giảm dmg từ 90% mặc định lên 100% — vẫn CHỈ 90% như
              // Guard thường (hoặc 99% nếu có Fortified Resolve, không liên quan
              // gì tới Iron Horus). Toàn bộ hiệu ứng ĐẶC BIỆT của Iron Horus chỉ
              // là: (1) cost 40 Sta thay vì 10, (2) 1 charge chặn được MỌI hit
              // trong SUỐT turn đó (không giới hạn theo weaponWeight, không tự
              // tụt) — cả 2 phần này đã đúng sẵn ở nơi khác (performGuardEvade's
              // cost, và nhánh "while(hitIdx<totalHits)" bên dưới), CHỈ RIÊNG dòng
              // này (% giảm dmg) là sai, đã xoá hẳn nhánh hasIronHorus khỏi đây.
              const baseGuardPct = hasPerk(target, "Fortified Resolve") ? 0.99 : 0.9;
              // Iron Horus KHÔNG còn đặc biệt gì về % nữa (xem comment đầy đủ ở
              // baseGuardPct ngay trên) — Defense Up/Down áp dụng BÌNH THƯỜNG dù
              // có Iron Horus hay không, giống mọi combatant khác.
              const defenseUpDownPct = ((target.defenseUp ?? 0) * 1 - (target.defenseDown ?? 0) * 5) / 100;
              const guardReductionPct_base = Math.min(1, Math.max(0, baseGuardPct + defenseUpDownPct));
              // "Blade Lineage" (outfit) — GAP MỚI (xác nhận trực tiếp): "Nếu
              // người dùng có trên hoặc bằng 10 Poise, đòn đánh thường của bạn
              // sẽ bỏ qua 50% giảm dmg của block" — kiểm tra ATTACKER (người
              // đang tấn công, KHÔNG PHẢI target đang Guard) có Poise>=10.
              const guardReductionPct = (attacker.combatant.equippedOutfit === "Blade Lineage" && (attacker.combatant.poise ?? 0) >= 10)
                ? guardReductionPct_base * 0.5
                : guardReductionPct_base;
              // GAP ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp thật: "hệ thống tùy
              // chọn né theo từng hit... nhận hit 1 và 2 nhưng né/guard hit 3")
              // — TRƯỚC ĐÂY chỉ M1 mới có logic per-hit (cho phép trộn nhiều loại
              // phòng thủ + chọn hit cụ thể qua guardHitSelections), skill dùng
              // nhánh "fraction" đơn giản hơn (không chọn được hit nào). Giờ CẢ
              // 2 dùng CHUNG 1 logic per-hit — nhất quán, hỗ trợ chọn hit cụ thể
              // cho MỌI loại đòn (M1 hay skill).
              // perHitMultForBulletEffect — khai báo Ở TOP-LEVEL hàm (xem đầu
              // hàm resolveOnePendingAction), KHÔNG PHẢI ở đây — nếu không, dù
              // "xuất" ra khỏi khối {} bên dưới thì vẫn chỉ tồn tại trong PHẠM
              // VI vòng for (const t of p.targets) này, không tới được các
              // đoạn code NẰM NGOÀI vòng for đó (VD Blade Lineage keypage 1).
              {
                // M1 NHIỀU HIT — cho phép TRỘN nhiều LOẠI phòng thủ khác nhau để chặn
                // các CỤM hit khác nhau trong CÙNG 1 đòn M1 (xác nhận trực tiếp từ GM:
                // "có thể guard/parry/evade theo tùy thích vào số hit" — KHÔNG bắt
                // buộc chỉ 1 loại cho cả đòn như code cũ). Thứ tự ưu tiên xử lý từng
                // CỤM hit kế tiếp: Evade (free, an toàn nhất) → Parry (free nhưng rủi
                // ro ăn full nếu hụt) → Guard (chắc chắn giảm % nhưng không free) —
                // mỗi loại tiêu thụ HẾT charge/roll đang có rồi mới chuyển loại kế,
                // cho tới khi hết hit cần chặn hoặc hết toàn bộ charge các loại. Loại
                // nào bị bypass (tag Undodgeable/Unblockable/Guard Break/Unparriable)
                // thì SKIP hoàn toàn, không tiêu charge của loại đó cho đòn này.
                const instanceResults = t.preview.instanceResults ?? [];
                const totalHits = instanceResults.length || hitCount;
                const perHitMult = new Array(totalHits).fill(1);
                // [Unfocused Volley] — target này CHỈ ăn đúng những dice được
                // phân về cho họ (index.js phân bổ lúc tạo pendingAction). Các
                // dice khác thuộc về địch khác nên tắt hoàn toàn (mult 0) để
                // không bị tính trùng cho mọi target.
                if (Array.isArray(t.volleyHitIndices)) {
                  const mine = new Set(t.volleyHitIndices);
                  for (let i = 0; i < totalHits; i++) if (!mine.has(i)) perHitMult[i] = 0;
                }
                const hitEvadedOrParried = new Array(totalHits).fill(false);
                let hitIdx = 0;
                const noteParts = [];

                // Task yêu cầu trực tiếp: "sau khi né/guard m1 light 2 hit thì còn
                // 0,5 charge guard/evade lần sau bấm để né 2 hit light thì không
                // tiêu sta" — tiêu thụ banked hits (dư từ lần TRƯỚC, MIỄN PHÍ hoàn
                // toàn — không trừ Stamina/charge gì cả) TRƯỚC KHI vào các nhánh
                // Evade/Guard bằng charge/Stamina bình thường bên dưới. Track riêng
                // hitsCoveredByBank để tính lại phần dư MỚI sau khi resolve xong
                // (không lẫn với phần charge MỚI mua — xem cuối khối Guard/Evade).
                let evadeHitsCoveredByBank = 0;
                if (!(t.perHitBypass?.[hitIdx] ?? bypass).blockEvade && (target.bankedEvadeHits ?? 0) > 0 && hitIdx < totalHits) {
                  const coverStart = hitIdx;
                  while ((target.bankedEvadeHits ?? 0) > 0 && hitIdx < totalHits && !(t.perHitBypass?.[hitIdx] ?? bypass).blockEvade) {
                    target.bankedEvadeHits -= 1;
                    perHitMult[hitIdx] = 0; hitEvadedOrParried[hitIdx] = true;
                    hitIdx++; evadeHitsCoveredByBank++;
                  }
                  if (evadeHitsCoveredByBank > 0) noteParts.push(`💨**Evade (dư charge từ trước, miễn phí)** — né hit ${coverStart + 1}-${hitIdx}`);
                }

                let evadeChargesConsumedThisCall = 0;
                if (!(t.perHitBypass?.[hitIdx] ?? bypass).blockEvade && (target.evadeCharges ?? 0) > 0 && ((target.evadeHitSelections ?? []).length > 0 || hitIdx < totalHits)) {
                  const coverStart = hitIdx;
                  let used = 0;
                  if ((target.evadeHitSelections ?? []).length > 0) {
                    // GAP ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp thật: "hit tôi có
                    // thể chọn nhận hit 1 và 2 nhưng né/guard hit 3") — đối xứng với
                    // guardHitSelections đã có sẵn — Evade giờ cũng hỗ trợ chọn ĐÚNG
                    // hit index cụ thể, không chỉ che tuần tự từ hitIdx hiện tại.
                    const validSelected = target.evadeHitSelections.filter(h => h >= 1 && h <= totalHits);
                    for (const h of validSelected) { perHitMult[h - 1] = 0; hitEvadedOrParried[h - 1] = true; }
                    used = Math.min(target.evadeCharges, Math.ceil(validSelected.length / hitsPerCharge));
                    target.evadeCharges -= used;
                    evadeChargesConsumedThisCall += used;
                    target.evadeHitSelections = target.evadeHitSelections.filter(h => !(h >= 1 && h <= totalHits));
                    hitIdx = Math.max(hitIdx, ...validSelected, 0);
                    noteParts.push(`💨**Evade** (${used} charge — né hit ${validSelected.join(", ")})${applyEvadeSuccessPerks(target, attacker.combatant)}`);
                  } else {
                    while (target.evadeCharges > 0 && hitIdx < totalHits) {
                      target.evadeCharges -= 1; used += 1; evadeChargesConsumedThisCall += 1;
                      for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) { perHitMult[hitIdx] = 0; hitEvadedOrParried[hitIdx] = true; }
                    }
                    noteParts.push(`💨**Evade** (${used} charge — né hit ${coverStart + 1}-${hitIdx})${applyEvadeSuccessPerks(target, attacker.combatant)}`);
                  }
                  // Cùng cơ chế banked-leftover với Guard ở dưới — xem comment đầy
                  // đủ ở khối Guard.
                  const capacityFromNewEvadeCharges = evadeChargesConsumedThisCall * hitsPerCharge;
                  const totalEvadedThisCall = hitEvadedOrParried.filter(Boolean).length;
                  const hitsCoveredByNewEvadeCharges = Math.max(0, totalEvadedThisCall - evadeHitsCoveredByBank);
                  const leftoverEvade = Math.max(0, capacityFromNewEvadeCharges - hitsCoveredByNewEvadeCharges);
                  if (leftoverEvade > 0) target.bankedEvadeHits = (target.bankedEvadeHits ?? 0) + leftoverEvade;
                }
                if (!(t.perHitBypass?.[hitIdx] ?? bypass).blockParry && (target.parryHitSelections ?? []).length > 0) {
                  // GAP ĐÃ SỬA (đối xứng với evadeHitSelections/guardHitSelections
                  // — xác nhận trực tiếp: "hit 1 né, hit 2 guard, hit 3 né/parry")
                  // — parryRolls[i] ứng ĐÚNG với parryHitSelections[i] (cùng thứ tự
                  // đẩy vào lúc chọn từng hit).
                  const validSelected = target.parryHitSelections.filter(h => h >= 1 && h <= totalHits);
                  // BUG LUẬT ĐÃ SỬA (Fragaria xác nhận trực tiếp: "1 charge parry
                  // vẫn hoạt động như evade và guard là chặn được 1 group hit m1").
                  //
                  // TRƯỚC ĐÂY vòng lặp `for (const h of validSelected)` shift MỘT
                  // roll cho MỖI HIT. Nhưng số roll đẩy vào lúc chọn chỉ là
                  // `opts.chargesNeeded` = ceil(hitsTrongNhóm / hitsPerCharge) —
                  // với M1 Light (4 hit/charge) là ĐÚNG 1 roll cho 4 hit. Hệ quả:
                  // roll hết sau hit ĐẦU TIÊN, `break`, và 3 hit còn lại của nhóm
                  // ăn FULL mà KHÔNG có lần thử Parry nào. Người chơi trả đủ giá
                  // cho 1 charge nhưng chỉ được bảo vệ 1/4 nhóm, và không có cách
                  // nào biết. Guard/Evade thì 1 charge phủ TRỌN nhóm (xem 2 nhánh
                  // ngay trên/dưới) — Parry lệch hẳn khỏi 2 anh em.
                  //
                  // SỬA: chia validSelected thành từng CỤM `hitsPerCharge` hit,
                  // MỘT roll quyết định cho CẢ CỤM — khớp đúng cách roll được sinh
                  // ra (1 roll/charge) và đúng luật Fragaria vừa chốt.
                  // Cụm CUỐI có thể ngắn hơn (nhóm cuối của đòn ít hit hơn) —
                  // chunk theo thứ tự đã push nên vẫn khớp 1-1 với roll.
                  for (let ci = 0; ci < validSelected.length; ci += hitsPerCharge) {
                    // ❗ BUG ĐÃ SỬA (Fragaria kèm ảnh: "player spam nhiều parry liên
                    // tục, bị STAGGER GIỮA CHỪNG rồi VẪN ĐƯỢC TÍNH PARRY").
                    // Đã Stagger thì mất quyền hành động ⇒ huỷ toàn bộ lượt Parry
                    // còn lại, các hit sau ăn full (và ăn Res 2x theo per-hit).
                    if (target.staggered) {
                      if ((target.parryRolls ?? []).length > 0) {
                        noteParts.push(`⭐**STAGGER** — huỷ **${target.parryRolls.length}** lượt Parry còn lại`);
                        target.parryRolls = [];
                      }
                      break;
                    }
                    const chunk = validSelected.slice(ci, ci + hitsPerCharge);
                    const defRoll = target.parryRolls.shift();
                    if (defRoll === undefined) break;
                    const atkRoll = 1 + Math.floor(Math.random() * 20);
                    const won = defRoll >= atkRoll;
                    const hitLabel = chunk.length > 1 ? `hit ${chunk[0]}-${chunk[chunk.length - 1]}` : `hit ${chunk[0]}`;
                    if (won) {
                      for (const h of chunk) { perHitMult[h - 1] = 0; hitEvadedOrParried[h - 1] = true; }
                      // applyParrySuccessPerks gọi MỘT lần cho cả cụm: đây là MỘT
                      // hành động Parry (1 charge, 1 roll), không phải N lần thành
                      // công — gọi mỗi hit sẽ nhân hiệu ứng perk lên gấp bội.
                      noteParts.push(`🗡️**Parry THÀNH CÔNG** (${defRoll} vs ${atkRoll} — né ${hitLabel})${applyParrySuccessPerks(target, attacker.combatant)}`);
                    } else {
                      const baseFailCost = hasPerk(target, "Mastered Breaths") ? 30 : 40;
                      const failCost = (target.injuries ?? []).includes("Gãy tay") ? baseFailCost * 2 : baseFailCost;
                      target.currentStamina = Math.max(0, target.currentStamina - failCost);
                      noteParts.push(`🗡️**Parry THẤT BẠI** (${defRoll} vs ${atkRoll}, -${failCost} Sta — ăn full ${hitLabel})`);
                      // ❗ Fragaria: "trường hợp bình thường thì nếu họ fail parry
                      // thì họ sẽ STAGGER GIỮA CHỪNG rồi". Trước đây chỉ trừ Stamina
                      // rồi đi tiếp — Stagger mãi tới cuối đòn mới được chấm, nên
                      // các nhóm parry sau vẫn resolve như chưa có gì.
                      // Chấm NGAY: người thường sẽ Stagger từ đây, các hit còn lại
                      // ăn Res 2x (per-hit đã xử lý) và không parry tiếp được.
                      checkStaggerPanic(target);
                      if (target.staggered) noteParts.push(`⭐**STAGGER giữa chuỗi** — các hit còn lại chịu Res 2x`);
                    }
                  }
                  target.parryHitSelections = target.parryHitSelections.filter(h => !(h >= 1 && h <= totalHits));
                  hitIdx = Math.max(hitIdx, ...validSelected, 0);
                // ❗ BUG ĐÃ SỬA (Fragaria, kèm ảnh: "player spam nhiều parry liên
                // tục, bị STAGGER GIỮA CHỪNG rồi VẪN ĐƯỢC TÍNH PARRY").
                // Thêm `!target.staggered`: đã Stagger thì KHÔNG parry tiếp được —
                // các nhóm còn lại ăn full (và ăn Res 2x theo per-hit).
                } else while (!target.staggered && !(t.perHitBypass?.[hitIdx] ?? bypass).blockParry && (target.parryRolls ?? []).length > 0 && hitIdx < totalHits) {
                  const defRoll = target.parryRolls.shift();
                  const atkRoll = 1 + Math.floor(Math.random() * 20);
                  const won = defRoll >= atkRoll;
                  const coverStart = hitIdx;
                  for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) {
                    if (won) { perHitMult[hitIdx] = 0; hitEvadedOrParried[hitIdx] = true; }
                  }
                  if (won) {
                    noteParts.push(`🗡️**Parry THÀNH CÔNG** (${defRoll} vs ${atkRoll} — né hit ${coverStart + 1}-${hitIdx})${applyParrySuccessPerks(target, attacker.combatant)}`);
                  } else {
                    // Mastered Breaths (Sloth, [15 Points]): base cost 30 thay vì 40.
                    // Gãy tay (chấn thương) vẫn NHÂN ĐÔI bất kể base là bao nhiêu.
                    const baseFailCost = hasPerk(target, "Mastered Breaths") ? 30 : 40;
                    const failCost = (target.injuries ?? []).includes("Gãy tay") ? baseFailCost * 2 : baseFailCost;
                    target.currentStamina = Math.max(0, target.currentStamina - failCost);
                    noteParts.push(`🗡️**Parry THẤT BẠI** (${defRoll} vs ${atkRoll}, -${failCost} Sta — ăn full hit ${coverStart + 1}-${hitIdx})`);
                    checkStaggerPanic(target);
                    if (target.staggered) noteParts.push(`⭐**STAGGER giữa chuỗi** — các hit còn lại chịu Res 2x`);
                  }
                }
                const canAttemptGuard = (target.guardHitSelections ?? []).length > 0
                  ? target.guardHitSelections.some(h => !(t.perHitBypass?.[h - 1] ?? bypass).blockGuard)
                  : !(t.perHitBypass?.[hitIdx] ?? bypass).blockGuard;
                // Cùng cơ chế banked hits với Evade ở trên — MIỄN PHÍ, tiêu thụ
                // TRƯỚC khi vào nhánh Guard bằng charge/Stamina bình thường.
                let guardHitsCoveredByBank = 0;
                if (canAttemptGuard && (target.bankedGuardHits ?? 0) > 0 && hitIdx < totalHits && !target.hasIronHorus) {
                  const coverStart = hitIdx;
                  while ((target.bankedGuardHits ?? 0) > 0 && hitIdx < totalHits && !(t.perHitBypass?.[hitIdx] ?? bypass).blockGuard) {
                    target.bankedGuardHits -= 1;
                    perHitMult[hitIdx] = 1 - guardReductionPct;
                    hitIdx++; guardHitsCoveredByBank++;
                  }
                  if (guardHitsCoveredByBank > 0) noteParts.push(`🛡️**Guard (dư charge từ trước, miễn phí)** — giảm ${Math.round(guardReductionPct * 100)}% hit ${coverStart + 1}-${hitIdx}`);
                }
                if (canAttemptGuard && (target.guardCharges ?? 0) > 0 && ((target.guardHitSelections ?? []).length > 0 || hitIdx < totalHits)) {
                  const coverStart = hitIdx;
                  let guardedHitIndices = []; // GAP ĐÃ SỬA — track ĐÚNG index (0-based) các hit ĐÃ thực sự được Guard trong nhánh này, để kiểm tra guardBreak cho ĐÚNG hit (không phải coverStart cố định, sai khi dùng guardHitSelections không tuần tự).
                  let guardChargesConsumedThisCall = 0;
                  // Iron Horus (Abydos's Uniform passive) — BUG ĐÃ SỬA (xác nhận
                  // trực tiếp từ GM, đang gây ăn dmg thật trên production): "1 lần
                  // guard tốn 40 Sta nhưng CẢ TURN sẽ guard TOÀN BỘ đòn, 1 charge
                  // KHÔNG BAO GIỜ tụt" — KHÁC HẲN cơ chế mặc định (charge chặn giới
                  // hạn N hit theo weaponWeight rồi tự trừ hết). Với Iron Horus: che
                  // TOÀN BỘ hit còn lại trong hit-group này, KHÔNG trừ guardCharges gì
                  // cả (giữ nguyên charge, tiếp tục che các đòn KHÁC trong CÙNG turn
                  // cho tới khi turn kết thúc — xem advanceCombatantTurn nơi charge
                  // mới thực sự reset).
                  if (target.hasIronHorus) {
                    while (hitIdx < totalHits) { perHitMult[hitIdx] = 1 - guardReductionPct; guardedHitIndices.push(hitIdx); hitIdx++; }
                    noteParts.push(`🛡️**Guard (Iron Horus — chặn TOÀN BỘ, charge không tụt)** (giảm ${Math.round(guardReductionPct * 100)}% — hit ${coverStart + 1}-${hitIdx})`);
                  } else if ((target.guardHitSelections ?? []).length > 0) {
                    // GAP ĐÃ SỬA (xác nhận trực tiếp): "Guard không tùy chọn được
                    // guard đòn nào — chỉ có thể tuần tự 1 2 3 4 5, trong khi chơi
                    // thủ công có thể chọn tùy thích (VD guard đòn 3 và 5)" — NẾU
                    // player đã gọi "guard hits: X,Y" trước đó (lưu sẵn trong
                    // guardHitSelections), dùng ĐÚNG các hit index đó thay vì che
                    // tuần tự từ hitIdx hiện tại. Chỉ lấy các index HỢP LỆ nằm
                    // trong phạm vi đòn này (1..totalHits) — số dư (nếu chỉ định
                    // hit vượt quá totalHits của đòn thực tế) giữ lại cho đòn sau.
                    const validSelected = target.guardHitSelections.filter(h => h >= 1 && h <= totalHits);
                    for (const h of validSelected) { perHitMult[h - 1] = 1 - guardReductionPct; guardedHitIndices.push(h - 1); }
                    const chargesUsed = Math.min(target.guardCharges, Math.ceil(validSelected.length / hitsPerCharge));
                    target.guardCharges = Math.max(0, target.guardCharges - chargesUsed);
                    guardChargesConsumedThisCall += chargesUsed;
                    target.guardHitSelections = target.guardHitSelections.filter(h => !(h >= 1 && h <= totalHits));
                    hitIdx = totalHits; // đã xử lý xong khối Guard này (dù không tuần tự) — không loại khác che tiếp lên các hit CHƯA được chỉ định
                    noteParts.push(`🛡️**Guard (chọn riêng)** (${chargesUsed} charge, giảm ${Math.round(guardReductionPct * 100)}% — hit ${validSelected.join(",")})`);
                  } else {
                    let used = 0;
                    while (target.guardCharges > 0 && hitIdx < totalHits) {
                      target.guardCharges -= 1; used += 1; guardChargesConsumedThisCall += 1;
                      for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) { perHitMult[hitIdx] = 1 - guardReductionPct; guardedHitIndices.push(hitIdx); }
                    }
                    noteParts.push(`🛡️**Guard** (${used} charge, giảm ${Math.round(guardReductionPct * 100)}% — hit ${coverStart + 1}-${hitIdx})`);
                  }
                  // Guard Break: Guard VẪN cản được (đã giảm dmg ở trên), nhưng bên
                  // Guard bị Stagger NGAY (không đợi Stamina về 0) — xác nhận trực
                  // tiếp từ GM, KHÁC hẳn Unblockable (vốn làm Guard không cản được).
                  if (guardedHitIndices.some(idx => (t.perHitBypass?.[idx] ?? bypass).guardBreak)) {
                    // "Zwei Association": "Nếu bạn có trên hoặc bằng 10 Defense
                    // Up và khi đỡ đòn Guard Break, bạn sẽ tiêu thụ hết chúng và
                    // sẽ không bị Guard Break". Phần "Undodgeable tương tự" KHÔNG
                    // tự động hoá — cần thiết kế lại cơ chế bypass evade phức tạp
                    // hơn nhiều (đã dùng perHitMult tính sẵn từ trước), rủi ro cao
                    // nếu làm sai — để GM tự áp dụng phần đó bằng tay.
                    if (target.hasZweiAssociation && (target.defenseUp ?? 0) >= 10) {
                      target.defenseUp = 0;
                      noteParts.push(`🛡️**Zwei Association** — tiêu hết Defense Up, KHÔNG bị Guard Break`);
                    } else {
                      forceStagger(target);
                      noteParts.push(`💥**Guard Break** — bị Stagger ngay (Res 2x từ giờ)`);
                      // ❗ LỖ HỔNG ĐÃ VÁ (Fragaria: "do Wound-Casing Mask cho miễn
                      // nhiễm Stagger nên có thể THOẢI MÁI GUARD đòn Guard Break mà
                      // không bị tác hại gì").
                      // Guard Break trừng phạt bằng Stagger; ai miễn nhiễm Stagger
                      // thì hình phạt biến mất hoàn toàn ⇒ guard vô tư.
                      // Chốt: miễn nhiễm Stagger mà ăn Guard Break thì **mất SẠCH
                      // Stamina** — vẫn là hình phạt thật, vẫn không bị Stagger.
                      if (!target.staggered) {
                        const lostAll = target.currentStamina ?? 0;
                        target.currentStamina = 0;
                        noteParts.push(`⚡**Miễn nhiễm Stagger** — không bị Stagger nhưng **mất sạch ${Math.round(lostAll)} Stamina** vì ăn Guard Break`);
                      }
                    }
                  }
                  // Task yêu cầu trực tiếp: tính lại banked hits MỚI cho lần sau —
                  // capacity từ charge MỚI mua turn này (guardChargesConsumedThisCall
                  // * hitsPerCharge) trừ đi số hit ĐÃ DÙNG bởi charge MỚI (KHÔNG tính
                  // phần đã dùng từ bank cũ — guardHitsCoveredByBank riêng) = phần dư
                  // MỚI, CỘNG DỒN vào bankedGuardHits (đã tự trừ đúng phần tiêu thụ ở
                  // bước banked-consumption phía trên rồi, không ghi đè mất). BỎ QUA
                  // Iron Horus — charge của nó không bao giờ tụt nên không có khái
                  // niệm "dư" theo nghĩa thường.
                  if (!target.hasIronHorus) {
                    const capacityFromNewGuardCharges = guardChargesConsumedThisCall * hitsPerCharge;
                    const hitsCoveredByNewGuardCharges = Math.max(0, guardedHitIndices.length - guardHitsCoveredByBank);
                    const leftoverGuard = Math.max(0, capacityFromNewGuardCharges - hitsCoveredByNewGuardCharges);
                    if (leftoverGuard > 0) target.bankedGuardHits = (target.bankedGuardHits ?? 0) + leftoverGuard;
                  }
                }

                if (instanceResults.length > 0) {
                  finalDmg = instanceResults.reduce((sum, r, i) => sum + (r.instanceDmg ?? 0) * perHitMult[i], 0);
                } else {
                  // fallback hiếm gặp (không có instanceResults chi tiết) — coi như đều
                  // (giữ hành vi gần đúng cũ, KHÔNG nên xảy ra trong thực tế vì M1 luôn
                  // có instanceResults).
                  const avgMult = perHitMult.reduce((s, m) => s + m, 0) / totalHits;
                  finalDmg *= avgMult;
                }
                // Task yêu cầu trực tiếp (xác nhận lại, đảm bảo đúng ngữ nghĩa
                // rõ ràng thay vì suy luận gián tiếp): "parry thành công cũng
                // tính là không trúng như né" — evadedCompletely giờ dùng TRỰC
                // TIẾP hitEvadedOrParried (field CHUYÊN DỤNG, set bởi CẢ Evade
                // LẪN Parry thành công, KHÔNG BAO GIỜ bởi Guard — xem chỗ khai
                // báo) thay vì suy luận gián tiếp qua perHitMult===0 (dù về mặt
                // số học 2 cách cho cùng kết quả vì Guard không bao giờ đạt đúng
                // 0%, dùng field chuyên dụng rõ ràng và chắc chắn hơn).
                evadedCompletely = totalHits > 0 && hitEvadedOrParried.every(Boolean);
                renegadeLandedHits = totalHits - hitEvadedOrParried.filter(Boolean).length;
                const bypassNote = [bypass.blockEvade && "Undodgeable", bypass.blockGuard && "Unblockable", bypass.blockParry && "Unparriable"].filter(Boolean);
                defenseNote = noteParts.length > 0 ? " " + noteParts.join(" + ") : "";
                if (bypassNote.length > 0 && hitIdx < totalHits) defenseNote += ` *(${bypassNote.join(", ")} — phần hit còn lại không thể chặn)*`;
                // GAP ĐÃ SỬA (xác nhận trực tiếp: "dice up của blade flourish
                // với durandal không áp dụng") — "diceEffects" (skills.js):
                // hiệu ứng phụ cấu trúc hoá TỪNG dice, CHỈ áp dụng nếu dice đó
                // thật sự trúng (perHitMult[i] > 0, không bị né/chặn hoàn
                // toàn). BUG SCOPE ĐÃ SỬA: phải nằm TRONG block này (trước khi
                // đóng) vì totalHits/perHitMult chỉ tồn tại ở đây — đặt sau
                // dấu đóng gây lỗi "totalHits is not defined" khi runtime.
                // Giới hạn: chỉ xử lý đúng khi skill là dạng "1 dice = 1 hit"
                // (totalHits khớp diceEffects.length) — skill nhiều hit/dice
                // (Eye of Horus-style) KHÔNG áp dụng ở đây, cần thiết kế riêng.
                if (p.skillKey && attacker.type === "player") {
                  const diceEffectSkill = findSkill(p.skillKey);
                  // GAP HỆ THỐNG ĐÃ SỬA (Fragaria: "còn rất nhiều page vẫn chưa
                  // gây debuff hoặc nhận buff đúng nên check lại 1 lượt và làm
                  // hết") — ƯU TIÊN diceEffects VIẾT TAY (chính xác tuyệt đối,
                  // dùng cho case đặc biệt), FALLBACK sang bản tự parse từ text
                  // mô tả (autoExtractDiceSideEffects, xem skills.js) cho ~130
                  // skill chưa ai code hoá thủ công.
                  const autoDiceEffects = diceEffectSkill && !diceEffectSkill.diceEffects
                    // LƯU Ý (bài học HANDOFF #1 — KHÔNG đoán tên field): pendingAction
                    // KHÔNG có field `skillRollLines`; text roll() được lưu trong
                    // `skillRollEmbed.description` (các dòng nối bằng "\n", xem
                    // skill-verification.js). annotateLinesWithEmotion chỉ APPEND
                    // emoji vào CUỐI dòng nên phần đầu "<:DiceN:... [Slash] ..."
                    // còn nguyên vẹn — parser đọc được bình thường. Dòng header
                    // "[cost] [CD] [Dice Mul]" tự bị loại vì không bắt đầu bằng
                    // "<:DiceN:".
                    ? autoExtractDiceSideEffects((p.skillRollEmbed?.description ?? "").split("\n"))
                    : null;
                  const effectiveDiceEffects = diceEffectSkill?.diceEffects ?? autoDiceEffects;
                  if (effectiveDiceEffects && effectiveDiceEffects.length === totalHits) {
                    // MỞ RỘNG (GAP ĐÃ SỬA — Fragaria báo trực tiếp: "spear/level
                    // slash không cho imitation"): TRƯỚC ĐÂY diceEffects CHỈ hiểu
                    // đúng 1 khoá `diceUp`, nên mọi hiệu ứng-phụ-theo-dice khác
                    // đều phải hardcode riêng từng skill ở dưới (dễ sót — đó
                    // chính là lý do Level Slash/Spear ghi "nhận 1 Imitation"
                    // trong text mà không có logic nào). Giờ bảng ánh xạ chung:
                    // khoá trong diceEffects → field THẬT trên combatant.
                    // CHỈ gồm status KHÔNG biểu diễn được bằng dmgStr (Poise/
                    // Charge/Bleed/Burn/Rupture/Sinking/Tremor đã đi qua
                    // autoBuildDmgStrFromSkillRoll — KHÔNG đưa vào đây kẻo áp 2 lần).
                    const DICE_EFFECT_SELF_FIELDS = {
                      diceUp: "diceUp", imitation: "imitation", haste: "haste",
                      protection: "protection", defenseUp: "defenseUp",
                      attackPowerUp: "attackPowerUp", regen: "regen", smoke: "smoke",
                    };
                    const DICE_EFFECT_TARGET_FIELDS = {
                      paralyze: "paralyze", fragile: "fragile", bind: "bind",
                      diceDown: "diceDown", nails: "nails", freeble: "freeble",
                      defenseDown: "defenseDown", attackPowerDown: "attackPowerDown",
                    };
                    effectiveDiceEffects.forEach((effect, i) => {
                      if (!effect) return;
                      if (hitEvadedOrParried[i]) return; // GAP ĐÃ SỬA: chỉ Evade/Parry THÀNH CÔNG mới không dính hiệu ứng — Guard (kể cả 100% reduction) vẫn tính là "dính"
                      // Cap theo TỪNG field — trước đây vòng lặp này cộng TRẦN
                      // TRỤI, nên Imitation (và mọi field mới thêm sau) không có
                      // giới hạn nào. Khai bảng thay vì if riêng cho từng field.
                      const DICE_EFFECT_SELF_CAPS = { imitation: IMITATION_MAX ?? 10 };
                      for (const [key, field] of Object.entries(DICE_EFFECT_SELF_FIELDS)) {
                        const amount = effect[key];
                        if (!amount) continue;
                        const capForField = DICE_EFFECT_SELF_CAPS[field];
                        attacker.combatant[field] = capForField != null
                          ? Math.min(capForField, (attacker.combatant[field] ?? 0) + amount)
                          : (attacker.combatant[field] ?? 0) + amount;
                        // BUG ĐÃ SỬA: defenseNote CHƯA tồn tại ở scope này (khai
                        // báo sau, gây TDZ error "Cannot access before
                        // initialization") — dùng defenseNote (đã tồn tại sẵn).
                        defenseNote += ` 🎲[Dice ${i + 1} +${amount} ${key}]`;
                      }
                      // Hiệu ứng lên TARGET của chính dice đó (dice này trúng ai
                      // thì áp lên người đó — dùng targetResolved của vòng lặp
                      // target đang chạy, KHÔNG phải p.targets[0]).
                      for (const [key, field] of Object.entries(DICE_EFFECT_TARGET_FIELDS)) {
                        const amount = effect[key];
                        if (!amount) continue;
                        targetResolved.combatant[field] = (targetResolved.combatant[field] ?? 0) + amount;
                        defenseNote += ` 🎯[Dice ${i + 1} địch +${amount} ${key}]`;
                      }
                      // Hậu tố "__t" — do autoExtractDiceSideEffects sinh ra khi
                      // parser xác định hiệu ứng nhắm vào TARGET (VD "địch nhận 2
                      // Dice Down"). Cho phép CÙNG 1 field xuất hiện ở cả 2 chiều
                      // trong 1 dice mà không đè nhau (VD tự +Protection đồng thời
                      // gây +Fragile cho địch).
                      for (const [rawKey, amount] of Object.entries(effect)) {
                        if (!rawKey.endsWith("__t") || !amount) continue;
                        const baseKey = rawKey.slice(0, -3);
                        // "Airborne" là CỜ boolean (không stack) — xem
                        // combatant-factory.js. Parser sinh ra số 1 để đi chung
                        // cơ chế diceEffects, ép về true ở đây thay vì cộng dồn.
                        if (baseKey === "airborne") {
                          // "Biến mất sau bị dính đòn có condition Airborne" —
                          // target ĐANG Airborne mà lại ăn thêm đòn Airborne thì
                          // cờ bị TIÊU THỤ (rơi xuống) chứ không gia hạn.
                          if (targetResolved.combatant.airborne) {
                            targetResolved.combatant.airborne = false;
                            defenseNote += ` 🪁[Dice ${i + 1} địch rơi xuống — **Airborne** bị tiêu]`;
                            continue;
                          }
                          targetResolved.combatant.airborne = true;
                          defenseNote += ` 🪁[Dice ${i + 1} địch bị **Airborne**]`;
                          continue;
                        }
                        const field = DICE_EFFECT_TARGET_FIELDS[baseKey] ?? DICE_EFFECT_SELF_FIELDS[baseKey];
                        if (!field) continue;
                        targetResolved.combatant[field] = (targetResolved.combatant[field] ?? 0) + amount;
                        defenseNote += ` 🎯[Dice ${i + 1} địch +${amount} ${baseKey}]`;
                      }
                    });
                  }
                  // Task yêu cầu trực tiếp: "page light attack khi trúng không
                  // hồi light" (fix cũ hardcode riêng 1 skill, Fragaria test lại
                  // vẫn báo không hồi) + "extract fuel không hồi hp, hồi light
                  // vào turn sau thay vì lúc dùng" — GAP THẬT rộng hơn dự kiến:
                  // ít nhất 15 skill khác trong skills.js có mô tả "hồi HP/Light"
                  // tương tự nhưng CHƯA code hoá. Thay vì tiếp tục hardcode TỪNG
                  // skill (dễ sót, dễ lỗi), giờ dùng field CẤU TRÚC chung
                  // (selfLightRestore/selfHealByBaseDmg — xem skills.js) — áp
                  // dụng NGAY LÚC TRÚNG (không phải turn sau), GATE bởi
                  // !evadedCompletely (né hoàn toàn = không trúng gì, không hồi).
                  if (diceEffectSkill && !evadedCompletely) {
                    if (diceEffectSkill.selfLightRestore) {
                      const beforeLight = attacker.combatant.currentLight ?? 0;
                      attacker.combatant.currentLight = Math.min(attacker.combatant.maxLight ?? 6, beforeLight + diceEffectSkill.selfLightRestore);
                      const lightGained = attacker.combatant.currentLight - beforeLight;
                      if (lightGained > 0) defenseNote += ` <:Light:1513786082502770719>+${lightGained} Light (${diceEffectSkill.name})`;
                    }
                    if (diceEffectSkill.selfHealByBaseDmg) {
                      // Base dmg value CHÍNH LÀ dice roll gốc (roll() dùng d1 làm
                      // damage TRỰC TIẾP, không nhân/cộng gì thêm cho case này) —
                      // parse lại từ p.dmgStr (số ĐẦU TIÊN trước ký tự loại dmg).
                      const baseDmgMatch = (p.dmgStr ?? "").match(/^([\d.]+)/);
                      const baseDmgVal = baseDmgMatch ? parseFloat(baseDmgMatch[1]) : 0;
                      const healAmount = diceEffectSkill.selfHealByBaseDmg(baseDmgVal);
                      if (healAmount > 0) {
                        const beforeHp = attacker.combatant.currentHp ?? 0;
                        healHpCapped(attacker.combatant, healAmount); // tôn trọng healCapHp (Memories: Compassion)
                        const hpHealed = attacker.combatant.currentHp - beforeHp;
                        if (hpHealed > 0) defenseNote += ` ❤️+${hpHealed.toFixed(1)} HP (${diceEffectSkill.name})`;
                      }
                    }
                  }
                }
                // "Blade Lineage" (outfit) — GAP MỚI (xác nhận trực tiếp):
                // "Mỗi khi kẻ địch block đòn đánh của bạn, bạn nhận được 2
                // Poise" — trigger khi có ÍT NHẤT 1 hit bị target Guard.
                // Xuất perHitMult ra ngoài scope (xem khai báo
                // perHitMultForBulletEffect phía trên khối này).
                perHitMultForBulletEffect = perHitMult;
              }
              // Smoldering Resolve (perk passive, KHÔNG tiêu thụ) áp SAU Guard/Evade/
              // Parry — giảm thêm % trên phần dmg CÒN LẠI sau khi đã né/đỡ.
              // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp: "40% Dmg Reduction
              // của Reverberation Ensemble outfit vẫn bị bão hòa của hệ thống
              // mà") — ĐÂY LÀ ĐIỂM ÁP DỤNG DMG THẬT (không phải chỉ preview) —
              // trước đây HOÀN TOÀN bỏ qua saturateDR (dù hàm đã tồn tại sẵn,
              // export đúng mục đích này) — ảnh hưởng TOÀN BỘ hệ thống Damage
              // Reduction (Smoldering Resolve/Protection/Charge Shield/Fragile/
              // Smoke/Vengeance Mark/Tremor Decay/Gaze/Contempt/Hemorrhage...),
              // không chỉ riêng Reverberation Ensemble vừa thêm.
              finalDmg *= saturateDR(1 - (t.defReductionPct ?? 0) / 100);
              let killNote = "";
              // Evade né được = né LUÔN finisher (Claim Their Heart) — đã tránh đòn
              // hoàn toàn thì không có lý do vẫn bị "kết liễu" bởi chính đòn đó.
              if (t.instantKill && !evadedCompletely) { finalDmg = target.currentHp; killNote = ` ☠️KẾT LIỄU (${t.instantKill})`; }
              let bleedOverride = null; // Break the Dams — giữ bleed KHÔNG bị giảm turn này nếu trigger
              let perkNote = "";
              // Craving Synergy/Thirst/Break the Dams — CHỈ đòn đánh ĐẦU TIÊN của
              // ATTACKER lên TARGET ĐANG có Bleed mỗi turn (chung 1 cờ — trigger cả 3
              // nếu đủ điều kiện riêng từng cái, vì đều là "tận dụng đòn đầu turn").
              // BUG ĐÃ SỬA: trước đây KHÔNG check evadedCompletely — nếu đòn bị né/
              // parry HOÀN TOÀN, cả 3 perk này vẫn trigger như đòn đã trúng (vô lý —
              // "đòn đánh đầu tiên LÊN kẻ địch" hàm ý phải THỰC SỰ chạm tới, không
              // trúng thì không có "đòn đánh" nào để tính là "đầu tiên" cả). Nghiêm
              // trọng hơn: Break the Dams cũ còn "finalDmg += bleedBeforeHit" — cộng
              // thẳng vào finalDmg ĐÃ BỊ ÉP VỀ 0 bởi né hoàn toàn, khiến target VẪN ăn
              // dmg dù đã né 100% — giờ chặn hẳn nhánh này khi evadedCompletely.
              if (!evadedCompletely && attacker.type === "player" && !attacker.combatant.bleedFirstHitUsedThisTurn && bleedBeforeHit > 0) {
                let usedThisHit = false;
                if (hasPerk(attacker.combatant, "Break the Dams") && bleedBeforeHit >= 7 && (attacker.combatant.breakTheDamsCdLeft ?? 0) <= 0) {
                  finalDmg += bleedBeforeHit;
                  // Lấy bleedStacksAfter của hit CUỐI (trước khi end-turn-tick giảm nửa) thay cho finalBleed — "giữ count không giảm turn này".
                  const lastHit = t.preview.instanceResults[t.preview.instanceResults.length - 1];
                  bleedOverride = lastHit?.bleedStacksAfter ?? bleedBeforeHit;
                  attacker.combatant.breakTheDamsCdLeft = 3;
                  perkNote += ` [💥Break the Dams +${bleedBeforeHit}dmg]`;
                  usedThisHit = true;
                }
                if (hasPerk(attacker.combatant, "Thirst")) {
                  const healAmt = Math.floor(bleedBeforeHit / 2);
                  healHpCapped(attacker.combatant, healAmt);
                  bleedOverride = 0; // "tiêu thụ chúng" — Thirst LUÔN thắng nếu cả 2 cùng trigger (hiếm khi xảy ra)
                  perkNote += ` [🩸Thirst +${healAmt}HP bản thân, tiêu thụ Bleed]`;
                  usedThisHit = true;
                }
                if (hasPerk(attacker.combatant, "Craving Synergy") && bleedBeforeHit > 5) {
                  attacker.combatant.currentLight = Math.min(attacker.combatant.maxLight, attacker.combatant.currentLight + 1);
                  perkNote += ` [✨Craving Synergy +1 Light]`;
                  usedThisHit = true;
                }
                if (usedThisHit) attacker.combatant.bleedFirstHitUsedThisTurn = true;
              }
              const wasAliveBefore = target.currentHp > 0;
              // Táo (item): giảm 1 Dmg PHẢI NHẬN mỗi HIT (không phải mỗi ACTION) cho
              // tới hết turn hiện tại — áp SAU Guard/Evade/Parry (finalDmg đã qua
              // mitigation), nhân theo hitCount thật của action này (M1 nhiều hit →
              // giảm nhiều lần, đúng "mỗi hit"). Không áp nếu evadedCompletely
              // (finalDmg đã =0 từ trước, floor tại 0 tự nhiên an toàn không cần
              // check thêm). Chỉ áp cho target LÀ PLAYER (Táo là item của player).
              if (target.appleDmgReductionActive && targetResolved.type === "player") {
                finalDmg = Math.max(0, finalDmg - hitCount);
              }
              // Foreclosure Task Force President (Eye of Horus, passive vũ khí — tự
              // động hoá theo yêu cầu trực tiếp): leo thang theo SỐ LẦN đánh thường
              // (M1) trong 1 TURN lên CÙNG 1 target. Áp dụng TẠI ĐÂY (lúc CONFIRM,
              // không phải lúc declare) để tránh counter bị tăng NHẦM nếu GM sau đó
              // reject action — đồng bộ đúng với thời điểm "hành động THỰC SỰ xảy
              // ra". CHỈ áp cho M1 (p.isM1), không áp cho Page/skill.
              // Phần TỰ ĐỘNG HOÁ ĐƯỢC: +50% dmg khi count 2-3, +2 Tremor +2 Charge
              // lên BẢN THÂN (attacker) MỖI lần đánh thường bất kể count bao nhiêu.
              // Phần KHÔNG tự động hoá (giữ nguyên GM/player tự áp — xem weapon.js):
              // "Repeat Ammo" ở lần đầu (cơ chế không rõ ràng đủ để code chính xác),
              // Base dmg 3→4 ở count 4-6 (CHỈ tự động được cho đường nút bấm "Đánh
              // mấy lần" — xem encmenu handler đọc count HIỆN TẠI để tính base động,
              // KHÔNG áp được cho lệnh text tự gõ dmgStr).
              // Foreclosure Task Force President (Eye Of Horus) — logic THẬT nằm ở
              // computeAttackerPerkContext (bonusPct theo tier, tính lúc DECLARE) +
              // khối "eyeOfHorusTremorChargeAmount" phía trên (commit Tremor/Charge lúc
              // CONFIRM) — xem 2 chỗ đó, KHÔNG áp dụng lại ở đây. (BUG ĐÃ SỬA: từng có
              // 1 bản implementation THỨ HAI ở đây, dùng field khác (hasEyeOfHorus/
              // eyeOfHorusHitCountByTarget) — SAI logic tier (+50% chỉ áp lần 2-3 thay
              // vì 1-3), THIẾU Repeat Ammo + base 3→4, và Tremor/Charge KHÔNG check
              // evadedCompletely — chạy SONG SONG với bản đúng khiến Tremor/Charge bị
              // cộng ĐÚP mỗi lần đánh, verify bằng test thật phát hiện Tremor=16 thay
              // vì 8 sau 4 lần đánh. Đã xoá hẳn, chỉ giữ 1 nguồn duy nhất.)
              let eyeOfHorusNote = "";
              // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp: phát hiện qua điều
              // tra bão hòa "Fragile/Hemorrhage/Gaze... vẫn bão hòa thôi") —
              // TOÀN BỘ 5 khối tính Fragile/Karmic Consequence/Smoke/Charge
              // Shield/Protection từng nằm ở đây đã bị XOÁ — đây là 1 "audit"
              // RIÊNG BIỆT (không biết computeDefenderDmgReduction/
              // computeAttackerPerkContext đã xử lý đúng 5 hiệu ứng này từ
              // trước, có bão hòa đúng công thức) tự ý áp dụng LẠI cả 5 một
              // cách ĐỘC LẬP trực tiếp vào finalDmg — gây DOUBLE-COUNT nghiêm
              // trọng cho TẤT CẢ 5 hiệu ứng (mỗi cái tính 2 lần qua 2 đường
              // hoàn toàn khác nhau, 1 bên có bão hòa 1 bên không). Giờ CHỈ còn
              // đúng 1 nguồn duy nhất cho mỗi hiệu ứng — xem defReductionPct
              // (Protection/Charge Shield/Contempt) và perkCtx.bonusPct
              // (Fragile/Karmic Consequence/Smoke/Vengeance Mark/Tremor Decay/
              // Gaze[Awe]/Hemorrhage) đã áp dụng ĐÚNG 1 LẦN từ đầu hàm này rồi.
              let fragileNote = "", karmicNote = "", smokeNote = "", chargeShieldNote = "", protectionNote = "";
              // Charge Shield vẫn cần RESET về 0 sau mỗi lần bị tấn công (khác
              // Protection/2-turn) — chỉ giữ lại phần reset, không tính dmg lại.
              if ((target.chargeShieldStack ?? 0) > 0 && finalDmg > 0) {
                target.chargeShieldStack = 0;
              }
              // Time Moratorium (xác nhận trực tiếp): "khi bị nhận sát thương mà có
              // hiệu ứng này... KHÔNG NHẬN sát thương trong turn đó mà tích lại...
              // khi mục tiêu có hiệu ứng này giảm 10% dmg nhận vào" — chặn TOÀN BỘ
              // finalDmg CUỐI CÙNG (sau khi Guard/Evade/Parry đã áp dụng xong ở
              // trên), tích luỹ 90% (đã giảm 10%) vào timeMoratoriumAccumulated,
              // rồi set finalDmg=0 để mọi logic PHÍA SAU (regen, justDied, injury...)
              // tự nhiên coi đây là "không nhận dmg" — an toàn nhất, không cần sửa
              // lại từng chỗ phụ thuộc finalDmg riêng lẻ.
              let timeMoratoriumNote = "";
              if (target.timeMoratorium && finalDmg > 0) {
                const accumulatedGain = finalDmg * 0.9;
                target.timeMoratoriumAccumulated = (target.timeMoratoriumAccumulated ?? 0) + accumulatedGain;
                timeMoratoriumNote = ` ⏳[Time Moratorium hoãn ${accumulatedGain.toFixed(3)} dmg, tích lũy ${target.timeMoratoriumAccumulated.toFixed(3)}]`;
                finalDmg = 0;
              }
              // "Shield HP" (Tactical Suppression, Dieci Association) — GAP ĐÃ
              // SỬA: xác nhận trực tiếp "tôi không thấy shield hp" — trước đây
              // shieldHp CHỈ TỒN TẠI như 1 con số, KHÔNG BAO GIỜ thực sự hấp
              // thụ dmg (khác defReductionPct/% ở trên — đây là FLAT absorb,
              // trừ TRƯỚC khi dmg còn lại mới trừ vào HP thật).
              let shieldHpNote = "";
              // Ghi lại TRƯỚC khi hấp thụ — Renegade kích theo khiên lúc BỊ ĐÁNH,
              // không phải khiên còn lại sau đòn.
              const shieldHpBeforeAbsorb = target.shieldHp ?? 0;
              if ((target.shieldHp ?? 0) > 0 && finalDmg > 0) {
                // applyShieldLoss (combat-utils.js) — đếm vào `shieldLostThisTurn`
                // để "Swan Song" của Lucent Historia hồi đúng 20% lượng khiên ĐÃ
                // MẤT trong turn. Trừ tay ở đây là Swan Song hụt đúng phần này.
                const absorbed = applyShieldLoss(target, Math.min(target.shieldHp, finalDmg));
                finalDmg -= absorbed;
                shieldHpNote = ` 🛡️[Shield HP hấp thụ ${absorbed.toFixed(3)}, còn ${target.shieldHp.toFixed(3)}]`;
              }
              // "Hana Association": "+1 Dice Up mỗi 10 HP mất trong turn".
              // Logic đã GOM vào applyHpLoss (combat-utils.js) để MỌI nguồn mất
              // HP đều được đếm — trước đây CHỈ dòng này đếm, 19 chỗ trừ HP còn
              // lại (dmg phản, Bleed tự cắn, Tremor Burst…) hoàn toàn không.
              // skipShield: khiên ĐÃ được hấp thụ ngay phía trên (tách riêng vì
              // Renegade cần biết khiên lúc BỊ ĐÁNH). Không truyền cờ này thì
              // applyHpLoss sẽ trừ khiên LẦN HAI.
              // ── ÁP DMG THEO TỪNG HIT ────────────────────────────────────
              // ❗ Fragaria: "per hit khi Stagger giữa chừng chưa đúng — 1 chuỗi
              // 10 hit 10 dmg Blunt, Res địch 1x, sau đòn thứ 5 địch bị Stagger
              // thì 5 đòn sau phải thành 20 dmg mỗi đòn. Hiện tại một khi quyết
              // 1 chuỗi dmg thì giữa chừng không thay đổi."
              // Stagger giữa chuỗi đến từ Tremor Burst / Guard Break / Parry fail.
              //
              // GỐC: `calcMathCore` tính `resValues` MỘT LẦN ngoài vòng lặp hit,
              // và chỗ này áp `finalDmg` MỘT LẦN cho cả đòn ⇒ không có chỗ nào
              // để Res kịp đổi.
              //
              // Nay: đi TỪNG hit, sau mỗi hit gọi `checkStaggerPanic`; hit nào rơi
              // vào lúc mục tiêu ĐÃ Stagger mà lúc tính còn chưa Stagger thì
              // **scale lại** theo tỉ lệ `2 / resUsed` (Stagger = 2x mọi loại).
              // Phụ phẩm: mọi hiệu ứng "on hit" cũng tính đúng thời điểm hơn.
              {
                const insts = t.preview?.instanceResults ?? [];
                const scaleTotal = finalDmg / Math.max(1e-9, (t.preview?.totalDmg ?? finalDmg) || finalDmg);
                if (insts.length > 1) {
                  let appliedSum = 0;
                  for (const inst of insts) {
                    let hitDmg = (inst.instanceDmg ?? 0) * scaleTotal;
                    // MỌI hit rơi vào lúc mục tiêu ĐANG Stagger đều phải chịu Res
                    // Stagger (2x). `resUsed < 2` lọc sẵn trường hợp preview vốn
                    // đã tính bằng 2x (mục tiêu Stagger từ trước khi đòn bắt đầu)
                    // — không nhân đôi lần thứ hai.
                    if (target.staggered) {
                      const used = inst.resUsed ?? 1;
                      if (used > 0 && used < 2) hitDmg = hitDmg * (2 / used);
                    }
                    applyHpLoss(target, hitDmg, { skipShield: true });
                    appliedSum += hitDmg;
                    // Stagger có thể xảy ra NGAY tại hit này (Tremor Burst /
                    // Guard Break / Parry fail) ⇒ hit KẾ TIẾP mới ăn 2x.
                    checkStaggerPanic(target);
                  }
                  finalDmg = Math.round(appliedSum * 1000) / 1000;
                } else {
                  applyHpLoss(target, finalDmg, { skipShield: true });
                }
              }
              // Dmg NGƯỜI TẤN CÔNG gây ra trong turn, TÁCH RIÊNG THEO TỪNG MỤC
              // TIÊU — "Astral Quantization" tính % trên dmg gây cho **từng** kẻ
              // địch, không phải trên tổng.
              // Fragaria nói rõ: "turn đó nếu đồng đội đánh 3 kẻ địch mỗi kẻ 100
              // dmg và gieo ra 30 thì TOÀN BỘ 3 kẻ đó chịu thêm 30 dmg".
              // Dùng tổng (bản trước của tôi) sẽ ra 3 kẻ × 30% × 300 = sai hoàn toàn.
              // Đếm ở ĐÂY (nơi dmg THẬT vào HP) chứ không ở preview: preview là
              // dự kiến TRƯỚC phòng thủ, dùng nó sẽ tính cả phần đã bị né/guard.
              if (attacker.combatant && finalDmg > 0) {
                attacker.combatant.dmgDealtThisTurn = (attacker.combatant.dmgDealtThisTurn ?? 0) + finalDmg;
                attacker.combatant.dmgDealtByTargetThisTurn = attacker.combatant.dmgDealtByTargetThisTurn ?? {};
                const tk = t.targetId;
                attacker.combatant.dmgDealtByTargetThisTurn[tk] =
                  (attacker.combatant.dmgDealtByTargetThisTurn[tk] ?? 0) + finalDmg;
                // "The Strongest" cần biết Max HP của TỪNG kẻ địch đã đánh, để
                // cuối turn chấm ngưỡng "15% Max HP của kẻ địch" (turn-advance.js).
                // Ghi Ở ĐÂY vì đây là chỗ DUY NHẤT biết chắc target là ai; snapshot
                // lúc Manifest thì bỏ sót kẻ địch mới vào giữa trận.
                if (attacker.combatant.theStrongestActive) {
                  attacker.combatant.theStrongestEnemyMaxHpSnapshot = attacker.combatant.theStrongestEnemyMaxHpSnapshot ?? {};
                  attacker.combatant.theStrongestEnemyMaxHpSnapshot[tk] = target.maxHp ?? 0;
                }
                // "The Red Mist" — "Bạn được hồi máu dựa vào 4% sát thương gây ra".
                // Tính trên finalDmg (dmg THẬT sau phòng thủ/Res/DR), không phải
                // preview. Đi qua healHpCapped để tôn trọng healCapHp (Memories:
                // Compassion cộng Max HP ảo mà KHÔNG cho heal lên tới đó).
                if (redMistLifestealActive) {
                  const healAmt = Math.round(finalDmg * 0.04 * 1000) / 1000;
                  if (healAmt > 0) {
                    healHpCapped(attacker.combatant, healAmt);
                    redMistHealTotal += healAmt;
                  }
                }
              }
              // ── PROVIDENCE OF THE PRESCRIPT (accessory) ──────────────────
              // Indulgence in Prescript (Singleton) — "cho khả năng inflict thêm
              // 2 count ở mỗi đòn có áp Sinking".
              if ((attacker.combatant?.indulgenceInPrescript ?? 0) > 0
                  && (target.sinking ?? 0) > (sinkingBeforeHit ?? 0)) {
                target.sinking = Math.min(99, (target.sinking ?? 0) + 2);
                defenseNote += ` 📜[Indulgence in Prescript: +2 Sinking]`;
              }
              if (attacker.combatant?.hasProvidenceOfPrescript && finalDmg > 0) {
                // "Khi bản thân ≥20 Poise: mỗi đòn ĐÁNH TRÚNG gây thêm 1 Sinking
                // và 1 Rupture." Áp TRƯỚC vế dưới để chính nó cũng kích được +3 Poise.
                let providenceInflicted = false;
                if ((attacker.combatant.poise ?? 0) >= 20) {
                  target.sinking = Math.min(99, (target.sinking ?? 0) + 1);
                  target.rupture = Math.min(99, (target.rupture ?? 0) + 1);
                  providenceInflicted = true;
                }
                // "Khi gây Sinking/Rupture, nhận thêm 3 Poise" — tính CẢ nguồn từ
                // page lẫn từ chính vế trên.
                const gaveSinkOrRupt = providenceInflicted
                  || (target.sinking ?? 0) > (sinkingBeforeHit ?? 0)
                  || (target.rupture ?? 0) > (ruptureBeforeHit ?? 0);
                if (gaveSinkOrRupt) {
                  attacker.combatant.poise = Math.min(POISE_MAX, (attacker.combatant.poise ?? 0) + 3);
                  attacker.combatant.providencePoiseProcsThisTurn = (attacker.combatant.providencePoiseProcsThisTurn ?? 0) + 1;
                  defenseNote += ` ⚖️[Providence: +3 Poise (${attacker.combatant.providencePoiseProcsThisTurn}/3 lần turn này)`
                    + (providenceInflicted ? ` · ≥20 Poise → +1 Sinking +1 Rupture` : "") + `]`;
                }
              }
              // ── RENEGADE (Lucent Historia) ────────────────────────────────
              // Fragaria đính chính luật: *"đồng đội NÀO CÓ Shield HP thì sẽ phản
              // lại MỖI KHI BỊ TẤN CÔNG theo BASE DMG, chia theo type dmg nốt.
              // VD light base 5 → phản 5; Heavy 20/4; Medium 10/2."*
              //
              // → Đọc từ 3 ví dụ: chia `weaponBaseDamage` cho hệ số theo WEIGHT
              //   light ÷1 · medium ÷2 · heavy ÷4
              //   (5/1 = 5 · 10/2 = 5 · 20/4 = 5 — khớp cả 3 ví dụ)
              // KHÔNG còn "50% sát thương đánh thường" như bản đầu của tôi.
              //
              // Chủ thể phản = CHÍNH NGƯỜI BỊ ĐÁNH (target), miễn họ đang có
              // Shield HP — không phải người cầm Lucent Historia. Nhưng passive
              // thuộc về Lucent Historia nên vẫn cần có người trong party cầm nó.
              // Type dmg phản theo VŨ KHÍ CỦA NGƯỜI PHẢN ("chia theo type dmg nốt").
              // Khiên xét TRƯỚC khi hấp thụ: bị đánh bay hết khiên trong chính đòn
              // đó vẫn phải phản.
              let renegadeNote = "";
              if (shieldHpBeforeAbsorb > 0 && attacker.combatant && attacker.type === "enemy") {
                const holder = Object.values(encounter.players ?? {})
                  .find(pl => pl.weaponName === "Lucent Historia" && (pl.currentHp ?? 0) > 0);
                if (holder) {
                  // BUG ĐÃ SỬA (Fragaria: "Renegade thay vì phản per hit nhận
                  // được thì nó chỉ phản 1 group. VD 1 page gây 3 lần dmg thì
                  // Lucent Historia sẽ phản CẢ 3 LẦN").
                  // Bản cũ phản ĐÚNG 1 LẦN cho cả action, bất kể bị đánh mấy hit.
                  //
                  // LUẬT ĐẦY ĐỦ (Fragaria đưa kèm ví dụ số):
                  //  • Giá trị phản 1 GROUP = base dmg người BỊ ĐÁNH ÷ hệ số WEIGHT
                  //    của họ (light ÷1 · medium ÷2 · heavy ÷4).
                  //  • Với M1, 1 group = WEAPON_DEFENSE_HITS[weight của KẺ TẤN CÔNG]
                  //    hit, nên MỖI HIT chỉ mang 1/số-hit-mỗi-group giá trị đó.
                  //    Với Page/Critical thì mỗi dice là 1 group riêng (hitsPerCharge
                  //    = 1) ⇒ mỗi dice phản TRỌN giá trị.
                  //  • Tổng phản = giá-trị-mỗi-hit × số hit THẬT SỰ DÍNH.
                  //
                  // KIỂM LẠI VÍ DỤ CỦA FRAGARIA: người bị đánh M1 light base 5
                  // (5÷1 = 5/group), kẻ địch M1 light đánh 2 hit (group light = 4
                  // hit) ⇒ mỗi hit phản 5÷4 = **1.25** ✓, 2 hit dính = 2.5 = đúng
                  // **50%** của Renegade ✓ — khớp cả hai vế Fragaria nói.
                  const divisor = RENEGADE_DIVISOR[target.weaponWeight ?? "medium"] ?? 2;
                  const perGroup = Math.round(((target.weaponBaseDamage ?? 0) / divisor) * 1000) / 1000;
                  // hitsPerCharge đã tính sẵn ở đầu vòng lặp target: M1 → số hit
                  // mỗi group theo vũ khí KẺ TẤN CÔNG; Page/Critical → 1.
                  // ❗ Fragaria: "Renegade chia luôn cả group hit M1 dù địch đang
                  // xài PAGE". `hitsPerCharge` là khái niệm của M1 (WEAPON_DEFENSE_HITS);
                  // với Page/Critical mỗi dice là 1 group riêng ⇒ KHÔNG chia.
                  const perHit = isM1Type
                    ? Math.round((perGroup / Math.max(1, hitsPerCharge)) * 1000) / 1000
                    : perGroup;
                  const landed = renegadeLandedHits === null ? hitCount : renegadeLandedHits;
                  const reflected = Math.round(perHit * landed * 1000) / 1000;
                  if (reflected > 0 && landed > 0) {
                    applyHpLoss(attacker.combatant, reflected);
                    renegadeNote = ` ⚔️[Renegade: ${target.weaponWeight ?? "medium"} ${target.weaponBaseDamage}/${divisor} = ${perGroup}/group` +
                      (isM1Type && hitsPerCharge > 1 ? ` ÷ ${hitsPerCharge} hit/group = ${perHit}/hit` : "") +
                      ` × ${landed} hit dính → phản **${reflected}** ${target.weaponType ?? ""} về ${attacker.label}]`;
                  }
                }
              }
              // "Dieci Association": "Khi bị tấn công và bạn có Shield HP, kẻ
              // địch sẽ nhận 2 Sinking" — target (bị tấn công) có outfit này VÀ
              // shieldHp > 0 → attacker (kẻ đang tấn công target) nhận 2 Sinking.
              let dieciSinkingNote = "";
              if (target.hasDieciAssociation && (target.shieldHp ?? 0) > 0 && attacker.combatant) {
                attacker.combatant.sinking = Math.min(99, (attacker.combatant.sinking ?? 0) + 2);
                dieciSinkingNote = ` 🌀[Dieci Association +2 Sinking lên ${attacker.label}]`;
              }
              // liuAssociationNote — GAP ĐÃ SỬA (thứ tự thực thi): logic Liu
              // Association THẬT SỰ nằm SAU toàn bộ M1-count block (fire_burn
              // chạy ở đó, sau khi vòng for này đã đóng) — biến này giữ nguyên
              // rỗng ở đây, chỉ để không phá cấu trúc targetDmgLines.push bên dưới.
              let liuAssociationNote = "";
              // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 3) —
              // "Payback" (Chains of Loyalty): đòn tấn công ĐẦU TIÊN mỗi turn của
              // target (chỉ player, vì đây là target bị TẤN CÔNG bởi kẻ thù —
              // logic không áp dụng nếu 2 phe cùng player/cùng enemy đối đầu nhau
              // theo cách bất thường nào đó) → phản 1/2 finalDmg (Blunt, true dmg,
              // không tính lại Res của attacker để tránh double-dip phức tạp) về
              // attacker, gây 5 Fragile + 1 Vengeance Mark lên attacker.
              let paybackNote = "";
              if (finalDmg > 0 && !target.paybackUsedThisTurn) {
                const targetWeaponInfo = findWeaponAnywhere(target.weaponName);
                const hasPayback = (targetWeaponInfo?.passives ?? []).some(pa => pa.mechanicId === "payback_reflect");
                if (hasPayback) {
                  target.paybackUsedThisTurn = true;
                  const reflectedDmg = finalDmg * 0.5;
                  applyHpLoss(attacker.combatant, reflectedDmg); // đếm vào hpLostThisTurn (Hana)
                  attacker.combatant.fragile = Math.min(99, (attacker.combatant.fragile ?? 0) + 5);
                  attacker.combatant.vengeanceMark = (attacker.combatant.vengeanceMark ?? 0) + 1;
                  paybackNote = ` 🔗**Payback** — phản ${reflectedDmg.toFixed(3)} Dmg [Blunt] lên ${attacker.label}, gây 5 Fragile + 1 Vengeance Mark.`;
                }
              }
              // Regen (50-Status Nhóm 1) — "CHỈ khi mất máu mới tự động tiêu thụ để
              // hồi HP" (xác nhận trực tiếp từ GM) — KHÔNG tự hồi mỗi turn, CHỈ kích
              // hoạt NGAY SAU khi vừa nhận dmg thật (finalDmg > 0, không tính đòn bị
              // né/chặn hoàn toàn thành 0 dmg). Tiêu thụ tối đa min(regen, finalDmg)
              // — mỗi 1 Regen hồi lại đúng 1 HP, KHÔNG hồi vượt quá lượng vừa mất.
              let regenHealNote = "";
              if (finalDmg > 0 && (target.regen ?? 0) > 0) {
                let regenConsumed = Math.min(target.regen, finalDmg);
                // Hemorrhage stack 5 (xác nhận trực tiếp): "giảm hồi máu của mục
                // tiêu dính Bleed đi 1/3" — chỉ áp ở tier CAO NHẤT (đúng 5, không
                // phải mọi tier).
                let hemorrhageHealNote = "";
                if (target.hemorrhage === HEMORRHAGE_MAX) {
                  const reduced = Math.floor(regenConsumed / 3);
                  regenConsumed -= reduced;
                  if (reduced > 0) hemorrhageHealNote = ` (Hemorrhage giảm hồi ${reduced})`;
                }
                // Burning Sensation (xác nhận trực tiếp): "giảm 1/2 lượng hồi phục"
                // — áp ĐỘC LẬP với Hemorrhage ở trên (cả 2 cùng có thì cộng dồn).
                if (target.burningSensation) {
                  const reducedBS = Math.floor(regenConsumed / 2);
                  regenConsumed -= reducedBS;
                  if (reducedBS > 0) hemorrhageHealNote += ` (Burning Sensation giảm hồi ${reducedBS})`;
                }
                target.regen -= regenConsumed;
                healHpCapped(target, regenConsumed);
                regenHealNote = ` 💚+${regenConsumed} HP (Regen, còn ${target.regen}${hemorrhageHealNote})`;
              }
              const justDied = wasAliveBefore && target.currentHp <= 0;
              // Fpoon — easter egg (Fragaria: "khi chết thay vì ghi là đã bị hạ
              // gục thì hãy ghi là tự dùng Fpoon tự sát"). Chỉ áp cho người mặc
              // The Index Oracle's Proxy; thuần HIỂN THỊ, không đổi cơ chế nào.
              const fpoonDeath = justDied && target.hasIndexOraclesProxy === true;
              if (fpoonDeath) {
                // Bỏ hẳn field `deathFlavor` — push THẲNG vào log. Giữ một cờ chỉ
                // để ghi rồi không ai đọc chính là lớp lỗi vừa dọn.
                resultLines.push(`🥄 **${targetResolved.label}** — Caduceus biến thành **Fpoon**, buộc Rien phải tự sát.`);
              }
              // HP Persistence (luật: "HP vẫn giữ nguyên" sau khi encounter kết
              // thúc) — đồng bộ NGAY mỗi lần HP player thay đổi (không chỉ lúc
              // -encounter end, để không mất dữ liệu nếu encounter bị bỏ dở/quên
              // end). Enemy không có profile nên không áp.
              if (targetResolved.type === "player") {
                try {
                  const { data: hpSyncData, slot: hpSyncSlot } = await getPlayerDataWithSlot(t.targetId);
                  hpSyncData.currentHp = target.currentHp;
                  hpSyncData.hpLastResetCheck = Date.now();
                  await savePlayerData(t.targetId, hpSyncData, hpSyncSlot);
                } catch { /* không chặn action chính nếu sync HP lỗi — log đủ rồi bỏ qua */ }
              }
              // Emotion Coin: "Giết 1 kẻ địch cho 3" — CHỈ áp khi target là enemy (PvE)
              // và ATTACKER là player (enemy giết enemy khác hoặc tự mình chết không
              // tính). "Đồng đội bị giết cho 5" — áp cho TẤT CẢ player KHÁC trong
              // encounter khi 1 player chết — giả định mọi player đều là "đồng đội"
              // của nhau (đúng cho PvE chuẩn; với PvP thật giữa 2 player thì coi như
              // không có "đồng đội" nào khác để cộng — không có cách phân biệt
              // team/side rõ ràng hơn trong hệ thống hiện tại nên dùng quy ước này).
              if (justDied) {
                if (targetResolved.type === "enemy" && attacker.type === "player") {
                  applyEmotionDelta(attacker.combatant, 3);
                  // "The Red Mist" (Manifested E.G.O: Red Mist) — "cứ mỗi một kẻ
                  // địch bạn tiêu diệt được Ở TRONG TRẠNG THÁI Manifested E.G.O,
                  // bản thân nhận 5 Dice Up kéo dài TỚI HẾT ENCOUNTER".
                  // Gate `manifestedEGO` là bắt buộc: hạ địch lúc KHÔNG Manifest
                  // thì không được gì. Cộng vào bộ đếm BỀN (redMistPersistentDiceUp)
                  // chứ không vào `diceUp` — `diceUp` bị reset mỗi turn, cộng
                  // thẳng vào đó là mất sạch ngay turn sau.
                  if (hasEgoMechanic(attacker.combatant, "redmist_the_red_mist")) {
                    attacker.combatant.redMistPersistentDiceUp = (attacker.combatant.redMistPersistentDiceUp ?? 0) + 5;
                    attacker.combatant.diceUp = (attacker.combatant.diceUp ?? 0) + 5;
                    resultLines.push(`🩸 **The Red Mist** — hạ ${targetResolved.label ?? "kẻ địch"}: +5 Dice Up tới hết Encounter (tổng ${attacker.combatant.redMistPersistentDiceUp}).`);
                  }
                  // Stage 5 (cuối) — nhiệm vụ 3 của -daily, biến thể "killmobs"
                  // ("hạ 3 mob/boss bất kỳ") — tăng đếm mỗi khi player hạ 1 enemy
                  // (bất kỳ encounter nào, quest hay GM thường — "mob/boss bất kỳ"
                  // không giới hạn phạm vi). Fire-and-forget — không chặn action
                  // chính nếu lỗi (giống pattern applyEmotionDelta/HP sync ở trên).
                  // KHÔNG fire-and-forget nữa — xem comment đầy đủ ở khai báo
                  // dailyKillHookPromises (đầu hàm). Vẫn nuốt lỗi RIÊNG của hook
                  // này (không được chặn đòn đánh chính) nhưng phải ĐỢI nó xong
                  // để nhả lock userId trước khi finalizeQuestOutcome cần dùng.
                  dailyKillHookPromises.push(
                    incrementKillTaskProgress(p.attackerId).catch((err) => {
                      resultLines.push(`⚠️ Không cập nhật được tiến độ nhiệm vụ \`-daily\` (hạ mob): ${err?.message ?? err}`);
                    })
                  );
                } else if (targetResolved.type === "player") {
                  for (const otherPid of Object.keys(encounter.players)) {
                    if (otherPid === t.targetId) continue;
                    applyEmotionDelta(encounter.players[otherPid], 5);
                  }
                }
              }
              // Death Penalty — CHỈ player (enemy không có profile để trừ). Detect
              // đúng lúc HP chuyển từ >0 sang ≤0 (không trừ lại nếu ĐÃ chết từ trước
              // mà ăn thêm dmg). Logic THẬT nằm ở applyDeathPenalty (dùng CHUNG với
              // K-Corp Ampule dùng 2 lần liên tiếp — xem -encounter useitem).
              //
              // Stage 5 (quest system) — GIỮ NGUYÊN hành vi CŨ cho encounter GM
              // thường (áp NGAY như trước) — nhưng encounter.isQuest thì KHÔNG áp
              // ngay ở đây (xác nhận trực tiếp: "nếu còn người sống và thắng thì
              // cả team vẫn nhận thưởng, người chết rồi KHÔNG phải nhận Death
              // Penalty, chỉ khi cả team chết mới áp") — chỉ TRACK lại ai đã chết,
              // xử lý THẬT SỰ ở checkQuestOutcome cuối hàm (biết được thắng/thua
              // trước khi quyết định có áp Death Penalty hay không).
              let deathNote = "";
              if (justDied && targetResolved.type === "player") {
                if (encounter.isQuest) {
                  encounter.questMeta = encounter.questMeta ?? {};
                  encounter.questMeta.deadPlayerIds = encounter.questMeta.deadPlayerIds ?? [];
                  if (!encounter.questMeta.deadPlayerIds.includes(t.targetId)) {
                    encounter.questMeta.deadPlayerIds.push(t.targetId);
                  }
                } else {
                  deathNote = await applyDeathPenalty(encounter, t.targetId);
                }
              }
              // 5 status "trên người địch" — áp vào TARGET (bên bị tấn công).
              // QUAN TRỌNG (BUG ĐÃ SỬA): TOÀN BỘ status/Stamina/Charge effect dưới
              // đây trước kia áp VÔ ĐIỀU KIỆN từ t.preview (đã tính sẵn lúc DECLARE,
              // TRƯỚC khi biết Guard/Evade/Parry được dùng lúc CONFIRM) — nghĩa là
              // dù target NÉ HOÀN TOÀN (evadedCompletely=true, 0 dmg thật), Sinking/
              // Rupture/Burn/Bleed/Tremor/Defenseless/Convert Physical Trauma VẪN bị
              // áp như thể đòn trúng 100% — vô lý hoàn toàn (né hoàn toàn = không
              // trúng GÌ CẢ, không chỉ riêng HP). Giờ bọc toàn bộ trong
              // !evadedCompletely — NÉ MỘT PHẦN (M1 nhiều hit, evadedCompletely vẫn
              // false) thì status vẫn áp bình thường (đúng — 1 phần đòn vẫn trúng).
              if (!evadedCompletely) {
                target.sinking = t.preview.finalSinking;
                target.rupture = t.preview.finalRupture;
                // QUAN TRỌNG: dùng burnStacksAfter/bleedStacksAfter (giá trị NGAY SAU
                // gain/consume từ dmgStr, TRƯỚC khi calcMathCore áp công thức "cuối
                // turn") — KHÔNG dùng finalBurn/finalBleed (đã bị giảm nửa SẴN, vì
                // calcMathCore coi MỌI lần gọi là "nếu turn kết thúc NGAY bây giờ").
                // Trước đây dùng finalBurn/finalBleed khiến Burn/Bleed bị giảm nửa
                // NGAY SAU MỖI HIT thay vì chỉ 1 lần thật mỗi -encounter endturn — sai
                // hoàn toàn với luật, và làm hỏng cả Break the Dams/Craving Synergy/
                // Thirst (chúng cần biết bleed CHƯA bị giảm khi check điều kiện). Halving
                // THẬT giờ chỉ xảy ra trong advanceCombatantTurn (xem comment ở đó).
                const lastHitForStatus = t.preview.instanceResults[t.preview.instanceResults.length - 1];
                target.burn = lastHitForStatus?.burnStacksAfter ?? target.burn;
                const bleedBeforeThisHit = target.bleed ?? 0;
                let rawNewBleed = bleedOverride ?? (lastHitForStatus?.bleedStacksAfter ?? target.bleed);
                // "Dark Cloud" (outfit, 3+ stack) — xác nhận trực tiếp: "Gây
                // thêm 1.25x Bleed" — CHỈ nhân phần MỚI GÂY THÊM (chênh lệch
                // trước/sau đòn này), không nhân lại toàn bộ stack cũ đã có.
                if (attacker.combatant.equippedOutfit === "Kurokumo Wakashu" && (attacker.combatant.darkCloudOutfitStacks ?? 0) >= 3 && rawNewBleed > bleedBeforeThisHit) {
                  const bleedGainedThisHit = rawNewBleed - bleedBeforeThisHit;
                  rawNewBleed = bleedBeforeThisHit + Math.floor(bleedGainedThisHit * 1.25);
                }
                target.bleed = rawNewBleed;
                // Hemorrhage (xác nhận trực tiếp): "+1 stack MỖI LẦN áp Bleed" —
                // phát hiện bằng cách so sánh Bleed TRƯỚC/SAU đòn này (tăng = có áp
                // Bleed mới). Reset check ("không áp Bleed trong 1 turn") xử lý ở
                // turn-advance.js dựa vào hemorrhageAppliedThisTurn.
                // BUG LUẬT ĐÃ SỬA (Fragaria: "AI Eye Gouger kích Hemorrhage VÔ TỘI
                // VẠ dù không có bất kỳ thứ gì có thể inflict nó").
                // TRƯỚC ĐÂY: hễ Bleed tăng là +1 Hemorrhage, KỂ CẢ khi đang 0 —
                // nên mọi đòn có Bleed đều tự sinh Hemorrhage từ hư không.
                // LUẬT ĐÚNG: phải INFLICT Hemorrhage trước (nguồn riêng, xem
                // sfx.hemorrhage bên dưới) thì mới có; Bleed chỉ TĂNG TIẾN lvl
                // của cái đã có. `> 0` chính là cái gate đã thiếu.
                if (target.bleed > bleedBeforeThisHit && (target.hemorrhage ?? 0) > 0) {
                  target.hemorrhage = Math.min(HEMORRHAGE_MAX, target.hemorrhage + 1);
                  target.hemorrhageAppliedThisTurn = true;
                }
                target.tremor = t.preview.finalTremor;
                // BUG NGHIÊM TRỌNG ĐÃ SỬA (phát hiện qua test thực tế của user
                // — Burn tag "+NBurn" gõ tay hoàn toàn KHÔNG hoạt động) —
                // calcMathCore đã tính đúng finalBurn (bao gồm cả +NBurn tag)
                // từ trước, nhưng index.js CHƯA BAO GIỜ áp dụng nó vào
                // target.burn thật — khác với finalTremor/finalSinking/
                // finalRupture đều đã có sẵn dòng gán tương tự.
                target.burn = t.preview.burnStackAfterHit;
                // "Zwei Association": áp Tremor THẬT ở đây (SAU khi ghi đè từ
                // preview đã chạy xong ở dòng trên) — finalizeReactiveChoice chỉ
                // đánh dấu pending vì áp trực tiếp ở đó sẽ bị ghi đè mất bởi dòng
                // này (chạy SAU, khi resolveOnePendingAction commit thật).
                if (target.zweiAssociationPendingTremor) {
                  target.tremor = Math.min(TREMOR_MAX, (target.tremor ?? 0) + 1);
                  target.zweiAssociationPendingTremor = false;
                }
                // Haou Sinking (xác nhận trực tiếp): "khi có stack... sẽ bị -1
                // sanity và gây bonus dmg bằng số count MỖI ĐÒN chúng bị tấn công
                // TRONG TURN LÚC -45 sanity HOẶC KHÔNG có sanity" — kiểm tra ĐIỀU
                // KIỆN bằng Sanity TRƯỚC khi đòn này ghi đè (currentSanity vẫn là
                // giá trị CŨ tại đây), nhưng ÁP DỤNG SAU khi finalSanity đã ghi
                // (nếu áp trước, dòng currentSanity=finalSanity ngay sau sẽ ghi đè
                // mất — cùng lỗi thứ tự đã gặp với Contempt of the Gaze trước đó).
                const haouSinkingTriggered = (target.haouSinking ?? 0) > 0 && target.currentSanity <= 0;
                target.currentSanity = t.preview.finalSanity;
                if (haouSinkingTriggered) {
                  applyHpLoss(target, target.haouSinking);
                  target.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, target.currentSanity - 1);
                  checkStaggerPanic(target);
                }
                // Tremor Burst rút STAMINA của TARGET (kẻ mang Tremor bị rút Sta).
                if (t.preview.totalTremorStaminaLoss > 0) {
                  target.currentStamina = Math.max(0, target.currentStamina - t.preview.totalTremorStaminaLoss);
                }
                // Tremor Decay/Chain: "giảm 1 count mỗi khi nhận đòn có Tremor
                // Burst" — trừ THẬT theo số lần Tremor Burst thực sự kích hoạt
                // trong đòn này (totalTremorDecayConsumed/totalTremorChainConsumed
                // từ calcMathCore — xem damage-calc.js).
                if ((t.preview.totalTremorDecayConsumed ?? 0) > 0) {
                  target.tremorDecay = Math.max(0, (target.tremorDecay ?? 0) - t.preview.totalTremorDecayConsumed);
                }
                if ((t.preview.totalTremorChainConsumed ?? 0) > 0) {
                  target.tremorChain = Math.max(0, (target.tremorChain ?? 0) - t.preview.totalTremorChainConsumed);
                }
                // Haou Rupture (xác nhận trực tiếp): "Mỗi lần địch chịu 1 đòn tấn
                // công sẽ trừ 1 stack NẾU resistance thấp hơn 1.5x Res" — chỉ tiêu
                // khi thực sự có tác dụng (đã xác định ở preview qua haouRuptureApplied).
                if (t.haouRuptureApplied) {
                  target.haouRupture = Math.max(0, (target.haouRupture ?? 0) - 1);
                }
                // Defenseless (perk của ATTACKER): gây dmg lên target ĐANG có Rupture → -5 Stamina target.
                if (hasPerk(attacker.combatant, "Defenseless") && hadRuptureBeforeHit) {
                  target.currentStamina = Math.max(0, target.currentStamina - 5);
                }
                // Convert Physical Trauma (perk của TARGET/defender): bị tấn công trúng → +1 Charge.
                if (hasPerk(target, "Convert Physical Trauma")) {
                  // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — "WARP
                  // Corp. Cleaner": "Gia tăng 1.5x hiệu quả nhận Charge của bản
                  // thân" — áp dụng cho MỌI nguồn Charge người đó tự nhận (không
                  // phải nhận HỘ ai khác).
                  const cptGain = target.hasWarpCorpCleaner ? Math.round(1 * 1.5) : 1;
                  target.charge = Math.min(CHARGE_MAX, target.charge + cptGain);
                }
                // Charge Shield (50-Status Nhóm 1) — "biến mất sau mỗi khi bị tấn
                // công" — reset về 0 NGAY SAU KHI đã phát huy tác dụng (đã cộng vào
                // defReductionPct ở trên, TRONG khối !evadedCompletely — né hoàn
                // toàn thì coi như CHƯA thực sự "bị tấn công", giữ nguyên Charge
                // Shield cho lần sau, nhất quán với mọi status khác trong khối này).
                if ((target.chargeShieldStack ?? 0) > 0) target.chargeShieldStack = 0;
                // Charge Shield (50-Status Nhóm 1): "Biến mất sau MỖI KHI bị tấn
                // công" — TOÀN BỘ stack reset về 0 (không phải trừ dần từng đòn),
                // ngay sau khi ĐÃ dùng để giảm dmg đòn NÀY (defReductionPct ở trên
                // đã tính bằng giá trị TRƯỚC khi reset). Nằm trong !evadedCompletely
                // — né hoàn toàn thì không tính là "bị tấn công", Charge Shield giữ
                // nguyên.
                if ((target.chargeShieldStack ?? 0) > 0) target.chargeShieldStack = 0;
                // Eye Of Horus — COMMIT THẬT (khác PEEK lúc declare trong
                // computeAttackerPerkContext) — áp Tremor/Charge KHI action THỰC SỰ
                // được confirm (không phải declare) VÀ KHÔNG bị né hoàn toàn (nằm
                // trong khối !evadedCompletely — "đánh thường" né hoàn toàn thì
                // không tính là đã đánh, nhất quán với mọi status effect khác trong
                // khối này).
                // MÔ HÌNH MỚI (xác nhận trực tiếp, 8 ví dụ N=1..8) — KHÔNG còn
                // counter m1CountThisTurnByTarget nữa (N giờ luôn được cung cấp trực
                // tiếp mỗi hành động, không cộng dồn qua nhiều lần bấm riêng biệt).
                // Tremor gắn lên target (KẺ ĐỊCH), Charge gắn lên bản thân (resource
                // người dùng vũ khí) — amount đã tính SẴN đúng theo N ở
                // computeAttackerPerkContext (2 × tổng số volley thật, bao gồm cả
                // volley Repeat Ammo nếu có).
                if (t.eyeOfHorusTremorChargeAmount > 0 && attacker.type === "player") {
                  target.tremor = Math.min(TREMOR_MAX, (target.tremor ?? 0) + t.eyeOfHorusTremorChargeAmount);
                  eyeOfHorusChargeGainedThisAction += t.eyeOfHorusTremorChargeAmount;
                }
                // GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3 — ghi THẬT per-target hit count
                // lúc COMMIT (không phải lúc declare) — khớp nguyên tắc "chưa gì
                // là thật cho tới khi GM xác nhận", giống staminaCost/eyeOfHorusAmmo.
                if (t.eyeOfHorusNewCount !== null && t.eyeOfHorusNewCount !== undefined && attacker.type === "player") {
                  attacker.combatant.eyeOfHorusTargetHitCounts = attacker.combatant.eyeOfHorusTargetHitCounts ?? {};
                  attacker.combatant.eyeOfHorusTargetHitCounts[t.targetId] = t.eyeOfHorusNewCount;
                }
                // Nails (50-Status Nhóm 2, xác nhận trực tiếp): "mỗi đòn kẻ thù
                // NHẬN sẽ nhận thêm số Bleed bằng số count Nails, mỗi lần nhận 1
                // đòn giảm 1/3 count Nails" — 1 ĐÒN (action), không phải mỗi hit —
                // dùng floor(count/3) theo đúng nghĩa đen "1/3 số count" (count
                // nhỏ 1-2 sẽ chưa giảm cho tới khi tích đủ 3, chấp nhận được vì
                // không có mô tả riêng cho trường hợp nhỏ).
                if ((target.nails ?? 0) > 0) {
                  target.bleed = Math.min(BLEED_MAX, (target.bleed ?? 0) + target.nails);
                  target.nails = Math.max(0, target.nails - Math.floor(target.nails / 3));
                }
                // Red Plum Blossom (50-Status Nhóm 2, xác nhận trực tiếp): "nếu
                // Critical sẽ gắn 1 Bleed lên kẻ địch [mang Red Plum Blossom],
                // giảm 1 Count" — dùng lastHitForStatus.didCrit (đòn CUỐI của
                // action này — nhất quán với cách đọc burn/bleed stacks ở trên).
                if ((target.redPlumBlossom ?? 0) > 0 && lastHitForStatus?.didCrit) {
                  target.bleed = Math.min(BLEED_MAX, (target.bleed ?? 0) + 1);
                  target.redPlumBlossom = Math.max(0, target.redPlumBlossom - 1);
                }
                // "Blade Lineage Salsu" (outfit) — GAP MỚI (xác nhận trực tiếp):
                // "Khi Crit bạn gây 1 Red Plum Blossom lên kẻ địch, nếu có hơn
                // hoặc bằng 5 Red Plum Blossom thì sẽ gây 1 Bleed" — CƠ CHẾ
                // KHÁC với khối ngay trên (khối trên TIÊU redPlumBlossom CÓ
                // SẴN, không điều kiện ngưỡng — đây là GÂY THÊM mỗi Crit, CHỈ
                // Bleed khi đạt ngưỡng 5, rồi reset về 0 để tích luỹ lại).
                // Đặt SAU khối trên để tránh bị khối trên tiêu ngay trong cùng
                // vòng lặp.
                if (attacker.combatant.equippedOutfit === "Blade Lineage Salsu" && lastHitForStatus?.didCrit) {
                  target.redPlumBlossom = (target.redPlumBlossom ?? 0) + 1;
                  if (target.redPlumBlossom >= 5) {
                    target.bleed = Math.min(BLEED_MAX, (target.bleed ?? 0) + 1);
                    target.redPlumBlossom = 0;
                  }
                }
                // Fairy (50-Status Nhóm 2, xác nhận trực tiếp): "trừ HP = count/3
                // MỖI Action" — giả định (đã nêu ở combatant-factory.js): "mỗi
                // Action" = mỗi lần CHÍNH attacker (người mang Fairy) hành động —
                // tự trừ HP BẢN THÂN, KHÔNG liên quan tới target đang đánh. Đặt
                // trong loop targets.map nên với AOE nhiều target CÙNG 1 action sẽ
                // CHỈ tính đúng 1 lần cho action đó — kiểm tra targetIdx===0 để
                // tránh trừ lặp lại theo số target.
                if (p.targets.indexOf(t) === 0 && (attacker.combatant.fairy ?? 0) > 0) {
                  applyHpLoss(attacker.combatant, Math.floor(attacker.combatant.fairy / 3));
                }
                // Ammo system — Frost/Incendiary Ammo (xác nhận trực tiếp): "Frost
                // Ammo: gây 1 Paralyze. Incendiary Ammo: gây 2 Burn." — áp lên
                // TARGET đang bị bắn, CHỈ khi đòn thực sự trúng (không evaded hoàn
                // toàn — kiểm tra ở ngoài khối này qua !evadedCompletely).
                if (p.effectiveAmmoType === "frost") {
                  target.paralyze = Math.min(99, (target.paralyze ?? 0) + 1);
                } else if (p.effectiveAmmoType === "incendiary") {
                  target.burn = Math.min(BURN_MAX, (target.burn ?? 0) + 2);
                }
                // bulletStack system (Soldato Rifle's "Firing" passive) — CÙNG
                // hiệu ứng phụ Frost/Incendiary như trên nhưng cho pool RIÊNG
                // (bulletStack, không phải ammo/frostAmmo/incendiaryAmmo).
                // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp): "2 hit đầu tôi
                // né và 2 hit sau tôi chịu đòn sẽ bị dính 8 burn, dù né rồi vẫn
                // dính hiệu ứng" — TRƯỚC ĐÂY nhân CỐ ĐỊNH theo effectiveBulletCount
                // (tổng số hit CÓ DÙNG đạn khi build dmgStr), hoàn toàn không
                // kiểm tra per-hit hit nào trong số đó THẬT SỰ trúng — chỉ được
                // gate bởi !evadedCompletely (all-or-nothing: chỉ chặn nếu
                // TOÀN BỘ hit đều né, mix 2 né + 2 trúng vẫn lọt qua với FULL
                // effectiveBulletCount). Giờ đếm ĐÚNG số hit "có đạn" (trong
                // phạm vi 0..effectiveBulletCount-1, theo đúng thứ tự build
                // dmgStr — phần "có đạn" luôn xây TRƯỚC phần cận chiến) mà
                // perHitMult > 0 (THẬT SỰ trúng — Guard tính, Evade/Parry thành
                // công KHÔNG tính, đúng luật đã xác nhận), nhân hiệu ứng theo
                // SỐ ĐÓ thay vì effectiveBulletCount cố định.
                const bulletedHitsLanded = (p.effectiveBulletCount ?? 0) > 0
                  ? (perHitMultForBulletEffect ?? []).slice(0, p.effectiveBulletCount).filter(m => m > 0).length
                  : 0;
                if (p.effectiveBulletType === "frost" && bulletedHitsLanded > 0) {
                  target.paralyze = Math.min(99, (target.paralyze ?? 0) + 1 * bulletedHitsLanded);
                } else if (p.effectiveBulletType === "incendiary" && bulletedHitsLanded > 0) {
                  target.burn = Math.min(BURN_MAX, (target.burn ?? 0) + 2 * bulletedHitsLanded);
                }
                // Set Fire (Page): "đòn đánh thường sẽ áp 1/2/4 [Light/Medium/Heavy]
                // Burn... mỗi lần trúng" — CHỈ áp cho M1 (p.isM1), KHÔNG áp cho Page/
                // skill khác. BUG ĐÃ SỬA: "mỗi lần trúng" nghĩa là MỖI HIT (không
                // phải mỗi ACTION) — code cũ chỉ cộng burnAmount ĐÚNG 1 LẦN dù M1 có
                // bao nhiêu hit (vì nằm trong for loop TARGET, không phải loop HIT) —
                // giống lớp bug tôi từng sửa cho Eye Of Horus's Repeat Ammo — giờ
                // nhân theo hitCount (số hit THẬT của target này trong action). Nằm
                // trong khối !evadedCompletely — né hoàn toàn thì không tính là đã
                // đánh trúng, không áp Burn (nhất quán với mọi status effect khác).
                if (p.isM1 && attacker.type === "player" && (attacker.combatant.setFireTurnsLeft ?? 0) > 0) {
                  const burnPerHit = { light: 1, medium: 2, heavy: 4 }[attacker.combatant.weaponWeight] ?? 1;
                  target.burn = Math.min(BURN_MAX, (target.burn ?? 0) + burnPerHit * hitCount);
                }
              }
              checkStaggerPanic(target);
              // BUG ĐÃ SỬA (xác nhận trực tiếp): "Điều kiện Injury là 1 HIT phải
              // vượt qua 30% Max HP" — trước đây SO SÁNH SAI: dùng `finalDmg`
              // (TỔNG cả đòn, gồm nhiều hit) thay vì TỪNG HIT RIÊNG LẺ — VD "3x10"
              // (10 hit, mỗi hit 3 dmg) lên target 60 HP: finalDmg=30 (>18=30%
              // MaxHp) → SAI trigger Injury dù mỗi hit CHỈ 3 dmg (thấp hơn NHIỀU
              // so với 18). Đúng phải lấy dmg hit LỚN NHẤT trong đòn này để so
              // sánh — nếu KHÔNG có hit nào đơn lẻ vượt ngưỡng, dù tổng cả đòn có
              // lớn tới đâu vẫn KHÔNG trigger.
              const maxSingleHitDmg = Math.max(0, ...(t.preview.instanceResults ?? []).map(r => r.instanceDmg ?? 0));
              const injuryGained = (killNote || deathNote) ? null : rollInjury(target, maxSingleHitDmg);
              const injuryNote = injuryGained ? ` 🩻**${injuryGained}**` : "";
              // Injury Persistence — sync NGAY vào profile mỗi khi player nhận chấn
              // thương MỚI (giống cách HP sync ở trên) — không đợi -encounter end,
              // tránh mất dữ liệu nếu trận bị bỏ dở/quên end.
              if (injuryGained && targetResolved.type === "player") {
                try {
                  const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(t.targetId);
                  injSyncData.injuries = [...target.injuries];
                  await savePlayerData(t.targetId, injSyncData, injSyncSlot);
                } catch { /* không chặn action chính nếu sync injury lỗi */ }
              }
              targetDmgLines.push(`${targetResolved.label} -${finalDmg.toFixed(3)} HP${killNote}${deathNote}${defenseNote}${perkNote}${injuryNote}${eyeOfHorusNote}${fragileNote}${karmicNote}${smokeNote}${chargeShieldNote}${protectionNote}${shieldHpNote}${renegadeNote}${dieciSinkingNote}${liuAssociationNote}${regenHealNote}${timeMoratoriumNote}${paybackNote}`);
              if (!evadedCompletely) anyHitLandedThisAction = true; // gom kết quả từng target ra scope ngoài (xem khai báo)
            }
            // 2 status "trên bản thân" — áp vào ATTACKER. Với AOE (nhiều target),
            // mỗi target preview tính crit ĐỘC LẬP nên finalPoiseStacks/finalCharge
            // có thể khác nhau giữa các target — LẤY target ĐẦU TIÊN làm đại diện
            // (đơn giản hoá có chủ đích, vì luật không nói rõ Poise tính sao khi 1
            // swing AOE trúng nhiều địch — báo với GM nếu cần khác đi).
            if (p.targets.length > 0) {
              const firstPreview = p.targets[0].preview;
              // Smoke Overload: crit trúng KHÔNG giảm Poise ngay — dồn lại
              // (poiseReductionPending), trừ thật lúc end turn (xem advanceCombatantTurn).
              // Tính phần ĐÃ bị calcMathCore giảm (poiseAfterGain - poiseStacksAfter
              // mỗi hit có crit) rồi CỘNG TRẢ LẠI cho Poise ngay bây giờ, dồn phần đó
              // vào pending để trừ sau — thay vì sửa calcMathCore (tránh đụng logic
              // dùng chung cho /math thường).
              if (hasPerk(attacker.combatant, "Smoke Overload")) {
                const totalReducedThisAction = firstPreview.instanceResults.reduce(
                  (sum, r) => sum + Math.max(0, (r.poiseAfterGain ?? 0) - (r.poiseStacksAfter ?? 0)), 0
                );
                attacker.combatant.poise = Math.min(POISE_MAX, firstPreview.finalPoiseStacks + totalReducedThisAction);
                attacker.combatant.poiseReductionPending = (attacker.combatant.poiseReductionPending ?? 0) + totalReducedThisAction;
              } else {
                attacker.combatant.poise = firstPreview.finalPoiseStacks;
              }
              // "Blade Lineage" (outfit) — GAP FIX (đặt SAU dòng ghi đè poise ở
              // trên, vì bất kể "Smoke Overload" hay không, dòng đó LUÔN chạy
              // và sẽ xoá mất +2 nếu đặt TRƯỚC nó) — GAP MỚI (xác nhận trực
              // tiếp): "Mỗi khi kẻ địch block đòn đánh của bạn, bạn nhận được
              // 2 Poise" — trigger khi có hit bị Guard (perHitMult giảm nhưng
              // không về 0, khác Evade/Parry thành công).
              if (attacker.combatant.equippedOutfit === "Blade Lineage" && (perHitMultForBulletEffect ?? []).some(m => m > 0 && m < 1)) {
                attacker.combatant.poise = Math.min(POISE_MAX, (attacker.combatant.poise ?? 0) + 2);
              }
              attacker.combatant.charge = firstPreview.finalCharge;
              // Eye Of Horus — cộng THÊM (không ghi đè) SAU dòng gán finalCharge ở
              // trên — xem comment đầy đủ tại chỗ khai báo eyeOfHorusChargeGainedThisAction.
              if (eyeOfHorusChargeGainedThisAction > 0) {
                // "WARP Corp. Cleaner": 1.5x hiệu quả nhận Charge của bản thân.
                const eohChargeFinal = attacker.combatant.hasWarpCorpCleaner ? Math.round(eyeOfHorusChargeGainedThisAction * 1.5) : eyeOfHorusChargeGainedThisAction;
                attacker.combatant.charge = Math.min(CHARGE_MAX, attacker.combatant.charge + eohChargeFinal);
              }
            }
            // Bleed — "1 bleed count trên người địch sẽ gây dmg bằng 1/4 count mỗi
            // khi kẻ địch hành động tấn công trong turn" — áp dụng cho CHÍNH người
            // ĐANG TẤN CÔNG (attacker) ở action này, nếu HỌ đang mang Bleed — không
            // liên quan gì tới target. Áp dụng cho MỌI loại tấn công (attack/hit/
            // enemyattack), KHÔNG riêng M1, vì luật chỉ nói "hành động tấn công" nói
            // chung. Count KHÔNG đổi ở đây (chỉ giảm nửa lúc end turn thật).
            // Bleed — GAP ĐÃ SỬA HOÀN TOÀN (xác nhận trực tiếp qua ví dụ số học:
            // "kẻ địch có 12 bleed... Critical tổng 3 hit và 7 hit m1 thì tổng
            // chúng sẽ mất 30 HP [đã sửa từ 40 — tính nhầm]... mỗi hit riêng
            // biệt, trigger bleed dmg = stack bleed / 4 mỗi lần kẻ địch tung ra
            // 1 hit tấn công") — TRƯỚC ĐÂY chỉ trigger 1 LẦN DUY NHẤT mỗi hành
            // động (bất kể hành động đó có bao nhiêu hit) — SAI, đúng luật là
            // MỖI HIT RIÊNG kích hoạt formula riêng (nhân trực tiếp với
            // totalHitsThisActionAny — đã tính đúng "tổng số hit ĐÃ TUNG RA"
            // của hành động, không phụ thuộc né/guard/parry của target, và tự
            // nhiên = 0 cho hành động thuần buff không target thật như Light
            // Dash Page — khớp đúng "page/critical chỉ thuần hiệu ứng không có
            // tấn công... không phải nhận dmg từ bleed"). Guard/Evade/Parry
            // của CHÍNH bleed-holder (khi họ đang phòng thủ, không tấn công)
            // tự động không qua nhánh này vì đó là 1 luồng xử lý hoàn toàn
            // khác (finalizeReactiveChoice/encreactivedef, không phải
            // resolveOnePendingAction với attacker=bleed-holder).
            let bleedSelfNote = "";
            if ((attacker.combatant.bleed ?? 0) > 0 && totalHitsThisActionAny > 0) {
              // Sizzling Wound: "+50% Dmg từ Burn và Bleed" — nhân vào đây tương tự Burn.
              // Hemorrhage (xác nhận trực tiếp): "Bleed khi gây dmg sẽ /3|/2|x1|
              // x1.5|x2" theo tier 1-5 — nhân thêm vào công thức Bleed tự gây dmg.
              const HEMORRHAGE_BLEED_MULT = { 0: 1, 1: 1 / 3, 2: 1 / 2, 3: 1, 4: 1.5, 5: 2 };
              const hemorrhageMult = HEMORRHAGE_BLEED_MULT[attacker.combatant.hemorrhage ?? 0] ?? 1;
              const bleedSelfDmgPerHit = Math.floor((attacker.combatant.bleed / 4) * (attacker.combatant.sizzlingWound ? 1.5 : 1) * hemorrhageMult);
              const bleedSelfDmg = bleedSelfDmgPerHit * totalHitsThisActionAny;
              if (bleedSelfDmg > 0) {
                applyHpLoss(attacker.combatant, bleedSelfDmg);
                checkStaggerPanic(attacker.combatant);
                bleedSelfNote = ` [🩸Bleed tự gây ${bleedSelfDmgPerHit} dmg × ${totalHitsThisActionAny} hit = ${bleedSelfDmg} dmg lên ${attacker.label}]`;
              }
            }
            // Haou Bleed (xác nhận trực tiếp): "Gây Dmg cho kẻ địch dựa vào số
            // count mỗi khi CHÚNG hành động" — tự gây dmg = FULL count (KHÔNG /4
            // như Bleed thường, mô tả gốc không nhắc chia) — CÙNG SỬA per-hit
            // như Bleed thường ở trên (nhân totalHitsThisActionAny).
            if ((attacker.combatant.haouBleed ?? 0) > 0 && totalHitsThisActionAny > 0) {
              const haouBleedSelfDmg = attacker.combatant.haouBleed * totalHitsThisActionAny;
              applyHpLoss(attacker.combatant, haouBleedSelfDmg);
              checkStaggerPanic(attacker.combatant);
              bleedSelfNote += ` [🩸Haou Bleed tự gây ${attacker.combatant.haouBleed} dmg × ${totalHitsThisActionAny} hit = ${haouBleedSelfDmg} dmg lên ${attacker.label}]`;
            }
            // Battle Ignition/Overbearing/Blessed Sparks: đếm M1 (chỉ attack mới có
            // p.isM1=true, hit/Page không tính). 2 counter TÁCH BIỆT, đếm KHÁC kiểu:
            //   - attacksThisTurn (Battle Ignition, "đánh kẻ địch ≥10 LẦN"): đếm theo
            //     HIT THẬT (xác nhận trực tiếp từ GM) — dùng totalHitsThisAction (tích
            //     luỹ TRONG vòng for ở trên, qua MỌI target nếu AOE) — BUG ĐÃ SỬA 2
            //     LẦN: (1) trước đây +1 mỗi LƯỢT TARGET trong vòng lặp thay vì +N hit
            //     thật; (2) lần sửa đầu tiên dùng biến `hitCount` nhưng đặt code Ở
            //     NGOÀI scope của vòng for (const t of p.targets) — gây lỗi runtime
            //     "hitCount is not defined" mỗi lần confirm M1 — giờ dùng
            //     totalHitsThisAction (khai báo TRƯỚC vòng for, cộng dồn ĐÚNG TRONG
            //     vòng for, đọc lại AN TOÀN ở NGOÀI vòng for).
            //   - m1AttackCount (Overbearing/Blessed Sparks, "mỗi đòn đánh thường thứ
            //     2"): GIỮ NGUYÊN đếm theo ACTION (+1/toàn action, không nhân theo
            //     target/hit) — luật dùng từ "đòn" (1 lượt ra tay), KHÁC "lần" của
            //     Battle Ignition, và KHÔNG được GM xác nhận đổi sang hit-based, nên
            //     giữ behavior cũ.
            // PHẢI ĐẶT SAU khối gán Poise/Charge từ preview phía trên — trước đây đặt
            // TRƯỚC nên bị preview ghi đè mất ngay, Overbearing/Blessed Sparks không
            // bao giờ thấy hiệu lực thật.
            if (p.isM1 && attacker.type === "player") {
              attacker.combatant.attacksThisTurn = (attacker.combatant.attacksThisTurn ?? 0) + totalHitsThisAction;
              attacker.combatant.m1AttackCount = (attacker.combatant.m1AttackCount ?? 0) + 1;
              if (attacker.combatant.m1AttackCount % 2 === 0) {
                const poiseGain = { light: 1, medium: 2, heavy: 4 }[attacker.combatant.weaponWeight];
                if (hasPerk(attacker.combatant, "Overbearing")) {
                  attacker.combatant.poise = Math.min(POISE_MAX, attacker.combatant.poise + poiseGain);
                }
                if (hasPerk(attacker.combatant, "Blessed by the Sparks")) {
                  // "WARP Corp. Cleaner": 1.5x hiệu quả nhận Charge của bản thân.
                  const bsChargeFinal = attacker.combatant.hasWarpCorpCleaner ? Math.round(poiseGain * 1.5) : poiseGain;
                  attacker.combatant.charge = Math.min(CHARGE_MAX, attacker.combatant.charge + bsChargeFinal);
                }
              }
              // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 2) —
              // "Shi" (Shi Association Katana): 4 đòn đánh thường → +4 Poise cho
              // BẢN THÂN. "Fire" (Liu Martial Arts/Liu Guan Dao): 2 đòn đánh thường
              // → +1 Burn lên TẤT CẢ target của đòn này (không phải bản thân).
              const currentWeaponInfo = findWeaponAnywhere(attacker.combatant.weaponName);
              const weaponMechanics = (currentWeaponInfo?.passives ?? []).map(pa => pa.mechanicId).filter(Boolean);
              if (weaponMechanics.includes("shi_poise") && attacker.combatant.m1AttackCount % 4 === 0) {
                attacker.combatant.poise = Math.min(POISE_MAX, (attacker.combatant.poise ?? 0) + 4);
                resultLines.push(`⚔️ **Shi** — ${attacker.label} nhận 4 Poise (đòn đánh thường thứ ${attacker.combatant.m1AttackCount}).`);
              }
              if (weaponMechanics.includes("fire_burn") && attacker.combatant.m1AttackCount % 2 === 0) {
                for (const t of p.targets) {
                  const tResolved = resolveCombatant(encounter, t.targetId);
                  if (tResolved) tResolved.combatant.burn = Math.min(99, (tResolved.combatant.burn ?? 0) + 1);
                }
                resultLines.push(`🔥 **Fire** — ${attacker.label} gắn 1 Burn lên mục tiêu (đòn đánh thường thứ ${attacker.combatant.m1AttackCount}).`);
              }
              // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 5) —
              // "Grasping Vulnerabilities" (Seven Association Longsword): 2 đòn
              // đánh thường → +1 Rupture lên TẤT CẢ target.
              if (weaponMechanics.includes("grasping_vulnerabilities") && attacker.combatant.m1AttackCount % 2 === 0) {
                // "Seven Association": 1.5x hiệu quả áp Rupture — attacker là người GẮN.
                const gvRupture = attacker.combatant.hasSevenAssociation ? Math.round(1 * 1.5) : 1;
                for (const t of p.targets) {
                  const tResolved = resolveCombatant(encounter, t.targetId);
                  if (tResolved) tResolved.combatant.rupture = Math.min(99, (tResolved.combatant.rupture ?? 0) + gvRupture);
                }
                resultLines.push(`⚔️ **Grasping Vulnerabilities** — ${attacker.label} gắn ${gvRupture} Rupture lên mục tiêu (đòn đánh thường thứ ${attacker.combatant.m1AttackCount}).`);
              }
              // "Charging" (WARP Corp. Dagger/Gauntlets): 4 đòn đánh thường →
              // +1 Charge cho BẢN THÂN.
              if (weaponMechanics.includes("warp_charging") && attacker.combatant.m1AttackCount % 4 === 0) {
                // "WARP Corp. Cleaner": 1.5x hiệu quả nhận Charge của bản thân.
                const chargingGain = attacker.combatant.hasWarpCorpCleaner ? Math.round(1 * 1.5) : 1;
                attacker.combatant.charge = Math.min(CHARGE_MAX, (attacker.combatant.charge ?? 0) + chargingGain);
                resultLines.push(`⚡ **Charging** — ${attacker.label} nhận ${chargingGain} Charge (đòn đánh thường thứ ${attacker.combatant.m1AttackCount}).`);
              }
              // "Blue Reverberation Ensemble" (L'Heure du Loup/Yesterday's
              // Promise): 4 đòn đánh thường → +1 Tremor lên TẤT CẢ target.
              if (weaponMechanics.includes("blue_reverberation") && attacker.combatant.m1AttackCount % 4 === 0) {
                for (const t of p.targets) {
                  const tResolved = resolveCombatant(encounter, t.targetId);
                  if (tResolved) tResolved.combatant.tremor = Math.min(99, (tResolved.combatant.tremor ?? 0) + 1);
                }
                resultLines.push(`💧 **Blue Reverberation Ensemble** — ${attacker.label} gắn 1 Tremor lên mục tiêu (đòn đánh thường thứ ${attacker.combatant.m1AttackCount}).`);
              }
              // "Blue Reverberation Ensemble Leader" (Reverberation Scythe):
              // phần "3 đòn đánh thường → +1 Tremor" — phần "Critical → +5
              // Sanity" xử lý riêng ở block Knowledge-style bên dưới.
              if (weaponMechanics.includes("blue_reverberation_leader") && attacker.combatant.m1AttackCount % 3 === 0) {
                for (const t of p.targets) {
                  const tResolved = resolveCombatant(encounter, t.targetId);
                  if (tResolved) tResolved.combatant.tremor = Math.min(99, (tResolved.combatant.tremor ?? 0) + 1);
                }
                resultLines.push(`💧 **Blue Reverberation Ensemble Leader** — ${attacker.label} gắn 1 Tremor lên mục tiêu (đòn đánh thường thứ ${attacker.combatant.m1AttackCount}).`);
              }
              // "Thumb Soldato" (outfit, không phải weapon mechanic) — GAP SỬA
              // LẦN 4 (xác nhận trực tiếp): "cho nhận đạn vào inventory, chứ
              // không phải là nạp thẳng giùm vào súng, nếu cho đạn thẳng vào
              // súng thì dễ bị bug do nó là đạn thường trong khi bản thân đang
              // xài đạn incendiary" — TRƯỚC ĐÂY cộng thẳng vào bulletStack
              // (SAI, xung đột nếu súng đang khoá loại khác qua
              // bulletStackType) — giờ cộng vào Inventory (profileData.items
              // ["Ammo"], LUÔN là loại thường bất kể đang dùng loại gì) — player
              // tự Reload lại sau như đạn Inventory bình thường. CHỈ áp cho
              // player (attacker.type — enemy không có Inventory/profileData).
              // "Blade Lineage" (outfit) — GAP MỚI (xác nhận trực tiếp): "Bạn
              // nhận được 3 Poise mỗi khi dùng Page" — CHỈ áp cho skill/Page
              // (không phải M1, kiểm tra !p.isM1).
              if (attacker.combatant.hasThumbSoldato && attacker.type === "player" && p.staminaCost > 0) {
                attacker.combatant.thumbSoldatoStaminaAccum = (attacker.combatant.thumbSoldatoStaminaAccum ?? 0) + p.staminaCost;
                const ammoGained = Math.floor(attacker.combatant.thumbSoldatoStaminaAccum / 40);
                if (ammoGained > 0) {
                  attacker.combatant.thumbSoldatoStaminaAccum -= ammoGained * 40;
                  const { data: profileDataThumb, slot: thumbSlot } = await getPlayerDataWithSlot(p.attackerId);
                  profileDataThumb.items = profileDataThumb.items ?? {};
                  profileDataThumb.items["Ammo"] = (profileDataThumb.items["Ammo"] ?? 0) + ammoGained;
                  await savePlayerData(p.attackerId, profileDataThumb, thumbSlot);
                  resultLines.push(`🔫 **Thumb Soldato** — ${attacker.label} nhận +${ammoGained} Ammo vào Inventory (hiện có ${profileDataThumb.items["Ammo"]}) — dùng Reload để nạp vào súng.`);
                }
              }
              // "The Middle Little/Big Sibling" (outfit) — GAP MỚI (xác nhận
              // trực tiếp, làm rõ lại): "mỗi khi 20 stamina tiêu hao qua đánh
              // thường thì nhận được 1 Stack Enhancement Tattoos, chứ không
              // phải là nhận thêm light" — CÙNG pattern accumulator với Thumb
              // Soldato (ngưỡng 20 thay vì 40) — reset lại 2 Turn mỗi lần được
              // cộng thêm stack (không cộng dồn thời hạn).
              if ((attacker.combatant.equippedOutfit === "The Middle Little Sibling" || attacker.combatant.equippedOutfit === "The Middle Big Sibling") && p.staminaCost > 0) {
                attacker.combatant.enhancementTattoosStaminaAccum = (attacker.combatant.enhancementTattoosStaminaAccum ?? 0) + p.staminaCost;
                const stackGained = Math.floor(attacker.combatant.enhancementTattoosStaminaAccum / 20);
                if (stackGained > 0) {
                  attacker.combatant.enhancementTattoosStaminaAccum -= stackGained * 20;
                  attacker.combatant.enhancementTattoosStack = (attacker.combatant.enhancementTattoosStack ?? 0) + stackGained;
                  attacker.combatant.enhancementTattoosTurnsLeft = 2;
                  resultLines.push(`💉 **Enhancement Tattoos** — ${attacker.label} nhận +${stackGained} stack (tổng ${attacker.combatant.enhancementTattoosStack}).`);
                }
              }
              // "Liu Association" ĐÃ DI CHUYỂN ra khỏi block if (p.isM1) này —
              // xem ngay bên dưới (sau block M1-count kết thúc) — passive gốc
              // KHÔNG giới hạn "chỉ M1", nên phải kiểm tra cho MỌI loại hành động.
              // "Pointillist's Uniform" (outfit) — GAP MỚI (xác nhận trực tiếp):
              // "Mỗi khi đánh thường bạn nhận được 1 Sanity tương ứng với mỗi 1
              // hiệu ứng bất lợi khác nhau kẻ địch có trên người" — đếm SỐ LOẠI
              // debuff KHÁC NHAU (không phải tổng stack) đang có trên target,
              // cộng đúng số đó vào Sanity của attacker.
              if (attacker.combatant.equippedOutfit === "Pointillist's Uniform" && p.isM1) {
                const DEBUFF_FIELDS_TO_COUNT = ["bleed", "rupture", "sinking", "tremor", "burn", "paralyze", "hemorrhage", "fragile", "attackPowerDown", "defenseDown", "diceDown", "smoke", "nails", "bind", "haouFlame", "haouBleed", "haouTremor", "haouRupture", "haouSinking"];
                for (const t of p.targets) {
                  const tResolved = resolveCombatant(encounter, t.targetId);
                  if (!tResolved) continue;
                  const debuffTypeCount = DEBUFF_FIELDS_TO_COUNT.filter(f => (tResolved.combatant[f] ?? 0) > 0).length;
                  if (debuffTypeCount > 0) {
                    attacker.combatant.currentSanity = Math.min(attacker.combatant.maxSanity, (attacker.combatant.currentSanity ?? 0) + debuffTypeCount);
                    resultLines.push(`🎨 **Pointillist's Uniform** — ${attacker.label} nhận ${debuffTypeCount} Sanity (${debuffTypeCount} loại debuff trên ${tResolved.label}).`);
                  }
                }
              }
              // "Dieci Association": áp Sinking THẬT ở đây (sau khi target.sinking
              // = t.preview.finalSinking đã ghi đè xong ở vòng lặp target chính) —
              // dieciSinkingGain đã tính sẵn ở đầu hàm (xem block shieldHp).
              if (dieciSinkingGain > 0) {
                for (const t of p.targets) {
                  const tResolved = resolveCombatant(encounter, t.targetId);
                  if (tResolved) tResolved.combatant.sinking = Math.min(99, (tResolved.combatant.sinking ?? 0) + dieciSinkingGain);
                }
                resultLines.push(`🌀 **Dieci Association** — ${attacker.label} gắn ${dieciSinkingGain} Sinking lên mục tiêu.`);
              }
              // "Dark Cloud" (outfit, 6+ stack) — áp "nổ" Bleed THẬT ở đây,
              // cùng lý do/vị trí với Dieci Association ở trên. Dùng CÔNG THỨC
              // giống bleedSelfDmg (count/4 * Hemorrhage/Sizzling Wound) nhưng
              // áp lên chính TARGET's Bleed count (không phải attacker's), và
              // KHÔNG trừ count Bleed của target (chỉ "kích hoạt", không tiêu).
              if (darkCloudExplodeGain > 0) {
                const HEMORRHAGE_BLEED_MULT_DC = { 0: 1, 1: 1 / 3, 2: 1 / 2, 3: 1, 4: 1.5, 5: 2 };
                for (const t of p.targets) {
                  const tResolved = resolveCombatant(encounter, t.targetId);
                  if (!tResolved || (tResolved.combatant.bleed ?? 0) <= 0) continue;
                  const dcTarget = tResolved.combatant;
                  const dcHemMult = HEMORRHAGE_BLEED_MULT_DC[dcTarget.hemorrhage ?? 0] ?? 1;
                  const dcExplodeDmgPerHit = Math.floor((dcTarget.bleed / 4) * (dcTarget.sizzlingWound ? 1.5 : 1) * dcHemMult);
                  const dcTotalDmg = dcExplodeDmgPerHit * darkCloudExplodeGain;
                  if (dcTotalDmg > 0) {
                    applyHpLoss(dcTarget, dcTotalDmg);
                    checkStaggerPanic(dcTarget);
                    resultLines.push(`🩸 **Dark Cloud** — ${tResolved.label} bị nổ Bleed ${darkCloudExplodeGain} lần, mất ${dcTotalDmg} HP.`);
                  }
                }
              }
            }
            // "Blade Lineage" (outfit) — GAP FIX SCOPE (đặt SAI trong khối
            // if (p.isM1...) ở trên trước đây, khối đó CHỈ chạy khi isM1=true
            // — nhưng keypage này CẦN CHẠY KHI KHÔNG PHẢI M1, nên KHÔNG BAO
            // GIỜ trigger được) — GAP MỚI (xác nhận trực tiếp): "Bạn nhận được
            // 3 Poise mỗi khi dùng Page". Tự tạo vòng for MỚI (biến "t" gốc đã
            // ra khỏi scope từ lâu, đóng ở dòng ~961) — giống hệt cách gap
            // tương tự (Liu Association) ngay dưới đây đã giải quyết.
            if (attacker.combatant.equippedOutfit === "Blade Lineage" && !p.isM1 && attacker.type === "player" && p.targets.length > 0) {
              attacker.combatant.poise = Math.min(POISE_MAX, (attacker.combatant.poise ?? 0) + 3);
            }
            // "Blade Lineage Mentor" (outfit) — GAP MỚI (xác nhận trực tiếp):
            // "Mỗi khi sử dụng page của Blade Lineage Syndicate bạn nhận được
            // Rending cho đến hết turn. Giúp gia tăng 30% Dmg Slash và tăng 3
            // Dice Up cho mọi Dice là Slash" — "page của Blade Lineage
            // Syndicate" xác định qua skill.weaponOf chứa "Blade Lineage" (VD
            // "Blade Lineage Hwando"). "renderingActive" reset về false ở
            // advanceCombatantTurn (kéo dài ĐẾN HẾT TURN, không phải vĩnh
            // viễn). +30% Dmg Slash áp trong attacker-perk-context.js (chỉ khi
            // dmgStr có hit Slash). +3 Dice Up CHỈ cho Dice Slash — vì hệ
            // thống diceUp hiện tại LÀ SỐ HIỂN THỊ (GM/player tự cộng thủ công
            // khi tính dmgStr, KHÔNG tự động áp vào calc — xác nhận qua
            // encounter-display.js/message-create-handler.js's cách dùng
            // diceUp khác) — nên field riêng "diceUpSlashOnly" cũng chỉ cần
            // HIỂN THỊ trên board để GM/player tự biết cộng khi roll Dice
            // Slash, nhất quán với cách diceUp thường hoạt động.
            if (attacker.combatant.equippedOutfit === "Blade Lineage Mentor" && !p.isM1 && attacker.type === "player" && p.targets.length > 0) {
              const usedSkill = findSkill(p.skillKey);
              if (usedSkill?.weaponOf?.includes("Blade Lineage")) {
                attacker.combatant.renderingActive = true;
                attacker.combatant.diceUpSlashOnly = (attacker.combatant.diceUpSlashOnly ?? 0) + 3;
              }
            }
            // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp: "outfit của Liu
            // association chưa áp dụng được việc khi áp burn sẽ trừ stamina kẻ
            // địch") — TRƯỚC ĐÂY nằm TRONG block if (p.isM1...) ở trên, nên CHỈ
            // trigger cho M1 — nhưng "Mỗi khi gây Burn cho kẻ địch" (văn bản
            // gốc) KHÔNG giới hạn loại hành động — bất kỳ skill/Critical/Page
            // nào gây Burn cũng phải trigger. Đặt NGOÀI block if (p.isM1) để áp
            // dụng cho MỌI trường hợp (M1 lẫn skill).
            if (attacker.combatant.hasLiuAssociation) {
              for (const t of p.targets) {
                const tResolved = resolveCombatant(encounter, t.targetId);
                if (tResolved && (tResolved.combatant.burn ?? 0) > (burnBeforeMap[t.targetId] ?? 0)) {
                  tResolved.combatant.currentStamina = Math.max(0, tResolved.combatant.currentStamina - 5);
                  resultLines.push(`🏮 **Liu Association** — ${attacker.label} khiến ${tResolved.label} mất 5 Stamina (do bị gây Burn).`);
                }
              }
            }
            checkStaggerPanic(attacker.combatant);

            // skill:/ref: verify — set cooldown + áp Emotion Coin delta THẬT lúc
            // confirm (xem comment đầy đủ ở resolveSkillVerification/doPlayerAttack).
            // QUAN TRỌNG: counter nội bộ = cooldownTurns + 1 (KHÔNG phải đúng số CD
            // ghi trên skill) — vì luật xác nhận: "CD 2 Turn" dùng ở Turn 1 thì Turn
            // 2 PHẢI còn hiện "còn 2 turn" (chưa giảm gì), Turn 3 mới hiện "còn 1",
            // Turn 4 mới dùng lại được — nghĩa là lượt CHÍNH NÓ được cast (Turn 1)
            // không tính là 1 lần giảm. Dùng cùng logic giảm-mỗi-endturn như cũ
            // (advanceCombatantTurn) nhưng counter khởi tạo dư thêm 1 thì ra đúng số
            // turn hiển thị. Text hiển thị NGAY LÚC NÀY vẫn dùng cooldownTurns gốc
            // (đúng số ghi trên skill), CHỈ giá trị lưu nội bộ mới +1.
            let verifyNote = "";
            if (p.skillKey && p.cooldownTurns > 0) {
              attacker.combatant.skillCooldowns = attacker.combatant.skillCooldowns ?? {};
              attacker.combatant.skillCooldowns[cdKeyFor(p.skillKey)] = p.cooldownTurns + 1; // cdKeyFor: skill khai cdGroup dùng CHUNG ô đếm (Atelier Logic Shotgun/Pistols)
              verifyNote += ` [CD ${p.skillKey}: ${p.cooldownTurns}T]`;
            }
            // Task yêu cầu trực tiếp: "page unlock... đáng lẽ dù nó có là cd 0
            // turn nhưng có description là 1 turn chỉ dùng được 1 lần" — set cờ
            // riêng (reset mỗi turn ở turn-advance.js), KHÔNG dùng skillCooldowns
            // thường vì CD=0 (không kích hoạt được điều kiện > 0 ở trên).
            if (p.skillKey?.toLowerCase() === "unlock") {
              attacker.combatant.unlockUsedThisTurn = true;
            }
            // orlandoFuriosoBypass — GAP ĐÃ SỬA (xác nhận trực tiếp) — TIÊU THỤ
            // bypass sau khi commit (cooldownTurns đã = 0 từ lúc declare, ở đây chỉ
            // cần clear flag để KHÔNG lặp lại miễn CD cho Critical LẦN SAU nữa).
            if (p.orlandoFuriosoBypassConsumed) {
              attacker.combatant.orlandoFuriosoBypass = false;
              // Xoá SẠCH CD cũ (nếu có) — "miễn CD" nghĩa là hoàn toàn không bị
              // ảnh hưởng, không chỉ bỏ qua check 1 lần rồi vẫn giữ CD cũ lại.
              if (attacker.combatant.skillCooldowns && p.skillKey) {
                attacker.combatant.skillCooldowns[cdKeyFor(p.skillKey)] = 0;
              }
              verifyNote += ` ⚡[Orlando Furioso đã tiêu thụ]`;
            }
            // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 2) —
            // "Knowledge" (Dieci Association Kata/Key): mỗi lần dùng ĐÚNG Critical
            // của vũ khí này → hồi 5 Sanity cho bản thân.
            if (p.skillKey && attacker.type === "player") {
              const knowledgeWeapon = findWeaponAnywhere(attacker.combatant.weaponName);
              const hasKnowledge = (knowledgeWeapon?.passives ?? []).some(pa => pa.mechanicId === "knowledge_sanity");
              if (hasKnowledge && knowledgeWeapon?.criticalSkillKey === p.skillKey) {
                attacker.combatant.currentSanity = Math.min(attacker.combatant.maxSanity, (attacker.combatant.currentSanity ?? 0) + 5);
                verifyNote += ` 📿[Knowledge +5 Sanity]`;
              }
              // GAP ĐÃ SỬA (batch 5) — "Blue Reverberation Ensemble Leader"
              // (Reverberation Scythe): dùng ĐÚNG Critical của vũ khí này (Resonate)
              // → hồi 5 Sanity, cùng pattern với Knowledge ở trên.
              const hasReverbLeader = (knowledgeWeapon?.passives ?? []).some(pa => pa.mechanicId === "blue_reverberation_leader");
              if (hasReverbLeader && knowledgeWeapon?.criticalSkillKey === p.skillKey) {
                attacker.combatant.currentSanity = Math.min(attacker.combatant.maxSanity, (attacker.combatant.currentSanity ?? 0) + 5);
                verifyNote += ` 💧[Blue Reverberation Ensemble Leader +5 Sanity]`;
              }
              // "Zwei Association": "Critical của vũ khí bạn sẽ áp Tremor lên kẻ
              // địch tương đương với 1/2 Tremor trên người bạn hiện tại" — áp
              // dụng cho BẤT KỲ weapon nào (không cần mechanicId cụ thể, vì đây
              // là outfit-based, không phải weapon-specific).
              if (attacker.combatant.hasZweiAssociation && knowledgeWeapon?.criticalSkillKey === p.skillKey) {
                const zweiTremorAmount = Math.floor((attacker.combatant.tremor ?? 0) / 2);
                if (zweiTremorAmount > 0 && p.targets) {
                  for (const t of p.targets) {
                    const tResolved = resolveCombatant(encounter, t.targetId);
                    if (tResolved) tResolved.combatant.tremor = Math.min(99, (tResolved.combatant.tremor ?? 0) + zweiTremorAmount);
                  }
                  verifyNote += ` 🌊[Zwei Association +${zweiTremorAmount} Tremor lên mục tiêu]`;
                }
              }
            }
            // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 4) —
            // "The Imitation" (Mimicry Blade): "Upstanding Slash" nhận 1 Imitation
            // MỖI HIT trúng (dùng totalHitsThisAction — 2 Dice trúng cả 2 = +2);
            // "Great Split" tiêu ĐÚNG 5 Imitation (đã check đủ ở lúc roll), cộng
            // vào imitationConsumedTotal (vĩnh viễn, không giảm — dùng tính %
            // Dmg Bonus ở computeAttackerPerkContext).
            // ── Chuỗi Unlock → Unlocked Blade → Eliminate → Castigation ──
            // BUG ĐÃ SỬA (Fragaria: "unlock và castigation hoạt động không
            // đúng"). Trước đây KHÔNG có 1 dòng logic nào cho chuỗi này: Unlock
            // random stage rồi thôi (stack chỉ tồn tại trong TEXT), Eliminate
            // không biết chain, Castigation không cần điều kiện và không xoá gì.
            // Chỉ tăng stage khi đòn THẬT SỰ TRÚNG (evadedCompletely=false) —
            // đúng mô tả "trúng: nhận Unlock Blade - 1".
            if (p.skillKey === "unlock" && anyHitLandedThisAction) {
              const beforeStage = attacker.combatant.unlockBladeStage ?? 0;
              attacker.combatant.unlockBladeStage = Math.min(3, beforeStage + 1);
              const st = attacker.combatant.unlockBladeStage;
              verifyNote += ` 🗝️[${st >= 3 ? "**Unlocked Blade** — Eliminate giờ chain sang Castigation" : `Unlock Blade - ${st}`}]`;
            }
            // Eliminate — báo cho người chơi biết đã đủ điều kiện chain (KHÔNG tự
            // động bắn Castigation hộ: nó là 1 action riêng có target/phòng thủ
            // riêng, tự động hoá sẽ bỏ qua bước reactive defense của đối thủ).
            if (p.skillKey === "eliminate" && anyHitLandedThisAction && (attacker.combatant.unlockBladeStage ?? 0) >= 3) {
              verifyNote += ` ⚔️[Có **Unlocked Blade** → dùng tiếp **Castigation** ngay được]`;
            }
            // Castigation — tiêu stack sau khi dùng (dù trúng hay trượt: page đã
            // được phóng ra, đúng câu "sau đó xóa stack Unlocked Blade").
            // "Atelier Logic" — lật form sau khi dùng Critical (mô tả roll() của
            // cả 2 form đều ghi "sau đó đổi qua dạng <form kia>"). Lật DÙ trúng
            // hay trượt: cò đã bóp, súng đã chuyển cơ cấu — không phụ thuộc việc
            // đòn có vào target hay không.
            // "A Prayer For Loving Sorrow" (Găng Tay Câm Lặng) — GAP ĐÃ SỬA:
            // dùng Critical của 1 vũ khí Black Silence → +1 Realization, MỖI VŨ
            // KHÍ CHỈ 1 LẦN (nên track danh sách tên vũ khí, không đếm trần).
            // Đủ 9 → Orlando Furioso: lần đổi vũ khí kế tiếp bắn Furioso thay vì
            // đổi (cờ orlandoFuriosoReady, tiêu ở lệnh đổi vũ khí).
            if (attacker.combatant.hasGangTayCamLang && attacker.type === "player"
                && attacker.combatant.weaponCriticalKey === p.skillKey && attacker.combatant.weaponName) {
              const wName = attacker.combatant.weaponName;
              attacker.combatant.realizationWeapons = attacker.combatant.realizationWeapons ?? [];
              if (!attacker.combatant.realizationWeapons.includes(wName)) {
                attacker.combatant.realizationWeapons.push(wName);
                attacker.combatant.realizationStacks = attacker.combatant.realizationWeapons.length;
                verifyNote += ` 🧤[+1 Realization (${attacker.combatant.realizationStacks}/9)]`;
                if (attacker.combatant.realizationStacks >= 9 && !attacker.combatant.orlandoFuriosoReady) {
                  attacker.combatant.orlandoFuriosoReady = true;
                  verifyNote += ` ✨[**Orlando Furioso** sẵn sàng — lần đổi vũ khí kế tiếp sẽ tung **Furioso**]`;
                }
              }
            }
            // Grappling (Brawler) — "sau khi dùng xong kẻ địch sẽ thoát khỏi
            // Airborne và nhận 10 Dmg" (xác nhận trực tiếp từ Fragaria).
            // 10 Dmg CỐ ĐỊNH, không qua resistance/DR — cùng bản chất với dmg
            // Airborne ở End Turn (rơi xuống đất), chỉ là bị kích hoạt SỚM.
            // Áp cho MỌI target của đòn này đang Airborne (Grappling đơn target
            // nhưng viết theo vòng lặp cho an toàn nếu sau này thành AOE).
            // Wheel's Industry — "gây 10 Tremor, Tremor Burst nếu ≥20 Tremor".
            // Điều kiện kiểm SAU khi 10 Tremor đã cộng vào (dmgStr xử lý trước).
            if (p.skillKey === "wheels industry") {
              for (const tg of p.targets ?? []) {
                const tr = resolveCombatant(encounter, tg.targetId);
                if (!tr?.combatant || (tr.combatant.tremor ?? 0) < 20) continue;
                // Dùng ĐÚNG cơ chế Tremor Burst có sẵn (pattern giống Scorch
                // Propellant Round bên dưới) — KHÔNG bịa field cờ mới, vì cờ tự
                // chế sẽ không có ai đọc (lỗi "cờ mồ côi" đã mắc trước đây).
                const tbRes = calcMathCore({ dmgStr: "0B+TremorBurst", resStr: combatantResStr(tr.combatant), tremorInit: tr.combatant.tremor ?? 0 });
                applyHpLoss(tr.combatant, tbRes.totalDmg);
                tr.combatant.currentStamina = Math.max(0, (tr.combatant.currentStamina ?? 0) - tbRes.totalTremorStaminaLoss);
                tr.combatant.tremor = tbRes.finalTremor;
                checkStaggerPanic(tr.combatant);
                verifyNote += ` 💥[${tr.label} có ≥20 Tremor → **Tremor Burst**: -${tbRes.totalDmg.toFixed(1)} HP, -${tbRes.totalTremorStaminaLoss} Sta]`;
              }
            }
            if (p.skillKey === "grappling") {
              for (const tg of p.targets ?? []) {
                const tr = resolveCombatant(encounter, tg.targetId);
                if (!tr?.combatant?.airborne) continue;
                tr.combatant.airborne = false;
                tr.combatant.currentHp = Math.max(0, (tr.combatant.currentHp ?? 0) - 10);
                verifyNote += ` 🪁[${tr.label} thoát **Airborne** — rơi xuống nhận thêm 10 Dmg]`;
                checkStaggerPanic(tr.combatant);
              }
            }
            if (p.skillKey === "atelier logic shotgun" || p.skillKey === "atelier logic pistols") {
              const nextForm = p.skillKey === "atelier logic shotgun" ? "pistols" : "shotgun";
              attacker.combatant.atelierLogicForm = nextForm;
              // BUG ĐÃ SỬA (Fragaria báo trực tiếp: "còn nhiều page cũng không
              // hoạt động đúng như effect... trong số đó có Atelier Logic").
              //
              // NGUYÊN NHÂN GỐC: `atelierLogicForm` TRƯỚC ĐÂY chỉ là 1 cái nhãn
              // — nó quyết định Critical nào hiện trên panel, và KHÔNG gì khác.
              // Chỉ số vũ khí thật trên combatant (weaponBaseDamage/weaponType/
              // weaponWeight) vẫn đứng im ở giá trị Shotgun (26 / Blunt / heavy)
              // kể cả khi đã đổi sang Pistols. Chính passive trong weapon.js
              // cũng thừa nhận điều đó: "GM/player TỰ CHỌN form đang dùng khi
              // tính M1, hệ thống chỉ lưu 1 baseDamage cố định". Hệ quả: đổi
              // form xong thì M1, chi phí Stamina và số hit/nhóm phòng thủ đều
              // vẫn là Shotgun — form Pistols gần như vô nghĩa.
              //
              // SỬA Ở ĐÚNG 1 CHỖ NÀY thay vì vá riêng cho M1: ghi thẳng chỉ số
              // của form mới lên combatant, nên MỌI nơi đọc chỉ số vũ khí
              // (dmgStr M1 ở interaction-handlers.js, WEAPON_STAMINA_COST,
              // WEAPON_DEFENSE_HITS khi chia nhóm hit phòng thủ, Parry
              // counter-dmg ở reactive-defense.js) tự động đúng theo form.
              const ATELIER_FORM_STATS = {
                shotgun: { baseDamage: 26,  type: "Blunt",  weight: "heavy" },
                pistols: { baseDamage: 6.5, type: "Pierce", weight: "light" },
              };
              const formStats = ATELIER_FORM_STATS[nextForm];
              attacker.combatant.weaponBaseDamage = formStats.baseDamage;
              attacker.combatant.weaponType = formStats.type;
              attacker.combatant.weaponWeight = formStats.weight;
              verifyNote += ` 🔫[Atelier Logic đổi sang dạng **${nextForm === "pistols" ? "Pistols" : "Shotgun"}** — ${formStats.baseDamage} ${formStats.type} / ${formStats.weight}]`;
            }
            // ── HIỆU ỨNG NGOÀI dmgStr (dùng CHUNG cho MỌI page) ───────────────
            // BUG HỆ THỐNG ĐÃ SỬA (Fragaria: "Page Onrush không giảm stamina như
            // text ghi, có vẻ còn nhiều page cũng thế không hoạt động đúng như
            // effect... trong số đó có Atelier Logic và Vengeance Retaliation").
            //
            // TRƯỚC ĐÂY mỗi page phải có 1 khối `if (p.skillKey === "...")` viết
            // tay, nên hàng chục page có hiệu ứng ghi trong text mà KHÔNG AI code
            // thì im lặng không chạy — người chơi không có cách nào biết.
            // Giờ đọc từ `p.autoSideEffects` (skills.js's extractNonDmgStrEffects
            // phân tích chính text đã roll) → page MỚI tự động chạy luôn, không
            // cần thêm handler. Hiệu ứng CÓ ĐIỀU KIỆN vẫn phải code riêng (parser
            // cố ý bỏ qua dòng bắt đầu bằng "Nếu" — xem gotcha trong HANDOFF).
            //
            // Bao phủ ngay: Onrush (−40 Sta địch, +1 Imitation), Regret (−100 Sta),
            // Vengeance Retaliation (Fragile + Paralyze — hai status này KHÔNG có
            // trong damageRegex nên chưa từng áp được lần nào).
            {
              const sfx = p.autoSideEffects;
              // ── Blind / Shield-theo-mục-tiêu / Paralyze theo Sanity / Erosion ──
              // 4 hiệu ứng TRƯỚC ĐÂY chỉ là CHỮ trong text (HANDOFF liệt kê ở mục
              // "hiệu ứng còn phải thao tác tay").
              if (sfx && (sfx.blind > 0 || sfx.selfShieldPerTarget > 0)) {
                for (const t2 of (p.targets ?? [])) {
                  const tr2 = resolveCombatant(encounter, t2.targetId);
                  if (!tr2?.combatant) continue;
                  if (sfx.blind > 0) {
                    tr2.combatant.blind = Math.min(99, (tr2.combatant.blind ?? 0) + sfx.blind);
                    verifyNote += ` 🌑[${tr2.label}: +${sfx.blind} Blind (đòn đánh thường kế trượt)]`;
                  }
                }
                // "Nhận 100 HP Shield với TỪNG mục tiêu DÍNH ĐÒN" — nhân theo SỐ
                // mục tiêu, không phải 1 lần. Đi qua grantShieldHp để ăn đúng
                // hiệu suất Day One / Compassion.
                if (sfx.selfShieldPerTarget > 0 && attacker.combatant) {
                  const nTargets = (p.targets ?? []).length;
                  if (nTargets > 0) {
                    const got = grantShieldHp(attacker.combatant, sfx.selfShieldPerTarget * nTargets, attacker.combatant, { isAlly: false });
                    verifyNote += ` 🛡️[+${got} Shield HP (${sfx.selfShieldPerTarget} × ${nTargets} mục tiêu)]`;
                  }
                }
              }
              // Falco Berigora — 2 điều kiện viết dạng *Nếu…* nên parser CỐ Ý
              // không tự áp; xử lý thật ở đây.
              // False Throne — "sau khi dùng: hồi sinh TOÀN BỘ đồng minh đã chết
              // trong trận này trong 1 Turn (4 Light, mọi Buff trừ Emotion Level
              // bị reset)". TRƯỚC ĐÂY chỉ là chữ.
              // ── FURIOSO (Caduceus) ────────────────────────────────────────
              // ❗ BUG ĐÃ SỬA (Fragaria: "Procuration Hermes đếm sai — báo thiếu
              // Dice 9 Slash nhưng M1 và Crit 3 Slash ra Dice 9 Slash thì không
              // được đếm"). Chỉ nhánh M1 mới cộng Procuration; Critical/Furioso
              // cũng roll ra mặt Caduceus nhưng KHÔNG đếm.
              // Quét dmgStr đã roll: mỗi hạng `<dmg><type>` khớp một mặt trong bảng.
              if (attacker.combatant && /^caduceus crit|^furioso /.test(p.skillKey ?? "")) {
                const FACE = { "8Blunt": 1, "8Pierce": 2, "15Slash": 3, "15Pierce": 4, "15Blunt": 5,
                  "24Slash": 6, "24Pierce": 7, "24Blunt": 8, "30Slash": 9 };
                const TL = { B: "Blunt", P: "Pierce", S: "Slash" };
                attacker.combatant.procurationHermes = attacker.combatant.procurationHermes ?? [];
                const gained = [];
                for (const term of String(p.dmgStr ?? "").split("+")) {
                  const m = term.trim().match(/^(\d+(?:\.\d+)?)\s*([BPS])/);
                  if (!m) continue;
                  // Crit nhân bonus % nên dmg lệch — quy về mặt gần nhất theo type.
                  const raw = parseFloat(m[1]), ty = TL[m[2]];
                  let best = null, bestDiff = Infinity;
                  for (const [k, n2] of Object.entries(FACE)) {
                    if (!k.endsWith(ty)) continue;
                    const base = parseInt(k, 10);
                    for (const mul of [1, 1.3, 1.4, 1.5]) {
                      const d = Math.abs(raw - base * mul);
                      if (d < bestDiff) { bestDiff = d; best = n2; }
                    }
                  }
                  if (best && bestDiff <= 0.6 && !attacker.combatant.procurationHermes.includes(best)) {
                    attacker.combatant.procurationHermes.push(best); gained.push(best);
                  }
                }
                if (gained.length > 0) {
                  defenseNote += ` <:Unlock:1528452595859849406>[+${gained.length} Procuration (Dice ${gained.join(", ")}) → ${attacker.combatant.procurationHermes.length}/9]`;
                }
              }
              // ❗ Fragaria: "Degraded Fairy không cộng Light ngay trong turn sau
              // khi sử dụng". Text ghi "Nhận 1 Light NẾU đánh dính kẻ thù" — có
              // ĐIỀU KIỆN nên parser chung CỐ Ý bỏ qua (đúng nguyên tắc: thà sót
              // còn hơn áp nhầm). Xử lý thật ở đây: đánh dính thì cộng NGAY.
              if (p.skillKey === "degraded fairy" && attacker.combatant && finalDmg > 0) {
                const before = attacker.combatant.currentLight ?? 0;
                attacker.combatant.currentLight = Math.min(attacker.combatant.maxLight ?? 5, before + 1);
                if (attacker.combatant.currentLight > before) {
                  defenseNote += ` <:Light:1513786082502770719>[Degraded Fairy: +1 Light (đánh dính)]`;
                }
              }
              const furiosoSkill = p.skillKey ? findSkill(p.skillKey) : null;
              if (furiosoSkill?.caduceusFurioso && attacker.combatant) {
                const F = furiosoSkill.caduceusFurioso;
                // "Gây … ở TURN SAU khi đòn tấn công này kết thúc" ⇒ hàng đợi,
                // turn-advance mới áp. Áp ngay bây giờ là sai một nhịp turn.
                // ❗ CRASH ĐÃ SỬA ("Furioso Replica: target is not defined", kẹt
                // luôn encounter). Khối này nằm ở phần SIDE-EFFECTS — CHẠY SAU
                // vòng lặp `for (const t of p.targets)` — nên biến `target` (khai
                // TRONG vòng lặp đó) KHÔNG tồn tại ở đây. Phải tự duyệt lại
                // p.targets qua resolveCombatant, đúng như các khối khác cùng chỗ.
                for (const tf of (p.targets ?? [])) {
                  const trf = resolveCombatant(encounter, tf.targetId);
                  if (!trf?.combatant) continue;
                  const q = trf.combatant.pendingNextTurnStatus ?? { bleed: 0, bind: 0, fragile: 0 };
                  q.bleed += F.bleed; q.bind += F.bind; q.fragile += F.fragile;
                  trf.combatant.pendingNextTurnStatus = q;
                }
                verifyNote += ` 💥[${furiosoSkill.name}: turn SAU gây ${F.bleed} <:Bleed:1513762688226955285>Bleed · ${F.bind} <:Fix_Bind:1513768025881317457>Bind · ${F.fragile} <:Fix_Fragile:1513763336167100536>Fragile]`;
                // Wound-Casing Mask — "vỡ khi dùng bất kỳ biến thể Furioso LẦN ĐẦU".
                // Đã có Sizzling Wound (mặt nạ vỡ từ trước) + dùng Furioso ⇒ Saikai2.
                if (attacker.combatant.sizzlingWound && !attacker.combatant.woundCasingMaskIntact) {
                  attacker.combatant.saikai2TurnsLeft = 2;
                  attacker.combatant.lastFuriosoName = furiosoSkill.name;
                  attacker.combatant.bgmAnnounceNow = "Saikai2.mp3";
                  verifyNote += ` 🎵[BGM → **Saikai2.mp3** (${furiosoSkill.name}, 2 Turn)]`;
                }
                if (attacker.combatant.woundCasingMaskIntact) {
                  // Fragaria: *"Khi Furioso được sử dụng mà player VẪN CÒN mặt nạ
                  // thì sẽ ghi đè và phát BGM Saikai1.mp3 TRONG TURN VÀ TURN KẾ."*
                  // Bật cờ TRƯỚC khi làm vỡ — sau khi vỡ thì không còn "vẫn còn
                  // mặt nạ" nữa, đặt sau là không bao giờ chạy.
                  attacker.combatant.saikai1TurnsLeft = 2;
                  // Ghi tên biến thể để nhãn BGM nói ĐÚNG bài của ai (Replica /
                  // Crescendo / Lacrimosa-Crescendo), thay vì dán "Manifested E.G.O".
                  attacker.combatant.lastFuriosoName = furiosoSkill.name;
                  attacker.combatant.bgmAnnounceNow = "Saikai1.mp3";
                  attacker.combatant.woundCasingMaskIntact = false;
                  attacker.combatant.sizzlingWound = true;
                  verifyNote += ` 🎭[**Wound-Casing Mask VỠ** vì dùng Furioso — Sizzling Wound quay lại tới hết Encounter]`;
                  verifyNote += ` 🎵[BGM → **Saikai1.mp3** (turn này + turn kế), sau đó **Saikai2.mp3**]`;
                }
                // Singleton — "dùng biến thể Furioso bất kỳ cho 1 stack
                // Indulgence in Prescript" (mất khi end turn).
                if (attacker.combatant.singleton && attacker.combatant.hasIndexOraclesProxy) {
                  attacker.combatant.indulgenceInPrescript = (attacker.combatant.indulgenceInPrescript ?? 0) + 1;
                  verifyNote += ` 📜[+1 **Indulgence in Prescript** — đòn có áp Sinking sẽ inflict thêm 2 count]`;
                }
                // "Sau khi sử dụng Furioso thì reset toàn bộ Procuration [Hermes] về 0."
                attacker.combatant.procurationHermes = [];
              }
              if (p.skillKey === "false throne" && attacker.type === "player") {
                const revived = [];
                for (const [pid, pl] of Object.entries(encounter.players ?? {})) {
                  if ((pl.currentHp ?? 0) > 0) continue;
                  // Reset MỌI buff trừ Emotion Level: dựng lại combatant từ các
                  // field NỀN thay vì xoá từng buff một (xoá tay chắc chắn sót,
                  // và sót buff nào thì người chết sống dậy mạnh hơn lúc sống).
                  const keepEmotion = { emotionLevel: pl.emotionLevel, emotionCoin: pl.emotionCoin,
                    emotionLevelTurnsLeft: pl.emotionLevelTurnsLeft, emotionLevelCooldownLeft: pl.emotionLevelCooldownLeft };
                  for (const k of Object.keys(pl)) {
                    const v = pl[k];
                    // Chỉ reset các bộ đếm/stack dạng SỐ và cờ dạng BOOLEAN true —
                    // giữ nguyên tên, vũ khí, Res, snapshot page… (không phải buff).
                    if (typeof v === "number" && /Left$|Stacks?$|Bonus$|TurnsLeft$/.test(k)) pl[k] = 0;
                    if (v === true && /^(has|is)[A-Z]/.test(k) === false && /Active$/.test(k)) pl[k] = false;
                  }
                  for (const k of ["burn","bleed","tremor","rupture","sinking","poise","charge","fragile",
                                   "paralyze","blind","haste","bind","diceUp","diceDown","shieldHp","erosion"]) {
                    if (k in pl) pl[k] = 0;
                  }
                  Object.assign(pl, keepEmotion);
                  pl.currentHp = 1;
                  pl.currentLight = 4;
                  pl.staggered = false;
                  pl.currentStamina = Math.max(1, Math.round((pl.maxStamina ?? 100) * 0.5));
                  // Sống lại ĐÚNG 1 Turn — turn-advance đếm ngược rồi cho gục lại.
                  pl.falseThroneRevivedTurnsLeft = 1;
                  revived.push(pl.name ?? pid);
                }
                verifyNote += revived.length > 0
                  ? ` 👑[**False Throne** hồi sinh ${revived.length} đồng minh trong 1 Turn: ${revived.join(", ")} — 4 Light, mọi Buff (trừ Emotion Level) đã reset]`
                  : ` 👑[**False Throne** — không có đồng minh nào đã chết để hồi sinh]`;
              }
              if (p.skillKey === "falco berigora" && attacker.combatant) {
                const lowSanity = (attacker.combatant.currentSanity ?? 0) <= -40;
                for (const t2 of (p.targets ?? [])) {
                  const tr2 = resolveCombatant(encounter, t2.targetId);
                  if (!tr2?.combatant) continue;
                  if (lowSanity) {
                    tr2.combatant.paralyze = Math.min(99, (tr2.combatant.paralyze ?? 0) + 2);
                    verifyNote += ` 😵[Sanity ${attacker.combatant.currentSanity} ≤ -40 → ${tr2.label} +2 Paralyze]`;
                  }
                  if ((tr2.combatant.bleed ?? 0) > 0) {
                    const eaten = tr2.combatant.bleed;
                    tr2.combatant.bleed = 0;
                    // Erosion — 2 stack, hết hạn sau 1 Turn (turn-advance dọn).
                    // Lưu theo NGƯỜI GÂY — chỉ họ mới được hưởng (Fragaria chốt).
                    tr2.combatant.erosionBy = tr2.combatant.erosionBy ?? {};
                    tr2.combatant.erosionBy[p.attackerId] = (tr2.combatant.erosionBy[p.attackerId] ?? 0) + 2;
                    tr2.combatant.erosion = (tr2.combatant.erosion ?? 0) + 2; // tổng, chỉ để HIỂN THỊ
                    tr2.combatant.erosionTurnsLeft = 1;
                    verifyNote += ` 🩸[Tiêu ${eaten} Bleed của ${tr2.label} → +2 Erosion (1 Turn)]`;
                  }
                }
              }
              if (sfx && (sfx.drainStamina || sfx.fragile || sfx.paralyze)) {
                const sfxLabels = [];
                for (const t2 of p.targets ?? []) {
                  const tr2 = resolveCombatant(encounter, t2.targetId);
                  if (!tr2) continue;
                  const parts = [];
                  if (sfx.drainStamina > 0) {
                    const before = tr2.combatant.currentStamina ?? 0;
                    tr2.combatant.currentStamina = Math.max(0, before - sfx.drainStamina);
                    // Hết Stamina là điều kiện Stagger — phải kiểm ngay như mọi
                    // nguồn trừ Stamina khác.
                    checkStaggerPanic(tr2.combatant);
                    parts.push(`−${(before - tr2.combatant.currentStamina).toFixed(0)} Sta`);
                  }
                  if (sfx.fragile > 0) {
                    tr2.combatant.fragile = Math.min(99, (tr2.combatant.fragile ?? 0) + sfx.fragile);
                    parts.push(`+${sfx.fragile} Fragile`);
                  }
                  if (sfx.paralyze > 0) {
                    tr2.combatant.paralyze = Math.min(99, (tr2.combatant.paralyze ?? 0) + sfx.paralyze);
                    parts.push(`+${sfx.paralyze} Paralyze`);
                  }
                  // Airborne là BOOLEAN trên combatant (combatant-factory.js:
                  // `airborne: false`), KHÔNG phải bộ đếm — turn-advance.js đọc
                  // nó dạng cờ rồi set false + gây 10 dmg rơi. Cộng dồn số vào
                  // đây là sai mô hình dữ liệu (đúng lỗi #1 trong HANDOFF).
                  if (sfx.hemorrhage > 0) {
                    // NGUỒN INFLICT duy nhất của Hemorrhage. Đánh dấu
                    // hemorrhageAppliedThisTurn để turn-advance không reset ngay
                    // trong chính turn vừa gắn.
                    tr2.combatant.hemorrhage = Math.min(5, (tr2.combatant.hemorrhage ?? 0) + sfx.hemorrhage);
                    tr2.combatant.hemorrhageAppliedThisTurn = true;
                    parts.push(`+${sfx.hemorrhage} Hemorrhage (lv ${tr2.combatant.hemorrhage})`);
                  }
                  if (sfx.airborne > 0 && !tr2.combatant.airborne) {
                    tr2.combatant.airborne = true;
                    parts.push("Airborne");
                  }
                  if (parts.length) sfxLabels.push(`${tr2.label} ${parts.join(", ")}`);
                }
                if (sfxLabels.length) verifyNote += ` ✨[${sfxLabels.join(" · ")}]`;
              }
              // Hiệu ứng lên CHÍNH MÌNH.
              if (sfx && attacker.type === "player") {
                const selfParts = [];
                if (sfx.selfImitation > 0) {
                  attacker.combatant.imitation = Math.min(IMITATION_MAX ?? 10, (attacker.combatant.imitation ?? 0) + sfx.selfImitation);
                  selfParts.push(`+${sfx.selfImitation} Imitation (tổng ${attacker.combatant.imitation})`);
                }
                if (sfx.selfDiceUp > 0) {
                  // Dice Up TỰ NHẬN có thời hạn (Focus Spirit…). Phải lưu thành
                  // bonus BỀN chứ không cộng thẳng `diceUp`: advanceCombatantTurn
                  // reset `diceUp` về 0 mỗi turn ⇒ cộng thẳng là mất ngay turn sau,
                  // đúng triệu chứng "Focus Spirit không cho dice up".
                  // Cộng CẢ 2: `diceUp` để có hiệu lực NGAY turn này, và bonus bền
                  // để turn-advance cộng lại cho những turn còn lại.
                  attacker.combatant.diceUp = (attacker.combatant.diceUp ?? 0) + sfx.selfDiceUp;
                  const turns = Math.max(1, sfx.selfDiceUpTurns ?? 1);
                  if (turns > 1) {
                    attacker.combatant.pageDiceUpBonus = (attacker.combatant.pageDiceUpBonus ?? 0) + sfx.selfDiceUp;
                    attacker.combatant.pageDiceUpTurnsLeft = Math.max(attacker.combatant.pageDiceUpTurnsLeft ?? 0, turns - 1);
                  }
                  selfParts.push(`+${sfx.selfDiceUp} Dice Up${turns > 1 ? ` (${turns} Turn)` : ""}`);
                }
                if (sfx.selfLight > 0) {
                  const beforeL = attacker.combatant.currentLight ?? 0;
                  attacker.combatant.currentLight = Math.min(attacker.combatant.maxLight ?? 99, beforeL + sfx.selfLight);
                  selfParts.push(`+${(attacker.combatant.currentLight - beforeL)} Light`);
                }
                if (sfx.selfHaste > 0) {
                  // Cap 20 — cùng trần với nguồn Haste sẵn có ở turn-advance.js.
                  const beforeHa = attacker.combatant.haste ?? 0;
                  attacker.combatant.haste = Math.min(20, beforeHa + sfx.selfHaste);
                  selfParts.push(`+${attacker.combatant.haste - beforeHa} Haste (tổng ${attacker.combatant.haste})`);
                }
                if (sfx.healHp > 0) {
                  // healHpCapped — KHÔNG dùng Math.min(maxHp, …) nữa: với người
                  // đội "Memories: Compassion" thì `maxHp` đã cộng 100 máu ẢO mà
                  // luật ghi rõ là KHÔNG hồi lên tới đó được. Xem healCapHp.
                  const gotHp = healHpCapped(attacker.combatant, sfx.healHp);
                  if (gotHp > 0) selfParts.push(`+${gotHp.toFixed(0)} HP`);
                }
                if (selfParts.length) verifyNote += ` 💠[${selfParts.join(", ")}]`;
              }
            }
            // ── INFLICT HEMORRHAGE CÓ ĐIỀU KIỆN ──────────────────────────────
            // "Take This, Kid" / "Learn Again, Kid": *Nếu địch có Bleed: gắn 1
            // Hemorrhage*. Dòng CÓ ĐIỀU KIỆN nên parser chung cố ý bỏ qua (đúng
            // gotcha trong HANDOFF) → phải code riêng.
            // Đây là 2 nguồn INFLICT Hemorrhage duy nhất hiện có; không có chúng
            // thì Bleed không tự sinh Hemorrhage nữa (xem gate `hemorrhage > 0`).
            if (p.skillKey === "take this kid" || p.skillKey === "learn again kid") {
              const hemoLabels = [];
              for (const t2 of p.targets ?? []) {
                const tr2 = resolveCombatant(encounter, t2.targetId);
                if (!tr2 || (tr2.combatant.bleed ?? 0) <= 0) continue;
                tr2.combatant.hemorrhage = Math.min(HEMORRHAGE_MAX, (tr2.combatant.hemorrhage ?? 0) + 1);
                tr2.combatant.hemorrhageAppliedThisTurn = true;
                hemoLabels.push(`${tr2.label} → Hemorrhage lv ${tr2.combatant.hemorrhage}`);
              }
              if (hemoLabels.length) verifyNote += ` 🩸[Gắn Hemorrhage: ${hemoLabels.join(", ")}]`;
            }
            // ── BORROWED EYES (Singularity của Eye Gouger) ───────────────────
            // GAP ĐÃ SỬA (Fragaria: "Borrowed Eyes của Eye Gouger chưa hoạt động
            // đúng"). Text mô tả đúng nhưng KHÔNG có mã nào đọc: dice vẫn gây dmg
            // bình thường và không ai được charge né nào.
            // Luật: dice [5~10] KHÔNG gây dmg; sau khi dùng, người dùng nhận số
            // charge né BẰNG ĐÚNG giá trị dice. Charge né không chặn [Undodgeable]
            // — điều này đã đúng sẵn ở nhánh tiêu charge (kiểm blockEvade).
            if (p.skillKey === "borrowed eyes") {
              // Lấy giá trị dice từ dmgStr ĐÃ ROLL (không roll lại — roll lại thì
              // số charge sẽ lệch khỏi con số vừa hiện cho người chơi).
              const diceVal = Math.round(parseFloat(String(p.dmgStr ?? "0").match(/(\d+(?:\.\d+)?)/)?.[1] ?? "0"));
              if (diceVal > 0) {
                attacker.combatant.evadeCharges = (attacker.combatant.evadeCharges ?? 0) + diceVal;
                attacker.combatant.borrowedEyeCharges = diceVal;
                verifyNote += ` 👁️[Borrowed Eye: +${diceVal} charge né (tổng ${attacker.combatant.evadeCharges})]`;
              }
            }
            // ── RESONATE ─────────────────────────────────────────────────────
            // "nếu kẻ địch có số Tremor BẰNG số Dice này thì sẽ Stagger ngay".
            // CÓ ĐIỀU KIỆN + so với giá trị dice cụ thể → parser chung cố ý
            // không đụng tới, phải code riêng (đúng gotcha trong HANDOFF).
            // So Tremor SAU đòn với TỪNG giá trị dice của chính đòn này
            // (p.dmgStr đã roll sẵn lúc declare — KHÔNG roll lại, tránh lệch số
            // giữa cái hiển thị và cái đem ra so).
            if (p.skillKey === "resonate") {
              const diceValues = [...String(p.dmgStr ?? "").matchAll(/(\d+(?:\.\d+)?)\s*(?:x\d+)?\s*[BPSbps]/g)]
                .map(m => Math.round(parseFloat(m[1])));
              const staggeredLabels = [];
              for (const t2 of p.targets ?? []) {
                const tr2 = resolveCombatant(encounter, t2.targetId);
                if (!tr2 || tr2.combatant.staggered) continue;
                const tremorNow = Math.round(tr2.combatant.tremor ?? 0);
                if (tremorNow > 0 && diceValues.includes(tremorNow)) {
                  forceStagger(tr2.combatant);
                  staggeredLabels.push(`${tr2.label} (Tremor ${tremorNow} = Dice)`);
                }
              }
              if (staggeredLabels.length) verifyNote += ` 💫[Resonate ép STAGGER: ${staggeredLabels.join(", ")}]`;
            }
            // ── DESIGNANT. (Lucent Historia) ─────────────────────────────────
            // "Bản thân và TẤT CẢ đồng đội nhận 30 Shield HP, rồi CHỈ ĐỊNH một
            // đồng đội hoặc chính bản thân. Người được chỉ định nhận Shield HP
            // bằng 20% Max HP CỦA NGƯỜI DÙNG và 1 Dice Up đến hết turn."
            // Người chỉ định = target của đòn (promptArg/target chọn ở panel);
            // không chọn ai thì mặc định CHÍNH MÌNH.
            if (p.skillKey === "designant." && attacker.type === "player") {
              const notes = [];
              for (const [pid, pl] of Object.entries(encounter.players ?? {})) {
                if ((pl.currentHp ?? 0) <= 0) continue;
                const got = grantShieldHp(pl, 30, attacker.combatant, { isAlly: pid !== p.attackerId });
                if (got > 0) notes.push(`<@${pid}> +${got}`);
              }
              const designatedId = (p.targets ?? [])[0]?.targetId ?? p.attackerId;
              const designated = encounter.players?.[designatedId] ?? attacker.combatant;
              const bonus = Math.round((attacker.combatant.maxHp ?? 0) * 0.2 * 100) / 100;
              const bonusGot = grantShieldHp(designated, bonus, attacker.combatant, { isAlly: designatedId !== p.attackerId });
              designated.diceUp = (designated.diceUp ?? 0) + 1;
              verifyNote += ` 🛡️[Designant: toàn đội ${notes.join(", ")} · chỉ định <@${designatedId}> +${bonusGot} Shield, +1 Dice Up]`;
            }
            // ── ASTRAL QUANTIZATION (Lucent Historia) ────────────────────────
            // "Chỉ định 1 đồng đội ĐANG CÓ Shield HP, roll [1-30]. CUỐI TURN gây
            // sát thương lên 1 đối thủ bằng [dice]% DMG mà đồng đội đó đã gây ra
            // trong turn này."
            // Dmg TRÌ HOÃN → lưu vào encounter, bắn ở mốc kết thúc turn order
            // (reactive-defense.js's performEndTurn). % lấy từ dice ĐÃ ROLL trong
            // p.dmgStr — KHÔNG roll lại, nếu không số hiện cho người chơi sẽ khác
            // số thực thi.
            if (p.skillKey === "astral quantization" && attacker.type === "player") {
              // BUG ĐÃ SỬA (Fragaria: "Astral Quantization có vẻ hoạt động không
              // đúng"). Skill này KHÔNG có dice sát thương ⇒ `p.dmgStr` là chuỗi
              // placeholder "Critical: Astral Quantization" — KHÔNG có chữ số nào
              // ⇒ regex cũ luôn trả "0" ⇒ **pct = 0 vĩnh viễn**, cuối turn gây
              // đúng 0 dmg. Con số thật nằm trong TEXT ĐÃ ROLL ("bằng **41%** DMG"),
              // nay truyền qua `p.rollText` từ bước chọn đồng đội.
              const pctSrc = `${p.rollText ?? ""} ${p.dmgStr ?? ""}`;
              const pct = Math.round(parseFloat(
                pctSrc.match(/\*\*(\d+(?:\.\d+)?)%\*\*/)?.[1]
                ?? pctSrc.match(/(\d+(?:\.\d+)?)\s*%/)?.[1]
                ?? "0"));
              if (!(pct > 0)) {
                verifyNote += ` ⚠️[Astral Quantization: không đọc được % từ kết quả roll — báo GM]`;
              }
              const allyId = (p.targets ?? [])[0]?.targetId ?? p.attackerId;
              const ally = encounter.players?.[allyId];
              if (!(pct > 0)) { /* đã báo ở trên */ }
              else if (!ally || (ally.shieldHp ?? 0) <= 0) {
                verifyNote += ` ⚠️[Astral Quantization: <@${allyId}> KHÔNG có Shield HP — không chỉ định được]`;
              } else {
                encounter.pendingAstralQuantization = encounter.pendingAstralQuantization ?? [];
                encounter.pendingAstralQuantization.push({ userId: p.attackerId, allyId, pct });
                verifyNote += ` 🌌[Astral Quantization: chỉ định <@${allyId}>, cuối turn gây **${pct}%** tổng dmg của họ]`;
              }
            }
            if (p.skillKey === "castigation") {
              attacker.combatant.unlockBladeStage = 0;
              verifyNote += ` 🗝️[Đã tiêu **Unlocked Blade** — chuỗi Unlock reset về 0]`;
            }
            if (p.skillKey === "upstanding slash" && attacker.type === "player") {
              attacker.combatant.imitation = Math.min(IMITATION_MAX ?? 10, (attacker.combatant.imitation ?? 0) + totalHitsThisActionAny);
              verifyNote += ` 🗡️[+${totalHitsThisActionAny} Imitation, tổng ${attacker.combatant.imitation}]`;
            }
            // BUG ĐÃ SỬA (cùng lỗi dấu ":" như ở skill-verification.js) —
            // p.skillKey giữ nguyên dấu ":" từ tên hiển thị gốc.
            const skillKeyNoColonCommit = (p.skillKey ?? "").replace(/:/g, "").trim();
            if ((skillKeyNoColonCommit === "great split vertical" || skillKeyNoColonCommit === "great split horizontal") && attacker.type === "player") {
              attacker.combatant.imitation = Math.max(0, (attacker.combatant.imitation ?? 0) - 5);
              attacker.combatant.imitationConsumedTotal = (attacker.combatant.imitationConsumedTotal ?? 0) + 5;
              verifyNote += ` 🗡️[Tiêu 5 Imitation — tổng đã tiêu ${attacker.combatant.imitationConsumedTotal}, +${Math.min(50, attacker.combatant.imitationConsumedTotal * 5)}% Dmg Bonus vĩnh viễn]`;
            }
            // Set Fire — Page tự buff (không dice, không nhắm target thật) — kích
            // hoạt NGAY khi skill confirm thành công, KHÔNG phụ thuộc evadedCompletely
            // (đây không phải đòn tấn công lên target, tương tự Light Dash/Tactical
            // Suppression). 3 turn tự áp Burn theo weaponWeight lên M1 — xem logic
            // ÁP DỤNG THẬT ở khối xử lý M1 (tìm "setFireTurnsLeft") và đếm ngược ở
            // advanceCombatantTurn.
            if (p.skillKey === "set fire") {
              attacker.combatant.setFireTurnsLeft = 3;
              verifyNote += ` 🔥 Vũ khí bốc cháy trong 3 turn!`;
            }
            // "Light Dash" (Page, KHÁC HOÀN TOÀN "Light Dash" PERK skill tree —
            // trùng tên, không liên quan): "Lướt tới vị trí kẻ thù đồng thời hồi
            // cho bản thân 2 Light và né một đòn tấn công của kẻ địch (không
            // thể né Undodgeable)" — +2 Light NGAY, cộng 1 lượt né MIỄN PHÍ
            // (lightDashFreeEvadeCharges, xử lý riêng ở
            // computeReactiveDefenseOptions/finalizeReactiveChoice). BUG SCOPE
            // ĐÃ SỬA: TRƯỚC ĐÂY đặt nhầm TRONG block if (p.emotionDelta) (chỉ
            // chạy khi có thay đổi Emotion Coin) — Light Dash không liên quan
            // Emotion Coin nên KHÔNG BAO GIỜ chạy — giờ đặt độc lập, giống Set
            // Fire ở trên (cùng loại "Page tự buff bản thân").
            if (p.skillKey === "light dash") {
              attacker.combatant.currentLight = Math.min(attacker.combatant.maxLight, (attacker.combatant.currentLight ?? 0) + 2);
              attacker.combatant.lightDashFreeEvadeCharges = (attacker.combatant.lightDashFreeEvadeCharges ?? 0) + 1;
              verifyNote += ` 💨[Light Dash +2 Light, +1 lượt né miễn phí]`;
            }
            // "Fleet Footsteps" (Page): "dịch chuyển lại gần kẻ địch, né 1 đòn
            // tấn công (không thể né Undodgeable), sau đó nhận 2 Haste" — GIỐNG
            // Light Dash (free evade charge), KHÁC là skill này CÓ tự gây dmg
            // riêng (dmgStr đã tính bình thường qua flow chính, không cần xử lý
            // gì thêm ở đây) — chỉ cần thêm phần free evade + Haste.
            if (p.skillKey === "fleet footsteps") {
              attacker.combatant.haste = (attacker.combatant.haste ?? 0) + 2;
              attacker.combatant.lightDashFreeEvadeCharges = (attacker.combatant.lightDashFreeEvadeCharges ?? 0) + 1;
              verifyNote += ` 🏃[Fleet Footsteps +2 Haste, +1 lượt né miễn phí]`;
            }
            // "Waltz In White" (Page): điều kiện cho "Waltz In Black" (xem
            // comment đầy đủ ở computeAttackerPerkContext) — đánh dấu target
            // này ĐÃ bị Waltz In White trúng round này (waltzInWhiteHitThisRound,
            // sẽ trở thành waltzInWhiteHitLastRound ở round advance kế tiếp).
            // Không cần check hit-thật-sự-trúng riêng vì skill này tự có sẵn
            // [Unevadeable][Unblockable] — luôn trúng theo đúng thiết kế gốc.
            if (p.skillKey === "waltz in white" && p.targets && p.targets[0]) {
              const waltzTarget = resolveCombatant(encounter, p.targets[0].targetId);
              if (waltzTarget) {
                waltzTarget.combatant.waltzInWhiteHitThisRound = true;
                verifyNote += ` ⚔️[Waltz In White đánh dấu — Waltz In Black round sau sẽ x3 Dice + Unevadeable]`;
              }
            }
            // "Coffin" (Fused Blade of Ruined Mirror Worlds passive, đi kèm
            // Dullahan) — xác nhận trực tiếp: "Coffin nhận được trang bị Fused
            // Blade of Ruined Mirror Worlds và sử dụng các page Smackdown,
            // Memorial Procession, Beheading, Greatsword Rend".
            if (attacker.combatant.weaponName === "Fused Blade of Ruined Mirror Worlds"
              && ["smackdown", "memorial procession", "beheading", "greatsword rend"].includes(p.skillKey)) {
              attacker.combatant.coffinStacks = (attacker.combatant.coffinStacks ?? 0) + 1;
              verifyNote += ` ⚰️[+1 Coffin Stack (hiện ${attacker.combatant.coffinStacks})]`;
            }
            // "Dark Cloud" — CẢ 2 passive CÙNG TÊN NHƯNG KHÁC NHAU HOÀN TOÀN
            // (xác nhận trực tiếp: "Dark Cloud từ outfit và weapon là 2
            // passive khác nhau nhưng cùng tên"), CÙNG điều kiện kích hoạt
            // (dùng 1 trong 7 Page của Kurokumo Syndicate Book).
            const KUROKUMO_SYNDICATE_PAGES = ["cloud cutter", "sky clearing cut", "shadowcloud shattercleaver", "dark cloud cleaver", "sober up", "silent mist", "shadowcloud kick"];
            if (KUROKUMO_SYNDICATE_PAGES.includes(p.skillKey)) {
              // WEAPON (Kurokumo Katana): "+2 Bleed cho Page của Kurokumo
              // Syndicate" — áp lên TARGET (không phải attacker).
              if (attacker.combatant.weaponName === "Kurokumo Katana" && p.targets) {
                for (const t of p.targets) {
                  const tResolved = resolveCombatant(encounter, t.targetId);
                  if (tResolved) tResolved.combatant.bleed = Math.min(BLEED_MAX, (tResolved.combatant.bleed ?? 0) + 2);
                }
                verifyNote += ` 🩸[Dark Cloud (Kurokumo Katana): +2 Bleed]`;
              }
              // OUTFIT (Kurokumo Wakashu): "+2 Dark Cloud Stack" — áp lên
              // CHÍNH attacker (stack riêng, không liên quan weapon's Bleed).
              if (attacker.combatant.equippedOutfit === "Kurokumo Wakashu") {
                attacker.combatant.darkCloudOutfitStacks = Math.min(99, (attacker.combatant.darkCloudOutfitStacks ?? 0) + 2);
                verifyNote += ` ☁️[+2 Dark Cloud Stack (hiện ${attacker.combatant.darkCloudOutfitStacks})]`;
              }
            }
            // "Scorch Propellant Round" (Thumb Syndicate ammo) — xác nhận trực
            // tiếp mô tả gốc của TỪNG dòng dice trong skills.js (savage double
            // slash/savage triple slash/blasting shatterslash/tanglecleaver
            // flurry). Tự động tiêu NẾU đủ Stack (không cần hỏi, xác nhận trực
            // tiếp: "giống như Bleed/Burn tự áp"). Cap 20. Áp lên TARGET đầu
            // tiên (4 skill này không AOE, luôn chỉ 1 target).
            const scorchTarget = p.targets?.[0] ? resolveCombatant(encounter, p.targets[0].targetId)?.combatant : null;
            // Snapshot TRƯỚC mọi hook mới (Scorch/Tigermark consumption ở dưới)
            // để tính đúng "phần Tremor/Burn MỚI GÂY THÊM từ hành động này" cho
            // Thumb Capo IIII's half-conversion (xem block cuối cùng bên dưới).
            const tremorBeforeThumbCapo = scorchTarget?.tremor ?? 0;
            const burnBeforeThumbCapo = scorchTarget?.burn ?? 0;
            if (scorchTarget && ["savage double slash", "savage triple slash", "blasting shatterslash", "tanglecleaver flurry"].includes(p.skillKey)) {
              const atk = attacker.combatant;
              let scorchNote = "";
              const burnFromStack = (n) => { scorchTarget.burn = Math.min(BURN_MAX, (scorchTarget.burn ?? 0) + n); };
              const diceUpGain = (n) => { atk.diceUp = (atk.diceUp ?? 0) + n; };
              if (p.skillKey === "savage double slash") {
                // D1: tiêu 1 Stack → +2 Burn. D2: tiêu 1 Stack → +2 Burn +5 DiceUp, SAU ĐÓ +5 Stack (không điều kiện).
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); }
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); diceUpGain(5); }
                atk.scorchPropellantRound = Math.min(20, (atk.scorchPropellantRound ?? 0) + 5);
                scorchNote = ` 🔥[Scorch Propellant Round: tiêu tối đa 2, +5 Stack sau dùng (hiện ${atk.scorchPropellantRound})]`;
              } else if (p.skillKey === "savage triple slash") {
                // D1/D2: tiêu 1 Stack → +2 Burn (D2 thêm +5 DiceUp). D3: tiêu 1
                // Stack → +2 Burn +2 Tremor +5 DiceUp, SAU ĐÓ +5 Stack.
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); }
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); diceUpGain(5); }
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); scorchTarget.tremor = Math.min(TREMOR_MAX, (scorchTarget.tremor ?? 0) + 2); diceUpGain(5); }
                atk.scorchPropellantRound = Math.min(20, (atk.scorchPropellantRound ?? 0) + 5);
                scorchNote = ` 🔥[Scorch Propellant Round: tiêu tối đa 3, +5 Stack sau dùng (hiện ${atk.scorchPropellantRound})]`;
              } else if (p.skillKey === "blasting shatterslash") {
                // D1/D2: tiêu 1 Stack → +2 Burn (D2 thêm +5 DiceUp). D3: tiêu 1
                // Stack → +Burn = Tremor hiện tại của target +5 DiceUp. KHÔNG
                // có "nhận lại Stack" (không nhắc trong mô tả gốc).
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); }
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); diceUpGain(5); }
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(scorchTarget.tremor ?? 0); diceUpGain(5); }
                scorchNote = ` 🔥[Scorch Propellant Round: tiêu tối đa 3 (hiện ${atk.scorchPropellantRound})]`;
              } else if (p.skillKey === "tanglecleaver flurry") {
                // D1/D2: tiêu 1 Stack → +2 Burn +5 DiceUp. D3: TIÊU TOÀN BỘ
                // Stack → +Burn = Tremor hiện tại + 3 DiceUp/Stack xả, VÀ nếu
                // ĐÃ có ≥15 Stack TRƯỚC khi xả thì kích hoạt thêm Tremor Burst.
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); diceUpGain(5); }
                if ((atk.scorchPropellantRound ?? 0) >= 1) { atk.scorchPropellantRound -= 1; burnFromStack(2); diceUpGain(5); }
                const stackBeforeDump = atk.scorchPropellantRound ?? 0;
                if (stackBeforeDump > 0) {
                  atk.scorchPropellantRound = 0;
                  burnFromStack(scorchTarget.tremor ?? 0);
                  diceUpGain(3 * stackBeforeDump);
                  if (stackBeforeDump >= 15) {
                    const tbResult = calcMathCore({ dmgStr: "0B+TremorBurst", resStr: combatantResStr(scorchTarget), tremorInit: scorchTarget.tremor ?? 0 });
                    applyHpLoss(scorchTarget, tbResult.totalDmg);
                    scorchTarget.currentStamina = Math.max(0, scorchTarget.currentStamina - tbResult.totalTremorStaminaLoss);
                    scorchTarget.tremor = tbResult.finalTremor;
                  }
                }
                scorchNote = ` 🔥[Scorch Propellant Round: xả ${stackBeforeDump} Stack ở dòng cuối]`;
              }
              verifyNote += scorchNote;
            }
            // "Triple Slash - Blast [爆]" (Tiantui Star's Blade Critical) — xác
            // nhận trực tiếp: "Tiêu thụ toàn bộ Tigermark Round có trên người.
            // Cứ mỗi 1 Tigermark Round được tiêu thụ thì gây thêm 1 Burn và 1
            // Tremor tương ứng. Nếu có trên hoặc bằng 6 Tigermark Round thì sẽ
            // Tremor Burst".
            if (p.skillKey === "triple slash blast [爆]" && scorchTarget && (attacker.combatant.tigermarkRound ?? 0) > 0) {
              const consumed = attacker.combatant.tigermarkRound;
              attacker.combatant.tigermarkRound = 0;
              scorchTarget.burn = Math.min(BURN_MAX, (scorchTarget.burn ?? 0) + consumed);
              scorchTarget.tremor = Math.min(TREMOR_MAX, (scorchTarget.tremor ?? 0) + consumed);
              let tsbNote = ` 🐯[Triple Slash Blast: tiêu ${consumed} Tigermark Round → +${consumed} Burn/+${consumed} Tremor]`;
              if (consumed >= 6) {
                const tbR = calcMathCore({ dmgStr: "0B+TremorBurst", resStr: combatantResStr(scorchTarget), tremorInit: scorchTarget.tremor ?? 0 });
                applyHpLoss(scorchTarget, tbR.totalDmg);
                scorchTarget.currentStamina = Math.max(0, scorchTarget.currentStamina - tbR.totalTremorStaminaLoss);
                scorchTarget.tremor = tbR.finalTremor;
                tsbNote += ` + Tremor Burst (-${tbR.totalTremorStaminaLoss} Sta/-${tbR.totalDmg.toFixed(3)} HP)`;
              }
              verifyNote += tsbNote;
            }
            // "Savage Tigerslayer's Perfected Flurry of Blades [超絕猛虎殺擊亂斬]"
            // — xác nhận trực tiếp: "Tiêu thụ toàn bộ Savage Tigermark Round có
            // trên người. Cứ mỗi 1 Savage Tigermark Round được tiêu thụ thì gây
            // thêm 1 Burn, 1 Tremor tương ứng vào Dice cuối".
            if (p.skillKey === "savage tigerslayer's perfected flurry of blades [超絕猛虎殺擊亂斬]" && scorchTarget && (attacker.combatant.savageTigermarkRound ?? 0) > 0) {
              const consumed = attacker.combatant.savageTigermarkRound;
              attacker.combatant.savageTigermarkRound = 0;
              scorchTarget.burn = Math.min(BURN_MAX, (scorchTarget.burn ?? 0) + consumed);
              scorchTarget.tremor = Math.min(TREMOR_MAX, (scorchTarget.tremor ?? 0) + consumed);
              verifyNote += ` 🐯[Savage Tigerslayer Flurry: tiêu ${consumed} Savage Tigermark Round → +${consumed} Burn/+${consumed} Tremor]`;
            }
            // "Re-Load" (Soldato Rifle + outfit The Thumb Syndicate, Page
            // không tốn slot) — xác nhận trực tiếp: "Nạp một nửa số đạn tối đa
            // của vũ khí. Số đạn nạp được từ Page này có thể tùy chọn giữa
            // đạn thường, Frost Ammo và Incendiary Ammo tùy ý" — KHÔNG tiêu
            // inventory (khác lệnh -encounter reload có sẵn). Loại đã kiểm
            // tra xung đột ở doPlayerHit (declare) — ở đây chỉ cần nạp thật.
            if (p.skillKey === "re-load" && attacker.combatant.weaponName === "Soldato Rifle") {
              const loadAmount = 4; // floor(8/2) theo customLoad.max=8, half=true
              const loadType = p.loadType ?? "ammo";
              attacker.combatant.bulletStack = Math.min(8, (attacker.combatant.bulletStack ?? 0) + loadAmount);
              attacker.combatant.bulletStackType = loadType;
              verifyNote += ` 🔫[Re-Load: +${loadAmount} đạn ${loadType} (tổng ${attacker.combatant.bulletStack}/8)]`;
              // "Thumb Soldato" (outfit): "Đồng minh thuộc Thumb ở trong trận
              // sẽ nhận được đạn đặc biệt của riêng họ bằng một nửa số đạn mà
              // bạn nạp được (làm tròn lên) thông qua Re-Load" — chỉ khi
              // CHÍNH attacker có Thumb Soldato (không phải đồng minh).
              if (attacker.combatant.equippedOutfit === "Thumb Soldato") {
                const shareAmount = Math.ceil(loadAmount / 2);
                for (const [allyId, ally] of Object.entries(encounter.players)) {
                  if (allyId === p.attackerId) continue;
                  if (!(ally.equippedOutfit ?? "").startsWith("Thumb")) continue;
                  if ((ally.bulletStack ?? 0) > 0 && ally.bulletStackType && ally.bulletStackType !== loadType) continue; // tôn trọng "chỉ 1 loại" của chính đồng minh
                  ally.bulletStack = Math.min(8, (ally.bulletStack ?? 0) + shareAmount);
                  ally.bulletStackType = loadType;
                  verifyNote += ` 🤝[Thumb Soldato: ${ally.name} nhận +${shareAmount} đạn ${loadType} (tổng ${ally.bulletStack}/8)]`;
                }
              }
            }
            // "Ignite Weaponry" (Liu Association, Page không tốn slot) — xác
            // nhận trực tiếp: "Đốt cháy vũ khí của bạn trong 2 Turn, khiến cho
            // đòn đánh thường sẽ áp 1/2/4 [Light/Medium/Heavy] Burn lên kẻ
            // địch" — kích hoạt hiệu ứng (giảm dần mỗi turn end ở turn-advance.js).
            if (p.skillKey === "ignite weaponry") {
              attacker.combatant.weaponIgnitedTurnsLeft = 2;
              verifyNote += ` 🔥[Ignite Weaponry: vũ khí bốc cháy trong 2 Turn]`;
            }
            // M1 tự động áp Burn theo weaponWeight khi vũ khí đang bốc cháy
            // (weaponIgnitedTurnsLeft > 0) — 1/2/4 Burn cho Light/Medium/Heavy.
            if (scorchTarget && (attacker.combatant.weaponIgnitedTurnsLeft ?? 0) > 0) {
              const isM1TypeForIgnite = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
              if (isM1TypeForIgnite) {
                const IGNITE_BURN_BY_WEIGHT = { light: 1, medium: 2, heavy: 4 };
                const igniteBurnAmount = IGNITE_BURN_BY_WEIGHT[attacker.combatant.weaponWeight ?? "medium"] ?? 2;
                scorchTarget.burn = Math.min(BURN_MAX, (scorchTarget.burn ?? 0) + igniteBurnAmount);
                verifyNote += ` 🔥[Vũ khí bốc cháy: +${igniteBurnAmount} Burn]`;
              }
            }
            // "Tactical Suppression" (Eye Of Horus) — GAP ĐÃ SỬA (xác nhận trực
            // tiếp: "còn chưa được tự động hóa hết") — "Nếu đánh thường trong
            // trạng thái này: tiêu thụ toàn bộ Charge thành Charge Shield lên
            // bản thân" — PHẦN NÀY tự động hoá được hoàn toàn (khác "Khiêu
            // khích"/"Block húc vào 1 kẻ địch" cần GM/player tự chọn target).
            if (attacker.combatant.tacticalSuppressionActive) {
              const isM1TypeForTacticalSuppression = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
              if (isM1TypeForTacticalSuppression && (attacker.combatant.charge ?? 0) > 0) {
                const chargeConverted = attacker.combatant.charge;
                attacker.combatant.chargeShieldStack = Math.min(20, (attacker.combatant.chargeShieldStack ?? 0) + chargeConverted);
                attacker.combatant.charge = 0;
                verifyNote += ` 🛡️[Tactical Suppression: tiêu ${chargeConverted} Charge → +${chargeConverted} Charge Shield]`;
              }
            }
            // "Thumb Capo IIII" (outfit) — xác nhận trực tiếp: "Khi sử dụng
            // Tiantui Star's Blade: Khi gây Tremor bạn sẽ áp thêm Burn bằng một
            // nửa count của Tremor và ngược lại" — chỉ tính PHẦN MỚI GÂY THÊM
            // từ hành động này (so với snapshot lúc đầu), KHÔNG áp lại lên toàn
            // bộ stack cũ, và KHÔNG đệ quy (chỉ 1 lượt chuyển đổi duy nhất,
            // dùng số Tremor/Burn mới gây GỐC — tránh vòng lặp vô hạn).
            if (scorchTarget && attacker.combatant.equippedOutfit === "Thumb Capo IIII" && attacker.combatant.weaponName === "Tiantui Star's Blade [天退星刀]") {
              const gainedTremor = Math.max(0, (scorchTarget.tremor ?? 0) - tremorBeforeThumbCapo);
              const gainedBurn = Math.max(0, (scorchTarget.burn ?? 0) - burnBeforeThumbCapo);
              const extraBurnFromTremor = Math.floor(gainedTremor / 2);
              const extraTremorFromBurn = Math.floor(gainedBurn / 2);
              if (extraBurnFromTremor > 0) scorchTarget.burn = Math.min(BURN_MAX, (scorchTarget.burn ?? 0) + extraBurnFromTremor);
              if (extraTremorFromBurn > 0) scorchTarget.tremor = Math.min(TREMOR_MAX, (scorchTarget.tremor ?? 0) + extraTremorFromBurn);
              if (extraBurnFromTremor > 0 || extraTremorFromBurn > 0) {
                verifyNote += ` 👊[Thumb Capo IIII: +${extraBurnFromTremor} Burn (từ Tremor)/+${extraTremorFromBurn} Tremor (từ Burn)]`;
              }
            }
            // "Tactical Suppression" (Eye Of Horus Critical) — xác nhận trực
            // tiếp: "Khiêu khích toàn bộ kẻ địch, bản thân nhận 50 HP Shield x
            // Số lượng người trên sân trong 2 Turn. Heal lại lượng máu = Lượng
            // HP Shield hao hụt sau 2 turn." — "Khiêu khích" KHÔNG tự động hoá
            // được (hệ thống này GM tự chọn target khi tấn công, không có AI
            // ép buộc target) — chỉ là flavor text hiển thị, GM tự lưu ý.
            if (p.skillKey === "tactical suppression") {
              const totalPeopleOnField = Object.keys(encounter.enemies).length + Object.keys(encounter.players).length;
              const shieldGranted = 50 * totalPeopleOnField;
              attacker.combatant.shieldHp = (attacker.combatant.shieldHp ?? 0) + shieldGranted;
              attacker.combatant.tacticalSuppressionActive = true;
              attacker.combatant.tacticalSuppressionTurnsLeft = 2;
              attacker.combatant.tacticalSuppressionShieldGranted = shieldGranted;
              verifyNote += ` 🛡️[Tactical Suppression: +${shieldGranted} Shield HP (${totalPeopleOnField} người × 50), 2 turn]`;
            }
            if (p.emotionDelta) {
              const levelNotes = applyEmotionDelta(attacker.combatant, p.emotionDelta);
              verifyNote += ` [Coin ${p.emotionDelta >= 0 ? "+" : ""}${p.emotionDelta}]`;
              if (levelNotes.length > 0) {
                verifyNote += " " + levelNotes.join(" ");
                // GAP ĐÃ SỬA (batch 5) — "Philip" (The Crying Children): LÊN
                // level mới (không phải đang giữ nguyên level cũ) → +2 Dice Up
                // nếu Level 1, +4 nếu Level 2 — dùng emotionLevel THẬT SAU khi
                // applyEmotionDelta đã cập nhật (không parse text levelNotes).
                const philipWeapon = findWeaponAnywhere(attacker.combatant.weaponName);
                const hasPhilip = (philipWeapon?.passives ?? []).some(pa => pa.name === "Philip");
                if (hasPhilip) {
                  const philipDiceUp = attacker.combatant.emotionLevel === 1 ? 2 : (attacker.combatant.emotionLevel === 2 ? 4 : 0);
                  if (philipDiceUp > 0) {
                    attacker.combatant.diceUp = (attacker.combatant.diceUp ?? 0) + philipDiceUp;
                    verifyNote += ` 🎭[Philip +${philipDiceUp} Dice Up]`;
                  }
                }
                // "Liu Association": "Nhận được thêm 2 Dice Up khi bạn ở trong
                // Emotion Level" — LÊN level mới (emotionLevel >= 1) → +2 Dice Up.
                if (attacker.combatant.hasLiuAssociation && attacker.combatant.emotionLevel >= 1) {
                  attacker.combatant.diceUp = (attacker.combatant.diceUp ?? 0) + 2;
                  verifyNote += ` 🏮[Liu Association +2 Dice Up]`;
                }
              }
            }

            // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — Index
            // Proselyte's Dice 1 ("Tấn công 1 lần") — áp dụng cho MỌI loại tấn
            // công (M1/Critical/Page), không chỉ riêng M1 — đây là điểm CHUNG
            // cho tất cả (sau khi damage đã áp dụng thành công).
            if (attacker.type === "player") attacker.combatant.prescriptAttacked = true;
            resultLines.push(`${attacker.label}${staminaNote}${verifyNote}${eyeOfHorusRepeatLightNote}${bleedSelfNote} → ${targetDmgLines.join(", ")} (\`${p.dmgStr}\`)`);

  // Stage 5 (quest system) — check THẮNG/THUA NGAY SAU KHI resolve xong action
  // này (đã biết HP mới nhất của MỌI enemy/player).
  // ĐÃ TÁCH sang quest-resolution.js's finalizeQuestOutcome — TRƯỚC ĐÂY toàn bộ
  // khối này nằm inline ở đây, nghĩa là quest CHỈ kết thúc được qua đường
  // "resolve 1 pendingAction". performEndTurn (GM bấm kết thúc turn, hoặc enemy
  // cuối chết vì DoT tick) KHÔNG bao giờ chạy qua đây → contract không tự end.
  // Xem comment đầy đủ ở finalizeQuestOutcome.
  // GAP ĐÃ SỬA (Fragaria: "action log nó khá kỳ, không thể hiện được rõ").
  // TRƯỚC ĐÂY action log CHỈ ghi "dùng skill X" / "bỏ qua lượt" / "kết thúc lượt"
  // — tức là CHỈ Ý ĐỊNH, KHÔNG có KẾT QUẢ: ai trúng ai, mất bao nhiêu HP, phòng
  // thủ kiểu gì, ai gục. Xem lại log để debug thì không suy ra được gì.
  // Giờ ghi luôn dòng kết quả (chính là `resultLines` vẫn gửi ra channel), gắn
  // type "resolve" để phân biệt với dòng ý định.
  if (resultLines.length > 0) appendActionLog(encounter, resultLines, "resolve");
  // BẮT BUỘC đợi hook -daily (nhiệm vụ 3) nhả lock userId TRƯỚC khi
  // finalizeQuestOutcome đi phát thưởng + đánh dấu nhiệm vụ 2 trên CÙNG userId
  // đó — xem comment đầy đủ ở khai báo dailyKillHookPromises.
  if (dailyKillHookPromises.length > 0) await Promise.all(dailyKillHookPromises);
  resultLines.push(...(await finalizeQuestOutcome(encounter)));

  return resultLines;
}

  return { resolveOnePendingAction };
};
