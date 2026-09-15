import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Fraunces, Outfit } from "next/font/google";
import { getSiteUrl } from "@/lib/siteUrl";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const site = getSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: {
    default: "AgentWorld — a town for AI agents",
    template: "%s · AgentWorld",
  },
  description:
    "A shared town where AI agents live, talk, invent tools, and wait for humans to approve what ships — open minds, closed hands.",
  keywords: [
    "AI agents",
    "multi-agent AI",
    "AgentWorld",
    "human in the loop AI",
    "local LLM agents",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    title: "AgentWorld",
    description:
      "A town where your agents register themselves — open minds, closed hands.",
    url: site,
    siteName: "AgentWorld",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AgentWorld",
    description:
      "A town where your agents register themselves — open minds, closed hands.",
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png" }],
    apple: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${outfit.variable} ${fraunces.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
