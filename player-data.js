// player-data.js
// Toàn bộ helper thao tác với player data qua Redis (migrate, get/save theo
// slot profile, quản lý tên profile...) — TÁCH khỏi index.js theo yêu cầu
// trực tiếp: "tách nhỏ file index.js ra các file js khác" (code đã lên tới
// 11k+ dòng, khó check/chỉnh sửa và tốn usage mỗi lần quét).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào) — chỉ bọc trong
// factory function nhận dependency từ index.js (giống pattern các module đã
// tách trước đó — xem comment ở encounter-panels.js).

module.exports = function ({ mostRecentHpResetBoundaryUtc, getMinorInjuries, MAX_PROFILES, RedisTimeoutError, VALID_ITEMS_SET, log, redis, withTimeout }) {

// ─── PLAYER DATA HELPERS ──────────────────────────────────────────────────────
function migratePlayerData(data) {
  if (data.books !== undefined || data.items !== undefined) {
    data.books = data.books ?? {};
    data.items = data.items ?? {};
    data.pages = data.pages ?? {};
    data.unlockedSkillTree = data.unlockedSkillTree ?? [];
    data.equippedPages = data.equippedPages ?? [null, null, null, null, null];
    data.equippedEgoPages = data.equippedEgoPages ?? [null, null, null, null, null];
    data.equippedWeapon = data.equippedWeapon ?? null;
    data.equippedOutfit = data.equippedOutfit ?? null;
    data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
    // BUG ĐÃ SỬA (phát hiện qua GM trực tiếp xem JSON thật trong Upstash và không
    // thấy field này đâu cả) — 4 cờ điều kiện đặc biệt + "pages" KHÔNG được backfill
    // cho player ĐÃ TỒN TẠI TỪ TRƯỚC khi các field này được thêm vào hệ thống —
    // profile CŨ hoàn toàn THIẾU field, KHÔNG PHẢI = false, gây khó hiểu khi GM tự
    // xem/sửa JSON trực tiếp trong Upstash.
    data.ShinUnlock = data.ShinUnlock ?? false;
    // ── DỌN "Shin" MỒ CÔI khỏi unlockedSkillTree (Fragaria yêu cầu trực tiếp:
    // "Nhiều player bây giờ có 'Shin' trong unlockskilltree ở database rồi mặc
    // dù họ không có unlockedshin: yes, cần clear ra bằng cách nào đó").
    //
    // NGUỒN GỐC: ở phiên trước tôi ĐOÁN SAI cơ chế mở khoá Shin nên đã thêm
    // `"Shin": 0` vào PERK_POINT_COSTS — GM cấp được perk tên "Shin" với giá 0
    // điểm. Sau khi xác định cơ chế THẬT là cờ profile `ShinUnlock`, những entry
    // "Shin" đó thành RÁC: vô nghĩa về luật nhưng vẫn nằm trong database.
    //
    // Dọn NGAY LÚC LOAD (migrate) nên tự lành dần khi player tương tác, không
    // cần chạy script quét toàn bộ database. Cost của "Shin" là 0 nên KHÔNG có
    // điểm skill tree nào phải hoàn lại — xoá là sạch.
    // Chỉ xoá đúng entry "Shin" TRẦN; perk NHÁNH shin (Shin Follow Up, Defensive
    // Light, Decimate Mind, Regain Mind) GIỮ NGUYÊN — chúng tốn điểm thật và vẫn
    // có tác dụng khi player được mở khoá sau này.
    if (Array.isArray(data.unlockedSkillTree) && data.unlockedSkillTree.includes("Shin")) {
      data.unlockedSkillTree = data.unlockedSkillTree.filter(p => p !== "Shin");
    }
  // ShinLevel / MangLevel — CHỈ SỐ CỦA PROFILE (không phải bộ đếm trong trận).
  // Fragaria làm rõ: "Mang là để ám chỉ LVL Mang của player, 1 lvl Mang tương
  // ứng 1 vòng tròn sáng... Khởi đầu player sẽ có 10 Shin Lvl và 1 Mang Lvl".
  // Tăng bằng vật phẩm (Fixer's Note), KHÔNG tăng khi kích hoạt Shin/Mang.
  data.ShinLevel = data.ShinLevel ?? 10;
  data.MangLevel = data.MangLevel ?? 1;
    data.LightSkillTreeUnlock = data.LightSkillTreeUnlock ?? false;
    data["50StatUnlock"] = data["50StatUnlock"] ?? false;
    data.ManifestedEGOUnlock = data.ManifestedEGOUnlock ?? false;
    return data;
  }
  const inv = data.inventory ?? {};
  const books = {};
  const items = {};
  for (const [name, count] of Object.entries(inv)) {
    if (count <= 0) continue;
    if (VALID_ITEMS_SET.has(name.toLowerCase())) {
      items[name] = count;
    } else {
      books[name] = count;
    }
  }
  data.books = books;
  data.items = items;
  data.pages = data.pages ?? {};
  data.unlockedSkillTree = data.unlockedSkillTree ?? [];
  data.equippedPages = data.equippedPages ?? [null, null, null, null, null];
  data.equippedEgoPages = data.equippedEgoPages ?? [null, null, null, null, null];
  data.equippedWeapon = data.equippedWeapon ?? null;
  data.equippedOutfit = data.equippedOutfit ?? null;
  data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
  data.ShinUnlock = data.ShinUnlock ?? false;
  // ShinLevel / MangLevel — CHỈ SỐ CỦA PROFILE (không phải bộ đếm trong trận).
  // Fragaria làm rõ: "Mang là để ám chỉ LVL Mang của player, 1 lvl Mang tương
  // ứng 1 vòng tròn sáng... Khởi đầu player sẽ có 10 Shin Lvl và 1 Mang Lvl".
  // Tăng bằng vật phẩm (Fixer's Note), KHÔNG tăng khi kích hoạt Shin/Mang.
  data.ShinLevel = data.ShinLevel ?? 10;
  data.MangLevel = data.MangLevel ?? 1;
  data.LightSkillTreeUnlock = data.LightSkillTreeUnlock ?? false;
  data["50StatUnlock"] = data["50StatUnlock"] ?? false;
  data.ManifestedEGOUnlock = data.ManifestedEGOUnlock ?? false;
  delete data.inventory;
  return data;
}

const REDIS_MAX_RETRIES = 2;
const REDIS_RETRY_BASE_MS = 150;

function isTimeoutError(err) {
  return err instanceof RedisTimeoutError;
}

// ─── PROFILE SYSTEM ───────────────────────────────────────────────────────────
// MAX_PROFILES được import từ constants.js (dùng chung với deploy-commands.js)
// Sinh PROFILE_LABELS/PROFILE_EMOJIS tự động theo MAX_PROFILES — tránh tình trạng
// hard-code chỉ tới slot 3 rồi quên cập nhật khi MAX_PROFILES đổi (gây hiển thị
// "undefined" cho slot mới), đúng với chủ đích "đổi 1 chỗ trong constants.js,
// chỗ khác tự đồng bộ".
function numberEmoji(n) {
  if (n === 10) return "🔟";
  if (n >= 0 && n <= 9) return `${n}\u{FE0F}\u{20E3}`; // keycap digit emoji (0️⃣-9️⃣)
  return `${n}.`; // fallback cho n > 10 (không có keycap emoji chuẩn)
}
const PROFILE_LABELS = {};
const PROFILE_EMOJIS = {};
for (let s = 1; s <= MAX_PROFILES; s++) {
  PROFILE_LABELS[s] = `Profile ${s}`;
  PROFILE_EMOJIS[s] = numberEmoji(s);
}

// ─── PROFILE NAME HELPERS ─────────────────────────────────────────────────────
// Tên tuỳ chỉnh lưu vào 1 key duy nhất per-user để giảm Redis round-trip.
// Cấu trúc: { "1": "Tên A", "2": "Tên B", "3": "Tên C" }
function profileNamesKey(userId) {
  return `profilenames:${userId}`;
}

async function getProfileNames(userId) {
  try {
    const raw = await withTimeout(redis.get(profileNamesKey(userId)));
    if (!raw) return {};
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

async function setProfileName(userId, slot, name) {
  const names = await getProfileNames(userId);
  if (name) {
    names[String(slot)] = name;
  } else {
    delete names[String(slot)];
  }
  if (Object.keys(names).length === 0) {
    await withTimeout(redis.del(profileNamesKey(userId)));
  } else {
    await withTimeout(redis.set(profileNamesKey(userId), JSON.stringify(names)));
  }
}

/** Trả về tên hiển thị của profile: tên tuỳ chỉnh nếu có, mặc định nếu không. */
function resolveProfileLabel(names, slot) {
  return names[String(slot)] ?? PROFILE_LABELS[slot];
}
// ─────────────────────────────────────────────────────────────────────────────

async function getActiveProfileSlot(userId) {
  try {
    const raw = await withTimeout(redis.get(`profile:${userId}`));
    const slot = parseInt(raw, 10);
    return (slot >= 1 && slot <= MAX_PROFILES) ? slot : 1;
  } catch {
    return 1;
  }
}

async function setActiveProfileSlot(userId, slot) {
  await withTimeout(redis.set(`profile:${userId}`, String(slot)));
}

// Task yêu cầu trực tiếp: "cấm không cho join nhiều encounter một lúc" + "đang
// lúc giữa encounter thì không được đổi profile" — track channel encounter
// ĐANG active của user (TTL 24h tự dọn nếu quên clear ở đâu đó — an toàn kép,
// không phụ thuộc HOÀN TOÀN vào việc clear đúng chỗ mọi trường hợp kết thúc).
function activeEncounterUserKey(userId) {
  return `useractiveenc:${userId}`;
}
async function getUserActiveEncounterChannel(userId) {
  const raw = await withTimeout(redis.get(activeEncounterUserKey(userId)));
  return raw || null;
}
async function setUserActiveEncounterChannel(userId, channelId) {
  await withTimeout(redis.set(activeEncounterUserKey(userId), channelId, { ex: 86400 }));
}
/** getUserActiveEncounterChannelChecked — BUG ĐÃ SỬA (Fragaria: "thỉnh thoảng khi
 *  encounter end nhưng key useractiveenc ở trên database vẫn còn khiến encounter
 *  đó bị kẹt trên hệ thống dù đã hết rồi, -encounter end cũng không được").
 *
 *  NGUYÊN NHÂN GỐC: `deleteEncounter` CHỈ xoá key encounter, KHÔNG dọn key
 *  `useractiveenc:<userId>` của từng người. Chỉ 2 đường có dọn tường minh
 *  (finalizeQuestOutcome và `-encounter end`); mọi đường khác (bot restart giữa
 *  chừng, xoá encounter thủ công, lỗi mạng ở giữa 2 thao tác) để lại key MỒ CÔI
 *  trỏ tới encounter không còn tồn tại. Người chơi bị khoá vĩnh viễn: join gì
 *  cũng bị chặn, mà `-encounter end` cũng vô dụng vì encounter đã biến mất.
 *
 *  SỬA TẬN GỐC — TỰ CHỮA LÀNH: khi đọc key, kiểm tra encounter đích còn tồn tại
 *  VÀ người này còn trong đó không; nếu không thì xoá key luôn rồi trả null.
 *  Đặt ở đây (không phải từng call site) để MỌI đường kiểm tra đều được chữa,
 *  kể cả đường thêm về sau. Nhận `encounterKeyFn` qua tham số thay vì require
 *  encounter-persistence — tránh circular dependency.
 */
async function getUserActiveEncounterChannelChecked(userId, encounterKeyFn) {
  const chan = await getUserActiveEncounterChannel(userId);
  if (!chan) return null;
  try {
    const raw = await withTimeout(redis.get(encounterKeyFn(chan)));
    if (!raw) { await clearUserActiveEncounterChannel(userId).catch(() => {}); return null; }
    const enc = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!enc?.players?.[userId]) { await clearUserActiveEncounterChannel(userId).catch(() => {}); return null; }
    return chan;
  } catch {
    // Redis lỗi tạm thời — GIỮ NGUYÊN key (không xoá nhầm khi chỉ là timeout),
    // trả về chan như cũ để hành vi chặn vẫn đúng.
    return chan;
  }
}

async function clearUserActiveEncounterChannel(userId) {
  await withTimeout(redis.del(activeEncounterUserKey(userId)));
}

function playerKeyForSlot(userId, slot) {
  return slot === 1 ? `player:${userId}` : `player:${userId}:slot${slot}`;
}

function dailyKeyForSlot(userId, slot) {
  return slot === 1 ? `daily:${userId}` : `daily:${userId}:slot${slot}`;
}

// buildProfileInfoEmbed đã chuyển sang player-actions.js (xem phần require + wiring bên dưới)
// ─────────────────────────────────────────────────────────────────────────────

async function getPlayerData(userId) {
  const slot = await getActiveProfileSlot(userId);
  const key = playerKeyForSlot(userId, slot);
  let lastErr;
  for (let attempt = 0; attempt <= REDIS_MAX_RETRIES; attempt++) {
    try {
      const raw = await withTimeout(redis.get(key));
      if (!raw) return { exp: 0, ahn: 0, lunacy: 0, redeemedCodes: [], books: {}, items: {}, pages: {}, unlockedSkillTree: [], equippedPages: [null,null,null,null,null], equippedEgoPages: [null,null,null,null,null], equippedWeapon: null, equippedOutfit: null, equippedAccessories: [null,null,null], ShinUnlock: false, LightSkillTreeUnlock: false, "50StatUnlock": false, ManifestedEGOUnlock: false };
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      return migratePlayerData(data);
    } catch (err) {
      lastErr = err;
      if (isTimeoutError(err)) break;
      if (attempt < REDIS_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, REDIS_RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// Giống getPlayerData nhưng trả về cả slot — dùng khi caller cần gọi savePlayerData
// với cùng slot để tránh gọi getActiveProfileSlot 2 lần (2 Redis round-trips).
/** applyHpCycleReset — reset HP + tự chữa CHẤN THƯƠNG NHẸ ở mốc 0h/12h giờ VN.
 *
 *  ❗ BUG ĐÃ SỬA (Fragaria: "chu kỳ 12h mỗi ngày reset HP và injury nhẹ chưa hoạt
 *  động; KHÔNG player nào được heal sau mốc 12h/24h").
 *  GỐC: việc reset chỉ chạy ở 3 chỗ (join encounter, party-board, một nhánh của
 *  message-create-handler). Người chơi xem `-balance`, `-heal`, đi shop… thì
 *  KHÔNG đường nào chạm tới ⇒ tưởng như chu kỳ không hoạt động.
 *  Nay đặt ở `getPlayerDataWithSlot` — cửa ngõ CHUNG của mọi đường đọc profile.
 *  @returns true nếu vừa reset (nơi gọi nên save).
 */
function applyHpCycleReset(data, deps) {
  const { mostRecentHpResetBoundaryUtc, MINOR_INJURIES } = deps ?? {};
  if (!mostRecentHpResetBoundaryUtc) return false;
  const boundary = mostRecentHpResetBoundaryUtc(Date.now());
  if ((data.hpLastResetCheck ?? 0) >= boundary) return false;
  data.hpLastResetCheck = Date.now();
  // Chấn thương NHẸ tự khỏi; NẶNG + Sizzling Wound (vĩnh viễn) thì giữ.
  if (Array.isArray(data.injuries) && data.injuries.length > 0 && Array.isArray(MINOR_INJURIES)) {
    const before = data.injuries.length;
    data.injuries = data.injuries.filter(
      i => !MINOR_INJURIES.some(m => String(m).toLowerCase() === String(i).toLowerCase()));
    if (data.injuries.length !== before) data.minorInjuriesAutoHealed = before - data.injuries.length;
  }
  // HP về đầy: xoá currentHp để mọi nơi tính lại theo Max HP hiện tại.
  delete data.currentHp;
  return true;
}

async function getPlayerDataWithSlot(userId) {
  const slot = await getActiveProfileSlot(userId);
  const key = playerKeyForSlot(userId, slot);
  let lastErr;
  for (let attempt = 0; attempt <= REDIS_MAX_RETRIES; attempt++) {
    try {
      const raw = await withTimeout(redis.get(key));
      const data = raw
        ? migratePlayerData(typeof raw === "string" ? JSON.parse(raw) : raw)
        : { exp: 0, ahn: 0, lunacy: 0, redeemedCodes: [], books: {}, items: {}, pages: {}, unlockedSkillTree: [], equippedPages: [null,null,null,null,null], equippedEgoPages: [null,null,null,null,null], equippedWeapon: null, equippedOutfit: null, equippedAccessories: [null,null,null], ShinUnlock: false, LightSkillTreeUnlock: false, "50StatUnlock": false, ManifestedEGOUnlock: false };
      // Áp chu kỳ 12h NGAY tại cửa ngõ đọc — mọi lệnh đều thấy HP đã reset.
      // getMinorInjuries là HÀM gọi muộn — `MINOR_INJURIES` là const khai SAU
      // dòng require này trong index.js (TDZ nếu truyền thẳng giá trị).
      if (applyHpCycleReset(data, { mostRecentHpResetBoundaryUtc, MINOR_INJURIES: getMinorInjuries?.() })) {
        savePlayerData(userId, data, slot).catch(() => {});
      }
      return { data, slot };
    } catch (err) {
      lastErr = err;
      if (isTimeoutError(err)) break;
      if (attempt < REDIS_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, REDIS_RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function savePlayerData(userId, data, slot = null) {
  // slot có thể được truyền vào từ caller (VD: handleOpenCache) để tránh thêm 1 Redis
  // round-trip khi đã biết slot rồi (từ getPlayerDataWithSlot).
  const resolvedSlot = slot ?? await getActiveProfileSlot(userId);
  const key = playerKeyForSlot(userId, resolvedSlot);
  const payload = JSON.stringify(data);
  let lastErr;
  for (let attempt = 0; attempt <= REDIS_MAX_RETRIES; attempt++) {
    try {
      await withTimeout(redis.set(key, payload));
      return;
    } catch (err) {
      lastErr = err;
      if (isTimeoutError(err)) break;
      if (attempt < REDIS_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, REDIS_RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  log("error", "savePlayerData", userId, lastErr?.message ?? "Unknown save error");
  throw lastErr;
}

async function saveMultiplePlayerData(entries) {
  // Nếu entry đã có slot (được truyền từ getPlayerDataWithSlot), dùng luôn để tránh
  // round-trip Redis thứ 2 và ngăn TOCTOU nếu user switch profile giữa chừng.
  const slots = await Promise.all(entries.map(e =>
    e.slot != null ? Promise.resolve(e.slot) : getActiveProfileSlot(e.userId)
  ));
  const keys = entries.map((e, i) => playerKeyForSlot(e.userId, slots[i]));
  const values = entries.map(e => JSON.stringify(e.data));

  // Dùng 1 lệnh EVAL (Lua script) để SET toàn bộ key cùng lúc — Redis chạy Lua
  // script atomic (đơn luồng), nên đảm bảo TẤT CẢ key cùng thành công hoặc TẤT
  // CẢ cùng thất bại. Trước đây dùng pipeline: mỗi SET trong pipeline thực thi
  // độc lập, nên nếu 1 lệnh lỗi giữa đường (VD: lưu cho recipient lỗi nhưng lưu
  // cho sender vẫn thành công), /give có thể làm mất Ahn/sách của người gửi mà
  // người nhận lại không được cộng — Lua script tránh được rủi ro nửa-nửa này.
  const setAllScript = `
    for i = 1, #KEYS do
      redis.call("set", KEYS[i], ARGV[i])
    end
    return "OK"
  `;
  try {
    await withTimeout(redis.eval(setAllScript, keys, values));
  } catch (err) {
    for (const e of entries) {
      log("error", "saveMultiplePlayerData", e.userId ?? "unknown", err.message);
    }
    throw new Error(`Lưu dữ liệu thất bại, không ai bị trừ/mất dữ liệu (atomic): ${err.message}`);
  }
}

function unwrapPipelineResults(results) {
  return results.map(r => {
    if (r !== null && typeof r === "object" && "result" in r) return r.result;
    return r;
  });
}

function formatNumber(n) {
  return Math.floor(n).toLocaleString("en-US");
}

  return {
    migratePlayerData, isTimeoutError, numberEmoji, PROFILE_LABELS, PROFILE_EMOJIS,
    profileNamesKey, getProfileNames, setProfileName, resolveProfileLabel,
    getActiveProfileSlot, setActiveProfileSlot, playerKeyForSlot, dailyKeyForSlot,
    getPlayerData, getPlayerDataWithSlot, savePlayerData, saveMultiplePlayerData,
    unwrapPipelineResults, formatNumber,
    getUserActiveEncounterChannel, getUserActiveEncounterChannelChecked, setUserActiveEncounterChannel, clearUserActiveEncounterChannel,
  };
};
