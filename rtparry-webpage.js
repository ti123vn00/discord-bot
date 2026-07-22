// rtparry-webpage.js
// Hàm render trang HTML "Parry Real Time" (đo phản xạ thời gian thực trên
// trình duyệt người dùng) — TÁCH khỏi index.js theo yêu cầu trực tiếp: "tách
// nhỏ file index.js ra các file js khác" (code đã lên tới 11k+ dòng).
//
// HÀM THUẦN — chỉ dùng process.env (đọc trực tiếp, không cần truyền vào) và
// tham số đầu vào, KHÔNG phụ thuộc bất kỳ biến/hàm nào khác của index.js.
// COPY NGUYÊN VĂN (không sửa 1 dòng logic nào).

// ─── RTPARRY WEB PAGE ───────────────────────────────────────────────────────
/** Render trang Parry Real Time — HTML/CSS/JS thuần, không phụ thuộc gì bên ngoài.
 *  performance.now() chạy hoàn toàn trên máy user, không qua round-trip server
 *  lúc đo — đây là điểm khác biệt cốt lõi so với bản -rtparry trong Discord. */
function renderParryWebPage(token, windowMs, yellowMs, skillName) {
  // Audio hook — CHƯA có file thật (user sẽ cung cấp sau), nên đọc từ env var, fallback
  // rỗng. Client tự kiểm tra "có URL không" trước khi play — không lỗi gì nếu để trống,
  // chỉ là chạy không có âm thanh (im lặng) cho tới khi set 2 biến này.
  const soundYellowUrl = process.env.RTPARRY_SOUND_YELLOW_URL || "";
  const soundGoUrl = process.env.RTPARRY_SOUND_GO_URL || "";

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Parry Real Time</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
  #stage {
    height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 24px; user-select: none;
    background: #2c2f33; color: #fff; cursor: pointer;
  }
  #stage.idle    { background: #2c2f33; }
  #stage.waiting { background: #c0392b; }
  #stage.yellow  { background: #f1c40f; color: #2c2f33; }
  #stage.go      { background: #27ae60; }
  #stage.early   { background: #8e44ad; }
  #stage.missed  { background: #7f8c8d; }
  #stage.done    { background: #2c2f33; cursor: default; }
  h1 { font-size: clamp(22px, 7vw, 42px); margin: 0 0 12px; }
  p  { font-size: clamp(15px, 4vw, 20px); max-width: 480px; opacity: 0.9; }
  .big { font-size: clamp(36px, 12vw, 90px); font-weight: 800; margin: 8px 0; }
  button.start {
    margin-top: 16px; padding: 16px 32px; font-size: 18px; border: none; border-radius: 12px;
    background: #5865f2; color: #fff; cursor: pointer;
  }
  .footer { position: fixed; bottom: 12px; font-size: 12px; opacity: 0.5; }
</style>
</head>
<body>
<div id="stage" class="idle">
  <h1>⚔️ Parry Real Time</h1>
  <p>${skillName ? `Page: <b>${skillName}</b><br>` : ""}Đỏ = chuẩn bị · Vàng = sắp tới · Xanh = BẤM NGAY (trong ${windowMs}ms)</p>
  <button class="start" id="startBtn">Bắt đầu</button>
</div>
<div class="footer">Token: ${token.slice(0, 8)}… · Kết quả sẽ tự gửi vào Discord</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const WINDOW_MS = ${windowMs};
const YELLOW_MS = ${yellowMs};
const SOUND_YELLOW_URL = ${JSON.stringify(soundYellowUrl)};
const SOUND_GO_URL = ${JSON.stringify(soundGoUrl)};
const stage = document.getElementById("stage");
const startBtn = document.getElementById("startBtn");
let phase = "idle"; // idle | waiting | yellow | go | late | done
let t0 = null;
let timer = null;
let yellowTimer = null;
let goTimeoutTimer = null;
let noClickTimer = null;

function setPhase(p, html) {
  phase = p;
  stage.className = p === "late" ? "missed" : p; // dùng lại màu "missed" cho "late"
  stage.innerHTML = html;
}

// Preload audio NGAY lúc trang load — KHÔNG đợi tới lúc cần phát mới tạo Audio() như
// trước (đó là bug thật: tạo mới + bắt đầu fetch network đúng lúc màn vàng/xanh xuất
// hiện, có thể làm việc tải/decode file cạnh tranh CPU với việc render màn hình ngay
// lúc cần chính xác nhất — đặc biệt rõ với Page "fast" vì vàng chỉ kéo dài 50-150ms,
// file có thể chưa tải xong khi cần chuyển xanh). Giờ tạo Audio() 1 lần, gọi .load()
// chủ động ngay khi script chạy — lúc thật sự cần phát, file đã sẵn sàng từ trước.
const yellowAudio = SOUND_YELLOW_URL ? new Audio(SOUND_YELLOW_URL) : null;
const goAudio = SOUND_GO_URL ? new Audio(SOUND_GO_URL) : null;
if (yellowAudio) { yellowAudio.preload = "auto"; yellowAudio.load(); }
if (goAudio) { goAudio.preload = "auto"; goAudio.load(); }

// playSound — KHÔNG lỗi gì nếu chưa có audio (url rỗng) hoặc browser chặn autoplay.
// User đã bấm "Bắt đầu" trước đó nên đã có user-gesture trong page, audio.play()
// thường được phép sau đó, nhưng vẫn catch lỗi cho chắc (Safari/mobile có thể khác).
// Dùng LẠI audio object đã preload (currentTime reset về 0 để phát lại từ đầu nếu
// user chơi nhiều lần) — không tạo mới mỗi lần gọi.
function playSound(audio) {
  if (!audio) return;
  try {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch (e) {}
}

function startRound() {
  setPhase("waiting", "<h1>Chờ…</h1><p>ĐỪNG bấm vội — chờ qua VÀNG rồi tới XANH</p>");
  const delay = 1200 + Math.random() * 2800; // 1.2s~4s, random để không đoán được nhịp
  timer = setTimeout(() => {
    // Màn VÀNG — thời gian giữ vàng (YELLOW_MS) phụ thuộc tốc độ Page đang luyện, suy
    // ra từ cooldown thật của skill (xem inferPageSpeed phía server) — Page nhanh thì
    // vàng gần như tức khắc chuyển xanh, Page chậm thì giữ vàng lâu hơn nhiều.
    setPhase("yellow", "<h1>⚠️ Sắp tới!</h1>");
    playSound(yellowAudio);
    yellowTimer = setTimeout(() => {
      // QUAN TRỌNG: setPhase() TRƯỚC, ghi t0 SAU — và không ghi ngay mà đợi qua
      // double requestAnimationFrame. Trước đây ghi t0 = performance.now() NGAY
      // LẬP TỨC rồi MỚI gọi setPhase() — nghĩa là t0 đo "lúc code bắt đầu chạy",
      // không phải "lúc màn hình THẬT SỰ chuyển xanh". Giữa lúc yêu cầu đổi DOM
      // (className + innerHTML) và lúc trình duyệt thực sự PAINT thay đổi đó lên
      // màn hình luôn có 1 khoảng trễ (đợi tới vsync/frame kế tiếp, vài ms tới hơn
      // chục ms tùy máy). requestAnimationFrame lồng đôi là kỹ thuật chuẩn để chờ
      // tới khi chắc chắn frame chứa thay đổi đó ĐÃ được vẽ — rAF đầu tiên chạy
      // ngay TRƯỚC frame kế tiếp (đổi màu vừa apply nhưng có thể chưa lên màn
      // hình), rAF thứ hai (lồng trong rAF đầu) chạy ở frame SAU đó — lúc này chắc
      // chắn frame xanh đã vẽ xong. t0 ghi ở đây mới đúng là "lúc xanh thật sự".
      setPhase("go", "<div class='big'>BẤM NGAY!</div>");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          t0 = performance.now();
          // playSound() ĐẶT SAU khi đã chốt t0 — trước đây gọi TRƯỚC double rAF, nghĩa
          // là việc khởi động audio (seek currentTime=0 + play()) có khả năng (dù nhỏ)
          // chiếm main-thread đúng lúc rAF cần chạy, làm trễ thêm vài ms ngoài dự kiến.
          // Giờ âm thanh phát SAU khi đã đo xong — đánh đổi vài ms lệch audio-visual
          // (không đáng kể, tai người khó phân biệt) để đảm bảo việc ĐO không bị bất kỳ
          // công việc nào khác chen vào.
          playSound(goAudio);
          // Đếm ngược WINDOW_MS cũng neo theo CHÍNH XÁC mốc t0 này — không phải
          // mốc setTimeout fire — để 2 con số (thời điểm "xanh thật" và thời điểm
          // "hết giờ") luôn khớp nhau, không lệch theo độ trễ rAF kể trên.
          goTimeoutTimer = setTimeout(() => {
            setPhase("late", "<h1>⌛ Trễ rồi!</h1><p>Vẫn bấm để xem bạn trễ bao nhiêu</p>");
            // Failsafe: nếu sau đó vẫn không bấm luôn, tự submit "missed" thật (không
            // số) sau 1 khoảng đủ dài — không để phiên treo vô hạn.
            noClickTimer = setTimeout(() => submitResult(null, "missed"), 5000);
          }, WINDOW_MS);
        });
      });
    }, YELLOW_MS);
  }, delay);
}

async function submitResult(reactionMs, resultType) {
  clearTimeout(goTimeoutTimer);
  clearTimeout(noClickTimer);
  setPhase("done", "<h1>⏳ Đang gửi kết quả…</h1>");
  try {
    const res = await fetch("/rtparry/" + TOKEN + "/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reactionMs, resultType }),
    });
    const data = await res.json();
    if (data.ok) {
      const msgByType = {
        success: "<h1>✅ " + Math.round(reactionMs) + "ms</h1><p>Kết quả đã gửi vào Discord. Có thể đóng tab này.</p>",
        early:   "<h1>❌ Bấm sớm quá!</h1><p>Kết quả đã gửi vào Discord. Có thể đóng tab này.</p>",
        missed:  "<h1>⌛ Bỏ lỡ!</h1><p>Kết quả đã gửi vào Discord. Có thể đóng tab này.</p>",
      };
      setPhase("done", msgByType[resultType] ?? msgByType.success);
    } else {
      setPhase("done", "<h1>⚠️ " + (data.error || "Có lỗi xảy ra") + "</h1><p>Link có thể đã hết hạn — quay lại Discord dùng <code>-rtparry</code> lại.</p>");
    }
  } catch (e) {
    setPhase("done", "<h1>⚠️ Lỗi kết nối</h1><p>Không gửi được kết quả — kiểm tra mạng rồi thử lại.</p>");
  }
}

startBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  startRound();
});

stage.addEventListener("click", () => {
  if (phase === "waiting" || phase === "yellow") {
    // Bấm sớm (kể cả lúc ĐÃ vàng nhưng chưa xanh) = THẤT BẠI THẬT — khớp đúng cảm giác
    // Sekiro: thấy ký hiệu báo trước không có nghĩa được đỡ ngay, phải đợi đúng lúc đòn
    // landing (xanh) mới đỡ được. Trước đây cho "thử lại tại chỗ" miễn phí ở phase
    // "waiting", không báo server — nghĩa là spam-click suốt từ đầu KHÔNG BAO GIỜ bị
    // tính fail. Giờ bấm sớm 1 lần (dù đỏ hay vàng) là kết thúc phiên luôn, y như bấm
    // trễ (missed) hay bấm đúng lúc (success) — phải gõ -rtparry lại để có lượt mới.
    clearTimeout(timer);
    clearTimeout(yellowTimer);
    submitResult(null, "early");
  } else if ((phase === "go" || phase === "late") && t0 !== null) {
    // "late" vẫn submit như "success" — server tự ép thành "missed" nếu reactionMs
    // vượt windowMs (xem route POST), nhưng giờ có SỐ THẬT để hiển thị khi báo bỏ lỡ.
    const reactionMs = performance.now() - t0;
    submitResult(reactionMs, "success");
  } else if (phase === "go") {
    // Edge case cực hiếm: phase đã là "go" nhưng t0 chưa kịp set (đang chờ qua double
    // rAF xác nhận đã paint xong, xem comment ở startRound). Click rơi đúng vào khe vài
    // ms này thực tế gần như không thể xảy ra với phản xạ người thật — coi như bấm
    // sớm để an toàn, tránh tính ra reactionMs vô nghĩa (performance.now() - null).
    submitResult(null, "early");
  }
});
</script>
</body>
</html>`;
}

module.exports = { renderParryWebPage };
