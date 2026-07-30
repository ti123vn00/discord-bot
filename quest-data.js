// quest-data.js
// Data tĩnh cho Quest System (-contract) — TÁCH riêng khỏi combat logic, giống quy
// ước weapon.js/outfit.js/accessory.js (sửa trực tiếp file này để thêm/sửa
// contract hoặc mob mới, không cần đụng code logic).
//
// CONTRACTS — key dùng cho dropdown/customId, "mobKey" trỏ tới QUEST_MOBS bên
// dưới, "killCount" = số mob cần hạ (mob CÙNG LOẠI, spawn đủ số lượng lúc start
// — xem party-board.js).
const CONTRACTS = {
  evict: {
    name: "Evict", description: "Diệt 3 Rats",
    mobKey: "rats", killCount: 3, expReward: 3, ahnReward: 50000,
  },
  debtcollector: {
    name: "Debt Collector", description: "Diệt 5 Rats",
    mobKey: "rats", killCount: 5, expReward: 5, ahnReward: 100000,
  },
  backonline: {
    name: "Back Online", description: "Diệt 3 người nhóm lưỡi câu",
    mobKey: "hookgang", killCount: 3, expReward: 10, ahnReward: 250000,
  },
  rescue: {
    name: "Rescue", description: "Diệt 10 Rats",
    mobKey: "rats", killCount: 10, expReward: 10, ahnReward: 250000,
  },
  contrabandtech: {
    name: "Contraband Tech", description: "Diệt 1 thành viên của Amon Syndicate",
    mobKey: "amonsyndicate", killCount: 1, expReward: 15, ahnReward: 400000,
  },
  eyegouger: {
    name: "Eye Gouger", description: "Diệt 1 Eye Gouger",
    mobKey: "eyegouger", killCount: 1, expReward: 20, ahnReward: 500000,
  },
};

// QUEST_MOBS — stat block dùng để tạo combatant qua createCombatant + field bổ
// sung riêng cho AI (m1DmgStr — vì enemy thường KHÔNG có field lưu sẵn công thức
// M1, GM luôn gõ tay mỗi lần qua -encounter enemyattack; AI-controlled thì cần có
// sẵn để tự dùng). "skills" — tên PHẢI khớp CHÍNH XÁC skills.js (dùng findSkill()
// y hệt -encounter addenemy's skills: list) — ĐÃ VERIFY đủ 9/10 skill nêu ra đã có
// sẵn trong database, CHỈ THIẾU "Borrowed Eyes" (Fragaria báo sẽ gửi sau — Eye
// Gouger tạm chưa có skill này trong list, thêm sau khi có dice/light cost thật).
const QUEST_MOBS = {
  rats: {
    name: "Rats",
    maxHp: 60, maxStamina: 60, maxLight: 0, maxSanity: 0,
    weaponWeight: "light",
    resistance: { B: 1.5, P: 1.5, S: 1.5 },
    m1DmgStr: "4P",
    skills: [],
  },
  hookgang: {
    name: "Thành viên nhóm lưỡi câu",
    maxHp: 140, maxStamina: 100, maxLight: 4, maxSanity: 0,
    weaponWeight: "light",
    resistance: { B: 1, P: 1.2, S: 1 },
    m1DmgStr: "5S",
    skills: ["Right Hook"],
  },
  amonsyndicate: {
    name: "Amon Syndicate Member",
    maxHp: 560, maxStamina: 400, maxLight: 5, maxSanity: 0,
    // Không ghi rõ weight trong data gốc — mặc định "medium" (GIẢ ĐỊNH, đã báo Fragaria).
    weaponWeight: "medium",
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
    maxHp: 600, maxStamina: 450, maxLight: 6, maxSanity: 0,
    weaponWeight: "medium", // không ghi rõ weight — mặc định (GIẢ ĐỊNH, đã báo Fragaria)
    resistance: { B: 0.8, P: 1.3, S: 1 },
    m1DmgStr: "6P",
    // "+3 Dice Up vĩnh viễn" — set diceUp: 3 lúc tạo, KHÔNG tiêu hao như diceUp
    // thường (cần verify cơ chế tiêu hao thật lúc code enemy-ai.js/resolve logic
    // để đảm bảo "vĩnh viễn" đúng nghĩa, không bị consume sau 1 roll).
    permanentDiceUp: 3,
    // "Borrowed Eyes" CHƯA có trong list — Fragaria sẽ gửi dice/light cost sau.
    skills: ["Pistol Draw", "Thrust", "You're Too Slow", "Slash Series", "Sky Clearing Cut"],
  },
};

module.exports = { CONTRACTS, QUEST_MOBS };
