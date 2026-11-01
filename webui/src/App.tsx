import { useEffect, useState, useRef, type ReactNode, useMemo } from "react";
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

interface Nav {
  key: string;
  label: string;
  icon: LucideIcon;
  alwaysAvailable: boolean;
}

// [key, label, icon, alwaysAvailable] — views not marked alwaysAvailable are disabled
// while no PC/SC reader is connected (they all operate on a physical SIM line).
const NAV: Nav[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    alwaysAvailable: true,
  },
  { key: "softphone", label: "Softphone", icon: Phone, alwaysAvailable: false },
  {
    key: "messages",
    label: "Messages",
    icon: MessageSquare,
    alwaysAvailable: false,
  },
  { key: "sims", label: "SIM Config", icon: Cpu, alwaysAvailable: false },
  { key: "esim", label: "eSIM", icon: Smartphone, alwaysAvailable: false },
  {
    key: "settings",
    label: "Settings",
    icon: SettingsIcon,
    alwaysAvailable: true,
  },
  { key: "logs", label: "Logs", icon: ScrollText, alwaysAvailable: true },
];

export default function App() {
  const [view, setView] = useState("dashboard");
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
  // Dashboard / Settings / Logs and bounce back to the dashboard if needed.
  const noReaders = useMemo(
    () => cardsKnown && cards.length === 0,
    [cardsKnown, cards],
  );
  useEffect(() => {
    if (noReaders && !NAV.find(({ key }) => key === view)?.alwaysAvailable) {
      setView("dashboard");
    }
  }, [noReaders, view]);

  const sel = instances.find((i) => String(i.id) === String(selected));

  const View = {
    dashboard: Dashboard,
    softphone: Softphone,
    messages: Messages,
    sims: SimConfig,
    esim: Esim,
    settings: Settings,
    logs: Logs,
  }[view];

  return (
    <AppShell>
      <SideBar>
        <AppBrand />
        {NAV.map(({ key: k, label, icon: Icon, alwaysAvailable: always }) => {
          const disabled = noReaders && !always;
          return (
            <button
              className={`app-nav-button${view === k ? " is-active" : ""}`}
              key={k}
              onClick={() => !disabled && setView(k)}
              disabled={disabled}
              title={
                disabled
                  ? "No PC/SC reader detected — connect a card reader to enable"
                  : undefined
              }
            >
              <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
              <span className="app-nav-label">{label}</span>
            </button>
          );
        })}
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
        <div
          className="app-header"
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 16,
            gap: 16,
            flexShrink: 0,
            padding: "24px 24px 0",
          }}
        >
          <h1 className="app-title">
            {NAV.find(({ key }) => key === view)?.label}
          </h1>
          {/* per-page SIM selectors (SimSelector) handle multi-SIM switching on the views that
              operate on a single line — softphone / messages / logs / SIM config */}
        </div>
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
            padding: "6px 24px 24px",
          }}
        >
          {View && (
            <View
              instances={instances}
              cards={cards}
              noReaders={noReaders}
              cardsKnown={cardsKnown}
              selected={sel}
              setSelected={setSelected}
              refresh={refresh}
              subscribe={subscribe}
              showToast={showToast}
              setView={setView}
            />
          )}
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
