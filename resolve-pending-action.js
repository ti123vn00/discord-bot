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

module.exports = function ({ BLEED_MAX, BURN_MAX, CHARGE_MAX, ENCOUNTER_SANITY_MAX, HEMORRHAGE_MAX, POISE_MAX, TREMOR_MAX, WEAPON_DEFENSE_HITS, applyDeathPenalty, applyEmotionDelta, applyEvadeSuccessPerks, applyParrySuccessPerks, applySanityGain, calcMathCore, checkStaggerPanic, combatantResStr, findSkill, findWeaponAnywhere, forceStagger, getPlayerDataWithSlot, hasPerk, resolveCombatant, rollInjury, saturateDR, savePlayerData }) {

async function resolveOnePendingAction(encounter, p) {
  const resultLines = [];
            const attacker = resolveCombatant(encounter, p.attackerId);
            if (!attacker) { resultLines.push(`⚠️ Bỏ qua 1 action — không tìm thấy attacker ${p.attackerId} (có thể đã rời encounter).`); return resultLines; }

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
              checkStaggerPanic(attacker.combatant);
              staminaNote = ` (-${p.staminaCost} Sta${attacker.combatant.staggered ? " 💫Stagger!" : ""})`;
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
              const bleedBeforeHit = target.bleed; // Craving Synergy/Thirst/Break the Dams cần biết TRƯỚC khi finalBleed ghi đè
              burnBeforeMap[t.targetId] = target.burn ?? 0;
              let finalDmg = t.preview.totalDmg;
              let defenseNote = "";
              let evadedCompletely = false;
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
              const guardReductionPct = Math.min(1, Math.max(0, baseGuardPct + defenseUpDownPct));
              // GAP ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp thật: "hệ thống tùy
              // chọn né theo từng hit... nhận hit 1 và 2 nhưng né/guard hit 3")
              // — TRƯỚC ĐÂY chỉ M1 mới có logic per-hit (cho phép trộn nhiều loại
              // phòng thủ + chọn hit cụ thể qua guardHitSelections), skill dùng
              // nhánh "fraction" đơn giản hơn (không chọn được hit nào). Giờ CẢ
              // 2 dùng CHUNG 1 logic per-hit — nhất quán, hỗ trợ chọn hit cụ thể
              // cho MỌI loại đòn (M1 hay skill).
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
                // GAP ĐÃ SỬA (xác nhận trực tiếp: "khi né hoặc parry thành công
                // thì sẽ không dính đòn nên sẽ không dính hiệu ứng, còn nếu
                // guard thì vẫn dính hiệu ứng") — perHitMult=0 KHÔNG đủ để biết
                // "có dính hiệu ứng hay không", vì Guard cũng CÓ THỂ đạt đúng 0
                // (guardReductionPct = Math.min(1,...) có thể = 1 nếu Defense Up
                // rất cao) — trong trường hợp đó Guard vẫn phải tính là "dính",
                // chỉ Evade/Parry mới thực sự "không dính". Array riêng này CHỈ
                // được set true bởi Evade/Parry thành công, không bao giờ bởi Guard.
                const hitEvadedOrParried = new Array(totalHits).fill(false);
                let hitIdx = 0;
                const noteParts = [];

                if (!bypass.blockEvade && (target.evadeCharges ?? 0) > 0 && ((target.evadeHitSelections ?? []).length > 0 || hitIdx < totalHits)) {
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
                    target.evadeHitSelections = target.evadeHitSelections.filter(h => !(h >= 1 && h <= totalHits));
                    hitIdx = Math.max(hitIdx, ...validSelected, 0);
                    noteParts.push(`💨**Evade** (${used} charge — né hit ${validSelected.join(", ")})${applyEvadeSuccessPerks(target, attacker.combatant)}`);
                  } else {
                    while (target.evadeCharges > 0 && hitIdx < totalHits) {
                      target.evadeCharges -= 1; used += 1;
                      for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) { perHitMult[hitIdx] = 0; hitEvadedOrParried[hitIdx] = true; }
                    }
                    noteParts.push(`💨**Evade** (${used} charge — né hit ${coverStart + 1}-${hitIdx})${applyEvadeSuccessPerks(target, attacker.combatant)}`);
                  }
                }
                if (!bypass.blockParry && (target.parryHitSelections ?? []).length > 0) {
                  // GAP ĐÃ SỬA (đối xứng với evadeHitSelections/guardHitSelections
                  // — xác nhận trực tiếp: "hit 1 né, hit 2 guard, hit 3 né/parry")
                  // — parryRolls[i] ứng ĐÚNG với parryHitSelections[i] (cùng thứ tự
                  // đẩy vào lúc chọn từng hit).
                  const validSelected = target.parryHitSelections.filter(h => h >= 1 && h <= totalHits);
                  for (const h of validSelected) {
                    const defRoll = target.parryRolls.shift();
                    if (defRoll === undefined) break;
                    const atkRoll = 1 + Math.floor(Math.random() * 20);
                    const won = defRoll >= atkRoll;
                    if (won) {
                      perHitMult[h - 1] = 0; hitEvadedOrParried[h - 1] = true;
                      noteParts.push(`🗡️**Parry THÀNH CÔNG** (${defRoll} vs ${atkRoll} — né hit ${h})${applyParrySuccessPerks(target, attacker.combatant)}`);
                    } else {
                      const baseFailCost = hasPerk(target, "Mastered Breaths") ? 30 : 40;
                      const failCost = (target.injuries ?? []).includes("Gãy tay") ? baseFailCost * 2 : baseFailCost;
                      target.currentStamina = Math.max(0, target.currentStamina - failCost);
                      noteParts.push(`🗡️**Parry THẤT BẠI** (${defRoll} vs ${atkRoll}, -${failCost} Sta — ăn full hit ${h})`);
                    }
                  }
                  target.parryHitSelections = target.parryHitSelections.filter(h => !(h >= 1 && h <= totalHits));
                  hitIdx = Math.max(hitIdx, ...validSelected, 0);
                } else while (!bypass.blockParry && (target.parryRolls ?? []).length > 0 && hitIdx < totalHits) {
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
                  }
                }
                if (!bypass.blockGuard && (target.guardCharges ?? 0) > 0 && ((target.guardHitSelections ?? []).length > 0 || hitIdx < totalHits)) {
                  const coverStart = hitIdx;
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
                    while (hitIdx < totalHits) { perHitMult[hitIdx] = 1 - guardReductionPct; hitIdx++; }
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
                    for (const h of validSelected) perHitMult[h - 1] = 1 - guardReductionPct;
                    const chargesUsed = Math.min(target.guardCharges, Math.ceil(validSelected.length / hitsPerCharge));
                    target.guardCharges = Math.max(0, target.guardCharges - chargesUsed);
                    target.guardHitSelections = target.guardHitSelections.filter(h => !(h >= 1 && h <= totalHits));
                    hitIdx = totalHits; // đã xử lý xong khối Guard này (dù không tuần tự) — không loại khác che tiếp lên các hit CHƯA được chỉ định
                    noteParts.push(`🛡️**Guard (chọn riêng)** (${chargesUsed} charge, giảm ${Math.round(guardReductionPct * 100)}% — hit ${validSelected.join(",")})`);
                  } else {
                    let used = 0;
                    while (target.guardCharges > 0 && hitIdx < totalHits) {
                      target.guardCharges -= 1; used += 1;
                      for (let k = 0; k < hitsPerCharge && hitIdx < totalHits; k++, hitIdx++) perHitMult[hitIdx] = 1 - guardReductionPct;
                    }
                    noteParts.push(`🛡️**Guard** (${used} charge, giảm ${Math.round(guardReductionPct * 100)}% — hit ${coverStart + 1}-${hitIdx})`);
                  }
                  // Guard Break: Guard VẪN cản được (đã giảm dmg ở trên), nhưng bên
                  // Guard bị Stagger NGAY (không đợi Stamina về 0) — xác nhận trực
                  // tiếp từ GM, KHÁC hẳn Unblockable (vốn làm Guard không cản được).
                  if (bypass.guardBreak) {
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
                    }
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
                // evadedCompletely CHỈ true nếu TOÀN BỘ hit đều = 0 — vì Guard KHÔNG
                // BAO GIỜ đạt 0 (tối đa giảm 99%), nên nếu true thì chắc chắn do
                // Evade/Parry-thành-công che hết, không lẫn Guard.
                evadedCompletely = totalHits > 0 && perHitMult.every((m) => m === 0);
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
                  if (diceEffectSkill?.diceEffects && diceEffectSkill.diceEffects.length === totalHits) {
                    diceEffectSkill.diceEffects.forEach((effect, i) => {
                      if (!effect) return;
                      if (hitEvadedOrParried[i]) return; // GAP ĐÃ SỬA: chỉ Evade/Parry THÀNH CÔNG mới không dính hiệu ứng — Guard (kể cả 100% reduction) vẫn tính là "dính"
                      if (effect.diceUp) {
                        attacker.combatant.diceUp = (attacker.combatant.diceUp ?? 0) + effect.diceUp;
                        // BUG ĐÃ SỬA: verifyNote CHƯA tồn tại ở scope này (khai
                        // báo sau, gây TDZ error "Cannot access before
                        // initialization") — dùng defenseNote (đã tồn tại sẵn).
                        defenseNote += ` 🎲[Dice ${i + 1} +${effect.diceUp} Dice Up]`;
                      }
                    });
                  }
                }
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
                  attacker.combatant.currentHp = Math.min(attacker.combatant.maxHp, attacker.combatant.currentHp + healAmt);
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
              target.currentHp = Math.max(0, target.currentHp - finalDmg);
              // "Hana Association": "+1 Dice Up mỗi 10 HP mất trong turn" — tích
              // luỹ hpLostThisTurn, so sánh ngưỡng 10 TRƯỚC/SAU để chỉ cộng phần
              // CHÊNH LỆCH (không ghi đè diceUp có thể đã tăng từ nguồn khác).
              if (target.hasHanaAssociation && finalDmg > 0) {
                const thresholdBefore = Math.floor((target.hpLostThisTurn ?? 0) / 10);
                target.hpLostThisTurn = (target.hpLostThisTurn ?? 0) + finalDmg;
                const thresholdAfter = Math.floor(target.hpLostThisTurn / 10);
                if (thresholdAfter > thresholdBefore) {
                  target.diceUp = (target.diceUp ?? 0) + (thresholdAfter - thresholdBefore);
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
                  attacker.combatant.currentHp = Math.max(0, attacker.combatant.currentHp - reflectedDmg);
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
                target.currentHp = Math.min(target.maxHp, target.currentHp + regenConsumed);
                regenHealNote = ` 💚+${regenConsumed} HP (Regen, còn ${target.regen}${hemorrhageHealNote})`;
              }
              const justDied = wasAliveBefore && target.currentHp <= 0;
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
              let deathNote = "";
              if (justDied && targetResolved.type === "player") {
                deathNote = await applyDeathPenalty(encounter, t.targetId);
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
                if (target.bleed > bleedBeforeThisHit) {
                  target.hemorrhage = Math.min(HEMORRHAGE_MAX, (target.hemorrhage ?? 0) + 1);
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
                  target.currentHp = Math.max(0, target.currentHp - target.haouSinking);
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
                // Fairy (50-Status Nhóm 2, xác nhận trực tiếp): "trừ HP = count/3
                // MỖI Action" — giả định (đã nêu ở combatant-factory.js): "mỗi
                // Action" = mỗi lần CHÍNH attacker (người mang Fairy) hành động —
                // tự trừ HP BẢN THÂN, KHÔNG liên quan tới target đang đánh. Đặt
                // trong loop targets.map nên với AOE nhiều target CÙNG 1 action sẽ
                // CHỈ tính đúng 1 lần cho action đó — kiểm tra targetIdx===0 để
                // tránh trừ lặp lại theo số target.
                if (p.targets.indexOf(t) === 0 && (attacker.combatant.fairy ?? 0) > 0) {
                  attacker.combatant.currentHp = Math.max(0, attacker.combatant.currentHp - Math.floor(attacker.combatant.fairy / 3));
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
                if (p.effectiveBulletType === "frost") {
                  target.paralyze = Math.min(99, (target.paralyze ?? 0) + 1);
                } else if (p.effectiveBulletType === "incendiary") {
                  target.burn = Math.min(BURN_MAX, (target.burn ?? 0) + 2);
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
              targetDmgLines.push(`${targetResolved.label} -${finalDmg.toFixed(3)} HP${killNote}${deathNote}${defenseNote}${perkNote}${injuryNote}${eyeOfHorusNote}${fragileNote}${karmicNote}${smokeNote}${chargeShieldNote}${protectionNote}${dieciSinkingNote}${liuAssociationNote}${regenHealNote}${timeMoratoriumNote}${paybackNote}`);
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
                attacker.combatant.currentHp = Math.max(0, attacker.combatant.currentHp - bleedSelfDmg);
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
              attacker.combatant.currentHp = Math.max(0, attacker.combatant.currentHp - haouBleedSelfDmg);
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
              // "Thumb Soldato" (outfit, không phải weapon mechanic) — "Mỗi đòn
              // đánh thường thứ 4 bạn sẽ nhận được 1 đạn" — max 8.
              if (attacker.combatant.hasThumbSoldato && attacker.combatant.m1AttackCount % 4 === 0) {
                attacker.combatant.bulletStack = Math.min(8, (attacker.combatant.bulletStack ?? 0) + 1);
                resultLines.push(`🔫 **Thumb Soldato** — ${attacker.label} nhận 1 đạn (tổng ${attacker.combatant.bulletStack}/8).`);
              }
              // "Liu Association" ĐÃ DI CHUYỂN ra khỏi block if (p.isM1) này —
              // xem ngay bên dưới (sau block M1-count kết thúc) — passive gốc
              // KHÔNG giới hạn "chỉ M1", nên phải kiểm tra cho MỌI loại hành động.
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
                    dcTarget.currentHp = Math.max(0, dcTarget.currentHp - dcTotalDmg);
                    checkStaggerPanic(dcTarget);
                    resultLines.push(`🩸 **Dark Cloud** — ${tResolved.label} bị nổ Bleed ${darkCloudExplodeGain} lần, mất ${dcTotalDmg} HP.`);
                  }
                }
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
              attacker.combatant.skillCooldowns[p.skillKey] = p.cooldownTurns + 1;
              verifyNote += ` [CD ${p.skillKey}: ${p.cooldownTurns}T]`;
            }
            // orlandoFuriosoBypass — GAP ĐÃ SỬA (xác nhận trực tiếp) — TIÊU THỤ
            // bypass sau khi commit (cooldownTurns đã = 0 từ lúc declare, ở đây chỉ
            // cần clear flag để KHÔNG lặp lại miễn CD cho Critical LẦN SAU nữa).
            if (p.orlandoFuriosoBypassConsumed) {
              attacker.combatant.orlandoFuriosoBypass = false;
              // Xoá SẠCH CD cũ (nếu có) — "miễn CD" nghĩa là hoàn toàn không bị
              // ảnh hưởng, không chỉ bỏ qua check 1 lần rồi vẫn giữ CD cũ lại.
              if (attacker.combatant.skillCooldowns && p.skillKey) {
                attacker.combatant.skillCooldowns[p.skillKey] = 0;
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
            if (p.skillKey === "upstanding slash" && attacker.type === "player") {
              attacker.combatant.imitation = (attacker.combatant.imitation ?? 0) + totalHitsThisActionAny;
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
                    scorchTarget.currentHp = Math.max(0, scorchTarget.currentHp - tbResult.totalDmg);
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
                scorchTarget.currentHp = Math.max(0, scorchTarget.currentHp - tbR.totalDmg);
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

  return resultLines;
}

  return { resolveOnePendingAction };
};
