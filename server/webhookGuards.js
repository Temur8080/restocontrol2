/**
 * Hikvision va boshqa webhook endpointlar uchun IP / tez cheklash.
 * Nginx orqali kelganda TRUST_PROXY=1 bo‘lsa X-Forwarded-For ishonchli hisoblanadi.
 */

/** Qurilma/host qatori: URL, port, IPv4-mapped — bir xil ko‘rinish. */
export function normalizeDeviceHost(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\//i, "");
  s = s.split("/")[0];
  s = s.split(":")[0];
  s = s.replace(/^::ffff:/i, "");
  return s.toLowerCase();
}

export function getWebhookClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return normalizeDeviceHost(String(xff).split(",")[0]);
  const ra = req.socket?.remoteAddress || "";
  return normalizeDeviceHost(ra);
}

/** WEBHOOK_ALLOWED_IPS=ip1,ip2 (vergul bilan); bo‘sh bo‘lsa barcha IP. */
export function webhookIpAllowlistMiddleware(req, res, next) {
  const raw = String(process.env.WEBHOOK_ALLOWED_IPS || "").trim();
  if (!raw) return next();
  const allowed = raw
    .split(",")
    .map((s) => normalizeDeviceHost(s.trim()))
    .filter(Boolean);
  if (allowed.length === 0) return next();
  const ip = getWebhookClientIp(req);
  if (!allowed.includes(ip)) {
    console.warn(`[hikvision http] WEBHOOK_ALLOWED_IPS: ruxsat yo‘q — ulanish_ip="${ip}"`);
    return res.status(403).type("text/plain").send("Forbidden");
  }
  next();
}

/** WEBHOOK_MAX_PER_MINUTE — daqiqada bitta IP uchun maksimal POST; 0 yoki bo‘sh o‘chirilgan. */
const rlCounts = new Map();
let rlMinuteBucket = 0;

export function webhookRateLimitMiddleware(req, res, next) {
  const max = Number.parseInt(String(process.env.WEBHOOK_MAX_PER_MINUTE || "0").trim(), 10);
  if (!Number.isFinite(max) || max <= 0) return next();
  const bucket = Math.floor(Date.now() / 60000);
  if (bucket !== rlMinuteBucket) {
    rlCounts.clear();
    rlMinuteBucket = bucket;
  }
  const ip = getWebhookClientIp(req);
  const nextCount = (rlCounts.get(ip) || 0) + 1;
  rlCounts.set(ip, nextCount);
  if (nextCount > max) {
    console.warn(`[hikvision http] rate limit (${max}/daq): ip="${ip}"`);
    return res.status(429).type("text/plain").send("Too Many Requests");
  }
  next();
}
