import { useEffect } from "react";

const REVEAL_CLASS = "scroll-modern--reveal";
const IDLE_MS = 1100;

function bindReveal(el) {
  let idleTimer;
  const onScroll = () => {
    el.classList.add(REVEAL_CLASS);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      el.classList.remove(REVEAL_CLASS);
    }, IDLE_MS);
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    clearTimeout(idleTimer);
    el.removeEventListener("scroll", onScroll);
    el.classList.remove(REVEAL_CLASS);
  };
}

function collectScrollModernRoots(node) {
  const out = [];
  if (node.nodeType === 1 && node.classList?.contains("scroll-modern")) {
    out.push(node);
  }
  if (node.nodeType === 1 && node.querySelectorAll) {
    node.querySelectorAll(".scroll-modern").forEach((el) => out.push(el));
  }
  return out;
}

/** Aylanish paytida `.scroll-modern--reveal` qo‘shiladi; to‘xtagach qisqa vaqt keyin yashirinadi (modallar uchun subtree kuzatiladi). */
export function useScrollModernReveal() {
  useEffect(() => {
    const cleanups = new Map();

    const attach = (el) => {
      if (!(el instanceof Element)) return;
      if (!el.classList.contains("scroll-modern")) return;
      if (cleanups.has(el)) return;
      cleanups.set(el, bindReveal(el));
    };

    const detach = (el) => {
      const fn = cleanups.get(el);
      if (fn) {
        fn();
        cleanups.delete(el);
      }
    };

    document.querySelectorAll(".scroll-modern").forEach(attach);

    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          collectScrollModernRoots(node).forEach(attach);
        });
        rec.removedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.classList?.contains("scroll-modern")) {
            detach(node);
          }
          if (node.nodeType === 1 && node.querySelectorAll) {
            node.querySelectorAll(".scroll-modern").forEach(detach);
          }
        });
      }
    });

    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      cleanups.forEach((fn) => fn());
      cleanups.clear();
    };
  }, []);
}
