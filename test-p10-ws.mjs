// 端到端测试:Web 终端 WS 路径
async function main() {
  const port = 3030;
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const tmp = fs.mkdtempSync("/tmp/p10-");
  const dataDir = path.join(tmp, "data");
  const logDir = path.join(tmp, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const child = spawn(
    process.execPath,
    [path.join("/workspace/packages/server/dist/index.js"), "--enable-web"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        LOG_DIR: logDir,
        ENCRYPTION_KEY: Buffer.from("x".repeat(32)).toString("base64"),
        JWT_SECRET: "test-jwt-secret-for-verification-1234",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d) => process.stdout.write("SRV: " + d));
  child.stderr.on("data", (d) => process.stderr.write("SRV-E: " + d));

  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/api/v1/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(">>> server up");

  // 1) 登录
  const login = await fetch(`http://localhost:${port}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "admin", password: "admin123" }),
  });
  const loginData = await login.json();
  console.log(
    ">>> login status:",
    login.status,
    "name:",
    loginData.name,
    "token len:",
    loginData.token?.length,
  );

  // 1.5) 创建一个 server(用 127.0.0.1:1 不可达 — 仅测试鉴权,不会真连 SSH)
  const create = await fetch(`http://localhost:${port}/api/v1/servers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${loginData.token}`,
    },
    body: JSON.stringify({
      name: "test-srv",
      host: "127.0.0.1",
      port: 1,
      username: "test",
      password: "test",
    }),
  });
  const createData = await create.json();
  console.log(">>> create server status:", create.status, "data:", createData);

  // 2) 开 WS — 真 server(不可达,会触发 SSH 连接失败)
  const url = `ws://localhost:${port}/ws/terminal/${createData.id}?token=${encodeURIComponent(loginData.token)}`;
  console.log(">>> ws url:", url);
  const ws = new WebSocket(url);
  let firstFrame = null;
  ws.onopen = () => console.log(">>> ws open");
  ws.onmessage = (ev) => {
    if (!firstFrame) firstFrame = ev.data;
    console.log(">>> ws msg:", String(ev.data).slice(0, 200));
  };
  ws.onerror = () => console.log(">>> ws error");
  ws.onclose = (ev) =>
    console.log(`>>> ws close code=${ev.code} reason=${ev.reason}`);

  // 2.5) 试无 token 的 WS(应被拒)
  const badUrl = `ws://localhost:${port}/ws/terminal/${createData.id}`;
  const badWs = new WebSocket(badUrl);
  badWs.onclose = (ev) =>
    console.log(`>>> bad ws close code=${ev.code} reason=${ev.reason}`);

  await new Promise((r) => setTimeout(r, 5000));
  ws.close();
  badWs.close();
  await new Promise((r) => setTimeout(r, 500));
  child.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(">>> done, first frame:", firstFrame);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
