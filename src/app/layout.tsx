import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import elkoMark from "../../public/elko-mark.png";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Payment Lead Matcher",
  description: "Match Stripe and Square payments to your leads.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="px-6 pt-6 pb-2 sm:px-8">
          <Link href="/" className="inline-flex items-center gap-2.5 text-xl font-bold tracking-tight">
            <Image src={elkoMark} alt="" height={36} loading="eager" />
            Elko Creative
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}
