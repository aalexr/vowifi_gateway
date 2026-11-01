import type { ReactNode } from "react";

interface SideBarProps {
  children: ReactNode;
}

const SideBar = ({ children }: SideBarProps) => {
  return <aside className="app-sidebar">{children}</aside>;
};

export { SideBar };
