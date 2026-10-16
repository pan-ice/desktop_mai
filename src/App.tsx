import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  AudioLines,
  Bell,
  ChevronRight,
  Coffee,
  Home,
  MessageCircle,
  Moon,
  PawPrint,
  Plug,
  ScanEye,
  Settings2,
  Sparkles,
  Volume2,
} from "lucide-react";
import { api, perform, useSnapshot } from "./api";
import { Avatar } from "./components/Avatar";
import { Panel, Status, Toasts } from "./components/ui";
import { ChatPage } from "./pages/ChatPage";
import { ModelsPage } from "./pages/ModelsPage";
import { SensesPage } from "./pages/SensesPage";
import { CorePage } from "./pages/CorePage";
import { SettingsPage } from "./pages/SettingsPage";
import type { Page, Snapshot } from "../shared/types";

const navigation = [
  { id: "home", name: "此刻", icon: Home, note: "HOME" },
  { id: "chat", name: "和麦麦聊聊", icon: MessageCircle, note: "CHAT" },
  { id: "models", name: "角色衣橱", icon: PawPrint, note: "AVATAR" },
  { id: "senses", name: "声音与感知", icon: AudioLines, note: "SENSES" },
  { id: "core", name: "连接与账号", icon: Plug, note: "ACCOUNT" },
  { id: "settings", name: "偏好设置", icon: Settings2, note: "SETTINGS" },
] as const;

export function App() {
  const state = useSnapshot();
  const [page, setPage] = useState<Page>("home");
  const [logs, setLogs] = useState(false);
  useEffect(() => api.onNavigate(setPage), []);
  const selected = navigation.find((item) => item.id === page)!;
  return (
    <div
      className={`app-shell ${state.settings.reducedMotion ? "reduce-motion" : ""}`}
    >
      <aside className="sidebar">
        <a
          className="brand"
          href="#home"
          onClick={(event) => {
            event.preventDefault();
            setPage("home");
          }}
          aria-label="Mai 首页"
        >
          <span className="brand-mark">
            <PawPrint size={25} strokeWidth={1.6} />
          </span>
          <span>
            mai<span className="brand-dot">.</span>
            <small>你的桌面伙伴</small>
          </span>
        </a>
        <div className="sidebar-caption">一小片属于你们的空间</div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "selected" : ""}`}
              onClick={() => setPage(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={19} strokeWidth={1.65} />
              <span>{item.name}</span>
              {page === item.id && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="note-doodle">
            <Sparkles size={21} />
          </span>
          <p>
            不用很特别的事，
            <br />
            在一起就很好。
          </p>
          <span className="note-line" />
        </div>
        <button className="sidebar-core" onClick={() => setPage("core")}>
          <div className="core-icon">
            <Plug size={19} />
          </div>
          <span>
            <strong>MaiBot 内核</strong>
            <small>
              {state.connection.phase === "connected"
                ? "已连接 · 记忆持续生长中"
                : "等待你的麦麦上线"}
            </small>
          </span>
          <span
            className={`tiny-light ${state.connection.phase === "connected" ? "green" : ""}`}
          />
        </button>
        <div className="sidebar-footer">
          <span className="tiny-light green" /> 本地陪伴，安心留存{" "}
          <span>v{state.version}</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            陪伴空间
            <ChevronRight size={13} />
            <strong>{selected.name}</strong>
          </div>
          <div className="topbar-actions">
            <span className="local-tag">LOCAL COMPANION</span>
            <button
              className="text-button summon"
              onClick={() => {
                void perform(
                  () => api.showPet(),
                  "桌宠已召回；Ctrl + Shift + M 也可以找到它",
                );
              }}
            >
              <PawPrint size={16} />
              召回桌宠
            </button>
            <button
              className={`icon-button ${logs ? "active" : ""}`}
              aria-label="运行动态"
              title="运行动态"
              onClick={() => setLogs(!logs)}
            >
              <Bell size={18} />
              {state.activity.some((item) => item.level === "error") && (
                <i className="notification-dot" />
              )}
            </button>
            <button
              className="user-avatar"
              title="偏好设置"
              aria-label="打开偏好设置"
              onClick={() => setPage("settings")}
            >
              {state.settings.userName.slice(0, 1)}
            </button>
          </div>
        </header>
        {logs && (
          <div className="activity-popover">
            <h3>最近的动态</h3>
            {state.activity.length ? (
              state.activity.slice(0, 8).map((item) => (
                <div key={item.id} className={item.level}>
                  <time>
                    {new Date(item.timestamp).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <span>{item.text}</span>
                </div>
              ))
            ) : (
              <p>还没有运行动态。连接 MaiBot 后会在这里显示。</p>
            )}
          </div>
        )}
        <main className={`main-content page-${page}`}>
          {page === "home" && <HomePage state={state} navigate={setPage} />}
          {page === "chat" && <ChatPage state={state} navigate={setPage} />}
          {page === "models" && <ModelsPage state={state} />}
          {page === "senses" && <SensesPage state={state} />}
          {page === "core" && <CorePage state={state} />}
          {page === "settings" && <SettingsPage state={state} />}
        </main>
        <footer className="workspace-footer">
          <span>MAI DESKTOP COMPANION</span>
          <span>
            让陪伴，发生在每个日常里。
            <PawPrint size={12} />
          </span>
        </footer>
      </div>
      <Toasts />
    </div>
  );
}

function HomePage({
  state,
  navigate,
}: {
  state: Snapshot;
  navigate: (page: Page) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const hour = new Date(now).getHours();
  const greeting =
    hour < 6
      ? "夜深了"
      : hour < 11
        ? "早上好"
        : hour < 14
          ? "中午好"
          : hour < 18
            ? "下午好"
            : "晚上好";
  const model = state.models.find(
    (item) => item.id === state.settings.activeModelId,
  );
  const today = new Date(now).toDateString();
  const dailyMessages = state.history.filter(
    (message) =>
      message.role !== "system" &&
      new Date(message.timestamp).toDateString() === today,
  );
  const lastReply = state.history.findLast(
    (message) => message.role === "assistant",
  );
  const remaining = state.focusUntil
    ? Math.max(0, Math.ceil((state.focusUntil - now) / 1000))
    : 0;
  return (
    <>
      <div className="page-heading home-heading">
        <div>
          <div className="eyebrow">
            <span /> LITTLE MOMENTS, TOGETHER
          </div>
          <h1>
            {greeting}，{state.settings.userName}{" "}
            <span className="greeting-flower">✳</span>
          </h1>
          <p>把平凡的日子，过得可爱一点。</p>
        </div>
        <span className="date-label">
          {new Date(now).toLocaleDateString("zh-CN", {
            month: "long",
            day: "numeric",
            weekday: "long",
          })}
        </span>
      </div>
      <div className="home-grid">
        <section className="companion-stage">
          <div className="stage-top">
            <span className="stage-label">
              <span className="tiny-light green" /> 你的桌面小伙伴
            </span>
            <button className="text-button" onClick={() => navigate("models")}>
              更换角色
              <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="stage-spark s1">✧</div>
          <div className="stage-spark s2">✳</div>
          <div className="stage-dot d1" />
          <div className="stage-dot d2" />
          <div className="stage-orbit orbit-one" />
          <div className="stage-orbit orbit-two" />
          <div
            className="stage-avatar"
            onDoubleClick={() => {
              void perform(() => api.setMood("happy"));
            }}
          >
            <Avatar
              model={model}
              mood={state.mood}
              reducedMotion={state.settings.reducedMotion}
            />
          </div>
          <div className="stage-name">
            <h2>
              {state.settings.nickname}
              <span>
                {state.focusUntil
                  ? "专注陪伴中"
                  : state.mood === "thinking"
                    ? "正在思考"
                    : state.connection.phase === "connected"
                      ? "在这里，陪着你"
                      : "准备好陪伴你"}
              </span>
            </h2>
            <p>
              {model
                ? `${model.kind.toUpperCase()} · ${model.name}`
                : "简笔占位角色 · 可以导入你喜欢的模型"}
            </p>
          </div>
          <div className="stage-bottom">
            <Status state={state} small />
            <button
              className="icon-button"
              title="显示桌宠"
              aria-label="显示桌宠"
              onClick={() => {
                void perform(() => api.showPet());
              }}
            >
              <ArrowUpRight size={17} />
            </button>
          </div>
        </section>
        <div className="home-side">
          <div className="section-kicker">
            现在，想做点什么？<span>MAKE YOURSELF AT HOME</span>
          </div>
          <button
            className="quick-card quick-chat"
            onClick={() => navigate("chat")}
          >
            <span className="quick-icon">
              <MessageCircle size={24} strokeWidth={1.6} />
            </span>
            <div>
              <h3>聊一会儿</h3>
              <p>今天发生了什么，都可以告诉我。</p>
            </div>
            <ArrowUpRight size={19} />
          </button>
          <button
            className="quick-card quick-screen"
            onClick={() => navigate("senses")}
          >
            <span className="quick-icon">
              <ScanEye size={24} strokeWidth={1.6} />
            </span>
            <div>
              <h3>一起看看你的世界</h3>
              <p>分享屏幕，让陪伴多一点默契。</p>
            </div>
            <ArrowUpRight size={19} />
          </button>
          <button
            className={`focus-card ${remaining ? "focusing" : ""}`}
            onClick={() => {
              void perform(() => api.focus(remaining ? 0 : 25));
            }}
          >
            <div className="focus-top">
              <span>
                <Coffee size={18} />
                安静陪伴
              </span>
              <span className="focus-pill">
                {remaining ? "点击结束" : "25 MIN"}
              </span>
            </div>
            <div className="focus-bottom">
              <div>
                <h3>
                  {remaining
                    ? `${String(Math.floor(remaining / 60)).padStart(2, "0")} : ${String(remaining % 60).padStart(2, "0")}`
                    : "你专注，我陪你。"}
                </h3>
                <p>
                  {remaining
                    ? "暂时放下聊天，好好做眼前的事。"
                    : "开启一段不被打扰的专注时光。"}
                </p>
              </div>
              <span className="focus-circle">
                {remaining ? <Moon size={19} /> : <ChevronRight size={20} />}
              </span>
            </div>
          </button>
        </div>
      </div>
      <div className="home-lower">
        <Panel
          title="陪伴的小记录"
          subtitle="每一次交流，都让我们更熟悉一点。"
          className="moments-panel"
          action={
            <button className="text-button" onClick={() => navigate("chat")}>
              全部对话
              <ChevronRight size={14} />
            </button>
          }
        >
          {lastReply ? (
            <button className="last-message" onClick={() => navigate("chat")}>
              <span className="message-avatar">
                <PawPrint size={20} />
              </span>
              <div>
                <strong>
                  {state.settings.nickname}
                  <time>
                    {new Date(lastReply.timestamp).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </strong>
                <p>{lastReply.text || "发来了一条多媒体消息"}</p>
              </div>
            </button>
          ) : (
            <div className="first-moment">
              <span className="moment-scribble">
                <MessageCircle size={28} strokeWidth={1.2} />
              </span>
              <div>
                <strong>我们的故事，从第一句你好开始。</strong>
                <p>连接 MaiBot，来一场只属于你们的对话。</p>
              </div>
              <button
                className="round-arrow"
                aria-label="开始连接"
                onClick={() => navigate("core")}
              >
                <ArrowUpRight size={18} />
              </button>
            </div>
          )}
          <div className="moment-stats">
            <span>
              <strong>{dailyMessages.length}</strong>今天的交流
            </span>
            <span>
              <strong>{state.models.length}</strong>衣橱中的角色
            </span>
            <span>
              <span className="tiny-light green" />
              {state.settings.serverAccountId
                ? "聊天记录随账号同步"
                : "聊天记录保存在本机"}
            </span>
          </div>
        </Panel>
        <Panel className="little-note">
          <div className="little-note-top">
            <Sparkles size={18} />
            <span>A LITTLE NOTE</span>
          </div>
          <h3>让麦麦，更像麦麦。</h3>
          <p>
            人格、记忆与思考都来自 MaiBot。
            <br />
            在熟悉的内核里，慢慢认识彼此。
          </p>
          <button className="text-button" onClick={() => navigate("core")}>
            管理桌宠账号
            <ArrowUpRight size={15} />
          </button>
          <span className="note-paw">
            <PawPrint size={45} strokeWidth={1.1} />
          </span>
        </Panel>
      </div>
      {!state.desktop && (
        <div className="preview-notice">
          当前为浏览器预览。运行 <code>npm run dev</code>{" "}
          可使用透明桌宠、语音、截图与内核连接。
        </div>
      )}
    </>
  );
}
