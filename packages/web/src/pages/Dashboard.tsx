import { Card, Col, Row, Statistic, Table, Tag, Empty } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

interface RecentAudit {
  id: string;
  action: string;
  status: "success" | "failed" | "denied" | "cancelled";
  serverId: string | null;
  operatorId: string | null;
  operatorType: "human" | "agent";
  durationMs: number | null;
  createdAt: number;
}

interface HealthResp {
  activeSessions: number;
}

export default function Dashboard() {
  const [serverCount, setServerCount] = useState(0);
  const [auditCount, setAuditCount] = useState(0);
  const [activeSessions, setActiveSessions] = useState(0);
  const [recent, setRecent] = useState<RecentAudit[]>([]);

  useEffect(() => {
    api.get<unknown[]>("/api/v1/servers").then((data) => {
      setServerCount(Array.isArray(data) ? data.length : 0);
    }).catch(() => {});
    api
      .get<{ count: number }>("/api/v1/audit-logs?sinceMinutes=1440")
      .then((data) => setAuditCount(data.count))
      .catch(() => {});
    api
      .get<HealthResp>("/api/v1/health")
      .then((data) => setActiveSessions(data.activeSessions ?? 0))
      .catch(() => {});
    api
      .get<{ logs: RecentAudit[] }>("/api/v1/audit-logs?limit=10")
      .then((data) => setRecent(data.logs ?? []))
      .catch(() => setRecent([]));
  }, []);

  const statusColor = (s: RecentAudit["status"]) => {
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

  const recentColumns = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (ts: number) => new Date(ts).toLocaleString("zh-CN"),
      width: 170,
    },
    {
      title: "操作",
      dataIndex: "action",
      key: "action",
      width: 160,
    },
    {
      title: "操作者",
      dataIndex: "operatorType",
      key: "operatorType",
      width: 90,
      render: (t: string) => <Tag>{t}</Tag>,
    },
    {
      title: "机器",
      dataIndex: "serverId",
      key: "serverId",
      render: (id: string | null) =>
        id ? <Link to={`/servers/${id}`}>{id.slice(0, 8)}</Link> : "-",
      width: 110,
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      render: (d: number | null) => (d != null ? `${d}ms` : "-"),
      width: 90,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (s: RecentAudit["status"]) => (
        <Tag color={statusColor(s)}>{s}</Tag>
      ),
      width: 100,
    },
  ];

  return (
    <div>
      <h2>仪表盘</h2>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic title="机器总数" value={serverCount} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="24h 操作数" value={auditCount} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="在线 session" value={activeSessions} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="审计来源" value="audit_logs" />
          </Card>
        </Col>
      </Row>
      <Card title="最近操作" size="small">
        {recent.length === 0 ? (
          <Empty description="暂无操作" />
        ) : (
          <Table
            rowKey="id"
            dataSource={recent}
            columns={recentColumns}
            size="small"
            pagination={false}
          />
        )}
      </Card>
    </div>
  );
}
