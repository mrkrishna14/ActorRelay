import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import "./themes.css";

export const metadata: Metadata = {
  title: "ActorRelay — Plant workspace",
  description: "A connected workspace for simulated plants, equipment agents, and evidence-backed operating changes.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-theme="light" className={`${GeistSans.variable} ${GeistMono.variable}`}><body>{children}</body></html>;
}
