import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const geistMono = Geist_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Digital Home Platform',
  description: 'The operating system for your digital presence.',
  robots: 'noindex, nofollow',
};

// Runs before paint: applies the persisted theme (default dark) to <html>
// so there is no flash of the wrong theme.
//
// Manages BOTH classes on purpose. Upstream only toggles `dark`, which is
// enough for its own `html:not(.dark)` rules — but the Envisioned Winter
// palette in globals.css is keyed on `html.light`, and without the class
// being added those overrides never fire and light mode falls back to
// upstream's generic white/zinc.
const THEME_SCRIPT = `try{var l=localStorage.getItem("dh-theme")==="light",r=document.documentElement;r.classList.toggle("dark",!l);r.classList.toggle("light",l)}catch(e){document.documentElement.classList.add("dark")}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("dark", "font-sans", geist.variable)}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      {/* text-minimal-accent, not text-white: the token remaps per theme, so
          body copy stays readable in light mode. */}
      <body className={`${geist.variable} ${geistMono.variable} bg-minimal-bg text-minimal-accent font-sans h-screen w-screen overflow-hidden flex antialiased`}>
        <Sidebar />
        <main className="flex-1 flex flex-col h-full overflow-hidden">
          {children}
        </main>
      </body>
    </html>
  );
}
