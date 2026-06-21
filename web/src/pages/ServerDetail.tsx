import { Tabs, Descriptions, Spin, message, Alert } from "antd";
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

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const [server, setServer] = useState<Server | null>(null);
  const [loading, setLoading] = useState(true);
  const [cmdOut, setCmdOut] = useState<string>("(终端/命令/状态/审计 功能开发中)");
  const [activeTab, setActiveTab] = useState("info");

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api
      .get<Server>(`/api/v1/servers/${id}`)
      .then(setServer)
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <Spin />;
  if (!server) return <Alert type="error" message="未找到服务器" />;

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
              {(server.commandWhitelist ?? []).join("\n") || "(空)"}
            </Descriptions.Item>
            <Descriptions.Item label="黑名单" span={2}>
              {(server.commandBlacklist ?? []).join("\n") || "(空)"}
            </Descriptions.Item>
            <Descriptions.Item label="允许远端路径" span={2}>
              {(server.allowedRemotePaths ?? []).join("\n") || "(空)"}
            </Descriptions.Item>
            <Descriptions.Item label="SOCKS 代理" span={2}>
              {server.socksProxy ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="描述" span={2}>
              {server.description ?? "-"}
            </Descriptions.Item>
          </Descriptions>
        </Tabs.TabPane>
        <Tabs.TabPane tab="终端" key="terminal">
          <Alert
            type="info"
            message="Web 终端开发中 (Phase 10)"
            description="MVP 阶段,请使用 CLI 的 terminal 子命令唤起浏览器 / 直接通过 MCP client 操作。"
          />
        </Tabs.TabPane>
        <Tabs.TabPane tab="命令" key="cmd">
          <Alert
            type="info"
            message="单服务器命令执行请通过 MCP tool execute-command"
            description="本页面将提供命令面板(Phase 10 后续工作)。"
          />
        </Tabs.TabPane>
        <Tabs.TabPane tab="文件" key="files">
          <Alert type="info" message="文件管理 (Phase 10+ 后续工作)" />
        </Tabs.TabPane>
        <Tabs.TabPane tab="审计" key="audit">
          <pre>{cmdOut}</pre>
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}
