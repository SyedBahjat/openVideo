import type { Metadata } from 'next';
import { Fraunces } from 'next/font/google';
import './globals.css';

// One display serif for headings; body text uses the system UI face on purpose (fast, native-feeling).
const display = Fraunces({ subsets: ['latin'], variable: '--font-display', axes: ['opsz'], style: ['normal', 'italic'] });

export const metadata: Metadata = {
  title: { default: 'openVideo', template: '%s · openVideo' },
  description: 'Open-source screen and camera recording with instant share links.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={display.variable}>
      <body>{children}</body>
    </html>
  );
}
