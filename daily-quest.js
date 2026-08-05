// daily-quest.js
// Stage 5 (cuối) — rework "-daily" từ "gõ lệnh là xong" thành 3 nhiệm vụ/ngày:
//   1. Login (-daily chính) — 2 Exp.
//   2. Hoàn thành 1 contract bất kỳ (quest system) — 2 Exp.
//   3. RANDOM 1-trong-3 (roll 1 lần/ngày/người, lưu lại task3Variant):
//      - "ahn": tự hoàn thành ngay khi roll trúng — +2 Exp, +200k Ahn.
//      - "books": tự hoàn thành ngay khi roll trúng — +2 Exp, +3 Random Book.
//      - "killmobs": CẦN hành động thật — hạ đủ 3 mob/boss bất kỳ mới +2 Exp.
// Streak 7 ngày (xác nhận trực tiếp): đổi từ "login 7 ngày liên tục" thành "đủ
// CẢ 3 nhiệm vụ 7 ngày liên tục" — thưởng GIỮ NGUYÊN số cũ (DAILY_STREAK_*).
//
// GIẢ ĐỊNH cần xác nhận lại với Fragaria (đã báo rõ trong report): 2/3 biến thể
// task 3 (ahn/books) không cần hành động gì — tự hoàn thành ngay lúc roll trúng
// (cộng dồn luôn khi gọi claimDailyLogin) — CHỈ "killmobs" cần hành động thật.
// Đây là cách hiểu hợp lý nhất từ mô tả gốc nhưng CHƯA được xác nhận từng chữ.
//
// LƯU Ý LOCK: markContractTaskDone/incrementKillTaskProgress được gọi từ NƠI
// KHÁC (quest-resolution.js, resolve-pending-action.js) — PHẢI gọi SAU KHI lock
// userId ở nơi gọi đã release (không lồng vào lock cùng userId đang giữ, tránh
// deadlock/lock timeout) — xem comment cụ thể ở từng điểm gọi.

const TASK3_VARIANTS = ["ahn", "books", "killmobs"];
const TASK_EXP = 2;
const TASK3_AHN_REWARD = 200_000;
const TASK3_BOOK_COUNT = 3;
// BUG ĐÃ SỬA (Fragaria: "Quest 3 ở -daily nhiều khi chỉ cần -daily là hoàn thành
// luôn, quá dễ"). Chính comment đầu file đã ghi đây là GIẢ ĐỊNH chưa xác nhận —
// và giả định đó SAI: 2/3 biến thể ("ahn"/"books") tự hoàn thành ngay lúc roll,
// nên 2/3 số ngày nhiệm vụ 3 là quà miễn phí.
// Giờ CẢ 3 biến thể đều cần hạ mob thật, chỉ khác ngưỡng + phần thưởng — tái dùng
// nguyên bộ đếm `killCount` đã có (incrementKillTaskProgress), KHÔNG cần thêm hook
// theo dõi mới ở chỗ khác.
const TASK3_KILL_TARGET = 3;
const TASK3_KILL_TARGET_BY_VARIANT = { killmobs: 3, books: 4, ahn: 5 };
function killTargetFor(variant) { return TASK3_KILL_TARGET_BY_VARIANT[variant] ?? TASK3_KILL_TARGET; }

module.exports = function ({
  withLock, getActiveProfileSlot, playerKeyForSlot, dailyKeyForSlot,
  savePlayerData, redis, withTimeout, getVNDateString, getVNNow,
  secondsUntilVNMidnight, clampExpWithLunacy, DAILY_KEY_TTL_SECONDS,
  DAILY_STREAK_EXP_BONUS, DAILY_STREAK_AHN_BONUS, DAILY_STREAK_LUNACY_BONUS,
  formatNumber,
}) {
  function pickTask3Variant() {
    return TASK3_VARIANTS[Math.floor(Math.random() * TASK3_VARIANTS.length)];
  }

  function yesterdayStr() {
    const vnYesterday = new Date(getVNNow());
    vnYesterday.setUTCDate(vnYesterday.getUTCDate() - 1);
    return vnYesterday.toISOString().slice(0, 10);
  }

  /** getOrInitDailyData — đọc data hôm nay, hoặc khởi tạo mới nếu qua ngày (roll
   *  task3Variant MỚI, giữ streak nếu hôm qua đã hoàn thành đủ 3, reset về 0 nếu
   *  không). KHÔNG tự lock — caller chịu trách nhiệm lock userId trước khi gọi. */
  async function getOrInitDailyData(userId, slot) {
    const dailyKey = dailyKeyForSlot(userId, slot);
    const raw = await withTimeout(redis.get(dailyKey));
    const parsed = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    const today = getVNDateString();
    if (parsed && parsed.date === today) return { data: parsed, dailyKey };
    const prevStreak = parsed?.streak ?? 0;
    const streakCarry = (parsed?.allDoneDate === yesterdayStr()) ? prevStreak : 0;
    return {
      data: {
        date: today, loginDone: false, contractDone: false,
        task3Variant: pickTask3Variant(), task3Done: false, killCount: 0,
        streak: streakCarry, allDoneDate: parsed?.allDoneDate ?? null,
      },
      dailyKey,
    };
  }

  async function readProfile(userId, slot) {
    const raw = await withTimeout(redis.get(playerKeyForSlot(userId, slot)));
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
  }

  /** checkAllDoneAndApplyStreak — gọi SAU KHI vừa set 1 trong 3 field done=true.
   *  Nếu ĐỦ CẢ 3 và HÔM NAY CHƯA tính streak (allDoneDate !== today) — cộng
   *  streak +1, tới 7 thì phát thưởng tuần (số liệu GIỮ NGUYÊN DAILY_STREAK_*)
   *  rồi reset về 0. Trả về note thưởng tuần (string) hoặc null. */
  function checkAllDoneAndApplyStreak(data, profileData) {
    const today = getVNDateString();
    if (!(data.loginDone && data.contractDone && data.task3Done)) return null;
    if (data.allDoneDate === today) return null; // đã tính hôm nay rồi, không cộng lại
    data.allDoneDate = today;
    data.streak = (data.streak ?? 0) + 1;
    if (data.streak < 7) return null;
    profileData.exp = clampExpWithLunacy(profileData, (profileData.exp ?? 0) + DAILY_STREAK_EXP_BONUS);
    profileData.ahn = (profileData.ahn ?? 0) + DAILY_STREAK_AHN_BONUS;
    profileData.lunacy = (profileData.lunacy ?? 0) + DAILY_STREAK_LUNACY_BONUS;
    profileData.books = profileData.books ?? {};
    profileData.books["Sealed Book Cache"] = (profileData.books["Sealed Book Cache"] ?? 0) + 1;
    data.streak = 0;
    return `🏆 **Hoàn thành streak 7 ngày (đủ cả 3 nhiệm vụ)!** +${DAILY_STREAK_EXP_BONUS} Exp, +${formatNumber(DAILY_STREAK_AHN_BONUS)} Ahn, +${formatNumber(DAILY_STREAK_LUNACY_BONUS)} Lunacy, +1 Sealed Book Cache! Streak reset về 0.`;
  }

  async function saveDailyAndProfile(userId, slot, dailyKey, data, profileData) {
    await withTimeout(redis.set(dailyKey, JSON.stringify(data), { ex: DAILY_KEY_TTL_SECONDS }));
    await savePlayerData(userId, profileData, slot);
  }

  /** claimDailyLogin — nhiệm vụ 1 (-daily chính). Tự hoàn thành LUÔN nhiệm vụ 3
   *  nếu biến thể hôm nay là "ahn"/"books" (không cần hành động riêng). */
  async function claimDailyLogin(userId) {
    return withLock(userId, async () => {
      const slot = await getActiveProfileSlot(userId);
      const { data, dailyKey } = await getOrInitDailyData(userId, slot);
      if (data.loginDone) {
        const remaining = secondsUntilVNMidnight();
        return { alreadyDone: true, hours: Math.floor(remaining / 3600), minutes: Math.floor((remaining % 3600) / 60), seconds: remaining % 60, data };
      }
      const profileData = await readProfile(userId, slot);
      data.loginDone = true;
      profileData.exp = clampExpWithLunacy(profileData, (profileData.exp ?? 0) + TASK_EXP);
      let task3AutoNote = null;
      // KHÔNG còn auto-complete cho biến thể nào — xem comment ở TASK3_KILL_TARGET.
      // Giữ nguyên khối này dưới dạng "đã hoàn thành nhờ hạ đủ mob" (do
      // incrementKillTaskProgress set task3Done trước đó).
      if (false) {
        data.task3Done = true;
        profileData.exp = clampExpWithLunacy(profileData, (profileData.exp ?? 0) + TASK_EXP);
        if (data.task3Variant === "ahn") {
          profileData.ahn = (profileData.ahn ?? 0) + TASK3_AHN_REWARD;
          task3AutoNote = `Nhiệm vụ 3 hôm nay (nhận Ahn): +${TASK_EXP} Exp, +${formatNumber(TASK3_AHN_REWARD)} Ahn`;
        } else {
          profileData.books = profileData.books ?? {};
          profileData.books["Random Book"] = (profileData.books["Random Book"] ?? 0) + TASK3_BOOK_COUNT;
          task3AutoNote = `Nhiệm vụ 3 hôm nay (nhận sách): +${TASK_EXP} Exp, +${TASK3_BOOK_COUNT} Random Book`;
        }
      }
      const weeklyBonusNote = checkAllDoneAndApplyStreak(data, profileData);
      await saveDailyAndProfile(userId, slot, dailyKey, data, profileData);
      // task3AutoNote giữ lại để tương thích caller cũ, nhưng LUÔN null kể từ khi
      // bỏ auto-complete — KHÔNG hiển thị nó ra (sẽ ra chuỗi "null").
      return { alreadyDone: false, data, task3AutoNote, weeklyBonusNote };
    });
  }

  /** markContractTaskDone — nhiệm vụ 2, gọi từ quest-resolution.js SAU KHI lock
   *  userId ở đó đã release (KHÔNG lồng lock). Idempotent trong ngày. */
  async function markContractTaskDone(userId) {
    return withLock(userId, async () => {
      const slot = await getActiveProfileSlot(userId);
      const { data, dailyKey } = await getOrInitDailyData(userId, slot);
      if (data.contractDone) return null;
      const profileData = await readProfile(userId, slot);
      data.contractDone = true;
      profileData.exp = clampExpWithLunacy(profileData, (profileData.exp ?? 0) + TASK_EXP);
      const weeklyBonusNote = checkAllDoneAndApplyStreak(data, profileData);
      await saveDailyAndProfile(userId, slot, dailyKey, data, profileData);
      return { granted: true, weeklyBonusNote };
    });
  }

  /** incrementKillTaskProgress — nhiệm vụ 3 (biến thể "killmobs"), gọi từ
   *  resolve-pending-action.js mỗi khi player hạ 1 enemy (không cần unlock đặc
   *  biệt gì — resolve-pending-action.js không giữ lock userId nào). Chỉ tăng
   *  nếu biến thể HÔM NAY đúng là "killmobs" và chưa hoàn thành. */
  async function incrementKillTaskProgress(userId) {
    return withLock(userId, async () => {
      const slot = await getActiveProfileSlot(userId);
      const { data, dailyKey } = await getOrInitDailyData(userId, slot);
      if (data.task3Done) return null; // MỌI biến thể giờ đều đếm mob (xem TASK3_KILL_TARGET)
      data.killCount = (data.killCount ?? 0) + 1;
      const killTarget = killTargetFor(data.task3Variant);
      if (data.killCount < killTarget) {
        await withTimeout(redis.set(dailyKey, JSON.stringify(data), { ex: DAILY_KEY_TTL_SECONDS }));
        return { completed: false, killCount: data.killCount };
      }
      data.task3Done = true;
      const profileData = await readProfile(userId, slot);
      profileData.exp = clampExpWithLunacy(profileData, (profileData.exp ?? 0) + TASK_EXP);
      // Phần thưởng THEO BIẾN THỂ — trước đây trao ngay lúc gõ `-daily`, giờ chỉ
      // trao khi đã hạ đủ mob (ngưỡng cao hơn thì thưởng nhiều hơn).
      let variantRewardNote = "";
      if (data.task3Variant === "ahn") {
        profileData.ahn = (profileData.ahn ?? 0) + TASK3_AHN_REWARD;
        variantRewardNote = `, +${formatNumber(TASK3_AHN_REWARD)} Ahn`;
      } else if (data.task3Variant === "books") {
        profileData.books = profileData.books ?? {};
        profileData.books["Random Book"] = Math.min(99, (profileData.books["Random Book"] ?? 0) + TASK3_BOOK_COUNT);
        variantRewardNote = `, +${TASK3_BOOK_COUNT} Random Book`;
      }
      const weeklyBonusNote = checkAllDoneAndApplyStreak(data, profileData);
      await saveDailyAndProfile(userId, slot, dailyKey, data, profileData);
      return { completed: true, weeklyBonusNote, variantRewardNote, killTarget };
    });
  }

  return { claimDailyLogin, markContractTaskDone, incrementKillTaskProgress, TASK3_KILL_TARGET, killTargetFor };
};
