import "./globals.css";
import { PRE_PAINT } from "@/lib/theme";

/* Inter is self-hosted from app/fonts (latin + latin-ext so ₹ renders). IBM
   Plex Sans is only used by the "dense" theme; loading it is cheap and avoids
   a flash when someone switches. */
export const metadata = {
  title: { default: process.env.NEXT_PUBLIC_APP_NAME || "KRA KPI", template: `%s · ${process.env.NEXT_PUBLIC_APP_NAME || "KRA KPI"}` },
  description: "Tasks, workdays and client sign-offs for the whole team.",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/brand/favicon.png", sizes: "64x64", type: "image/png" },
      { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/brand/apple-icon.png",
  },
};

export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#1E40AF" };

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
