import jwt from "jsonwebtoken";

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || String(s).length < 16) {
    throw new Error("JWT_SECRET .env da kamida 16 belgi bo'lishi kerak");
  }
  return s;
}

export function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: process.env.JWT_EXPIRES || "7d" });
}

export function assertJwtConfigured() {
  getSecret();
}

export function verifyToken(token) {
  try {
    const raw = String(token || "").trim();
    if (!raw) return null;
    return jwt.verify(raw, getSecret());
  } catch {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const raw = req.headers.authorization || "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return res.status(401).json({ error: "Kirish talab qilinadi" });
  }
  try {
    req.auth = jwt.verify(m[1].trim(), getSecret());
    next();
  } catch {
    return res.status(401).json({ error: "Sessiya yaroqsiz yoki muddati tugagan" });
  }
}
