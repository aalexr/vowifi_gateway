import {
  useState,
  useRef,
  type ComponentType,
  type ReactNode,
  useMemo,
} from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { ThemePicker } from "./components/sidebar/ThemePicker";
import { SideBar } from "./components/sidebar/SideBar";
import {
  Dashboard,
  Softphone,
  Messages,
  SimConfig,
  Settings,
  Logs,
  Esim,
} from "./views";
import {
  LayoutDashboard,
  Phone,
  MessageSquare,
  Cpu,
  Smartphone,
  Settings as SettingsIcon,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { AppShell } from "./AppShell";
import { AppBrand } from "./components/sidebar/AppBrand";
import { useLiveUpdates } from "./useLiveUpdates";
import type { CommonViewProps } from "./views/common-view-props";
import { InstanceId } from "./api";
import { Handler } from "./types";

interface Nav {
  path: string;
  label: string;
  icon: LucideIcon;
  view: ComponentType<any>;
  alwaysAvailable: boolean;
}

// Views not marked alwaysAvailable are disabled while no PC/SC reader is connected
// (they all operate on a physical SIM line).
const navigation: Nav[] = [
  {
    path: "/",
    label: "Dashboard",
    icon: LayoutDashboard,
    view: Dashboard,
    alwaysAvailable: true,
  },
  {
    path: "/softphone",
    label: "Softphone",
    icon: Phone,
    view: Softphone,
    alwaysAvailable: false,
  },
  {
    path: "/messages",
    label: "Messages",
    icon: MessageSquare,
    view: Messages,
    alwaysAvailable: false,
  },
  {
    path: "/sims",
    label: "SIM Config",
    icon: Cpu,
    view: SimConfig,
    alwaysAvailable: false,
  },
  {
    path: "/esim",
    label: "eSIM",
    icon: Smartphone,
    view: Esim,
    alwaysAvailable: false,
  },
  {
    path: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    view: Settings,
    alwaysAvailable: true,
  },
  {
    path: "/logs",
    label: "Logs",
    icon: ScrollText,
    view: Logs,
    alwaysAvailable: true,
  },
];

export default function App() {
  const [toast, setToast] = useState<ReactNode | null>(null);

  const toastTimer = useRef<number | null>(null);
  const showToast = (m: ReactNode) => {
    if (toastTimer.current) {
      // an older toast's timer must not clear this one
      clearTimeout(toastTimer.current);
    }
    setToast(m);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  const {
    instances,
    cards,
    cardsKnown,
    selected,
    setSelected,
    refresh,
    subscribe,
  } = useLiveUpdates(showToast);

  // No PC/SC reader connected at all -> SIM-bound views are unusable; keep only
  // Dashboard / Settings / Logs (their routes redirect to the dashboard).
  const noReaders = useMemo(
    () => cardsKnown && cards.length === 0,
    [cardsKnown, cards],
  );

  const selectedConfig = useMemo(
    () => instances.find((i) => i.id === selected),
    [instances, selected],
  );

  const viewProps: CommonViewProps = {
    instances,
    cards,
    noReaders,
    cardsKnown,
    selected: selectedConfig,
    setSelected,
    refresh,
    subscribe,
    showToast,
  };

  return (
    <AppShell>
      <SideBar>
        <AppBrand />
        {navigation.map(
          ({ path, label, icon: Icon, alwaysAvailable: always }) => {
            const disabled = noReaders && !always;
            if (disabled) {
              return (
                <button
                  className="app-nav-button"
                  key={path}
                  disabled
                  title="No PC/SC reader detected — connect a card reader to enable"
                >
                  <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
                  <span className="app-nav-label">{label}</span>
                </button>
              );
            }
            return (
              <NavLink
                className={({ isActive }) =>
                  `app-nav-button${isActive ? " is-active" : ""}`
                }
                key={path}
                to={path}
                end
              >
                <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
                <span className="app-nav-label">{label}</span>
              </NavLink>
            );
          },
        )}
        <ThemePicker />
        <div className="app-instance-count">
          {instances.length} SIM{instances.length !== 1 ? "s" : ""} configured
        </div>
      </SideBar>

      <main
        className="app-main"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Single bounded scroll region. Document-flow views (Dashboard/Settings/Logs) scroll
            here; app-like views (Messages/Softphone) fill it with height:100% and scroll their
            own inner lists instead, so the page height never grows with list length. The
            padding also gives card outlines/shadows room so overflow:auto doesn't clip them
            (e.g. the Dashboard active-reader ring on the top/left edge). */}
        <div
          className="app-content"
          style={{
            flex: 1,
            minHeight: 0,
            overflowX: "hidden",
            overflowY: "auto",
            padding: "24px",
          }}
        >
          <Routes>
            <Route
              path="/dashboard"
              element={
                <Dashboard
                  instances={instances}
                  cards={cards}
                  noReaders={noReaders}
                  cardsKnown={cardsKnown}
                  setSelected={setSelected}
                  refresh={refresh}
                  subscribe={subscribe}
                  showToast={showToast}
                />
              }
            />
            <Route
              path="/softphone"
              element={
                <Softphone
                  instances={instances}
                  cards={cards}
                  noReaders={noReaders}
                  cardsKnown={cardsKnown}
                  setSelected={setSelected}
                  refresh={refresh}
                  subscribe={subscribe}
                  showToast={showToast}
                />
              }
            />
            <Route
              path="/messages"
              element={
                <Messages
                  selected={selectedConfig}
                  instances={instances}
                  cards={cards}
                  setSelected={setSelected}
                  subscribe={subscribe}
                  showToast={showToast}
                  noReaders={noReaders}
                  cardsKnown={cardsKnown}
                  refresh={refresh}
                />
              }
            />
            <Route
              path="/sims"
              element={
                <SimConfig
                  selected={selectedConfig}
                  instances={instances}
                  cards={cards}
                  setSelected={setSelected}
                  refresh={refresh}
                />
              }
            />
            <Route
              path="/esim"
              element={
                <Esim
                  selected={selectedConfig}
                  instances={instances}
                  cards={cards}
                  setSelected={setSelected}
                  subscribe={subscribe}
                  showToast={showToast}
                  noReaders={noReaders}
                  cardsKnown={cardsKnown}
                  refresh={refresh}
                />
              }
            />
            <Route path="/settings" element={<Settings />} />
            <Route path="/logs" element={<Logs {...viewProps} />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </div>
      </main>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </AppShell>
  );
}
