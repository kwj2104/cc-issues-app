import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Code · Issue Tracker",
  description: "Internal tracker for the anthropics/claude-code issue backlog.",
};

// Explicit rather than relying on the framework default — the app is a fixed-height shell,
// so a wrong initial scale on a phone is not recoverable by scrolling.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Set the theme before first paint to avoid a flash (mirrors the mockup's light default).
const themeInit = `(function(){try{var t=localStorage.getItem('cc-theme')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

// suppressHydrationWarning on <html>: the script above stamps data-theme before React
// hydrates, which is exactly the attribute mismatch the warning is for.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
