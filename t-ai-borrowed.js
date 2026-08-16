// t-ai-borrowed.js — Fragaria 14/08: *"Eye Gouger bị lỗi không xài Borrowed Eyes."*
//
// BA khâu hỏng nối tiếp nhau, sửa một khâu vẫn không chạy:
//   1. CHỌN — `pickOffensiveSkill` sort `lightCost` GIẢM DẦN rồi lấy phần tử ĐẦU.
//      Borrowed Eyes tốn **0 Light** ⇒ vĩnh viễn xếp chót sau 5 page kia (đều ≥1),
//      không bao giờ tới lượt.
//   2. CHẠY — nhánh tấn công bị chặn bởi `if (rolled.dmgStr)`. Dice của page này
//      KHÔNG mang tag loại dmg (đúng thiết kế "Dice này KHÔNG gây dmg") nên
//      `autoBuildDmgStrFromSkillRoll` trả null ⇒ cả khối bị bỏ qua IM LẶNG.
//   3. CẤP BUFF — logic cấp charge chỉ nằm trong `resolve-pending-action`, tức chỉ
//      chạy khi có `pendingAction`, mà AI không tạo được (xem khâu 2).
const fs = require("fs");
const C = require("./constants.js");
const skills = require("./skills.js");
const QD = require("./quest-data.js");
const cu = require("./combat-utils.js")({
  CADUCEUS_DICE: C.CADUCEUS_DICE, hasPerk: () => false,
  ENCOUNTER_SANITY_MAX: 45, CHARGE_MAX: 20, UNLOCK_THRESHOLDS: [3, 6, 9],
});

let fails = 0;
const A = (c, m) => { if (!c) { fails++; console.log("❌ " + m); } else console.log("✅ " + m); };

const ai = fs.readFileSync("enemy-ai.js", "utf8");
const EG = QD.QUEST_MOBS?.eyegouger;

(async () => {
  console.log("── DỮ LIỆU: Eye Gouger CÓ page này từ đầu ──");
  A(!!EG, `tìm được mob eyegouger`);
  A((EG?.skills ?? []).some(n => /^borrowed eyes$/i.test(n)),
    `Borrowed Eyes nằm trong skill list: ${JSON.stringify(EG?.skills ?? [])}`);
  const be = skills.findSkill("borrowed eyes");
  A(!!be && be.noDirectDamage && be.unclashable,
    `page: cd ${be?.cd} · noDirectDamage ${!!be?.noDirectDamage} · unclashable ${!!be?.unclashable}`);

  console.log("\n── KHÂU 1: page 0 Light KHÔNG còn bị xếp chót ──");
  {
    // Chạy THẬT `pickUtilitySkill` trích từ source (không gõ lại — lớp lỗi 15).
    const a0 = ai.indexOf("function pickUtilitySkill(mob) {");
    A(a0 > 0, "có hàm pickUtilitySkill riêng cho page utility");
    const a1 = ai.indexOf("\n  }", ai.indexOf("return null;", a0)) + 4;
    const fnSrc = ai.slice(a0, a1);
    const pick = new Function("findSkill", "parseSkillCost", `${fnSrc}\nreturn pickUtilitySkill;`)(
      skills.findSkill,
      (c) => { const m = /(\d+)/.exec(String(c)); return { light: m ? parseInt(m[1], 10) : null }; },
    );
    const mob = (o = {}) => Object.assign({
      unlockedPagesSnapshot: EG.skills, currentLight: 6, skillCooldowns: {}, borrowedEyeCharges: 0,
    }, o);
    const got = pick(mob());
    A(got?.key === "borrowed eyes", `AI chọn được "${got?.name}" (trước đây: không bao giờ)`);
    A(got?.isUtility === true, "đánh dấu isUtility ⇒ đi đường thực thi riêng");

    console.log("\n── KHÂU 1b: luật Fragaria — mở encounter dùng, rồi CỨ HẾT CD LÀ DÙNG ──");
    A(pick(mob({ skillCooldowns: {} }))?.key === "borrowed eyes",
      "lượt đầu (CD 0) → dùng ngay khi mở encounter");
    A(pick(mob({ borrowedEyeCharges: 5 }))?.key === "borrowed eyes",
      "CÒN 5 charge nhưng hết CD → VẪN dùng (không gác theo charge)");
    A(pick(mob({ skillCooldowns: { "borrowed eyes": 4 } })) === null, "đang CD → không dùng");
  }

  console.log("\n── KHÂU 2: đường thực thi riêng, KHÔNG chiếm lượt tấn công ──");
  // Fragaria: *"nó không liên quan gì tới các act tấn công khác của Eye Gouger —
  // nó là phụ trợ phòng thủ thôi."*
  {
    const i0 = ai.indexOf("async function runUtilityPages(");
    A(i0 > 0, "có hàm runUtilityPages riêng");
    const seg = ai.slice(i0, ai.indexOf("async function attemptOneMobAction", i0));
    A(/mob2\.currentLight -= chosen\.lightCost/.test(seg) && /skillCooldowns\[chosen\.key\] = cd/.test(seg),
      "vẫn trừ Light và set CD như page thường");
    A(/withLock\(encounterKey\(channelId\)/.test(seg), "đọc-sửa-ghi nằm trong lock (chống lost-update)");
    A(/skillCooldowns\?\.\[chosen\.key\] \?\? 0\) > 0\) \{ ok = false/.test(seg),
      "kiểm LẠI cooldown TRONG lock (chống hai lượt cùng dùng)");
    A(/applyBorrowedEyesCharges\(mob2/.test(seg), "cấp buff trên object VỪA FETCH trong lock, không phải `mob` ngoài lock");

    // Phải gọi TRƯỚC phần tấn công và KHÔNG return — nếu return thì nó chiếm lượt.
    const attempt = ai.slice(ai.indexOf("async function attemptOneMobAction"));
    const iCall = attempt.indexOf("await runUtilityPages(channelId, mobKey);");
    A(iCall > 0, "attemptOneMobAction có gọi runUtilityPages");
    A(!/return await runUtilityPages|return runUtilityPages/.test(attempt),
      "KHÔNG return kết quả ⇒ mob vẫn đánh bình thường trong cùng lượt");
    A(iCall < attempt.indexOf("pickAiTargets(encounter, mob)"),
      "gọi TRƯỚC pickAiTargets ⇒ 'không có target khả dụng' không chặn mất page tự buff");
    A(iCall < attempt.indexOf("pickOffensiveSkill(mob)"), "và trước cả khâu chọn skill tấn công");
  }
  // Không được để utility lọt vào danh sách tấn công (sẽ chiếm lượt).
  {
    const off = ai.slice(ai.indexOf("function pickOffensiveSkill"), ai.indexOf("function pickM1DmgStr"));
    A(!/pickUtilitySkill\(/.test(off), "pickOffensiveSkill KHÔNG trả page utility (trả là chiếm mất lượt đánh)");
    A(/if \(skill\.noDirectDamage\) continue;/.test(off), "và loại page noDirectDamage khỏi danh sách tấn công");
  }

  console.log("\n── CHỈ CHẠY TRONG LƯỢT CỦA MOB, KHÔNG cấp sẵn lúc mở encounter ──");
  // Fragaria làm rõ 14/08: *"mở encounter dùng ngay — ý tôi là tới TURN của Eye
  // Gouger thì AI tự dùng, chứ KHÔNG phải encounter start là có sẵn buff."*
  {
    const cf = fs.readFileSync("combatant-factory.js", "utf8");
    A(!/borrowedEyeCharges\s*:\s*[1-9]/.test(cf),
      "combatant-factory KHÔNG cấp sẵn borrowedEyeCharges lúc tạo mob");
    A(/evadeCharges:\s*0/.test(cf), "mob sinh ra với 0 charge né — buff phải do AI tự dùng page mà có");
    // Đường gọi duy nhất: maybeRunAiTurn → attemptOneMobAction → runUtilityPages.
    // Đếm nơi GỌI, không tính dòng khai báo `async function attemptOneMobAction(`.
    const callSites = (ai.match(/(?<!function )attemptOneMobAction\(channelId/g) ?? []).length;
    A(callSites === 1, `attemptOneMobAction chỉ có MỘT nơi gọi (${callSites}) — là maybeRunAiTurn`);
    const mrt = ai.slice(ai.indexOf("async function maybeRunAiTurn"));
    A(/cur\.type !== "enemy"\) return;/.test(mrt) && /encounter\.turnOrder\[encounter\.currentTurnIndex/.test(mrt),
      "maybeRunAiTurn chặn theo turnOrder ⇒ chỉ chạy đúng lượt của mob đó");
    A(/if \(mob\.staggered\) \{ await passMobTurn/.test(mrt),
      "đang Stagger thì pass lượt, không dùng page");
    A(!/runUtilityPages/.test(fs.readFileSync("combatant-factory.js", "utf8")),
      "không nơi nào chạy page này lúc dựng encounter");
  }
  // maybeRunAiTurn được gọi NHIỀU LẦN trong một lượt (sau mỗi pendingAction resolve).
  // CD phải chặn lần thứ hai, nếu không mob nạp charge liên tục trong cùng turn.
  {
    const a0 = ai.indexOf("function pickUtilitySkill(mob) {");
    const a1 = ai.indexOf("\n  }", ai.indexOf("return null;", a0)) + 4;
    const pick = new Function("findSkill", "parseSkillCost", `${ai.slice(a0, a1)}\nreturn pickUtilitySkill;`)(
      skills.findSkill,
      (c) => { const m = /(\d+)/.exec(String(c)); return { light: m ? parseInt(m[1], 10) : null }; },
    );
    const mob = { unlockedPagesSnapshot: EG.skills, currentLight: 6, skillCooldowns: {} };
    A(pick(mob)?.key === "borrowed eyes", "lần gọi 1 trong lượt → dùng");
    mob.skillCooldowns["borrowed eyes"] = 6;   // runUtilityPages set CD ngay trong lock
    A(pick(mob) === null, "lần gọi 2 cùng lượt → CD đã set ⇒ KHÔNG nạp lại (không spam trong 1 turn)");
  }

  console.log("\n── KHÂU 3: cấp charge dùng CHUNG một hàm với đường người chơi ──");
  const rpa = fs.readFileSync("resolve-pending-action.js", "utf8");
  A(/applyBorrowedEyesCharges\(attacker\.combatant/.test(rpa), "resolve-pending-action gọi helper chung");
  A(!/borrowedEyeCharges = diceVal/.test(rpa), "logic cũ đã gỡ khỏi rpa (không còn 2 bản song song)");
  {
    const roll = skills.findSkill("borrowed eyes").roll(0).join("\n");
    const m = roll.match(/\*\*(\d+)\*\*/);
    A(!!m, `roll ra dice: ${m?.[1]}`);
    const mob = { evadeCharges: 0, borrowedEyeCharges: 0 };
    const r = cu.applyBorrowedEyesCharges(mob, roll, null);
    A(r.charges === parseInt(m[1], 10), `cấp ĐÚNG ${r.charges} charge = số dice hiện trên embed (không roll lại)`);
    A(mob.borrowedEyeCharges === r.charges && mob.evadeCharges === r.charges,
      `set cả borrowedEyeCharges (${mob.borrowedEyeCharges}) lẫn evadeCharges (${mob.evadeCharges})`);
    A(/Borrowed Eye/.test(r.note), "có dòng thông báo cho người chơi");
    // Không có dice → không cấp bừa.
    const mob2 = { evadeCharges: 0 };
    A(cu.applyBorrowedEyesCharges(mob2, "Critical: Borrowed Eyes", null).charges === 0,
      "chuỗi không có chữ số → 0 charge, không cấp bừa");
  }

  console.log("\n── HỒI QUY: AI vẫn KHÔNG đem Borrowed Eyes đi Clash ──");
  A(/\/\^borrowed eyes\$\/i\.test\(skillName\.trim\(\)\)/.test(ai) || /skill\.unclashable/.test(ai),
    "pickClashSkill vẫn loại page utility/unclashable");
  A(/if \(skill\.noDirectDamage\) continue;/.test(ai.slice(ai.indexOf("function pickOffensiveSkill"))),
    "pickOffensiveSkill loại page noDirectDamage khỏi danh sách TẤN CÔNG (đã xét riêng ở trên)");

  console.log(fails === 0 ? "\n=== TẤT CẢ PASS ===" : `\n=== ${fails} CHECK HỎNG ===`);
  process.exit(fails === 0 ? 0 : 1);
})();
