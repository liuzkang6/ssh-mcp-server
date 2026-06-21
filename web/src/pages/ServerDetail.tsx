import {
  Tabs,
  Descriptions,
  Spin,
  message,
  Alert,
  Form,
  Input,
  Button,
  Card,
  Table,
  Tag,
  Empty,
} from "antd";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";

interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group: string | null;
  tags: string[];
  description: string | null;
  transportMode: "exec" | "shell";
  commandWhitelist: string[];
  commandBlacklist: string[];
  allowedRemotePaths: string[];
  socksProxy: string | null;
}

interface ActiveSession {
  sessionId: string | null;
  operatorId: string;
  mode: string;
  acquiredAt: number;
  refCount: number;
}

interface ExecResp {
  command: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
  durationMs: number;
}

interface AuditEntry {
  id: string;
  action: string;
  status: "success" | "failed" | "denied" | "cancelled";
  operatorType: "human" | "agent";
  operatorId: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: number;
}

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const [server, setServer] = useState<Server | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("info");

  // 状态 tab
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);

  // 命令 tab
  const [execForm] = Form.useForm();
  const [execResult, setExecResult] = useState<ExecResp | null>(null);
  const [execRunning, setExecRunning] = useState(false);

  // 文件 tab
  const [uploadForm] = Form.useForm();
  const [downloadForm] = Form.useForm();
  const [fileResult, setFileResult] = useState<string | null>(null);

  // 审计 tab
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api
      .get<Server>(`/api/v1/servers/${id}`)
      .then(setServer)
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  // 状态 tab:轮询 active-sessions
  useEffect(() => {
    if (activeTab !== "status" || !id) return;
    let stopped = false;
    const tick = async () => {
      try {
        const data = await api.get<{ sessions: ActiveSession[] }>(
          `/api/v1/servers/${id}/active-sessions`,
        );
        if (!stopped) setActiveSessions(data.sessions ?? []);
      } catch {
        if (!stopped) setActiveSessions([]);
      }
    };
    void tick();
    const h = setInterval(tick, 5000);
    return () => {
      stopped = true;
      clearInterval(h);
    };
  }, [activeTab, id]);

  // 审计 tab:取该 server 最近 50 条
  useEffect(() => {
    if (activeTab !== "audit" || !id) return;
    api
      .get<{ logs: AuditEntry[] }>(
        `/api/v1/audit-logs?serverId=${id}&limit=50`,
      )
      .then((data) => setAuditLogs(data.logs ?? []))
      .catch(() => setAuditLogs([]));
  }, [activeTab, id]);

  const runExec = async () => {
    if (!id) return;
    const values = await execForm.validateFields();
    setExecRunning(true);
    setExecResult(null);
    try {
      const r = await api.post<ExecResp>(`/api/v1/servers/${id}/exec`, values);
      setExecResult(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setExecRunning(false);
    }
  };

  const runUpload = async () => {
    if (!id) return;
    const values = await uploadForm.validateFields();
    try {
      const r = await api.post<{ bytesTransferred: number; durationMs: number }>(
        `/api/v1/servers/${id}/upload`,
        values,
      );
      setFileResult(`上传 ${r.bytesTransferred} 字节,${r.durationMs}ms`);
      message.success("上传成功");
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const runDownload = async () => {
    if (!id) return;
    const values = await downloadForm.validateFields();
    try {
      const r = await api.post<{ bytesTransferred: number; durationMs: number }>(
        `/api/v1/servers/${id}/download`,
        values,
      );
      setFileResult(`下载 ${r.bytesTransferred} 字节,${r.durationMs}ms`);
      message.success("下载成功");
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (loading) return <Spin />;
  if (!server) return <Alert type="error" message="未找到服务器" />;

  const statusColor = (s: AuditEntry["status"]) => {
    switch (s) {
      case "success":
        return "green";
      case "failed":
        return "red";
      case "denied":
        return "orange";
      case "cancelled":
        return "default";
    }
  };

  return (
    <div>
      <h2>{server.name}</h2>
      <Tabs activeKey={activeTab} onChange={setActiveTab}>
        <Tabs.TabPane tab="信息" key="info">
          <Descriptions bordered column={2} size="small">
            <Descriptions.Item label="Host">{server.host}</Descriptions.Item>
            <Descriptions.Item label="端口">{server.port}</Descriptions.Item>
            <Descriptions.Item label="用户">{server.username}</Descriptions.Item>
            <Descriptions.Item label="Transport">{server.transportMode}</Descriptions.Item>
            <Descriptions.Item label="分组">{server.group ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="Tags">
              {(server.tags ?? []).join(", ") || "-"}
            </Descriptions.Item>
            <Descriptions.Item label="白名单" span={2}>
              <pre style={{ margin: 0 }}>
                {(server.commandWhitelist ?? []).join("\n") || "(空)"}
              </pre>
            </Descriptions.Item>
            <Descriptions.Item label="黑名单" span={2}>
              <pre style={{ margin: 0 }}>
                {(server.commandBlacklist ?? []).join("\n") || "(空)"}
              </pre>
            </Descriptions.Item>
            <Descriptions.Item label="允许远端路径" span={2}>
              <pre style={{ margin: 0 }}>
                {(server.allowedRemotePaths ?? []).join("\n") || "(空)"}
              </pre>
            </Descriptions.Item>
            <Descriptions.Item label="SOCKS 代理" span={2}>
              {server.socksProxy ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="描述" span={2}>
              {server.description ?? "-"}
            </Descriptions.Item>
          </Descriptions>
        </Tabs.TabPane>

        <Tabs.TabPane tab="状态" key="status">
          <Card title="活跃 Session" size="small" extra="每 5s 自动刷新">
            {activeSessions.length === 0 ? (
              <Empty description="暂无活跃 session" />
            ) : (
              <Table
                rowKey={(r) => `${r.operatorId}-${r.acquiredAt}`}
                dataSource={activeSessions}
                size="small"
                pagination={false}
                columns={[
                  { title: "Operator", dataIndex: "operatorId", width: 200 },
                  {
                    title: "Mode",
                    dataIndex: "mode",
                    width: 80,
                    render: (m: string) => <Tag>{m}</Tag>,
                  },
                  {
                    title: "开始时间",
                    dataIndex: "acquiredAt",
                    render: (t: number) => new Date(t).toLocaleTimeString("zh-CN"),
                    width: 140,
                  },
                  { title: "引用计数", dataIndex: "refCount", width: 100 },
                ]}
              />
            )}
          </Card>
        </Tabs.TabPane>

        <Tabs.TabPane tab="命令" key="cmd">
          <Card size="small">
            <Form form={execForm} layout="vertical" onFinish={runExec}>
              <Form.Item label="命令" name="command" rules={[{ required: true }]}>
                <Input.TextArea rows={3} placeholder="ls -la" />
              </Form.Item>
              <Form.Item label="工作目录(可选)" name="directory">
                <Input placeholder="/tmp" />
              </Form.Item>
              <Form.Item label="超时(毫秒)" name="timeoutMs" initialValue={30000}>
                <Input type="number" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={execRunning}>
                  执行
                </Button>
              </Form.Item>
            </Form>
          </Card>
          {execResult && (
            <Card size="small" style={{ marginTop: 12 }} title="执行结果">
              <div style={{ marginBottom: 8 }}>
                <Tag color={execResult.exitCode === 0 ? "green" : "red"}>
                  exitCode={execResult.exitCode}
                </Tag>
                <Tag>{execResult.durationMs}ms</Tag>
              </div>
              <pre style={{ background: "#f5f5f5", padding: 8, maxHeight: 360, overflow: "auto" }}>
                {execResult.stdout || ""}
                {execResult.stderr ? `\n--- stderr ---\n${execResult.stderr}` : ""}
              </pre>
            </Card>
          )}
        </Tabs.TabPane>

        <Tabs.TabPane tab="终端" key="terminal">
          <Alert
            type="info"
            message="Web 终端开发中 (Phase 10)"
            description="MVP 阶段,请使用 CLI 的 terminal 子命令唤起浏览器 / 直接通过 MCP client 操作。"
          />
        </Tabs.TabPane>

        <Tabs.TabPane tab="文件" key="files">
          <Card title="上传" size="small" style={{ marginBottom: 12 }}>
            <Form form={uploadForm} layout="vertical" onFinish={runUpload}>
              <Form.Item label="本地路径" name="localPath" rules={[{ required: true }]}>
                <Input placeholder="/local/path/file.txt" />
              </Form.Item>
              <Form.Item label="远端路径" name="remotePath" rules={[{ required: true }]}>
                <Input placeholder="/remote/path/file.txt" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit">上传</Button>
              </Form.Item>
            </Form>
          </Card>
          <Card title="下载" size="small">
            <Form form={downloadForm} layout="vertical" onFinish={runDownload}>
              <Form.Item label="远端路径" name="remotePath" rules={[{ required: true }]}>
                <Input placeholder="/remote/path/file.txt" />
              </Form.Item>
              <Form.Item label="本地路径" name="localPath" rules={[{ required: true }]}>
                <Input placeholder="/local/path/file.txt" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit">下载</Button>
              </Form.Item>
            </Form>
          </Card>
          {fileResult && (
            <Alert
              style={{ marginTop: 12 }}
              type="success"
              message={fileResult}
              showIcon
            />
          )}
        </Tabs.TabPane>

        <Tabs.TabPane tab="审计" key="audit">
          <Card size="small" title="最近 50 条审计">
            {auditLogs.length === 0 ? (
              <Empty description="暂无审计" />
            ) : (
              <Table
                rowKey="id"
                dataSource={auditLogs}
                size="small"
                pagination={{ pageSize: 20 }}
                columns={[
                  {
                    title: "时间",
                    dataIndex: "createdAt",
                    width: 170,
                    render: (t: number) => new Date(t).toLocaleString("zh-CN"),
                  },
                  { title: "操作", dataIndex: "action", width: 160 },
                  {
                    title: "操作者",
                    dataIndex: "operatorType",
                    width: 90,
                    render: (t: string) => <Tag>{t}</Tag>,
                  },
                  {
                    title: "耗时",
                    dataIndex: "durationMs",
                    width: 90,
                    render: (d: number | null) => (d != null ? `${d}ms` : "-"),
                  },
                  {
                    title: "状态",
                    dataIndex: "status",
                    width: 100,
                    render: (s: AuditEntry["status"]) => (
                      <Tag color={statusColor(s)}>{s}</Tag>
                    ),
                  },
                  { title: "错误", dataIndex: "errorMessage" },
                ]}
              />
            )}
          </Card>
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}
