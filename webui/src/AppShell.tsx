import type { ReactNode } from "react";

interface AppShellProps {
  children: ReactNode;
}

const AppShell = ({ children }: AppShellProps) => {
  return (
    <div className="app-shell" style={{ display: "flex", height: "100%" }}>
      {children}
    </div>
  );
};

export { AppShell };
