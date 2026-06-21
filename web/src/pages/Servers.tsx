import { Table, Button, Space, Modal, Form, Input, message, Popconfirm, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
}

export default function Servers() {
  const [data, setData] = useState<Server[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Server | null>(null);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const list = await api.get<Server[]>("/api/v1/servers");
      setData(list);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const onEdit = (s: Server) => {
    setEditing(s);
    form.setFieldsValue(s);
    setModalOpen(true);
  };

  const onDelete = async (s: Server) => {
    try {
      await api.delete(`/api/v1/servers/${s.id}`);
      message.success("已删除");
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const onSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (editing) {
        await api.put(`/api/v1/servers/${editing.id}`, values);
        message.success("已更新");
      } else {
        await api.post("/api/v1/servers", values);
        message.success("已创建");
      }
      setModalOpen(false);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns = [
    { title: "名称", dataIndex: "name", render: (n: string, r: Server) => <Link to={`/servers/${r.id}`}>{n}</Link> },
    { title: "Host", dataIndex: "host" },
    { title: "端口", dataIndex: "port" },
    { title: "用户", dataIndex: "username" },
    {
      title: "分组",
      dataIndex: "group",
      render: (g: string | null) => (g ? <Tag>{g}</Tag> : "-"),
    },
    {
      title: "Tags",
      dataIndex: "tags",
      render: (tags: string[]) => (tags || []).map((t) => <Tag key={t}>{t}</Tag>),
    },
    { title: "Transport", dataIndex: "transportMode" },
    {
      title: "操作",
      render: (_: any, r: Server) => (
        <Space>
          <Button size="small" onClick={() => onEdit(r)}>
            编辑
          </Button>
          <Popconfirm title="确定删除?" onConfirm={() => onDelete(r)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2>服务器</h2>
        <Button type="primary" onClick={onCreate}>
          新建服务器
        </Button>
      </div>
      <Table
        rowKey="id"
        dataSource={data}
        columns={columns}
        loading={loading}
        pagination={{ pageSize: 20 }}
      />
      <Modal
        title={editing ? "编辑服务器" : "新建服务器"}
        open={modalOpen}
        onOk={onSubmit}
        onCancel={() => setModalOpen(false)}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Host" name="host" rules={[{ required: true }]}>
            <Input placeholder="192.168.1.10" />
          </Form.Item>
          <Form.Item label="端口" name="port" initialValue={22}>
            <Input type="number" />
          </Form.Item>
          <Form.Item label="用户名" name="username" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="密码" name="password">
            <Input.Password placeholder={editing ? "留空保持原密码" : ""} />
          </Form.Item>
          <Form.Item label="分组" name="group">
            <Input placeholder="production / staging" />
          </Form.Item>
          <Form.Item label="Tags (逗号分隔)" name="tags">
            <Input placeholder="web, db" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
