import { Button, Form, Input, Modal, Select, Space, Table, Tag, message } from "antd";
import { useState } from "react";
import { api } from "../api/client";

export default function Operators() {
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const onCreate = () => {
    form.resetFields();
    setCreatedKey(null);
    setModalOpen(true);
  };

  const onSubmit = async () => {
    const values = await form.validateFields();
    try {
      const res = await api.post<{
        operator: any;
        plainCredential: string;
      }>("/api/v1/operators", {
        ...values,
        scopes: values.scopes || ["read"],
      });
      setCreatedKey(res.plainCredential);
      message.success("已创建,API key 仅显示一次,请妥善保存");
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2>操作者管理</h2>
        <Button type="primary" onClick={onCreate}>
          新建 Agent
        </Button>
      </div>
      <p style={{ color: "#666" }}>
        创建 Agent 后,返回的 API key 仅在创建时显示一次。Agent 通过该 key 调用 API(Authorization: Bearer sk-xxx)。
      </p>
      <Modal
        title="新建 Agent"
        open={modalOpen}
        onOk={createdKey ? () => setModalOpen(false) : onSubmit}
        onCancel={() => setModalOpen(false)}
        okText={createdKey ? "完成" : "创建"}
      >
        {createdKey ? (
          <div>
            <p>API Key(请复制并妥善保存):</p>
            <Input.TextArea
              rows={3}
              value={createdKey}
              readOnly
              onFocus={(e) => e.target.select()}
            />
          </div>
        ) : (
          <Form form={form} layout="vertical" initialValues={{ scopes: ["read"] }}>
            <Form.Item label="类型" name="type" initialValue="agent">
              <Select
                options={[
                  { value: "agent", label: "Agent" },
                  { value: "human", label: "Human" },
                ]}
              />
            </Form.Item>
            <Form.Item label="名称" name="name" rules={[{ required: true }]}>
              <Input placeholder="claude-laptop-01" />
            </Form.Item>
            <Form.Item label="Scopes" name="scopes">
              <Select
                mode="multiple"
                options={[
                  { value: "read", label: "read" },
                  { value: "write", label: "write" },
                  { value: "admin", label: "admin" },
                ]}
              />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
}
