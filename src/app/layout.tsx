import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Omegle For Your College",
  description:
    "A polished campus-only matching concept with college verification, language filters, anonymous chat, and mutual reveal flows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full scroll-smooth antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
