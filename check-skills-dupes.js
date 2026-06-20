#!/usr/bin/env node
// check-skills-dupes.js
//
// JS KHÔNG báo lỗi khi object literal có key trùng — key sau đè key trước, âm thầm,
// không warning, không exception, `node --check` cũng pass bình thường.
//
// QUAN TRỌNG: SKILLS không chỉ được khai báo 1 lần qua `const SKILLS = {...}` — codebase
// còn dùng `Object.assign(SKILLS, {...})` để nối thêm skill mới ở cuối file (xem comment
// "NEW SKILLS (thêm vào đây khi có skill mới)" trong skills.js). Bản đầu của script này
// CHỈ quét block đầu tiên, bỏ sót toàn bộ block Object.assign — nghĩa là (a) trùng key
// NGAY TRONG block Object.assign, và (b) trùng key GIỮA 2 block, đều không bị phát hiện.
// Bản này quét TẤT CẢ block đóng góp key vào SKILLS, dồn chung vào 1 map để bắt được
// cả 2 trường hợp.
//
// Cách dùng:
//   node check-skills-dupes.js              → check skills.js ở cùng thư mục
//   node check-skills-dupes.js path/to/file → check file khác
//
// Gợi ý: thêm vào package.json:
//   "scripts": { "pretest": "node check-skills-dupes.js", "lint:skills": "node check-skills-dupes.js" }
// để tự chạy trước khi deploy / trước khi chạy test, không cần nhớ chạy tay.
//
// CÁCH HOẠT ĐỘNG: require("./skills.js") không giúp được gì — lúc đó JS đã collapse key
// trùng xong rồi, object trả về sẽ KHÔNG còn dấu vết gì cho thấy từng có duplicate. Phải
// đọc SOURCE TEXT và tự track brace-depth để tìm các dòng `"key": {` nằm ở ĐÚNG TOP-LEVEL
// (depth 1, tức con trực tiếp của khối chứa nó), rồi gom theo key trên TOÀN BỘ các block
// xem có key nào xuất hiện ≥2 lần.

const fs = require("fs");
const path = require("path");

const targetPath = path.resolve(process.argv[2] ?? path.join(__dirname, "skills.js"));
const src = fs.readFileSync(targetPath, "utf8");
const lines = src.split("\n");

// Tìm TẤT CẢ điểm bắt đầu đóng góp key vào SKILLS — không chỉ "const SKILLS = {" mà
// còn "Object.assign(SKILLS, {" (có thể xuất hiện nhiều lần nếu sau này thêm block nữa).
const blockStartPattern = /^\s*(const\s+SKILLS\s*=\s*\{|Object\.assign\(SKILLS,\s*\{)/;
const blockStarts = [];
for (let i = 0; i < lines.length; i++) {
  if (blockStartPattern.test(lines[i])) blockStarts.push(i);
}
if (blockStarts.length === 0) {
  console.error(`❌ Không tìm thấy block nào khai báo/mở rộng SKILLS trong ${targetPath}`);
  process.exit(1);
}

// Tokenizer tối giản — bỏ qua comment (//, /* */) và nội dung trong string literal
// ('...', "...", `...`), nếu không 1 dòng comment kiểu "đóng }; của SKILLS" sẽ bị đếm
// nhầm như brace thật, làm depth lệch.
function stripCommentsAndCountBraces(line, state) {
  let depthDelta = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === "*" && next === "/") { state.inBlockComment = false; i += 2; continue; }
      i++; continue;
    }
    if (state.inString) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === state.inString) { state.inString = null; }
      i++; continue;
    }
    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") { state.inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { state.inString = ch; i++; continue; }
    if (ch === "{") depthDelta++;
    else if (ch === "}") depthDelta--;
    i++;
  }
  return depthDelta;
}

// Quét TỪNG block riêng biệt (mỗi block có depth bắt đầu lại từ 0→1), nhưng DỒN
// CHUNG kết quả vào 1 map duy nhất — để bắt được cả trùng-trong-1-block và
// trùng-giữa-các-block.
const keyOccurrences = new Map(); // key → [lineNumber, ...]
const blockRanges = [];

for (const blockStart of blockStarts) {
  let depth = 0;
  const tokenState = { inString: null, inBlockComment: false };
  let blockEnd = lines.length - 1;

  for (let i = blockStart; i < lines.length; i++) {
    const line = lines[i];
    if (depth === 1) {
      // Dùng \s* (không cố định số space) — vì 2 dòng thực tế trong file bị thụt lề
      // không nhất quán (0 hoặc 4 space thay vì 2 như chuẩn), bản trước cứng \s{2}
      // làm bỏ sót "apocalypse" và "the solemn lament for the living". Đã có depth===1
      // làm chốt chặn chính xác rồi, không cần regex tự giới hạn indentation nữa.
      const m = line.match(/^\s*"([^"]+)"\s*:\s*\{/);
      if (m) {
        const key = m[1];
        if (!keyOccurrences.has(key)) keyOccurrences.set(key, []);
        keyOccurrences.get(key).push(i + 1); // 1-indexed
      }
    }
    depth += stripCommentsAndCountBraces(line, tokenState);
    if (depth <= 0 && i > blockStart) { blockEnd = i; break; }
  }
  blockRanges.push({ start: blockStart + 1, end: blockEnd + 1 });
}

const dupes = [...keyOccurrences.entries()].filter(([, lns]) => lns.length > 1);

console.log(`Đã quét ${path.relative(process.cwd(), targetPath)}: ${blockStarts.length} block đóng góp key —`);
for (const r of blockRanges) console.log(`  dòng ${r.start}–${r.end}`);
console.log(`Tổng ${keyOccurrences.size} key duy nhất.`);

if (dupes.length === 0) {
  console.log("✅ Không có key trùng trong SKILLS (đã quét tất cả block, kể cả Object.assign).");
  process.exit(0);
}

console.error(`\n❌ Tìm thấy ${dupes.length} key bị khai báo TRÙNG (key sau sẽ âm thầm đè key trước, không báo lỗi gì):\n`);
for (const [key, lns] of dupes) {
  console.error(`  "${key}" — khai báo ở dòng: ${lns.join(", ")}`);
}
console.error("\n→ Xóa hoặc đổi tên 1 trong các bản trùng trước khi deploy.");
process.exit(1);
