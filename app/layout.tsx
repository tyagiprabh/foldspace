import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { APP } from '../config'
import './globals.css'

export const metadata: Metadata = {
  title: APP.title,
  description: APP.description,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="night">
      <body>{children}</body>
    </html>
  )
}
