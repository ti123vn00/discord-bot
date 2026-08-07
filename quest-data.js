// quest-data.js
// Data tĩnh cho Quest System (-contract) — TÁCH riêng khỏi combat logic, giống quy
// ước weapon.js/outfit.js/accessory.js (sửa trực tiếp file này để thêm/sửa
// contract hoặc mob mới, không cần đụng code logic).
//
// CONTRACTS — key dùng cho dropdown/customId, "mobKey" trỏ tới QUEST_MOBS bên
// dưới, "killCount" = số mob cần hạ (mob CÙNG LOẠI, spawn đủ số lượng lúc start
// — xem party-board.js).
// bookDropMin/Max — số Random Book rơi ra khi HOÀN THÀNH contract (Fragaria xác
// nhận trực tiếp). RARE_DROP_* — 1% cơ hội rơi thêm "Borrowed Eyes" (Singularity)
// ở MỌI contract, độc lập với book thường.
const RARE_DROP_BOOK = "Borrowed Eyes";
const RARE_DROP_CHANCE = 0.01;

const CONTRACTS = {
  evict: {
    name: "Evict", description: "Diệt 3 Rats",
    mobKey: "rats", killCount: 3, expReward: 3, ahnReward: 50000,
    bookDropMin: 0, bookDropMax: 1,
  },
  debtcollector: {
    name: "Debt Collector", description: "Diệt 5 Rats",
    mobKey: "rats", killCount: 5, expReward: 5, ahnReward: 100000,
    bookDropMin: 1, bookDropMax: 1,
  },
  backonline: {
    name: "Back Online", description: "Diệt 3 người nhóm lưỡi câu",
    mobKey: "hookgang", killCount: 3, expReward: 10, ahnReward: 250000,
    bookDropMin: 1, bookDropMax: 2,
  },
  rescue: {
    name: "Rescue", description: "Diệt 10 Rats",
    mobKey: "rats", killCount: 10, expReward: 10, ahnReward: 250000,
  },
  contrabandtech: {
    name: "Contraband Tech", description: "Diệt 1 thành viên của Amon Syndicate",
    mobKey: "amonsyndicate", killCount: 1, expReward: 15, ahnReward: 400000,
    bookDropMin: 2, bookDropMax: 2,
  },
  eyegouger: {
    name: "Eye Gouger", description: "Diệt 1 Eye Gouger",
    mobKey: "eyegouger", killCount: 1, expReward: 20, ahnReward: 500000,
    bookDropMin: 2, bookDropMax: 3,
  },
  // ── WEEKLY BOSS ─────────────────────────────────────────────────────────
  // Fragaria: "weekly boss này sẽ hiện trong contract với key là nothingthere.
  // Tên contract: There Is Nothing There. Phần thưởng: 50 Exp, 5000000 Ahn,
  // 5 Sealed Book Cache, 10 Random Book, 750 Lunacy. Một tuần chỉ nhận thưởng
  // được một lần."
  nothingthere: {
    name: "There Is Nothing There", description: "Diệt Nothing There (Weekly Boss)",
    mobKey: "nothingthere", killCount: 1,
    expReward: 50, ahnReward: 5_000_000,
    // Thưởng CỐ ĐỊNH 10 Random Book (không random khoảng như contract thường).
    bookDropMin: 10, bookDropMax: 10,
    // Thưởng riêng của weekly boss — grantContractReward đọc 2 field này.
    lunacyReward: 750,
    // "Sealed Book Cache" nằm trong `data.books` (đường mở cache đọc
    // `data.books["Sealed Book Cache"]`), KHÔNG phải `data.items` — dùng
    // bookRewards để cộng đúng kho, nếu không người chơi có 5 cái mà `-openbook`
    // báo không có.
    bookRewards: { "Sealed Book Cache": 5 },
    // `weeklyReward` — chỉ nhận thưởng 1 lần/tuần, VÀ không tính vào hạn mức
    // 4 contract/ngày (đây là nội dung tuần, không phải cày ngày).
    weeklyReward: true,
    // Fragaria: "sửa weekly boss Nothing There thành encounter cho phép tối đa
    // 5 người thay vì 3 như bình thường do độ khó của nó".
    // Contract KHÔNG khai field này giữ nguyên trần mặc định (MAX_PARTY_SIZE = 3).
    maxPartySize: 5,
  },
};

// QUEST_MOBS — stat block dùng để tạo combatant qua createCombatant + field bổ
// sung riêng cho AI (m1DmgStr — vì enemy thường KHÔNG có field lưu sẵn công thức
// M1, GM luôn gõ tay mỗi lần qua -encounter enemyattack; AI-controlled thì cần có
// sẵn để tự dùng). "skills" — tên PHẢI khớp CHÍNH XÁC skills.js (dùng findSkill()
// y hệt -encounter addenemy's skills: list) — ĐÃ VERIFY đủ 9/10 skill nêu ra đã có
// sẵn trong database, CHỈ THIẾU "Borrowed Eyes" (Fragaria báo sẽ gửi sau — Eye
// Gouger tạm chưa có skill này trong list, thêm sau khi có dice/light cost thật).
// ⚠️ maxSanity: Fragaria xác nhận trực tiếp — "Rats, Hook Gang, Amon Syndicate ĐỀU
// CÓ Sanity, chúng start với 0 Sanity và tùy tình huống có thể xuống -45 hoặc lên 45".
// Nên `maxSanity: 45` (mọi combatant đều bắt đầu ở currentSanity 0, xem
// combatant-factory.js). TRƯỚC ĐÂY để 0 — chỉ có nghĩa "khởi điểm 0" trong ý đồ ban
// đầu, nhưng code đọc thành "KHÔNG CÓ thanh Sanity" nên mob không hiện Sanity và bị
// kẹp về 0 ở vài chỗ Math.min(maxSanity, …).
// "Không có Sanity" GIỜ khai bằng cờ RIÊNG `noSanity: true` (chỉ Nothing There) —
// KHÔNG suy từ maxSanity nữa, để 2 khái niệm này không lẫn vào nhau lần nữa.
const QUEST_MOBS = {
  rats: {
    name: "Rats",
    maxHp: 60, maxStamina: 60, maxLight: 0, maxSanity: 45,
    weaponWeight: "light",
    resistance: { B: 1.5, P: 1.5, S: 1.5 },
    m1DmgStr: "4P",
    skills: [],
  },
  hookgang: {
    name: "Thành viên nhóm lưỡi câu",
    maxHp: 140, maxStamina: 100, maxLight: 4, maxSanity: 45,
    weaponWeight: "light",
    resistance: { B: 1, P: 1.2, S: 1 },
    m1DmgStr: "5S",
    skills: ["Right Hook"],
  },
  amonsyndicate: {
    name: "Amon Syndicate Member",
    maxHp: 560, maxStamina: 400, maxLight: 5, maxSanity: 45,
    // Xác nhận trực tiếp: "Amon xài light weapon".
    weaponWeight: "light",
    resistance: { B: 0.8, P: 1.3, S: 0.8 },
    // "Có thể đổi Dmg M1 qua Dmg Pierce tùy thích" — 2 công thức, AI tự chọn cái
    // gây dmg cao hơn dựa theo Res thật của target đang nhắm (xem enemy-ai.js).
    m1DmgStr: "6B", m1DmgStrAlt: "6P",
    // "Miễn nhiễm với mọi dmg có sử dụng đạn" — hiểu là hệ thống Ammo hiện có
    // (frostAmmo/incendiaryAmmo/repeat, VÀ Firing/bulletStack Soldato Rifle) —
    // check effectiveAmmoType/effectiveBulletType lúc resolve, zero dmg nếu có.
    ammoImmune: true,
    skills: ["Celestial Sight", "Alleyway Counter", "Stylish Sweeps", "Pistol Draw"],
  },
  eyegouger: {
    name: "Eye Gouger",
    maxHp: 600, maxStamina: 450, maxLight: 6, maxSanity: 45,
    weaponWeight: "light", // xác nhận trực tiếp: "Eyegouger... xài light weapon"
    resistance: { B: 0.8, P: 1.3, S: 1 },
    m1DmgStr: "6P",
    // "+3 Dice Up vĩnh viễn" — set diceUp: 3 lúc tạo, KHÔNG tiêu hao như diceUp
    // thường (cần verify cơ chế tiêu hao thật lúc code enemy-ai.js/resolve logic
    // để đảm bảo "vĩnh viễn" đúng nghĩa, không bị consume sau 1 roll).
    permanentDiceUp: 3,
    skills: ["Pistol Draw", "Thrust", "You're Too Slow", "Slash Series", "Sky Clearing Cut", "Borrowed Eyes"],
  },
  // ── WEEKLY BOSS (data Fragaria đưa nguyên văn) ──────────────────────────
  nothingthere: {
    name: "Nothing There",
    isWeeklyBoss: true,
    maxHp: 3000, maxStamina: 500, maxLight: 0,
    // "Không có Sanity" (Fragaria) — CỜ TƯỜNG MINH, không suy từ maxSanity.
    // Hệ quả: Sinking ăn dmg NGAY từ hit đầu (coi như luôn ở đáy Sanity),
    // The Departed dùng cap 15, và MỌI nguồn Sanity trượt hết ⇒ không bao giờ
    // Panic. Xem damage-calc.js + sanity-emotion.js.
    maxSanity: 0, noSanity: true,
    resistance: { B: 1, P: 1, S: 1 },
    // "M1 (Không có)" — boss KHÔNG đánh thường, chỉ dùng page theo pattern.
    m1DmgStr: null, noM1: true,
    weaponWeight: "heavy",
    // Fragaria: "speed range của Nothing There là 1~3".
    speedRangeMin: 1, speedRangeMax: 3,
    // "Stamina KHÔNG hồi mỗi turn mà chỉ 1 điểm cố định; khi bị Stagger và hết
    // Stagger thì hồi lại FULL Stamina."
    // → Trần hồi mỗi turn là 1 (thay vì ENCOUNTER_STAMINA_REGEN_PER_TURN chung).
    // Nhánh hồi-đầy-sau-Stagger đã có sẵn cho MỌI combatant, không phải sửa.
    staminaRegenPerTurn: 1,
    // "Miễn nhiễm đạn"
    ammoImmune: true,
    // "Không thể né, guard hay parry" — mọi page của boss đều đã mang tag
    // [Unblockable]/[Undodgeable] ở skills.js; cờ này là chốt chặn CẤP BOSS để
    // page mới thêm sau cũng tự chặn, không phải nhớ gắn tag từng cái.
    defenseImmune: true,
    // "Đòn của bản thân không bị giảm stamina"
    noStaminaCost: true,
    // Boss 3 đòn/turn + có đòn 200 True AOE → khoá mục tiêu là wipe chắc chắn.
    // Cờ này tắt hẳn aggro lock: MỖI đòn rút lại mục tiêu từ đầu.
    aiSpreadTargets: true,
    skills: ["Swing", "Triple Swing", "Jump Attack", "Running Attack", "HELP", "Goodbye"],
    // Pattern CỐ ĐỊNH theo turn, lặp lại từ đầu sau turn 3 (Fragaria: "Turn 4:
    // lặp lại từ đầu"). Mỗi turn tung 3 đòn theo ĐÚNG thứ tự này.
    attackPattern: [
      ["Jump Attack", "Triple Swing", "Swing"],
      ["Running Attack", "Jump Attack", "Triple Swing"],
      ["HELP", "Triple Swing", "Goodbye"],
    ],
  },
};

module.exports = { CONTRACTS, RARE_DROP_BOOK, RARE_DROP_CHANCE, QUEST_MOBS };
