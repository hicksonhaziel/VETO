import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

import './globals.css';

const manrope = localFont({
  display: 'swap',
  src: [
    { path: './fonts/manrope-400.ttf', weight: '400' },
    { path: './fonts/manrope-500.ttf', weight: '500' },
    { path: './fonts/manrope-600.ttf', weight: '600' },
    { path: './fonts/manrope-700.ttf', weight: '700' },
  ],
  variable: '--font-manrope',
});

export const metadata: Metadata = {
  title: 'VETO',
  description: 'A bounded exit rule for Morpho Vault V2 depositors.',
  icons: { icon: '/brand/veto-mark.png' },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html className={manrope.variable} lang="en">
      <body>{children}</body>
    </html>
  );
}
