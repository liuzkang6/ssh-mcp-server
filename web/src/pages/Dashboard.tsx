import { Card, Col, Row, Statistic } from "antd";
import { useEffect, useState } from "react";
import { api } from "../api/client";

export default function Dashboard() {
  const [serverCount, setServerCount] = useState(0);
  const [auditCount, setAuditCount] = useState(0);

  useEffect(() => {
    api.get<unknown[]>("/api/v1/servers").then((data) => {
      setServerCount(Array.isArray(data) ? data.length : 0);
    }).catch(() => {});
    api
      .get<{ count: number }>("/api/v1/audit-logs?sinceMinutes=1440")
      .then((data) => setAuditCount(data.count))
      .catch(() => {});
  }, []);

  return (
    <div>
      <h2>仪表盘</h2>
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic title="机器总数" value={serverCount} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="24h 操作数" value={auditCount} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="在线 session" value={0} suffix="(未实现)" />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
