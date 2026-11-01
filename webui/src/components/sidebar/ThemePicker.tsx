import React, { useEffect, useState } from "react";
import { SunMoon, Sun, Moon, type LucideIcon } from "lucide-react";

const THEMES: [string, LucideIcon][] = [
  ["auto", SunMoon],
  ["light", Sun],
  ["dark", Moon],
];

const ThemePicker = () => {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("theme") || "auto",
  );

  // Apply + persist theme. 'auto' follows the OS (falls back to light if unavailable).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  return (
    <div className="app-theme-picker" role="radiogroup" aria-label="Theme">
      {THEMES.map(([t, Icon]) => (
        <button
          key={t}
          onClick={() => setTheme(t)}
          title={`${t} theme`}
          role="radio"
          aria-checked={theme === t}
          className={theme === t ? "is-active" : ""}
        >
          <Icon size={14} aria-hidden="true" />
          <span>{t}</span>
        </button>
      ))}
    </div>
  );
};

export { ThemePicker };
