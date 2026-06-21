import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Button, Space, Tag, Alert } from "antd";

interface TerminalProps {
  serverId: string;
  serverName?: string;
  token: string;
  /**
   * 后端 base url(默认从 window.location 推断)。
   * dev 时可指向 http://localhost:3000
   */
  baseUrl?: string;
}

type Status = "connecting" | "open" | "closed" | "reconnecting" | "error";

/**
 * Phase 10: Web 终端组件
 * - xterm.js + FitAddon(自动撑满容器)+ WebLinksAddon(URL 链接)
 * - WebSocket 桥接 SSH shell stream(binary text 帧)
 * - 指数退避重连(1s → 2s → 4s → 8s → 16s → 30s 封顶)
 * - 30s 宽限期:服务端"复活"同一 shell session
 * - 容器尺寸变化 → 调 fit() + 发 resize 帧
 */
export function Terminal({ serverId, serverName, token, baseUrl }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const manualCloseRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontFamily: 'Menlo, Consolas, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
      },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // 监听容器 resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        // 通知 server 调整 PTY 大小
        sendResize();
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(containerRef.current);

    // xterm 输入 → ws
    const dataDisposable = term.onData((data) => {
      sendInput(data);
    });

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      manualCloseRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        try {
          wsRef.current.close(1000, "component unmounted");
        } catch {
          // ignore
        }
      }
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function wsUrl(): string {
    const base =
      baseUrl ??
      (typeof window !== "undefined"
        ? `${window.location.protocol}//${window.location.host}`
        : "http://localhost:3000");
    return base.replace(/^http/, "ws") + `/ws/terminal/${serverId}?token=${encodeURIComponent(token)}`;
  }

  function connect() {
    manualCloseRef.current = false;
    setStatus("connecting");
    setErrorMsg(null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      setStatus("error");
      setErrorMsg((e as Error).message);
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("open");
      setErrorMsg(null);
      reconnectAttemptRef.current = 0;
      // 连接建立后立即同步一次大小
      sendResize();
    };

    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      if (!data) return;
      // 控制帧以 { 开头
      if (data.length > 0 && data[0] === "{") {
        try {
          const ctrl = JSON.parse(data);
          if (ctrl && typeof ctrl === "object") {
            if (ctrl.type === "ready") {
              // OK,清屏提示
              termRef.current?.writeln("\x1b[32m[connected]\x1b[0m");
              return;
            }
            if (ctrl.type === "error") {
              termRef.current?.writeln(
                `\x1b[31m[error] ${String(ctrl.message ?? "")}\x1b[0m`,
              );
              return;
            }
            if (ctrl.type === "close") {
              termRef.current?.writeln(
                `\x1b[33m[closed] ${String(ctrl.reason ?? "")}\x1b[0m`,
              );
              return;
            }
            if (ctrl.type === "pong") return;
          }
        } catch {
          // 非 JSON,当 shell 输出处理
        }
      }
      termRef.current?.write(data);
    };

    ws.onerror = (e) => {
      setStatus("error");
      setErrorMsg("WebSocket error (see console)");
      // eslint-disable-next-line no-console
      console.error("[ws-term] error", e);
    };

    ws.onclose = (ev) => {
      wsRef.current = null;
      if (manualCloseRef.current) {
        setStatus("closed");
        return;
      }
      // 非主动关闭 → 触发重连
      termRef.current?.writeln(
        `\x1b[33m[disconnected code=${ev.code}] ${ev.reason ?? ""}\x1b[0m`,
      );
      scheduleReconnect();
    };
  }

  function sendInput(text: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(text);
  }

  function sendResize() {
    const ws = wsRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!ws || !term || !fit) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    const cols = term.cols;
    const rows = term.rows;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  function scheduleReconnect() {
    setStatus("reconnecting");
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
    }
    // 指数退避:1s, 2s, 4s, 8s, 16s, 30s 封顶
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(30000, 1000 * 2 ** attempt);
    reconnectAttemptRef.current = attempt + 1;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, delay);
  }

  function manualReconnect() {
    reconnectAttemptRef.current = 0;
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close(1000, "manual reconnect");
      } catch {
        // ignore
      }
    }
    connect();
  }

  // 首次连接
  useEffect(() => {
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Tag color={statusColor(status)}>{status.toUpperCase()}</Tag>
        {serverName && <Tag>{serverName}</Tag>}
        {(status === "reconnecting" || status === "error" || status === "closed") && (
          <Button size="small" onClick={manualReconnect}>
            重新连接
          </Button>
        )}
      </Space>
      {errorMsg && <Alert type="error" message={errorMsg} style={{ marginBottom: 8 }} />}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: 480,
          background: "#1e1e1e",
          padding: 4,
          borderRadius: 4,
        }}
      />
    </div>
  );
}

function statusColor(s: Status): string {
  switch (s) {
    case "open":
      return "green";
    case "connecting":
      return "blue";
    case "reconnecting":
      return "gold";
    case "closed":
      return "default";
    case "error":
      return "red";
  }
}
