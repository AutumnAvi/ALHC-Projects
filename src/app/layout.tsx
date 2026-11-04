import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ConfirmProvider } from "@/components/confirm";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "ALHC Projects", template: "%s · ALHC Projects" },
  description: "Projects, sections, and tasks for the ALHC team.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="h-full font-sans">
        {/* The in-app confirm / alert modal (useConfirm, useAlert): browser dialogs are lint-blocked. */}
        <ConfirmProvider>{children}</ConfirmProvider>
        {/* Nov 4 notes (batch 21): Vercel Speed Insights (real-user page timings). It sends nothing until
            Speed Insights is turned on for the project in the Vercel dashboard. */}
        <SpeedInsights />
      </body>
    </html>
  );
}
