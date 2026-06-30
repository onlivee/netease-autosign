import crypto from "crypto";

const COOKIE = process.env.NETEASE_COOKIE;
const DT_WEBHOOK = process.env.DINGTALK_WEBHOOK;
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT = 30_000;
const MAX_RETRIES = 2;

if (!COOKIE) {
  console.error("Error: NETEASE_COOKIE environment variable is not set.");
  process.exit(1);
}

function getCookieValue(name) {
  const match = COOKIE.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : "";
}

function randomChineseIP() {
  const prefixes = ["118.31", "119.23", "123.56", "47.92", "39.96", "47.100", "120.25", "112.126"];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  return p + "." + Math.floor(Math.random() * 256) + "." + Math.floor(Math.random() * 256);
}

const headers = {
  Cookie: COOKIE,
  "User-Agent": UA,
  Referer: "https://music.163.com/",
  Origin: "https://music.163.com",
  "X-Real-IP": randomChineseIP(),
};

// ── Weapi 加密 ──────────────────────────────────────────
const presetKey = Buffer.from("0CoJUm6Qyw8W8jud");
const aesIv = Buffer.from("0102030405060708");
const modulusHex =
  "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function randomSecret(size = 16) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(size);
  let s = "";
  for (let i = 0; i < size; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, aesIv);
  return cipher.update(text, "utf8", "base64") + cipher.final("base64");
}

function rsaEncrypt(text) {
  const reversed = text.split("").reverse().join("");
  const m = BigInt("0x" + Buffer.from(reversed, "utf8").toString("hex"));
  const n = BigInt("0x" + modulusHex);
  return modPow(m, 0x010001n, n).toString(16).padStart(256, "0");
}

function weapiEncrypt(data) {
  const secKey = randomSecret(16);
  let params = aesEncrypt(JSON.stringify(data), presetKey);
  params = aesEncrypt(params, Buffer.from(secKey));
  return { params, encSecKey: rsaEncrypt(secKey) };
}

// ── 基础设施 ──────────────────────────────────────────
function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

function isSessionExpired(data) {
  return data.code === 301;
}

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, label, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i < retries) {
        log(label, `重试 ${i + 1}/${retries}: ${e.message}`);
        continue;
      }
      throw e;
    }
  }
}

async function weapiRequest(path, body = {}) {
  const csrfToken = getCookieValue("__csrf");
  const { params, encSecKey } = weapiEncrypt(body);
  const url = `https://music.163.com${path}${csrfToken ? "?csrf_token=" + csrfToken : ""}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ params, encSecKey }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── 云贝签到 ──────────────────────────────────────────
async function cloudSignIn() {
  const data = await withRetry(() => weapiRequest("/weapi/point/dailyTask", { type: "1" }), "云贝签到");
  if (isSessionExpired(data)) return { ok: false, text: "cookie 过期", fatal: true };
  if (data.code === 200) {
    const text = `+${data.point || 0} 云贝`;
    log("云贝签到", `成功, ${text}`);
    return { ok: true, text };
  }
  if (data.code === -2 || data.code === 403) {
    log("云贝签到", "今天已签到");
    return { ok: true, text: "今日已签到" };
  }
  const text = `code=${data.code}`;
  log("云贝签到", `失败 ${text}`);
  return { ok: false, text };
}

// ── VIP 信息查询 ──────────────────────────────────
async function getVipInfo() {
  const data = await withRetry(() => weapiRequest("/weapi/vipnewcenter/app/level/growhpoint/basic"), "VIP");
  if (data.code !== 200) {
    log("VIP", `查询失败 code=${data.code}`);
    return null;
  }
  return data.data;
}

// ── VIP 签到 ──────────────────────────────────────────
async function vipSignIn() {
  const data = await withRetry(() => weapiRequest("/weapi/vip-center-bff/task/sign"), "VIP签到");
  if (data.code === 200 && data.data === true) {
    log("VIP签到", "成功");
    return { ok: true, text: "success" };
  }
  const text = `code=${data.code}`;
  log("VIP签到", `失败 ${text}`);
  return { ok: false, text };
}

// ── VIP 成长值领取 ────────────────────────────────────
async function claimRewards() {
  const data = await withRetry(() => weapiRequest("/weapi/vipnewcenter/app/level/task/reward/getall"), "VIP成长值");
  if (data.code === 200 && data.data?.result === true) {
    log("VIP成长值", "领取成功");
    return { ok: true, text: "已领取" };
  }
  log("VIP成长值", "无可领取");
  return { ok: true, text: "无可领取" };
}

// ── 通知消息格式化（与推送通道解耦）───────────────────────
function buildMessage(result) {
  const now = new Date();
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const weekDay = weekdays[now.getDay()];

  const dingtalk = buildDingTalkMd(result, dateStr, weekDay);
  const telegram = buildTelegramText(result, dateStr, weekDay);
  return { dateStr, dingtalk, telegram };
}

function buildDingTalkMd(result, dateStr, weekDay) {
  const md = [
    `## 🎵 网易云音乐签到`,
    ``,
    `> 📅 ${dateStr} 星期${weekDay}`,
    ``,
    `---`,
    ``,
    `☁️ **云贝签到**`,
    ``,
    `${result.cloud.ok ? "✅" : "❌"} ${result.cloud.text}`,
  ];
  if (result.vipInfo) {
    md.push(
      ``,
      `---`,
      ``,
      `👑 **VIP 会员**`,
      ``,
      `> 🏷️ ${result.vipInfo.level}  📊 成长值 ${result.vipInfo.growth}`,
      ``,
      `${result.vipSign.ok ? "✅" : "❌"} VIP签到：${result.vipSign.ok ? "成功" : result.vipSign.text}`,
      `${result.vipReward.text !== "-" ? (result.vipReward.ok ? "🎁" : "❌") : "  "} 成长值：${result.vipReward.ok ? result.vipReward.text : result.vipReward.text}`
    );
  } else {
    md.push(``, `---`, ``, `👑 **VIP 会员**`, ``, `❌ 非会员或查询失败`);
  }
  md.push(``, `---`, ``, `🤖 [netease-sign](https://github.com/a6b6c6d6/netease-sign)`);
  return md.join("\n");
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildTelegramText(result, dateStr, weekDay) {
  const lines = [
    `<b>🎵 网易云音乐签到</b>`,
    ``,
    `📅 ${dateStr} 星期${weekDay}`,
    ``,
    `<b>☁️ 云贝签到</b>`,
    `${result.cloud.ok ? "✅" : "❌"} ${escapeHtml(result.cloud.text)}`,
  ];
  if (result.vipInfo) {
    lines.push(
      ``,
      `<b>👑 VIP 会员</b>`,
      `🏷️ ${escapeHtml(result.vipInfo.level)}  📊 成长值 ${result.vipInfo.growth}`,
      `${result.vipSign.ok ? "✅" : "❌"} VIP签到：${result.vipSign.ok ? "成功" : escapeHtml(result.vipSign.text)}`,
      `${result.vipReward.text !== "-" ? (result.vipReward.ok ? "🎁" : "❌") : "  "} 成长值：${result.vipReward.ok ? escapeHtml(result.vipReward.text) : escapeHtml(result.vipReward.text)}`
    );
  } else {
    lines.push(``, `<b>👑 VIP 会员</b>`, `❌ 非会员或查询失败`);
  }
  return lines.join("\n");
}

// ── 钉钉推送 ──────────────────────────────────────────
async function sendDingTalk(text, dateStr) {
  if (!DT_WEBHOOK) return;

  let url = DT_WEBHOOK;
  const secret = process.env.DINGTALK_SECRET;
  if (secret) {
    const timestamp = Date.now();
    const sign = crypto
      .createHmac("sha256", secret)
      .update(timestamp + "\n" + secret)
      .digest("base64");
    url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title: `🎵 签到报告 ${dateStr}`, text },
      }),
    });
    const data = await res.json();
    if (data.errcode === 0) {
      log("钉钉", "通知发送成功");
    } else {
      log("钉钉", `发送失败 errcode=${data.errcode}`);
    }
  } catch (e) {
    log("钉钉", `发送失败 ${e.message}`);
  }
}

// ── Telegram 推送 ──────────────────────────────────
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      log("Telegram", "通知发送成功");
    } else {
      log("Telegram", `发送失败 ${data.description || JSON.stringify(data)}`);
    }
  } catch (e) {
    log("Telegram", `发送失败 ${e.message}`);
  }
}

// ── 主流程 ──────────────────────────────────────────
async function main() {
  let hasFatal = false;

  if (!getCookieValue("MUSIC_U")) {
    console.warn("⚠️ 未找到 MUSIC_U cookie，session 可能已过期");
  }
  if (!getCookieValue("__csrf")) {
    console.warn("⚠️ 未找到 __csrf cookie，云贝签到可能失败");
  }

  let cloud = { ok: false, text: "未执行" };
  try {
    cloud = await cloudSignIn();
    if (cloud.fatal) hasFatal = true;
  } catch (e) {
    cloud = { ok: false, text: `请求异常: ${e.message}` };
    log("云贝签到", `异常 ${e.message}`);
  }

  let vipUserInfo = null;
  try {
    vipUserInfo = await getVipInfo();
  } catch (e) {
    log("VIP", `查询异常 ${e.message}`);
  }

  let vipInfo = null;
  let vipSign = { ok: false, text: "-" };
  let vipReward = { ok: true, text: "-" };

  if (vipUserInfo) {
    const ul = vipUserInfo.userLevel;
    vipInfo = { level: ul.levelName, growth: ul.growthPoint };
    log("VIP", `等级 ${vipInfo.level}  成长值 ${vipInfo.growth}`);

    if (ul.latestVipStatus === 1 && !ul.maxLevel) {
      try {
        vipSign = await vipSignIn();
      } catch (e) {
        vipSign = { ok: false, text: `请求异常: ${e.message}` };
        log("VIP签到", `异常 ${e.message}`);
      }
      try {
        vipReward = await claimRewards();
      } catch (e) {
        vipReward = { ok: false, text: `请求异常: ${e.message}` };
        log("VIP成长值", `异常 ${e.message}`);
      }
    } else {
      vipSign = { ok: true, text: "已达上限" };
    }
  } else {
    log("VIP", "查询失败或非会员");
  }

  const result = { cloud, vipInfo, vipSign, vipReward };

  // 结构化汇总输出
  const summary = [
    `云贝签到: ${result.cloud.ok ? "✅" : "❌"} ${result.cloud.text}`,
  ];
  if (result.vipInfo) {
    summary.push(
      `VIP等级:  ${result.vipInfo.level}`,
      `VIP签到:  ${result.vipSign.ok ? "✅" : "❌"} ${result.vipSign.text}`,
      `成长值:    ${result.vipReward.ok ? "✅" : "❌"} ${result.vipReward.text}`
    );
  } else {
    summary.push("VIP:      ❌ 非会员或查询失败");
  }
  console.log("\n═══ 签到汇总 ═══\n" + summary.join("\n") + "\n");

  const msg = buildMessage(result);
  await Promise.all([sendDingTalk(msg.dingtalk, msg.dateStr), sendTelegram(msg.telegram)]);

  if (hasFatal) process.exit(2);
  if (!result.cloud.ok) process.exit(1);
}

main().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
