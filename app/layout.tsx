import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata={title:"Tracework — orchestration workspace",description:"Evidence-backed orchestration observation. Navigate projects, runs, session groupings and conversations."};
export default function RootLayout({children}:LayoutProps<"/">){return <html lang="en"><body><a className="skip-link" href="#main-content">Skip to workspace</a>{children}</body></html>;}
