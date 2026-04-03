import net from "node:net";
import { spawn } from "node:child_process";

function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };

    socket.setTimeout(800);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function run(command) {
  const child = spawn(command, {
    shell: true,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

const serverBusy = await isPortInUse(8000);

if (serverBusy) {
  console.log("Port 8000 band: server allaqachon ishlayapti. Faqat frontend ishga tushiriladi.");
  run("npm run dev");
} else {
  console.log("Port 8000 bo'sh: server + frontend birga ishga tushiriladi.");
  run('chcp 65001>nul && concurrently -k "npm run server" "npm run dev"');
}
