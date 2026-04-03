import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";

/**
 * WebSocket clientlarni admin_id bo‘yicha guruhlaydi (admin yoki hodim — hodimning ish beruvchi admini).
 */
export async function resolveNotifyAdminId(pool, auth) {
  const role = auth?.role;
  const sub = Number(auth?.sub);
  if (!Number.isFinite(sub)) return null;
  if (role === "admin") return sub;
  if (role === "hodim") {
    const { rows } = await pool.query(
      `SELECT e.admin_id FROM users u JOIN employees e ON e.id = u.employee_id WHERE u.id = $1`,
      [sub]
    );
    const aid = rows[0]?.admin_id;
    return aid != null ? Number(aid) : null;
  }
  return null;
}

export function createAttendanceBroadcaster(pool) {
  /** @type {Map<number, Set<import('ws').WebSocket>>} */
  const byAdmin = new Map();

  function addClient(adminId, ws) {
    let set = byAdmin.get(adminId);
    if (!set) {
      set = new Set();
      byAdmin.set(adminId, set);
    }
    set.add(ws);
  }

  function removeClient(adminId, ws) {
    const set = byAdmin.get(adminId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) byAdmin.delete(adminId);
  }

  function broadcast({ adminId, records }) {
    if (adminId == null || !Array.isArray(records) || records.length === 0) return;
    const set = byAdmin.get(Number(adminId));
    if (!set || set.size === 0) return;
    const msg = JSON.stringify({ type: "attendance", records });
    for (const ws of set) {
      try {
        if (ws.readyState === 1) ws.send(msg);
      } catch {
        /* ignore */
      }
    }
  }

  function attachToHttpServer(server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      const host = request.headers.host || "localhost";
      let u;
      try {
        u = new URL(request.url || "/", `http://${host}`);
      } catch {
        socket.destroy();
        return;
      }
      if (u.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, u);
      });
    });

    wss.on("connection", async (ws, u) => {
      const token = u.searchParams.get("token");
      const auth = verifyToken(token);
      if (!auth?.sub) {
        ws.close(4001, "auth");
        return;
      }
      const adminScope = await resolveNotifyAdminId(pool, auth);
      if (adminScope == null) {
        ws.close(4002, "scope");
        return;
      }
      const aid = Number(adminScope);
      addClient(aid, ws);
      ws.on("close", () => removeClient(aid, ws));
      ws.on("error", () => removeClient(aid, ws));
    });

    return wss;
  }

  return { broadcast, attachToHttpServer };
}
