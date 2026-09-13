import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentWorld",
  description: "A small 2D city where agents live on their own.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
