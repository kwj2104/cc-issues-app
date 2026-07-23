import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Code · Issue Tracker",
  description: "Internal tracker for the anthropics/claude-code issue backlog.",
};

// Set the theme before first paint to avoid a flash (mirrors the mockup's light default).
const themeInit = `(function(){try{var t=localStorage.getItem('cc-theme')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
