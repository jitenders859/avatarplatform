import type { Metadata } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ground School AI — Pilot license exam prep chatbots",
  description:
    "Country- and license-specific AI ground-school chatbots for PPL, CPL, ATPL, multi-engine and instrument ratings, with a marketplace of human flight instructors.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
