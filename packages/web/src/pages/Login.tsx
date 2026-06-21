import { Form, Input, Button, message } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken, getApiBase, setApiBase } from "../api/client";

export default function Login() {
  const [loading, setLoading] = useState(false);
  const [apiBase, setApiBaseState] = useState(getApiBase());
  const navigate = useNavigate();

  const onFinish = async (values: { name: string; password: string }) => {
    setLoading(true);
    try {
      const data = await api.post<{ token: string }>("/api/v1/auth/login", {
        name: values.name,
        password: values.password,
      });
      setToken(data.token);
      message.success("登录成功");
      navigate("/");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h2 style={{ textAlign: "center", marginTop: 0 }}>🛠 SSH MCP 中台</h2>
        <Form layout="vertical" onFinish={onFinish} initialValues={{ name: "admin" }}>
          <Form.Item label="API Base" tooltip="留空使用相对路径(走同源)">
            <Input
              value={apiBase}
              onChange={(e) => {
                setApiBaseState(e.target.value);
                setApiBase(e.target.value);
              }}
              placeholder="http://localhost:3000"
            />
          </Form.Item>
          <Form.Item label="用户名" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              登录
            </Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  );
}
