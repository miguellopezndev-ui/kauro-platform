// The control that shows why the network hooks exist (decision D-ISO-1): run under `node --permission` WITHOUT the preload, a
// connection goes out — Node 24's permission model does not govern the network. The test counts it at its own listener.
import net from "node:net";

const port = Number(process.argv[2]);
const socket = net.connect({ host: "127.0.0.1", port });
socket.on("connect", () => {
  process.stdout.write("CONNECTED");
  socket.destroy();
});
socket.on("error", (error: Error & { code?: string }) => {
  process.stdout.write(`ERROR:${error.code ?? "UNKNOWN"}`);
});
