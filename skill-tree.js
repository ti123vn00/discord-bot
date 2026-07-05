// skill-tree.js
// Hệ thống Skill Tree/Perk (data + helper thuần) — tách khỏi index.js theo yêu
// cầu trực tiếp: "tiếp tục tách hàm ra thành file riêng". Dùng pattern
// dependency-injection GIỐNG player-actions.js (factory function nhận dependency
// làm tham số, tránh circular require với index.js — calcGrade/GRADE_MIN được
// ĐỊNH NGHĨA trong index.js nhưng file NÀY cũng cần dùng, nên INJECT thay vì
// require ngược lại).
//
// CHỈ tách phần DATA + HELPER ĐƠN GIẢN (không phụ thuộc Redis/Discord/combatant
// phức tạp) — computeAttackerPerkContext/computeDefenderDmgReduction (dùng RẤT
// NHIỀU field combatant khác như Eye Of Horus/Set Fire) VẪN GIỮ NGUYÊN trong
// index.js, KHÔNG tách đợt này (rủi ro cao hơn lợi ích do đan xen sâu với
// "ENCOUNTER SYSTEM" core).
//
// LƯU Ý: BOOK_GRANTS (nằm NGAY GIỮA 2 đoạn code này trong index.js gốc) CỐ Ý
// KHÔNG tách theo — các hàm xử lý sách (getBookTopLevelChoices...) nằm CÁCH XA
// hàng nghìn dòng trong "PREFIX COMMANDS", gộp chung sẽ tăng rủi ro nhầm lẫn hơn
// lợi ích, để lại cho 1 đợt tách RIÊNG sau này.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ calcGrade, GRADE_MIN }) {

  const MUTUALLY_EXCLUSIVE_PERKS = [
    ["Overbearing", "Steady Breathing"],
    ["Follow-Up", "Pounce"],
  ];
  function findExclusiveConflict(existingPerks, newPerk) {
    for (const [a, b] of MUTUALLY_EXCLUSIVE_PERKS) {
      if (newPerk === a && existingPerks.includes(b)) return b;
      if (newPerk === b && existingPerks.includes(a)) return a;
    }
    return null;
  }
  
  // ── Skill Tree — Budget điểm ────────────────────────────────────────────────
  // Luật (xác nhận trực tiếp từ GM): "Grade 9 mặc định 5 điểm. Tới Grade 1 sẽ có 45
  // điểm. Để có 5 điểm cuối (đạt 50) cần làm QUEST ĐẶC BIỆT" — leveling thường
  // (grade 9→1) cho 5 + 5×8 = 45 điểm, 5 điểm CUỐI cần quest đặc biệt KHÔNG được
  // luật mô tả chi tiết nội dung quest → lưu riêng field bonusSkillPoints (admin tự
  // cấp tay qua `-setplayer @user bonusskillpoints: +5` khi GM xác nhận player đã
  // hoàn thành quest đó, hệ thống không tự biết quest là gì để tự động trao).
  //
  // PERK_POINT_COSTS: CHỈ chứa perk đã được xác nhận TRỰC TIẾP số point cụ thể
  // (Pride/Wrath/Sloth/Desire/Shin qua các đoạn chat trước) — perk KHÁC không có
  // trong bảng này được xem là "chưa rõ cost", KHÔNG bị chặn bởi budget (tránh chặn
  // nhầm các perk cũ đã unlock từ trước khi chưa có hệ thống budget này).
  const PERK_POINT_COSTS = {
    // Pride
    "Claim Their Heart": 10, "Pressure Point": 15, "Shrouded Power": 20, "Sharp Eyes": 30,
    "Adrenaline Rush": 35, "Smoke Overload": 45, "Overbearing": 50, "Steady Breathing": 50,
    // Wrath
    "Battle Ignition": 5, "Close Call Wind": 10, "Follow-Up": 15, "Smoldering Resolve": 20,
    "Tip-Toe Around": 25, "Inner Ardor": 30, "Backdraft": 35,
    // Desire
    "Here We Go Again": 10, "Craving Synergy": 15, "Thirst": 20, "Voracity": 30,
    "Break the Dams": 40, "A Beautiful Mess": 50,
    // Sloth
    "Pounce": 5, "Fleeting Steps": 10, "Mastered Breaths": 15, "Fortified Resolve": 20,
    "Shockwave": 25, "Break and Punish": 30, "Wasted Hours, Lying Down": 40,
    // Gluttony
    "Defenseless": 10, "Biting Embrace": 15, "Thorns": 30, "Tear To Shreds": 35,
    "Death Comes For All": 50,
    // Gloom
    "Tap Of The Light": 10, "Borderline Breakdown": 15, "Comeback Time": 20, "Wail": 25,
    "No Will To Break": 30, "Negative Thoughts": 30, "No Mind To Cure": 40, "Cry On Deaf Ears": 50,
    // Envy
    "Charge Up": 5, "Convert Physical Trauma": 10, "Blessed by the Sparks": 15,
    "Electrifying Vendetta": 30, "Short Circuit Trip": 35, "Kinetic Energy": 40,
    "Overflowing Guard": 45, "Overcharged Vessel": 50,
    // Shin
    "Shin Follow Up": 5, "Defensive Light": 10, "Decimate Mind": 20, "Regain Mind": 30,
    "Overwhelming Power": 50,
    // Light (chỉ thủ thư thư viện) — LƯU Ý: "Light Dash" ở đây là PERK (mỗi turn
    // start +2 Light), KHÁC HOÀN TOÀN "Light Dash" PAGE đã có trong skills.js (dash+
    // né 1 đòn) — trùng TÊN nhưng 2 thứ khác nhau, không liên quan tới nhau.
    "Ein Sof": 5, "Light Body": 10, "Light Dash": 20, "Emotion Surge": 30, "Ohr Ein Sof": 50,
  };
  
  // PERK_BRANCH — map TÊN PERK → key nhánh (9 nhánh chuẩn hoá, khớp PERK_POINT_COSTS
  // phía trên) — dùng để biết 1 perk thuộc nhánh nào khi check ngưỡng mở khoá.
  // BOOK_GRANTS — map TÊN SÁCH CHÍNH THỨC (khớp VALID_BOOKS ở trên) → nội dung sách
  // dạy được (Page/Weapon/Outfit) — dùng cho lệnh -readbook. Xác nhận trực tiếp từ
  // GM: đọc sách KHÔNG chặn equip (equip vẫn tự do như trước), sách chỉ mang tính
  // GHI NHẬN/THAM KHẢO — tiêu 1 cuốn mỗi lần đọc.
  // LƯU Ý: "Reverbation Ensemble Book" GIỮ NGUYÊN chính tả (thiếu chữ "r" so với
  // "Reverberation") vì đây LÀ tên item CHÍNH THỨC đã tồn tại sẵn trong VALID_BOOKS
  // — không tự ý sửa để tránh làm gãy mapping với item thật trong inventory.
  // UNIVERSALLY_KNOWN_WEAPONS — vũ khí AI CŨNG BIẾT DÙNG, bỏ qua ownership gate khi
  // equip (xác nhận trực tiếp từ GM: "Brawler là vũ khí tay không nên bất kỳ ai cũng
  // chọn được"). Danh sách CỐ Ý NGẮN — chỉ thêm khi có xác nhận rõ ràng tương tự.
  const UNIVERSALLY_KNOWN_WEAPONS = new Set(["brawler"]);
  // MIDDLE_SYNDICATE_SKILLS — dùng cho Vengeance Mark (50-Status Nhóm 2, xác nhận
  // trực tiếp: "tăng 5% dmg từ skill của the middle với mỗi 1 stack") — gộp page
  // từ CẢ 2 sách liên quan tới "The Middle" (Middle Syndicate Book + The Middle
  // Big Brother Book — xem book-system.js's BOOK_GRANTS để đối chiếu nếu sách đổi).
  const MIDDLE_SYNDICATE_SKILLS = new Set([
    "proof of loyalty", "just a vengeance", "punching", "kicking",
    "my hair coupon", "complete and total extermination!", "vengeance retaliation", "stamp of vengeance", "punting",
  ]);
  const PERK_BRANCH = {
    // Pride
    "Claim Their Heart": "pride", "Pressure Point": "pride", "Shrouded Power": "pride", "Sharp Eyes": "pride",
    "Adrenaline Rush": "pride", "Smoke Overload": "pride", "Overbearing": "pride", "Steady Breathing": "pride",
    // Wrath
    "Battle Ignition": "wrath", "Close Call Wind": "wrath", "Follow-Up": "wrath", "Smoldering Resolve": "wrath",
    "Tip-Toe Around": "wrath", "Inner Ardor": "wrath", "Backdraft": "wrath",
    // Desire
    "Here We Go Again": "desire", "Craving Synergy": "desire", "Thirst": "desire", "Voracity": "desire",
    "Break the Dams": "desire", "A Beautiful Mess": "desire",
    // Sloth
    "Pounce": "sloth", "Fleeting Steps": "sloth", "Mastered Breaths": "sloth", "Fortified Resolve": "sloth",
    "Shockwave": "sloth", "Break and Punish": "sloth", "Wasted Hours, Lying Down": "sloth",
    // Gluttony
    "Defenseless": "gluttony", "Biting Embrace": "gluttony", "Thorns": "gluttony", "Tear To Shreds": "gluttony",
    "Death Comes For All": "gluttony",
    // Gloom
    "Tap Of The Light": "gloom", "Borderline Breakdown": "gloom", "Comeback Time": "gloom", "Wail": "gloom",
    "No Will To Break": "gloom", "Negative Thoughts": "gloom", "No Mind To Cure": "gloom", "Cry On Deaf Ears": "gloom",
    // Envy
    "Charge Up": "envy", "Convert Physical Trauma": "envy", "Blessed by the Sparks": "envy",
    "Electrifying Vendetta": "envy", "Short Circuit Trip": "envy", "Kinetic Energy": "envy",
    "Overflowing Guard": "envy", "Overcharged Vessel": "envy",
    // Shin
    "Shin Follow Up": "shin", "Defensive Light": "shin", "Decimate Mind": "shin", "Regain Mind": "shin",
    "Overwhelming Power": "shin",
    // Light
    "Ein Sof": "light", "Light Body": "light", "Light Dash": "light", "Emotion Surge": "light", "Ohr Ein Sof": "light",
  };
  const BRANCH_KEYS = ["wrath", "desire", "sloth", "gluttony", "gloom", "pride", "envy", "shin", "light"];
  
  /** calcSkillTreePointsEarned — tổng điểm ĐÃ KIẾM ĐƯỢC (5 khởi điểm grade 9 + 5/grade
   *  đã lên + 5 điểm CUỐI CÙNG nếu đã hoàn thành "điều kiện đặc biệt"). Cap tuyệt
   *  đối ở 50 dù cộng dư bao nhiêu — đây là TỔNG POOL để PHÂN BỔ vào 9 nhánh
   *  (branchPoints), KHÔNG PHẢI để "mua" từng perk trực tiếp.
   *  ĐÃ ĐƠN GIẢN HOÁ (xác nhận trực tiếp từ GM: "50statunlock đã true rồi nhưng
   *  profile vẫn 45, đáng lẽ là 50") — TRƯỚC ĐÂY thiết kế "2 bước tách biệt"
   *  (50StatUnlock chỉ là cờ VERIFY, bonusSkillPoints là SỐ THẬT cần set THÊM
   *  RIÊNG) — nhưng GM chỉ set cờ, KHÔNG set thêm bonusSkillPoints, dẫn tới pool
   *  vẫn giữ 45 dù cờ đã true — GÂY NHẦM LẪN THẬT (không khớp kỳ vọng tự nhiên
   *  "bật cờ là đủ"). Giờ 50StatUnlock=true → +5 CỐ ĐỊNH luôn, KHÔNG cần bước
   *  phụ nào nữa — khớp đúng ý nghĩa gốc "5 điểm CUỐI luôn là đúng 5, không phải
   *  số tuỳ chỉnh". bonusSkillPoints/lệnh -setplayer bonusskillpoints: VẪN GIỮ
   *  NGUYÊN cú pháp (không xoá, tránh lỗi nếu ai gõ) nhưng KHÔNG CÒN ẢNH HƯỞNG
   *  gì tới công thức này nữa. */
  function calcSkillTreePointsEarned(profileData) {
    const { grade } = calcGrade(profileData.exp ?? 0);
    const fromGrade = 5 + 5 * (GRADE_MIN - grade);
    const bonus = profileData["50StatUnlock"] ? 5 : 0;
    return Math.min(50, fromGrade + bonus);
  }
  
  /**
   * calcBranchPointsAllocated — TỔNG điểm đã PHÂN BỔ vào 9 nhánh (branchPoints) —
   * dùng để validate KHÔNG VƯỢT tổng pool (calcSkillTreePointsEarned) khi GM phân bổ
   * thêm. KIẾN TRÚC ĐÃ SỬA HOÀN TOÀN (xác nhận trực tiếp từ GM, kèm ví dụ cụ thể:
   * Hoshino Takanashi Grade 4 (pool=30 theo Grade), Sloth: 20, mọi nhánh khác: 0 —
   * TỨC LÀ điểm KHÔNG "chi tiêu cộng dồn qua từng perk lẻ" như tôi hiểu sai lúc
   * đầu, mà PHÂN BỔ theo TỪNG NHÁNH riêng biệt — trong 1 nhánh, có N điểm = mở
   * ĐƯỢC TẤT CẢ perk nhánh đó có tag ≤N cùng lúc, không giới hạn số lượng, không
   * trừ dần theo từng perk).
   */
  function calcBranchPointsAllocated(profileData) {
    const bp = profileData.branchPoints ?? {};
    return BRANCH_KEYS.reduce((sum, k) => sum + (bp[k] ?? 0), 0);
  }
  
  function hasPerk(combatant, perkName) {
    return (combatant.unlockedPerks ?? []).includes(perkName);
  }
  
  // ── SKILL TREE PERK ENGINE ───────────────────────────────────────────────────
  // Chỉ tự động hoá perk dựa trên hệ thống ĐÃ CÓ (HP%/Sanity/Stamina/Poise/Charge/
  // Rupture/Bleed/Tremor/Stagger/crit/Emotion Level/M1). Perk phụ thuộc Guard/Evade/
  // Parry/Clash/E.G.O/Shin (hệ thống CHƯA CÓ trong V2) CHỈ nằm trong unlockedPerks
  // dạng ghi chú — GM tự áp dụng tay, KHÔNG có logic nào ở đây cho chúng (theo đúng
  // quyết định: không thêm lại Guard/Evade/Parry chỉ để 1 nhánh skill tree có cái
  // để hóa vào).
  
  /** applyStatusMultiplierToDmgStr — viết lại TẤT CẢ "+N<tag>" trong dmgStr thành
   *  "+ceil(N*multiplier)<tag>" — dùng cho perk dạng "Tăng X lần khả năng áp <status>"
   *  (Tear To Shreds, A Beautiful Mess, Inner Ardor...). Multiplier=1 thì trả nguyên
   *  dmgStr (không tốn chi phí regex nếu không cần). Chỉ sửa GAIN (+N), không đụng
   *  CONSUME (-N) — vì luật chỉ nói "khả năng ÁP", không nói gì về tiêu thụ. */
  function applyStatusMultiplierToDmgStr(dmgStr, tagName, multiplier) {
    if (multiplier === 1 || !dmgStr) return dmgStr;
    return dmgStr.replace(new RegExp(`\\+(\\d*)${tagName}`, "gi"), (match, numStr) => {
      const num = numStr ? parseInt(numStr, 10) : 1;
      return `+${Math.ceil(num * multiplier)}${tagName}`;
    });
  }

  return {
    hasPerk,
    findExclusiveConflict,
    calcSkillTreePointsEarned,
    calcBranchPointsAllocated,
    applyStatusMultiplierToDmgStr,
    PERK_POINT_COSTS,
    PERK_BRANCH,
    BRANCH_KEYS,
    UNIVERSALLY_KNOWN_WEAPONS,
    MIDDLE_SYNDICATE_SKILLS,
    MUTUALLY_EXCLUSIVE_PERKS,
  };
};
