// rtparry.js
// Hệ thống Real-Time Parry (web flow đo phản xạ thật + suy luận tốc độ Page 3 màu)
// — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp tục tách hàm ra thành file
// riêng". KHÁC skill-tree.js/book-system.js (cần dependency-injection) — module
// NÀY HOÀN TOÀN TỰ CHỨA, không phụ thuộc Redis/profile/combatant/calcGrade gì cả,
// nên export TRỰC TIẾP (không qua factory function).
//
// webParrySessions là SHARED MUTABLE STATE (Map) — dùng ở CẢ command handler
// (-rtparry/`/rtparry`, tạo session) LẪN Express route (/rtparry/:token/result,
// đọc/xoá session), 2 nơi CÁCH XA NHAU trong index.js. Node's require cache đảm
// bảo CHỈ 1 INSTANCE Map này tồn tại dù require() ở nhiều chỗ khác nhau (module
// singleton) — AN TOÀN, không cần lo lệch state giữa 2 nơi.
//
// crypto là Node.js built-in, discord.js builder classes require TRỰC TIẾP được
// — không có circular dependency với index.js.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

const crypto = require("crypto");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// ─── REAL-TIME PARRY (web flow — đo chính xác 100%, không lẫn latency Discord) ──
// `-rtparry` / `/rtparry` gửi DM 1 link ra trang Parry Real Time độc lập (route
// Express bên dưới), performance.now() chạy NGAY trên máy user — không qua
// round-trip Discord nào lúc đo, nên không có vấn đề clock-skew/latency như bản
// message-edit-đếm-ngược cũ (đã bỏ hoàn toàn — không còn fallback).
// Map<token, session> — token sống NGẮN (chỉ vài chục giây) nên dùng RAM, không cần
// Upstash: nếu bot restart giữa lúc user đang làm bài thì coi như hỏng phiên, chấp
// nhận được vì tỉ lệ xảy ra cực thấp và đây chỉ là minigame, không phải economy.
const webParrySessions = new Map();
const WEB_PARRY_TTL_MS = 90_000; // đủ thời gian user mở tab, đọc hướng dẫn, rồi mới bấm
// Cửa sổ parry (ms) — quá mốc này coi như "bỏ lỡ". Đặt thành const chung 1 chỗ thay vì
// hardcode rải rác (help text, route POST, v.v.) — tránh lệch số như đã từng gặp khi
// đổi 400→500→550 mà quên sửa hết chỗ. Đã hạ từ 550 xuống 250 vì giờ đo phản xạ thật,
// không còn latency Discord/CSS transition bù vào nữa.
const RTPARRY_WINDOW_MS = 400;
// Sàn sinh lý học — không ai phản xạ thị giác dưới mức này thật, dùng để lọc kết
// quả từ script tự động (xem comment đầy đủ ở route POST /rtparry/:token/result).
const RTPARRY_MIN_HUMAN_MS = 0;
const webParrySessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, s] of webParrySessions)
    if (s.expiresAt < now) webParrySessions.delete(token);
}, 30_000);

/** Lấy base URL public của bot — Render tự set RENDER_EXTERNAL_URL, fallback PUBLIC_URL
 *  cho môi trường khác (VD: chạy local hoặc host khác không tự set biến này). */
function getPublicBaseUrl() {
  return process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || null;
}

// ─── RTPARRY — TỐC ĐỘ PAGE (hệ thống 3 màu: đỏ→vàng→xanh, lấy cảm hứng Sekiro) ────
// Game gốc turn-based, KHÔNG có khái niệm "tốc độ real-time" nào — không có field
// nào trong skills.js được thiết kế để đại diện cho việc này. Đây là HEURISTIC suy
// luận từ field gần nhất có sẵn, không phải dữ liệu chính xác:
//   - weaponType (Heavy/Medium/Light): chỉ 7/302 skill có field này, và phần lớn skill
//     dùng weaponOf lại trỏ tới vũ khí KHÔNG có weaponType (VD: Durandal tự trỏ vào
//     chính nó) → phủ quá ít, không dùng được.
//   - diceMul: có ở mọi skill, nhưng 253/302 (84%) đều là "1x" → không phân biệt được.
//   - cd (cooldown): phân bố tốt nhất (120×2Turn, 55×1Turn, 52×3Turn, 37×4Turn, 16×"—",
//     9×5Turn, 7×6Turn) — suy luận: cd ngắn = đòn cơ bản/nhẹ dùng liên tục = NHANH;
//     cd dài = đòn nặng/ulti cần hồi lâu = CHẬM (telegraph dài hơn, giống đòn nặng
//     trong Sekiro có ký hiệu báo trước lâu hơn).
// Một số skill có thể bị suy luận sai (cd không = tốc độ thật) — chấp nhận được vì
// đây chỉ là minigame vui, không phải dữ liệu combat chính thức.
function inferPageSpeed(skill) {
  const cd = (skill.cd ?? "").trim();
  if (cd === "—" || cd === "") return "fast";
  const match = cd.match(/^(\d+)/);
  if (!match) return "normal"; // text không parse được rõ ràng (VD: "Khi X kích hoạt")
  const turns = parseInt(match[1], 10);
  if (turns <= 1) return "fast";
  if (turns <= 3) return "normal";
  return "slow";
}

// Khoảng thời gian (ms) màn vàng hiện trước khi chuyển xanh, theo tốc độ suy luận được.
// fast gần như tức khắc ("vàng cái thì instant xanh luôn" — ý gốc của Hugo); slow giữ
// lâu ("đợi lóe lên một lúc lâu mới xanh").
const PAGE_SPEED_YELLOW_MS = {
  fast:   { min: 50,   max: 150 },
  normal: { min: 500,  max: 900 },
  slow:   { min: 1300, max: 2000 },
};

// Cửa sổ parry (ms) — CŨNG phải đổi theo tốc độ Page, không chỉ riêng màn vàng. Lý do:
// Page chậm giữ vàng rất lâu (lên tới 2000ms) trước khi xanh — đã chờ lâu như vậy mà
// cửa sổ vẫn cố định 300ms như Page nhanh thì cảm giác RẤT khó/trễ (đợi căng cả 2s mà
// chỉ có 300ms để phản ứng, không tương xứng với độ "nặng"/báo trước dài của đòn chậm).
// Đòn chậm trong nhiều game parry cũng thường DỄ đỡ hơn vì thấy rõ trước — nên window
// rộng hơn cho slow, hẹp hơn cho fast (đòn nhanh cần phản ứng chính xác, ít khoan nhượng).
const PAGE_SPEED_WINDOW_MS = {
  fast:   300,
  normal: 400,
  slow:   560,
};

function randomYellowMs(speedTier) {
  const { min, max } = PAGE_SPEED_YELLOW_MS[speedTier] ?? PAGE_SPEED_YELLOW_MS.normal;
  return Math.round(min + Math.random() * (max - min));
}

/**
 * createRtparryToken — tạo token mới + lưu session, trả về URL đầy đủ. Đây là phần
 * CHUNG thật sự giữa prefix và slash — phần GỬI link (DM hay ephemeral) khác nhau đủ
 * nhiều (xem comment ở từng handler) nên để mỗi bên tự lo, không gò vào 1 hàm chung.
 * @param {object|null} skill — skill object (đã resolve qua findSkill ở caller) dùng để
 *   suy ra tốc độ vàng→xanh + cửa sổ qua inferPageSpeed(). NULL khi gọi `-rtparry` /
 *   `/rtparry` KHÔNG kèm tên — lúc đó dùng mốc mặc định cố định (RTPARRY_WINDOW_MS +
 *   tier "normal" cho vàng), KHÔNG tự chọn skill ngẫu nhiên (trước đây có làm vậy,
 *   user phản hồi là sai — "-rtparry" trần không liên quan gì tới page cụ thể nào cả,
 *   nên giữ hành vi đơn giản/cố định như cũ, chỉ thêm màn vàng cho đồng bộ UI 3 màu).
 * @returns {{ url: string, token: string } | null} null nếu thiếu baseUrl
 */
function createRtparryToken({ userId, channelId, messageId, skill = null }) {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) return null;
  const token = crypto.randomBytes(16).toString("hex");
  const speedTier = skill ? inferPageSpeed(skill) : "normal";
  webParrySessions.set(token, {
    userId,
    channelId,
    messageId,
    windowMs: skill ? PAGE_SPEED_WINDOW_MS[speedTier] : RTPARRY_WINDOW_MS,
    yellowMs: randomYellowMs(speedTier),
    skillName: skill ? skill.name : null,
    expiresAt: Date.now() + WEB_PARRY_TTL_MS,
  });
  return { url: `${baseUrl}/rtparry/${token}`, token };
}

function buildRtparryLinkButton(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("🔗 Mở Parry Real Time").setStyle(ButtonStyle.Link).setURL(url)
  );
}


module.exports = {
  webParrySessions,
  WEB_PARRY_TTL_MS,
  RTPARRY_WINDOW_MS,
  RTPARRY_MIN_HUMAN_MS,
  getPublicBaseUrl,
  inferPageSpeed,
  PAGE_SPEED_YELLOW_MS,
  PAGE_SPEED_WINDOW_MS,
  randomYellowMs,
  createRtparryToken,
  buildRtparryLinkButton,
};
