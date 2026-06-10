/**
 * weapons.js
 * Database vũ khí với base damage, passive, critical skill
 * Format: { name, type, baseDamg, category, passive, critical }
 */

const WEAPONS = {
  "moonlit-azure-blade": {
    id: "moonlit-azure-blade",
    name: "Moonlit Azure Blade",
    type: "Slash",
    baseShort: "5",
    baseLong: "5-10", // Nếu là range, roll từ min-max
    category: "Light",
    description: "Lam chiếc kiếm ánh trăng",
    passive: {
      name: "The Orthodox Blade [整劍]",
      desc: "Nếu trong turn này không tấn công thì turn sau sẽ được nhận 10 Poise [Max 2 lần, reset sau khi tấn công]",
    },
    critical: {
      name: "Fallstar Slayer [落星一殺]",
      cd: 3,
      desc: "Lướt lên rút kiếm ra chém kẻ địch",
      diceRange: "8-9",
      effect: "Cứ mỗi 1 Poise có trên người, đòn này sẽ được +1 Dice Up [Max: 19] [Slash] [Undodgeable]",
      consumePoise: true,
      poiseMul: 3,
    },
  },
  "standard-sword": {
    id: "standard-sword",
    name: "Standard Sword",
    type: "Slash",
    baseShort: "5",
    baseLong: "5-8",
    category: "Medium",
    description: "Kiếm tiêu chuẩn",
    passive: null,
    critical: {
      name: "Power Slash",
      cd: 2,
      diceRange: "10-15",
      desc: "Chém mạnh",
      effect: "Gây dmg cộng thêm 20%",
      consumePoise: false,
    },
  },
  "heavy-hammer": {
    id: "heavy-hammer",
    name: "Heavy Hammer",
    type: "Blunt",
    baseShort: "7",
    baseLong: "7-12",
    category: "Heavy",
    description: "Búa nặng",
    passive: null,
    critical: {
      name: "Shockwave",
      cd: 3,
      diceRange: "12-18",
      desc: "Đánh mạnh để phát sóng xung kích",
      effect: "Gây 4 Tremor + giảm 20 Stamina enemy",
      consumePoise: false,
    },
  },
};

/**
 * Lấy vũ khí từ ID
 */
function getWeapon(weaponId) {
  return WEAPONS[weaponId] ?? null;
}

/**
 * Danh sách tất cả vũ khí
 */
function listWeapons() {
  return Object.values(WEAPONS).map(w => ({
    id: w.id,
    name: w.name,
    type: w.type,
    category: w.category,
  }));
}

/**
 * Roll base dmg của vũ khí
 */
function rollWeaponDamage(weapon) {
  const dmgStr = weapon.baseLong || weapon.baseShort;
  if (!dmgStr.includes("-")) {
    return parseInt(dmgStr, 10);
  }
  const [min, max] = dmgStr.split("-").map(s => parseInt(s.trim(), 10));
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  WEAPONS,
  getWeapon,
  listWeapons,
  rollWeaponDamage,
};
