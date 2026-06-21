import { Table, Select, Input, Button, Space } from "antd";
import { useEffect, useState } from "react";
import { api } from "../api/client";

interface AuditLog {
  id: string;
  operatorId: string | null;
  operatorType: string;
  serverId: string | null;
  action: string;
  status: string;
  input: any;
  output: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: number;
}

export default function Audit() {
  const [data, setData] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [sinceMinutes, setSinceMinutes] = useState(60);

  const load = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (action) qs.set("action", action);
      if (status) qs.set("status", status);
      qs.set("sinceMinutes", String(sinceMinutes));
      qs.set("limit", "100");
      const res = await api.get<{ count: number; logs: AuditLog[] }>(
        `/api/v1/audit-logs?${qs.toString()}`,
      );
      setData(res.logs);
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns = [
    {
      title: "时间",
      dataIndex: "createdAt",
      render: (t: number) => new Date(t).toLocaleString(),
    },
    { title: "操作者", dataIndex: "operatorId" },
    { title: "类型", dataIndex: "operatorType" },
    { title: "动作", dataIndex: "action" },
    { title: "状态", dataIndex: "status" },
    { title: "退出码", dataIndex: "exitCode" },
    { title: "耗时(ms)", dataIndex: "durationMs" },
    { title: "错误", dataIndex: "errorMessage", ellipsis: true },
  ];

  return (
    <div>
      <h2>审计中心</h2>
      <Space style={{ marginBottom: 16 }}>
        <Select
          allowClear
          placeholder="动作"
          style={{ width: 160 }}
          value={action}
          onChange={setAction}
          options={[
            { value: "execute_command", label: "execute_command" },
            { value: "batch_execute_command", label: "batch_execute_command" },
            { value: "get_server_status", label: "get_server_status" },
            { value: "search_files", label: "search_files" },
          ]}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 120 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: "success", label: "success" },
            { value: "failed", label: "failed" },
            { value: "denied", label: "denied" },
            { value: "cancelled", label: "cancelled" },
          ]}
        />
        <Input
          type="number"
          style={{ width: 120 }}
          value={sinceMinutes}
          onChange={(e) => setSinceMinutes(Number(e.target.value))}
          addonAfter="分钟"
        />
        <Button type="primary" onClick={load}>
          查询
        </Button>
      </Space>
      <Table
        rowKey="id"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={{ pageSize: 20 }}
        size="small"
      />
    </div>
  );
}
