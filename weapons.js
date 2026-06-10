/**
 * weapons.js
 * Database vũ khí với base damage, passive, critical skill
 * Light = 5 Sta, Medium = 10 Sta, Heavy = 20 Sta
 */

const WEAPONS = {
  "moonlit-azure-blade": {
    id: "moonlit-azure-blade",
    name: "Moonlit Azure Blade",
    type: "Slash",
    baseMin: 5,
    baseMax: 10,
    category: "Light", // 5 Sta per attack
    staCost: 5,
    description: "Lam chiếc kiếm ánh trăng",
    passive: {
      name: "The Orthodox Blade [整劍]",
      desc: "Nếu trong turn này không tấn công thì turn sau sẽ được nhận 10 Poise [Max 2 lần, reset sau khi tấn công]",
    },
    critical: {
      name: "Fallstar Slayer [落星一殺]",
      cd: 3,
      cost: "3 Light",
      desc: "Lướt lên rút kiếm ra chém kẻ địch sau đó tra kiếm lại vào, cắt đứt không gian trước mặt",
      diceMin: 8,
      diceMax: 9,
      effect: "Cứ mỗi 1 Poise có trên người, đòn này sẽ được +1 Dice Up [Max: 19] [Slash] [Undodgeable]",
      consumePoise: true,
      poiseMul: 3,
    },
  },
  "standard-sword": {
    id: "standard-sword",
    name: "Standard Sword",
    type: "Slash",
    baseMin: 5,
    baseMax: 8,
    category: "Medium", // 10 Sta per attack
    staCost: 10,
    description: "Kiếm tiêu chuẩn",
    passive: null,
    critical: {
      name: "Power Slash",
      cd: 2,
      cost: "2 Light",
      diceMin: 10,
      diceMax: 15,
      desc: "Chém mạnh",
      effect: "Gây dmg cộng thêm 20%",
      consumePoise: false,
    },
  },
  "heavy-hammer": {
    id: "heavy-hammer",
    name: "Heavy Hammer",
    type: "Blunt",
    baseMin: 7,
    baseMax: 12,
    category: "Heavy", // 20 Sta per attack
    staCost: 20,
    description: "Búa nặng",
    passive: null,
    critical: {
      name: "Shockwave",
      cd: 3,
      cost: "3 Light",
      diceMin: 12,
      diceMax: 18,
      desc: "Đánh mạnh để phát sóng xung kích",
      effect: "Gây 4 Tremor + giảm 20 Stamina enemy",
      consumePoise: false,
    },
  },
};

/**
 * Action costs
 */
const ACTION_COSTS = {
  attack: (weapon) => weapon.staCost,
  dodge: () => 20,
  guard: () => 10,
  parry: () => 0,
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
    staCost: w.staCost,
  }));
}

/**
 * Roll base dmg của vũ khí
 */
function rollWeaponDamage(weapon) {
  return Math.floor(Math.random() * (weapon.baseMax - weapon.baseMin + 1)) + weapon.baseMin;
}

/**
 * Roll critical skill dice
 */
function rollCriticalDice(critical) {
  return Math.floor(Math.random() * (critical.diceMax - critical.diceMin + 1)) + critical.diceMin;
}

module.exports = {
  WEAPONS,
  ACTION_COSTS,
  getWeapon,
  listWeapons,
  rollWeaponDamage,
  rollCriticalDice,
};
