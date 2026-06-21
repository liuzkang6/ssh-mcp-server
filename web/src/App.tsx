import { Routes, Route, Navigate, useNavigate, useLocation, Link } from "react-router-dom";
import { Layout, Menu, Button, Space, message } from "antd";
import { useEffect, useState } from "react";
import { api, setToken, getToken } from "./api/client";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Servers from "./pages/Servers";
import ServerDetail from "./pages/ServerDetail";
import Audit from "./pages/Audit";
import Operators from "./pages/Operators";

const { Header, Sider, Content } = Layout;

interface Whoami {
  id: string;
  name: string;
  type: string;
  scopes: string[];
}

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Whoami | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const token = getToken();
    if (!token) {
      navigate("/login");
      return;
    }
    api
      .get<Whoami>("/api/v1/auth/whoami")
      .then((data) => {
        setMe(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [navigate]);

  if (loading) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }
  if (!me) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  const items = [
    { key: "/", label: <Link to="/">仪表盘</Link> },
    { key: "/servers", label: <Link to="/servers">服务器</Link> },
    { key: "/audit", label: <Link to="/audit">审计</Link> },
    { key: "/operators", label: <Link to="/operators">操作者</Link> },
  ];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider>
        <div
          style={{
            color: "white",
            padding: 16,
            fontSize: 18,
            fontWeight: "bold",
          }}
        >
          🛠 SSH MCP
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[location.pathname]}>
          {items.map((it) => (
            <Menu.Item key={it.key}>{it.label}</Menu.Item>
          ))}
        </Menu>
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "0 24px",
          }}
        >
          <div>DevOps 中台</div>
          <Space>
            <span>
              {me.name} ({me.type})
            </span>
            <Button
              size="small"
              onClick={() => {
                setToken(null);
                message.success("已退出");
                navigate("/login");
              }}
            >
              退出
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: 24, padding: 24, background: "#fff" }}>
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedLayout>
            <Dashboard />
          </ProtectedLayout>
        }
      />
      <Route
        path="/servers"
        element={
          <ProtectedLayout>
            <Servers />
          </ProtectedLayout>
        }
      />
      <Route
        path="/servers/:id"
        element={
          <ProtectedLayout>
            <ServerDetail />
          </ProtectedLayout>
        }
      />
      <Route
        path="/audit"
        element={
          <ProtectedLayout>
            <Audit />
          </ProtectedLayout>
        }
      />
      <Route
        path="/operators"
        element={
          <ProtectedLayout>
            <Operators />
          </ProtectedLayout>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
