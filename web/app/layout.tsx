import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "ActorRelay | Operations", description: "Equipment negotiation and simulated plant operations" };
export default function RootLayout({children}: {children: React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
