import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Motion Mirror — iPhone Motion Capture",
  description: "Private, real-time markerless body tracking and 3D model preview.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
