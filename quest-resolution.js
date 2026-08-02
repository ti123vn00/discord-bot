// quest-resolution.js
// Stage 5 — check quest THẮNG/THUA (sau mỗi action resolve) + phát reward.
//
// Luật xác nhận trực tiếp:
//   - THẮNG (hết enemy) — CẢ TEAM nhận thưởng (kể cả người đã chết giữa chừng),
//     KHÔNG áp Death Penalty cho ai (dù có chết) — chỉ khi CẢ team chết mới áp.
//   - THUA (cả team chết — wipe) — áp Death Penalty cho TỪNG người.
//   - Giới hạn thưởng: 4 lần contract/NGÀY/NGƯỜI (không phân biệt loại contract),
//     hết lượt thì không nhận thưởng (dù vẫn thắng trận).
//
// checkQuestOutcome — THUẦN detect (không side-effect), gọi từ resolve-pending-
// action.js NGAY SAU khi resolve xong 1 action (đã biết HP mới nhất). Trả về
// null nếu CHƯA kết thúc, {won, contract} nếu đã kết thúc.
//
// grantContractReward — có side-effect (ghi profile + Redis) — mirror ĐÚNG
// pattern giới hạn theo ngày của processDailyClaimForUser (index.js) — key
// Redis riêng "contractcount:<userId>:<slot>", reset tự nhiên khi qua ngày mới
// (so sánh date field, không cần cron/job riêng).

const { CONTRACTS } = require("./quest-data");

module.exports = function ({
  withLock, getPlayerDataWithSlot, savePlayerData, clampExpWithLunacy,
  redis, withTimeout, getVNDateString, DAILY_KEY_TTL_SECONDS, markContractTaskDone,
  applyDeathPenalty, clearUserActiveEncounterChannel,
}) {
  function contractCountKey(userId, slot) {
    return `contractcount:${userId}:${slot}`;
  }

  /** checkQuestOutcome — encounter.isQuest bắt buộc true mới check. Trả về
   *  null nếu vẫn còn ít nhất 1 enemy VÀ ít nhất 1 player còn sống (chưa kết
   *  thúc) — {won: true, contract} nếu hết enemy — {won: false} nếu hết player
   *  (wipe toàn team). */
  function checkQuestOutcome(encounter) {
    if (!encounter.isQuest) return null;
    const aliveEnemies = Object.values(encounter.enemies).filter(e => e.currentHp > 0).length;
    const alivePlayers = Object.values(encounter.players).filter(p => p.currentHp > 0).length;
    if (aliveEnemies > 0 && alivePlayers > 0) return null;
    if (aliveEnemies === 0) {
      const contract = CONTRACTS[encounter.questMeta?.contractKey];
      return { won: true, contract };
    }
    return { won: false };
  }

  /** grantContractReward — cộng EXP/Ahn cho 1 người, tôn trọng giới hạn 4
   *  lần/ngày (tính chung TẤT CẢ loại contract, không phải riêng từng loại).
   *  Trả về { granted, count } — granted=false nếu đã đủ 4/4 hôm nay. */
  async function grantContractReward(userId, contract) {
    const result = await withLock(userId, async () => {
      const { data: profileData, slot } = await getPlayerDataWithSlot(userId);
      const today = getVNDateString();
      const key = contractCountKey(userId, slot);
      const raw = await withTimeout(redis.get(key));
      const parsed = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      const data = (parsed && parsed.date === today) ? parsed : { date: today, count: 0 };
      if (data.count >= 4) {
        return { granted: false, count: data.count };
      }
      data.count += 1;
      profileData.exp = clampExpWithLunacy(profileData, (profileData.exp ?? 0) + contract.expReward);
      profileData.ahn = (profileData.ahn ?? 0) + contract.ahnReward;
      await withTimeout(redis.set(key, JSON.stringify(data), { ex: DAILY_KEY_TTL_SECONDS }));
      await savePlayerData(userId, profileData, slot);
      return { granted: true, count: data.count };
    });
    // Nhiệm vụ 2 của -daily ("hoàn thành 1 contract bất kỳ") — tính là ĐÃ HOÀN
    // THÀNH ngay khi contract THẮNG (bất kể còn lượt reward 4/ngày hay không —
    // đây là nhiệm vụ RIÊNG của hệ thống -daily, không phụ thuộc giới hạn contract
    // reward). Gọi SAU KHI withLock(userId) ở trên đã release — markContractTaskDone
    // TỰ lock lại userId này lần nữa, lồng vào lock CÒN ĐANG GIỮ sẽ treo/lỗi.
    // dailyTaskNote — GAP THẬT phát hiện qua test: nếu việc này TRÚNG NGAY lúc đủ
    // streak 7 ngày, thông báo "🏆 Hoàn thành streak..." trước đây bị fire-and-
    // forget bỏ qua, KHÔNG ai thấy dù đã cộng đúng — giờ trả ra để resolve-
    // pending-action.js hiện kèm trong resultLines.
    let dailyTaskNote = null;
    try {
      const dailyResult = await markContractTaskDone(userId);
      if (dailyResult?.weeklyBonusNote) dailyTaskNote = dailyResult.weeklyBonusNote;
    } catch { /* không chặn reward chính nếu daily-quest lỗi */ }
    return { ...result, dailyTaskNote };
  }

  /** finalizeQuestOutcome — TÁCH RA DÙNG CHUNG (BUG ĐÃ SỬA, Fragaria báo trực
   *  tiếp: "sau khi gm dùng turn end order thì contract không thể tự động end
   *  encounter được").
   *
   *  NGUYÊN NHÂN GỐC: toàn bộ khối "check thắng/thua + phát thưởng + đánh dấu
   *  xoá encounter" TRƯỚC ĐÂY nằm INLINE bên trong resolveOnePendingAction
   *  (resolve-pending-action.js) — nghĩa là quest CHỈ có thể kết thúc khi có 1
   *  pendingAction vừa resolve. Mọi đường KHÁC đều không bao giờ check:
   *    - GM bấm "Kết thúc Turn" thủ công (performEndTurn)
   *    - Enemy/player cuối cùng chết vì DoT (Bleed/Burn/Rupture tick trong
   *      advanceCombatantTurn ở performEndTurn) chứ không phải vì 1 đòn đánh
   *    - Encounter bị treo rồi GM end tay để gỡ (chính xác kịch bản đã báo)
   *  → trận đã xong về mặt logic nhưng encounter vẫn nằm đó, không ai nhận
   *  thưởng, không ai được giải phóng active-encounter-index.
   *
   *  Giờ resolveOnePendingAction VÀ performEndTurn cùng gọi hàm này.
   *  KHÔNG tự xoá encounter ở đây (không có channelId/deleteEncounter) — chỉ
   *  set encounter._deleteAfterSave, caller tự xoá SAU khi saveEncounter (thứ
   *  tự bắt buộc: save giữ state cuối rồi mới xoá).
   *
   *  @returns string[] — các dòng thông báo (rỗng nếu quest CHƯA kết thúc). */
  /** QUEST_MAX_DURATION_MS — BUG ĐÃ SỬA (Fragaria: "player lạm dụng treo
   *  encounter không chịu kết thúc, treo cho tới khi tới giờ 12h 24h được hồi
   *  máu rồi mới đánh tiếp abuse khá nặng").
   *
   *  CÁCH ABUSE: HP hồi theo mốc 0h/12h giờ VN (getEffectiveCurrentHp). Encounter
   *  KHÔNG có hạn, và `-encounter end` đã bị chặn cho Contract (chống abuse
   *  khác) — nên player sắp thua chỉ cần NGỒI IM. Qua mốc reset là full máu,
   *  đánh tiếp như chưa có gì. Không mất lượt contract, không Death Penalty.
   *
   *  CHẶN: hạn **1 NGÀY** kể từ lúc bắt đầu (xác nhận trực tiếp từ Fragaria:
   *  "1 contract cho thời hạn là 1 ngày, sau hơn 1 ngày đó mà vẫn treo contract
   *  thì sẽ bị tính là thua và force end contract"). Quá hạn = xử THUA như wipe:
   *  áp Death Penalty, giải phóng active-encounter-index, xoá encounter.
   *  LƯU Ý: 24h DÀI HƠN chu kỳ hồi máu 12h, nên hạn này KHÔNG chặn được người
   *  chỉ chờ đúng 1 mốc reset — nó chặn việc treo VÔ HẠN. Phần chặn abuse mốc
   *  reset thật sự nằm ở chỗ khác: `-encounter end` đã bị khoá cho Contract và
   *  người treo trận bị giữ active-encounter-index nên KHÔNG nhận contract mới
   *  được (tự trừng phạt: đứng im = mất luôn lượt farm). */
  const QUEST_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

  /** isQuestExpired — encounter contract đã quá hạn (treo quá lâu) chưa. */
  function isQuestExpired(encounter) {
    if (!encounter?.isQuest) return false;
    const startedAt = encounter.createdAt ?? 0;
    if (!startedAt) return false; // encounter cũ chưa có timestamp — không xử oan
    return (Date.now() - startedAt) > QUEST_MAX_DURATION_MS;
  }

  async function finalizeQuestOutcome(encounter) {
    const resultLines = [];
    // Quá hạn → xử THUA ngay, KHÔNG cần đợi điều kiện thắng/thua thường.
    const expired = isQuestExpired(encounter);
    const questOutcome = expired
      ? { won: false, contract: null, reason: "expired" }
      : checkQuestOutcome(encounter);
    if (!questOutcome) return resultLines;
    if (expired) {
      resultLines.push(`⏰ **Contract quá hạn** — encounter đã kéo dài quá ${Math.round(QUEST_MAX_DURATION_MS / 3600000)} tiếng nên bị xử THUA tự động (chống treo trận chờ mốc hồi máu).`);
    }
    // Chặn chạy 2 lần cho CÙNG 1 encounter (VD resolveOnePendingAction vừa kết
    // thúc quest, rồi performEndTurn chạy ngay sau đó trên object đã đánh dấu) —
    // nếu không sẽ phát thưởng LẶP.
    if (encounter._questFinalized) return resultLines;
    encounter._questFinalized = true;

    if (questOutcome.won && questOutcome.contract) {
      const contract = questOutcome.contract;
      for (const pid of encounter.questMeta?.memberIds ?? []) {
        const rewardResult = await grantContractReward(pid, contract);
        resultLines.push(
          rewardResult.granted
            ? `🎁 <@${pid}> nhận ${contract.expReward} EXP + ${contract.ahnReward.toLocaleString("vi-VN")} Ahn (contract hôm nay: ${rewardResult.count}/4)`
            : `⚠️ <@${pid}> đã dùng hết 4 lượt contract hôm nay — không nhận thưởng lần này (dù trận đã thắng).`
        );
        if (rewardResult.dailyTaskNote) resultLines.push(`<@${pid}> ${rewardResult.dailyTaskNote}`);
      }
      resultLines.push(`🎉 **Contract "${contract.name}" HOÀN THÀNH!** Encounter kết thúc.`);
    } else {
      for (const pid of encounter.questMeta?.memberIds ?? []) {
        const note = await applyDeathPenalty(encounter, pid);
        if (note) resultLines.push(note);
      }
      resultLines.push(`💀 **Cả team đã gục ngã — Contract thất bại.** Encounter kết thúc.`);
    }
    for (const pid of encounter.questMeta?.memberIds ?? []) {
      clearUserActiveEncounterChannel(pid).catch(() => {});
    }
    encounter._deleteAfterSave = true;
    return resultLines;
  }

  return { checkQuestOutcome, grantContractReward, finalizeQuestOutcome, isQuestExpired, QUEST_MAX_DURATION_MS };
};
